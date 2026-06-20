import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno
const envPath = path.resolve('c:/Users/yisle/surtihogar/.env');
dotenv.config({ path: envPath });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("❌ Error: No se encontraron las credenciales de Supabase en el archivo .env");
  process.exit(1);
}

// Desactivar temporalmente rechazo de certificados TLS inseguros si es necesario
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Configuración de Telegram cargada de Supabase de forma dinámica
let botToken = '';
let adminChatIds = [];

async function loadTelegramConfig() {
  try {
    const { data: configs } = await supabase
      .from('system_logs')
      .select('message')
      .eq('type', 'TELEGRAM_CONFIG')
      .order('timestamp', { ascending: false })
      .limit(1);

    if (configs && configs.length > 0) {
      const config = JSON.parse(configs[0].message);
      botToken = config.botToken;
      adminChatIds = config.chatId ? config.chatId.split(',').map(id => id.trim()).filter(Boolean) : [];
      console.log(`📡 Configuración de Telegram cargada: Token disponible, Admin Chat IDs: ${adminChatIds.join(', ')}`);
    }
  } catch (e) {
    console.error("⚠️ Error cargando la configuración de Telegram de Supabase:", e);
  }

  // Fallback si no está en base de datos
  if (!botToken) botToken = '8037545998:AAH4zgAxhoNbZ1WKJXmCElwq7oHzi7IJ1LY';
  if (adminChatIds.length === 0) adminChatIds = ['6736325362', '8676279926'];
}

// Estados de conversación para el registro de usuarios
const userStates = {};

// Normalizar texto para comparaciones flexibles (eliminar tildes, minúsculas, espacios)
function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

// Utilidades para llamadas a API de Telegram
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    console.error(`❌ Error enviando mensaje a ${chatId}:`, e);
  }
}

async function editTelegramMessage(chatId, messageId, text, replyMarkup = null) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML'
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    console.error(`❌ Error editando mensaje ${messageId} en ${chatId}:`, e);
  }
}

async function answerCallbackQuery(callbackQueryId, text = null, showAlert = false) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
    const payload = {
      callback_query_id: callbackQueryId
    };
    if (text) {
      payload.text = text;
      payload.show_alert = showAlert;
    }
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error("❌ Error respondiendo callback query:", e);
  }
}

// Consumo de Gemini API en crudo
async function parseRequestWithAI(messageText) {
  if (!geminiApiKey) {
    console.warn("⚠️ No se encontró la clave GEMINI_API_KEY. Usando parseo por reglas básicas.");
    return parseRequestWithRules(messageText);
  }

  try {
    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const now = new Date();
    const currentDayName = days[now.getDay()];
    const currentDateStr = now.toISOString().split('T')[0];

    const prompt = `
Eres un asistente experto para un sistema de turnos. Tu objetivo es procesar solicitudes en lenguaje natural de los empleados para cambios de turno y devolver un objeto JSON estructurado.

Hoy es ${currentDayName}, ${currentDateStr}.

Analiza la solicitud: "${messageText}"
Y devuelve EXACTAMENTE un objeto JSON con la siguiente estructura (sin formato de markdown, sin bloques de código, solo el texto JSON puro):
{
  "type": "change_hours" | "swap_employee" | "unknown",
  "date": "YYYY-MM-DD", // Fecha en la que se solicita el cambio, calculada a partir de la fecha de hoy.
  "requested_shift": "morning" | "afternoon" | "full" | "off" | "custom" | null, // mañana (morning, 8:00 a 14:00), tarde (afternoon, 14:00 a 21:00), completo (full, 8:30 a 20:30 o consolidado), libre/descanso (off), personalizado (custom si indican horas específicas como 'de 9am a 4pm') o null.
  "custom_start_time": "HH:MM" | null, // Si es 'custom' y especifican hora de entrada (ej: "09:00", "13:30"), de lo contrario null. Convertir formato 12h (am/pm) a 24h.
  "custom_end_time": "HH:MM" | null,   // Si es 'custom' y especifican hora de salida (ej: "17:00", "18:30"), de lo contrario null. Convertir formato 12h (am/pm) a 24h.
  "target_employee_name": "string" | null, // Nombre del empleado con el que se quiere cambiar/intercambiar (si se menciona).
  "reason": "string" | null // Razón de la solicitud si se menciona.
}

Instrucciones de cálculo de fechas:
- "este domingo", "el domingo": calcula la fecha del domingo de esta semana (o el próximo si ya pasó).
- "mañana": calcula la fecha del día siguiente.
- "el lunes", "este lunes": calcula la fecha del lunes correspondiente.
- Si la frase contiene un día de la semana, determina la fecha de ese día en el calendario de este año/mes actual basándote en que hoy es ${currentDateStr}.
- Si no hay fecha clara o es ambigua, pon "type": "unknown".
`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    });

    const data = await res.json();
    if (data.candidates && data.candidates[0].content.parts[0].text) {
      const jsonText = data.candidates[0].content.parts[0].text;
      return JSON.parse(jsonText);
    }
  } catch (err) {
    console.error("❌ Error llamando a Gemini API:", err);
  }

  return parseRequestWithRules(messageText);
}

