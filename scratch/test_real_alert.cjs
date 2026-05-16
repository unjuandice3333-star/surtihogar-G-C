const { createClient } = require('@supabase/supabase-js');
const https = require('https');
require('dotenv').config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function testRealAlert() {
    console.log('🚨 SIMULANDO ALERTA CRÍTICA DE PERÍMETRO...');

    // 1. Obtener Config de la DB (como hace el servicio)
    const { data: configs } = await supabase
        .from('system_logs')
        .select('message')
        .eq('type', 'TELEGRAM_CONFIG')
        .order('timestamp', { ascending: false })
        .limit(1);

    if (!configs || configs.length === 0) {
        console.error('❌ Error: No se encontró configuración de Telegram en la DB.');
        return;
    }

    const config = JSON.parse(configs[0].message);
    const employeeName = "André (TEST)";
    const sedeName = "Surtihogar Principal";
    const distance = 2450;

    const alertMsg = `🚨 <b>ALERTA DE SEGURIDAD (TEST)</b> 🚨\n\nEl colaborador <b>${employeeName}</b> ha ABANDONADO el perímetro seguro de 📍 <b>${sedeName}</b>.\n\n📏 Distancia: <b>${distance}m</b>\n🕒 Hora: ${new Date().toLocaleTimeString()}\n\n<i>Este es un mensaje de prueba del sistema de monitoreo.</i>`;

    console.log('📤 Enviando alerta a Telegram...');
    
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const payload = JSON.stringify({
        chat_id: config.chatId,
        text: alertMsg,
        parse_mode: 'HTML'
    });

    const req = https.request(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length
        }
    }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
            const result = JSON.parse(data);
            if (result.ok) {
                console.log('✅ Alerta de Seguridad recibida por Telegram!');
            } else {
                console.error('❌ Error de Telegram API:', result);
            }
        });
    });

    req.on('error', e => console.error(e));
    req.write(payload);
    req.end();
}

testRealAlert();
