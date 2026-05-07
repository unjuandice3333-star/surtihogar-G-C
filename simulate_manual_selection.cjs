const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Mock del estado para la simulación
const state = {
    user: { id: "emp_123", role: "empleado", business_id: "bus_default" },
    activeShiftBusinessId: null, // SIN TURNO
    businesses: [
        { id: "op_1", name: "Tienda Celulares", type: "operativo" },
        { id: "op_2", name: "Muebles", type: "operativo" },
        { id: "arr_1", name: "Droguería", type: "arriendo" }
    ]
};

// Lógica de renderizado del dropdown (Simulada)
const getDropdownOptions = (user, businesses) => {
    // Si es empleado, filtramos por operativo
    const filtered = businesses.filter(b => b.type === 'operativo');
    return filtered.map(b => b.name);
};

// Lógica de validación antes de guardar
const validateTransaction = (busId) => {
    if (!busId || busId === "") {
        return { success: false, error: "Error de validación: Debes seleccionar un negocio o tener un turno activo." };
    }
    return { success: true };
};

async function runSimulation() {
    console.log("🚀 SIMULACIÓN: EMPLEADO SIN TURNO ACTIVO\n");

    console.log("--------------------------------------------");
    console.log("1. Detectando Estado:");
    console.log(`Usuario: ${state.user.role} | Turno Activo: ${state.activeShiftBusinessId ? 'SÍ' : 'NO'}`);

    console.log("\n2. Abriendo Formulario:");
    const options = getDropdownOptions(state.user, state.businesses);
    console.log("✅ Dropdown mostrado (Manual)");
    console.log("📋 Negocios disponibles en la lista:");
    options.forEach(opt => console.log(`   - ${opt}`));
    
    const hasRental = options.some(opt => opt === "Droguería");
    if (!hasRental) {
        console.log("✅ VALIDACIÓN: Solo se muestran negocios OPERATIVOS.");
    } else {
        console.log("❌ ERROR: Se están mostrando negocios de arriendo.");
    }

    console.log("\n3. Intentando Guardar SIN seleccionar negocio:");
    const result = validateTransaction(""); // Simula no seleccionar nada
    
    if (!result.success) {
        console.log("🚫 ACCIÓN BLOQUEADA");
        console.log(`💬 MENSAJE DE ERROR: "${result.error}"`);
        console.log("✅ VALIDACIÓN: El sistema impidió el guardado sin negocio.");
    } else {
        console.log("❌ ERROR: El sistema permitió guardar sin negocio.");
    }
    console.log("--------------------------------------------\n");
}

runSimulation();