// Mapeo básico de fallback si no hay API Key de Gemini
function parseRequestWithRules(text) {
  const norm = normalizeText(text);
  const result = {
    type: 'unknown',
    date: null,
    requested_shift: null,
    target_employee_name: null,
    reason: null
  };

  // Detectar fecha muy básica (mañana)
  const today = new Date();
  if (norm.includes('manana')) {
    const tomorrow = new Date(today.getTime() + 24*60*60*1000);
    result.date = tomorrow.toISOString().split('T')[0];
    result.type = 'change_hours';
  } else {
    // Si no tiene IA ni fecha básica, lo declaramos desconocido
    return result;
  }

  // Detectar horarios básicos
  if (norm.includes('manana')) result.requested_shift = 'morning';
  else if (norm.includes('tarde')) result.requested_shift = 'afternoon';
  else if (norm.includes('completo') || norm.includes('todo el dia')) result.requested_shift = 'full';
  else if (norm.includes('libre') || norm.includes('descanso')) result.requested_shift = 'off';

  // Buscar nombres comunes en la frase
  const commonNames = ['paola', 'nubia', 'blanca', 'carolina', 'andre', 'german', 'sebastian'];
  for (const name of commonNames) {
    if (norm.includes(`con ${name}`)) {
      result.target_employee_name = name;
      result.type = 'swap_employee';
      break;
    }
  }

  return result;
}

