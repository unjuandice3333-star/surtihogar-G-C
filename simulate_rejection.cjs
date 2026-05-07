// Reglas de negocio a validar (Exactamente como están en main.js)
const validateTransactionLogic = (user, business) => {
    if (user.role === 'empleado' && business && business.type !== 'operativo') {
        return { success: false, error: "No autorizado para este negocio" };
    }
    return { success: true };
};

async function runSimulation() {
    console.log("🚀 SIMULACIÓN DE BLOQUEO POR ROL (ARRIENDOS)\n");

    const user = { name: "Empleado Test", role: "empleado" };
    
    const targetBusinesses = [
        { name: "Billar", type: "arriendo" },
        { name: "Droguería", type: "arriendo" }
    ];

    console.log(`👤 Usuario Logueado: ${user.name} (${user.role})`);
    console.log("--------------------------------------------");

    targetBusinesses.forEach(bus => {
        console.log(`📝 Intentando registrar en: ${bus.name} (${bus.type})`);
        
        const result = validateTransactionLogic(user, bus);
        
        if (!result.success) {
            console.log("🚫 ACCIÓN BLOQUEADA");
            console.log(`💬 MENSAJE DE ERROR: "${result.error}"`);
            console.log("✅ VALIDACIÓN: El sistema impidió el registro correctamente.");
        } else {
            console.log("❌ ERROR: El sistema permitió el registro (Fallo de seguridad)");
        }
        console.log("---");
    });

    console.log("\n🏁 Simulación de seguridad finalizada.");
}

runSimulation();
