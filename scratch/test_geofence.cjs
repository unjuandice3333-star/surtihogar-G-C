const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

// Configuración de Prueba
const TEST_USER_ID = 'ef4d854e-c6d4-4307-a7ff-18cd167eddde'; // André
const BIZ_ID = 'e349c48f-70d8-4832-a322-b6508476dec4'; // Electrodomésticos y celulares
const BIZ_LAT = 4.4420178;
const BIZ_LNG = -74.0446619;
const RADIUS = 100;

// Función de distancia (Haversine)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function simulateTest() {
    console.log('🚀 Iniciando TEST DE GEOCERCA Y SEÑALES...');
    
    // 1. Simular pulso DENTRO de la geocerca
    const insideLat = BIZ_LAT + 0.0001; 
    const insideLng = BIZ_LNG + 0.0001;
    console.log(`📍 Enviando pulso DENTRO (${insideLat}, ${insideLng})...`);
    
    await supabase.from('device_heartbeats').insert({
        user_id: TEST_USER_ID,
        lat: insideLat,
        lng: insideLng,
        accuracy: 10,
        battery_level: 85,
        network_status: 'wifi',
        app_state: 'FOREGROUND'
    });

    // 2. Simular pulso FUERA de la geocerca (BREACH)
    const outsideLat = BIZ_LAT + 0.01; 
    const outsideLng = BIZ_LNG + 0.01;
    const dist = getDistance(outsideLat, outsideLng, BIZ_LAT, BIZ_LNG);
    console.log(`🚨 Enviando pulso FUERA (${outsideLat}, ${outsideLng}) - Distancia: ${Math.round(dist)}m...`);

    await supabase.from('device_heartbeats').insert({
        user_id: TEST_USER_ID,
        lat: outsideLat,
        lng: outsideLng,
        accuracy: 10,
        battery_level: 82,
        network_status: 'lte',
        app_state: 'BACKGROUND'
    });

    // 3. Simular la Alerta que enviaría el servicio
    console.log('🔔 Generando Log de Alerta Crítica en Supabase...');
    await supabase.from('system_logs').insert({
        user_id: TEST_USER_ID,
        type: 'SECURITY_ALERT',
        severity: 'CRITICAL',
        module: 'TEST_AGENT',
        message: JSON.stringify({ 
            text: `🔴 TEST ABANDONO: André salió del perímetro (SIMULACIÓN).`, 
            context: { type: 'GEOFENCE_EXIT', distance: Math.round(dist), geofenceName: 'Surtihogar Test' } 
        })
    });

    console.log('✅ TEST FINALIZADO. Revisa el dashboard de Gerencia en la app.');
}

simulateTest();
