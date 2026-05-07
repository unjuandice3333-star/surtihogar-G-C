import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

const tests = [
  { file: 'test_auth.js', name: '🔐 Autenticación y Sesiones' },
  { file: 'test_businesses.js', name: '🏢 Integridad de Negocios' },
  { file: 'test_transactions.js', name: '🧮 Matemáticas y Flujo de Caja' },
  { file: 'test_arriendo.js', name: '🏠 Restricciones de Arriendos' },
  { file: 'test_reports.js', name: '📊 Motor de Reportes y Tiempos' },
  { file: 'test_employee_rls.js', name: '🛡️ Seguridad RLS (Empleados)' },
  { file: 'test_notes.js', name: '📝 Sistema de Notas' }
];

async function runMasterTestSuite() {
  console.log("=================================================");
  console.log("🤖 INICIANDO AUDITORÍA GENERAL DEL SISTEMA");
  console.log("=================================================\n");

  const results = {
    total: tests.length,
    passed: 0,
    failed: 0,
    errors: []
  };

  for (const test of tests) {
    process.stdout.write(`⏳ Ejecutando: ${test.name} ... `);
    try {
      const { stdout, stderr } = await execPromise(`node ${test.file}`);
      console.log('✅ PASSED');
      results.passed++;
    } catch (error) {
      console.log('❌ FAILED');
      results.failed++;
      
      // Extraer el error real del output
      const errorLines = error.stdout.split('\n').concat(error.stderr.split('\n'));
      const detalleLine = errorLines.find(line => line.includes('Detalle:'));
      const criticalError = detalleLine ? detalleLine.replace('Detalle: ', '') : error.message.split('\n')[0];
      
      results.errors.push({
        test: test.name,
        file: test.file,
        detail: criticalError.trim()
      });
    }
  }

  console.log("\n=================================================");
  console.log("📊 RESUMEN FINAL DE AUDITORÍA");
  console.log("=================================================");
  console.log(`🔹 Total de pruebas : ${results.total}`);
  console.log(`✅ Tests Exitosos   : ${results.passed}`);
  console.log(`❌ Tests Fallidos   : ${results.failed}`);
  
  if (results.failed > 0) {
    console.log("\n⚠️ DETALLE DE ERRORES Y SUGERENCIAS DE CORRECCIÓN:");
    results.errors.forEach((err, idx) => {
      console.log(`\n[${idx + 1}] Fallo en: ${err.test}`);
      console.log(`    📌 Motivo: ${err.detail}`);
      
      // Sugerencias automáticas
      console.log(`    💡 Sugerencia Automática:`);
      if (err.file === 'test_employee_rls.js') {
        console.log("       → Ejecuta el script 'fix_rls_3.sql' en Supabase para reparar las políticas de lectura/escritura de transacciones.");
      } else if (err.file === 'test_reports.js') {
        console.log("       → Verifica que no haya datos basura recientes en la base de datos o revisa la lógica de filtrado de fechas en main.js.");
      } else if (err.file === 'test_auth.js') {
        console.log("       → Verifica que las variables de entorno de Supabase en .env sean válidas y que los usuarios de prueba no estén bloqueados.");
      } else if (err.file === 'test_businesses.js') {
        console.log("       → Asegúrate de que los negocios por defecto existan en la tabla y que el tipo (operativo/arriendo) esté bien escrito.");
      } else {
        console.log("       → Revisa los logs de la consola o la base de datos para inconsistencias en los datos ingresados.");
      }
    });
    
    console.log("\n🛑 AUDITORÍA RECHAZADA. El sistema requiere correcciones.");
    process.exit(1);
  } else {
    console.log("\n🎉 AUDITORÍA PERFECTA. El sistema está 100% blindado y listo para producción. 🚀");
    process.exit(0);
  }
}

runMasterTestSuite();
