import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

const delay = (ms) => new Promise(res => setTimeout(res, ms));

async function runSimulation() {
  console.log("===============================================================");
  console.log("🌞 INICIANDO SIMULACIÓN DE DÍA ORGÁNICO EN NEXT TERRA 🌞");
  console.log("===============================================================\n");

  // 1. Cargar Negocios
  const { data: bData } = await supabase.from('businesses').select('*');
  const bElec = bData.find(b => b.name.includes('Electrodomésticos'));
  const bMueb = bData.find(b => b.name.includes('Muebles'));
  const bBara = bData.find(b => b.name.includes('Baratillo'));
  const bBillar = bData.find(b => b.name.includes('Billar'));
  const bDrog = bData.find(b => b.name.includes('Droguería'));

  // 2. Cargar Categorías
  const { data: catData } = await supabase.from('categories').select('*');
  const catVenta = catData.find(c => c.name === 'Venta')?.id;
  const catCompra = catData.find(c => c.name.includes('Compra inventario'))?.id;
  const catServ = catData.find(c => c.name.includes('Pago de servicios'))?.id;
  
  let catArrId = catData.find(c => c.name.includes('Arriendo'))?.id;
  if (!catArrId) {
    const { data: newCat } = await supabase.from('categories').insert({ name: 'Arriendo', type: 'income' }).select();
    catArrId = newCat[0].id;
  }

  // Helper para generar y loguear empleados
  async function createWorker(businessId, workerName) {
    const email = `sim_${workerName.toLowerCase()}_${Date.now()}@test.com`;
    const { data } = await supabase.auth.signUp({
      email, password: 'password123', options: { data: { name: workerName, business_id: businessId } }
    });
    return { email, id: data.user.id, name: workerName };
  }

  console.log("👥 Generando equipo de empleados para hoy...");
  const eElec = await createWorker(bElec.id, "Carlos_Electro");
  const eMueb = await createWorker(bMueb.id, "Sofia_Muebles");
  const eBara = await createWorker(bBara.id, "Pedro_Baratillo");
  const eBillar = await createWorker(bBillar.id, "Ana_Billar");
  const eDrog = await createWorker(bDrog.id, "Luis_Drogueria");
  console.log("✅ Empleados listos y asignados a sus locales.\n");

  const timeline = [
    // Baratillo
    { time: "08:00 AM", worker: eBara, b: bBara, cat: catCompra, type: 'expense', amount: 500000, note: "Compra de surtido semanal en abastos" },
    // Electro
    { time: "08:30 AM", worker: eElec, b: bElec, cat: catVenta, type: 'income', amount: 150000, note: "Venta licuadora Oster" },
    { time: "09:15 AM", worker: eElec, b: bElec, cat: catCompra, type: 'expense', amount: 2000000, note: "Pago a proveedor LG por 3 televisores" },
    // Muebles
    { time: "09:45 AM", worker: eMueb, b: bMueb, cat: catVenta, type: 'income', amount: 850000, note: "Venta juego de comedor 4 puestos" },
    // Electro
    { time: "10:30 AM", worker: eElec, b: bElec, cat: catVenta, type: 'income', amount: 450000, note: "Venta microondas Samsung" },
    // Billar
    { time: "11:00 AM", worker: eBillar, b: bBillar, cat: catArrId, type: 'income', amount: 15000, note: "Mesa 1 - 1 hora" },
    // Electro
    { time: "12:15 PM", worker: eElec, b: bElec, cat: catCompra, type: 'expense', amount: 500000, note: "Compra repuestos para aires acondicionados" },
    // Drogueria
    { time: "01:30 PM", worker: eDrog, b: bDrog, cat: catArrId, type: 'income', amount: 1200000, note: "Pago arriendo mensual local principal" },
    // Muebles
    { time: "02:45 PM", worker: eMueb, b: bMueb, cat: catCompra, type: 'expense', amount: 1500000, note: "Compra madera y telas a proveedor" },
    // Baratillo
    { time: "03:10 PM", worker: eBara, b: bBara, cat: catVenta, type: 'income', amount: 250000, note: "Ventas varias del turno tarde" },
    // Electro
    { time: "04:00 PM", worker: eElec, b: bElec, cat: catServ, type: 'expense', amount: 120000, note: "Pago recibo luz Electrodomésticos" },
    { time: "05:00 PM", worker: eElec, b: bElec, cat: catVenta, type: 'income', amount: 1200000, note: "Venta Televisor 55 pulgadas" },
    // Muebles
    { time: "05:30 PM", worker: eMueb, b: bMueb, cat: catVenta, type: 'income', amount: 400000, note: "Venta de 2 sillas de escritorio" },
    { time: "06:15 PM", worker: eMueb, b: bMueb, cat: catVenta, type: 'income', amount: 1200000, note: "Venta sofá en L" },
    // Electro
    { time: "06:45 PM", worker: eElec, b: bElec, cat: catVenta, type: 'income', amount: 90000, note: "Venta plancha de ropa" },
    { time: "07:30 PM", worker: eElec, b: bElec, cat: catVenta, type: 'income', amount: 300000, note: "Venta ventilador industrial" },
    // Billar
    { time: "08:00 PM", worker: eBillar, b: bBillar, cat: catArrId, type: 'income', amount: 45000, note: "Mesas 2 y 3 - Torneo nocturno" }
  ];

  console.log("⏱️ INICIANDO LÍNEA DE TIEMPO DEL DÍA...\n");

  for (let t of timeline) {
    // Simulamos que el empleado saca su celular y entra a la app
    await supabase.auth.signInWithPassword({ email: t.worker.email, password: 'password123' });
    
    // Inserta la transacción
    const { error } = await supabase.from('transactions').insert({
      amount: t.amount,
      type: t.type,
      business_id: t.b.id,
      category_id: t.cat,
      user_id: t.worker.id,
      note: t.note
    });

    if (error) {
      console.log(`[${t.time}] ❌ ERROR de ${t.worker.name}: ${error.message}`);
    } else {
      const color = t.type === 'income' ? '\x1b[32m+$' : '\x1b[31m-$'; // Verde para ingresos, Rojo para gastos
      const resetColor = '\x1b[0m';
      console.log(`[${t.time}] 🧑‍💼 ${t.worker.name} en ${t.b.name}: ${t.note} (${color}${t.amount.toLocaleString()}${resetColor})`);
    }

    // Pequeño delay para emular organicidad y no saturar la API
    await delay(300);
  }

  console.log("\n===============================================================");
  console.log("🌙 FIN DEL DÍA. CERRANDO TIENDAS.");
  console.log("===============================================================");
  
  // Resumen del robot
  const ingresos = timeline.filter(t => t.type === 'income').reduce((s,t) => s + t.amount, 0);
  const gastos = timeline.filter(t => t.type === 'expense').reduce((s,t) => s + t.amount, 0);
  
  console.log(`\n💵 CAJA GLOBAL DEL DÍA: Ingresos Totales $${ingresos.toLocaleString()} | Gastos Totales $${gastos.toLocaleString()}`);
  console.log(`💰 BALANCE FINAL EN BANCOS: $${(ingresos - gastos).toLocaleString()}`);
  console.log("\n✅ Simulación inyectada exitosamente. ¡Puedes ver todo en la App web ahora mismo!");
}

runSimulation();
