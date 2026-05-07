import fs from 'fs';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div><select id="modal-category-select"></select><canvas id="managerChart"></canvas></body></html>', { url: 'http://localhost', runScripts: 'dangerously' });
const window = dom.window;

window.supabase = {
  from: () => ({
    select: () => {
      const chain = {
        order: () => chain,
        limit: () => Promise.resolve({ data: [{ tipo: 'GEOLOCATION_TRACK', mensaje: 'LLEGADA', created_at: new Date().toISOString(), users: {name: 'John'}, contexto: {coords: {lat: 1, lng: 1}} }], error: null }),
        eq: () => chain
      };
      return chain;
    },
    insert: () => Promise.resolve({ error: null })
  })
};

let scriptContent = fs.readFileSync('src/main.js', 'utf8');
scriptContent = scriptContent.replace(/import .*?from .*?;/g, '');
scriptContent = scriptContent.replace(/import '.*?';/g, '');

window.lucide = { createIcons: () => {} };
window.formatCurrency = (v) => v;

try {
  dom.window.eval(scriptContent);
  dom.window.state.user = { role: 'admin' };
  
  dom.window.fetchLogs('attendance_admin').then(() => {
    console.log('fetchLogs finished. State view:', dom.window.state.view);
    console.log('App HTML length:', dom.window.document.getElementById('app').innerHTML.length);
  }).catch(e => console.log('FETCH ERROR:', e));
} catch(e) { console.log('EVAL ERROR:', e); }
