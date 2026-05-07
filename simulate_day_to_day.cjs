const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

const PASS = "100CampeoneS";

async function runFullSimulation() {
    console.log("🌞 INICIANDO SIMULACIÓN DE JORNADA LABORAL RIVO\n");

    try {
        // --- PREPARACIÓN ---
        const { data: businesses } = await supabase.from('businesses').select('*');
        const { data: categories } = await supabase.from('categories').select('*');
        const { data: users } = await supabase.from('users').select('*');

        const electro = businesses.find(b => b.name.includes('Electrodomésticos'));
        const muebles = businesses.find(b => b.name.includes('Muebles'));
        const billar = businesses.find(b => b.name.includes('Billar'));
        const drogueria = businesses.find(b => b.name.includes('Droguería'));

        const admin = users.find(u => u.role === 'admin');
        const emp1 = users.find(u => u.name.includes('Carlos') || u.name.includes('juan_empleado'));
        const emp2 = users.find(u => u.name.includes('Sofia') || u.name.includes('cajero'));

        const catVenta = categories.find(c => c.name === 'Venta');
        const catGasto = categories.find(c => c.name === 'Gasto Operativo' || c.name === 'Gasto');
        const catRenta = categories.find(c => c.name === 'Arriendo' || c.name === 'Venta');

        console.log("✅ Datos base cargados.");

        // --- PASO 1: ASIGNACIÓN DE TURNOS (ADMIN) ---
        console.log("\n🕒 [ADMIN] Asignando turnos para hoy...");
        const shiftPayloads = [
            { user_id: emp1.id, business_id: electro.id, start_time: new Date().toISOString(), end_time: new Date(Date.now() + 28800000).toISOString() },
            { user_id: emp2.id, business_id: muebles.id, start_time: new Date().toISOString(), end_time: new Date(Date.now() + 28800000).toISOString() }
        ];
        await supabase.from('shifts').insert(shiftPayloads);
        console.log("✅ Turnos asignados: Carlos -> Electro, Sofia -> Muebles.");

        // --- PASO 2: OPERACIÓN DIARIA (EMPLEADOS) ---
        console.log("\n💸 [EMPLEADOS] Registrando ventas y gastos operativos...");
        const trxPayloads = [
            { amount: 1200000, type: 'income', business_id: electro.id, category_id: catVenta.id, user_id: emp1.id, note: "Venta Nevera Samsung", date: new Date().toISOString() },
            { amount: 450000, type: 'income', business_id: electro.id, category_id: catVenta.id, user_id: emp1.id, note: "Venta Celular Xiaomi", date: new Date().toISOString() },
            { amount: 85000, type: 'expense', business_id: electro.id, category_id: catGasto.id, user_id: emp1.id, note: "Pago energía local", date: new Date().toISOString() },
            { amount: 2300000, type: 'income', business_id: muebles.id, category_id: catVenta.id, user_id: emp2.id, note: "Juego de sala Cuero", date: new Date().toISOString() }
        ];
        await supabase.from('transactions').insert(trxPayloads);
        console.log("✅ Operativa completada: 3 ventas y 1 gasto registrados.");

        // --- PASO 3: GESTIÓN DE RENTAS (ADMIN) ---
        console.log("\n🏠 [ADMIN] Recaudando rentas del sector arriendos...");
        const rentalPayloads = [
            { amount: 800000, type: 'income', business_id: billar.id, category_id: catRenta.id, user_id: admin.id, note: "Cobro mes de Mayo", date: new Date().toISOString() },
            { amount: 1100000, type: 'income', business_id: drogueria.id, category_id: catRenta.id, user_id: admin.id, note: "Renta local droguería", date: new Date().toISOString() },
            { amount: 120000, type: 'expense', business_id: drogueria.id, category_id: catGasto.id, user_id: admin.id, note: "Arreglo techo local", date: new Date().toISOString() }
        ];
        await supabase.from('transactions').insert(rentalPayloads);
        console.log("✅ Rentas procesadas exitosamente.");

        // --- PASO 4: PRUEBA DE SEGURIDAD (LOGS) ---
        console.log("\n🛡️ [SEGURIDAD] Simulando intento de intrusión...");
        // Empleado 1 intenta registrar en Billar (Esto sería bloqueado por el frontend, aquí lo logueamos)
        await supabase.from('system_logs').insert({
            tipo: 'SECURITY_ALERT',
            mensaje: 'No autorizado para este negocio',
            modulo: 'saveTransaction',
            user_id: emp1.id,
            contexto: { business_id: billar.id, business_name: billar.name }
        });
        console.log("✅ Alerta de seguridad registrada en auditoría.");

        console.log("\n--------------------------------------------");
        console.log("🏁 SIMULACIÓN FINALIZADA");
        console.log("Dashboard actualizado con éxito.");
        console.log("--------------------------------------------");

    } catch (e) {
        console.error("❌ Error en la simulación:", e.message);
    }
}

runFullSimulation();
