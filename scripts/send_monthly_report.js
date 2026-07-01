import { createClient } from '@supabase/supabase-js';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Desactivar temporalmente rechazo de certificados TLS inseguros
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Cargar variables de entorno
const envPath = path.resolve('c:/Users/yisle/surtihogar/.env');
dotenv.config({ path: envPath });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("❌ Error: No se encontraron las credenciales de Supabase en el archivo .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Utilidad para formatear dinero
const formatCurrency = (val) => {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0
  }).format(val);
};

// Obtener límites del mes en UTC-5
const getMonthlyLimits = (monthStr) => {
  // monthStr: YYYY-MM
  const [year, month] = monthStr.split('-').map(Number);
  const endLocal = new Date(year, month, 0); // Último día
  
  const startMs = new Date(`${year}-${String(month).padStart(2,'0')}-01T00:00:00-05:00`).getTime();
  const endMs = new Date(`${year}-${String(month).padStart(2,'0')}-${String(endLocal.getDate()).padStart(2,'0')}T23:59:59-05:00`).getTime();
  
  return { startMs, endMs, lastDay: endLocal.getDate() };
};

const getMonthName = (monthNum) => {
  const months = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
  ];
  return months[monthNum - 1];
};

async function main() {
  try {
    const args = process.argv.slice(2);
    let targetMonthStr = '';

    const now = new Date();
    
    // Si se pasa --month YYYY-MM
    if (args.includes('--month')) {
      const idx = args.indexOf('--month');
      if (idx !== -1 && args[idx + 1]) {
        targetMonthStr = args[idx + 1];
      }
    }

    if (!targetMonthStr) {
      // Por defecto, mes actual en Bogotá
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric',
        month: '2-digit'
      });
      targetMonthStr = formatter.format(now); // Formato YYYY-MM
    }

    const [year, monthNum] = targetMonthStr.split('-').map(Number);
    const monthName = getMonthName(monthNum);
    const periodLabel = `${monthName} de ${year}`;
    const periodId = `monthly_${targetMonthStr}`;
    const logFilePath = path.resolve('c:/Users/yisle/surtihogar/scripts/telegram_reports_sent.json');

    // 1. Evitar envíos duplicados a menos que se use --force
    let sentReports = {};
    if (fs.existsSync(logFilePath)) {
      try {
        sentReports = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
      } catch (e) {
        sentReports = {};
      }
    }

    if (sentReports[periodId] && !args.includes('--force')) {
      console.log(`ℹ️ El reporte mensual para ${periodLabel} ya fue enviado previamente. Saltando.`);
      return;
    }

    console.log(`⏳ Iniciando generación de reporte mensual para: ${periodLabel}`);

    const { startMs, endMs } = getMonthlyLimits(targetMonthStr);

    // 2. Cargar configuración de Telegram
    const { data: configs } = await supabase
      .from('system_logs')
      .select('message')
      .eq('type', 'TELEGRAM_CONFIG')
      .order('timestamp', { ascending: false })
      .limit(1);

    let config = null;
    if (configs && configs.length > 0) {
      try {
        config = JSON.parse(configs[0].message);
      } catch (e) {}
    }

    const botToken = (config && config.botToken) ? config.botToken : '8037545998:AAH4zgAxhoNbZ1WKJXmCElwq7oHzi7IJ1LY';
    const chatId = (config && config.chatId) ? config.chatId : '6736325362,8676279926';

    // 3. Consultar datos
    const [businessesRes, employeesRes, salesRes, saleItemsRes, productsRes] = await Promise.all([
      supabase.from('businesses').select('id, name'),
      supabase.from('users').select('*').neq('role', 'admin'),
      supabase.from('sales').select('*').gte('created_at', new Date(startMs).toISOString()).lte('created_at', new Date(endMs).toISOString()),
      supabase.from('sale_items').select('*'),
      supabase.from('products').select('id, name')
    ]);

    if (salesRes.error) throw salesRes.error;
    
    const businesses = businessesRes.data || [];
    const employees = employeesRes.data || [];
    const sales = salesRes.data || [];
    const saleItems = saleItemsRes.data || [];
    const products = productsRes.data || [];

    if (sales.length === 0) {
      console.log(`ℹ️ No se registraron ventas en el mes ${periodLabel}. No se genera reporte.`);
      return;
    }

    // 4. Agrupar y Calcular Métricas de Empleadas
    const employeeMetrics = {};
    employees.forEach(emp => {
      employeeMetrics[emp.id] = {
        name: emp.name,
        totalSales: 0,
        transactionsCount: 0,
        itemsCount: 0,
        salesList: []
      };
    });

    sales.forEach(sale => {
      const empId = sale.user_id;
      if (!employeeMetrics[empId]) {
        // Por si hay ventas de un usuario eliminado o administrador
        employeeMetrics[empId] = {
          name: 'Otro / Administrador',
          totalSales: 0,
          transactionsCount: 0,
          itemsCount: 0,
          salesList: []
        };
      }
      
      const total = parseFloat(sale.total) || 0;
      employeeMetrics[empId].totalSales += total;
      employeeMetrics[empId].transactionsCount += 1;
      
      const items = saleItems.filter(si => si.sale_id === sale.id);
      employeeMetrics[empId].itemsCount += items.reduce((sum, i) => sum + (Number(i.quantity) || 1), 0);
      employeeMetrics[empId].salesList.push({
        id: sale.id,
        created_at: sale.created_at,
        total: total,
        payment_method: sale.payment_method || 'Efectivo',
        items: items
      });
    });

    // Ordenar empleados por total de ventas descendente (para el Ranking)
    const ranking = Object.entries(employeeMetrics)
      .map(([id, data]) => ({ id, ...data }))
      .filter(emp => emp.transactionsCount > 0) // Solo los que vendieron algo
      .sort((a, b) => b.totalSales - a.totalSales);

    // 5. Generar PDF (Horizontal)
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    // PÁGINA 1: CUADRO DE HONOR Y RESUMEN GENERAL
    doc.setFillColor(15, 23, 42); // Azul oscuro corporativo
    doc.rect(0, 0, 297, 35, 'F');
    
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text(`SURTIHOGAR G&C - REPORTE MENSUAL DE RENDIMIENTO`, 15, 14);
    
    doc.setFontSize(9.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(148, 163, 184);
    doc.text(`Resumen y Ranking de Ventas por Colaborador • Periodo: ${periodLabel.toUpperCase()}`, 15, 23);

    // Cuadro de Honor / Medallero
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("🏆 CUADRO DE HONOR DEL MES", 15, 50);

    // Top 3 de Ventas
    let medalY = 58;
    ranking.slice(0, 3).forEach((emp, index) => {
      const medals = ['🥇 1er Lugar (Máxima Vendedora)', '🥈 2do Lugar', '🥉 3er Lugar'];
      doc.setFillColor(index === 0 ? 254 : 241, index === 0 ? 240 : 245, index === 0 ? 138 : 249); // Oro suave para 1er lugar
      doc.setDrawColor(226, 232, 240);
      doc.rect(15, medalY, 267, 10, 'FD');

      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(30, 41, 59);
      doc.text(medals[index], 18, medalY + 6.5);
      doc.text(emp.name, 110, medalY + 6.5);
      doc.text(`Ventas: ${formatCurrency(emp.totalSales)}`, 200, medalY + 6.5);
      doc.text(`Tickets: ${emp.transactionsCount}`, 250, medalY + 6.5);

      medalY += 12;
    });

    // Tabla Completa de Ranking
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(30, 41, 59);
    doc.text("📊 TABLA DE RENDIMIENTO GENERAL Y MÉTRICAS", 15, medalY + 8);

    const rankingHead = [['PUESTO', 'COLABORADORA', 'TOTAL VENTAS', 'Nº TRANSACCIONES', 'TICKET PROMEDIO', 'UNIDADES VENDIDAS']];
    const rankingBody = ranking.map((emp, index) => {
      const avgTicket = emp.transactionsCount > 0 ? emp.totalSales / emp.transactionsCount : 0;
      return [
        `${index + 1}º`,
        emp.name,
        formatCurrency(emp.totalSales),
        emp.transactionsCount,
        formatCurrency(avgTicket),
        emp.itemsCount
      ];
    });

    autoTable(doc, {
      startY: medalY + 12,
      head: rankingHead,
      body: rankingBody,
      theme: 'grid',
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9, cellPadding: 3.5 },
      styles: { fontSize: 8.5, cellPadding: 3, font: 'helvetica', halign: 'center' },
      columnStyles: {
        1: { halign: 'left', fontStyle: 'bold' },
        2: { halign: 'right', fontStyle: 'bold' },
        4: { halign: 'right' }
      }
    });

    // PÁGINAS INDIVIDUALES DE DESGLOSE DE AUDITORÍA
    ranking.forEach(emp => {
      doc.addPage();
      
      // Encabezado por empleada
      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, 297, 28, 'F');
      
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(13);
      doc.setFont("helvetica", "bold");
      doc.text(`DESGLOSE DETALLADO DE VENTAS: ${emp.name.toUpperCase()}`, 15, 11);
      
      doc.setFontSize(8.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(203, 213, 225);
      doc.text(`Periodo: ${periodLabel} • Ventas Totales: ${formatCurrency(emp.totalSales)} • Transacciones: ${emp.transactionsCount}`, 15, 18);

      const empSalesHead = [['REF VENTA', 'FECHA Y HORA', 'SEDE / NEGOCIO', 'PRODUCTOS DESPACHADOS', 'MÉTODO DE PAGO', 'TOTAL NETO']];
      const empSalesBody = emp.salesList.map(s => {
        // Productos
        const prodDetails = s.items.map(i => {
          const p = products.find(p => p.id === i.product_id);
          return `${p?.name || 'Producto'} [x${i.quantity || 1}]`;
        }).join(', ');

        const dateObj = new Date(s.created_at);
        const dateStr = `${dateObj.getDate().toString().padStart(2,'0')}/${(dateObj.getMonth()+1).toString().padStart(2,'0')}/${dateObj.getFullYear()} ${dateObj.getHours().toString().padStart(2,'0')}:${dateObj.getMinutes().toString().padStart(2,'0')}`;

        // Obtener nombres de negocios
        const bizIds = [...new Set(s.items.map(i => {
          const p = products.find(prod => prod.id === i.product_id);
          return p?.business_id;
        }).filter(Boolean))];
        const bizNames = bizIds.map(id => businesses.find(b => b.id === id)?.name || 'Sede').join(', ');

        return [
          `#${s.id.slice(0, 8).toUpperCase()}`,
          dateStr,
          bizNames || 'General',
          prodDetails || 'Venta directa en POS',
          s.payment_method.toUpperCase(),
          formatCurrency(s.total)
        ];
      });

      autoTable(doc, {
        startY: 34,
        head: empSalesHead,
        body: empSalesBody,
        theme: 'grid',
        headStyles: { fillColor: [51, 65, 85], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8, cellPadding: 3 },
        styles: { fontSize: 7.5, cellPadding: 2.5, font: 'helvetica', overflow: 'linebreak' },
        columnStyles: {
          0: { cellWidth: 25, fontStyle: 'bold' },
          1: { cellWidth: 35 },
          2: { cellWidth: 35 },
          3: { cellWidth: 130 },
          4: { cellWidth: 28, halign: 'center' },
          5: { halign: 'right', fontStyle: 'bold', cellWidth: 28 }
        }
      });
    });

    // 6. Enviar Reporte PDF a Telegram
    console.log("📤 Despachando reporte mensual a Telegram...");
    const arrayBuffer = doc.output('arraybuffer');
    const fileBlob = new Blob([arrayBuffer], { type: 'application/pdf' });
    const safeName = `Reporte_Mensual_Ventas_${targetMonthStr}.pdf`;

    const chatIds = chatId.split(',').map(id => id.trim()).filter(Boolean);
    let anySuccess = false;

    // Calcular la que más vendió para el mensaje de resumen
    const topSellerMsg = ranking.length > 0 ? `🏆 <b>Vendedora del Mes:</b> ${ranking[0].name} (Total: <b>${formatCurrency(ranking[0].totalSales)}</b>)` : '';

    for (const id of chatIds) {
      try {
        const formData = new FormData();
        formData.append('chat_id', id);
        formData.append('caption', `📅 <b>REPORTE MENSUAL DE RENDIMIENTO</b>\n\n📌 Periodo: <code>${periodLabel}</code>\n${topSellerMsg}\n📊 Ventas Totales: <b>${formatCurrency(sales.reduce((sum, s) => sum + parseFloat(s.total || 0), 0))}</b>\n🕒 Generado: ${now.toLocaleString('es-CO')}\n\nAdjuntamos el informe en PDF con el Cuadro de Honor y el desglose de auditoría por colaboradora.`);
        formData.append('parse_mode', 'HTML');
        formData.append('document', fileBlob, safeName);

        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
          method: 'POST',
          body: formData
        });

        const result = await res.json();
        if (result.ok) {
          anySuccess = true;
          console.log(`✅ Reporte mensual enviado a Telegram (Chat ID: ${id})`);
        }
      } catch (err) {
        console.error(`❌ Error enviando a chat ID ${id}:`, err);
      }
    }

    if (anySuccess) {
      // Registrar log local
      sentReports[periodId] = {
        sent_at: new Date().toISOString(),
        label: periodLabel,
        total_sales: sales.reduce((sum, s) => sum + parseFloat(s.total || 0), 0)
      };
      fs.writeFileSync(logFilePath, JSON.stringify(sentReports, null, 2), 'utf8');
      console.log("📝 Registro local mensual actualizado.");
    }

  } catch (err) {
    console.error("❌ Error inesperado ejecutando reporte mensual:", err);
    if (process.argv[1] && process.argv[1].includes('send_monthly_report.js')) {
      process.exit(1);
    }
    throw err;
  }
}

export { main as runMonthlyReport };

if (process.argv[1] && process.argv[1].includes('send_monthly_report.js')) {
  main();
}
