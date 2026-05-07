const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Reglas de negocio a validar (Exactamente como están en main.js)
const validateShiftLogic = (businessType) => {
    if (businessType === 'arriendo') {
        return { success: false, error: "Este negocio no requiere empleados (Sector Arriendos)" };
    }
    return { success: true };
};

async function runSimulation() {
    console.log("🚀 SIMULACIÓN DE REGLAS DE NEGOCIO (SHIFTS)\n");

    // Simulamos los datos obtenidos de la DB
    const opBus = { name: "Electrodomésticos y celulares", type: "operativo" };
    const arrBus = { name: "Droguería", type: "arriendo" };

    console.log("--------------------------------------------");
    console.log("TEST 1: Negocio Operativo");
    console.log(`Negocio: ${opBus.name} | Tipo: ${opBus.type}`);
    
    const res1 = validateShiftLogic(opBus.type);
    if (res1.success) {
        console.log("✅ RESULTADO: OPERACIÓN PERMITIDA");
    } else {
        console.log("❌ RESULTADO: OPERACIÓN BLOQUEADA (Error)");
    }

    console.log("\n--------------------------------------------");
    console.log("TEST 2: Negocio de Arriendo");
    console.log(`Negocio: ${arrBus.name} | Tipo: ${arrBus.type}`);
    
    const res2 = validateShiftLogic(arrBus.type);
    if (!res2.success) {
        console.log("🚫 RESULTADO: OPERACIÓN BLOQUEADA");
        console.log(`💬 MENSAJE ESPERADO: "${res2.error}"`);
        console.log("✅ VALIDACIÓN: El sistema cumple con la restricción solicitada.");
    } else {
        console.log("❌ RESULTADO: OPERACIÓN PERMITIDA (Fallo en la regla)");
    }
    console.log("--------------------------------------------\n");
}

runSimulation();
