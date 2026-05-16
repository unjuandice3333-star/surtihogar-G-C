const https = require('https');

const configData = {
  botToken: '8037545998:AAH4zgAxhoNbZ1WKJXmCElwq7oHzi7IJ1LY',
  chatId: '6736325362'
};

console.log("🚀 Dispatching STANDALONE Telegram Welcome message to " + configData.chatId);
const text = encodeURIComponent("🤖 *¡ENLACE EXITOSO!* 🚀\n\nTu celular ha sido vinculado correctamente con el *Centro de Monitoreo Surtihogar G&C*.\n\nDe ahora en adelante recibirás alertas críticas automáticas si algún empleado abandona el rango asignado a su sede de trabajo.\n\n_Sistema Operativo y Blindado._");

const url = `https://api.telegram.org/bot${configData.botToken}/sendMessage?chat_id=${configData.chatId}&text=${text}&parse_mode=Markdown`;

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const result = JSON.parse(data);
    if (result.ok) {
      console.log("✅ Telegram Welcome Message Delivered successfully!");
    } else {
      console.warn("⚠️ Message failed. Did the user forget to start the bot first?", result);
    }
  });
}).on('error', err => {
  console.error("Telegram API Request Error:", err);
});
