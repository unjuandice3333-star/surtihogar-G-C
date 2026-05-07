async function runMockDashboardSimulation() {
    console.log("🚀 SIMULACIÓN: CONSOLIDACIÓN CON DATOS DE MUESTRA\n");

    // Datos de Negocios
    const businesses = [
        { id: "op_1", name: "Tienda Celulares", type: "operativo" },
        { id: "op_2", name: "Muebles", type: "operativo" },
        { id: "arr_1", name: "Droguería", type: "arriendo" },
        { id: "arr_2", name: "Billar", type: "arriendo" }
    ];

    // Datos de Transacciones (Simuladas)
    const transactions = [
        { amount: 1000000, type: 'income', business_id: 'op_1' }, // Venta Celular
        { amount: 500000, type: 'income', business_id: 'op_2' },  // Venta Mueble
        { amount: 200000, type: 'expense', business_id: 'op_1' }, // Gasto Operativo
        { amount: 800000, type: 'income', business_id: 'arr_1' }, // Renta Droguería
        { amount: 1200000, type: 'income', business_id: 'arr_2' },// Renta Billar
        { amount: 100000, type: 'expense', business_id: 'arr_1' }  // Mantenimiento Local
    ];

    console.log(`📊 Procesando: ${businesses.length} negocios | ${transactions.length} movimientos de prueba`);
    console.log("--------------------------------------------");

    // Lógica de Consolidación
    const opTrx = transactions.filter(t => {
        const b = businesses.find(bus => bus.id === t.business_id);
        return b && b.type === 'operativo';
    });

    const arrTrx = transactions.filter(t => {
        const b = businesses.find(bus => bus.id === t.business_id);
        return b && b.type === 'arriendo';
    });

    const opInc = opTrx.filter(t => t.type === 'income').reduce((s,t) => s + t.amount, 0);
    const opExp = opTrx.filter(t => t.type === 'expense').reduce((s,t) => s + t.amount, 0);

    const arrInc = arrTrx.filter(t => t.type === 'income').reduce((s,t) => s + t.amount, 0);
    const arrExp = arrTrx.filter(t => t.type === 'expense').reduce((s,t) => s + t.amount, 0);

    console.log("🏢 BLOQUE 1: NEGOCIOS OPERATIVOS");
    console.log(`   💰 Ingresos:  $${opInc.toLocaleString()} (Ventas directas)`);
    console.log(`   💸 Gastos:    $${opExp.toLocaleString()} (Costos operativos)`);
    console.log(`   📈 Utilidad:  $${(opInc - opExp).toLocaleString()}`);
    
    console.log("\n🏠 BLOQUE 2: NEGOCIOS DE ARRIENDO");
    console.log(`   💰 Ingresos:  $${arrInc.toLocaleString()} (Rentas cobradas)`);
    console.log(`   💸 Gastos:    $${arrExp.toLocaleString()} (Mantenimiento)`);
    console.log(`   📊 Utilidad:  $${(arrInc - arrExp).toLocaleString()}`);

    console.log("\n--------------------------------------------");
    console.log(`✅ TOTAL CAJA: $${(opInc + arrInc).toLocaleString()}`);
    console.log("✅ VALIDACIÓN: Los bloques se calculan de forma independiente.");
    console.log("🏁 Simulación finalizada.");
}

runMockDashboardSimulation();