// Procesamiento de mensajes recibidos
async function handleMessage(message) {
  const chatId = message.chat.id;
  const messageText = message.text;

  if (!messageText) return;

  console.log(`📩 Mensaje recibido de ${chatId}: "${messageText}"`);

  // 1. Verificar si la empleada está vinculada en la base de datos
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_chat_id', chatId.toString())
    .limit(1);

  if (error) {
    console.error("Error consultando usuario:", error);
    return;
  }

  const currentUser = user && user.length > 0 ? user[0] : null;

  // 2. Si no está vinculado, iniciar registro
  if (!currentUser) {
    const state = userStates[chatId];
    if (!state) {
      userStates[chatId] = { step: 'awaiting_name' };
      await sendTelegramMessage(chatId, "👋 ¡Hola! No reconozco tu cuenta de Telegram vinculada en el sistema.\n\nPor favor, escribe tu **nombre y apellido completo** (tal como figura en la aplicación) para asociar tu usuario.");
    } else if (state.step === 'awaiting_name') {
      const inputName = normalizeText(messageText);
      
      // Buscar coincidencia en la base de datos de usuarios
      const { data: allUsers } = await supabase.from('users').select('id, name');
      const matches = allUsers.filter(u => normalizeText(u.name).includes(inputName) || inputName.includes(normalizeText(u.name)));

      if (matches.length === 1) {
        // Vinculación exitosa
        const targetUser = matches[0];
        await supabase
          .from('users')
          .update({ telegram_chat_id: chatId.toString() })
          .eq('id', targetUser.id);

        delete userStates[chatId];
        await sendTelegramMessage(chatId, `✅ ¡Vinculación exitosa! Hola **${targetUser.name}**.\n\nYa puedes pedirme cambios de turno de forma directa. Por ejemplo:\n• *"Cámbiame el turno del domingo a la tarde"* \n• *"Cambio turno con Paola el lunes"*`);
      } else if (matches.length > 1) {
        await sendTelegramMessage(chatId, `Encontré varias coincidencias para tu nombre:\n${matches.map(m => `• ${m.name}`).join('\n')}\n\nPor favor escribe tu nombre completo más específico.`);
      } else {
        await sendTelegramMessage(chatId, "⚠️ No pude encontrar un empleado con ese nombre en la base de datos. Por favor, vuelve a escribirlo o verifica con tu administrador.");
      }
    }
    return;
  }

  // 3. Manejar solicitudes de ayuda o comandos iniciales
  const normalizedMsg = normalizeText(messageText);
  if (normalizedMsg === '/start' || normalizedMsg === '/ayuda') {
    await sendTelegramMessage(chatId, `Hola **${currentUser.name}**. Estoy listo para tus solicitudes.\n\nEscríbeme de forma natural lo que necesitas cambiar de tus turnos programados (ej. cambio de horario o intercambio con otra persona).`);
    return;
  }

  // 4. Procesar la solicitud del cambio de turno con IA
  await sendTelegramMessage(chatId, "⏳ Procesando tu solicitud con la IA, un momento por favor...");
  const parsed = await parseRequestWithAI(messageText);

  if (parsed.type === 'unknown' || !parsed.date) {
    await sendTelegramMessage(chatId, "⚠️ No logré entender la fecha o el tipo de cambio que solicitas. Por favor escríbelo de forma más clara (ej. *'Cambio turno con Blanca el lunes 22 de junio'*).");
    return;
  }

  // Validar y estructurar datos del cambio
  const requestedDate = parsed.date;
  
  if (parsed.type === 'change_hours') {
    // Caso 1: Cambio de horas / turno
    let labelShift = '';
    let startHr = 8, startMin = 0, endHr = 21, endMin = 0;

    if (parsed.requested_shift === 'custom' && parsed.custom_start_time && parsed.custom_end_time) {
      const startParts = parsed.custom_start_time.split(':');
      const endParts = parsed.custom_end_time.split(':');
      startHr = parseInt(startParts[0]);
      startMin = parseInt(startParts[1] || '0');
      endHr = parseInt(endParts[0]);
      endMin = parseInt(endParts[1] || '0');
      labelShift = `Personalizado (${parsed.custom_start_time} - ${parsed.custom_end_time})`;
    } else if (parsed.requested_shift === 'morning') {
      labelShift = 'Mañana (8:00 AM - 2:00 PM)';
      startHr = 8; startMin = 0; endHr = 14; endMin = 0;
    } else if (parsed.requested_shift === 'afternoon') {
      labelShift = 'Tarde (2:00 PM - 9:00 PM)';
      startHr = 14; startMin = 0; endHr = 21; endMin = 0;
    } else if (parsed.requested_shift === 'full') {
      labelShift = 'Completo (8:30 AM - 8:30 PM)';
      startHr = 8; startMin = 30; endHr = 20; endMin = 30;
    } else if (parsed.requested_shift === 'off') {
      labelShift = 'Descanso / Libre';
    } else {
      await sendTelegramMessage(chatId, "⚠️ Por favor especifica a qué horario deseas cambiar (ej: mañana, tarde, completo, descanso, o un horario específico como '9am a 4pm').");
      return;
    }

    // Consultar horario actual
    const { data: currentShifts } = await supabase
      .from('shifts')
      .select('start_time, end_time')
      .eq('user_id', currentUser.id)
      .gte('start_time', `${requestedDate}T00:00:00`)
      .lte('start_time', `${requestedDate}T23:59:59`)
      .limit(1);

    let currentHoursText = 'Ninguno (Descanso)';
    if (currentShifts && currentShifts.length > 0) {
      const sh = currentShifts[0];
      const startD = new Date(sh.start_time);
      const endD = new Date(sh.end_time);
      currentHoursText = `${startD.toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit', hour12: true})} - ${endD.toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit', hour12: true})}`;
    }

    // Insertar solicitud en base de datos
    const { data: requestRecord, error: insErr } = await supabase
      .from('shift_requests')
      .insert({
        requester_id: currentUser.id,
        type: 'change_hours',
        date: requestedDate,
        details: {
          requested_shift: parsed.requested_shift,
          custom_start_time: parsed.custom_start_time || null,
          custom_end_time: parsed.custom_end_time || null,
          label: labelShift
        }
      })
      .select();

    if (insErr) {
      console.error(insErr);
      await sendTelegramMessage(chatId, "❌ Ocurrió un error al guardar la solicitud en la base de datos.");
      return;
    }

    const reqId = requestRecord[0].id;

    // Enviar alerta al Admin
    const adminMsg = `🔔 <b>SOLICITUD DE CAMBIO DE HORARIO</b>\n\n👤 <b>Empleado:</b> ${currentUser.name}\n📅 <b>Fecha:</b> ${requestedDate}\n🕒 <b>Horario actual:</b> ${currentHoursText}\n🔄 <b>Solicita cambiar a:</b> <b>${labelShift}</b>\n\n¿Deseas aprobar esta solicitud?`;
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Aprobar", callback_data: `app_${reqId}` },
          { text: "❌ Rechazar", callback_data: `rej_${reqId}` }
        ]
      ]
    };

    for (const adminId of adminChatIds) {
      await sendTelegramMessage(adminId, adminMsg, replyMarkup);
    }
    await sendTelegramMessage(chatId, `📨 He enviado tu solicitud de cambio al administrador para el día <b>${requestedDate}</b> (Cambio a: *${labelShift}*). Te avisaré en cuanto lo apruebe.`);

  } else if (parsed.type === 'swap_employee') {
    // Caso 2: Intercambio con otro empleado
    const targetName = parsed.target_employee_name;
    if (!targetName) {
      await sendTelegramMessage(chatId, "⚠️ Por favor indica con qué compañera(o) deseas intercambiar el turno.");
      return;
    }

    const { data: allUsers } = await supabase.from('users').select('id, name');
    const matches = allUsers.filter(u => normalizeText(u.name).includes(normalizeText(targetName)));

    if (matches.length === 0) {
      await sendTelegramMessage(chatId, `⚠️ No encontré a ningún empleado llamado "${targetName}" en el sistema.`);
      return;
    } else if (matches.length > 1) {
      await sendTelegramMessage(chatId, `Encontré varios empleados con ese nombre:\n${matches.map(m => `• ${m.name}`).join('\n')}\n\nPor favor vuelve a solicitarlo usando el nombre completo de la persona.`);
      return;
    }

    const targetUser = matches[0];

    // Consultar horarios actuales de ambos en la BD para dar contexto al administrador
    const { data: shiftReq } = await supabase
      .from('shifts')
      .select('*')
      .eq('user_id', currentUser.id)
      .gte('start_time', `${requestedDate}T00:00:00`)
      .lte('start_time', `${requestedDate}T23:59:59`)
      .limit(1);

    const { data: shiftTarget } = await supabase
      .from('shifts')
      .select('*')
      .eq('user_id', targetUser.id)
      .gte('start_time', `${requestedDate}T00:00:00`)
      .lte('start_time', `${requestedDate}T23:59:59`)
      .limit(1);

    const sReq = shiftReq && shiftReq.length > 0 ? shiftReq[0] : null;
    const sTarget = shiftTarget && shiftTarget.length > 0 ? shiftTarget[0] : null;

    let detailMsg = '';
    let reqDetails = {
      target_user_id: targetUser.id,
      target_user_name: targetUser.name
    };

    if (sReq && sTarget) {
      const timeReq = `${new Date(sReq.start_time).toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit', hour12: true})} - ${new Date(sReq.end_time).toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit', hour12: true})}`;
      const timeTarget = `${new Date(sTarget.start_time).toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit', hour12: true})} - ${new Date(sTarget.end_time).toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit', hour12: true})}`;
      
      detailMsg = `• <b>${currentUser.name}</b> trabaja en el horario de ${targetUser.name}: <b>${timeTarget}</b>\n• <b>${targetUser.name}</b> trabaja en el horario de ${currentUser.name}: <b>${timeReq}</b>`;
      reqDetails.has_both_shifts = true;
      reqDetails.time_req = timeReq;
      reqDetails.time_target = timeTarget;
    } else if (sReq) {
      const timeReq = `${new Date(sReq.start_time).toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit', hour12: true})} - ${new Date(sReq.end_time).toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit', hour12: true})}`;
      detailMsg = `• <b>${targetUser.name}</b> reemplaza a ${currentUser.name} en su turno de <b>${timeReq}</b> (Andrea descansará).`;
      reqDetails.has_req_shift_only = true;
      reqDetails.time_req = timeReq;
    } else if (sTarget) {
      const timeTarget = `${new Date(sTarget.start_time).toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit', hour12: true})} - ${new Date(sTarget.end_time).toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit', hour12: true})}`;
      detailMsg = `• <b>${currentUser.name}</b> reemplaza a ${targetUser.name} en su turno de <b>${timeTarget}</b> (Nubia descansará).`;
      reqDetails.has_target_shift_only = true;
      reqDetails.time_target = timeTarget;
    } else {
      detailMsg = `⚠️ Ninguno tiene turnos registrados para ese día aún.`;
    }

    // Registrar solicitud
    const { data: requestRecord, error: insErr } = await supabase
      .from('shift_requests')
      .insert({
        requester_id: currentUser.id,
        type: 'swap_employee',
        date: requestedDate,
        details: reqDetails
      })
      .select();

    if (insErr) {
      console.error(insErr);
      await sendTelegramMessage(chatId, "❌ Ocurrió un error al guardar la solicitud.");
      return;
    }

    const reqId = requestRecord[0].id;

    // Enviar alerta al Admin
    const adminMsg = `🔔 <b>SOLICITUD DE INTERCAMBIO/REEMPLAZO</b>\n\n📅 <b>Fecha:</b> ${requestedDate}\n\n${detailMsg}\n\n¿Deseas aprobar esta solicitud?`;
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Aprobar Intercambio", callback_data: `app_${reqId}` },
          { text: "❌ Rechazar", callback_data: `rej_${reqId}` }
        ]
      ]
    };

    for (const adminId of adminChatIds) {
      await sendTelegramMessage(adminId, adminMsg, replyMarkup);
    }
    await sendTelegramMessage(chatId, `📨 He enviado tu solicitud al administrador para intercambiar turno con <b>${targetUser.name}</b> el día <b>${requestedDate}</b>. Te avisaré la respuesta.`);
  }
}

