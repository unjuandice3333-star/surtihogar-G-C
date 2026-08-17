import express from 'express';
import cron from 'node-cron';
import { 
  loadTelegramConfig, 
  botToken, 
  handleMessage, 
  handleCallbackQuery, 
  startBot 
} from './telegram_bot.js';
import { runDailyReport } from './send_daily_report.js';
import { runMonthlyReport } from './send_monthly_report.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Endpoint de salud para pings / mantener activo el bot gratis
app.get('/', (req, res) => {
  res.send('🤖 J&M Telegram Bot & Scheduler is active!');
});

// Endpoint de Webhook para Telegram (recibe mensajes y clics instantáneos)
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (err) {
    console.error("❌ Error procesando webhook:", err);
  }
  // Responder siempre 200 OK a Telegram rápido
  res.sendStatus(200);
});

// Programar el reporte diario automático a las 10:00 PM (Hora de Bogotá UTC-5)
cron.schedule('0 22 * * *', async () => {
  console.log("⏰ [Cron] Iniciando generación de reporte diario (10:00 PM Bogotá)...");
  try {
    // Forzamos el reporte del día actual
    await runDailyReport();
    console.log("✅ [Cron] Reporte diario generado y enviado con éxito.");
  } catch (err) {
    console.error("❌ [Cron] Error ejecutando reporte diario automático:", err);
  }
}, {
  scheduled: true,
  timezone: "America/Bogota"
});

// Programar chequeo a las 11:30 PM para el reporte mensual automático (Último día del mes)
cron.schedule('30 23 * * *', async () => {
  const now = new Date();
  // Sumar 1 día en hora de Bogotá
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  
  if (tomorrow.getDate() === 1) {
    console.log("⏰ [Cron] Último día del mes detectado. Iniciando reporte mensual de rendimiento (11:30 PM Bogotá)...");
    try {
      await runMonthlyReport();
      console.log("✅ [Cron] Reporte mensual de rendimiento enviado con éxito.");
    } catch (err) {
      console.error("❌ [Cron] Error ejecutando reporte mensual automático:", err);
    }
  }
}, {
  scheduled: true,
  timezone: "America/Bogota"
});

async function initialize() {
  // Cargar token y config desde Supabase
  await loadTelegramConfig();

  // Iniciar servidor Express para webhooks
  app.listen(PORT, async () => {
    console.log(`🚀 Servidor activo en puerto ${PORT}`);

    // Si está alojado en Render, configurar Webhook
    if (process.env.RENDER_EXTERNAL_URL) {
      const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook?url=${webhookUrl}`);
        const result = await res.json();
        if (result.ok) {
          console.log(`✅ Webhook de Telegram registrado con éxito: ${webhookUrl}`);
        } else {
          console.error("❌ Falló el registro de Webhook en Telegram:", result);
        }
      } catch (err) {
        console.error("❌ Error registrando Webhook en Telegram:", err);
      }
    } else {
      // Si corre localmente, usar Long Polling de respaldo para poder probar sin internet público
      console.log("ℹ️ RENDER_EXTERNAL_URL no detectado. Iniciando bucle de Long Polling local...");
      startBot();
    }
  });
}

initialize();
