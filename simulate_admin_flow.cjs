const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

// Reglas de negocio a validar (Admin tiene acceso total)
const validateAdminAccess = (user) => {
    if (user.role === 'admin') return { success: true };
    return { success: false, error: "No autorizado" };
};

async function runSimulation() {
    console.log("🚀 SIMULACIÓN: FLUJO COMPLETO ADMINISTRADOR\n");

    try {
        // 1. Obtener datos de prueba
        const { data: businesses } = await supabase.from('businesses').select('*');
        const { data: users } = await supabase.from('users').select('*').eq('role', 'admin').limit(1);
        const { data: categories } = await supabase.from('categories').select('*');

        const opBus = businesses.find(b => b.type === 'operativo');
        const arrBus = businesses.find(b => b.type === 'arriendo');
        const adminUser = users[0];
        
        const incCat = categories.find(c => c.type === 'income');
        const expCat = categories.find(c => c.type === 'expense');

        console.log(`👑 Administrador: ${adminUser.name}`);
        console.log("--------------------------------------------");

        // --- CASO 1: Ingreso en ARRIENDO ---
        console.log(`📝 ACCIÓN 1: Registrando INGRESO en ARRIENDO (${arrBus.name})`);
        if (validateAdminAccess(adminUser).success) {
            console.log("✅ Lógica: PERMITIDO (Rol Admin)");
            const payload = {
                amount: 500000,
                type: 'income',
                business_id: arrBus.id,
                category_id: incCat.id,
                user_id: adminUser.id,
                date: new Date().toISOString(),
                note: "Simulación: Pago renta admin"
            };
            const { error } = await supabase.from('transactions').insert(payload);
            if (error) throw error;
            console.log("✅ RESULTADO: Ingreso registrado exitosamente.");
        }

        console.log("\n--------------------------------------------");

        // --- CASO 2: Gasto en OPERATIVO ---
        console.log(`📝 ACCIÓN 2: Registrando GASTO en OPERATIVO (${opBus.name})`);
        if (validateAdminAccess(adminUser).success) {
            console.log("✅ Lógica: PERMITIDO (Rol Admin)");
            const payload = {
                amount: 25000,
                type: 'expense',
                business_id: opBus.id,
                category_id: expCat.id,
                user_id: adminUser.id,
                date: new Date().toISOString(),
                note: "Simulación: Gasto operativo admin"
            };
            const { error } = await supabase.from('transactions').insert(payload);
            if (error) throw error;
            console.log("✅ RESULTADO: Gasto registrado exitosamente.");
        }

        console.log("\n🏁 Simulación administrativa finalizada con éxito.");

    } catch (e) {
        console.error("❌ Error en la simulación:", e.message);
    }
}

runSimulation();
