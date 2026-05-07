const fs = require('fs');

const { JSDOM } = require('jsdom');
const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="app"></div><select id="modal-category-select"></select></body></html>`, { url: "http://localhost" });

global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};
global.alert = console.log;
global.console.error = () => {};

// mock supabase
global.supabase = {
  from: () => ({
    select: () => ({
      order: () => {
        const chain = {
          limit: () => Promise.resolve({ data: [{ tipo: 'GEOLOCATION_TRACK', mensaje: 'LLEGADA', created_at: new Date().toISOString(), users: {name: 'John'}, contexto: {coords: {lat: 1, lng: 1}} }], error: null }),
          eq: () => chain
        };
        return chain;
      }
    }),
    insert: () => Promise.resolve({ error: null })
  })
};

global.lucide = { createIcons: () => {} };

// load script
const scriptContent = fs.readFileSync('src/main.js', 'utf8');

try {
  dom.window.eval(scriptContent);
  
  // Now call fetchLogs
  dom.window.state.user = { role: 'admin' };
  dom.window.fetchLogs('attendance_admin').then(() => {
    console.log("fetchLogs finished. State view:", dom.window.state.view);
    console.log("App innerHTML length:", document.getElementById('app').innerHTML.length);
  }).catch(e => {
    console.error("fetchLogs failed:", e.stack);
  });
} catch(e) {
  console.error("Script eval failed:", e.stack);
}
