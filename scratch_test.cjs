const fs = require('fs');
const content = fs.readFileSync('c:/Users/yisle/RIVO/next_terra_web/control_financiero/src/main.js', 'utf8');
const start = content.indexOf("else if (state.view === 'attendance_admin')");
const end = content.indexOf("else if (state.view === 'logs')");
const block = content.substring(start, end);
const fn = new Function('state', 'let html=""; if(false){} ' + block + '; return html;');

const state1 = { view: 'attendance_admin', systemLogs: [] };
console.log('Empty logs html length:', fn(state1).length);

const state2 = { view: 'attendance_admin', systemLogs: [
  { tipo: 'GEOLOCATION_TRACK', mensaje: null, created_at: null, users: null, contexto: null }
] };
console.log('Null fields html length:', fn(state2).length);
