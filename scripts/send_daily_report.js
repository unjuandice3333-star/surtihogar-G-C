import { createClient } from '@supabase/supabase-js';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Desactivar temporalmente rechazo de certificados TLS inseguros si es necesario
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

// Obtener fecha en zona horaria de Bogotá (UTC-5)
const getBogotaDateStr = (date = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
};

async function main() {
  try {
    const args = process.argv.slice(2);
    let targetDateStr = '';

    const now = new Date();
    
    if (args.includes('--yesterday') || args.includes('-y')) {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      targetDateStr = getBogotaDateStr(yesterday);
    } else if (args.includes('--date')) {
      const idx = args.indexOf('--date');
      if (idx !== -1 && args[idx + 1]) {
        targetDateStr = args[idx + 1];
      }
    }

    if (!targetDateStr) {
      targetDateStr = getBogotaDateStr(now);
    }

    console.log(`⏳ Iniciando generación de reporte para la fecha (Bogotá): ${targetDateStr}`);

    const periodId = `daily_${targetDateStr}`;
    const logFilePath = path.resolve('c:/Users/yisle/surtihogar/scripts/telegram_reports_sent.json');

    // 1. Verificar si ya fue enviado para evitar duplicados (blindaje)
    let sentReports = {};
    if (fs.existsSync(logFilePath)) {
      try {
        sentReports = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
      } catch (e) {
        sentReports = {};
      }
    }

    if (sentReports[periodId] && !args.includes('--force')) {
      console.log(`ℹ️ El reporte para la fecha ${targetDateStr} ya fue enviado previamente. Saltando.`);
      process.exit(0);
    }

    // 2. Definir límites del día en UTC (para coincidir con las cuentas de base de datos)
    const startMs = new Date(targetDateStr + 'T00:00:00Z').getTime();
    const endMs = new Date(targetDateStr + 'T23:59:59Z').getTime();

    // 3. Consultar configuración de Telegram
    console.log("📡 Cargando credenciales de Telegram desde system_logs...");
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

    if (!botToken || !chatId) {
      console.error("❌ Error: No se configuró el token o el ID del chat de Telegram.");
      process.exit(1);
    }

    // 4. Consultar datos en la base de datos
    console.log("📡 Consultando base de datos Supabase...");
    
    // Negocios
    const { data: businesses, error: busErr } = await supabase
      .from('businesses')
      .select('id, name, type');
    if (busErr) throw busErr;

    // Empleados/Usuarios
    const { data: employees, error: empErr } = await supabase
      .from('users')
      .select('*');
    if (empErr) throw empErr;

    // Ventas
    const { data: sales, error: salesErr } = await supabase
      .from('sales')
      .select('*')
      .gte('created_at', new Date(startMs).toISOString())
      .lte('created_at', new Date(endMs).toISOString());
    if (salesErr) throw salesErr;

    // Transacciones (Egresos)
    const { data: transactions, error: txErr } = await supabase
      .from('transactions')
      .select('*')
      .eq('type', 'expense')
      .gte('date', new Date(startMs).toISOString())
      .lte('date', new Date(endMs).toISOString());
    if (txErr) throw txErr;

    // Categorías de Transacciones
    const { data: categories, error: catErr } = await supabase
      .from('categories')
      .select('*');
    if (catErr) throw catErr;

    // Productos
    const { data: products, error: prodErr } = await supabase
      .from('products')
      .select('id, name, business_id, cost');
    if (prodErr) throw prodErr;

    // Productos Pendientes
    const { data: pendingProducts, error: pendingErr } = await supabase
      .from('pending_products')
      .select('*')
      .gte('created_at', new Date(startMs).toISOString())
      .lte('created_at', new Date(endMs).toISOString());
    if (pendingErr) {
      console.warn("Aviso: No se pudo cargar pending_products:", pendingErr.message);
    }

    // Ítems de Ventas
    let saleItems = [];
    if (sales && sales.length > 0) {
      const saleIds = sales.map(s => s.id);
      const { data: items, error: itemsErr } = await supabase
        .from('sale_items')
        .select('*')
        .in('sale_id', saleIds);
      if (itemsErr) throw itemsErr;
      saleItems = items || [];
    }

    if ((!sales || sales.length === 0) && (!transactions || transactions.length === 0)) {
      console.log(`ℹ️ No se registraron ventas ni egresos para la fecha ${targetDateStr}. No se envía reporte.`);
      process.exit(0);
    }

    console.log(`📊 Generando PDF para ${sales.length} ventas y ${transactions.length} egresos...`);

    // 5. Sintetizar PDF usando jsPDF
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    // Encabezado
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, 297, 32, 'F');
    
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text(`J&M - REPORTE DIARIO AUTOMÁTICO`, 15, 15);
    
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(148, 163, 184);
    doc.text("Planilla de Control y Resumen Financiero Consolidado • Telegram Auto-Report System", 15, 23);

    doc.setTextColor(30, 41, 59);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("DETALLE DEL PERIODO", 15, 45);
    
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(`Tipo de Reporte: DIARIO (FECHA ESPECÍFICA)`, 15, 51);
    doc.text(`Rango de Fechas: ${targetDateStr}`, 15, 57);

    doc.setFont("helvetica", "bold");
    doc.text("AUDITORÍA DE TELEGRAM", 180, 45);
    doc.setFont("helvetica", "normal");
    doc.text(`Generado automáticamente en el servidor`, 180, 51);
    doc.text(`Fecha de Emisión: ${new Date().toLocaleString('es-CO')}`, 180, 57);

    doc.setDrawColor(226, 232, 240);
    doc.line(15, 65, 282, 65);

    const head = [['REF / FECHA', 'SEDE', 'VENDEDOR', 'DETALLE DE PRODUCTOS', 'PAGO', 'TOTAL NETO']];
    const body = [];
    let totalRevenue = 0;
    let totalCost = 0;
    let totalUnits = 0;
    const paymentBreakdown = { Efectivo: 0, Sistecredito: 0, Addi: 0, 'Llano Gas': 0, Transferencia: 0, Daviplata: 0, 'Bonos Coopchipaque': 0 };

    sales.forEach(sale => {
      const items = saleItems.filter(si => si.sale_id === sale.id);
      const bizIdsFromProducts = items.map(i => {
        const prod = products.find(p => p.id === i.product_id);
        return prod?.business_id;
      }).filter(Boolean);

      const saleShortId = sale.id.slice(0, 5);
      const bizIdsFromTransactions = transactions.filter(t => t.note && t.note.includes(saleShortId)).map(t => t.business_id);
      const allBizIds = [...new Set([...bizIdsFromProducts, ...bizIdsFromTransactions])];
      const bizNames = allBizIds.map(id => businesses.find(b => b.id === id)?.name || 'General').join(', ');

      const sellerObj = employees.find(emp => emp.id === sale.user_id);
      const sellerName = sellerObj?.name || 'Asignado';
      const saleTotal = parseFloat(sale.total) || 0;

      let payMethod = sale.payment_method || 'Efectivo';
      if (payMethod.toLowerCase().includes('daviplata')) payMethod = 'Daviplata';
      else if (payMethod.toLowerCase().includes('nequi') || payMethod.toLowerCase().includes('transferencia')) payMethod = 'Transferencia';

      let productsLabel = items.map(i => {
        const prod = products.find(p => p.id === i.product_id);
        let pName = prod?.name;
        let pCost = parseFloat(prod?.cost) || 0;

        if (!pName) {
          const pending = (pendingProducts || []).find(pp => pp.sale_id === sale.id);
          if (pending) {
            pName = `${pending.name} (Pte.)`;
            pCost = parseFloat(pending.cost) || 0;
          } else if (sale.note && sale.note.includes('Venta informal')) {
            pName = sale.note.replace('Venta informal: ', '');
            pCost = 0;
          } else {
            pName = 'Producto Especial';
            pCost = 0;
          }
        }
        const itemQty = Number(i.quantity) || 1;
        totalUnits += itemQty;
        totalCost += (pCost * itemQty);
        return `${pName} [x${itemQty}]`;
      }).join(', ');

      if (!productsLabel && sale.note && sale.note.includes('Venta informal')) {
        productsLabel = sale.note.replace('Venta informal: ', '').trim() + ' (Directa)';
      }

      totalRevenue += saleTotal;
      if (!paymentBreakdown[payMethod]) paymentBreakdown[payMethod] = 0;
      paymentBreakdown[payMethod] += saleTotal;

      const dateObj = new Date(sale.created_at);
      const dateStr = `${dateObj.getDate().toString().padStart(2,'0')}/${(dateObj.getMonth()+1).toString().padStart(2,'0')} ${dateObj.getHours().toString().padStart(2,'0')}:${dateObj.getMinutes().toString().padStart(2,'0')}`;

      body.push([
        `#${sale.id.slice(0, 8).toUpperCase()}\n${dateStr}`,
        bizNames || 'J&M',
        sellerName,
        productsLabel || 'Venta directa en POS',
        payMethod.toUpperCase(),
        formatCurrency(saleTotal)
      ]);
    });

    autoTable(doc, {
      startY: 72,
      head: head,
      body: body,
      theme: 'grid',
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5, cellPadding: 4 },
      styles: { fontSize: 8, cellPadding: 3.5, font: 'helvetica', overflow: 'linebreak' },
      columnStyles: {
        0: { cellWidth: 35, fontStyle: 'bold' },
        1: { cellWidth: 35 },
        2: { cellWidth: 35 },
        3: { cellWidth: 120 },
        4: { cellWidth: 25, halign: 'center' },
        5: { halign: 'right', fontStyle: 'bold', cellWidth: 32 }
      }
    });

    if (transactions.length > 0) {
      let currentY = (doc.lastAutoTable ? doc.lastAutoTable.finalY : 72) + 15;
      if (currentY > 175) {
        doc.addPage();
        currentY = 20;
      }

      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(185, 28, 28);
      doc.text("📄 DESGLOSE DE EGRESOS Y GASTOS OPERATIVOS REGISTRADOS", 15, currentY);
      
      const expenseHead = [['REF / FECHA', 'SEDE / LOCAL', 'RESPONSABLE', 'MOTIVO / DETALLE', 'PAGO', 'MONTO GASTO']];
      const expenseBody = transactions.map(t => {
        const bizNameObj = businesses.find(b => b.id === t.business_id)?.name || 'General';
        const userObj = employees.find(e => e.id === t.user_id);
        const userName = userObj?.name || 'Colaborador';
        const catName = categories.find(c => c.id === t.category_id)?.name || 'Gasto General';
        const desc = t.description ? `(${t.description})` : (t.note ? `(${t.note})` : '');
        const finalMotivo = `${catName} ${desc}`;
        const dateObj = new Date(t.date || t.created_at);
        const dateStr = `${dateObj.getDate().toString().padStart(2,'0')}/${(dateObj.getMonth()+1).toString().padStart(2,'0')} ${dateObj.getHours().toString().padStart(2,'0')}:${dateObj.getMinutes().toString().padStart(2,'0')}`;

        return [
          `#TRX-${(t.id || '').slice(0,6).toUpperCase()}\n${dateStr}`,
          bizNameObj,
          userName,
          finalMotivo,
          (t.payment_method || 'Efectivo').toUpperCase(),
          formatCurrency(parseFloat(t.amount) || 0)
        ];
      });

      autoTable(doc, {
        startY: currentY + 4,
        head: expenseHead,
        body: expenseBody,
        theme: 'grid',
        headStyles: { fillColor: [185, 28, 28], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5, cellPadding: 4 },
        styles: { fontSize: 8, cellPadding: 3.5, font: 'helvetica', overflow: 'linebreak' },
        columnStyles: {
          0: { cellWidth: 35, fontStyle: 'bold' },
          1: { cellWidth: 35 },
          2: { cellWidth: 35 },
          3: { cellWidth: 120 },
          4: { cellWidth: 25, halign: 'center' },
          5: { halign: 'right', fontStyle: 'bold', cellWidth: 32, textColor: [185, 28, 28] }
        }
      });
    }

    const finalY = (doc.lastAutoTable ? doc.lastAutoTable.finalY : 100) + 15;
    if (finalY > 135) {
      doc.addPage();
      doc.setPage(doc.getNumberOfPages());
    }
    const rectY = finalY > 135 ? 20 : finalY;

    let totalOpExpenses = 0;
    let cashExpenses = 0;
    transactions.forEach(t => {
       const amt = parseFloat(t.amount) || 0;
       totalOpExpenses += amt;
       if ((t.payment_method || 'Efectivo').toLowerCase() === 'efectivo') cashExpenses += amt;
    });

    const cashRevenue = paymentBreakdown.Efectivo || 0;
    const digitalRevenue = totalRevenue - cashRevenue;
    const cashBalance = cashRevenue - cashExpenses;

    doc.setFillColor(241, 245, 249);
    doc.setDrawColor(203, 213, 225);
    doc.rect(15, rectY, 267, 45, 'FD');

    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("RESUMEN DE SALDOS FINANCIEROS DEL PERIODO", 20, rectY + 8);

    doc.setFontSize(8.5);
    doc.setFont("helvetica", "normal");
    doc.text(`• Total Ventas Netas: ${formatCurrency(totalRevenue)}`, 20, rectY + 16);
    doc.text(`• Ingresos Recibidos en Efectivo: ${formatCurrency(cashRevenue)}`, 20, rectY + 23);
    doc.text(`• Ingresos Recibidos en Digital: ${formatCurrency(digitalRevenue)}`, 20, rectY + 30);
    doc.text(`• Unidades Totales Despachadas: ${totalUnits} unds`, 20, rectY + 37);

    doc.text(`• Total Gastos Operativos: ${formatCurrency(totalOpExpenses)}`, 140, rectY + 16);
    doc.text(`• Gastos Pagados en Efectivo: ${formatCurrency(cashExpenses)}`, 140, rectY + 23);
    
    const netEbitda = totalRevenue - totalCost - totalOpExpenses;
    doc.setFont("helvetica", "bold");
    doc.text(`• FLUJO EFECTIVO CAJA (Efectivo Ventas - Efectivo Gastos): ${formatCurrency(cashBalance)}`, 140, rectY + 30);
    doc.setTextColor(netEbitda >= 0 ? 21 : 185, netEbitda >= 0 ? 128 : 28, netEbitda >= 0 ? 61 : 28);
    doc.text(`• EXCEDENTE NETO ESTIMADO (Ventas - Costos - Gastos): ${formatCurrency(netEbitda)}`, 140, rectY + 37);

    // 6. Enviar a Telegram
    console.log("📤 Enviando documento PDF a Telegram...");
    
    const arrayBuffer = doc.output('arraybuffer');
    const fileBlob = new Blob([arrayBuffer], { type: 'application/pdf' });
    const safeName = `Reporte_Ventas_DIARIO_${targetDateStr}.pdf`;

    const chatIds = chatId.split(',').map(id => id.trim()).filter(Boolean);
    let anySuccess = false;
    let errorMsg = '';

    for (const id of chatIds) {
      try {
        const formData = new FormData();
        formData.append('chat_id', id);
        formData.append('caption', `📊 <b>REPORTE DIARIO DE VENTAS (AUTOMÁTICO)</b>\n📅 Rango: <code>${targetDateStr}</code>\n🕒 Generado: ${new Date().toLocaleString('es-CO')}\n💰 Total Ventas: <b>${formatCurrency(totalRevenue)}</b>\n🔻 Gastos: <b>${formatCurrency(totalOpExpenses)}</b>\n📈 Neto: <b>${formatCurrency(netEbitda)}</b>`);
        formData.append('parse_mode', 'HTML');
        formData.append('document', fileBlob, safeName);

        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
          method: 'POST',
          body: formData
        });

        const result = await res.json();
        if (result.ok) {
          anySuccess = true;
          console.log(`✅ Reporte enviado a Telegram (Chat ID: ${id}) exitosamente!`);
        } else {
          console.error(`❌ Error de la API de Telegram para chat ${id}:`, result);
          errorMsg = result.description || 'Fallo de API';
        }
      } catch (err) {
        console.error(`❌ Excepción enviando a Telegram chat ${id}:`, err);
        errorMsg = err.message;
      }
    }

    if (anySuccess) {
      // Registrar log local de éxito
      sentReports[periodId] = {
        sent_at: new Date().toISOString(),
        total_revenue: totalRevenue,
        total_expenses: totalOpExpenses
      };
      
      fs.writeFileSync(logFilePath, JSON.stringify(sentReports, null, 2), 'utf8');
      console.log("📝 Registro local actualizado.");
    } else {
      console.error(`❌ Error al enviar reporte diario a todos los chats: ${errorMsg}`);
      process.exit(1);
    }
  } catch (err) {
    console.error("❌ Error inesperado ejecutando reporte diario:", err);
    if (process.argv[1] && process.argv[1].includes('send_daily_report.js')) {
      process.exit(1);
    }
    throw err;
  }
}

export { main as runDailyReport };

if (process.argv[1] && process.argv[1].includes('send_daily_report.js')) {
  main();
}
