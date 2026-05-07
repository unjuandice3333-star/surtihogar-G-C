import { createClient } from '@supabase/supabase-js';
import { JSDOM } from 'jsdom';
import fs from 'fs';

const supabase = createClient(
  'https://ohlfzkshypvxmgztnzub.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obGZ6a3NoeXB2eG1nenRuenViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNTI2NDcsImV4cCI6MjA5MjgyODY0N30.vFoil43f1bRVCO26AZMVzKDXW5mnNAKSpDt6Qf0epjw'
);

async function runTests() {
  console.log("--- INICIANDO TEST DE FUNCIONALIDAD ---");
  const errors = [];
  
  // 1. Simular Empleado (Insertar registro)
  console.log("\\n[1] EMPLEADO: Registrando llegada...");
  const fakeContext = { coords: { lat: 4.6097, lng: -74.0817, accuracy: 12.5 } };
  const msgData = JSON.stringify({ text: "LLEGADA", context: fakeContext });
  
  const { error: insertError } = await supabase.from('system_logs').insert({ 
    type: 'GEOLOCATION_TRACK', 
    message: msgData, 
    module: 'financial', 
    user_id: null // anonymous
  });

  if (insertError) {
    console.log("❌ ERROR EMPLEADO: No se pudo insertar en la base de datos.");
    errors.push("Fallo al insertar coordenada: " + insertError.message);
  } else {
    console.log("✅ EMPLEADO: Llegada guardada en base de datos correctamente.");
  }

  // 2. Simular Admin (Recuperar registros)
  console.log("\\n[2] ADMIN: Recuperando registros...");
  let query = supabase.from('system_logs').select('*, users!user_id(name)').eq('type', 'GEOLOCATION_TRACK').order('timestamp', { ascending: false }).limit(5);
  const { data: logs, error: fetchError } = await query;

  if (fetchError) {
    console.log("❌ ERROR ADMIN: Fallo consulta de logs.");
    errors.push("Admin no pudo leer los logs: " + fetchError.message);
  } else if (!logs || logs.length === 0) {
    console.log("❌ ERROR ADMIN: La consulta devolvió 0 resultados a pesar de haber insertado uno.");
    errors.push("Consulta de admin retornó vacía.");
  } else {
    console.log("✅ ADMIN: Registros recuperados (" + logs.length + " encontrados).");
    console.log("Último registro recuperado:", JSON.stringify(logs[0]));
    
    // 3. Simular Renderizado
    console.log("\\n[3] ADMIN: Renderizando tabla...");
    try {
      const scriptContent = fs.readFileSync('src/main.js', 'utf8').split('\\n').filter(line => !line.trim().startsWith('import ')).join('\\n');
      const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div><select id="modal-category-select"></select><canvas id="managerChart"></canvas></body></html>', { runScripts: 'dangerously' });
      dom.window.supabase = supabase;
      dom.window.lucide = { createIcons: () => {} };
      dom.window.formatCurrency = (v) => v;
      dom.window.Chart = class { constructor() {} destroy() {} };
      
      dom.window.eval(scriptContent);
      dom.window.state.user = { role: 'admin' };
      dom.window.state.systemLogs = logs;
      dom.window.state.view = 'attendance_admin';
      
      // Llamar manualmente render
      dom.window.render();
      
      const html = dom.window.document.getElementById('app').innerHTML;
      if (html.includes('VER EN MAPA') && html.includes('LLEGADA')) {
        console.log("✅ RENDER: La interfaz genera el HTML de la tabla con el enlace al mapa correctamente.");
      } else {
        console.log("❌ RENDER: Faltan elementos esperados en el HTML.");
        errors.push("Render de asistencia no contiene el botón de MAPA o el texto LLEGADA.");
      }
    } catch(e) {
      console.log("❌ ERROR RENDER:", e.message);
      errors.push("Error JS al renderizar admin: " + e.message);
    }
  }

  console.log("\\n--- RESULTADOS DEL TEST ---");
  if (errors.length === 0) {
    console.log("🚀 TODO FUNCIONA PERFECTAMENTE.");
  } else {
    console.log("⚠️ ERRORES ENCONTRADOS:");
    errors.forEach(e => console.log("- " + e));
  }
}

runTests();
