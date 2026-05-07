// Reglas de negocio a validar (Copiadas de main.js)
const saveTransactionSimulated = (formInputBusId, activeShiftBusId, user) => {
    // LÓGICA DE PRIORIDAD:
    // 1. Turno Activo (Fuerza el ID)
    // 2. Si no hay turno y es admin, usa el input del form
    // 3. Si no hay turno y es empleado, usa su negocio base
    
    let finalBusId = activeShiftBusId; // PRIORIDAD 1
    
    if (!finalBusId) {
        finalBusId = user.role === 'admin' ? formInputBusId : user.business_id;
    }

    return finalBusId;
};

async function runSimulation() {
    console.log("🚀 SIMULACIÓN: BLINDAJE POR TURNO ACTIVO\n");

    const user = { name: "Empleado Test", role: "empleado", business_id: "bus_base_99" };
    const shiftBus = { id: "bus_muebles_01", name: "Muebles" };
    const attemptedBus = { id: "bus_electro_02", name: "Electrodomésticos" };

    console.log(`👤 Usuario: ${user.name} | Negocio Base: ${user.business_id}`);
    console.log(`📍 Turno Activo detectado en: ${shiftBus.name} (${shiftBus.id})`);
    console.log(`⚠️ Intento de manipulación manual hacia: ${attemptedBus.name} (${attemptedBus.id})\n`);

    console.log("--------------------------------------------");
    console.log("🏁 Procesando transacción...");

    // Ejecutamos la lógica de guardado
    const busIdResult = saveTransactionSimulated(attemptedBus.id, shiftBus.id, user);

    console.log(`🎯 Negocio asignado finalmente: ${busIdResult}`);

    if (busIdResult === shiftBus.id) {
        console.log("✅ RESULTADO: El sistema IGNORÓ el input manual y usó el TURNO ACTIVO.");
        console.log("✅ VALIDACIÓN: Imposible alterar el negocio durante el turno.");
    } else {
        console.log("❌ ERROR: El sistema permitió el cambio de negocio. Falla de seguridad.");
    }
    console.log("--------------------------------------------\n");
}

runSimulation();