// Procesamiento de clics en los botones del Admin
async function handleCallbackQuery(callbackQuery) {
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  const adminId = callbackQuery.message.chat.id;

  // Filtro de seguridad: Solo permitir clics de administradores autorizados
  if (!adminChatIds.includes(adminId.toString())) {
    console.warn(`⚠️ Intento de acción no autorizada de chat ID: ${adminId}`);
    await answerCallbackQuery(callbackQuery.id, "⚠️ No estás autorizado como administrador para esta acción.", true);
    return;
  }

  // Detener el spinner de carga en Telegram inmediatamente
  await answerCallbackQuery(callbackQuery.id);

  if (!data.startsWith('app_') && !data.startsWith('rej_')) return;

  const action = data.startsWith('app_') ? 'approve' : 'reject';
  const reqId = data.substring(4);

  // 1. Obtener la solicitud
  const { data: requests, error } = await supabase
    .from('shift_requests')
    .select('*, requester:users!requester_id(*)')
    .eq('id', reqId)
    .limit(1);

  if (error || !requests || requests.length === 0) {
    await sendTelegramMessage(adminId, "⚠️ No se encontró la solicitud seleccionada.");
    return;
  }

  const request = requests[0];

  if (request.status !== 'pending') {
    await editTelegramMessage(adminId, messageId, `⚠️ Esta solicitud ya fue resuelta anteriormente (Estado: ${request.status.toUpperCase()}).`);
    return;
  }

  if (action === 'reject') {
    // Actualizar solicitud
    await supabase.from('shift_requests').update({ status: 'rejected' }).eq('id', reqId);
    
    // Editar mensaje del admin
    await editTelegramMessage(adminId, messageId, `❌ <b>Solicitud Rechazada</b>\n\n👤 <b>Empleado:</b> ${request.requester.name}\n📅 <b>Fecha:</b> ${request.date}\n\nEl cambio de turno ha sido rechazado.`);
    
    // Avisar a la empleada
    await sendTelegramMessage(request.requester.telegram_chat_id, `⚠️ Tu solicitud de cambio de turno para el día <b>${request.date}</b> ha sido **rechazada** por el administrador.`);
    
  } else if (action === 'approve') {
    // 1. Aplicar cambios en base de datos
    const targetDate = request.date;
    const requesterId = request.requester_id;

    if (request.type === 'change_hours') {
      const shiftType = request.details.requested_shift;
      
      if (shiftType === 'off') {
        // Caso descanso: Eliminar el turno de ese día
        await supabase
          .from('shifts')
          .delete()
          .eq('user_id', requesterId)
          .gte('start_time', `${targetDate}T00:00:00`)
          .lte('start_time', `${targetDate}T23:59:59`);
      } else {
        // Determinar horas
        let startHr = 8, startMin = 0, endHr = 21, endMin = 0;
        if (shiftType === 'custom' && request.details.custom_start_time && request.details.custom_end_time) {
          const startParts = request.details.custom_start_time.split(':');
          const endParts = request.details.custom_end_time.split(':');
          startHr = parseInt(startParts[0]);
          startMin = parseInt(startParts[1] || '0');
          endHr = parseInt(endParts[0]);
          endMin = parseInt(endParts[1] || '0');
        } else if (shiftType === 'morning') {
          startHr = 8;
          endHr = 14;
        } else if (shiftType === 'afternoon') {
          startHr = 14;
          endHr = 21;
        } else if (shiftType === 'full') {
          startHr = 8;
          startMin = 30;
          endHr = 20;
          endMin = 30;
        }

        const startLocal = new Date(`${targetDate}T00:00:00`);
        startLocal.setHours(startHr, startMin, 0, 0);
        const endLocal = new Date(`${targetDate}T00:00:00`);
        endLocal.setHours(endHr, endMin, 0, 0);

        // Buscar si ya existe un turno para actualizarlo
        const { data: existing } = await supabase
          .from('shifts')
          .select('id')
          .eq('user_id', requesterId)
          .gte('start_time', `${targetDate}T00:00:00`)
          .lte('start_time', `${targetDate}T23:59:59`)
          .limit(1);

        if (existing && existing.length > 0) {
          await supabase
            .from('shifts')
            .update({
              start_time: startLocal.toISOString(),
              end_time: endLocal.toISOString()
            })
            .eq('id', existing[0].id);
        } else {
          // Si no existe, crear uno nuevo con el negocio por defecto
          await supabase
            .from('shifts')
            .insert({
              user_id: requesterId,
              business_id: request.requester.business_id,
              start_time: startLocal.toISOString(),
              end_time: endLocal.toISOString()
            });
        }
      }

    } else if (request.type === 'swap_employee') {
      const targetUserId = request.details.target_user_id;

      // Buscar turnos de ambos para ese día
      const { data: shiftReq } = await supabase
        .from('shifts')
        .select('*')
        .eq('user_id', requesterId)
        .gte('start_time', `${targetDate}T00:00:00`)
        .lte('start_time', `${targetDate}T23:59:59`)
        .limit(1);

      const { data: shiftTarget } = await supabase
        .from('shifts')
        .select('*')
        .eq('user_id', targetUserId)
        .gte('start_time', `${targetDate}T00:00:00`)
        .lte('start_time', `${targetDate}T23:59:59`)
        .limit(1);

      const sReq = shiftReq && shiftReq.length > 0 ? shiftReq[0] : null;
      const sTarget = shiftTarget && shiftTarget.length > 0 ? shiftTarget[0] : null;

      if (sReq && sTarget) {
        // Intercambiar IDs de usuario
        await supabase.from('shifts').update({ user_id: targetUserId }).eq('id', sReq.id);
        await supabase.from('shifts').update({ user_id: requesterId }).eq('id', sTarget.id);
      } else if (sReq) {
        // Solo el solicitante tenía turno, se lo pasa a la otra persona
        await supabase.from('shifts').update({ user_id: targetUserId }).eq('id', sReq.id);
      } else if (sTarget) {
        // Solo el destino tenía turno, se lo pasa al solicitante
        await supabase.from('shifts').update({ user_id: requesterId }).eq('id', sTarget.id);
      } else {
        await editTelegramMessage(adminId, messageId, "⚠️ Ninguno de los dos tiene turnos generados para esa fecha para realizar el intercambio.");
        return;
      }
    }

    // Actualizar estado de la solicitud
    await supabase.from('shift_requests').update({ status: 'approved' }).eq('id', reqId);

    // Editar mensaje del admin
    await editTelegramMessage(adminId, messageId, `✅ <b>Solicitud Aprobada y Aplicada</b>\n\n👤 <b>Empleado:</b> ${request.requester.name}\n📅 <b>Fecha:</b> ${request.date}\n\nLos cambios se han aplicado en la base de datos de forma exitosa.`);

    // Avisar a la empleada solicitante
    await sendTelegramMessage(request.requester.telegram_chat_id, `🎉 ¡Excelente noticia! Tu solicitud de cambio para el día <b>${request.date}</b> ha sido **APROBADA** y aplicada en el sistema.`);

    // Avisar a la otra empleada si fue un intercambio
    if (request.type === 'swap_employee') {
      const { data: tUser } = await supabase
        .from('users')
        .select('telegram_chat_id')
        .eq('id', request.details.target_user_id)
        .limit(1);
      
      if (tUser && tUser.length > 0 && tUser[0].telegram_chat_id) {
        await sendTelegramMessage(tUser[0].telegram_chat_id, `🔔 Hola, te informamos que se ha aprobado un intercambio de turno con **${request.requester.name}** para el día <b>${request.date}</b>.`);
      }
    }
  }
}

// Bucle principal de ejecución (Long Polling)
async function startBot() {
  await loadTelegramConfig();
  console.log("🤖 Iniciando bucle de Long Polling para el bot de Surtihogar...");

  let offset = 0;

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=20`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;

          if (update.message) {
            await handleMessage(update.message);
          } else if (update.callback_query) {
            await handleCallbackQuery(update.callback_query);
          }
        }
      }
    } catch (err) {
      console.error("⚠️ Error en el bucle del bot:", err);
    }
    // Pausa breve para no saturar
    await new Promise(r => setTimeout(r, 1000));
  }
}

export {
  loadTelegramConfig,
  botToken,
  adminChatIds,
  handleMessage,
  handleCallbackQuery,
  sendTelegramMessage,
  editTelegramMessage,
  startBot
};

if (process.argv[1] && process.argv[1].includes('telegram_bot.js') && !process.env.RENDER) {
  startBot();
}
