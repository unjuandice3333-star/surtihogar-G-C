import './style.css'
import { supabase } from './lib/supabase'
import { SupplierService } from './services/SupplierService'
import { DatabaseService } from './services/DatabaseService'
import { byodService } from './services/ByodComplianceService'
import { renderSalesHistory } from './views/salesHistory.js'
import { renderProductsAdmin } from './views/productsAdmin.js'
import { renderInventoryAIView } from './views/inventoryAIView.js'
import { analyzeInventoryAI, generateSupplierOrderText, fetchGeminiInventoryAnalysis } from './inventoryAI.js'
import { Geolocation } from '@capacitor/geolocation'
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

// Centralización de Filtros (Mejores Prácticas DRY)
const RENTAL_BUSINESSES = ['Billar', 'Droguería', 'Local ropa', 'Restaurante'];
const TEST_BUSINESSES = ['Mi Primer Negocio', 'Mi Negocio Principal'];

const state = {
  user: null,
  businesses: [],
  categories: [],
  transactions: [],
  currentBusinessId: 'all',
  timeFilter: 'daily',
  loading: true,
  view: 'loading',
  authError: null,
  activeModal: null,
  geminiApiKey: localStorage.getItem('gemini_api_key') || import.meta.env.VITE_GEMINI_API_KEY || 'AIzaSyD3nv7WzpZqp3TGtLTPvFpV3lHaf__Rj5U',
  geminiAnalysisResult: null,
  systemLogs: [],
  realDbSchema: [],
  chartInstance: null,
  activeShiftBusinessId: null,
  shifts: [],
  employees: [],
  editingShift: null,
  selectedUserId: null,
  selectedDate: null,
  products: [],
  cart: [],
  posSearch: '',
  posGenderFilter: 'all',
  sales: [],
  saleItems: [],
  pendingProducts: [],
  payrollData: null,
  qaResults: [],
  editingRateUser: null,
  posPaymentMethod: 'Efectivo',
  posDiscount: 0,
  cashClosures: []
};

const safeQuery = async (queryBuilder, fallback = { data: [] }) => {
  try {
    const res = await queryBuilder;
    if (res && res.error) {
      console.warn("Advertencia en base de datos:", res.error.message);
      return fallback;
    }
    return res;
  } catch (err) {
    console.warn("Fallo de red o consulta en base de datos:", err.message);
    return fallback;
  }
};

const resolveActiveBusiness = (shifts, user) => {
  if (!user) return null;
  if (user.role === 'admin') return 'all';

  const userShifts = (shifts || []).filter(s => s.user_id === user.id);
  if (userShifts.length === 0) return user.business_id;

  const nowLocal = new Date();

  // A. Turno activo estricto por hora (comparar start_time/end_time con hora actual)
  const strictShift = userShifts.find(s => {
    const start = new Date(s.start_time);
    const end = s.end_time ? new Date(s.end_time) : null;
    return nowLocal >= new Date(start.getTime() - 60000) && (!end || nowLocal <= end);
  });
  if (strictShift) return strictShift.business_id;

  // B. Turno programado HOY (si existe turno en fecha calendario actual, usar ese business_id)
  const todayStr = nowLocal.toDateString();
  const todayShift = userShifts.find(s => {
    const start = new Date(s.start_time);
    return start.toDateString() === todayStr;
  });
  if (todayShift) return todayShift.business_id;

  // C. Último turno reciente (programado hace menos de 12 horas)
  const sortedShifts = [...userShifts].sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  if (sortedShifts.length > 0) {
    const lastShift = sortedShifts[0];
    const lastShiftStart = new Date(lastShift.start_time);
    const diffMs = Math.abs(nowLocal.getTime() - lastShiftStart.getTime());
    if (diffMs < 12 * 60 * 60 * 1000) { // Menos de 12 horas
      return lastShift.business_id;
    }
  }

  // D. Fallback final
  return user.business_id;
};

window.fetchData = async () => {
  try {
    state.loading = true;
    
    // 1. Garantizar que la sesión se restablezca en el cliente Supabase antes de cualquier consulta
    const { data: { session } } = await supabase.auth.getSession();
    
    // 2. Cargar Negocios (con datos de geocerca) - Ahora con JWT autenticado disponible si hay sesión
    const { data: busRes, error: busErr } = await supabase.from('businesses').select('id, name, type, lat, lng, geofence_radius_meters');
    if (busErr) console.warn("Aviso cargando negocios:", busErr.message);
    state.businesses = busRes || [];

    if (!session) { 
      if (state.view !== 'register') state.view = 'auth'; 
      state.loading = false;
      if (window.render) window.render(); else render(); 
      return; 
    }

    // 3. Cargar Perfil del Usuario logueado (con try-catch robusto)
    let profRes = null;
    try {
      const { data } = await supabase.from('users').select('*').eq('id', session.user.id).maybeSingle();
      profRes = data;
    } catch (e) {
      console.warn("Aviso cargando perfil:", e);
    }
    state.user = profRes || { id: session.user.id, name: 'Admin', role: 'admin' };

    // === INICIO GENERADOR DE TURNOS CONTINUO DE 4 SEMANAS ===
    if (state.user?.role === 'admin') {
      try {
        // Limpieza inyectada temporal para inicializar turnos de André y Andrea Torres sin afectar a los demás
        const hasCleanedV6 = localStorage.getItem('shifts_cleaned_v6');
        if (!hasCleanedV6) {
          window.showToast("⏳ Inicializando turnos para André y Andrea Torres...", "info");
          const today = new Date();
          today.setHours(0,0,0,0);
          
          try {
            // 1. Eliminar SOLAMENTE los turnos futuros de André y Andrea Torres
            await supabase.from('shifts')
              .delete()
              .in('user_id', ['ef4d854e-c6d4-4307-a7ff-18cd167eddde', '3c076f65-ff17-4116-9303-7758ab0f20a7'])
              .gte('start_time', today.toISOString());
              
            // 2. Generar sus turnos por defecto desde hoy hasta fin del próximo mes
            const now = new Date();
            const nextMonthEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0);
            nextMonthEnd.setHours(23,59,59,999);
            
            let tempDate = new Date(today);
            const shiftsToInsert = [];
            
            while (tempDate <= nextMonthEnd) {
              const day = tempDate.getDay();
              
              // André (ef4d854e-c6d4-4307-a7ff-18cd167eddde)
              if (day !== 5 && day !== 6) { // Domingo a Jueves
                const start = new Date(tempDate);
                start.setHours(8, 30, 0, 0);
                const end = new Date(tempDate);
                end.setHours(20, 30, 0, 0);
                shiftsToInsert.push({
                  user_id: 'ef4d854e-c6d4-4307-a7ff-18cd167eddde',
                  business_id: 'e349c48f-70d8-4832-a322-b6508476dec4',
                  start_time: start.toISOString(),
                  end_time: end.toISOString()
                });
              }
              
              // Andrea Torres (3c076f65-ff17-4116-9303-7758ab0f20a7)
              if (day !== 4 && day !== 6) { // Domingo a Miércoles y Viernes
                const start = new Date(tempDate);
                start.setHours(10, 0, 0, 0);
                const end = new Date(tempDate);
                end.setHours(20, 0, 0, 0);
                shiftsToInsert.push({
                  user_id: '3c076f65-ff17-4116-9303-7758ab0f20a7',
                  business_id: '9b99027c-7471-4c16-80c2-29e2645312e8',
                  start_time: start.toISOString(),
                  end_time: end.toISOString()
                });
              }
              
              tempDate.setDate(tempDate.getDate() + 1);
            }
            
            if (shiftsToInsert.length > 0) {
              const BATCH_SIZE = 50;
              for (let i = 0; i < shiftsToInsert.length; i += BATCH_SIZE) {
                const batch = shiftsToInsert.slice(i, i + BATCH_SIZE);
                await supabase.from('shifts').insert(batch);
              }
            }
            
            localStorage.setItem('shifts_cleaned_v6', 'true');
            localStorage.removeItem('last_shift_generation_check'); // Forzar ejecución del generador
            window.showToast("✅ Turnos inicializados exitosamente.", "success");
          } catch(e) {
            console.error("Error inicializando turnos para André/Andrea:", e);
          }
        }

        const lastCheck = localStorage.getItem('last_shift_generation_check');
        const nowMs = Date.now();
        const shouldCheck = !lastCheck || (nowMs - parseInt(lastCheck) > 43200000); // 12 horas de throttle
        
        if (shouldCheck) {
          localStorage.setItem('last_shift_generation_check', nowMs.toString());
          
          const EMPLOYEES = {
            N: '1541567b-e1b9-4baa-b6b1-c61b990d848f',
            PM: '42043c7a-0505-4b22-bd05-f4a90d51e924',
            B: '68466365-6338-44aa-b564-16c77b645c91',
            PQ: 'e7bdc58c-894a-4fbe-8664-7052a5bf9885',
            C: '6d02bcd1-d485-4799-9de8-0f7531dee85b'
          };

          const SCHEDULE = [
            // SEMANA 1
            [{ m: ['N', 'PM'], t: ['B', 'PQ'] }, { m: ['N', 'PM'], t: ['B', 'PQ'] }, { m: ['N', 'PM'], t: ['B', 'C'] }, { m: ['N', 'C'], t: ['B', 'PQ'] }, { m: ['N', 'C'], t: ['N', 'B'] }, { m: ['N', 'PQ'], t: ['B', 'PQ'] }, { m: ['PM', 'PQ'], t: ['PM', 'PQ'] }],
            // SEMANA 2
            [{ m: ['B', 'PQ'], t: ['N', 'PQ'] }, { m: ['B', 'PM'], t: ['N', 'PM'] }, { m: ['B', 'PM'], t: ['N', 'PQ'] }, { m: ['B', 'C'], t: ['N', 'PQ'] }, { m: ['PM', 'PQ'], t: ['N', 'PQ'] }, { m: ['B', 'PQ'], t: ['N', 'PQ'] }, { m: ['PM', 'B'], t: ['B', 'PM'] }],
            // SEMANA 3
            [{ m: ['B', 'PQ'], t: ['B', 'PM'] }, { m: ['N', 'PQ'], t: ['B', 'PM'] }, { m: ['N', 'C'], t: ['B', 'PM'] }, { m: ['N', 'PQ'], t: ['B', 'C'] }, { m: ['N', 'PQ'], t: ['B', 'C'] }, { m: ['N', 'PQ'], t: ['B', 'PQ'] }, { m: ['N', 'PQ'], t: ['N', 'PQ'] }],
            // SEMANA 4
            [{ m: ['B', 'PQ'], t: ['N', 'PM'] }, { m: ['B', 'PQ'], t: ['B', 'PM'] }, { m: ['B', 'C'], t: ['N', 'PM'] }, { m: ['N', 'PQ'], t: ['N', 'C'] }, { m: ['B', 'PQ'], t: ['N', 'C'] }, { m: ['N', 'B'], t: ['N', 'C'] }, { m: ['B', 'PQ'], t: ['B', 'PM'] }]
          ];

          const anchorMonday = new Date(2026, 4, 25); // Lunes 25 Mayo 2026 (Semana 3)
          anchorMonday.setHours(0,0,0,0);
          
          const getMondayOfDate = (d) => {
            const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            const day = monday.getDay();
            monday.setDate(monday.getDate() - day + (day === 0 ? -6 : 1));
            monday.setHours(0,0,0,0);
            return monday;
          };
          
          const BUSINESS_ID = 'ec292ea5-5cfd-44d8-8b1c-e093cb719492';
          
          // Determinar límite: Fin del próximo mes
          const now = new Date();
          const nextMonthEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0);
          nextMonthEnd.setHours(0,0,0,0);
          
          // Obtener todos los turnos para usarlos en el algoritmo de lookback semanal
          const { data: allExistingShiftsData } = await supabase
            .from('shifts')
            .select('user_id, business_id, start_time, end_time');
            
          const allExistingShifts = allExistingShiftsData || [];
          
          // Obtener el último turno de la BD
          const { data: latestShifts } = await supabase.from('shifts').select('start_time').order('start_time', { ascending: false }).limit(1);
          
          let currentDate = new Date(now.getFullYear(), now.getMonth(), 1);
          currentDate.setHours(0,0,0,0);

          if (latestShifts && latestShifts.length > 0) {
            const lastDate = new Date(latestShifts[0].start_time);
            lastDate.setHours(0,0,0,0);
            currentDate = new Date(lastDate);
            currentDate.setDate(currentDate.getDate() + 1);
          } else {
            // Si no hay turnos a futuro, iniciar desde hoy
            const today = new Date();
            today.setHours(0,0,0,0);
            currentDate = today;
          }

          if (currentDate <= nextMonthEnd) {
            window.showToast("🔄 Replicando y generando turnos...", "info");
            const shiftsToInsert = [];
            
            const getShiftsOnDay = (dateObj) => {
              const dateStr = dateObj.toDateString();
              return allExistingShifts.filter(s => {
                const d = new Date(s.start_time);
                return d.toDateString() === dateStr;
              });
            };
            
            while (currentDate <= nextMonthEnd) {
              const sourceDate = new Date(currentDate);
              sourceDate.setDate(sourceDate.getDate() - 7);
              
              const sourceShifts = getShiftsOnDay(sourceDate);
              
              if (sourceShifts.length > 0) {
                // Replicar de la semana anterior
                sourceShifts.forEach(s => {
                  const origStart = new Date(s.start_time);
                  const origEnd = new Date(s.end_time);
                  
                  const start = new Date(currentDate);
                  start.setHours(origStart.getHours(), origStart.getMinutes(), 0, 0);
                  
                  const end = new Date(currentDate);
                  const dayDiff = origEnd.getDate() - origStart.getDate();
                  end.setDate(end.getDate() + dayDiff);
                  end.setHours(origEnd.getHours(), origEnd.getMinutes(), 0, 0);
                  
                  const newShift = {
                    user_id: s.user_id,
                    business_id: s.business_id,
                    start_time: start.toISOString(),
                    end_time: end.toISOString()
                  };
                  
                  shiftsToInsert.push(newShift);
                  allExistingShifts.push(newShift); // Agregar en memoria para la siguiente iteración
                });
              } else {
                // Fallback al esquema por defecto anterior
                const targetMonday = getMondayOfDate(currentDate);
                const diffMs = targetMonday.getTime() - anchorMonday.getTime();
                const diffWeeks = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
                const weekIndex = ((2 + diffWeeks) % 4 + 4) % 4;
                
                const day = currentDate.getDay();
                const dayOfWeek = day === 0 ? 6 : day - 1;
                const dayConfig = SCHEDULE[weekIndex][dayOfWeek];
                
                const mEmps = dayConfig.m || [];
                const tEmps = dayConfig.t || [];
                const allEmps = new Set([...mEmps, ...tEmps]);
                
                allEmps.forEach(empKey => {
                  const userId = EMPLOYEES[empKey];
                  if (!userId) return;
                  
                  const inMorning = mEmps.includes(empKey);
                  const inAfternoon = tEmps.includes(empKey);
                  
                  let startHr = 8;
                  let endHr = 14;
                  
                  if (inMorning && inAfternoon) {
                    startHr = 8;
                    endHr = 21;
                  } else if (inAfternoon) {
                    startHr = 14;
                    endHr = 21;
                  }
                  
                  const start = new Date(currentDate); start.setHours(startHr, 0, 0, 0);
                  const end = new Date(currentDate); end.setHours(endHr, 0, 0, 0);
                  
                  const newShift = {
                    user_id: userId,
                    business_id: BUSINESS_ID,
                    start_time: start.toISOString(),
                    end_time: end.toISOString()
                  };
                  shiftsToInsert.push(newShift);
                  allExistingShifts.push(newShift);
                });

                // André
                if (day !== 5 && day !== 6) {
                  const start = new Date(currentDate);
                  start.setHours(8, 30, 0, 0);
                  const end = new Date(currentDate);
                  end.setHours(20, 30, 0, 0);
                  const newShift = {
                    user_id: 'ef4d854e-c6d4-4307-a7ff-18cd167eddde',
                    business_id: 'e349c48f-70d8-4832-a322-b6508476dec4',
                    start_time: start.toISOString(),
                    end_time: end.toISOString()
                  };
                  shiftsToInsert.push(newShift);
                  allExistingShifts.push(newShift);
                }

                // Andrea Torres
                if (day !== 4 && day !== 6) {
                  const start = new Date(currentDate);
                  start.setHours(10, 0, 0, 0);
                  const end = new Date(currentDate);
                  end.setHours(20, 0, 0, 0);
                  const newShift = {
                    user_id: '3c076f65-ff17-4116-9303-7758ab0f20a7',
                    business_id: '9b99027c-7471-4c16-80c2-29e2645312e8',
                    start_time: start.toISOString(),
                    end_time: end.toISOString()
                  };
                  shiftsToInsert.push(newShift);
                  allExistingShifts.push(newShift);
                }
              }
              
              currentDate.setDate(currentDate.getDate() + 1);
            }
            
            if (shiftsToInsert.length > 0) {
              const BATCH_SIZE = 50;
              for (let i = 0; i < shiftsToInsert.length; i += BATCH_SIZE) {
                const batch = shiftsToInsert.slice(i, i + BATCH_SIZE);
                await supabase.from('shifts').insert(batch);
              }
              window.showToast("✅ Turnos replicados y generados exitosamente.", "success");
              
              // Recargar datos si es necesario para refrescar la UI de inmediato
              if (window.location.hash.includes('manager')) {
                 setTimeout(() => fetchData(), 1000);
              }
            }
          }
        }
      } catch(e) {
        console.error("Error generando turnos automáticos:", e);
      }
    }
    // === FIN GENERADOR DE TURNOS CONTINUO ===

    // 3. Determinar Negocio Actual antes de seguir
    // (Aún no tenemos turnos, así que usamos el del perfil como fallback temporal)
    const initialBusId = state.currentBusinessId === 'all' ? 'all' : (state.currentBusinessId || state.user?.business_id || 'all');

    // 4. Cargar Transacciones y Categorías vía DatabaseService (con catch individual)
    let categories = [];
    let transactions = [];
    try {
      const [catRes, txRes] = await Promise.all([
        DatabaseService.fetchCategories().catch(err => { console.warn("Error cargando categorías:", err); return []; }),
        DatabaseService.fetchTransactions(initialBusId).catch(err => { console.warn("Error cargando transacciones:", err); return []; })
      ]);
      categories = catRes;
      transactions = txRes;
    } catch (e) {
      console.warn("Aviso en transacciones/categorías:", e);
    }

    state.categories = categories || [];
    state.transactions = transactions || [];

    // 5. Cargas Administrativas o de Colaborador (Turnos)
    if (state.user.role === 'admin') {
      try {
        const fetchAll = async (tableName, selectStr, orderByField) => {
          let all = [];
          let page = 0;
          while(true) {
            let q = supabase.from(tableName).select(selectStr);
            if (orderByField) q = q.order(orderByField, { ascending: false });
            q = q.range(page * 1000, (page + 1) * 1000 - 1);
            const res = await safeQuery(q);
            if (!res?.data || res.data.length === 0) break;
            all.push(...res.data);
            if (res.data.length < 1000) break;
            page++;
          }
          return { data: all };
        };

        const shPromise = fetchAll('shifts', '*, businesses(name)', 'start_time');
        const empPromise = safeQuery(supabase.from('users').select('*'));
        const salesPromise = fetchAll('sales', '*', 'created_at');
        const itemsPromise = fetchAll('sale_items', '*, products(name, business_id, cost)', null);
        const pendingPromise = safeQuery(supabase.from('pending_products').select('*').order('created_at', { ascending: false }));
        const suppliersPromise = safeQuery(SupplierService.loadAll(state.user.id), []);
        const polyPromise = safeQuery(supabase.from('system_logs').select('message').eq('type', 'GEOFENCE_POLYGON').order('timestamp', { ascending: false }));
        const closuresPromise = safeQuery(supabase.from('cash_closures').select('*, users(name), businesses(name)').order('created_at', { ascending: false }));

        const [shRes, empRes, salesRes, itemsRes, pendingRes, suppliersData, polyRes, closuresRes] = await Promise.all([
          shPromise, empPromise, salesPromise, itemsPromise, pendingPromise, suppliersPromise, polyPromise, closuresPromise
        ]);

        state.shifts = shRes?.data || [];
        state.employees = empRes?.data || [];
        state.sales = salesRes?.data || [];
        state.saleItems = itemsRes?.data || [];
        state.pendingProducts = pendingRes?.data || [];
        state.suppliers = suppliersData || [];
        state.cashClosures = closuresRes?.data || [];

        // Cargar Polígonos de Geocercas (Última versión por negocio)
        state.geofencePolygons = {};
        if (polyRes?.data) {
          polyRes.data.forEach(log => {
            try {
              const config = JSON.parse(log.message);
              if (config.business_id && !state.geofencePolygons[config.business_id]) {
                 state.geofencePolygons[config.business_id] = config;
              }
            } catch(e) {}
          });
        }
      } catch (err) {
        console.warn("Aviso cargando datos administrativos:", err);
      }
    } else {
      state.timeFilter = 'daily'; // Forzar filtro de Hoy / Turno para colaboradores por defecto
      try {
        const shPromise = safeQuery(supabase.from('shifts').select('*, businesses(lat, lng, geofence_radius_meters, name)').eq('user_id', session.user.id));
        const attPromise = safeQuery(supabase.from('system_logs').select('message').eq('user_id', session.user.id).eq('type', 'GEOLOCATION_TRACK').order('timestamp', { ascending: false }).limit(1));
        const closuresPromise = safeQuery(supabase.from('cash_closures').select('*, users(name), businesses(name)').order('created_at', { ascending: false }).limit(10));

        const [shRes, attRes, closuresRes] = await Promise.all([shPromise, attPromise, closuresPromise]);
        state.shifts = shRes?.data || [];
        state.cashClosures = closuresRes?.data || [];
        
        // Validar si hay un turno físico activo por GPS
        let hasGeoActive = false;
        try {
          if (attRes?.data?.[0]) {
            const msg = JSON.parse(attRes.data[0].message);
            if (msg.text && msg.text.includes('LLEGADA')) hasGeoActive = true;
          }
        } catch(e) {}
        state.hasActiveAttendance = hasGeoActive;
        
        // Calcular turno activo inmediato para alimentar el servicio BYOD local
        const activeShiftLocalId = resolveActiveBusiness(state.shifts, state.user);
        const activeShiftLocal = (state.shifts || []).find(s => s.business_id === activeShiftLocalId);

        // Activar/Desactivar motor de telemetría silenciosa BYOD con Geocerca
        if (hasGeoActive && state.user?.role !== 'admin') {
           const biz = activeShiftLocal?.businesses || state.businesses.find(b => b.id === state.currentBusinessId);
           if (biz) {
             biz.polygonConfig = state.geofencePolygons?.[biz.id];
             byodService.startTracking(session.user.id, biz);
           }
        } else {
           byodService.stopTracking();
        }
      } catch (err) {
        console.warn("Aviso cargando datos de turno/asistencia:", err);
      }
    }

    // 6. Actualizar Turno Activo y Negocio Definitivo (Arquitectura Robustecida)
    state.activeShiftBusinessId = resolveActiveBusiness(state.shifts, state.user);
    state.currentBusinessId = state.activeShiftBusinessId || 'all';

    // 7. Carga de productos (Agrupación Inteligente para Clúster Centralizado)
    let prodData = [];
    try {
      let prodQuery = supabase.from('products').select('*, businesses(name)').order('name');
      const finalFilterId = state.activeShiftBusinessId && state.activeShiftBusinessId !== 'all' ? state.activeShiftBusinessId : null;
      
      if (finalFilterId) {
         prodQuery = prodQuery.eq('business_id', finalFilterId);
      }
      
      const { data } = await prodQuery;
      prodData = data || [];
    } catch (e) {
      console.warn("Aviso cargando productos:", e);
    }
    state.products = prodData;

    // 7.5 Carga de la Lista de Compras
    try {
      const { data: shopData } = await supabase.from('shopping_list').select('*, users(name), businesses(name)').order('created_at', { ascending: false });
      state.shoppingList = shopData || [];
    } catch (e) {
      console.warn("Aviso cargando lista de compras:", e);
      state.shoppingList = [];
    }

    // --- INICIO AUTOSANACIÓN DE LA BD ---
    if (state.user?.role === 'admin' && state.sales && state.transactions) {
      setTimeout(async () => {
        try {
          const mSales = state.sales;
          const mTx = state.transactions;
          for (const s of mSales) {
            const saleShortId = s.id.slice(0, 5);
            let t = mTx.find(t => t.note && t.note.includes(saleShortId));
            if (!t && s.note && s.note.startsWith('Venta informal: ')) {
              const descPart = s.note.replace('Venta informal: ', '').trim();
              t = mTx.find(tx => tx.type === 'income' && tx.user_id === s.user_id && (tx.description === descPart || tx.description === 'Venta Rápida: ' + descPart) && Math.abs(new Date(tx.date) - new Date(s.created_at)) < 120000);
            }
            if (!t) {
              t = mTx.find(tx => tx.type === 'income' && tx.user_id === s.user_id && Math.abs(new Date(tx.date) - new Date(s.created_at)) < 60000);
            }
            if (t && Number(t.amount) !== Number(s.total)) {
              await supabase.from('transactions').update({ amount: s.total }).eq('id', t.id);
            }
          }
        } catch(e){}
        try {
          await window.runAutomaticTelegramReports();
        } catch(e){}
      }, 3000);
    }
    // --- FIN AUTOSANACIÓN ---

  } catch (e) { 
    console.error("Error Crítico en fetchData:", e);
    state.view = 'connection_error';
    window.showToast('⚠️ Error de conexión: ' + e.message, 'danger');
  } finally { 
    state.loading = false; 
    if (window.render) window.render(); else render(); 
  }
};

window.logSystemError = async (tipo, mensaje, modulo, contexto = {}) => {
  try {
    const userId = state.user ? state.user.id : null;
    console.error(`[SYSTEM_${tipo}]`, mensaje, modulo, contexto);
    const msgData = JSON.stringify({ text: mensaje, context: contexto });
    await supabase.from('system_logs').insert({ type: tipo, message: msgData, module: modulo, user_id: userId });
  } catch(e) { console.error("Fallo al registrar log:", e); }
};

window.logSecurityEvent = async (mensaje, modulo, contexto = {}) => {
  await window.logSystemError('SECURITY_ALERT', mensaje, modulo, contexto);
};

window.fetchByodDashboard = async () => {
  state.loading = true;
  render();
  try {
    // Parche Maestro: Decoplar consultas relacionales para evitar error de schema cache (HTTP 400)
    const [hbRes, scRes, logsRes, shiftRes, telRes, polyRes] = await Promise.all([
      supabase.from('device_heartbeats').select('*').order('timestamp', { ascending: false }).limit(150),
      supabase.from('operational_scores').select('*').order('score', { ascending: false }),
      supabase.from('system_logs').select('*').eq('type', 'SECURITY_ALERT').order('timestamp', { ascending: false }).limit(20),
      supabase.from('shifts').select('*, businesses(id, name, lat, lng, geofence_radius_meters)').is('end_time', null),
      supabase.from('system_logs').select('message').eq('type', 'TELEGRAM_CONFIG').order('timestamp', { ascending: false }).limit(1),
      supabase.from('system_logs').select('message').eq('type', 'GEOFENCE_POLYGON').order('timestamp', { ascending: false })
    ]);
    
    if (hbRes.error) throw hbRes.error;
    if (scRes.error) throw scRes.error;
    if (logsRes.error) throw logsRes.error;
    if (shiftRes.error) throw shiftRes.error;

    state.byodHeartbeats = hbRes.data || [];
    state.byodScores = scRes.data || [];
    state.byodSecurityLogs = logsRes.data || [];
    state.byodActiveShifts = shiftRes.data || [];
    
    try {
      state.byodTelegramConfig = telRes.data?.[0] ? JSON.parse(telRes.data[0].message) : null;
    } catch(e) {
      state.byodTelegramConfig = null;
    }

    // Cargar Polígonos de Geocercas (Última versión por negocio)
    state.geofencePolygons = {};
    if (polyRes.data) {
      polyRes.data.forEach(log => {
        try {
          const config = JSON.parse(log.message);
          if (config.business_id && config.polygon && !state.geofencePolygons[config.business_id]) {
            state.geofencePolygons[config.business_id] = config.polygon;
          }
        } catch(e) {}
      });
    }
    
    // Hidratación Autónoma del personal para búsquedas en memoria impecables
    if (!state.employees || state.employees.length === 0) {
      const { data: empRes } = await supabase.from('users').select('id, name, role, active');
      state.employees = empRes || [];
    }

    state.view = 'byod_dashboard';
  } catch(e) {
    window.showToast("Error cargando BYOD: " + e.message, "danger");
  } finally {
    state.loading = false;
    render();
  }
};

window.fetchLogs = async (targetView = 'logs') => {
  state.loading = true;
  state.view = 'loading';
  render();
  try {
    let query = supabase.from('system_logs').select('*, users!user_id(name)');
    if (targetView === 'attendance_admin') {
      query = query.eq('type', 'GEOLOCATION_TRACK');
      // Limpieza automática de registros mayores a 30 días (background)
      try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        supabase.from('system_logs').delete().lt('timestamp', thirtyDaysAgo.toISOString()).then(() => {});
      } catch(e) {}
    }
    const { data, error } = await query.order('timestamp', { ascending: false }).limit(50);
    
    if (error) throw error;
    state.systemLogs = data || [];
    state.view = targetView;
  } catch(e) {
    window.showToast("Error cargando logs: " + e.message, "danger");
    state.view = 'manager_dashboard';
  } finally {
    state.loading = false;
    render();
  }
};

window.updateModalCategories = (busId, modalType) => {
  const select = document.getElementById('modal-category-select');
  if (!select) return;
  const bus = state.businesses.find(b => b.id === busId);
  if (!bus) return;
  
  let validCategories = state.categories.filter(c => c.type === (modalType === 'sale' ? 'income' : 'expense'));
  
  if (modalType === 'sale') {
    // Filtrar solo las categorías principales solicitadas
    validCategories = validCategories.filter(c => ['Venta', 'Arriendo'].includes(c.name));
  }
  
  select.innerHTML = '<option value="">Selecciona categoría...</option>' + 
    validCategories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
};

window.updateModalBusinesses = (catId) => {
  const busSelect = document.getElementById('modal-business-select');
  if (!busSelect) return;
  
  const cat = state.categories.find(c => c.id === catId);
  if (!cat) return;

  let filteredBusinesses = [];

  // Lógica: Arriendo vs Operativos
  if (cat.name === 'Arriendo') {
    filteredBusinesses = state.businesses.filter(b => RENTAL_BUSINESSES.includes(b.name));
  } else {
    // Para cualquier otra categoría (Venta, Compra, Gasto, etc.)
    filteredBusinesses = state.businesses.filter(b => !RENTAL_BUSINESSES.includes(b.name) && !TEST_BUSINESSES.includes(b.name));
  }

  busSelect.innerHTML = '<option value="">Selecciona negocio...</option>' + 
    filteredBusinesses.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
};

window.openModal = async (type, shiftId = null, userId = null, date = null) => {
  state.activeModal = type;
  state.editingShift = null;
  state.selectedUserId = userId;
  state.selectedDate = date;

  if (type === 'shift' && shiftId) {
    state.editingShift = state.shifts.find(s => s.id === shiftId);
  }
  
  // Consultar turno activo en tiempo real
  if (state.user) {
    try {
      const { data: shiftBusId } = await supabase.rpc('get_active_shift', { 
        p_user_id: state.user.id, 
        p_current_time: new Date().toISOString() 
      });
      // Lógica defensiva: NO sobrescribir con null si falla o retorna null
      if (shiftBusId) {
        state.activeShiftBusinessId = shiftBusId;
      }
    } catch(e) { console.warn("Error en RPC get_active_shift:", e); }
  }

  if (type === 'cash_closure') {
    state.selectedClosureBusinessId = state.activeShiftBusinessId || state.user?.business_id || '';
  }

  render();
  setTimeout(() => {
    const busSelect = document.getElementById('modal-business-select');
    if (busSelect) {
      // Si hay turno activo, forzar el valor antes de cargar categorías
      if (state.activeShiftBusinessId) {
        busSelect.value = state.activeShiftBusinessId;
      }
      if (busSelect.value) {
        window.updateModalCategories(busSelect.value, type);
      }
    }
  }, 50);
};

window.saveBaratilloSale = async (e) => {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector('button[type="submit"]');
  const originalHtml = btn.innerHTML;
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> PROCESANDO...';
    
    const form = new FormData(e.target);
    const desc = form.get('description');
    const amount = window.getCleanNumber(form.get('amount'));
    const pm = form.get('payment_method');
    const bizId = state.activeShiftBusinessId || state.currentBusinessId;
    
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("Sesión inválida.");

    // Encontrar categoría de ingreso por ventas
    const cat = state.categories.find(c => c.name === 'Venta' && c.type === 'income');
    
    // 1. Guardar la venta matriz (Total y nota especial para ser interpretada en los reportes y PDF)
    const { data: sale, error: saleErr } = await supabase.from('sales').insert({
      user_id: state.user.id,
      total: amount,
      payment_method: pm,
      note: 'Venta informal: ' + desc
    }).select().single();
    if (saleErr) throw saleErr;
    
    // 2. Guardar el movimiento financiero (Caja)
    const { error: trxErr } = await supabase.from('transactions').insert({
      amount: amount,
      type: 'income',
      description: desc,
      note: sale.id.slice(0, 5), // Link to the sale
      category_id: cat ? cat.id : null,
      business_id: bizId,
      user_id: state.user.id,
      payment_method: pm
    });
    if (trxErr) throw trxErr;
    
    window.showToast('✅ Venta registrada exitosamente', 'success');
    state.activeModal = null;
    await window.fetchData();
  } catch (err) {
    console.error(err);
    window.showToast('❌ Error: ' + err.message, 'danger');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    render();
  }
};

window.saveTransaction = async (e, type) => {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector('button[type="submit"]') || e.target.querySelector('button');
  const originalHtml = btn.innerHTML;
  
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> GUARDANDO...';
    
    const form = new FormData(e.target);
    const amount = window.getCleanNumber(form.get('amount'));
    let note = form.get('note');

    // 1. Validar Usuario y Sesión
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || state.user.id !== session.user.id) {
      throw new Error("âš ï¸ Error de Autenticación: Tu sesión ha expirado o no es válida.");
    }

    // 2. Determinar Negocio (Sincronizado con el Dashboard)
    const busId = state.currentBusinessId;
    const fueraDeTurno = !state.activeShiftBusinessId;

    if (!busId || busId === 'all') {
      throw new Error("âš ï¸ Error: No se puede determinar el negocio actual. Por favor, asegíºrate de tener un turno activo o una sede asignada.");
    }

    // Limpiar puntos de miles si el usuario los pone manualmente
    const cleanAmount = typeof amount === 'string' ? amount.replace(/\./g, '').replace(',', '.') : amount;
    const parsedAmount = parseFloat(cleanAmount);
    
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new Error("âš ï¸ Error: El monto debe ser un níºmero mayor a 0.");
    }

    // 4. Validar Categoría
    const catId = form.get('category');
    const isValidCategory = state.categories.some(c => c.id === catId);
    if (!catId || !isValidCategory) {
      throw new Error("âš ï¸ Error: Debes seleccionar una categoría válida.");
    }

    if (note) note = note.trim();
    if (note === '') note = null;

    const payload = {
      amount: parsedAmount, 
      type, 
      business_id: busId, 
      category_id: catId, 
      user_id: state.user.id,
      date: new Date().toISOString(),
      note: note
    };

    // Solo agregar fuera_de_turno si la columna existe en la DB real para evitar errores 400
    if (state.realDbSchema.includes('fuera_de_turno')) {
      payload.fuera_de_turno = fueraDeTurno;
    }

    // Validación dinámica vs Base de Datos real
    const payloadKeys = Object.keys(payload);
    const validSchema = state.realDbSchema.length > 0 ? state.realDbSchema : ['amount', 'type', 'business_id', 'category_id', 'user_id', 'date', 'note'];
    
    for (const key of payloadKeys) {
      if (!validSchema.includes(key)) {
        throw new Error(`Error de desincronización: El campo '${key}' no existe en la base de datos.`);
      }
    }

    console.log("Preparando inserción en DB:", {
      user_id: state.user.id,
      business_id: busId,
      amount: parseFloat(amount),
      category: catId,
      created_at: payload.date,
      fuera_de_turno: fueraDeTurno
    });

    try {
      const { error } = await supabase.from('transactions').insert(payload);
      if (error) throw error;
      
      state.activeModal = null;
      const msg = type === 'income' ? 'Venta registrada correctamente' : 'Gasto registrado correctamente';
      window.showToast(`✅ ${msg}`, "success");
      await fetchData();
    } catch (dbErr) {
      console.error(dbErr);
      window.showToast("Error al guardar: " + dbErr.message, "danger");
    }
  } catch (err) { 
    console.error(err);
    window.showToast("Error: " + err.message, "danger");
    window.logSystemError('Transaction Error', err.message, 'saveTransaction');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
};

window.showToast = (message, type = 'info') => {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.style.borderLeft = `5px solid ${type === 'danger' ? '#ef4444' : (type === 'success' ? '#10b981' : '#3b82f6')}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 3000);
  }, 3000);
};

window.saveShift = async (e) => {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector('button[type="submit"]') || e.target.querySelector('button');
  const originalHtml = btn.innerHTML;
  
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> GUARDANDO...';
    
    const form = new FormData(e.target);
    const busId = form.get('business');
    const bus = state.businesses.find(b => b.id === busId);
    
    if (bus && bus.type === 'arriendo') {
      const errorMsg = "Este negocio no requiere COLABORADORs (Sector Arriendos)";
      window.logSecurityEvent("Intento de turno en arriendo bloqueado", { business_id: busId, business_name: bus.name });
      throw new Error(errorMsg);
    }

    const payload = {
      user_id: form.get('user'),
      business_id: busId,
      start_time: new Date(form.get('start')).toISOString(),
      end_time: new Date(form.get('end')).toISOString()
    };

    if (state.editingShift) {
      const { error } = await supabase.from('shifts').update(payload).eq('id', state.editingShift.id);
      if (error) throw error;
      window.showToast("✅ Turno actualizado correctamente.", "success");
    } else {
      const { error } = await supabase.from('shifts').insert(payload);
      if (error) throw error;
      window.showToast("✅ Turno asignado correctamente.", "success");
    }
    
    state.activeModal = null;
    state.editingShift = null;
    await fetchData();
  } catch (err) {
    console.error(err);
    window.showToast("Error: " + err.message, "danger");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
};

window.deleteShift = async (id) => {
  if (!confirm("¿Estás seguro de eliminar este turno?")) return;
  try {
    const { error } = await supabase.from('shifts').delete().eq('id', id);
    if (error) throw error;
    window.showToast("✅ Turno eliminado correctamente.", "success");
    await fetchData();
  } catch (err) {
    console.error(err);
    window.showToast("Error al eliminar: " + err.message, "danger");
  }
};

window.deleteEmployee = async (id, name) => {
  if (!confirm(`¿Estás SEGURO de eliminar al colaborador ${name}?\n\nEsto borrará su perfil.`)) return;
  
  const deepDelete = confirm(`¿Deseas realizar una ELIMINACIÓN PROFUNDA?\n\nSi aceptas, se borrarán todos sus turnos, ventas y registros (ideal para usuarios de PRUEBA).\n\nSi es un empleado REAL que renunció, dale CANCELAR para no dañar tu contabilidad histórica.`);

  try {
    state.loading = true;
    render();
    
    if (deepDelete) {
      window.showToast("Borrando dependencias (turnos, ventas)...", "warning");
      await supabase.from('shifts').delete().eq('user_id', id);
      await supabase.from('sales').delete().eq('user_id', id);
      await supabase.from('transactions').delete().eq('user_id', id);
      await supabase.from('cash_closures').delete().eq('user_id', id);
      await supabase.from('system_logs').delete().eq('user_id', id);
    }

    const { error } = await supabase.from('users').delete().eq('id', id);
    if (error) {
      if (error.code === '23503') {
         throw new Error("El usuario tiene datos amarrados (ventas, turnos) y elegiste no hacer eliminación profunda. No se puede borrar para proteger tu contabilidad.");
      }
      throw error;
    }
    
    window.showToast(`✅ Colaborador ${name} eliminado con éxito.`, "success");
    await window.fetchData();
  } catch (err) {
    console.error(err);
    window.showToast("Error: " + err.message, "danger");
  } finally {
    state.loading = false;
    render();
  }
};

window.handleLogin = async (e) => {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector('button');
  const originalHtml = btn.innerHTML;
  
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> ENTRANDO...';
    
    const email = e.target.querySelector('input[type="email"]').value;
    const password = document.getElementById('login-pass').value;
    
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { 
      state.authError = error.message; 
      state.loading = false; 
      window.logSystemError('Auth Error', error.message, 'Login');
      if (window.render) window.render(); else render();
    }
    else { 
      state.authError = null; // Limpiar cualquier error previo
      state.view = 'loading'; 
      state.loading = true;
      if (window.render) window.render(); else render();
      
      // Ejecutar la carga de datos de manera asíncrona para que entre de inmediato
      try {
        await fetchData(); 
      } catch (fetchErr) {
        console.error("Error al cargar datos después del login:", fetchErr);
        window.showToast("Error al cargar datos iniciales, intenta recargar", "warning");
      }
    }
  } catch (err) {
    console.error(err);
    const stackInfo = (err.stack || err.message).split('\n').slice(0, 3).map(l => l.trim()).join(' | ');
    window.showToast("Error de conexión: " + stackInfo, "danger");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
};

window.handleLogout = async () => {
  state.loading = true; render();
  byodService.stopTracking();
  // Cerrar canal Realtime del mapa en tiempo real al cerrar sesión
  if (window.byodRealtimeChannel) {
    supabase.removeChannel(window.byodRealtimeChannel);
    window.byodRealtimeChannel = null;
  }
  await supabase.auth.signOut();
  location.reload();
};

window.togglePasswordVisibility = (inputId, btnId) => {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;

  if (input.type === 'password') {
    input.type = 'text';
    btn.innerHTML = '<i data-lucide="eye-off" style="width:20px;"></i>';
  } else {
    input.type = 'password';
    btn.innerHTML = '<i data-lucide="eye" style="width:20px;"></i>';
  }
  if (window.lucide) window.lucide.createIcons();
};

window.handleRegister = async (e) => {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector('button');
  const originalHtml = btn.innerHTML;

  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> REGISTRANDO...';

    const name = e.target.querySelector('input[placeholder="Nombre"]').value;
    const email = e.target.querySelector('input[placeholder="Email"]').value;
    const password = document.getElementById('reg-pass').value;
    const busId = e.target.querySelector('select').value;
    
    if (!busId) {
      state.authError = "Debes seleccionar un negocio para registrarte.";
      state.loading = false;
      render();
      return;
    }
    
    const { error } = await supabase.auth.signUp({ 
      email, password, options: { data: { name, business_id: busId } }
    });
    
    if (error) { 
      state.authError = error.message; 
      state.loading = false; 
      window.logSystemError('Auth Error', error.message, 'Register');
      render(); 
    } else { 
      // Auto-login
      const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
      if (loginError) {
        state.authError = loginError.message;
        state.view = 'auth';
        state.loading = false;
        window.logSystemError('Auth Error', loginError.message, 'AutoLogin');
        render();
      } else {
        state.view = 'loading';
        await fetchData();
      }
    }
  } catch (err) {
    console.error(err);
    window.showToast("Error en el registro", "danger");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
};

const formatCurrency = (val) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(val);

window.getCleanNumber = (val) => {
  if (!val) return 0;
  return parseFloat(val.toString().replace(/\./g, '')) || 0;
};

const formatCurrencyInput = (val) => {
  const clean = val.replace(/\D/g, '');
  if (!clean) return '';
  return parseInt(clean, 10).toLocaleString('es-CO');
};

document.addEventListener('input', (e) => {
  if (e.target && e.target.classList.contains('currency-input')) {
    const originalPosition = e.target.selectionStart;
    const originalLength = e.target.value.length;
    
    e.target.value = formatCurrencyInput(e.target.value);
    
    const newLength = e.target.value.length;
    let newPosition = originalPosition + (newLength - originalLength);
    if (newPosition < 0) newPosition = 0;
    
    try { e.target.setSelectionRange(newPosition, newPosition); } catch(e){}
  }
});
window.filterByBusiness = (id) => {
  state.currentBusinessId = id;
  render();
};

window.showShiftReport = (timeframe = 'daily') => {
  const now = new Date();
  state.shiftReportTimeframe = timeframe;

  // A. Establecer hora base por defecto (hoy a la medianoche)
  let startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  
  // B. Sincronización Inteligente de Turno Nocturno:
  // Si es reporte diario, verificamos si hay un turno activo para este usuario hoy y ajustamos 
  // el filtro de fecha a la HORA REAL DE INICIO del turno (para no perder transacciones nocturnas previas a medianoche!).
  if (timeframe === 'daily') {
    const activeUserShift = (state.shifts || []).find(s => {
      const targetUserId = state.user?.role === 'admin' ? s.user_id : state.user?.id;
      const isUserMatch = s.user_id === targetUserId;
      const sStart = new Date(s.start_time);
      const sEnd = new Date(s.end_time);
      // Turnos activos o completados el día de hoy
      return isUserMatch && now >= new Date(sStart.getTime() - 60 * 60 * 1000) && now <= new Date(sEnd.getTime() + 60 * 60 * 1000);
    });
    if (activeUserShift) {
      startDate = new Date(activeUserShift.start_time);
    }
  } else if (timeframe === 'weekly') {
    startDate = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
  } else if (timeframe === 'monthly') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  }

  // C. Visibilidad Inteligente por Rol:
  // Los colaboradores ven solo SUS transacciones. Los administradores auditan TODO el negocio activo.
  const myTrx = state.transactions.filter(t => {
    const isRoleMatch = (state.user?.role === 'admin') ? true : (t.user_id === state.user?.id);
    const isDateMatch = new Date(t.date) >= startDate;
    return isRoleMatch && isDateMatch;
  });

  const totalSales = myTrx.filter(t => t.type === 'income').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const totalExpenses = myTrx.filter(t => t.type === 'expense').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const balance = totalSales - totalExpenses;
  const expensesList = myTrx.filter(t => t.type === 'expense');

  state.shiftReportData = { totalSales, totalExpenses, balance, count: myTrx.length, expensesList };
  state.activeModal = 'shift_report';
  render();
};


const render = () => {
  const app = document.getElementById('app');
  if (state.loading && state.view === 'loading') { app.innerHTML = '<div style="padding:100px;text-align:center;">Cargando...</div>'; return; }
  
  if (state.view === 'connection_error') {
    app.innerHTML = `
      <div class="container" style="padding: 40px; text-align: center; max-width: 500px; margin: 80px auto;">
        <div class="card" style="border: 1px solid rgba(239, 68, 68, 0.2); box-shadow: 0 10px 25px rgba(239, 68, 68, 0.05); padding: 30px; border-radius: 16px;">
          <div style="background: rgba(239, 68, 68, 0.1); width: 64px; height: 64px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px auto; color: var(--danger);">
            <i data-lucide="wifi-off" style="width: 32px; height: 32px;"></i>
          </div>
          <h2 style="font-size: 20px; font-weight: 800; color: #1e293b; margin-bottom: 12px;">Fallo de Conexión a la Base de Datos</h2>
          <p style="color: #64748b; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
            No se pudo establecer conexión con el servidor. Esto suele ocurrir cuando la base de datos de <b>Supabase se pausa automáticamente por inactividad</b> (después de 7 días sin uso).
          </p>
          <div style="background: #f8fafc; border-radius: 12px; padding: 15px; text-align: left; font-size: 13px; color: #475569; margin-bottom: 24px; border: 1px solid #e2e8f0; line-height: 1.5;">
            💡 <b>¿Cómo solucionarlo?</b><br>
            1. Ve a <a href="https://supabase.com/dashboard" target="_blank" style="color: var(--primary); font-weight: 700; text-decoration: underline;">Supabase Dashboard</a> e inicia sesión.<br>
            2. Selecciona tu proyecto <b>J&M</b>.<br>
            3. Haz clic en el botón <b>"Restore Project"</b> (Restaurar) y espera un par de minutos.<br>
            4. Una vez restaurado, toca el botón de abajo para reintentar.
          </div>
          <button onclick="window.fetchData()" class="btn-primary" style="width: 100%; padding: 12px; border-radius: 12px; font-weight: 700;">🔄 Reintentar Conexión</button>
        </div>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  const getSystemSalesForClosure = (bizId, dateStr, closureObj = null) => {
    let startTime = null;
    let endTime = null;
    
    if (closureObj) {
      const isBaratillo = state.businesses?.find(b => b.id === bizId)?.name?.toLowerCase().includes('baratillo');
      if (isBaratillo) {
        // Encontrar todos los cierres de este negocio en este día, ordenados cronológicamente
        const dayClosures = state.cashClosures
          .filter(c => c.business_id === bizId && c.date === dateStr)
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
          
        const closureIndex = dayClosures.findIndex(c => c.id === closureObj.id);
        
        if (closureIndex === 0) {
          // Es el primer cierre del día (Mañana)
          endTime = new Date(closureObj.created_at).getTime();
        } else if (closureIndex > 0) {
          // Es un cierre posterior (Tarde/Noche)
          startTime = new Date(dayClosures[closureIndex - 1].created_at).getTime();
          endTime = new Date(closureObj.created_at).getTime();
        }
      }
    }

    const dayTrx = state.transactions.filter(t => {
      if (t.type !== 'income') return false;
      if (t.business_id !== bizId) return false;
      const tDate = new Date(t.date).toLocaleDateString('en-CA');
      if (tDate !== dateStr) return false;
      
      if (startTime !== null || endTime !== null) {
        const trxTime = new Date(t.created_at).getTime();
        if (startTime !== null && trxTime <= startTime) return false;
        if (endTime !== null && trxTime > endTime) return false;
      }
      return true;
    });

    return {
      efectivo: dayTrx.filter(t => t.payment_method === 'Efectivo').reduce((sum, t) => sum + Number(t.amount), 0),
      addi: dayTrx.filter(t => t.payment_method === 'Addi').reduce((sum, t) => sum + Number(t.amount), 0),
      sistecredito: dayTrx.filter(t => t.payment_method === 'Sistecredito' || t.payment_method === 'Sistecrédito').reduce((sum, t) => sum + Number(t.amount), 0),
      daviplata: dayTrx.filter(t => t.payment_method === 'Daviplata').reduce((sum, t) => sum + Number(t.amount), 0),
      nequi: dayTrx.filter(t => t.payment_method === 'Transferencia' || t.payment_method === 'Nequi').reduce((sum, t) => sum + Number(t.amount), 0),
      bonos: dayTrx.filter(t => t.payment_method === 'Bonos Coopchipaque').reduce((sum, t) => sum + Number(t.amount), 0)
    };
  };

  let html = '';
  if (state.view === 'auth') {
    html = `
      <div class="container auth-view">
        <div class="logo-container" style="justify-content:center; margin-bottom:30px;">
          <div class="logo-icon" style="width:80px; height:80px;">
            <img src="logo_v3.png" alt="Logo">
          </div>
          <div class="header-title">
            <h1 style="font-size:28px;">J&M</h1>
          </div>
        </div>
        <form onsubmit="window.handleLogin(event)" class="card">
          <input type="email" class="form-input" placeholder="Email" autocomplete="username" required style="margin-bottom:12px;">
          
          <div class="password-wrapper" style="margin-bottom:12px;">
            <input type="password" id="login-pass" class="form-input" placeholder="Clave" autocomplete="current-password" required>
            <button type="button" id="login-pass-toggle" class="password-toggle" onclick="window.togglePasswordVisibility('login-pass', 'login-pass-toggle')">
              <i data-lucide="eye" style="width:20px;"></i>
            </button>
          </div>

          <button class="btn-primary" style="width:100%; margin-top:10px;" ${state.loading ? 'disabled' : ''}>
            ${state.loading ? 'ENTRANDO...' : 'ENTRAR'}
          </button>
        </form>
        <p style="text-align:center;margin-top:20px;">¿Nuevo? <a href="#" onclick="state.view='register';window.render()">Regístrate</a></p>
        ${state.authError?`<p class="error-text" style="color:var(--danger); text-align:center; margin-top:10px; font-weight:bold;">${state.authError}</p>`:''}
      </div>
    `;
  }

  else if (state.view === 'register') {
    html = `
      <div class="container auth-view">
        <h1>Nuevo COLABORADOR</h1>
        <form onsubmit="window.handleRegister(event)" class="card">
          <input type="text" class="form-input" placeholder="Nombre" autocomplete="name" required style="margin-bottom:12px;">
          <input type="email" class="form-input" placeholder="Email" autocomplete="email" required style="margin-bottom:12px;">
          
          <div class="password-wrapper" style="margin-bottom:12px;">
            <input type="password" id="reg-pass" class="form-input" placeholder="Clave" autocomplete="new-password" required>
            <button type="button" id="reg-pass-toggle" class="password-toggle" onclick="window.togglePasswordVisibility('reg-pass', 'reg-pass-toggle')">
              <i data-lucide="eye" style="width:20px;"></i>
            </button>
          </div>

          <select class="form-input" style="margin-bottom:12px;" required>
            <option value="" disabled selected>Selecciona tu Negocio...</option>
            ${state.businesses
              .filter(b => !TEST_BUSINESSES.includes(b.name) && !RENTAL_BUSINESSES.includes(b.name))
              .map(b=>`<option value="${b.id}">${b.name}</option>`).join('')}
          </select>
          <button class="btn-primary" style="width:100%;" ${state.loading ? 'disabled' : ''}>
            ${state.loading ? 'REGISTRANDO...' : 'REGISTRAR'}
          </button>
        </form>
        <p style="text-align:center;margin-top:20px;"><a href="#" onclick="state.view='auth';window.render()">Volver</a></p>
      </div>
    `;
  }

  else if (state.view === 'pos') {
    const activeBiz = state.businesses.find(b => b.id === (state.activeShiftBusinessId || state.currentBusinessId));
    const activeBizId = state.activeShiftBusinessId || state.currentBusinessId;
    const filteredProducts = state.products.filter(p => 
      (activeBizId === 'all' || p.business_id === activeBizId) &&
      p.name.toLowerCase().includes(state.posSearch.toLowerCase())
    );
    const cartTotal = state.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    const isBaratillo = false; // El Baratillo ahora usa la funcionalidad de inventario/POS completa
    const isJM = activeBiz && (activeBiz.name.toLowerCase().includes('j&m') || activeBiz.name.toLowerCase().includes('j & m'));

    html = `
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon"><img src="logo_v3.png" alt="Logo"></div>
          <div class="header-title">
            <p class="role-tag">POS (${state.products.length} productos)</p>
            <h1>Caja Registradora</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="window.fetchData()" class="btn-secondary" style="padding:8px 15px; font-size:12px; margin-right:10px;">RECARGAR</button>
          <div onclick="state.view='app';render()" class="icon-btn pill">Volver</div>
        </div>
      </header>

      <div class="container pos-container" style="max-width:1400px; height: calc(100vh - 120px); display: flex; flex-direction: row; gap: 20px;">
        <style>
          .pos-container { display: flex !important; flex-direction: row; }
          .pos-main { flex: 1; display: flex; flex-direction: column; gap: 20px; overflow: hidden; }
          .pos-sidebar { width: 350px; display: flex; flex-direction: column; height: 100%; border: 1px solid #e2e8f0; background: white; border-radius: 20px; overflow: hidden; }
          
          @media (max-width: 900px) {
            .pos-container { flex-direction: column !important; height: auto !important; overflow: visible !important; }
            .pos-sidebar { width: 100%; height: auto; min-height: 400px; }
            .pos-main { overflow: visible; }
          }
        </style>
        
        <!-- PRODUCTOS -->
        ${isBaratillo ? `
          <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; background:white; border-radius:20px; box-shadow:0 4px 6px rgba(0,0,0,0.05); padding:40px;">
            <div style="width:100px; height:100px; background:#f1f5f9; border-radius:50%; display:flex; align-items:center; justify-content:center; margin-bottom:20px;">
              <i data-lucide="shopping-bag" style="width:50px; height:50px; color:var(--primary);"></i>
            </div>
            <h2 style="font-size:28px; margin-bottom:10px; color:var(--text);">Punto de Venta El Baratillo</h2>
            <p style="color:var(--text-muted); margin-bottom:40px; text-align:center; max-width:400px;">Registra las ventas directas con una breve descripción y el precio final.</p>
            
            ${(!state.activeShiftBusinessId && state.user?.role !== 'admin') ? `
              <div style="background:#fee2e2; color:#991b1b; padding:15px 25px; border-radius:12px; font-weight:700; margin-bottom:20px; font-size:16px;">
                ⚠️ TURNO INACTIVO: Registra tu llegada para habilitar ventas.
              </div>
            ` : `
              <button onclick="state.activeModal='baratillo_sale';render()" class="btn-primary" style="padding:25px 50px; font-size:20px; border-radius:16px; box-shadow:0 10px 25px rgba(59,130,246,0.3); transition:all 0.2s;">
                + REGISTRAR VENTA
              </button>
            `}
          </div>
        ` : `
        <div class="pos-main">
          <div style="display:flex; flex-direction:column; gap:10px; width:100%; margin-bottom:10px;">
            <div style="position:relative; width:100%;">
              <i data-lucide="search" style="position:absolute; left:15px; top:15px; color:#94a3b8; width:20px;"></i>
              <input type="text" id="pos-search-input" class="form-input" placeholder="Buscar producto..." 
                value="${state.posSearch}" 
                oninput="window.handlePosSearch(this.value)" 
                style="width:100%; margin:0; height:50px; font-size:16px; padding-left:45px; border-radius:12px;">
            </div>
            ${isJM ? `
            <div style="display:flex; gap:8px; align-items:center; overflow-x:auto; padding-bottom:5px; width:100%; -webkit-overflow-scrolling:touch;">
              <button onclick="state.posGenderFilter='all';render()" style="padding:10px 18px; border-radius:12px; border:1px solid ${state.posGenderFilter==='all'?'#6366f1':'#e2e8f0'}; background:${state.posGenderFilter==='all'?'#6366f1':'white'}; color:${state.posGenderFilter==='all'?'white':'#64748b'}; font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap; flex-shrink:0;">🏷️ Todos</button>
              <button onclick="state.posGenderFilter='hombre';render()" style="padding:10px 18px; border-radius:12px; border:1px solid ${state.posGenderFilter==='hombre'?'#3b82f6':'#e2e8f0'}; background:${state.posGenderFilter==='hombre'?'#3b82f6':'white'}; color:${state.posGenderFilter==='hombre'?'white':'#64748b'}; font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap; flex-shrink:0;">👨 Hombre</button>
              <button onclick="state.posGenderFilter='mujer';render()" style="padding:10px 18px; border-radius:12px; border:1px solid ${state.posGenderFilter==='mujer'?'#ec4899':'#e2e8f0'}; background:${state.posGenderFilter==='mujer'?'#ec4899':'white'}; color:${state.posGenderFilter==='mujer'?'white':'#64748b'}; font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap; flex-shrink:0;">👩 Mujer</button>
              <button onclick="state.posGenderFilter='unisex';render()" style="padding:10px 18px; border-radius:12px; border:1px solid ${state.posGenderFilter==='unisex'?'#8b5cf6':'#e2e8f0'}; background:${state.posGenderFilter==='unisex'?'#8b5cf6':'white'}; color:${state.posGenderFilter==='unisex'?'white':'#64748b'}; font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap; flex-shrink:0;">⚧️ Unisex</button>
            </div>
            ` : ''}
            <div style="display:flex; gap:10px;">
              ${(state.user?.role === 'admin' || state.user?.can_manage_inventory) ? `
                <button onclick="state.activeModal='new_product';render()" class="btn-primary" style="width:auto; padding:0 20px; background:var(--primary);">+ NUEVO</button>
                <button onclick="state.activeModal='add_inventory';render()" class="btn-primary" style="width:auto; padding:0 20px; background:#475569;">+ INVENTARIO</button>
              ` : ''}
              <button onclick="state.activeModal='pending_product';render()" class="btn-primary" style="width:auto; padding:0 20px; background:var(--secondary);">+ NO REGISTRADO</button>
            </div>
          </div>

          <div id="pos-product-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); grid-auto-rows: minmax(150px, auto); gap:15px; flex:1; min-height:0; overflow-y:auto; padding-bottom:50px; padding-right:5px;">
            ${window.renderPosProducts()}
          </div>
        </div>

        <!-- CARRITO -->
        <div class="pos-sidebar card">
          <div style="padding:20px; border-bottom:1px solid #e2e8f0; background:#f8fafc;">
            <h3 style="font-size:16px; font-weight:700;">Carrito</h3>
          </div>
          
          <div style="flex:1; overflow-y:auto; padding:15px; display:flex; flex-direction:column; gap:10px;">
            ${state.cart.length > 0 ? state.cart.map(item => `
              <div style="display:flex; justify-content:space-between; align-items:center; background:#f1f5f9; padding:10px; border-radius:10px;">
                <div style="flex:1;">
                  <p style="font-weight:700; font-size:13px;">${item.name}</p>
                  <p style="font-size:11px; color:var(--text-muted);">${formatCurrency(item.price)} c/u</p>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                  <button onclick="window.updateCartQuantity('${item.product_id}', -1)" style="width:24px; height:24px; border-radius:50%; border:none; background:#cbd5e1;">-</button>
                  <span style="font-weight:700; font-size:14px; min-width:20px; text-align:center;">${item.quantity}</span>
                  <button onclick="window.updateCartQuantity('${item.product_id}', 1)" style="width:24px; height:24px; border-radius:50%; border:none; background:#cbd5e1;">+</button>
                  <button onclick="window.removeFromCart('${item.product_id}')" style="margin-left:10px; color:var(--danger); background:none; border:none; font-size:16px;">✕</button>
                </div>
              </div>
            `).join('') : '<div style="flex:1; display:flex; align-items:center; justify-content:center; color:var(--text-muted);">Carrito vacío</div>'}
          </div>

          <div style="padding:20px; background:#f8fafc; border-top:1px solid #e2e8f0;">
            <div style="margin-bottom:15px;">
              <label style="font-size:11px; font-weight:700; color:var(--text-muted); display:block; margin-bottom:5px; text-transform:uppercase;">Forma de Pago</label>
              <select id="pos-payment-method" class="form-input" onchange="state.posPaymentMethod = this.value" style="width:100%; height:45px; padding:10px; border-radius:12px; font-size:14px; font-weight:700; background:white; border:1px solid #cbd5e1;">
                <option value="Efectivo" ${state.posPaymentMethod === 'Efectivo' ? 'selected' : ''}>💵 Efectivo</option>
                <option value="Addi" ${state.posPaymentMethod === 'Addi' ? 'selected' : ''}>💳 Addi</option>
                <option value="Sistecredito" ${state.posPaymentMethod === 'Sistecredito' ? 'selected' : ''}>💳 Sistecredito</option>
                <option value="Bonos Coopchipaque" ${state.posPaymentMethod === 'Bonos Coopchipaque' ? 'selected' : ''}>🎟️ Bonos Coopchipaque</option>
                ${(() => {
                  const activeBus = state.businesses?.find(b => b.id === (state.activeShiftBusinessId || state.currentBusinessId));
                  return activeBus?.name?.toLowerCase().includes('baratillo')
                    ? `<option value="Daviplata" ${state.posPaymentMethod === 'Daviplata' ? 'selected' : ''}>📱 Daviplata</option>`
                    : `<option value="Transferencia" ${state.posPaymentMethod === 'Transferencia' ? 'selected' : ''}>🏦 Transferencia</option>`;
                })()}
                <option value="Llano Gas" ${state.posPaymentMethod === 'Llano Gas' ? 'selected' : ''}>🔥 Llano Gas</option>
              </select>
            </div>
            <div class="form-group" style="margin-bottom:15px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                <label style="font-size:11px; font-weight:800; color:#4f46e5; text-transform:uppercase; letter-spacing:0.5px;">🏷️ Descuento (COP)</label>
                ${state.posDiscount > 0 ? `<span onclick="window.updatePosDiscount(0)" style="font-size:10px; color:#ef4444; font-weight:700; cursor:pointer; text-decoration:underline;">Quitar</span>` : ''}
              </div>
              <input type="number" class="form-input" placeholder="0" min="0" max="${cartTotal}" style="height:40px; padding:0 12px; font-size:14px; font-weight:700; border-radius:10px; border:1.5px solid #818cf8; background:#f5f3ff;" value="${state.posDiscount || ''}" oninput="window.updatePosDiscount(this.value)">
            </div>
            ${state.posDiscount > 0 ? `
              <div style="display:flex; justify-content:space-between; margin-bottom:5px; font-size:13px; color:#64748b;">
                <span>Subtotal</span>
                <span>${formatCurrency(cartTotal)}</span>
              </div>
              <div style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:13px; color:var(--primary);">
                <span>Descuento</span>
                <span>- ${formatCurrency(state.posDiscount)}</span>
              </div>
            ` : ''}
            <div style="display:flex; justify-content:space-between; margin-bottom:15px;">
              <span style="font-weight:600;">TOTAL A PAGAR</span>
              <span style="font-size:24px; font-weight:800; color:var(--primary);">${formatCurrency(Math.max(0, cartTotal - (state.posDiscount || 0)))}</span>
            </div>
            
            ${(!state.activeShiftBusinessId && state.user?.role !== 'admin') ? `
              <div style="background:#fee2e2; color:#991b1b; padding:10px; border-radius:10px; font-size:12px; text-align:center; font-weight:700; margin-bottom:10px;">
                ⚠️ TURNO INACTIVO: Activa tu asistencia para poder vender.
              </div>
              <button disabled class="btn-primary" style="width:100%; height:60px; font-size:18px; border-radius:15px; opacity:0.5; cursor:not-allowed;">BLOQUEADO</button>
            ` : `
              <button onclick="window.finalizeSale()" class="btn-primary" style="width:100%; height:60px; font-size:18px; border-radius:15px;" ${state.cart.length === 0 || state.loading ? 'disabled' : ''}>
                ${state.loading ? 'PROCESANDO...' : 'FINALIZAR VENTA'}
              </button>
            `}
          </div>
        </div>
        `}
      </div>
    `;
  }

  else if (state.view === 'manager_dashboard') {
    const totalIncome = state.transactions.filter(t => t.type === 'income').reduce((acc, t) => acc + (parseFloat(t.amount) || 0), 0);
    const totalExpense = state.transactions.filter(t => t.type === 'expense').reduce((acc, t) => acc + (parseFloat(t.amount) || 0), 0);

    if (!state.payrollFilters) {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      state.payrollFilters = {
        employeeId: 'all',
        startDate: first.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0]
      };
    }

    html = `
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon">
            <img src="logo_v3.png" alt="Logo">
          </div>
          <div class="header-title">
            <p class="role-tag">GERENCIA</p>
            <h1>${state.currentBusinessId === 'all' ? 'Panel Global J&M' : (state.businesses.find(b => b.id === state.currentBusinessId)?.name || 'J&M')}</h1>
          </div>
        </div>
        <div class="header-actions">
          <div style="display:flex; gap:8px; padding-right:10px; border-right:1px solid #e2e8f0; margin-right:5px;">
            <div onclick="state.view='shifts_admin';window.render()" class="icon-btn" title="Gestión de Turnos y Personal"><i data-lucide="clock"></i></div>
            <div onclick="window.fetchByodDashboard()" class="icon-btn" title="Auditoría Satelital BYOD" style="background:#f0fdf4; color:#16a34a; border-color:#bbf7d0;"><i data-lucide="shield"></i></div>
            <div onclick="window.fetchData()" class="icon-btn" title="Recargar Datos"><i data-lucide="refresh-cw"></i></div>
          </div>
          <div onclick="state.view='app';window.render()" class="icon-btn pill" style="background:var(--primary); color:white; border:none;">Volver</div>
          <div onclick="window.handleLogout()" class="icon-btn pill logout"><i data-lucide="log-out"></i> Salir</div>
        </div>
      </header>

      <div class="container" style="max-width:1200px;">
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:20px; margin-bottom:30px;">
          <div class="card" style="text-align:center; border-left:5px solid var(--success); padding:20px;">
            <p style="font-size:11px; color:var(--text-muted); font-weight:700; text-transform:uppercase;">Total Ingresos</p>
            <p style="font-size:22px; font-weight:800; color:var(--success); margin-top:8px;">${formatCurrency(totalIncome)}</p>
          </div>
          <div class="card" style="text-align:center; border-left:5px solid var(--danger); padding:20px;">
            <p style="font-size:11px; color:var(--text-muted); font-weight:700; text-transform:uppercase;">Total Gastos</p>
            <p style="font-size:22px; font-weight:800; color:var(--danger); margin-top:8px;">${formatCurrency(totalExpense)}</p>
          </div>
          <div class="card" style="text-align:center; border-left:5px solid var(--primary); padding:20px;">
            <p style="font-size:11px; color:var(--text-muted); font-weight:700; text-transform:uppercase;">Balance Neto</p>
            <p style="font-size:22px; font-weight:800; color:var(--primary); margin-top:8px;">${formatCurrency(totalIncome - totalExpense)}</p>
          </div>
          <div class="card" style="text-align:center; border-left:5px solid #8b5cf6; padding:20px;">
            <p style="font-size:11px; color:var(--text-muted); font-weight:700; text-transform:uppercase; display:flex; justify-content:center; align-items:center; gap:4px;"><i data-lucide="award" style="width:12px;"></i> PUNTUALIDAD</p>
            <p style="font-size:22px; font-weight:800; color:#8b5cf6; margin-top:8px;">94.2%</p>
          </div>
        </div>
        
        <div style="display:grid; grid-template-columns: 2fr 1fr; gap:25px; margin-bottom:30px;">
          <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
              <h3 style="font-size:16px;">Rendimiento por Negocio</h3>
              <div style="display:flex; gap:8px; align-items:center;">

                <button onclick="state.activeModal='new_business';window.render()" class="btn-primary" style="padding:8px 12px; font-size:11px; height:40px; background:var(--primary); border:none; font-weight:700; display:flex; align-items:center; gap:4px;" title="Crear un nuevo negocio o sucursal"><i data-lucide="plus" style="width:14px;"></i> NUEVA SEDE</button>
                <select onchange="window.filterByBusiness(this.value)" class="form-input" style="width:auto; height:40px; font-size:12px;">
                  <option value="all" ${state.currentBusinessId === 'all' ? 'selected' : ''}>Todos los negocios</option>
                  ${state.businesses.map(b => `<option value="${b.id}" ${state.currentBusinessId === b.id ? 'selected' : ''}>${b.name}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="chart-container">
              <canvas id="managerChart"></canvas>
            </div>
          </div>
          
          <div class="card">
             <h3 style="font-size:16px; margin-bottom:20px;">Distribución por Sector</h3>
             <div style="display:flex; flex-direction:column; gap:15px;">
                ${['operativo', 'arriendo'].map(type => {
                  const sectorTrx = state.transactions.filter(t => {
                    const bus = state.businesses.find(b => b.id === t.business_id);
                    return bus && bus.type === type;
                  });
                  const total = sectorTrx.reduce((acc, t) => acc + (t.type === 'income' ? parseFloat(t.amount) : -parseFloat(t.amount)), 0);
                  return `
                    <div style="padding:15px; background:#f8fafc; border-radius:15px; border:1px solid #f1f5f9;">
                      <p style="font-size:10px; font-weight:800; color:var(--text-muted); text-transform:uppercase;">Sector ${type}</p>
                      <p style="font-size:18px; font-weight:800; margin-top:5px; color:${total >= 0 ? 'var(--success)' : 'var(--danger)'}">${formatCurrency(total)}</p>
                    </div>
                  `;
                }).join('')}
             </div>
          </div>
        </div>

        <!-- 📊 CENTRO DE REPORTES Y AUDITORÍA PREMIUM (PDF) -->
        <div class="card" style="margin-bottom:30px; padding:25px; background:linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color:white; border:none; border-radius:20px; box-shadow: 0 10px 30px rgba(15,23,42,0.15); position:relative; overflow:hidden;">
          <div style="position:absolute; top:-10px; right:-10px; font-size:90px; opacity:0.03; font-weight:800; pointer-events:none; color:white;"><i data-lucide="file-text"></i></div>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:15px; position:relative; z-index:1;">
            <div>
              <h3 style="font-size:18px; font-weight:800; display:flex; align-items:center; gap:8px; color:#38bdf8;"><i data-lucide="file-text" style="width:20px;"></i> Auditoría y Reportes PDF de Ventas</h3>
              <p style="font-size:11px; color:#94a3b8; margin-top:2px;">Genera planillas oficiales detallando productos por local, vendedor y fechas.</p>
            </div>
            <button onclick="window.setTodayReportingRange()" class="btn-primary" style="background:#0369a1; font-size:12px; padding:8px 15px; border:none; border-radius:10px; display:flex; align-items:center; gap:5px; font-weight:700; transition:all 0.2s;"><i data-lucide="calendar" style="width:14px;"></i> REPORTAR HOY</button>
          </div>
          
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:15px; align-items:end; position:relative; z-index:1;">
            <div>
              <label style="font-size:11px; font-weight:700; color:#94a3b8; display:block; margin-bottom:6px; text-transform:uppercase;">Seleccionar Local / Sede</label>
              <select id="rpt-biz-select" style="width:100%; background:#1e293b; border:1.5px solid #334155; color:white; padding:10px 12px; border-radius:12px; font-size:12px; outline:none; transition:border 0.2s;">
                <option value="all">--- Todos los Locales (Consolidado) ---</option>
                ${state.businesses.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px; font-weight:700; color:#94a3b8; display:block; margin-bottom:6px; text-transform:uppercase;">Fecha Inicial</label>
              <input type="date" id="rpt-start" value="${new Date().toISOString().split('T')[0]}" style="width:100%; background:#1e293b; border:1.5px solid #334155; color:white; padding:10px 12px; border-radius:12px; font-size:12px; outline:none;" />
            </div>
            <div>
              <label style="font-size:11px; font-weight:700; color:#94a3b8; display:block; margin-bottom:6px; text-transform:uppercase;">Fecha Final</label>
              <input type="date" id="rpt-end" value="${new Date().toISOString().split('T')[0]}" style="width:100%; background:#1e293b; border:1.5px solid #334155; color:white; padding:10px 12px; border-radius:12px; font-size:12px; outline:none;" />
            </div>
            <div>
              <button onclick="window.generateAdminSalesReportPDF()" class="btn-primary" style="width:100%; background:#0284c7; padding:12px; border-radius:12px; font-size:13px; font-weight:800; display:flex; align-items:center; justify-content:center; gap:8px; border:none; box-shadow: 0 4px 12px rgba(2,132,199,0.3); transition:transform 0.2s;"><i data-lucide="download-cloud" style="width:16px;"></i> DESCARGAR PDF</button>
            </div>
          </div>
          <!-- 📨 REPORTES AUTOMÁTICOS Y MANUALES A TELEGRAM -->
          <div style="margin-top:20px; padding-top:20px; border-top: 1px dashed rgba(255,255,255,0.15); display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:15px;">
            <div>
              <h4 style="font-size:13px; font-weight:700; color:#38bdf8; display:flex; align-items:center; gap:6px; margin:0;"><i data-lucide="send" style="width:16px;"></i> Reportes de Ventas a Telegram</h4>
              <p style="font-size:10px; color:#94a3b8; margin:2px 0 0 0;">Envía planillas PDF del periodo actual consolidado directamente al canal de Telegram configurado.</p>
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
              <button onclick="window.sendTelegramSalesReport('daily')" class="btn-primary" style="background:#0284c7; padding:8px 12px; border-radius:8px; font-size:11px; font-weight:700; display:flex; align-items:center; gap:5px; border:none; transition:all 0.2s;"><i data-lucide="send" style="width:12px;"></i> DIARIO</button>
              <button onclick="window.sendTelegramSalesReport('weekly')" class="btn-primary" style="background:#0369a1; padding:8px 12px; border-radius:8px; font-size:11px; font-weight:700; display:flex; align-items:center; gap:5px; border:none; transition:all 0.2s;"><i data-lucide="send" style="width:12px;"></i> SEMANAL</button>
              <button onclick="window.sendTelegramSalesReport('monthly')" class="btn-primary" style="background:#0f766e; padding:8px 12px; border-radius:8px; font-size:11px; font-weight:700; display:flex; align-items:center; gap:5px; border:none; transition:all 0.2s;"><i data-lucide="send" style="width:12px;"></i> MENSUAL</button>
            </div>
          </div>
        </div>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:20px; margin-bottom:30px;">
          <button onclick="state.activeModal='sale';render()" class="btn-primary" style="padding:20px; background:var(--secondary); font-size:13px;">+ REGISTRAR VENTA</button>
          <button onclick="state.activeModal='expense';render()" class="btn-primary" style="padding:20px; font-size:13px;">+ REGISTRAR GASTO</button>
          <button onclick="state.view='sales_history_admin';render()" class="btn-primary" style="padding:20px; background:linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); font-size:13px; display:flex; align-items:center; justify-content:center; gap:8px;"><i data-lucide="shopping-bag" style="width:16px;"></i> AUDITAR VENTAS</button>
          <button onclick="state.view='products_admin';render()" class="btn-primary" style="padding:20px; background:#475569; font-size:13px; display:flex; align-items:center; justify-content:center; gap:8px;"><i data-lucide="package" style="width:16px;"></i> GESTIÓN PRODUCTOS</button>
          <button onclick="window.fetchSuppliers()" class="btn-primary" style="padding:20px; background:#0d9488; font-size:13px; display:flex; align-items:center; justify-content:center; gap:8px;"><i data-lucide="truck" style="width:16px;"></i> PROVEEDORES</button>
          <button onclick="state.view='shifts_admin';window.render()" class="btn-primary" style="padding:20px; background:#10b981; font-size:13px; display:flex; align-items:center; justify-content:center; gap:8px;"><i data-lucide="users" style="width:16px;"></i> GESTIÓN DE TURNOS</button>
        </div>

        </div>

        <!-- POS ANALYTICS -->
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px; margin-top:30px; margin-bottom:50px;">
          <!-- STOCK CRÍTICO -->
          <div class="card">
            <h3 style="font-size:16px; margin-bottom:15px; display:flex; align-items:center; gap:8px;"><i data-lucide="alert-triangle" style="color:var(--danger); width:18px;"></i> Stock Crítico</h3>
            <div style="display:flex; flex-direction:column; gap:10px;">
              ${state.products.filter(p => p.stock < 5).map(p => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:#fff1f2; border-radius:10px; border:1px solid #fecaca;">
                  <span style="font-weight:600; font-size:13px;">${p.name}</span>
                  <span style="background:var(--danger); color:white; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:800;">${p.stock} unid.</span>
                </div>
              `).join('') || '<p style="text-align:center; color:var(--text-muted); padding:20px;">Todo el stock está normal</p>'}
            </div>
          </div>

          <!-- TOP PRODUCTOS -->
          <div class="card">
            <h3 style="font-size:16px; margin-bottom:15px; display:flex; align-items:center; gap:8px;"><i data-lucide="trophy" style="color:#f59e0b; width:18px;"></i> Productos Más Vendidos</h3>
            <div style="display:flex; flex-direction:column; gap:10px;">
              ${(() => {
                const productSales = {};
                state.saleItems.forEach(item => {
                  const name = item.products?.name || 'Desconocido';
                  productSales[name] = (productSales[name] || 0) + Number(item.quantity);
                });
                return Object.entries(productSales)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5)
                  .map(([name, qty]) => `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:#f8fafc; border-radius:10px;">
                      <span style="font-weight:600; font-size:13px;">${name}</span>
                      <span style="font-weight:800; color:var(--primary);">${qty} vendidos</span>
                    </div>
                  `).join('') || '<p style="text-align:center; color:var(--text-muted); padding:20px;">Sin datos de ventas</p>';
              })()}
            </div>
          </div>

          <!-- VENTAS POR COLABORADOR (Leaderboard Interactivo v1.8.0) -->
          <div class="card" style="box-shadow: 0 4px 15px rgba(0,0,0,0.02); border: 1px solid rgba(0,0,0,0.05); overflow:hidden;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; flex-wrap:wrap; gap:8px; border-bottom:1px solid #f1f5f9; padding-bottom:12px;">
              <h3 style="font-size:15px; font-weight:800; margin:0; display:flex; align-items:center; gap:8px; color:#1e293b;">
                <i data-lucide="users" style="color:var(--primary); width:18px;"></i> Ventas por COLABORADOR
              </h3>
              <div style="display:flex; background:#f1f5f9; padding:3px; border-radius:10px; gap:2px;">
                ${['today', 'week', 'month', 'year', 'all'].map(p => {
                  const labels = { today: 'Hoy', week: 'Semana', month: 'Mes', year: 'Año', all: 'Histórico' };
                  const active = (state.collabSalesPeriod || 'month') === p;
                  return `
                    <button onclick="state.collabSalesPeriod='${p}';render()" 
                      style="padding:5px 12px; font-size:11px; font-weight:700; border-radius:7px; border:none; cursor:pointer; 
                      background:${active ? 'white' : 'transparent'}; 
                      color:${active ? 'var(--primary)' : '#64748b'}; 
                      box-shadow:${active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none'}; 
                      transition:all 0.15s ease;">
                      ${labels[p]}
                    </button>
                  `;
                }).join('')}
              </div>
            </div>
            <div style="display:flex; flex-direction:column; gap:12px;">
              ${(() => {
                const getBogotaDateStr = (d) => {
                  const formatter = new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'America/Bogota',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                  });
                  return formatter.format(new Date(d));
                };

                const period = state.collabSalesPeriod || 'month';
                const todayStr = getBogotaDateStr(new Date());
                const currentMonthStr = todayStr.substring(0, 7);
                const currentYearStr = todayStr.substring(0, 4);

                // Calcular inicio de semana (Domingo) en hora local de Bogotá
                const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
                const startOfWeek = new Date(nowLocal);
                startOfWeek.setDate(nowLocal.getDate() - nowLocal.getDay());
                const startOfWeekStr = getBogotaDateStr(startOfWeek);

                const ventaCatId = state.categories.find(c => c.name === 'Venta' && c.type === 'income')?.id;

                // Filtrar transacciones de venta según el período seleccionado
                const filteredTx = state.transactions.filter(t => {
                  const isSale = t.type === 'income' && (t.category_id === ventaCatId || t.description?.includes('Venta POS'));
                  if (!isSale) return false;

                  const txDateStr = getBogotaDateStr(t.date);

                  if (period === 'today') {
                    return txDateStr === todayStr;
                  } else if (period === 'week') {
                    return txDateStr >= startOfWeekStr && txDateStr <= todayStr;
                  } else if (period === 'month') {
                    return txDateStr.startsWith(currentMonthStr);
                  } else if (period === 'year') {
                    return txDateStr.startsWith(currentYearStr);
                  }
                  return true; // 'all'
                });

                // Agrupar métricas
                const stats = {};
                state.employees.forEach(emp => {
                  stats[emp.id] = { totalAmount: 0, salesCount: 0, empName: emp.name, id: emp.id };
                });
                stats[state.user.id] = { totalAmount: 0, salesCount: 0, empName: state.user.name, id: state.user.id };

                filteredTx.forEach(t => {
                  const uid = t.user_id || state.user.id;
                  if (!stats[uid]) {
                    stats[uid] = { totalAmount: 0, salesCount: 0, empName: 'Colaborador', id: uid };
                  }
                  stats[uid].totalAmount += Number(t.amount);
                  stats[uid].salesCount += 1;
                });

                // Ordenar líderes por monto vendido
                const leaderboard = Object.values(stats)
                  .filter(s => s.totalAmount > 0 || state.employees.some(e => e.id === s.id))
                  .sort((a, b) => b.totalAmount - a.totalAmount);

                const maxSalesAmount = leaderboard.length > 0 ? Math.max(...leaderboard.map(s => s.totalAmount)) : 0;

                const getRankBadge = (index) => {
                  if (index === 0) return '🥇';
                  if (index === 1) return '🥈';
                  if (index === 2) return '🥉';
                  return `<span style="font-size:10px; font-weight:800; color:#64748b; background:#e2e8f0; width:22px; height:22px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center;">${index + 1}</span>`;
                };

                if (filteredTx.length === 0) {
                  return `
                    <div style="text-align:center; padding:30px 20px; color:#94a3b8;">
                      <span style="font-size:36px; display:block; margin-bottom:10px;">📦</span>
                      <p style="margin:0; font-size:13px; font-weight:600;">Sin ventas registradas en el período seleccionado</p>
                    </div>
                  `;
                }

                return leaderboard.map((s, index) => {
                  const pct = maxSalesAmount > 0 ? (s.totalAmount / maxSalesAmount) * 100 : 0;
                  return `
                    <div style="display:flex; flex-direction:column; gap:8px; padding:12px; background:#f8fafc; border-radius:14px; border:1px solid #f1f5f9; transition:all 0.2s ease;">
                      <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div style="display:flex; align-items:center; gap:10px; flex: 1; min-width: 0;">
                          <span style="font-size:16px; width:24px; text-align:center; display:flex; justify-content:center; align-items:center;">${getRankBadge(index)}</span>
                          <div style="width:34px; height:34px; min-width:34px; border-radius:50%; background:linear-gradient(135deg, var(--primary), var(--secondary)); color:white; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:12px; box-shadow:0 2px 5px rgba(59,130,246,0.15);">
                            ${s.empName.substring(0, 2).toUpperCase()}
                          </div>
                          <div style="min-width: 0; flex: 1;">
                            <span style="font-weight:700; font-size:13px; color:#1e293b; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${s.empName}</span>
                            <p style="font-size:10px; color:#64748b; margin:0;">${s.salesCount} ventas · Prom: ${formatCurrency(s.salesCount > 0 ? s.totalAmount / s.salesCount : 0)}</p>
                          </div>
                        </div>
                        <div style="text-align:right; display:flex; align-items:center; gap:8px; margin-left:10px;">
                          <div>
                            <span style="font-weight:800; font-size:14px; color:#10b981; display:block;">${formatCurrency(s.totalAmount)}</span>
                          </div>
                          <button onclick="window.openCollabAnalytics('${s.id}')" 
                            style="padding:6px 12px; font-size:11px; font-weight:800; background:white; color:var(--primary); border:1px solid #cbd5e1; border-radius:8px; cursor:pointer; transition:all 0.15s ease;">
                            Analizar
                          </button>
                        </div>
                      </div>
                      <!-- Barra de Progreso Visual -->
                      <div style="width:100%; height:5px; background:#e2e8f0; border-radius:3px; overflow:hidden;">
                        <div style="width:${pct}%; height:100%; background:linear-gradient(90deg, var(--primary), #10b981); border-radius:3px; transition:width 0.3s ease;"></div>
                      </div>
                    </div>
                  `;
                }).join('');
              })()}
            </div>
          </div>

          <!-- PRODUCTOS PENDIENTES -->
          <div class="card" onclick="state.view='pending_admin';render()" style="cursor:pointer; border:1px dashed var(--secondary);">
            <h3 style="font-size:16px; margin-bottom:15px; display:flex; justify-content:space-between; align-items:center;">
              <span style="display:flex; align-items:center; gap:8px;"><i data-lucide="plus-circle" style="color:var(--secondary); width:18px;"></i> Pendientes de Formalizar</span>
              <span style="font-size:10px; background:var(--secondary); color:white; padding:2px 8px; border-radius:10px;">Ver Todos</span>
            </h3>
            <div style="display:flex; flex-direction:column; gap:10px;">
              ${state.pendingProducts.length > 0 ? state.pendingProducts.slice(0, 3).map(p => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:#f0f9ff; border-radius:10px; border:1px solid #bae6fd;">
                  <div style="display:flex; align-items:center; gap:10px;">
                    ${p.photo_url ? `<img src="${p.photo_url}" style="width:30px; height:30px; border-radius:5px; object-fit:cover;">` : '<i data-lucide="package" style="width:20px; color:#64748b;"></i>'}
                    <span style="font-weight:600; font-size:13px;">${p.name}</span>
                  </div>
                  <span style="font-weight:700; color:var(--secondary);">${formatCurrency(p.price)}</span>
                </div>
              `).join('') : '<p style="text-align:center; color:var(--text-muted); padding:20px;">No hay productos pendientes</p>'}
            </div>
          </div>
        </div>

        <!-- 💵 PANEL DE AUDITORÍA: CIERRES DE CAJA (CONSOLIDADOS) -->
        <div class="card" style="margin-top:30px; padding:30px; border:none; box-shadow: 0 10px 30px rgba(0,0,0,0.05); background: #ffffff;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
            <div>
              <h3 style="font-size:20px; font-weight:800; color:#1e293b; display:flex; align-items:center; gap:12px;">
                <span style="background:#0f766e; color:white; padding:8px; border-radius:12px; display:inline-flex; align-items:center; justify-content:center;"><i data-lucide="wallet" style="width:20px; height:20px;"></i></span>
                Auditoría de Cierres de Caja (Consolidados)
              </h3>
              <p style="font-size:12px; color:#64748b; margin-top:5px; font-weight:500;">Comparación inteligente de arqueo físico vs registros contables del sistema.</p>
            </div>
          </div>

          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; text-align:left; font-size:13px;">
              <thead>
                <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0;">
                  <th style="padding:15px; font-weight:900; color:#475569; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">Fecha / Sede</th>
                  <th style="padding:15px; font-weight:900; color:#475569; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">Cajero</th>
                  <th style="padding:15px; font-weight:900; color:#475569; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; text-align:right;">Reportado (Físico)</th>
                  <th style="padding:15px; font-weight:900; color:#475569; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; text-align:right;">Sistema (POS)</th>
                  <th style="padding:15px; font-weight:900; color:#475569; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; text-align:right;">Descuadre</th>
                  <th style="padding:15px; font-weight:900; color:#475569; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">Desglose por Canal / Observaciones</th>
                </tr>
              </thead>
              <tbody>
                ${(!state.cashClosures || state.cashClosures.length === 0) ? `
                  <tr>
                    <td colspan="6" style="padding:40px; text-align:center; color:#94a3b8; font-weight:600;">No se han registrado cierres de caja en la base de datos aún.</td>
                  </tr>
                ` : state.cashClosures.map(c => {
                  const sys = getSystemSalesForClosure(c.business_id, c.date, c);
                  const effectiveCash = Number(c.cash_amount) - Number(c.next_day_base_amount || 0);
                  const totalReported = effectiveCash + Number(c.addi_amount) + Number(c.sistecredito_amount) + Number(c.daviplata_amount) + Number(c.nequi_amount) + Number(c.bonos_amount || 0);
                  const totalSystem = sys.efectivo + sys.addi + sys.sistecredito + sys.daviplata + sys.nequi + (sys.bonos || 0);
                  const diff = totalReported - totalSystem;

                  let diffColor = '#10b981'; // Verde
                  let diffText = '🟢 Cuadrado';
                  let diffBg = '#ecfdf5';
                  if (diff < -50) {
                    diffColor = '#ef4444'; // Rojo
                    diffText = `🔴 Faltante: -${formatCurrency(Math.abs(diff))}`;
                    diffBg = '#fef2f2';
                  } else if (diff > 50) {
                    diffColor = '#f59e0b'; // Ámbar
                    diffText = `🟡 Sobrante: +${formatCurrency(diff)}`;
                    diffBg = '#fffbeb';
                  }
                  
                  // Identificador visual de turno para Baratillo
                  let shiftLabel = '';
                  const isBaratillo = c.businesses?.name?.toLowerCase().includes('baratillo');
                  if (isBaratillo) {
                    const closureHour = new Date(c.created_at).getHours();
                    if (closureHour >= 12 && closureHour <= 17) shiftLabel = ' <span style="font-size:10px; background:#fef08a; color:#854d0e; padding:2px 6px; border-radius:10px; font-weight:800; margin-left:6px;">☀️ Mañana</span>';
                    else if (closureHour >= 18) shiftLabel = ' <span style="font-size:10px; background:#1e293b; color:#94a3b8; padding:2px 6px; border-radius:10px; font-weight:800; margin-left:6px;">🌙 Noche</span>';
                  }

                  return `
                    <tr style="border-bottom:1px solid #e2e8f0; transition: background 0.2s;">
                      <td style="padding:15px; font-weight:700;">
                        <span style="display:flex; align-items:center; font-size:13px; color:#1e293b;">${c.date}${shiftLabel}</span>
                        <span style="display:block; font-size:11px; color:#64748b; font-weight:500; margin-top:2px;">🏢 ${c.businesses?.name || 'Sede'}</span>
                      </td>
                      <td style="padding:15px; color:#475569; font-weight:600;">👤 ${c.users?.name || 'Cajero'}</td>
                      <td style="padding:15px; text-align:right; font-weight:800; color:#0f766e; font-size:14px;">${formatCurrency(totalReported)}</td>
                      <td style="padding:15px; text-align:right; font-weight:800; color:#3b82f6; font-size:14px;">${formatCurrency(totalSystem)}</td>
                      <td style="padding:15px; text-align:right;">
                        <span style="display:inline-block; padding:4px 10px; border-radius:8px; font-weight:800; font-size:12px; color:${diffColor}; background:${diffBg}; border:1px solid ${diffColor}22;">
                          ${diffText}
                        </span>
                      </td>
                      <td style="padding:15px;">
                        <div style="font-size:11px; line-height:1.6; color:#475569; display:grid; grid-template-columns:1fr 1fr; gap:0 15px; width:280px;">
                          <div>💵 <b>Efectivo</b>: R: ${formatCurrency(Number(c.cash_amount) - Number(c.next_day_base_amount || 0))} / S: ${formatCurrency(sys.efectivo)}</div>
                          <div>📱 <b>Daviplata</b>: R: ${formatCurrency(c.daviplata_amount)} / S: ${formatCurrency(sys.daviplata)}</div>
                          <div>💳 <b>Addi</b>: R: ${formatCurrency(c.addi_amount)} / S: ${formatCurrency(sys.addi)}</div>
                          <div>💳 <b>Sistecrédito</b>: R: ${formatCurrency(c.sistecredito_amount)} / S: ${formatCurrency(sys.sistecredito)}</div>
                          <div style="grid-column: 1 / -1;">🏦 <b>Nequi/Trans.</b>: R: ${formatCurrency(c.nequi_amount)} / S: ${formatCurrency(sys.nequi)}</div>
                          <div style="grid-column: 1 / -1;">🎟️ <b>Bonos C.</b>: R: ${formatCurrency(c.bonos_amount || 0)} / S: ${formatCurrency(sys.bonos || 0)}</div>
                          ${Number(c.next_day_base_amount) > 0 ? `<div style="grid-column: 1 / -1; color:#0369a1;">💰 <b>Base dejada en caja:</b> ${formatCurrency(c.next_day_base_amount)}</div>` : ''}
                        </div>
                        ${(Number(c.other_expenses_amount) > 0 || Number(c.savings_amount) > 0) ? `
                          <div style="margin-top:8px; display:flex; flex-direction:column; gap:4px; max-width:280px; padding:8px; background:rgba(56,189,248,0.05); border:1px dashed rgba(56,189,248,0.2); border-radius:8px;">
                            ${Number(c.other_expenses_amount) > 0 ? `
                              <div style="display:flex; justify-content:space-between; font-size:11px; color:#0369a1; font-weight:700;">
                                <span>➕ Otros Gastos:</span>
                                <span>${formatCurrency(c.other_expenses_amount)}</span>
                              </div>
                              ${c.other_expenses_description ? `<div style="font-size:10px; color:#475569; font-weight:500; padding-left:10px; font-style:italic;">📝 ${c.other_expenses_description}</div>` : ''}
                            ` : ''}
                            ${Number(c.savings_amount) > 0 ? `
                              <div style="display:flex; justify-content:space-between; font-size:11px; color:#0f766e; font-weight:700; margin-top:${Number(c.other_expenses_amount) > 0 ? '4px' : '0'};">
                                <span>🐖 Alcancía (Ahorro):</span>
                                <span>${formatCurrency(c.savings_amount)}</span>
                              </div>
                              ${c.savings_description ? `<div style="font-size:10px; color:#475569; font-weight:500; padding-left:10px; font-style:italic;">📝 ${c.savings_description}</div>` : ''}
                            ` : ''}
                          </div>
                        ` : ''}
                        ${c.observations ? `<div style="margin-top:8px; padding:8px 12px; background:#f8fafc; border-left:3.5px solid #cbd5e1; font-size:11px; font-style:italic; color:#475569; border-radius:0 8px 8px 0; max-width:280px;">📝 ${c.observations}</div>` : ''}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- CALCULADORA DE NÓMINA PREMIUM -->
        <div class="card" style="margin-top:30px; padding:30px; border:none; box-shadow: 0 10px 30px rgba(0,0,0,0.05); background: #ffffff;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:25px; flex-wrap:wrap; gap:15px;">
            <div>
              <h3 style="font-size:20px; font-weight:800; color:#1e293b; display:flex; align-items:center; gap:12px;">
                <span style="background:var(--secondary); color:white; padding:8px; border-radius:12px;"><i data-lucide="dollar-sign"></i></span>
                Liquidación de Nómina
              </h3>
              <p style="font-size:12px; color:#64748b; margin-top:5px; font-weight:500;">Filtros aplicados: Del <strong>${new Date(state.payrollFilters.startDate+'T00:00').toLocaleDateString('es-ES', {day:'numeric', month:'short'})}</strong> al <strong>${new Date(state.payrollFilters.endDate+'T00:00').toLocaleDateString('es-ES', {day:'numeric', month:'short', year:'numeric'})}</strong></p>
            </div>
          </div>

          <!-- PANEL DE FILTROS SEMI-AUTOMÁTICOS (Calendario y Empleado) -->
          <div style="display:flex; gap:15px; margin-bottom:25px; background:#f8fafc; padding:20px; border-radius:16px; align-items:flex-end; flex-wrap:wrap; border:1px solid #e2e8f0;">
            <div style="flex:1; min-width:220px;">
              <label style="display:block; font-size:11px; font-weight:800; color:#64748b; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">👤 Seleccionar Empleado</label>
              <select id="payroll-emp" class="form-input" style="width:100%; font-size:13px; font-weight:700; border-radius:10px;">
                <option value="all" ${state.payrollFilters.employeeId === 'all' ? 'selected' : ''}>👥 TODOS LOS COLABORADORES</option>
                ${state.employees.map(emp => `<option value="${emp.id}" ${state.payrollFilters.employeeId === emp.id ? 'selected' : ''}>👤 ${emp.name}</option>`).join('')}
              </select>
            </div>
            <div style="flex:1; min-width:150px;">
              <label style="display:block; font-size:11px; font-weight:800; color:#64748b; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">📅 Fecha Desde (Día X)</label>
              <input type="date" id="payroll-start" class="form-input" style="width:100%; font-size:13px; font-weight:700; border-radius:10px;" value="${state.payrollFilters.startDate}">
            </div>
            <div style="flex:1; min-width:150px;">
              <label style="display:block; font-size:11px; font-weight:800; color:#64748b; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">📅 Fecha Hasta (Día Y)</label>
              <input type="date" id="payroll-end" class="form-input" style="width:100%; font-size:13px; font-weight:700; border-radius:10px;" value="${state.payrollFilters.endDate}">
            </div>
            <button onclick="window.executePayrollCalculation()" class="btn-primary" style="background:var(--secondary); padding:12px 25px; border-radius:12px; font-weight:800; box-shadow: 0 4px 12px rgba(239,68,68,0.2); display:flex; align-items:center; gap:8px; height:45px;">
              <i data-lucide="refresh-cw" style="width:16px;"></i> CALCULAR NÓMINA
            </button>
          </div>

          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:separate; border-spacing: 0 10px; font-size:13px;">
              <thead>
                <tr style="text-align:left; color:#94a3b8; font-size:10px; text-transform:uppercase; letter-spacing:1px;">
                  <th style="padding:15px;">Colaborador</th>
                  <th style="padding:15px;">Tarifa</th>
                  <th style="padding:15px; text-align:center; background:rgba(59,130,246,0.03); border-radius:10px 0 0 10px;">Planilla Fija</th>
                  <th style="padding:15px; text-align:center; background:rgba(16,185,129,0.03);">Marcación Real (GPS)</th>
                  <th style="padding:15px; text-align:center; background:rgba(245,158,11,0.03);">Desfase / Variación</th>
                  <th style="padding:15px; text-align:right;">Pago Planilla</th>
                  <th style="padding:15px; text-align:right; border-radius:0 10px 10px 0;">Pago GPS</th>
                </tr>
              </thead>
              <tbody>
                ${!state.payrollData ? `
                  <tr>
                    <td colspan="7" style="text-align:center; padding:60px; background:#f8fafc; border-radius:16px;">
                      <div style="font-size:40px; margin-bottom:15px; color:#94a3b8;"><i data-lucide="bar-chart-3" style="width:48px; height:48px;"></i></div>
                      <p style="color:#64748b; font-size:14px; font-weight:600;">Define el rango de fechas arriba y haz clic en Calcular Nómina</p>
                    </td>
                  </tr>
                ` : Object.entries(state.payrollData)
                    .filter(([empId]) => state.payrollFilters.employeeId === 'all' || state.payrollFilters.employeeId === empId)
                    .map(([empId, data]) => {
                  const emp = state.employees.find(e => e.id === empId) || { name: 'Empleado Desconocido', hourly_rate: 0 };
                  const offset = data.gpsHours - data.hours; // Real GPS menos Planilla
                  
                  let offsetBadge = '';
                  if (Math.abs(offset) < 0.05) {
                    offsetBadge = `<span style="display:inline-flex; padding:4px 10px; background:#ecfdf5; color:#10b981; border:1px solid #d1fae5; border-radius:20px; font-weight:800; font-size:11px; gap:4px;"><i data-lucide="check-circle" style="width:12px;"></i> Coincide</span>`;
                  } else if (offset > 0) {
                    offsetBadge = `<span style="display:inline-flex; padding:4px 10px; background:#eff6ff; color:#2563eb; border:1px solid #dbeafe; border-radius:20px; font-weight:800; font-size:11px; gap:4px;" title="El empleado trabajó más tiempo que el asignado en planilla"><i data-lucide="trending-up" style="width:12px;"></i> +${offset.toFixed(2)}h Extra</span>`;
                  } else {
                    offsetBadge = `<span style="display:inline-flex; padding:4px 10px; background:#fef2f2; color:#ef4444; border:1px solid #fee2e2; border-radius:20px; font-weight:800; font-size:11px; gap:4px;" title="El empleado trabajó menos tiempo del asignado"><i data-lucide="alert-triangle" style="width:12px;"></i> -${Math.abs(offset).toFixed(2)}h Faltante</span>`;
                  }

                  return `
                    <tr style="background:#f8fafc; transition:all 0.2s;">
                      <td style="padding:15px; border-radius:12px 0 0 12px; font-weight:800; color:#1e293b;">
                        <div style="display:flex; align-items:center; gap:8px;">
                          <div style="width:32px; height:32px; border-radius:50%; background:#e2e8f0; display:flex; align-items:center; justify-content:center; font-size:12px; color:#475569; font-weight:800;">${emp.name.charAt(0).toUpperCase()}</div>
                          <div>
                            <p style="margin:0; font-size:14px;">${emp.name}</p>
                            <p style="margin:2px 0 0 0; font-size:10px; color:#94a3b8;">${data.shiftsCount} turnos registrados</p>
                          </div>
                        </div>
                      </td>
                      <td style="padding:15px; color:#475569; font-weight:600;">
                        <div style="display:flex; align-items:center; gap:4px;">
                          ${formatCurrency(emp.hourly_rate || 0)}
                          <button onclick="window.editHourlyRate('${emp.id}', '${emp.name.replace(/'/g, "\\'")}')" style="background:none; border:none; cursor:pointer; color:var(--primary); width:24px; height:24px; display:flex; align-items:center; justify-content:center;" title="Modificar Tarifa"><i data-lucide="edit-3" style="width:14px;"></i></button>
                        </div>
                      </td>
                      <td style="padding:15px; text-align:center; font-weight:800; color:#1d4ed8; background:rgba(59,130,246,0.02);">
                        ${data.hours.toFixed(2)} hrs
                      </td>
                      <td style="padding:15px; text-align:center; font-weight:800; color:#047857; background:rgba(16,185,129,0.02);">
                        ${data.gpsHours.toFixed(2)} hrs
                      </td>
                      <td style="padding:15px; text-align:center; background:rgba(245,158,11,0.02);">
                        ${offsetBadge}
                      </td>
                      <td style="padding:15px; border-radius:0; text-align:right;">
                        <span style="font-size:16px; font-weight:900; color:#3b82f6;">${formatCurrency(data.scheduledPay)}</span>
                      </td>
                      <td style="padding:15px; border-radius:0 12px 12px 0; text-align:right;">
                        <span style="font-size:16px; font-weight:900; color:var(--success);">${formatCurrency(data.pay)}</span>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
          
          <div style="margin-top:20px; padding:15px; background:rgba(239,68,68,0.05); border-radius:12px; border:1px solid rgba(239,68,68,0.1);">
             <p style="font-size:11px; color:var(--secondary); font-weight:700; text-align:center; display:flex; align-items:center; justify-content:center; gap:8px;"><i data-lucide="alert-circle" style="width:14px;"></i> El cálculo solo incluye turnos marcados como FINALIZADOS en el sistema.</p>
          </div>
        </div>
      </div>
    `;
  }

  else if (state.view === 'attendance_admin' || state.view === 'logs') {
    // Redirección inteligente al centro de mando unificado
    state.view = 'shifts_admin';
    return render();
  }

  else if (state.view === 'shifts_weekly') {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));
    startOfWeek.setHours(0,0,0,0);

    const userShifts = state.shifts.filter(s => s.user_id === state.user.id);
    const days = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

    html = `
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon"><i data-lucide="calendar"></i></div>
          <div class="header-title">
            <p class="role-tag" style="margin:0;">HORARIO</p>
            <h1>Mi Planificación</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="state.view='app';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px;">VOLVER</button>
        </div>
      </header>

      <div class="container">
        <div style="display:grid; grid-template-columns: 1fr; gap:15px;">
          ${days.map((dayName, idx) => {
            const dayDate = new Date(startOfWeek);
            dayDate.setDate(startOfWeek.getDate() + idx);
            const isToday = dayDate.toDateString() === now.toDateString();
            
            const dayShifts = userShifts.filter(s => new Date(s.start_time).toDateString() === dayDate.toDateString());

            return `
              <div class="card" style="padding:20px; border-left:5px solid ${isToday ? 'var(--primary)' : '#e2e8f0'};">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div>
                    <p style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">${dayName}</p>
                    <p style="font-size:20px; font-weight:800;">${dayDate.getDate()} de ${dayDate.toLocaleDateString('es-ES', {month:'long'})}</p>
                  </div>
                  ${isToday ? '<span style="padding:4px 10px; background:rgba(239,68,68,0.1); color:var(--primary); border-radius:20px; font-size:10px; font-weight:800;">HOY</span>' : ''}
                </div>
                
                <div style="margin-top:15px;">
                  ${dayShifts.length > 0 ? dayShifts.map(s => `
                    <div style="background:linear-gradient(135deg, var(--primary) 0%, #0f172a 100%); color:white; padding:15px; border-radius:16px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                      <p style="font-weight:700; font-size:15px; margin-bottom:5px; display:flex; align-items:center; gap:8px;"><i data-lucide="map-pin" style="width:16px;"></i> ${s.businesses?.name || 'Local'}</p>
                      <p style="opacity:0.9; font-size:12px; font-weight:500; display:flex; align-items:center; gap:8px;"><i data-lucide="clock" style="width:16px;"></i> ${new Date(s.start_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} - ${new Date(s.end_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</p>
                    </div>
                  `).join('') : `
                    <p style="color:var(--text-muted); font-size:13px; font-style:italic;">Sin turnos asignados</p>
                  `}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  else if (state.view === 'shifts_admin') {
    if (!state.rosterConfig) {
      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));
      state.rosterConfig = {
        daysCount: 15,
        startDate: startOfWeek.toISOString().split('T')[0]
      };
    }

    const baseDate = new Date(state.rosterConfig.startDate + 'T00:00:00');
    const rosterDates = Array.from({ length: state.rosterConfig.daysCount }, (_, i) => {
      const d = new Date(baseDate);
      d.setDate(baseDate.getDate() + i);
      return d;
    });

    html = `
      <header class="main-header" style="border-bottom: 2px solid var(--primary);">
        <div class="logo-container">
          <div class="logo-icon" style="background:var(--primary); color:white;"><i data-lucide="calendar-days"></i></div>
          <div class="header-title">
            <p class="role-tag" style="background:rgba(239, 68, 68, 0.1); color:var(--primary);">CONTROL OPERATIVO</p>
            <h1>Gestión Unificada de Turnos</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="window.replicateSelectedWeek()" class="btn-primary" style="padding:8px 15px; font-size:12px; background:#10b981; border:none;">🔄 REPLICAR SEMANA A FUTURO</button>
          <button onclick="state.view='manager_dashboard';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px; margin-left:10px;">VOLVER</button>
        </div>
      </header>

      <div class="container" style="max-width:1400px; padding-top:30px;">
        <div style="display:grid; grid-template-columns: 1fr; gap:30px;">
          
          <!-- SECCIÓN 1: PLANILLA MATRIX (EL "CEREBRO" DE LA OPERACIÓN) -->
          <div class="card" style="padding:0; overflow:hidden; border:none; box-shadow: 0 15px 35px rgba(0,0,0,0.08);">
            <div style="padding:25px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:20px; background:#fafafa;">
              <div>
                <h3 style="font-size:18px; margin:0; font-weight:900; color:#1e293b; display:flex; align-items:center; gap:10px;">
                  <i data-lucide="layout-grid" style="width:22px; color:var(--primary);"></i>
                  Planificador de Recursos Humanos
                </h3>
                <p style="font-size:12px; color:#64748b; margin:4px 0 0 0;">Visualización de despliegue táctico de personal</p>
              </div>
              
              <div style="display:flex; gap:15px; align-items:center; flex-wrap:wrap;">
                <div style="display:flex; align-items:center; gap:8px;">
                  <span style="font-size:10px; font-weight:900; color:#94a3b8; text-transform:uppercase;">Vista:</span>
                  <select onchange="state.rosterConfig.daysCount = parseInt(this.value); window.render()" class="form-input" style="width:auto; height:40px; font-size:12px; font-weight:800; border-radius:12px; padding:0 12px;">
                    <option value="7" ${state.rosterConfig.daysCount === 7 ? 'selected' : ''}>7 DÍAS</option>
                    <option value="15" ${state.rosterConfig.daysCount === 15 ? 'selected' : ''}>15 DÍAS</option>
                    <option value="30" ${state.rosterConfig.daysCount === 30 ? 'selected' : ''}>30 DÍAS</option>
                  </select>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                  <span style="font-size:10px; font-weight:900; color:#94a3b8; text-transform:uppercase;">Desde:</span>
                  <input type="date" onchange="state.rosterConfig.startDate = this.value; window.render()" class="form-input" style="width:auto; height:40px; font-size:12px; font-weight:800; border-radius:12px;" value="${state.rosterConfig.startDate}">
                </div>
              </div>
            </div>

            <div style="overflow-x:auto; background:#ffffff; max-height:500px; overflow-y:auto; position: relative;">
              <table style="width: calc(200px + (${state.rosterConfig.daysCount} * 120px)); border-collapse:collapse; table-layout:fixed;">
                <thead>
                  <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0; position:sticky; top:0; z-index:10;">
                    <th style="padding:15px; text-align:left; width:200px; color:#475569; background:#f8fafc; font-weight:900; font-size:10px; text-transform:uppercase; letter-spacing:1px; border-right:1px solid #e2e8f0; position:sticky; left:0; z-index:11; box-shadow: 2px 0 10px rgba(0,0,0,0.05);">COLABORADOR</th>
                    ${rosterDates.map(d => {
                      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                      const isToday = d.toDateString() === new Date().toDateString();
                      return `<th style="padding:12px; text-align:center; width:120px; color:${isToday ? 'var(--primary)' : (isWeekend ? '#ef4444' : '#475569')}; font-weight:900; background:${isToday ? '#fef2f2' : (isWeekend ? '#fffafb' : '#f8fafc')}; border-right:1px solid #edf2f7;">
                        <span style="font-size:10px; opacity:0.8; text-transform:uppercase; display:block;">${d.toLocaleDateString('es-ES', { weekday: 'short' })}</span>
                        <span style="font-size:16px; font-weight:900; display:block; margin:2px 0;">${d.getDate()}</span>
                        <span style="font-size:9px; opacity:0.6; text-transform:uppercase; display:block;">${d.toLocaleDateString('es-ES', { month: 'short' })}</span>
                      </th>`;
                    }).join('')}
                  </tr>
                </thead>
                <tbody>
                  ${state.employees.map(emp => {
                    const empShifts = state.shifts.filter(s => s.user_id === emp.id);
                    return `
                      <tr style="border-bottom:1px solid #edf2f7;">
                        <td style="padding:15px; font-weight:800; color:#1e293b; background:#fafbfc; border-right:1px solid #e2e8f0; position:sticky; left:0; z-index:2; box-shadow: 2px 0 10px rgba(0,0,0,0.02);">
                          <div style="display:flex; align-items:center; gap:10px;">
                            <div style="width:32px; height:32px; border-radius:10px; background:linear-gradient(135deg, var(--primary) 0%, #0f172a 100%); color:white; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:900; box-shadow:0 4px 10px rgba(239,68,68,0.25);">${emp.name.charAt(0).toUpperCase()}</div>
                            <div style="overflow:hidden;">
                               <div style="text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:800;">${emp.name}</div>
                               <div style="font-size:9px; color:#94a3b8; font-weight:700;">Rate: ${formatCurrency(emp.hourly_rate || 0)}/h</div>
                            </div>
                          </div>
                        </td>
                        ${rosterDates.map(dayDate => {
                          const dayShift = empShifts.find(s => new Date(s.start_time).toDateString() === dayDate.toDateString());
                          const isToday = dayDate.toDateString() === new Date().toDateString();
                          return `
                            <td style="padding:10px; text-align:center; vertical-align:middle; min-height:100px; border-right:1px solid #edf2f7; background:${isToday ? '#fff8f8' : '#ffffff'};">
                              ${dayShift ? `
                                <div style="background:linear-gradient(135deg, #1e293b 0%, #0f172a 100%); color:white; padding:10px; border-radius:14px; font-size:10px; font-weight:700; box-shadow:0 8px 20px rgba(0,0,0,0.15); position:relative; overflow:hidden; border:1px solid rgba(255,255,255,0.05);">
                                  <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:5px; color:var(--secondary); font-size:9px; font-weight:900; text-transform:uppercase; letter-spacing:0.5px;">📍 ${dayShift.businesses?.name || 'Local'}</div>
                                  <div style="font-size:12px; display:flex; align-items:center; justify-content:center; gap:4px; font-weight:900;"><i data-lucide="clock" style="width:12px;"></i> ${new Date(dayShift.start_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12: false})}</div>
                                  <div style="margin-top:10px; display:flex; justify-content:center; gap:12px; background:rgba(255,255,255,0.08); padding:6px 0; border-radius:8px;">
                                    <span onclick="window.openModal('shift', '${dayShift.id}')" style="cursor:pointer; color:var(--secondary); display:flex; align-items:center;" title="Ajustar Horario"><i data-lucide="settings-2" style="width:14px;"></i></span>
                                    <span onclick="window.deleteShift('${dayShift.id}')" style="cursor:pointer; color:var(--primary); display:flex; align-items:center;" title="Eliminar"><i data-lucide="trash-2" style="width:14px;"></i></span>
                                  </div>
                                </div>
                              ` : `
                                <button onclick="window.openModal('shift', null, '${emp.id}', '${dayDate.toISOString()}')" style="width:34px; height:34px; background:#f8fafc; border:2px dashed #e2e8f0; color:#cbd5e1; cursor:pointer; border-radius:12px; font-size:18px; font-weight:900; transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1); display:inline-flex; align-items:center; justify-content:center;" onmouseover="this.style.borderColor='var(--primary)'; this.style.color='var(--primary)'; this.style.background='white'; this.style.transform='scale(1.1)';" onmouseout="this.style.borderColor='#e2e8f0'; this.style.color='#cbd5e1'; this.style.background='#f8fafc'; this.style.transform='scale(1)';">+</button>
                              `}
                            </td>
                          `;
                        }).join('')}
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>

          <!-- SECCIÓN 2: AUDITORÍA DE PERSONAL Y PERMISOS (CENTRALIZADO) -->
          <div class="card" style="padding:25px; border-radius:24px; box-shadow: 0 10px 30px rgba(0,0,0,0.05); border:1px solid #f1f5f9;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:25px; border-bottom:1px solid #f1f5f9; padding-bottom:15px;">
               <div>
                  <h3 style="font-size:18px; font-weight:900; color:#1e293b;">Nómina y Facultades de Personal</h3>
                  <p style="font-size:12px; color:#94a3b8; margin-top:4px;">Configuración de privilegios de acceso y costos operativos</p>
               </div>
               <div style="background:var(--primary); color:white; font-size:11px; font-weight:900; padding:6px 14px; border-radius:30px;">
                  ${state.employees.length} ACTIVOS
               </div>
            </div>
            
            <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap:20px;">
              ${state.employees.filter(e => e.id !== state.user?.id).map(e => `
                <div style="display:flex; flex-direction:column; background:#ffffff; border:1px solid #edf2f7; border-radius:20px; overflow:hidden; transition:all 0.3s ease; box-shadow:0 4px 10px rgba(0,0,0,0.01);" onmouseover="this.style.borderColor='var(--primary)'; this.style.boxShadow='0 10px 25px rgba(239,68,68,0.08)'" onmouseout="this.style.borderColor='#edf2f7'; this.style.boxShadow='0 4px 10px rgba(0,0,0,0.01)'">
                  <div style="padding:18px; border-bottom:1px solid #f8fafc; display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; align-items:center; gap:12px;">
                      <div style="width:40px; height:40px; border-radius:14px; background:#f1f5f9; color:#1e293b; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:16px;">${e.name.charAt(0).toUpperCase()}</div>
                      <div>
                        <p style="font-weight:900; font-size:15px; color:#0f172a; margin:0;">${e.name}</p>
                        <p style="font-size:11px; color:#94a3b8; font-weight:700; text-transform:uppercase;">ID: ${e.id.slice(0,8)}</p>
                      </div>
                    </div>
                  </div>
                  
                  <div style="padding:18px; background:#fafbfc; display:grid; grid-template-columns: 1fr 1fr; gap:15px; border-bottom:1px solid #f1f5f9;">
                    <div>
                      <label style="font-size:9px; font-weight:900; color:#94a3b8; text-transform:uppercase; margin-bottom:8px; display:block;">Costo x Hora</label>
                      <div style="display:flex; align-items:center; gap:6px; background:white; border:1.5px solid #e2e8f0; border-radius:12px; padding:6px 10px;">
                        <span style="font-size:12px; font-weight:900; color:var(--primary);">$</span>
                        <input type="number" value="${e.hourly_rate || 0}" onchange="window.updateUserHourlyRate('${e.id}', this.value)" style="border:none; width:100%; font-size:14px; font-weight:900; outline:none; color:#1e293b;" title="Modificar tarifa horaria">
                      </div>
                    </div>
                    <div style="text-align:right;">
                       <label style="font-size:9px; font-weight:900; color:#94a3b8; text-transform:uppercase; margin-bottom:8px; display:block;">Turnos / Semana</label>
                       <p style="font-size:20px; font-weight:900; color:#1e293b; margin:0;">${state.shifts.filter(s => s.user_id === e.id).length}</p>
                    </div>
                  </div>
                  
                  <div style="padding:15px 18px; display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; gap:10px; flex-wrap:wrap;">
                      <label style="display:flex; align-items:center; gap:6px; cursor:pointer;" title="Permite gestionar movimientos de caja">
                        <input type="checkbox" onchange="window.toggleCashierPermission('${e.id}', ${e.is_cashier})" ${e.is_cashier ? 'checked' : ''} style="width:16px; height:16px; border-radius:6px; accent-color:var(--secondary);">
                        <span style="font-size:10px; font-weight:850; color:${e.is_cashier ? 'var(--secondary)' : '#64748b'}">CAJERO</span>
                      </label>
                      <label style="display:flex; align-items:center; gap:6px; cursor:pointer;" title="Habilita registro de nuevo inventario">
                        <input type="checkbox" onchange="window.toggleInventoryPermission('${e.id}', ${e.can_manage_inventory})" ${e.can_manage_inventory ? 'checked' : ''} style="width:16px; height:16px; border-radius:6px; accent-color:var(--success);">
                        <span style="font-size:10px; font-weight:850; color:${e.can_manage_inventory ? 'var(--success)' : '#64748b'}">INVENTARIO</span>
                      </label>
                      <label style="display:flex; align-items:center; gap:6px; cursor:pointer;" title="Habilita todas las funciones de administrador">
                        <input type="checkbox" onchange="window.toggleAdminPermission('${e.id}', '${e.role}')" ${e.role === 'admin' ? 'checked' : ''} style="width:16px; height:16px; border-radius:6px; accent-color:var(--primary);">
                        <span style="font-size:10px; font-weight:850; color:${e.role === 'admin' ? 'var(--primary)' : '#64748b'}">ADMIN</span>
                      </label>
                    </div>
                    <div style="display:flex; gap:12px;">
                      <button onclick="window.deleteEmployee('${e.id}', '${e.name}')" style="background:#fef2f2; border:1px solid #fee2e2; padding:8px; border-radius:10px; cursor:pointer; color:var(--danger);" title="Eliminar Colaborador">
                         <i data-lucide="user-minus" style="width:18px;"></i>
                      </button>
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
  }
  else if (state.view === 'pending_admin') {
    html = `
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon">ðŸ“¦</div>
          <div class="header-title">
            <p class="role-tag" style="margin:0;">GESTIÓN</p>
            <h1>Productos Pendientes</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="state.view='manager_dashboard';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px;">VOLVER</button>
        </div>
      </header>

      <div class="container">
        <div style="display:grid; grid-template-columns: 1fr; gap:15px;">
          ${state.pendingProducts.length === 0 ? '<p style="text-align:center; padding:50px; color:var(--text-muted);">No hay productos pendientes de formalizar</p>' : state.pendingProducts.map(p => `
            <div class="card" style="display:flex; justify-content:space-between; align-items:center; padding:15px;">
              <div style="display:flex; align-items:center; gap:20px;">
                ${p.photo_url ? `<img src="${p.photo_url}" style="width:60px; height:60px; border-radius:10px; object-fit:cover;">` : '<div style="width:60px; height:60px; background:#f1f5f9; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:24px;">ðŸ“¦</div>'}
                <div>
                  <h3 style="font-size:16px; margin:0;">${p.name}</h3>
                  <p style="font-size:12px; color:var(--text-muted); margin-top:4px;">Vendido: ${p.quantity} unid. a ${formatCurrency(p.price)}</p>
                  <p style="font-size:10px; color:#94a3b8; margin-top:2px;">Por: ${state.employees.find(e => e.id === p.created_by)?.name || 'COLABORADOR'} - ${new Date(p.created_at).toLocaleDateString()}</p>
                </div>
              </div>
              <div style="display:flex; gap:8px;">
                <button onclick="window.convertToRealProduct('${p.id}')" class="btn-primary" style="width:auto; padding:8px 15px; font-size:12px;">FORMALIZAR</button>
                <button onclick="window.deletePendingProduct('${p.id}')" class="btn-primary" style="width:auto; padding:8px 15px; font-size:12px; background:var(--danger); border:none;">ELIMINAR</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
  else if (state.view === 'products_admin') {
    html = renderProductsAdmin(state, formatCurrency);
  }
  else if (state.view === 'inventory_ai') {
    html = renderInventoryAIView(state, formatCurrency);
  }
  else if (state.view === 'qa_dashboard') {
    html = `
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon">🧪</div>
          <div class="header-title">
            <p class="role-tag" style="margin:0;">CALIDAD</p>
            <h1>Panel de Pruebas QA</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="window.runAllTests()" class="btn-primary" style="padding:8px 15px; font-size:12px; background:var(--secondary);">▶ EJECUTAR TODAS</button>
          <button onclick="state.view='manager_dashboard';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px; margin-left:10px;">VOLVER</button>
        </div>
      </header>

      <div class="container">
        <div class="card" style="margin-bottom:30px;">
          <h3 style="font-size:16px; margin-bottom:15px;">Resultados de Integración (Base de Datos Real)</h3>
          <div style="display:flex; flex-direction:column; gap:12px;">
            ${state.qaResults.length === 0 ? '<p style="text-align:center; padding:30px; color:var(--text-muted);">Sin pruebas ejecutadas recientemente</p>' : state.qaResults.map(r => `
              <div style="padding:15px; background:#f8fafc; border-radius:15px; border-left:5px solid ${r.status === 'PASSED' ? 'var(--success)' : 'var(--danger)'};">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span style="font-weight:700; font-size:14px;">${r.name}</span>
                  <span style="font-size:10px; font-weight:800; color:${r.status === 'PASSED' ? 'var(--success)' : 'var(--danger)'}">${r.status}</span>
                </div>
                <p style="font-size:12px; color:var(--text-muted); margin-top:5px;">${r.message}</p>
              </div>
            `).join('')}
          </div>
        </div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px;">
           <div class="card" style="background:rgba(16,185,129,0.05); border:1px dashed var(--success);">
             <h4 style="font-size:14px; color:var(--success);">Pruebas de Venta</h4>
             <p style="font-size:11px; color:#64748b; margin-top:5px;">Valida deducción de stock y creación de registros.</p>
             <button onclick="window.testNormalSale()" class="btn-primary" style="width:100%; margin-top:15px; background:var(--success); border:none; padding:8px;">TEST VENTA</button>
           </div>
           <div class="card" style="background:rgba(59,130,246,0.05); border:1px dashed var(--primary);">
             <h4 style="font-size:14px; color:var(--primary);">Pruebas Stock</h4>
             <p style="font-size:11px; color:#64748b; margin-top:5px;">Valida movimientos de entrada y trazabilidad.</p>
             <button onclick="window.testStockManagement()" class="btn-primary" style="width:100%; margin-top:15px; background:var(--primary); border:none; padding:8px;">TEST STOCK</button>
           </div>
        </div>
      </div>
    `;
  }
  
  else if (state.view === 'suppliers_admin') {
    const suppliersList = state.suppliers || [];
    const totalSuppliers = suppliersList.length;
    const totalDebt = suppliersList.reduce((s, sup) => s + (parseFloat(sup.debt) || 0), 0);
    const totalCash = suppliersList.reduce((s, sup) => s + (parseFloat(sup.cash_purchases) || 0), 0);

    // 👑 Cálculo en Tiempo Real del Proveedor Estrella
    let topSupplierName = 'Ninguno';
    let maxVol = -1;
    suppliersList.forEach(s => {
      const vol = (parseFloat(s.cash_purchases) || 0) + (parseFloat(s.debt) || 0);
      if (vol > maxVol && vol > 0) {
        maxVol = vol;
        topSupplierName = s.name;
      }
    });

    html = `
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon"><img src="logo_v3.png" alt="Logo"></div>
          <div class="header-title">
            <p class="role-tag" style="margin:0;">ADMINISTRACIÓN</p>
            <h1>Gestión de Proveedores</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="state.view='manager_dashboard';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px;">VOLVER</button>
        </div>
      </header>

      <div class="container" style="max-width: 1300px;">
        <!-- Summary Cards -->
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:20px; margin-bottom:25px;">
          <div class="card" style="text-align:center; border-left:5px solid #0d9488;">
            <p style="font-size:11px; color:var(--text-muted); font-weight:700;">TOTAL PROVEEDORES</p>
            <p style="font-size:24px; font-weight:800; color:#0d9488; margin-top:8px;">${totalSuppliers}</p>
          </div>
          <div class="card" style="text-align:center; border-left:5px solid var(--danger);">
            <p style="font-size:11px; color:var(--text-muted); font-weight:700;">SALDO PENDIENTE (DEUDA)</p>
            <p style="font-size:24px; font-weight:800; color:var(--danger); margin-top:8px;">${formatCurrency(totalDebt)}</p>
          </div>
          <div class="card" style="text-align:center; border-left:5px solid var(--success);">
            <p style="font-size:11px; color:var(--text-muted); font-weight:700;">COMPRAS DE CONTADO</p>
            <p style="font-size:24px; font-weight:800; color:var(--success); margin-top:8px;">${formatCurrency(totalCash)}</p>
          </div>
          <div class="card" style="text-align:center; border-left:5px solid #6366f1; background:linear-gradient(to right, #ffffff, #f5f3ff);">
            <p style="font-size:11px; color:var(--text-muted); font-weight:700; display:flex; align-items:center; justify-content:center; gap:4px;"><i data-lucide="crown" style="width:12px; color:#6366f1;"></i> PROVEEDOR ESTRELLA</p>
            <p style="font-size:18px; font-weight:900; color:#6366f1; margin-top:10px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" title="${topSupplierName}">${topSupplierName}</p>
          </div>
        </div>

        <div class="supplier-grid">
          <!-- ADD / EDIT FORM -->
          <div class="card">
            <h3 style="font-size:16px; font-weight:700; margin-bottom:15px; color:#1e293b;">
              ${state.editingSupplier ? 'Editar Proveedor' : 'Nuevo Proveedor'}
            </h3>
            <form id="supplier-form" onsubmit="window.handleSupplierSubmit(event)" style="display:flex; flex-direction:column; gap:12px;">
              <div>
                <label style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; display:block; margin-bottom:4px;">Nombre del Proveedor</label>
                <input type="text" id="sup-name" class="form-input" placeholder="Ej. Distribuidora del Llano" 
                  value="${state.editingSupplier ? state.editingSupplier.name : ''}" required style="width:100%; height:45px;">
              </div>
              <div>
                <label style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; display:block; margin-bottom:4px;">Teléfono</label>
                <input type="tel" id="sup-phone" class="form-input" placeholder="Ej. 3101234567" 
                  value="${state.editingSupplier ? state.editingSupplier.phone : ''}" style="width:100%; height:45px;">
              </div>
              <div>
                <label style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; display:block; margin-bottom:4px;">Productos que Vende</label>
                <textarea id="sup-products" class="form-input" placeholder="Ej. Gaseosas, jugos, abarrotes" style="width:100%; height:80px; resize:none;">${state.editingSupplier ? state.editingSupplier.products_sold : ''}</textarea>
              </div>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                <div>
                  <label style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; display:block; margin-bottom:4px;">Deuda ($)</label>
                  <input type="number" id="sup-debt" class="form-input" placeholder="Ej. 50000" 
                    value="${state.editingSupplier ? state.editingSupplier.debt : '0'}" style="width:100%; height:45px;">
                </div>
                <div>
                  <label style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; display:block; margin-bottom:4px;">Compras de Contado ($)</label>
                  <input type="number" id="sup-cash" class="form-input" placeholder="Ej. 120000" 
                    value="${state.editingSupplier ? state.editingSupplier.cash_purchases : '0'}" style="width:100%; height:45px;">
                </div>
              </div>
              
              <div style="display:flex; gap:10px; margin-top:10px;">
                <button type="submit" class="btn-primary" style="flex:2; height:50px; border-radius:12px; font-size:14px; font-weight:700;">
                  ${state.editingSupplier ? 'ACTUALIZAR PROVEEDOR' : 'CREAR PROVEEDOR'}
                </button>
                ${state.editingSupplier ? `
                  <button type="button" onclick="state.editingSupplier=null;render()" class="btn-secondary" style="flex:1; height:50px; border-radius:12px; font-size:14px; font-weight:700;">CANCELAR</button>
                ` : ''}
              </div>
            </form>
          </div>

          <!-- LIST TABLE -->
          <div class="card" style="padding:0; overflow:hidden; min-width:0;">
            <div style="padding:20px; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center;">
              <h3 style="font-size:16px; font-weight:700; margin:0; color:#1e293b;">Proveedores Registrados</h3>
            </div>
            <!-- DESKTOP VIEW: ANALYTICAL TABLE -->
            <div class="desktop-supplier-table" style="overflow-x:auto;">
              <table style="width:100%; border-collapse:collapse; font-size:13px;">
                <thead style="background:#f8fafc; color:var(--text-muted); text-align:left;">
                  <tr>
                    <th style="padding:15px; border-bottom:1px solid #f1f5f9;">Proveedor</th>
                    <th style="padding:15px; border-bottom:1px solid #f1f5f9;">Productos</th>
                    <th style="padding:15px; border-bottom:1px solid #f1f5f9; text-align:right;">Contado</th>
                    <th style="padding:15px; border-bottom:1px solid #f1f5f9; text-align:right;">Deuda</th>
                    <th style="padding:15px; border-bottom:1px solid #f1f5f9; text-align:center;">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  ${(state.suppliers || []).length === 0 ? '<tr><td colspan="5" style="padding:40px; text-align:center; color:var(--text-muted);">Sin proveedores registrados</td></tr>' : (state.suppliers || []).map((s, idx) => `
                    <tr style="border-bottom:1px solid #f1f5f9;">
                      <td style="padding:15px;">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                          <div>
                            <p style="font-weight:700; color:#1e293b; margin:0;">${s.name}</p>
                            <p style="font-size:11px; color:var(--text-muted); margin-top:2px; display:flex; align-items:center; gap:4px;"><i data-lucide="phone" style="width:10px;"></i> ${s.phone || 'Sin número'}</p>
                          </div>
                          ${s.phone ? `
                            <a href="https://wa.me/57${s.phone.replace(/\D/g, '')}?text=${encodeURIComponent('Hola ' + s.name + ', te saludamos desde J&M. Nos gustaría coordinar un pedido de mercancía para nuestro inventario. ¿Nos podrías confirmar disponibilidad? Quedamos atentos. ¡Muchas gracias!')}" target="_blank" style="background:#22c55e; color:white; padding:5px 10px; border-radius:20px; font-size:10px; font-weight:800; display:inline-flex; align-items:center; gap:4px; text-decoration:none; box-shadow:0 4px 6px -1px rgba(34,197,94,0.3); transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
                              <i data-lucide="message-circle" style="width:12px; height:12px;"></i> PEDIR
                            </a>
                          ` : ''}
                        </div>
                      </td>
                      <td style="padding:15px; font-size:12px; color:#475569; max-width:180px; overflow:hidden; text-overflow:ellipsis;">
                        ${s.products_sold || 'Varios'}
                      </td>
                      <td style="padding:15px; text-align:right; font-weight:700; color:var(--success);">
                        ${formatCurrency(s.cash_purchases || 0)}
                      </td>
                      <td style="padding:15px; text-align:right; font-weight:700; color:${(s.debt || 0) > 0 ? 'var(--danger)' : '#64748b'};">
                        ${formatCurrency(s.debt || 0)}
                      </td>
                      <td style="padding:15px; text-align:center;">
                        <div style="display:flex; justify-content:center; gap:8px;">
                          <button onclick="window.openSupplierLedger('${idx}')" class="icon-btn" title="Historial de Facturas y Deudas" style="background:rgba(13,148,136,0.1); color:#0d9488; width:32px; height:32px; border-radius:8px;"><i data-lucide="file-text" style="width:14px;"></i></button>
                          <button onclick="window.editSupplier('${idx}')" class="icon-btn" title="Editar" style="background:rgba(59,130,246,0.1); color:var(--primary); width:32px; height:32px; border-radius:8px;"><i data-lucide="edit-2" style="width:14px;"></i></button>
                          <button onclick="window.deleteSupplier('${idx}')" class="icon-btn" title="Eliminar" style="background:rgba(239,68,68,0.1); color:var(--danger); width:32px; height:32px; border-radius:8px;"><i data-lucide="trash-2" style="width:14px;"></i></button>
                        </div>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <!-- MOBILE VIEW: PREMIUM TOUCH CARDS -->
            <div class="mobile-supplier-cards">
              ${(state.suppliers || []).length === 0 ? `
                <div style="padding:40px; text-align:center; color:var(--text-muted); background:#f8fafc; border-radius:16px; border:1px dashed #cbd5e1;">Sin proveedores registrados</div>
              ` : (state.suppliers || []).map((s, idx) => `
                <div class="card" style="background:#ffffff; border:1px solid #e2e8f0; border-radius:20px; padding:20px; display:flex; flex-direction:column; gap:12px; box-shadow:0 4px 6px -1px rgba(0,0,0,0.01), 0 2px 4px -1px rgba(0,0,0,0.02);">
                  
                  <!-- Header: Info & WhatsApp Button -->
                  <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
                    <div style="flex:1;">
                      <p style="font-weight:800; font-size:16px; color:#0f172a; margin:0; line-height:1.2;">${s.name}</p>
                      <p style="font-size:13px; color:var(--text-muted); margin-top:6px; display:flex; align-items:center; gap:6px;"><i data-lucide="phone" style="width:12px; height:12px;"></i> ${s.phone || 'Sin teléfono'}</p>
                    </div>
                    ${s.phone ? `
                      <a href="https://wa.me/57${s.phone.replace(/\D/g, '')}?text=${encodeURIComponent('Hola ' + s.name + ', te saludamos desde J&M. Nos gustaría coordinar un pedido de mercancía para nuestro inventario. ¿Nos podrías confirmar disponibilidad? Quedamos atentos. ¡Muchas gracias!')}" target="_blank" style="background:#22c55e; color:white; padding:8px 14px; border-radius:25px; font-size:11px; font-weight:850; display:inline-flex; align-items:center; gap:6px; text-decoration:none; box-shadow:0 4px 12px rgba(34,197,94,0.25); flex-shrink:0;">
                        <i data-lucide="message-circle" style="width:14px; height:14px;"></i> PEDIR
                      </a>
                    ` : ''}
                  </div>

                  <!-- Sub: Products Tag View -->
                  <div style="background:#f8fafc; padding:12px; border-radius:12px; font-size:13px; color:#475569; line-height:1.5; border:1px solid #f1f5f9;">
                    <span style="font-weight:800; font-size:10px; color:#94a3b8; text-transform:uppercase; display:block; margin-bottom:4px; letter-spacing:0.5px;">Productos que suministra</span>
                    ${s.products_sold || 'Varios'}
                  </div>

                  <!-- Grid: Financial Summary -->
                  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; padding-top:8px;">
                    <div style="background:rgba(16,185,129,0.03); padding:10px; border-radius:10px; border:1px solid rgba(16,185,129,0.1);">
                      <span style="font-size:10px; color:#10b981; font-weight:800; text-transform:uppercase; letter-spacing:0.5px;">Compras Contado</span>
                      <p style="font-weight:800; color:var(--success); font-size:15px; margin-top:4px; margin-bottom:0;">${formatCurrency(s.cash_purchases || 0)}</p>
                    </div>
                    <div style="background:${(s.debt || 0) > 0 ? 'rgba(239,68,68,0.03)' : 'rgba(100,116,139,0.03)'}; padding:10px; border-radius:10px; border:1px solid ${(s.debt || 0) > 0 ? 'rgba(239,68,68,0.1)' : 'rgba(100,116,139,0.1)'};">
                      <span style="font-size:10px; color:${(s.debt || 0) > 0 ? 'var(--danger)' : '#64748b'}; font-weight:800; text-transform:uppercase; letter-spacing:0.5px;">Deuda Activa</span>
                      <p style="font-weight:800; color:${(s.debt || 0) > 0 ? 'var(--danger)' : '#64748b'}; font-size:15px; margin-top:4px; margin-bottom:0;">${formatCurrency(s.debt || 0)}</p>
                    </div>
                  </div>

                  <!-- Actions Footer Area -->
                  <div style="display:flex; flex-direction:column; gap:10px; margin-top:8px; padding-top:15px; border-top:1px solid #f1f5f9;">
                    <button onclick="window.openSupplierLedger('${idx}')" class="btn-primary" style="background:#0d9488; font-size:12px; height:42px; font-weight:800; border-radius:12px; display:flex; align-items:center; justify-content:center; gap:6px; width:100%;"><i data-lucide="file-text" style="width:14px;"></i> 📋 VER FACTURAS Y DEUDAS</button>
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
                      <button onclick="window.editSupplier('${idx}')" class="btn-secondary" style="height:40px; font-size:12px; font-weight:800; border-radius:12px; display:flex; align-items:center; justify-content:center; gap:6px; background:#f1f5f9; border:none; color:#334155; width:100%;"><i data-lucide="edit-2" style="width:14px;"></i> EDITAR</button>
                      <button onclick="window.deleteSupplier('${idx}')" class="btn-secondary" style="height:40px; font-size:12px; font-weight:800; border-radius:12px; display:flex; align-items:center; justify-content:center; gap:6px; background:#fef2f2; border:none; color:var(--danger); width:100%;"><i data-lucide="trash-2" style="width:14px;"></i> BORRAR</button>
                    </div>
                  </div>

                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  else if (state.view === 'byod_dashboard') {
    // 1. Computar cuántos colaboradores están FUERA DE SEDE en este preciso momento
    const currentActiveSignals = {};
    (state.byodHeartbeats || []).forEach(hb => {
      if (!currentActiveSignals[hb.user_id]) {
        currentActiveSignals[hb.user_id] = hb;
      }
    });

    let totalOutside = 0;
    Object.values(currentActiveSignals).forEach(hb => {
      const activeShift = (state.byodActiveShifts || []).find(s => s.user_id === hb.user_id);
      const biz = activeShift?.businesses || (state.businesses || []).find(b => b.id === activeShift?.business_id);
      
      if (hb.lat && hb.lng && biz && biz.lat && biz.lng) {
        const distMeters = window.getDistanceInMeters(hb.lat, hb.lng, biz.lat, biz.lng);
        const maxRadius = biz.geofence_radius_meters || 100;
        if (distMeters > maxRadius) {
          totalOutside++;
        }
      }
    });

    html = `
      <style>
        @keyframes pulse-alert-red {
          0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6); transform: scale(1); }
          50% { transform: scale(1.05); }
          70% { box-shadow: 0 0 0 15px rgba(239, 68, 68, 0); }
          100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); transform: scale(1); }
        }
        @keyframes pulse-alert-green {
          0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.5); }
          70% { box-shadow: 0 0 0 12px rgba(16, 185, 129, 0); }
          100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
        }
        .pulse-alert-red { animation: pulse-alert-red 1.5s infinite; }
        .pulse-alert-green { animation: pulse-alert-green 2.5s infinite; }
        
        @keyframes marker-pulse-red {
          0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
          70% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
          100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
        }
        
        #byod-leaflet-map {
          border-bottom-right-radius: 24px;
          border-bottom-left-radius: 24px;
          z-index: 1;
        }
        
        /* Arreglo Leaflet panes z-index */
        .leaflet-pane { z-index: 1 !important; }
        .leaflet-top, .leaflet-bottom { z-index: 2 !important; }

        @media (max-width: 992px) {
          .byod-dashboard-grid {
            grid-template-columns: 1fr !important;
          }
        }
      </style>

      <header class="main-header" style="background:#0f172a; color:white; border-bottom: 1px solid #1e293b;">
        <div class="logo-container">
          <div class="logo-icon" style="background:rgba(255,255,255,0.1);"><i data-lucide="shield-check" style="color:#10b981;"></i></div>
          <div class="header-title">
            <p class="role-tag" style="background:#10b981; color:white;">BYOD SECURE</p>
            <h1 style="color:white;">Centro de Monitoreo Táctico</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="window.fetchByodDashboard()" class="btn-secondary" style="background:rgba(255,255,255,0.1); border-color:#334155; color:white; border-radius:12px;"><i data-lucide="refresh-cw" style="width:14px; margin-right:5px;"></i> ACTUALIZAR</button>
          <div onclick="state.view='manager_dashboard';render()" class="icon-btn pill" style="background:rgba(255,255,255,0.1); color:white; border:none; cursor:pointer; border-radius:12px;">Regresar</div>
        </div>
      </header>

      <div class="container" style="max-width:1300px; margin-top:30px; padding-bottom:80px;">
        
        <!-- 🚨 BANNER DE ESTADO MAESTRO -->
        <div style="display:flex; align-items:center; gap:20px; padding:22px 25px; border-radius:20px; margin-bottom:30px; 
            background:${totalOutside > 0 ? '#fef2f2' : '#ecfdf5'}; 
            border:2px solid ${totalOutside > 0 ? '#fca5a5' : '#a7f3d0'};
            box-shadow: 0 10px 25px -5px ${totalOutside > 0 ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.08)'}; transition: all 0.3s ease;">
            
          <div class="${totalOutside > 0 ? 'pulse-alert-red' : 'pulse-alert-green'}" style="
              width:48px; height:48px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0;
              background:${totalOutside > 0 ? '#ef4444' : '#10b981'}; color:white; border:3px solid white; box-shadow:0 4px 12px rgba(0,0,0,0.1);">
            <i data-lucide="${totalOutside > 0 ? 'shield-alert' : 'shield-check'}" style="width:24px;"></i>
          </div>
          
          <div style="flex:1;">
            <h2 style="font-size:18px; font-weight:900; color:${totalOutside > 0 ? '#991b1b' : '#065f46'}; margin:0;">
              ${totalOutside > 0 ? `🚨 ¡ALERTA CRÍTICA! ${totalOutside} Colaborador(es) fuera de rango` : '🟢 SISTEMA SEGURO: Todo el personal dentro de sede'}
            </h2>
            <p style="font-size:13px; color:${totalOutside > 0 ? '#b91c1c' : '#047857'}; margin-top:2px; font-weight:600; opacity:0.9;">
              ${totalOutside > 0 ? 'Abandono de geoperímetro detectado en tiempo real. Verifique el mapa interactivo.' : 'Monitoreo en vivo activo. Geocercas satelitales 100% operativas.'}
            </p>
          </div>
        </div>

        <div style="display:grid; grid-template-columns: 1fr 2.2fr; gap:30px; align-items:start;" class="byod-dashboard-grid">
          
          <!-- 📊 COLUMNA IZQUIERDA: SCORES Y CONFIGURACIONES -->
          <div style="display:flex; flex-direction:column; gap:25px;">
            
            <!-- 🔔 TARJETA CONFIGURACIÓN TELEGRAM -->
            <div class="card" style="padding:25px; border-radius:22px; background:#0f172a; color:white; border:none; box-shadow:0 15px 30px -10px rgba(15,23,42,0.3);">
              <h3 style="font-size:16px; font-weight:900; color:white; margin:0 0 15px 0; display:flex; align-items:center; gap:8px;">
                <i data-lucide="send" style="width:18px; color:#38bdf8;"></i> ALERTAS EN TU CELULAR
              </h3>
              
              <div style="background:rgba(56,189,248,0.08); padding:15px; border-radius:14px; font-size:11px; line-height:1.6; color:#bae6fd; margin-bottom:20px; border:1px dashed rgba(56,189,248,0.25);">
                 <p style="margin:0 0 8px 0; font-weight:800; color:white; font-size:12px; display:flex; align-items:center; gap:5px;"><i data-lucide="lightbulb" style="width:13px; color:#f59e0b;"></i> Instrucciones de Configuración:</p>
                 1. Abre Telegram en tu celular y busca el bot: <b>@userinfobot</b>.<br>
                 2. Inicia conversación y copia tu número de <b>Id</b>.<br>
                 3. Pégalo abajo. ¡Empezarás a recibir notificaciones de inmediato!
              </div>

              <form onsubmit="window.saveTelegramConfig(event)" style="display:flex; flex-direction:column; gap:18px;">
                <input type="hidden" name="bot_token" value="${state.byodTelegramConfig?.botToken || '8037545998:AAH4zgAxhoNbZ1WKJXmCElwq7oHzi7IJ1LY'}">
                <div class="form-group" style="margin:0;">
                  <label style="color:#94a3b8; font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; display:block;">Tu Chat ID de Telegram</label>
                  <div style="position:relative; display:flex; align-items:center;">
                    <i data-lucide="user" style="position:absolute; left:12px; width:16px; color:#64748b;"></i>
                    <input type="text" name="chat_id" class="form-input" style="background:#1e293b; color:white; border:1px solid #334155; border-radius:12px; padding-left:38px; font-weight:800; font-size:14px; width:100%;" required placeholder="Escribe tu ID aquí..." value="${state.byodTelegramConfig?.chatId || ''}">
                  </div>
                </div>
                <button class="btn-primary" style="width:100%; background:#0284c7; border:none; border-radius:12px; display:flex; align-items:center; justify-content:center; gap:8px; font-size:12px; font-weight:800; padding:12px 0; cursor:pointer; box-shadow:0 4px 12px rgba(2,132,199,0.3); transition:background 0.2s;"><i data-lucide="check-circle" style="width:15px;"></i> VINCULAR MI CELULAR</button>
              </form>
            </div>

            <!-- SCORES -->
            <div class="card" style="padding:25px; border-radius:22px;">
              <h3 style="font-size:15px; font-weight:800; margin:0 0 20px 0; display:flex; align-items:center; gap:8px; color:#334155;">
                <i data-lucide="award" style="width:16px; color:#6366f1;"></i> RANKING DE CUMPLIMIENTO
              </h3>
              
              <div style="display:flex; flex-direction:column; gap:15px;">
                ${(state.byodScores || []).length === 0 ? '<p style="text-align:center; font-size:12px; color:var(--text-muted); padding:20px;">Calculando índices...</p>' : state.byodScores.slice(0, 6).map(scoreItem => {
                  const pct = parseFloat(scoreItem.score || 100).toFixed(1);
                  let color = '#10b981';
                  if (pct < 85) color = '#f59e0b';
                  if (pct < 70) color = '#ef4444';
                  
                  const scoreUser = state.employees?.find(e => e.id === scoreItem.user_id) || (state.user?.id === scoreItem.user_id ? state.user : null);
                  
                  return `
                    <div style="background:#f8fafc; border:1px solid #e2e8f0; padding:12px 15px; border-radius:14px; display:flex; align-items:center; justify-content:space-between;">
                      <div>
                        <p style="font-weight:800; font-size:13px; color:#1e293b; margin:0;">${scoreUser?.name || 'Colaborador'}</p>
                        <p style="font-size:11px; color:#64748b; margin-top:2px;">Incidencias: ${scoreItem.incidents_count || 0}</p>
                      </div>
                      <div style="text-align:right;">
                        <span style="font-size:16px; font-weight:900; color:${color}">${pct}%</span>
                        <div style="width:70px; height:5px; background:#e2e8f0; border-radius:3px; overflow:hidden; margin-top:4px;">
                          <div style="width:${pct}%; height:100%; background:${color}; border-radius:3px;"></div>
                        </div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>

          </div>

          <!-- 📡 COLUMNA DERECHA: MAPA E INCIDENCIAS -->
          <div style="display:flex; flex-direction:column; gap:25px;">
            
            <!-- 🗺️ MAPA SATELITAL LEAFLET -->
            <div class="card" style="padding:0; overflow:hidden; border-radius:24px; box-shadow:0 10px 25px -5px rgba(0,0,0,0.05); position:relative; border: 1px solid #e2e8f0;">
              <div style="padding:20px 25px; background:#ffffff; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                <h3 style="margin:0; font-size:16px; font-weight:900; color:#1e293b; display:flex; align-items:center; gap:8px;">
                   <i data-lucide="navigation" style="width:18px; color:#3b82f6;"></i> SEGUIMIENTO SATELITAL EN VIVO
                </h3>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                  <div id="byod-live-badge" style="display:flex; align-items:center; gap:6px; background:#fff1f2; border:1px solid #fecdd3; color:#be123c; padding:5px 12px; border-radius:30px; font-size:11px; font-weight:850; text-transform:uppercase; letter-spacing:0.5px;">
                    <span style="width:7px; height:7px; border-radius:50%; background:#ef4444; display:inline-block; animation: pulse-alert-red 1.2s infinite;"></span>
                    EN VIVO · <span id="byod-live-counter">—</span>
                  </div>
                  <button onclick="window.pickCoordinatesOnMap()" class="btn-primary" style="background:#0284c7; padding:5px 12px; font-size:11px; font-weight:800; border:none; border-radius:12px; display:flex; align-items:center; gap:5px;"><i data-lucide="map-pin" style="width:12px;"></i> UBICAR NEGOCIO AQUÍ</button>
                  <div style="display:flex; align-items:center; gap:6px; background:#ecfdf5; border:1px solid #a7f3d0; color:#047857; padding:5px 12px; border-radius:30px; font-size:11px; font-weight:850; text-transform:uppercase; letter-spacing:0.5px;">
                    <span style="width:7px; height:7px; border-radius:50%; background:#10b981; display:inline-block; animation: pulse-alert-green 1.5s infinite;"></span>
                    Geocercas Activas
                  </div>
                </div>
              </div>
              
              <!-- DIV CONTENEDOR DE LEAFLET MAP -->
              <div id="byod-leaflet-map" style="height:450px; width:100%; background:#f8fafc;"></div>
            </div>

            <!-- 🕒 BITÁCORA CRONOLÓGICA DE CAJA NEGRA -->
            <div class="card" style="padding:25px; border-radius:24px; border: 1px solid #e2e8f0;">
              <h3 style="font-size:16px; font-weight:900; color:#1e293b; margin:0 0 25px 0; display:flex; align-items:center; gap:8px;">
                <i data-lucide="history" style="width:18px; color:#475569;"></i> REGISTROS DE CAJA NEGRA (BITÁCORA CRÍTICA)
              </h3>
              
              <div style="display:flex; flex-direction:column; gap:20px; position:relative; padding-left:25px; border-left:2px solid #f1f5f9; max-height:400px; overflow-y:auto;">
                ${(state.byodSecurityLogs || []).length === 0 ? `
                  <div style="padding:40px 20px; text-align:center; color:#94a3b8; font-size:12px; background:#fafafa; border-radius:16px; border:1px dashed #e2e8f0;">
                    <i data-lucide="shield-check" style="width:32px; color:#cbd5e1; margin-bottom:10px;"></i>
                    <p style="margin:0;">Ningún incidente registrado en el ciclo operativo actual.</p>
                  </div>
                ` : state.byodSecurityLogs.map(log => {
                  let logText = 'Actividad de Seguridad';
                  const isCritical = log.severity === 'CRITICAL';
                  try {
                    const parsed = JSON.parse(log.message);
                    logText = parsed.text || 'Alerta de seguridad';
                  } catch(e) { logText = log.message; }

                  const logTime = new Date(log.timestamp);
                  const timeStr = logTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                  const dateStr = logTime.toLocaleDateString([], {day: '2-digit', month:'short'});

                  return `
                    <div style="position:relative;">
                      <!-- Indicador flotante en línea de tiempo -->
                      <span style="position:absolute; left:-34px; top:2px; width:16px; height:16px; border-radius:50%; 
                          background:${isCritical ? '#fee2e2' : '#ecfdf5'}; 
                          border:3px solid ${isCritical ? '#ef4444' : '#10b981'}; 
                          display:inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.05);"></span>
                      
                      <div style="background:#ffffff; border:1px solid #edf2f7; padding:14px 18px; border-radius:16px; display:flex; justify-content:space-between; align-items:center; gap:15px; box-shadow:0 2px 4px rgba(0,0,0,0.01);">
                        <div style="flex:1;">
                          <p style="font-size:12.5px; font-weight:800; color:#1e293b; margin:0; line-height:1.4;">${logText}</p>
                          <p style="font-size:10.5px; color:#64748b; margin-top:4px; font-weight:700; display:flex; align-items:center; gap:5px;">
                            <i data-lucide="clock" style="width:11px; color:#94a3b8;"></i> ${dateStr}, ${timeStr}
                            <span style="color:#e2e8f0;">|</span>
                            <span style="color:#94a3b8; font-weight:600;">${log.module || 'Sistema'}</span>
                          </p>
                        </div>
                        <span style="font-size:9.5px; font-weight:900; text-transform:uppercase; letter-spacing:0.5px; padding:5px 12px; border-radius:20px; 
                            background:${isCritical ? '#fee2e2' : '#f1f5f9'}; 
                            color:${isCritical ? '#b91c1c' : '#475569'}; flex-shrink:0; border:1px solid ${isCritical ? '#fca5a5' : '#e2e8f0'};">
                          ${isCritical ? '🚨 ALERTA' : 'ℹ️ REGISTRO'}
                        </span>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>

          </div>

        </div>
      </div>
    `;
  }

  else if (state.view === 'sales_history_admin') {
    html = renderSalesHistory(state, formatCurrency);
  }

  else if (state.view === 'business_reports') {
    const selectedBusId = state.selectedReportsBusinessId || 'all';
    const selectedBusName = selectedBusId === 'all' ? 'Todos los Negocios' : (state.businesses.find(b => b.id === selectedBusId)?.name || 'Negocio');

    const now = new Date();
    
    // Filtros de Periodos
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const weekStart = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);

    const trx = state.transactions.filter(t => selectedBusId === 'all' || t.business_id === selectedBusId);

    const dailyTrx = trx.filter(t => new Date(t.date) >= todayStart);
    const weeklyTrx = trx.filter(t => new Date(t.date) >= weekStart);
    const monthlyTrx = trx.filter(t => new Date(t.date) >= monthStart);

    const calc = (list) => {
      const inc = list.filter(t => t.type === 'income').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
      const exp = list.filter(t => t.type === 'expense').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
      return { inc, exp, bal: inc - exp };
    };

    const getBreakdown = (list) => {
      const pmList = ['Efectivo', 'Addi', 'Sistecredito', 'Llano Gas'];
      const breakdown = {};
      pmList.forEach(m => {
        breakdown[m] = list.filter(t => t.type === 'income' && (
          (t.note && t.note.includes(`[Forma de Pago: ${m}]`)) || 
          (t.description && t.description.includes(`[Forma de Pago: ${m}]`)) ||
          (m === 'Efectivo' && !t.note?.includes('[Forma de Pago:') && !t.description?.includes('[Forma de Pago:'))
        )).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
      });
      return breakdown;
    };

    const day = calc(dailyTrx);
    const week = calc(weeklyTrx);
    const month = calc(monthlyTrx);

    const dayPM = getBreakdown(dailyTrx);
    const weekPM = getBreakdown(weeklyTrx);
    const monthPM = getBreakdown(monthlyTrx);

    // 📈 LÓGICA DE PUNTO DE EQUILIBRIO Y UTILIDAD REAL (Requerimiento de 137.000 para Baratillo)
    const isBaratillo = selectedBusId === 'ec292ea5-5cfd-44d8-8b1c-e093cb719492';
    
    const getRealUtility = (startTime, endTime) => {
      let revenue = 0;
      let cost = 0;
      // Filtrar ventas en el periodo de tiempo
      const periodSales = state.sales.filter(s => {
        const t = new Date(s.created_at).getTime();
        return t >= startTime && t <= endTime;
      });
      
      periodSales.forEach(s => {
        const items = state.saleItems.filter(si => si.sale_id === s.id);
        const bizIdsFromProducts = items.map(i => i.products?.business_id).filter(Boolean);
        const saleShortId = s.id.slice(0, 5);
        const bizIdsFromTransactions = state.transactions.filter(t => t.note && t.note.includes(saleShortId)).map(t => t.business_id);
        const allBizIds = [...new Set([...bizIdsFromProducts, ...bizIdsFromTransactions])];
        
        if (allBizIds.length === 0) {
          const sellerObj = state.employees?.find(emp => emp.id === s.user_id) || (state.user?.id === s.user_id ? state.user : null);
          if (sellerObj?.business_id) allBizIds.push(sellerObj.business_id);
        }
        
        if (selectedBusId === 'all' || allBizIds.includes(selectedBusId)) {
          revenue += parseFloat(s.total) || 0;
          items.forEach(i => {
            let pCost = parseFloat(i.products?.cost) || 0;
            if (!i.products) {
              const linkedProd = state.products.find(p => p.id === i.product_id);
              if (linkedProd) pCost = parseFloat(linkedProd.cost) || 0;
            }
            cost += (pCost * (Number(i.quantity) || 1));
          });
        }
      });

      const expenses = state.transactions.filter(t => {
        if (t.type !== 'expense') return false;
        if (selectedBusId !== 'all' && t.business_id !== selectedBusId) return false;
        const tTime = new Date(t.date || t.created_at).getTime();
        return tTime >= startTime && tTime <= endTime;
      }).reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);

      return revenue - cost - expenses;
    };

    const dayUtil = getRealUtility(todayStart.getTime(), now.getTime());
    const weekUtil = getRealUtility(weekStart.getTime(), now.getTime());
    const monthUtil = getRealUtility(monthStart.getTime(), now.getTime());

    // Obtener ahorro real en Alcancía desde los cierres de caja
    const getSavingsForPeriod = (startTime, endTime) => {
      const filteredClosures = state.cashClosures.filter(c => {
        const cTime = new Date(c.created_at).getTime();
        const inRange = cTime >= startTime && cTime <= endTime;
        if (!inRange) return false;
        if (selectedBusId !== 'all' && c.business_id !== selectedBusId) return false;
        return true;
      });
      return filteredClosures.reduce((s, c) => s + (parseFloat(c.savings_amount) || 0), 0);
    };

    const daySavings = getSavingsForPeriod(todayStart.getTime(), now.getTime());
    const weekSavings = getSavingsForPeriod(weekStart.getTime(), now.getTime());
    const monthSavings = getSavingsForPeriod(monthStart.getTime(), now.getTime());

    const dayTarget = 137000;
    const weekTarget = 137000 * 7;
    const monthTarget = 137000 * now.getDate();

    const renderBreakEvenStatus = (savings, target, utility) => {
      if (!isBaratillo) return '';
      const diff = savings - target;
      const isGreen = diff >= 0;
      return `
        <div style="margin-top:15px; padding:12px; border-radius:12px; background:${isGreen ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)'}; border:1px solid ${isGreen ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}; display:flex; flex-direction:column; gap:5px;">
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px;">
            <span style="font-weight:700; color:#cbd5e1;">💰 Guardado en Alcancía:</span>
            <span style="font-family:monospace; font-weight:900; color:${isGreen ? '#34d399' : '#f87171'};">${formatCurrency(savings)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px;">
            <span style="font-weight:700; color:#cbd5e1;">🎯 Meta de Ahorro:</span>
            <span style="font-family:monospace; font-weight:800;">${formatCurrency(target)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px;">
            <span style="font-weight:700; color:#94a3b8;">📈 Utilidad en Ventas:</span>
            <span style="font-family:monospace; font-weight:800; color:#38bdf8;">${formatCurrency(utility)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; margin-top:2px; font-weight:850; text-transform:uppercase;">
            <span>Estado Ahorro:</span>
            <span style="color:${isGreen ? '#34d399' : '#f87171'}; font-size:12px; font-weight:900;">
              ${isGreen ? `🟢 BIEN (+${formatCurrency(diff)})` : `🔴 NÚMEROS ROJOS / MAL (${formatCurrency(diff)})`}
            </span>
          </div>
        </div>
      `;
    };

    html = `
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon"><img src="logo_v3.png" alt="Logo"></div>
          <div class="header-title">
            <p class="role-tag">Reportes Avanzados</p>
            <h1>Análisis por Negocio</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="state.view='app';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px;">VOLVER</button>
        </div>
      </header>

      <div class="container" style="padding-top:20px;">
        <div class="card" style="padding:15px; margin-bottom:20px;">
          <label style="font-size:12px; font-weight:700; color:var(--text-muted); display:block; margin-bottom:8px;">SELECCIONAR NEGOCIO</label>
          <select onchange="state.selectedReportsBusinessId=this.value;window.render()" class="form-input" style="width:100%;">
            <option value="all" ${selectedBusId === 'all' ? 'selected' : ''}>📊 Todos los Negocios</option>
            ${state.businesses.map(b => `<option value="${b.id}" ${selectedBusId === b.id ? 'selected' : ''}>🏢 ${b.name}</option>`).join('')}
          </select>
        </div>

        <div style="display:flex; flex-direction:column; gap:20px; margin-bottom:30px;">
          <!-- DIARIO -->
          <div class="card" style="background:linear-gradient(135deg, #1e293b 0%, #0f172a 100%); color:white; border:none; padding:25px; border-radius:24px; box-shadow:0 10px 25px rgba(0,0,0,0.1); position:relative; overflow:hidden;">
            <div style="position:absolute; right:-20px; bottom:-20px; opacity:0.05; font-size:120px; font-weight:800; pointer-events:none;">HOY</div>
            <h3 style="font-size:14px; text-transform:uppercase; letter-spacing:1px; opacity:0.8; margin-bottom:5px; color:#38bdf8;">Reporte Diario</h3>
            <p style="font-size:11px; opacity:0.6; margin-bottom:15px;">Periodo: 24 Horas Recientes</p>
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">
              <div style="background:rgba(255,255,255,0.05); padding:15px; border-radius:16px; border:1px solid rgba(255,255,255,0.1);">
                <p style="font-size:11px; color:#34d399; font-weight:600; text-transform:uppercase;">Ingresos</p>
                <h4 style="font-size:20px; font-weight:800; margin:4px 0; color:#34d399;">+ ${formatCurrency(day.inc)}</h4>
              </div>
              <div style="background:rgba(255,255,255,0.05); padding:15px; border-radius:16px; border:1px solid rgba(255,255,255,0.1);">
                <p style="font-size:11px; color:#f87171; font-weight:600; text-transform:uppercase;">Egresos</p>
                <h4 style="font-size:20px; font-weight:800; margin:4px 0; color:#f87171;">- ${formatCurrency(day.exp)}</h4>
              </div>
            </div>
            
            <div style="margin-top:15px; padding-top:15px; border-top:1px solid rgba(255,255,255,0.1); display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:12px; font-weight:600; opacity:0.8;">Ganancia Neta</span>
              <span style="font-size:22px; font-weight:900; color:${day.bal >= 0 ? '#34d399' : '#f87171'};">${formatCurrency(day.bal)}</span>
            </div>

            <!-- Breakdown por Forma de Pago -->
            <div style="margin-top:15px; padding-top:15px; border-top:1px dashed rgba(255,255,255,0.15); display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              ${Object.entries(dayPM).map(([m, val]) => `
                <div style="font-size:12px; display:flex; justify-content:space-between; opacity:0.9;">
                  <span>${m}:</span>
                  <span style="font-weight:800; color:#38bdf8;">${formatCurrency(val)}</span>
                </div>
              `).join('')}
            </div>

            ${renderBreakEvenStatus(daySavings, dayTarget, dayUtil)}
          </div>

          <!-- SEMANAL -->
          <div class="card" style="background:linear-gradient(135deg, #0d9488 0%, #115e59 100%); color:white; border:none; padding:25px; border-radius:24px; box-shadow:0 10px 25px rgba(0,0,0,0.1); position:relative; overflow:hidden;">
            <div style="position:absolute; right:-20px; bottom:-20px; opacity:0.05; font-size:120px; font-weight:800; pointer-events:none;">SEM</div>
            <h3 style="font-size:14px; text-transform:uppercase; letter-spacing:1px; opacity:0.8; margin-bottom:5px; color:#99f6e4;">Reporte Semanal</h3>
            <p style="font-size:11px; opacity:0.6; margin-bottom:15px;">Periodo: Últimos 7 Días</p>
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">
              <div style="background:rgba(255,255,255,0.05); padding:15px; border-radius:16px; border:1px solid rgba(255,255,255,0.1);">
                <p style="font-size:11px; color:#34d399; font-weight:600; text-transform:uppercase;">Ingresos</p>
                <h4 style="font-size:20px; font-weight:800; margin:4px 0; color:#34d399;">+ ${formatCurrency(week.inc)}</h4>
              </div>
              <div style="background:rgba(255,255,255,0.05); padding:15px; border-radius:16px; border:1px solid rgba(255,255,255,0.1);">
                <p style="font-size:11px; color:#f87171; font-weight:600; text-transform:uppercase;">Egresos</p>
                <h4 style="font-size:20px; font-weight:800; margin:4px 0; color:#f87171;">- ${formatCurrency(week.exp)}</h4>
              </div>
            </div>
            
            <div style="margin-top:15px; padding-top:15px; border-top:1px solid rgba(255,255,255,0.1); display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:12px; font-weight:600; opacity:0.8;">Ganancia Neta</span>
              <span style="font-size:22px; font-weight:900; color:${week.bal >= 0 ? '#34d399' : '#f87171'};">${formatCurrency(week.bal)}</span>
            </div>

            <!-- Breakdown por Forma de Pago -->
            <div style="margin-top:15px; padding-top:15px; border-top:1px dashed rgba(255,255,255,0.15); display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              ${Object.entries(weekPM).map(([m, val]) => `
                <div style="font-size:12px; display:flex; justify-content:space-between; opacity:0.9;">
                  <span>${m}:</span>
                  <span style="font-weight:800; color:#2dd4bf;">${formatCurrency(val)}</span>
                </div>
              `).join('')}
            </div>

            ${renderBreakEvenStatus(weekSavings, weekTarget, weekUtil)}
          </div>

          <!-- MENSUAL -->
          <div class="card" style="background:linear-gradient(135deg, #1e1b4b 0%, #311042 100%); color:white; border:none; padding:25px; border-radius:24px; box-shadow:0 10px 25px rgba(0,0,0,0.1); position:relative; overflow:hidden;">
            <div style="position:absolute; right:-20px; bottom:-20px; opacity:0.05; font-size:120px; font-weight:800; pointer-events:none;">MES</div>
            <h3 style="font-size:14px; text-transform:uppercase; letter-spacing:1px; opacity:0.8; margin-bottom:5px; color:#c084fc;">Reporte Mensual</h3>
            <p style="font-size:11px; opacity:0.6; margin-bottom:15px;">Periodo: Mes en curso</p>
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">
              <div style="background:rgba(255,255,255,0.05); padding:15px; border-radius:16px; border:1px solid rgba(255,255,255,0.1);">
                <p style="font-size:11px; color:#34d399; font-weight:600; text-transform:uppercase;">Ingresos</p>
                <h4 style="font-size:20px; font-weight:800; margin:4px 0; color:#34d399;">+ ${formatCurrency(month.inc)}</h4>
              </div>
              <div style="background:rgba(255,255,255,0.05); padding:15px; border-radius:16px; border:1px solid rgba(255,255,255,0.1);">
                <p style="font-size:11px; color:#f87171; font-weight:600; text-transform:uppercase;">Egresos</p>
                <h4 style="font-size:20px; font-weight:800; margin:4px 0; color:#f87171;">- ${formatCurrency(month.exp)}</h4>
              </div>
            </div>
            
            <div style="margin-top:15px; padding-top:15px; border-top:1px solid rgba(255,255,255,0.1); display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:12px; font-weight:600; opacity:0.8;">Ganancia Neta</span>
              <span style="font-size:22px; font-weight:900; color:${month.bal >= 0 ? '#34d399' : '#f87171'};">${formatCurrency(month.bal)}</span>
            </div>

            <!-- Breakdown por Forma de Pago -->
            <div style="margin-top:15px; padding-top:15px; border-top:1px dashed rgba(255,255,255,0.15); display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              ${Object.entries(monthPM).map(([m, val]) => `
                <div style="font-size:12px; display:flex; justify-content:space-between; opacity:0.9;">
                  <span>${m}:</span>
                  <span style="font-weight:800; color:#c084fc;">${formatCurrency(val)}</span>
                </div>
              `).join('')}
            </div>

            ${renderBreakEvenStatus(monthSavings, monthTarget, monthUtil)}
          </div>
        </div>
      </div>
    `;
  }


  else {
    // Filtro de negocio: Respetar lo decidido en fetchData (que ya prioriza turnos)
    const currentBusId = state.currentBusinessId;

    // Los colaboradores solo ven transacciones de tipo 'income' (ventas) asociadas a su id
    const trx = state.transactions.filter(t => 
      (currentBusId === 'all' || t.business_id === currentBusId) && 
      (state.user?.role === 'admin' ? true : (t.user_id === state.user?.id && t.type === 'income'))
    );
    
    // A. Detectar turno activo para sincronización inteligente en colaboradores
    const now = new Date();
    const activeUserShift = (state.user?.role !== 'admin') ? (state.shifts || []).find(s => {
      const isUserMatch = s.user_id === state.user?.id;
      const sStart = new Date(s.start_time);
      const sEnd = new Date(s.end_time);
      return isUserMatch && now >= new Date(sStart.getTime() - 60 * 60 * 1000) && now <= new Date(sEnd.getTime() + 60 * 60 * 1000);
    }) : null;

    // Filtro de fecha LOCAL (Evita problemas de medianoche UTC)
    const getLocalDate = (d) => new Date(d).toLocaleDateString('en-CA'); // Retorna YYYY-MM-DD en hora local
    const todayStr = getLocalDate(now);
    
    const timeFilteredTrx = trx.filter(t => {
      if (state.timeFilter === 'daily') {
        const isToday = getLocalDate(t.date) === todayStr;
        if (!isToday) return false;
        
        // --- Lógica dinámica de Turnos basada en Cierres de Caja ---
        const activeBus = state.businesses?.find(b => b.id === state.currentBusinessId);
        if (activeBus && activeBus.name.toLowerCase().includes('baratillo')) {
          const todayClosures = (state.cashClosures || [])
            .filter(c => c.business_id === activeBus.id && c.date === todayStr)
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            
          if (todayClosures.length > 0) {
            const latestClosure = todayClosures[todayClosures.length - 1];
            // Solo mostramos transacciones hechas DESPUÉS del último cierre
            return new Date(t.created_at).getTime() > new Date(latestClosure.created_at).getTime();
          }
        }
        
        if (activeUserShift) {
          // Si hay turno activo, filtrar transacciones ocurridas a partir del inicio de este turno
          return new Date(t.date) >= new Date(activeUserShift.start_time);
        }
        return true;
      }
      
      const tDate = new Date(t.date);
      if (state.timeFilter === 'monthly') return tDate.getMonth() === now.getMonth() && tDate.getFullYear() === now.getFullYear();
      if (state.timeFilter === 'weekly') return (now - tDate) <= (7 * 24 * 60 * 60 * 1000);
      return true;
    });

    const totalIncome = timeFilteredTrx.filter(t => t.type === 'income').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    const totalExpense = timeFilteredTrx.filter(t => t.type === 'expense').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    const profit = totalIncome - totalExpense;

    html = `
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon">
            <img src="logo_v3.png" alt="Logo">
          </div>
          <div class="header-title">
            <p class="role-tag">${state.user?.role === 'admin' ? 'ADMIN' : 'COLABORADOR'}</p>
            <h1>J&M</h1>
          </div>
        </div>
        <div class="header-actions">
          <div style="display:flex; gap:8px; padding-right:10px; border-right:1px solid #e2e8f0; margin-right:5px;">
            ${state.user?.role === 'admin' ? `
              <div onclick="state.view='manager_dashboard';window.render()" class="icon-btn" title="Gerencia"><i data-lucide="trending-up"></i></div>
              <div onclick="state.view='business_reports';window.render()" class="icon-btn" title="Reportes por Negocio"><i data-lucide="bar-chart-2"></i></div>
            ` : ''}
            <div onclick="window.fetchData()" class="icon-btn"><i data-lucide="refresh-cw"></i></div>
          </div>
          <div onclick="window.handleLogout()" class="icon-btn pill logout"><i data-lucide="log-out"></i> Salir</div>
        </div>
      </header>

      <div class="container">
        <div class="card" style="background: linear-gradient(135deg, var(--primary) 0%, #0f172a 100%); color: white; border: none; padding: 32px; position: relative; overflow: hidden; margin-bottom:20px;">
          <div style="position: absolute; top: -20px; right: -20px; font-size: 120px; opacity: 0.05; font-weight: 800; pointer-events: none;">G&C</div>
          
          ${state.user?.role === 'admin' ? `
            <p style="opacity: 0.8; font-size: 13px; font-weight: 600;">BALANCE TURNO ACTUAL</p>
            <h2 style="font-size: 38px; font-weight: 800; margin: 10px 0;">${formatCurrency(profit)}</h2>
            <div class="pill" style="background:rgba(16,185,129,0.2); border:1.5px solid rgba(16,185,129,0.5); font-size:12px; padding:10px 18px; display:inline-flex; align-items:center; gap:8px; border-radius:12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
              <span style="width:10px; height:10px; border-radius:50%; background:#10b981; box-shadow: 0 0 8px #10b981;"></span>
              <span style="color:#34d399; font-weight:900; letter-spacing:1.5px; font-size:13px; text-shadow: 0 0 4px rgba(52,211,153,0.3);">ADMINISTRADOR</span>
            </div>
          ` : `
            <p style="opacity: 0.8; font-size: 13px; font-weight: 600; text-transform: uppercase;">
              ${state.timeFilter === 'daily' ? (activeUserShift ? 'TOTAL VENDIDO EN ESTE TURNO' : 'TOTAL VENDIDO HOY') : state.timeFilter === 'weekly' ? 'TOTAL VENDIDO ESTA SEMANA' : 'TOTAL VENDIDO ESTE MES'}
            </p>
            <h2 style="font-size: 38px; font-weight: 800; margin: 10px 0; color: #ffffff;">${formatCurrency(totalIncome)}</h2>
            <div class="pill" style="background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); font-size:12px; padding:8px 15px; display:inline-flex; align-items:center; gap:8px;">
              <span style="width:8px; height:8px; border-radius:50%; background:${state.currentBusinessId !== 'all' ? '#10b981' : '#f59e0b'};"></span>
              ${state.businesses.find(b => b.id === state.currentBusinessId)?.name || 'Sin local asignado'}
            </div>
          `}
          ${state.currentBusinessId === 'all' && state.user?.role !== 'admin' ? `<p style="font-size:10px; color:rgba(255,255,255,0.6); margin-top:5px; display:flex; align-items:center; gap:5px;"><i data-lucide="alert-circle" style="width:12px;"></i> Pide al Admin que te asigne un local o <a href="#" onclick="window.fetchData()" style="color:white; text-decoration:underline;">RECARGAR</a></p>` : ''}
        </div>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap:12px; margin-bottom:25px;">
          ${state.user?.role !== 'admin' ? `
            <button onclick="window.registerGeolocation('arrival')" class="btn-primary" 
              style="padding:15px; background:${state.hasActiveAttendance ? '#94a3b8' : '#10b981'}; opacity:${state.hasActiveAttendance ? '0.5' : '1'}; cursor:${state.hasActiveAttendance ? 'not-allowed' : 'pointer'};"
              ${state.hasActiveAttendance ? 'disabled' : ''}>
              📍 LLEGADA
            </button>
            <button onclick="window.registerGeolocation('departure')" class="btn-primary" 
              style="padding:15px; background:${!state.hasActiveAttendance ? '#94a3b8' : '#ef4444'}; opacity:${!state.hasActiveAttendance ? '0.5' : '1'}; cursor:${!state.hasActiveAttendance ? 'not-allowed' : 'pointer'};"
              ${!state.hasActiveAttendance ? 'disabled' : ''}>
              📍 SALIDA
            </button>
          ` : ''}
          <button onclick="window.openPos()" class="btn-primary" style="padding:15px; background:var(--secondary);">+ VENTA (POS)</button>
          <button onclick="state.activeModal='shopping_list';render()" class="btn-primary" style="padding:15px; background:#8b5cf6;">📋 POR TRAER</button>
          ${(state.user?.role === 'admin' || state.user?.is_cashier) ? `
            <button onclick="window.openModal('expense')" class="btn-primary" style="padding:15px;">+ GASTO</button>
          ` : ''}
          ${state.user?.is_cashier ? `
            <button onclick="window.openModal('cash_closure')" class="btn-primary" style="padding:15px; background:#0f766e;">💵 CIERRE CAJA</button>
          ` : ''}
          <button onclick="window.showShiftReport()" class="btn-primary" style="padding:15px; background:#475569;">📄 REPORTE POR VENDEDOR</button>
          ${(state.user?.role === 'admin' || state.user?.can_manage_inventory) ? `
            <button onclick="state.activeModal='new_product';render()" class="btn-primary" style="padding:15px; background:var(--primary);">+ NUEVO PROD</button>
            <button onclick="state.activeModal='add_inventory';render()" class="btn-primary" style="padding:15px; background:#10b981;">+ INVENTARIO</button>
            <button onclick="state.view='products_admin';render()" class="btn-primary" style="padding:15px; background:#475569;">📦 GESTIÓN INVENTARIO</button>
          ` : ''}
        </div>

        <div class="activity-section">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
            <h3 style="font-size:18px; font-weight:700;">${state.user?.role !== 'admin' && state.timeFilter === 'daily' && activeUserShift ? 'Ventas del Turno' : 'Actividad Reciente'}</h3>
            <select class="btn-secondary" style="padding:6px 12px; font-size:12px;" onchange="state.timeFilter=this.value;render()">
              <option value="daily" ${state.timeFilter==='daily'?'selected':''}>Hoy</option>
              <option value="weekly" ${state.timeFilter==='weekly'?'selected':''}>Semana</option>
            </select>
          </div>
          
          <div class="card" style="padding:10px;">
            ${timeFilteredTrx.length === 0 ? `<p style="text-align:center; padding:20px; color:var(--text-muted);">${state.user?.role !== 'admin' && state.timeFilter === 'daily' && activeUserShift ? 'Sin ventas registradas en este turno' : 'Sin movimientos'}</p>` : timeFilteredTrx.map(t=>`
              <div class="transaction-item" style="display:flex; justify-content:space-between; align-items:center; padding:12px; border-bottom:1px solid #f1f5f9;">
                <div style="display:flex; align-items:center; gap:12px;">
                  <div style="width:36px; height:36px; border-radius:10px; display:flex; align-items:center; justify-content:center; background:${t.type==='income'?'rgba(16,185,129,0.1)':'rgba(239,68,68,0.1)'}; color:${t.type==='income'?'var(--success)':'var(--danger)'}; font-size:18px;">
                    <i data-lucide="${t.type==='income'?'trending-up':'trending-down'}" style="width:20px;"></i>
                  </div>
                  <div>
                    <h4 style="margin:0;">${t.categories?.name || (t.type==='income'?'Venta':'Gasto')}</h4>
                    ${t.description ? `<p style="margin:2px 0 0 0; font-size:12px; color:#475569; font-weight:700;">📝 ${t.description}</p>` : ''}
                    <p style="margin:2px 0 0 0; font-size:11px; color:var(--text-muted);">${new Date(t.date).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</p>
                  </div>
                </div>
                <div style="font-weight:800; color:${t.type==='income'?'var(--success)':'var(--danger)'}">
                  ${t.type==='income' ? '+' : '-'}${formatCurrency(t.amount)}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  }

  // 10. MODALES GLOBALES
  const modalHtml = `
    ${state.activeModal === 'baratillo_sale' ? `
    <div class="modal-overlay">
      <div class="modal-card card" style="max-width:450px;">
        <div class="modal-close" onclick="state.activeModal=null;render()">✕</div>
        <h2 style="text-align:center; margin-bottom:20px;">Registrar Venta Directa</h2>
        ${state.user?.role !== 'admin' && !state.activeShiftBusinessId ? `
          <div style="text-align:center; padding:40px 20px;">
            <div style="font-size:50px; margin-bottom:20px;">🔒</div>
            <h3 style="color:var(--danger); font-size:18px; margin-bottom:10px;">Acceso Bloqueado</h3>
            <p style="color:#64748b; font-size:14px; line-height:1.6;">No tienes un turno activo asignado en este momento. Por favor, solicita a un administrador que te asigne un turno para poder registrar movimientos.</p>
            <button onclick="state.activeModal=null;render()" class="btn-primary" style="margin-top:25px; background:#64748b;">ENTENDIDO</button>
          </div>
        ` : `
          <form onsubmit="window.saveBaratilloSale(event)">
            <div class="form-group">
              <label>Descripción / Producto vendido</label>
              <input type="text" name="description" class="form-input" required placeholder="Ej: Licuadora oster">
            </div>
            <div class="form-group">
              <label>Precio Final ($)</label>
              <input type='text' inputmode='numeric' name="amount" class="form-input currency-input" required placeholder="Ej: 50000" min="0" step="any">
            </div>
            <div class="form-group">
              <label>Medio de Pago</label>
              <select name="payment_method" class="form-input" required>
                <option value="Efectivo">💵 Efectivo</option>
                <option value="Addi">💳 Addi</option>
                <option value="Sistecredito">💳 Sistecredito</option>
                <option value="Bonos Coopchipaque">🎟️ Bonos Coopchipaque</option>
                ${(() => {
                  const activeBus = state.businesses?.find(b => b.id === (state.activeShiftBusinessId || state.currentBusinessId));
                  return activeBus?.name?.toLowerCase().includes('baratillo')
                    ? `<option value="Daviplata">📱 Daviplata</option>`
                    : `<option value="Transferencia">🏦 Transferencia</option>`;
                })()}
                <option value="Llano Gas">🔥 Llano Gas</option>
              </select>
            </div>
            <button type="submit" class="btn-primary" style="width:100%; padding:15px; margin-top:10px;">CONFIRMAR VENTA</button>
          </form>
        `}
      </div>
    </div>
    ` : ''}
    ${state.activeModal === 'sale' || state.activeModal === 'expense' ? `
    <div class="modal-overlay">
      <div class="modal-card card" style="max-width:450px;">
        <div class="modal-close" onclick="state.activeModal=null;render()">✕</div>
        <h2>${state.activeModal === 'sale' ? 'Registrar Venta' : 'Registrar Gasto'}</h2>
        
        ${state.user?.role !== 'admin' && !state.activeShiftBusinessId ? `
          <div style="text-align:center; padding:40px 20px;">
            <div style="font-size:50px; margin-bottom:20px;">🔒</div>
            <h3 style="color:var(--danger); font-size:18px; margin-bottom:10px;">Acceso Bloqueado</h3>
            <p style="color:#64748b; font-size:14px; line-height:1.6;">No tienes un turno activo asignado en este momento. Por favor, solicita a un administrador que te asigne un turno para poder registrar movimientos.</p>
            <button onclick="state.activeModal=null;render()" class="btn-primary" style="margin-top:25px; background:#64748b;">ENTENDIDO</button>
          </div>
        ` : `
          <form onsubmit="${state.activeModal === 'expense' ? 'window.saveExpense(event)' : `window.saveTransaction(event, '${state.activeModal === 'sale' ? 'income' : 'expense'}')`}">
            ${state.user?.role === 'admin' ? `
              ${state.activeModal === 'sale' ? `
                <div class="form-group">
                  <label>Categoría</label>
                  <select id="modal-category-select" name="category" class="form-input" required onchange="window.updateModalBusinesses(this.value)">
                    <option value="">Selecciona categoría...</option>
                    ${state.categories.filter(c => c.type === 'income' && ['Venta', 'Arriendo'].includes(c.name)).map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
                  </select>
                </div>
                <div class="form-group">
                  <label>Negocio</label>
                  <select id="modal-business-select" name="business" class="form-input" required>
                    <option value="">Primero selecciona una categoría...</option>
                  </select>
                </div>
              ` : `
                <div class="form-group">
                  <label>Categoría</label>
                  <select id="modal-category-select" name="category" class="form-input" required onchange="window.updateModalBusinesses(this.value)">
                    <option value="">Selecciona categoría...</option>
                    ${state.categories.filter(c => c.type === 'expense').map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
                  </select>
                </div>
                <div class="form-group">
                  <label>Negocio</label>
                  <select id="modal-business-select" name="business" class="form-input" required>
                    <option value="">Primero selecciona una categoría...</option>
                  </select>
                </div>
              `}
            ` : `
              <!-- VISTA COLABORADOR: Auto-atribución por Turno Activo -->
              <div class="form-group">
                <label>Categoría</label>
                <select id="modal-category-select" name="category" class="form-input" required>
                  ${state.categories
                    .filter(c => c.type === (state.activeModal === 'sale' ? 'income' : 'expense') && (state.activeModal === 'sale' ? c.name === 'Venta' : true))
                    .map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label>Negocio (Automático)</label>
                <div class="form-input" style="background:#f1f5f9; border-color:#e2e8f0; color:#475569; font-weight:700; display:flex; align-items:center;">
                  🏢 ${state.businesses.find(b => b.id === state.activeShiftBusinessId)?.name || 'Negocio de Turno'}
                </div>
                <!-- Input oculto que lee el formulario al enviar -->
                <input type="hidden" name="business" value="${state.activeShiftBusinessId}">
              </div>
            `}
            <div class="form-group"><label>Monto</label><input type='text' inputmode='numeric' name="amount" class="form-input currency-input" placeholder="$ 0" required></div>
            ${state.activeModal === 'expense' ? `
              <div class="form-group">
                <label>Descripción / Motivo</label>
                <input type="text" name="description" class="form-input" placeholder="Ej: Compra de café, Pago de luz, Flete..." required>
              </div>
              <div class="form-group">
                <label>Foto de Comprobante</label>
                <input type="file" name="photo" class="form-input" accept="image/*" capture="environment" style="padding:10px;">
              </div>
            ` : ''}
            <div class="form-group">
              <label>Fecha y Hora (Automática)</label>
              <input type="text" class="form-input" style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.1); color:#94a3b8; cursor:not-allowed; opacity:0.7;" value="${new Date().toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}" readonly disabled>
            </div>
            <div style="display:flex; gap:10px; margin-top:20px;">
              <button class="btn-primary" style="flex:2;">GUARDAR</button>
              <button type="button" onclick="state.activeModal=null;render()" class="btn-primary" style="flex:1; background:#64748b;">VOLVER</button>
            </div>
          </form>
        `}
      </div>
    </div>` : ''}

    ${state.activeModal === 'pending_product' ? `
    <div class="modal-overlay">
      <div class="modal-card card" style="max-width:400px;">
        <div class="modal-close" onclick="state.activeModal=null;render()"><i data-lucide="x"></i></div>
        <h2>Venta No Registrada</h2>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:20px;">Registra lo que estás vendiendo para no perder el rastro del dinero.</p>
        <form onsubmit="window.saveQuickSale(event)">
          <div class="form-group">
            <label>Nombre del Producto</label>
            <input type="text" name="name" class="form-input" placeholder="Ej: Correa cuero" required>
          </div>
          ${(() => {
            const ab = state.businesses?.find(b => b.id === (state.activeShiftBusinessId || state.currentBusinessId));
            const jm = ab && (ab.name.toLowerCase().includes('j&m') || ab.name.toLowerCase().includes('j & m'));
            return jm ? `
            <div class="form-group">
              <label style="font-weight:700;">👤 Categoría de Género</label>
              <div style="display:flex; gap:8px;">
                <label style="flex:1; display:flex; align-items:center; gap:6px; padding:10px; background:#eff6ff; border:2px solid #bfdbfe; border-radius:10px; cursor:pointer; font-weight:600; font-size:13px;"><input type="radio" name="gender" value="hombre" required> 👨 Hombre</label>
                <label style="flex:1; display:flex; align-items:center; gap:6px; padding:10px; background:#fdf2f8; border:2px solid #fbcfe8; border-radius:10px; cursor:pointer; font-weight:600; font-size:13px;"><input type="radio" name="gender" value="mujer" required> 👩 Mujer</label>
                <label style="flex:1; display:flex; align-items:center; gap:6px; padding:10px; background:#f5f3ff; border:2px solid #ddd6fe; border-radius:10px; cursor:pointer; font-weight:600; font-size:13px;"><input type="radio" name="gender" value="unisex" required> ⚧️ Unisex</label>
              </div>
            </div>` : '';
          })()}
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
            <div class="form-group">
              <label>Precio Unitario</label>
              <input type='text' inputmode='numeric' name="price" class="form-input currency-input" placeholder="$ 0" required>
            </div>
            <div class="form-group">
              <label>Cantidad</label>
              <input type="number" name="quantity" class="form-input" value="1" required min="1">
            </div>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
            <div class="form-group">
              <label style="font-weight: 700; display: block; margin-bottom: 5px;">Forma de Pago</label>
              <select name="payment_method" class="form-input" required style="width:100%; height:40px; padding:5px 10px; border-radius:10px; font-size:13px; font-weight:700; background:white; border:1px solid #cbd5e1;">
                <option value="Efectivo">💵 Efectivo</option>
                <option value="Addi">💳 Addi</option>
                <option value="Sistecredito">💳 Sistecredito</option>
                <option value="Bonos Coopchipaque">🎟️ Bonos Coopchipaque</option>
                ${(() => {
                  const activeBus = state.businesses?.find(b => b.id === (state.activeShiftBusinessId || state.currentBusinessId));
                  return activeBus?.name?.toLowerCase().includes('baratillo')
                    ? `<option value="Daviplata">📱 Daviplata</option>`
                    : `<option value="Transferencia">🏦 Transferencia</option>`;
                })()}
                <option value="Llano Gas">🔥 Llano Gas</option>
              </select>
            </div>
            <div class="form-group">
              <label style="font-weight: 700; display: block; margin-bottom: 5px; color:#4f46e5;">🏷️ Descuento (COP)</label>
              <input type="number" name="discount" class="form-input" placeholder="0" min="0" style="height:40px; border-radius:10px;">
            </div>
          </div>
          <div class="form-group">
            <label style="font-size:12px; font-weight:600; color:var(--text-muted);">📷 Foto del Producto <span style="color:#64748b; font-weight:400;">(OPCIONAL - No es obligatoria)</span></label>
            <input type="file" name="photo" class="form-input" accept="image/*" style="padding:10px;">
          </div>
          <button class="btn-primary" style="width:100%; margin-top:20px; background:var(--secondary); display:flex; align-items:center; justify-content:center; gap:8px;"><i data-lucide="check-circle" style="width:18px;"></i> AGREGAR Y VENDER</button>
        </form>
      </div>
    </div>` : ''}
    ${state.activeModal === 'add_inventory' ? `
    <div class="modal-overlay">
      <div class="modal-card card" style="max-width:400px;">
        <div class="modal-close" onclick="state.activeModal=null;render()"><i data-lucide="x"></i></div>
        <h2>Cargar Inventario</h2>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:20px;">Registra la entrada de mercancía con sus costos para cuadrar inventario y utilidades.</p>
        <form onsubmit="window.saveInventoryIn(event)">
          <div class="form-group">
            <label>Producto</label>
            <select name="product_id" class="form-input" required onchange="window.updateInventoryInfo(this.value)">
              <option value="">Selecciona producto...</option>
              ${state.products.sort((a,b) => a.name.localeCompare(b.name)).map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
            </select>
            <div id="inventory-prod-info" style="font-size:11px; color:var(--primary); margin-top:5px; font-weight:600;"></div>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
            <div class="form-group">
              <label>Cantidad</label>
              <input type="number" name="quantity" class="form-input" placeholder="0" required min="1">
            </div>
            <div class="form-group">
              <label>Costo Unitario</label>
              <input type='text' inputmode='numeric' name="cost" class="form-input currency-input" placeholder="$ 0" required min="1">
            </div>
          </div>
          <div class="form-group">
            <label>Nota / Referencia (Opcional)</label>
            <input type="text" name="note" class="form-input" placeholder="Ej: Factura #123">
          </div>
          <button class="btn-primary" style="width:100%; margin-top:20px; display:flex; align-items:center; justify-content:center; gap:8px;"><i data-lucide="check-circle" style="width:18px;"></i> REGISTRAR ENTRADA</button>
        </form>
      </div>
    </div>` : ''}
    ${state.activeModal === 'new_product' ? (() => {
      const selP = state.fromPending && state.selectedPendingProductId ? state.pendingProducts.find(p => p.id === state.selectedPendingProductId) : null;
      return `
      <div class="modal-overlay">
        <div class="modal-card card" style="max-width:450px;">
          <div class="modal-close" onclick="state.activeModal=null; state.fromPending=false; state.selectedPendingProductId=null; render()"><i data-lucide="x"></i></div>
          <h2>Nuevo Producto Oficial</h2>
          <p style="font-size:12px; color:var(--text-muted); margin-bottom:20px;">Registra productos con trazabilidad completa de stock y costos.</p>
          <form onsubmit="window.saveNewProduct(event)">
            
            <div style="margin-bottom:20px; padding:15px; background:#f8fafc; border-radius:15px; border:1px dashed #cbd5e1;">
              <label style="display:flex; align-items:center; gap:10px; cursor:pointer; font-weight:700; font-size:13px; color:var(--primary);">
                <input type="checkbox" onchange="state.fromPending=this.checked; if(!this.checked) state.selectedPendingProductId=null; render()" ${state.fromPending?'checked':''}>
                Formalizar desde producto pendiente
              </label>
              ${state.fromPending ? `
                <div class="form-group" style="margin-top:15px;">
                  <label>Seleccionar Venta Informal</label>
                  <select name="pending_id" class="form-input" onchange="state.selectedPendingProductId=this.value; window.fillFromPending(this.value)" required>
                    <option value="">Selecciona producto vendido...</option>
                    ${state.pendingProducts.map(p => `<option value="${p.id}" ${state.selectedPendingProductId === p.id ? 'selected' : ''}>${p.name} (${formatCurrency(p.price)})</option>`).join('')}
                  </select>
                </div>
              ` : ''}
            </div>

            <div class="form-group">
              <label>Negocio / Sede</label>
              <select name="business_id" class="form-input" required>
                <option value="">Seleccionar sede...</option>
                ${state.businesses
                  .filter(b => !['Mi Primer Negocio', 'Mi Negocio Principal', 'Billar', 'Local ropa', 'Droguería', 'Restaurante'].includes(b.name))
                  .map(b => `<option value="${b.id}" ${state.currentBusinessId === b.id ? 'selected' : ''}>${b.name}</option>`).join('')}
              </select>
            </div>

            <div class="form-group">
              <label>Nombre del Producto</label>
              <input type="text" name="name" id="new-prod-name" value="${selP ? selP.name : ''}" class="form-input" placeholder="Ej: Camisa Polo XL" required>
            </div>

            <div class="form-group">
              <label>Proveedor Asociado (Opcional)</label>
              <select name="supplier_index" class="form-input" onchange="window.toggleNewSupplierField(this.value)">
                <option value="">(Ninguno / Sin Asignar)</option>
                <option value="NEW_SUPPLIER" style="font-weight:bold; color:var(--primary);">➕ + NUEVO PROVEEDOR EN EL ACTO...</option>
                ${(state.suppliers || []).map((sup, index) => `<option value="${index}">${sup.name}</option>`).join('')}
              </select>
            </div>

            <!-- Bloque para crear un proveedor rápido si no existe -->
            <div id="quick-supplier-block" style="display:none; padding:15px; border:1px solid #e2e8f0; border-radius:12px; background:#f8fafc; margin-top:-10px; margin-bottom:15px;">
              <p style="font-size:11px; font-weight:800; margin-bottom:10px; color:#475569; text-transform:uppercase; letter-spacing:0.5px;">📦 Registro Rápido de Proveedor</p>
              <div class="form-group" style="margin-bottom:10px;">
                <label style="font-size:11px; font-weight:600; margin-bottom:4px;">Nombre del Nuevo Proveedor</label>
                <input type="text" name="new_supplier_name" class="form-input" placeholder="Ej: Mayorista Principal S.A." style="height:38px;">
              </div>
              <div class="form-group" style="margin-bottom:0;">
                <label style="font-size:11px; font-weight:600; margin-bottom:4px;">Teléfono de Contacto (Opcional)</label>
                <input type="tel" name="new_supplier_phone" class="form-input" placeholder="Ej: 3210000000" style="height:38px;">
              </div>
            </div>
            
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
              <div class="form-group">
                <label>Precio de Venta</label>
                <input type='text' inputmode='numeric' name="price" id="new-prod-price" value="${selP ? selP.price : ''}" class="form-input currency-input" placeholder="$ 0" required min="1" oninput="window.updateMarginCalc()">
              </div>
              <div class="form-group">
                <label>Costo Base</label>
                <input type='text' inputmode='numeric' name="cost" id="new-prod-cost" class="form-input currency-input" placeholder="$ 0" required min="1" oninput="window.updateMarginCalc()">
              </div>
            </div>

            <div id="margin-badge" style="font-size:11px; font-weight:800; padding:8px; border-radius:8px; background:#f1f5f9; text-align:center; margin-bottom:15px; color:var(--text-muted);">
              Margen Estimado: 0%
            </div>

            ${(() => {
              const selBiz = state.businesses?.find(b => b.id === (state.currentBusinessId));
              const jmCheck = selBiz && (selBiz.name.toLowerCase().includes('j&m') || selBiz.name.toLowerCase().includes('j & m'));
              return jmCheck ? `
            <div class="form-group">
              <label style="font-weight:700;">👤 Categoría de Género</label>
              <div style="display:flex; gap:8px;">
                <label style="flex:1; display:flex; align-items:center; gap:6px; padding:10px; background:#eff6ff; border:2px solid #bfdbfe; border-radius:10px; cursor:pointer; font-weight:600; font-size:12px;"><input type="radio" name="gender" value="hombre"> 👨 Hombre</label>
                <label style="flex:1; display:flex; align-items:center; gap:6px; padding:10px; background:#fdf2f8; border:2px solid #fbcfe8; border-radius:10px; cursor:pointer; font-weight:600; font-size:12px;"><input type="radio" name="gender" value="mujer"> 👩 Mujer</label>
                <label style="flex:1; display:flex; align-items:center; gap:6px; padding:10px; background:#f5f3ff; border:2px solid #ddd6fe; border-radius:10px; cursor:pointer; font-weight:600; font-size:12px;"><input type="radio" name="gender" value="unisex"> ⚧️ Unisex</label>
              </div>
            </div>` : '';
            })()}

            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
              <div class="form-group">
                <label>Stock Inicial</label>
                <input type="number" name="stock" class="form-input" placeholder="0" required min="0" value="0">
              </div>
              <div class="form-group">
                <label>Stock Fijo / Ideal</label>
                <input type="number" name="purchase_price" class="form-input" placeholder="Ej: 10" required min="0" value="0">
              </div>
            </div>
            <p style="font-size:10px; color:var(--text-muted); margin-top:5px; margin-bottom:15px;">El stock fijo sirve para generar automáticamente la lista de compras semanal y rellenar faltantes.</p>
            
            <button class="btn-primary" style="width:100%; margin-top:10px; background:var(--secondary);">✅ REGISTRAR E INICIALIZAR</button>
          </form>
        </div>
      </div>`;
    })() : ''}

    ${state.activeModal === 'shopping_list' ? (() => {
      const pendingItems = (state.shoppingList || []).filter(item => item.status === 'pending');
      const completedItems = (state.shoppingList || []).filter(item => item.status === 'completed');
      
      return `
      <div class="modal-overlay">
        <div class="modal-card card" style="max-width:500px; max-height:85vh; display:flex; flex-direction:column; overflow:hidden;">
          <div class="modal-close" onclick="state.activeModal=null;render()"><i data-lucide="x"></i></div>
          
          <div style="padding:10px 0 15px 0; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; gap:10px;">
            <div>
              <h2 style="display:flex; align-items:center; gap:8px; margin:0;"><i data-lucide="shopping-cart" style="color:var(--primary);"></i> Lista de Compras</h2>
              <p style="font-size:12px; color:var(--text-muted); margin:5px 0 0 0;">Registra los productos que hacen falta traer para los locales.</p>
            </div>
            <button onclick="window.autoReplenishStock()" class="btn-primary" style="padding:6px 12px; font-size:11px; background:var(--primary); font-weight:bold; border:none; display:flex; align-items:center; gap:4px; height:auto; width:auto;" title="Generar automáticamente faltantes para completar el Stock Fijo">
              <i data-lucide="refresh-cw" style="width:12px;"></i> AUTO-RELLENAR
            </button>
          </div>

          <!-- CONTENEDOR CON SCROLL QUE ENGLOBA FORMULARIOS Y LISTADO -->
          <div style="flex:1; overflow-y:auto; padding:10px 0 0 0; display:flex; flex-direction:column; gap:15px;">
            <!-- FORMULARIO PARA AGREGAR ITEM -->
            <form onsubmit="window.saveShoppingItem(event)" style="padding-bottom:15px; border-bottom:1px solid #e2e8f0; display:grid; grid-template-columns: 2fr 1fr; gap:10px; align-items:end;">
              <div class="form-group" style="margin:0;">
                <label style="font-size:11px; font-weight:700;">Producto / Artículo</label>
                <input type="text" name="name" class="form-input" placeholder="Ej: Jabón de loza, Ganchos..." required style="height:38px; font-size:13px; padding:6px 12px;">
              </div>
              <div class="form-group" style="margin:0;">
                <label style="font-size:11px; font-weight:700;">Cant.</label>
                <input type="number" name="quantity" class="form-input" value="1" min="1" required style="height:38px; font-size:13px; padding:6px 12px;">
              </div>
              
              <div class="form-group" style="margin:0; grid-column: span 2;">
                <label style="font-size:11px; font-weight:700;">Local Destino</label>
                <select name="business_id" class="form-input" required style="height:38px; font-size:13px; padding:6px 12px;">
                  ${state.businesses
                    .filter(b => !['Mi Primer Negocio', 'Mi Negocio Principal', 'Billar', 'Local ropa', 'Droguería', 'Restaurante'].includes(b.name))
                    .map(b => `<option value="${b.id}" ${state.activeShiftBusinessId === b.id ? 'selected' : ''}>${b.name}</option>`).join('')}
                </select>
              </div>
              
              <button type="submit" class="btn-primary" style="grid-column: span 2; height:38px; font-size:13px; font-weight:700; display:flex; align-items:center; justify-content:center; gap:6px; background:var(--success);">
                <i data-lucide="plus-circle" style="width:16px;"></i> AGREGAR A LA LISTA
              </button>
            </form>

            <!-- SECCIÓN: RELLENAR POR VENTAS EN UN RANGO DE FECHAS -->
            <div style="padding: 12px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px;">
              <p style="font-size: 11px; font-weight: 800; color: #166534; text-transform: uppercase; margin-top: 0; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                📊 Rellenar por Ventas (Por Rango de Fechas)
              </p>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
                <div class="form-group" style="margin: 0;">
                  <label style="font-size: 10px; font-weight: 700; margin-bottom: 4px; color:#166534;">Fecha Inicio</label>
                  <input type="date" id="replenish-start-date" class="form-input" style="height: 32px; font-size: 12px; padding: 4px 8px; border-color:#bbf7d0;" value="${(() => {
                    const d = new Date();
                    d.setDate(d.getDate() - 7);
                    return d.toISOString().split('T')[0];
                  })()}">
                </div>
                <div class="form-group" style="margin: 0;">
                  <label style="font-size: 10px; font-weight: 700; margin-bottom: 4px; color:#166534;">Fecha Fin</label>
                  <input type="date" id="replenish-end-date" class="form-input" style="height: 32px; font-size: 12px; padding: 4px 8px; border-color:#bbf7d0;" value="${new Date().toISOString().split('T')[0]}">
                </div>
              </div>
              <button type="button" onclick="window.previewAndReplenishSold()" class="btn-primary" style="width: 100%; height: 34px; font-size: 12px; font-weight: 700; background: #16a34a; border: none; display: flex; align-items: center; justify-content: center; gap: 6px;">
                🔍 CONSULTAR Y AGREGAR VENDIDOS
              </button>
            </div>

            <!-- LISTADO DE ITEMS -->
            <div style="padding:15px 0;">
            
            <!-- Pendientes -->
            <h3 style="font-size:12px; font-weight:800; color:var(--text-muted); text-transform:uppercase; margin-bottom:10px; display:flex; align-items:center; gap:6px;">
              📌 Pendientes (${pendingItems.length})
            </h3>
            
            ${pendingItems.length === 0 ? `
              <p style="font-size:12px; color:var(--text-muted); font-style:italic; padding:10px 0 20px 0; text-align:center;">No hay productos pendientes por comprar.</p>
            ` : `
              <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:20px;">
                ${pendingItems.map(item => {
                  const isUserAdmin = state.user?.role === 'admin';
                  const bizName = item.businesses?.name || 'General';
                  const userName = item.users?.name || 'Usuario';
                  return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;">
                      <div style="display:flex; align-items:center; gap:10px;">
                        ${isUserAdmin ? `
                          <input type="checkbox" onchange="window.toggleShoppingItemStatus('${item.id}', 'completed')" style="width:16px; height:16px; cursor:pointer;" title="Marcar como comprado">
                        ` : `
                          <span style="font-size:14px; opacity:0.6;">⏳</span>
                        `}
                        <div>
                          <p style="font-weight:700; font-size:13px; margin:0; color:#1e293b;">${item.name} <span style="background:var(--primary); color:white; font-size:10px; font-weight:800; padding:2px 6px; border-radius:6px;">x${item.quantity}</span></p>
                          <p style="font-size:10px; color:var(--text-muted); margin:2px 0 0 0;">📍 Sede: <b>${bizName}</b> | Registró: <b>${userName}</b></p>
                        </div>
                      </div>
                      ${isUserAdmin ? `
                        <button onclick="window.deleteShoppingItem('${item.id}')" style="background:none; border:none; color:var(--danger); cursor:pointer; padding:4px;" title="Eliminar de la lista">
                          <i data-lucide="trash-2" style="width:16px;"></i>
                        </button>
                      ` : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            `}

            <!-- Comprados / Completados -->
            ${completedItems.length > 0 ? `
              <h3 style="font-size:12px; font-weight:800; color:var(--text-muted); text-transform:uppercase; margin-top:20px; margin-bottom:10px;">
                ✓ Comprados (${completedItems.length})
              </h3>
              <div style="display:flex; flex-direction:column; gap:8px; opacity:0.7;">
                ${completedItems.map(item => {
                  const isUserAdmin = state.user?.role === 'admin';
                  const bizName = item.businesses?.name || 'General';
                  return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:10px;">
                      <div style="display:flex; align-items:center; gap:10px;">
                        ${isUserAdmin ? `
                          <input type="checkbox" checked onchange="window.toggleShoppingItemStatus('${item.id}', 'pending')" style="width:16px; height:16px; cursor:pointer;" title="Desmarcar">
                        ` : `
                          <span style="font-size:14px; color:#10b981;">✓</span>
                        `}
                        <div>
                          <p style="font-weight:600; font-size:13px; margin:0; text-decoration:line-through; color:var(--text-muted);">${item.name} <span>x${item.quantity}</span></p>
                          <p style="font-size:10px; color:var(--text-muted); margin:2px 0 0 0;">📍 Sede: ${bizName}</p>
                        </div>
                      </div>
                      ${isUserAdmin ? `
                        <button onclick="window.deleteShoppingItem('${item.id}')" style="background:none; border:none; color:var(--danger); cursor:pointer; padding:4px;" title="Eliminar">
                          <i data-lucide="trash-2" style="width:16px;"></i>
                        </button>
                      ` : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            ` : ''}

          </div></div>

          <div style="padding:10px 0 0 0; border-top:1px solid #e2e8f0; text-align:right; flex-shrink:0;">
            <button onclick="state.activeModal=null;render()" class="btn-primary" style="background:#64748b; padding:8px 20px; font-size:12px;">CERRAR</button>
          </div>
        </div>
      </div>
      `;
    })() : ''}
    ${state.activeModal === 'edit_rate' ? `
    <div class="modal-overlay">
      <div class="modal-card card" style="max-width:400px;">
        <div class="modal-close" onclick="state.activeModal=null;state.editingRateUser=null;render()"><i data-lucide="x"></i></div>
        <h2>Configurar Pago por Hora</h2>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:20px;">Establece cuánto gana <b>${state.editingRateUser?.name}</b> por cada hora de trabajo finalizada.</p>
        <form onsubmit="window.saveRateModal(event)">
          <div class="form-group">
            <label>Tarifa por Hora (COP)</label>
            <input type="number" name="rate" class="form-input" value="${state.editingRateUser?.hourly_rate || 0}" required min="0" placeholder="$ 0">
          </div>
          <div style="display:flex; gap:10px; margin-top:20px;">
            <button class="btn-primary" style="flex:2;">GUARDAR TARIFA</button>
            <button type="button" onclick="state.activeModal=null;state.editingRateUser=null;render()" class="btn-primary" style="flex:1; background:#64748b;">CANCELAR</button>
          </div>
        </form>
      </div>
    </div>` : ''}

    ${state.activeModal === 'shift' ? `<div class="modal-overlay">
      <div class="modal-card card" style="max-width:400px;">
        <div class="modal-close" onclick="state.activeModal=null;state.editingShift=null;render()">✕</div>
        <h2>${state.editingShift ? 'Editar Turno' : 'Asignar Turno'}</h2>
        <form onsubmit="window.saveShift(event)">
          <div class="form-group">
            <label>COLABORADOR</label>
            <select name="user" id="shift-user" class="form-input" required>
              <option value="">Selecciona COLABORADOR...</option>
              ${state.employees.map(e => `<option value="${e.id}" ${state.editingShift?.user_id === e.id || state.selectedUserId === e.id ? 'selected' : ''}>${e.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Negocio (Operativo)</label>
            <select name="business" class="form-input" required>
              <option value="">Selecciona negocio operativo...</option>
              ${state.businesses.filter(b => b.type === 'operativo').map(b => {
                const isSelected = state.editingShift?.business_id === b.id || (!state.editingShift && state.employees.find(emp => emp.id === state.selectedUserId)?.business_id === b.id);
                return `<option value="${b.id}" ${isSelected ? 'selected' : ''}>${b.name}</option>`;
              }).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Hora Inicio</label>
            <input type="datetime-local" name="start" class="form-input" required value="${state.editingShift ? new Date(new Date(state.editingShift.start_time).getTime() - 5*60*60*1000).toISOString().slice(0,16) : (state.selectedDate ? new Date(new Date(state.selectedDate).setHours(8,0,0,0) - 5*60*60*1000).toISOString().slice(0,16) : '')}">
          </div>
          <div class="form-group">
            <label>Hora Fin</label>
            <input type="datetime-local" name="end" class="form-input" required value="${state.editingShift ? new Date(new Date(state.editingShift.end_time).getTime() - 5*60*60*1000).toISOString().slice(0,16) : (state.selectedDate ? new Date(new Date(state.selectedDate).setHours(18,0,0,0) - 5*60*60*1000).toISOString().slice(0,16) : '')}">
          </div>
          <button class="btn-primary" style="width:100%; margin-top:20px;">GUARDAR TURNO</button>
        </form>
      </div>
    </div>` : ''}

    ${state.activeModal === 'shift_report' ? `
    <div class="modal-overlay">
      <div class="modal-card card" style="max-width:420px; max-height:90vh; overflow-y:auto; background:#0f172a; color:white; border:1px solid rgba(255,255,255,0.1); border-radius:24px;">
        <div class="modal-close" onclick="state.activeModal=null;render()" style="background:rgba(255,255,255,0.1); color:white;">✕</div>
        <div style="text-align:center; padding:10px 0;">
          <h2 style="font-size:20px; font-weight:800; color:white;">Reporte por Vendedor</h2>
          <p style="font-size:12px; color:#38bdf8; font-weight:700; margin-top:4px; text-transform:uppercase; letter-spacing:0.5px;">👤 ${state.user?.name || 'Colaborador'}</p>
        </div>

        <div class="form-group" style="margin-bottom: 15px;">
          <label style="color:#94a3b8; font-size:11px; font-weight:700; text-transform:uppercase; display:block; margin-bottom:5px;">Rango de Tiempo</label>
          <select onchange="window.showShiftReport(this.value)" class="form-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white; border-radius:12px; font-size:13px; font-weight:600; width:100%;">
            <option value="daily" ${state.shiftReportTimeframe === 'daily' || !state.shiftReportTimeframe ? 'selected' : ''}>📅 Diario (Hoy)</option>
            <option value="weekly" ${state.shiftReportTimeframe === 'weekly' ? 'selected' : ''}>📅 Semanal (Últimos 7 Días)</option>
            <option value="monthly" ${state.shiftReportTimeframe === 'monthly' ? 'selected' : ''}>📅 Mensual (Mes Actual)</option>
          </select>
        </div>
        
        <div style="display:flex; flex-direction:column; gap:12px; padding:10px 0;">
          <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); padding:16px; border-radius:18px; display:flex; justify-content:space-between; align-items:center;">
            <div>
              <p style="font-size:11px; color:#38bdf8; font-weight:700; text-transform:uppercase;">Ventas Realizadas</p>
              <p style="font-size:11px; opacity:0.6; margin-top:2px; color:#94a3b8;">${state.shiftReportData?.count || 0} movimientos</p>
            </div>
            <p style="font-size:20px; font-weight:800; color:#ffffff;">+ ${formatCurrency(state.shiftReportData?.totalSales || 0)}</p>
          </div>

          <div style="background:rgba(56,189,248,0.08); border:1px dashed rgba(56,189,248,0.3); padding:18px; border-radius:18px; display:flex; justify-content:space-between; align-items:center; margin-top:5px;">
            <div style="display:flex; flex-direction:column;">
              <span style="font-size:12px; font-weight:700; color:#e2e8f0;">Total Vendido</span>
              <span style="font-size:10px; color:#94a3b8; margin-top:1px;">Rendimiento del vendedor</span>
            </div>
            <span style="font-size:22px; font-weight:900; color:#ffffff;">${formatCurrency(state.shiftReportData?.totalSales || 0)}</span>
          </div>
        </div>

        <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
          <button onclick="state.activeModal=null;render()" class="btn-primary" style="background:#334155; border:none; padding:15px; color:#f1f5f9; border-radius:16px; font-weight:700; font-size:14px;">CONFIRMAR Y CERRAR</button>
        </div>
      </div>
    </div>` : ''}

    ${state.activeModal === 'cash_closure' ? (() => {
      const closureDateStr = new Date().toLocaleDateString('en-CA');
      const closureExpenses = state.transactions.filter(t => {
        if (t.type !== 'expense') return false;
        if (t.business_id !== state.selectedClosureBusinessId) return false;
        const tDate = new Date(t.date).toLocaleDateString('en-CA');
        return tDate === closureDateStr;
      });
      const totalClosureExpenses = closureExpenses.reduce((sum, e) => sum + Number(e.amount), 0);

      return `
      <div class="modal-overlay">
        <div class="modal-card card" style="max-width:450px; background:#0f172a; color:white; border:1px solid rgba(255,255,255,0.1); border-radius:24px; padding:25px; max-height:90vh; overflow-y:auto;">
          <div class="modal-close" onclick="state.activeModal=null;render()" style="background:rgba(255,255,255,0.1); color:white;">✕</div>
          
          <div style="text-align:center; padding:10px 0; margin-bottom:15px;">
            <h2 style="font-size:22px; font-weight:900; color:white; display:flex; align-items:center; justify-content:center; gap:8px;">
              💵 Cierre de Caja
            </h2>
            <p style="font-size:12px; color:#94a3b8; margin-top:4px;">Registro consolidado de ventas del día</p>
          </div>

          <form onsubmit="window.saveCashClosure(event)">
            ${state.user?.role === 'admin' ? `
              <div class="form-group" style="margin-bottom:12px;">
                <label style="color:#94a3b8; font-size:11px; font-weight:700;">Local / Sede</label>
                <select name="business_id" onchange="state.selectedClosureBusinessId = this.value; render()" class="form-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white;" required>
                  <option value="">Selecciona sede...</option>
                  ${state.businesses.map(b => `<option value="${b.id}" ${state.selectedClosureBusinessId === b.id ? 'selected' : ''}>${b.name}</option>`).join('')}
                </select>
              </div>
            ` : ''}

            <!-- 💸 DETALLE DE GASTOS DEL DÍA -->
            <div style="background:rgba(239,68,68,0.05); border:1px dashed rgba(239,68,68,0.2); padding:15px; border-radius:18px; margin-bottom:15px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <span style="font-size:11px; font-weight:700; color:#f87171; text-transform:uppercase; letter-spacing:0.5px;">💸 Gastos Registrados Hoy</span>
                <span style="font-size:16px; font-weight:800; color:#f87171;">-${formatCurrency(totalClosureExpenses)}</span>
              </div>
              ${closureExpenses.length === 0 ? `
                <p style="font-size:11px; color:#94a3b8; font-style:italic; margin:0; text-align:center; padding:5px 0;">No hay gastos registrados hoy para esta sede.</p>
              ` : `
                <div style="max-height:100px; overflow-y:auto; display:flex; flex-direction:column; gap:6px; margin-top:5px; padding-right:5px;">
                  ${closureExpenses.map((e, idx) => `
                    <div style="display:flex; justify-content:space-between; align-items:start; font-size:11px; padding:6px 8px; background:rgba(255,255,255,0.02); border-radius:8px; border:1px solid rgba(255,255,255,0.04);">
                      <div style="display:flex; flex-direction:column; max-width:70%;">
                        <span style="font-weight:700; color:#e2e8f0;">${idx + 1}. ${state.categories.find(c => c.id === e.category_id)?.name || 'Gasto General'}</span>
                        ${e.description ? `<span style="color:#94a3b8; font-size:10px; margin-top:1px;">📝 ${e.description}</span>` : ''}
                      </div>
                      <span style="font-weight:700; color:#f87171;">-${formatCurrency(e.amount)}</span>
                    </div>
                  `).join('')}
                </div>
              `}
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
              <div class="form-group">
                <label style="color:#94a3b8; font-size:11px; font-weight:700;">Efectivo Total Gaveta ($)</label>
                <input type='text' inputmode='numeric' name="cash_amount" class="form-input currency-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white;" required min="0" placeholder="0" value="0">
              </div>
              
              <div class="form-group">
                <label style="color:#38bdf8; font-size:11px; font-weight:700;">Base para día siguiente ($)</label>
                <input type='text' inputmode='numeric' name="next_day_base_amount" class="form-input currency-input" style="background:rgba(56,189,248,0.05); border:1px solid rgba(56,189,248,0.3); color:#38bdf8;" min="0" placeholder="0" value="0">
              </div>
              
              <div class="form-group">
                <label style="color:#94a3b8; font-size:11px; font-weight:700;">Daviplata ($)</label>
                <input type='text' inputmode='numeric' name="daviplata_amount" class="form-input currency-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white;" required min="0" placeholder="0" value="0">
              </div>

              <div class="form-group">
                <label style="color:#94a3b8; font-size:11px; font-weight:700;">Addi ($)</label>
                <input type='text' inputmode='numeric' name="addi_amount" class="form-input currency-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white;" required min="0" placeholder="0" value="0">
              </div>

              <div class="form-group">
                <label style="color:#94a3b8; font-size:11px; font-weight:700;">Sistecrédito ($)</label>
                <input type='text' inputmode='numeric' name="sistecredito_amount" class="form-input currency-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white;" required min="0" placeholder="0" value="0">
              </div>
            </div>

            <div class="form-group" style="margin-top:12px;">
              <label style="color:#94a3b8; font-size:11px; font-weight:700;">Nequi / Transferencia ($)</label>
              <input type='text' inputmode='numeric' name="nequi_amount" class="form-input currency-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white;" required min="0" placeholder="0" value="0">
            </div>

            <div class="form-group" style="margin-top:12px;">
              <label style="color:#94a3b8; font-size:11px; font-weight:700;">Bonos Coopchipaque ($)</label>
              <input type='text' inputmode='numeric' name="bonos_amount" class="form-input currency-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white;" required min="0" placeholder="0" value="0">
            </div>

            <!-- ➕ SECCIÓN DE GASTOS EXTRAS / ALCANCÍA -->
            <div style="border-top:1px dashed rgba(255,255,255,0.15); margin-top:15px; padding-top:15px;">
              <h4 style="font-size:12px; font-weight:800; color:#38bdf8; text-transform:uppercase; margin:0 0 12px 0; letter-spacing:0.5px; display:flex; align-items:center; gap:6px;">
                <span>➕ Egresos Extras / Ahorros</span>
              </h4>
              
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                <div class="form-group">
                  <label style="color:#94a3b8; font-size:11px; font-weight:700;">Otros Gastos ($)</label>
                  <input type='text' inputmode='numeric' name="other_expenses_amount" class="form-input currency-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white;" min="0" placeholder="0" value="0">
                </div>
                <div class="form-group">
                  <label style="color:#94a3b8; font-size:11px; font-weight:700;">Alcancía (Ahorro) ($)</label>
                  <input type='text' inputmode='numeric' name="savings_amount" class="form-input currency-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white;" min="0" placeholder="0" value="0">
                </div>
              </div>

              <div class="form-group" style="margin-top:8px;">
                <label style="color:#94a3b8; font-size:11px; font-weight:700;">Descripción Otros Gastos</label>
                <input type="text" name="other_expenses_description" class="form-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white;" placeholder="Ej: Transporte extra, tintos...">
              </div>

              <div class="form-group" style="margin-top:8px;">
                <label style="color:#94a3b8; font-size:11px; font-weight:700;">Descripción Alcancía / Ahorro</label>
                <input type="text" name="savings_description" class="form-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white;" placeholder="Ej: Ahorro diario para base...">
              </div>
            </div>

            <div class="form-group" style="margin-top:12px;">
              <label style="color:#94a3b8; font-size:11px; font-weight:700;">Observaciones / Novedades</label>
              <textarea name="observations" class="form-input" style="background:#1e293b; border:1px solid rgba(255,255,255,0.1); color:white; min-height:60px; resize:vertical;" placeholder="Escribe observaciones o diferencias detectadas..."></textarea>
            </div>

            <div style="display:flex; gap:10px; margin-top:20px;">
              <button class="btn-primary" style="flex:2; background:#0f766e; border:none; padding:12px; font-weight:700;">REGISTRAR CIERRE</button>
              <button type="button" onclick="state.activeModal=null;render()" class="btn-primary" style="flex:1; background:#475569; border:none; padding:12px; font-weight:700;">CANCELAR</button>
            </div>
          </form>
        </div>
      </div>
      `;
    })() : ''}

    ${state.activeModal === 'supplier_ledger' ? (() => {
      const s = state.suppliers[state.selectedSupplierIdx];
      if (!s) return '';
      const invoices = s.invoices || [];
      
      const totalPurchased = invoices.reduce((sum, i) => sum + i.total_amount, 0);
      const totalPaid = invoices.reduce((sum, i) => sum + (i.payments || []).reduce((s2, p) => s2 + p.amount, 0), 0);
      const remainingDebt = totalPurchased - totalPaid;
      
      return `
      <div class="modal-overlay">
        <div class="modal-card card" style="max-width:600px; padding: 25px; max-height: 90vh; overflow-y: auto; border-radius:24px;">
          <div class="modal-close" onclick="state.activeModal=null;render()">✕</div>
          
          <h2 style="margin-bottom:5px; font-weight:800;">📋 Historial: ${s.name}</h2>
          <p style="font-size:12px; color:var(--text-muted); margin-bottom:20px;">Control y tracking record de facturas y abonos.</p>
          
          <!-- RESUMEN CONTABLE -->
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:12px; margin-bottom:25px;">
            <div style="background:#f8fafc; border:1px solid #e2e8f0; padding:15px; border-radius:15px; text-align:center;">
              <p style="font-size:10px; color:#64748b; font-weight:800; text-transform:uppercase; letter-spacing:0.5px;">Facturado Total</p>
              <h3 style="font-size:18px; font-weight:900; color:#1e293b; margin-top:5px;">${formatCurrency(totalPurchased)}</h3>
            </div>
            <div style="background:rgba(16,185,129,0.05); border:1px solid rgba(16,185,129,0.2); padding:15px; border-radius:15px; text-align:center;">
              <p style="font-size:10px; color:#10b981; font-weight:800; text-transform:uppercase; letter-spacing:0.5px;">Abonado Total</p>
              <h3 style="font-size:18px; font-weight:900; color:#10b981; margin-top:5px;">${formatCurrency(totalPaid)}</h3>
            </div>
            <div style="background:${remainingDebt > 0 ? 'rgba(239,68,68,0.05)' : '#f8fafc'}; border:1px solid ${remainingDebt > 0 ? 'rgba(239,68,68,0.2)' : '#e2e8f0'}; padding:15px; border-radius:15px; text-align:center;">
              <p style="font-size:10px; color:${remainingDebt > 0 ? 'var(--danger)' : '#64748b'}; font-weight:800; text-transform:uppercase; letter-spacing:0.5px;">Deuda Total</p>
              <h3 style="font-size:18px; font-weight:900; color:${remainingDebt > 0 ? 'var(--danger)' : '#64748b'}; margin-top:5px;">${formatCurrency(remainingDebt)}</h3>
            </div>
          </div>

          <!-- SECCIÓN 1: REGISTRAR NUEVA COMPRA -->
          <div class="card" style="background:#f8fafc; padding:15px; margin-bottom:20px; border:1px dashed #cbd5e1;">
            <h4 style="font-size:13px; font-weight:800; color:#475569; margin-bottom:12px; display:flex; align-items:center; gap:6px;"><i data-lucide="plus-circle" style="width:16px; color:var(--primary);"></i> REGISTRAR COMPRA / FACTURA</h4>
            <form onsubmit="window.saveSupplierInvoice(event)" style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
              <div>
                <label style="font-size:10px; font-weight:700; color:#64748b;"># Número Factura</label>
                <input type="text" name="invoice_number" class="form-input" placeholder="Ej: FAC-203" required style="height:36px; font-size:12px; border-radius:8px;">
              </div>
              <div>
                <label style="font-size:10px; font-weight:700; color:#64748b;">Valor Gasto Factura ($)</label>
                <input type='text' inputmode='numeric' name="total_amount" class="form-input currency-input" placeholder="$ 0" required style="height:36px; font-size:12px; border-radius:8px;">
              </div>
              <div style="grid-column:span 2; display:flex; gap:10px; align-items:flex-end; margin-top:5px;">
                <div style="flex:1;">
                  <label style="font-size:10px; font-weight:700; color:#64748b;">Fecha Factura</label>
                  <input type="date" name="date" class="form-input" value="${new Date().toISOString().split('T')[0]}" required style="height:36px; font-size:12px; border-radius:8px;">
                </div>
                <button class="btn-primary" style="height:36px; font-size:12px; padding:0 20px; background:#0f172a; border-radius:8px;">+ REGISTRAR</button>
              </div>
            </form>
          </div>

          <!-- SECCIÓN 2: GENERADOR DE PDF -->
          <div style="display:flex; gap:10px; background:rgba(13,148,136,0.05); border:1px solid rgba(13,148,136,0.1); padding:15px; border-radius:12px; margin-bottom:25px; align-items:center; flex-wrap:wrap;">
            <div style="flex:1; min-width:120px;">
              <label style="font-size:10px; font-weight:700; color:#0d9488; display:block; margin-bottom:4px;">PDF Desde:</label>
              <input type="date" id="pdf-start-date" class="form-input" style="height:34px; font-size:12px; border-color:rgba(13,148,136,0.3); border-radius:8px;">
            </div>
            <div style="flex:1; min-width:120px;">
              <label style="font-size:10px; font-weight:700; color:#0d9488; display:block; margin-bottom:4px;">PDF Hasta:</label>
              <input type="date" id="pdf-end-date" class="form-input" style="height:34px; font-size:12px; border-color:rgba(13,148,136,0.3); border-radius:8px;" value="${new Date().toISOString().split('T')[0]}">
            </div>
            <button onclick="window.generateSupplierPdf()" class="btn-primary" style="background:#0d9488; height:34px; font-size:11px; font-weight:800; padding:0 15px; margin-top:15px; display:flex; align-items:center; gap:5px; border-radius:8px;"><i data-lucide="file-text" style="width:14px;"></i> GENERAR PDF</button>
          </div>

          <!-- LISTADO DETALLADO DE FACTURAS -->
          <h3 style="font-size:14px; font-weight:800; color:#475569; border-bottom:2px solid #f1f5f9; padding-bottom:8px; margin-bottom:15px; text-transform:uppercase; letter-spacing:0.5px;">Listado de Facturas (Track Record)</h3>
          <div style="display:flex; flex-direction:column; gap:15px;">
            ${invoices.length === 0 ? `
              <div style="text-align:center; color:var(--text-muted); font-size:13px; padding:30px; background:#f8fafc; border-radius:12px; border:1px dashed #cbd5e1;">Sin facturas registradas para este proveedor todavía.</div>
            ` : invoices.map(inv => {
              const paid = (inv.payments || []).reduce((acc, p) => acc + p.amount, 0);
              const debt = inv.total_amount - paid;
              
              return `
              <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; padding:16px; position:relative; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.02);">
                <!-- Encabezado Factura -->
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                  <div>
                    <span style="font-size:9px; font-weight:850; background:#f1f5f9; color:#64748b; padding:2px 8px; border-radius:20px; text-transform:uppercase; letter-spacing:0.5px;">Factura</span>
                    <h4 style="margin:5px 0 2px; font-size:16px; font-weight:900; color:#1e293b;"># ${inv.invoice_number}</h4>
                    <p style="margin:0; font-size:11px; color:#94a3b8; font-weight:700;">📅 Fecha: ${inv.date}</p>
                  </div>
                  <div style="text-align:right; display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
                    <button onclick="window.deleteSupplierInvoice('${inv.id}')" class="icon-btn" style="background:rgba(239,68,68,0.1); color:#ef4444; width:24px; height:24px; border-radius:6px;" title="Eliminar Registro"><i data-lucide="trash-2" style="width:12px;"></i></button>
                    <h4 style="margin:5px 0 0; font-size:16px; font-weight:800; color:#0f172a;">${formatCurrency(inv.total_amount)}</h4>
                  </div>
                </div>

                <!-- Abonos Grid -->
                ${(inv.payments || []).length > 0 ? `
                  <div style="background:#f8fafc; border-radius:10px; padding:8px 12px; margin-top:12px; border:1px solid #f1f5f9;">
                    <p style="font-size:9px; font-weight:800; color:#94a3b8; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">Abonos Realizados:</p>
                    ${inv.payments.map(p => `
                      <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:4px; color:#475569; font-weight:700;">
                        <span>↳ ${p.date}</span>
                        <span style="color:#10b981;">+ ${formatCurrency(p.amount)}</span>
                      </div>
                    `).join('')}
                  </div>
                ` : ''}

                <!-- Balance & Abono Form -->
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:15px; padding-top:12px; border-top:1px dashed #e2e8f0; flex-wrap:wrap; gap:10px;">
                  <div>
                    <p style="font-size:9px; color:#94a3b8; font-weight:800; text-transform:uppercase; margin:0; letter-spacing:0.5px;">Saldo Deudor Actual:</p>
                    <p style="font-size:16px; font-weight:900; margin:2px 0 0; color:${debt > 0 ? 'var(--danger)' : '#10b981'};">${debt > 0 ? formatCurrency(debt) : '✅ COMPLETADO'}</p>
                  </div>
                  
                  ${debt > 0 ? `
                    <form onsubmit="window.saveInvoicePayment(event, '${inv.id}')" style="display:flex; gap:6px; align-items:center; flex-wrap:nowrap;">
                      <input type='text' inputmode='numeric' name="payment_amount" class="form-input currency-input" placeholder="$ Abonar" required style="height:32px; font-size:11px; width:95px; padding:0 8px; border-color:#cbd5e1; border-radius:8px;">
                      <button class="btn-primary" style="height:32px; font-size:10px; font-weight:800; padding:0 12px; background:#10b981; border-radius:8px; text-transform:uppercase; letter-spacing:0.5px;">Abonar</button>
                    </form>
                  ` : ''}
                </div>
              </div>
              `;
            }).join('')}
          </div>
          
          <div style="margin-top:30px;">
            <button onclick="state.activeModal=null;render()" class="btn-primary" style="width:100%; background:#64748b; border-radius:12px; height:45px; font-weight:800;">CERRAR PANEL</button>
          </div>
        </div>
      </div>
      `;
    })() : ''}
    
    ${state.activeModal === 'new_business' ? `
    <div class="modal-overlay">
      <div class="modal-card card" style="max-width:400px;">
        <div class="modal-close" onclick="state.activeModal=null;render()"><i data-lucide="x"></i></div>
        <h2 style="display:flex; align-items:center; gap:8px; font-size:18px; font-weight:800;"><i data-lucide="plus-circle" style="color:var(--primary); width:20px;"></i> Nueva Sede Operativa</h2>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:20px;">Registra una nueva sucursal o modelo operativo en tu red.</p>
        <form onsubmit="window.saveNewBusiness(event)">
          <div class="form-group">
            <label style="font-size:11px; font-weight:700; color:#475569; text-transform:uppercase;">Nombre del Negocio / Sede</label>
            <input type="text" name="name" class="form-input" placeholder="Ej: J&M ROPA" required style="height:45px;">
          </div>
          <div class="form-group">
            <label style="font-size:11px; font-weight:700; color:#475569; text-transform:uppercase;">Tipo de Operación</label>
            <select name="type" class="form-input" required style="height:45px;">
              <option value="operativo">Negocio Operativo (POS, Stock, Turnos)</option>
              <option value="arriendo">Inmueble / Arriendo</option>
            </select>
          </div>
          <button class="btn-primary" style="width:100%; margin-top:10px; height:45px; font-weight:700; display:flex; align-items:center; justify-content:center; gap:8px;">💾 CREAR NEGOCIO AHORA</button>
        </form>
      </div>
    </div>` : ''}

    ${state.activeModal === 'collab_analytics' ? (() => {
      const empId = state.selectedCollabId;
      const emp = state.employees.find(e => e.id === empId) || (empId === state.user.id ? state.user : null);
      if (!emp) return '';

      // Obtener el año y mes seleccionado para el calendario
      if (state.collabCalendarYear === undefined) {
        const d = new Date();
        state.collabCalendarYear = d.getFullYear();
        state.collabCalendarMonth = d.getMonth();
      }
      
      const calYear = state.collabCalendarYear;
      const calMonth = state.collabCalendarMonth;
      
      const ventaCatId = state.categories.find(c => c.name === 'Venta' && c.type === 'income')?.id;

      // Filtrar transacciones del empleado
      const empTx = state.transactions.filter(t => {
        const isEmployee = (t.user_id === emp.id) || (emp.id === state.user.id && !t.user_id);
        const isSale = t.type === 'income' && (t.category_id === ventaCatId || t.description?.includes('Venta POS'));
        return isEmployee && isSale;
      });

      // Métricas clave del empleado (Totales del mes seleccionado)
      const monthPrefix = `${calYear}-${String(calMonth + 1).padStart(2, '0')}`;
      const monthTx = empTx.filter(t => t.date.startsWith(monthPrefix));

      const totalVendido = monthTx.reduce((sum, t) => sum + Number(t.amount), 0);
      const totalTransacciones = monthTx.length;
      const ticketPromedio = totalTransacciones > 0 ? totalVendido / totalTransacciones : 0;
      const maxTicket = totalTransacciones > 0 ? Math.max(...monthTx.map(t => Number(t.amount))) : 0;

      // Mapear ventas por día
      const salesByDay = {}; // día -> { count, total }
      monthTx.forEach(t => {
        const day = parseInt(t.date.split('-')[2], 10);
        if (!salesByDay[day]) salesByDay[day] = { count: 0, total: 0 };
        salesByDay[day].count += 1;
        salesByDay[day].total += Number(t.amount);
      });

      // Generar días del calendario
      const monthNames = [
        'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
        'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
      ];
      
      // Primer día del mes
      const firstDayDate = new Date(calYear, calMonth, 1);
      const startDayIndex = firstDayDate.getDay(); 
      const totalDays = new Date(calYear, calMonth + 1, 0).getDate();

      // Generar la grilla
      const calendarCells = [];
      for (let i = 0; i < startDayIndex; i++) {
        calendarCells.push(null);
      }
      for (let day = 1; day <= totalDays; day++) {
        calendarCells.push(day);
      }

      const selectedDay = state.collabSelectedCalDay || null;
      const dayTx = selectedDay ? monthTx.filter(t => parseInt(t.date.split('-')[2], 10) === selectedDay) : [];

      return `
      <div class="modal-overlay" style="display:flex; align-items:center; justify-content:center; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(15,23,42,0.6); backdrop-filter:blur(4px); z-index:9999; padding:20px; overflow-y:auto;">
        <div class="modal-card card" style="max-width:700px; width:100%; max-height:90vh; overflow-y:auto; padding:25px; border-radius:24px; position:relative; background:white; box-shadow:0 20px 40px rgba(0,0,0,0.15);">
          <div class="modal-close" onclick="state.activeModal=null;state.collabSelectedCalDay=null;render()" style="position:absolute; top:20px; right:20px; font-size:24px; cursor:pointer; color:#64748b; font-weight:bold; transition:all 0.15s;">✕</div>
          
          <!-- Header Perfil -->
          <div style="display:flex; align-items:center; gap:16px; margin-bottom:25px; border-bottom:1px solid #f1f5f9; padding-bottom:20px;">
            <div style="width:56px; height:56px; border-radius:50%; background:linear-gradient(135deg, var(--primary), var(--secondary)); color:white; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:20px; box-shadow:0 4px 10px rgba(59,130,246,0.2);">
              ${emp.name.substring(0, 2).toUpperCase()}
            </div>
            <div>
              <h2 style="margin:0; font-size:20px; color:#1f2937;">${emp.name}</h2>
              <p style="margin:0 0 4px 0; font-size:12px; color:#64748b;">${emp.email || 'Sin correo registrado'} · <span style="font-weight:700; color:var(--primary);">${emp.role?.toUpperCase() || 'COLABORADOR'}</span></p>
              <div style="display:flex; gap:6px;">
                <span style="font-size:10px; background:#f0fdf4; color:#16a34a; border:1px solid #bbf7d0; padding:2px 8px; border-radius:20px; font-weight:700;">
                  ${totalTransacciones > 10 ? '🔥 Vendedor Activo' : '👤 Colaborador'}
                </span>
                ${ticketPromedio > 200000 ? `
                  <span style="font-size:10px; background:#eff6ff; color:#2563eb; border:1px solid #bfdbfe; padding:2px 8px; border-radius:20px; font-weight:700;">
                    📈 Ticket Alto
                  </span>
                ` : ''}
              </div>
            </div>
          </div>

          <!-- Métricas Grid -->
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap:12px; margin-bottom:25px;">
            <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:16px; padding:15px; text-align:center;">
              <p style="margin:0 0 5px 0; font-size:11px; color:#64748b; font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">Venta del Mes</p>
              <h3 style="margin:0; font-size:18px; color:#10b981; font-weight:800;">${formatCurrency(totalVendido)}</h3>
            </div>
            <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:16px; padding:15px; text-align:center;">
              <p style="margin:0 0 5px 0; font-size:11px; color:#64748b; font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">Promedio x Venta</p>
              <h3 style="margin:0; font-size:18px; color:var(--primary); font-weight:800;">${formatCurrency(ticketPromedio)}</h3>
            </div>
            <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:16px; padding:15px; text-align:center;">
              <p style="margin:0 0 5px 0; font-size:11px; color:#64748b; font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">Transacciones</p>
              <h3 style="margin:0; font-size:18px; color:#4f46e5; font-weight:800;">${totalTransacciones}</h3>
            </div>
            <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:16px; padding:15px; text-align:center;">
              <p style="margin:0 0 5px 0; font-size:11px; color:#64748b; font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">Venta Máxima</p>
              <h3 style="margin:0; font-size:18px; color:#d97706; font-weight:800;">${formatCurrency(maxTicket)}</h3>
            </div>
          </div>

          <!-- Calendario y Detalle Diario (2 Columnas) -->
          <div style="display:grid; grid-template-columns: 1fr; gap:20px; margin-bottom:20px;">
            
            <!-- Calendario de Ventas -->
            <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:20px; padding:20px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h4 style="margin:0; font-size:14px; color:#334155; font-weight:800; display:flex; align-items:center; gap:6px;">
                  <i data-lucide="calendar" style="width:16px; color:var(--primary);"></i> Calendario de Ventas
                </h4>
                <div style="display:flex; align-items:center; gap:10px;">
                  <button onclick="window.changeCollabCalendarMonth(-1)" style="background:white; border:1px solid #cbd5e1; border-radius:8px; width:28px; height:28px; cursor:pointer; font-weight:bold; color:#475569;">◀</button>
                  <span style="font-size:13px; font-weight:800; color:#334155; min-width:110px; text-align:center;">${monthNames[calMonth]} ${calYear}</span>
                  <button onclick="window.changeCollabCalendarMonth(1)" style="background:white; border:1px solid #cbd5e1; border-radius:8px; width:28px; height:28px; cursor:pointer; font-weight:bold; color:#475569;">▶</button>
                </div>
              </div>

              <!-- Cabecera de Días de la Semana -->
              <div style="display:grid; grid-template-columns: repeat(7, 1fr); gap:6px; text-align:center; font-weight:700; font-size:11px; color:#64748b; margin-bottom:8px;">
                <span>Dom</span><span>Lun</span><span>Mar</span><span>Mié</span><span>Jue</span><span>Vie</span><span>Sáb</span>
              </div>

              <!-- Grilla de Días -->
              <div style="display:grid; grid-template-columns: repeat(7, 1fr); gap:6px;">
                ${calendarCells.map(day => {
                  if (day === null) {
                    return `<div style="aspect-ratio: 1; border-radius:10px; background:transparent;"></div>`;
                  }
                  
                  const sales = salesByDay[day];
                  const hasSales = !!sales;
                  const isSelected = selectedDay === day;
                  
                  let cellBg = 'white';
                  let cellColor = '#334155';
                  let border = '1px solid #e2e8f0';
                  
                  if (hasSales) {
                    if (sales.total > 400000) {
                      cellBg = '#047857';
                      cellColor = 'white';
                      border = 'none';
                    } else if (sales.total > 150000) {
                      cellBg = '#10b981';
                      cellColor = 'white';
                      border = 'none';
                    } else {
                      cellBg = '#d1fae5';
                      cellColor = '#065f46';
                      border = 'none';
                    }
                  }

                  if (isSelected) {
                    border = '3px solid var(--primary)';
                  }

                  return `
                    <div onclick="${hasSales ? `state.collabSelectedCalDay=${day};render()` : ''}" 
                      title="${hasSales ? `${sales.count} ventas - Total: ${formatCurrency(sales.total)}` : 'Sin ventas'}"
                      style="aspect-ratio: 1; border-radius:10px; background:${cellBg}; color:${cellColor}; border:${border}; display:flex; flex-direction:column; align-items:center; justify-content:center; font-size:12px; font-weight:700; cursor:${hasSales ? 'pointer' : 'default'}; transition:all 0.15s ease; position:relative; box-shadow:${isSelected ? '0 0 10px rgba(59,130,246,0.3)' : 'none'};">
                      <span>${day}</span>
                      ${hasSales ? `<span style="font-size:7px; font-weight:800; opacity:0.9; margin-top:2px;">$${Math.round(sales.total / 1000)}k</span>` : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            </div>

            <!-- Detalle de Ventas del Día Seleccionado -->
            <div style="background:white; border:1px solid #f1f5f9; border-radius:20px; padding:20px; box-shadow:0 4px 6px rgba(0,0,0,0.02);">
              <h4 style="margin:0 0 15px 0; font-size:14px; color:#334155; font-weight:800; display:flex; align-items:center; justify-content:space-between;">
                <span>
                  <i data-lucide="receipt" style="width:16px; color:var(--success); vertical-align:middle; margin-right:4px;"></i> 
                  Ventas del ${selectedDay ? `${selectedDay} de ${monthNames[calMonth]}` : 'Mes'}
                </span>
                <span style="font-size:11px; background:#f1f5f9; color:#475569; padding:2px 8px; border-radius:10px;">
                  ${dayTx.length || monthTx.length} registros
                </span>
              </h4>

              <div style="display:flex; flex-direction:column; gap:10px; max-height:280px; overflow-y:auto; padding-right:5px;">
                ${(() => {
                  const txList = selectedDay ? dayTx : monthTx;
                  if (txList.length === 0) {
                    return `
                      <div style="text-align:center; padding:40px 20px; color:#94a3b8;">
                        <span style="font-size:32px;">📭</span>
                        <p style="margin:10px 0 0 0; font-size:12px; font-weight:600;">Ninguna venta registrada para esta fecha.</p>
                      </div>
                    `;
                  }

                  return txList.map(t => {
                    const timeStr = t.timestamp ? new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Hora N/A';
                    return `
                      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px; background:#f8fafc; border-radius:12px; border:1px solid #f1f5f9; transition:all 0.15s ease;">
                        <div>
                          <p style="margin:0; font-weight:700; font-size:12px; color:#1e293b;">${t.description || 'Venta POS'}</p>
                          <span style="font-size:10px; color:#94a3b8;">📅 ${t.date} · 🕒 ${timeStr} · 💳 ${t.payment_method || 'Efectivo'}</span>
                        </div>
                        <span style="font-weight:800; font-size:13px; color:#10b981;">+ ${formatCurrency(t.amount)}</span>
                      </div>
                    `;
                  }).join('');
                })()}
              </div>
            </div>

          </div>

          <div style="display:flex; justify-content:flex-end;">
            <button onclick="state.activeModal=null;state.collabSelectedCalDay=null;render()" 
              class="btn-primary" 
              style="background:#64748b; border:none; padding:10px 20px; color:#f1f5f9; border-radius:12px; font-weight:700; font-size:13px; cursor:pointer;">
              Cerrar Analíticas
            </button>
          </div>
        </div>
      </div>
      `;
    })() : ''}

    ${state.activeModal === 'edit_sale' ? `
    <div class="modal-overlay">
      <div class="modal-card card" style="max-width:400px;">
        <div class="modal-close" onclick="state.activeModal=null;state.editingSaleId=null;render()">×</div>
        <div style="text-align:center; margin-bottom:15px;">
          <div style="background:#e0f2fe; color:#0284c7; width:48px; height:48px; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 10px;">
            <i data-lucide="edit-3" style="width:24px; height:24px;"></i>
          </div>
          <h2 style="margin:0; font-size:18px; color:#0f172a; font-weight:800;">Modificar Venta</h2>
          <p style="margin:5px 0 0 0; font-size:13px; color:#64748b;">Venta #${(state.editingSaleId || '').slice(0,8).toUpperCase()}</p>
        </div>
        
        <form onsubmit="window.saveEditSale(event); return false;">
          <div class="form-group">
            <label style="font-weight:700; color:#334155; font-size:13px;">Nuevo Total de la Venta</label>
            <input type='text' inputmode='numeric' name="new_total" class="form-input currency-input" value="${state.editingSaleTotal || ''}" required style="font-size:20px; font-weight:900; height:50px; text-align:center; color:var(--success);">
            <p style="font-size:11px; color:#94a3b8; margin-top:6px; line-height:1.4;">
              ⚠️ Esta acción modificará el total de la venta y ajustará proporcionalmente los precios de los artículos.
            </p>
          </div>
          <div class="form-group">
            <label style="font-weight:700; color:#334155; font-size:13px;">Método de Pago</label>
            <select name="payment_method" class="form-input" required>
              <option value="Efectivo" ${state.editingSalePaymentMethod === 'Efectivo' ? 'selected' : ''}>💵 Efectivo</option>
              <option value="Addi" ${state.editingSalePaymentMethod === 'Addi' ? 'selected' : ''}>💳 Addi</option>
              <option value="Sistecredito" ${state.editingSalePaymentMethod === 'Sistecredito' ? 'selected' : ''}>💳 Sistecredito</option>
              <option value="Daviplata" ${state.editingSalePaymentMethod === 'Daviplata' ? 'selected' : ''}>📱 Daviplata</option>
              <option value="Transferencia" ${state.editingSalePaymentMethod === 'Transferencia' ? 'selected' : ''}>🏦 Transferencia</option>
              <option value="Llano Gas" ${state.editingSalePaymentMethod === 'Llano Gas' ? 'selected' : ''}>🔥 Llano Gas</option>
              <option value="Bonos Coopchipaque" ${state.editingSalePaymentMethod === 'Bonos Coopchipaque' ? 'selected' : ''}>🎟️ Bonos Coopchipaque</option>
            </select>
          </div>
          <div style="display:flex; gap:10px; margin-top:20px;">
            <button type="button" onclick="window.deleteSale('${state.editingSaleId}')" class="btn-primary" style="flex:1; background:var(--danger); border:none; height:45px; font-weight:800; border-radius:12px;">Eliminar</button>
            <button type="submit" class="btn-primary" style="flex:2; height:45px; font-weight:800; border-radius:12px;">Guardar</button>
          </div>
        </form>
      </div>
    </div>
    ` : ''}
    ${state.activeModal === 'edit_transaction' ? `
    <div class="modal-overlay">
      <div class="modal-card card" style="max-width:400px;">
        <div class="modal-close" onclick="state.activeModal=null;state.editingTransactionId=null;render()">×</div>
        <div style="text-align:center; margin-bottom:15px;">
          <div style="background:#fef3c7; color:#d97706; width:48px; height:48px; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 10px;">
            <i data-lucide="edit-3" style="width:24px; height:24px;"></i>
          </div>
          <h2 style="margin:0; font-size:18px; color:#0f172a; font-weight:800;">Modificar Transacción</h2>
          <p style="margin:5px 0 0 0; font-size:13px; color:#64748b;">ID: #${(state.editingTransactionId || '').slice(0,8).toUpperCase()}</p>
        </div>
        
        <form onsubmit="window.saveEditTransaction(event); return false;">
          <div class="form-group">
            <label style="font-weight:700; color:#334155; font-size:13px;">Monto</label>
            <input type='text' inputmode='numeric' name="amount" class="form-input currency-input" value="${state.editingTransactionAmount || ''}" required style="font-size:20px; font-weight:900; height:50px; text-align:center; color:var(--success);">
          </div>
          <div class="form-group">
            <label style="font-weight:700; color:#334155; font-size:13px;">Tipo</label>
            <select name="type" class="form-input" required>
              <option value="income" ${state.editingTransactionType === 'income' ? 'selected' : ''}>Ingreso</option>
              <option value="expense" ${state.editingTransactionType === 'expense' ? 'selected' : ''}>Egreso / Gasto</option>
            </select>
          </div>
          <div class="form-group">
            <label style="font-weight:700; color:#334155; font-size:13px;">Categoría</label>
            <select name="category_id" class="form-input" required>
              <option value="">Seleccionar categoría...</option>
              ${state.categories.map(c => `<option value="${c.id}" ${state.editingTransactionCategoryId === c.id ? 'selected' : ''}>${c.name} (${c.type === 'income' ? 'Ingreso' : 'Egreso'})</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label style="font-weight:700; color:#334155; font-size:13px;">Sede / Negocio</label>
            <select name="business_id" class="form-input" required>
              <option value="">Seleccionar sede...</option>
              ${state.businesses.map(b => `<option value="${b.id}" ${state.editingTransactionBusinessId === b.id ? 'selected' : ''}>${b.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label style="font-weight:700; color:#334155; font-size:13px;">Método de Pago</label>
            <select name="payment_method" class="form-input" required>
              <option value="Efectivo" ${state.editingTransactionPaymentMethod === 'Efectivo' ? 'selected' : ''}>💵 Efectivo</option>
              <option value="Addi" ${state.editingTransactionPaymentMethod === 'Addi' ? 'selected' : ''}>💳 Addi</option>
              <option value="Sistecredito" ${state.editingTransactionPaymentMethod === 'Sistecredito' ? 'selected' : ''}>💳 Sistecredito</option>
              <option value="Daviplata" ${state.editingTransactionPaymentMethod === 'Daviplata' ? 'selected' : ''}>📱 Daviplata</option>
              <option value="Transferencia" ${state.editingTransactionPaymentMethod === 'Transferencia' ? 'selected' : ''}>🏦 Transferencia</option>
              <option value="Llano Gas" ${state.editingTransactionPaymentMethod === 'Llano Gas' ? 'selected' : ''}>🔥 New Gas / Llano Gas</option>
              <option value="Bonos Coopchipaque" ${state.editingTransactionPaymentMethod === 'Bonos Coopchipaque' ? 'selected' : ''}>🎟️ Bonos Coopchipaque</option>
            </select>
          </div>
          <div class="form-group">
            <label style="font-weight:700; color:#334155; font-size:13px;">Nota / Descripción</label>
            <input type="text" name="note" class="form-input" value="${state.editingTransactionNote || ''}">
          </div>
          <div style="display:flex; gap:10px; margin-top:20px;">
            <button type="button" onclick="window.deleteTransaction('${state.editingTransactionId}')" class="btn-primary" style="flex:1; background:var(--danger); border:none; height:45px; font-weight:800; border-radius:12px;">Eliminar</button>
            <button type="submit" class="btn-primary" style="flex:2; height:45px; font-weight:800; border-radius:12px;">Guardar</button>
          </div>
        </form>
      </div>
    </div>
    ` : ''}
    ${state.activeModal === 'edit_product' ? `
    <div class="modal-overlay">
      <div class="modal-card card" style="max-width:450px;">
        <div class="modal-close" onclick="state.activeModal=null;state.editingProductId=null;render()">×</div>
        <div style="text-align:center; margin-bottom:15px;">
          <div style="background:#e0f2fe; color:#0284c7; width:48px; height:48px; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 10px;">
            <i data-lucide="package" style="width:24px; height:24px;"></i>
          </div>
          <h2 style="margin:0; font-size:18px; color:#0f172a; font-weight:800;">Modificar Producto</h2>
        </div>
        
        <form onsubmit="window.saveEditProduct(event); return false;">
          <div class="form-group">
            <label style="font-weight:700; color:#334155; font-size:13px;">Nombre del Producto</label>
            <input type="text" name="name" class="form-input" value="${state.editingProductName || ''}" required>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
            <div class="form-group">
              <label style="font-weight:700; color:#334155; font-size:13px;">Precio de Venta</label>
              <input type='text' inputmode='numeric' name="price" class="form-input currency-input" value="${state.editingProductPrice || ''}" required>
            </div>
            <div class="form-group">
              <label style="font-weight:700; color:#334155; font-size:13px;">Costo Base</label>
              <input type='text' inputmode='numeric' name="cost" class="form-input currency-input" value="${state.editingProductCost || ''}" required>
            </div>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
            <div class="form-group">
              <label style="font-weight:700; color:#334155; font-size:13px;">Stock Actual</label>
              <input type="number" name="stock" class="form-input" value="${state.editingProductStock ?? 0}" required>
            </div>
            <div class="form-group">
              <label style="font-weight:700; color:#334155; font-size:13px;">Stock Fijo / Ideal</label>
              <input type="number" name="purchase_price" class="form-input" value="${state.editingProductIdealStock ?? 0}" required>
            </div>
          </div>
          <div class="form-group">
            <label style="font-weight:700; color:#334155; font-size:13px;">Sede / Negocio</label>
            <select name="business_id" class="form-input" required>
              <option value="">Seleccionar sede...</option>
              ${state.businesses.map(b => `<option value="${b.id}" ${state.editingProductBusinessId === b.id ? 'selected' : ''}>${b.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label style="font-weight:700; color:#334155; font-size:13px;">Género</label>
            <select name="gender" class="form-input">
              <option value="">Sin Asignar</option>
              <option value="hombre" ${state.editingProductGender === 'hombre' ? 'selected' : ''}>👨 Hombre</option>
              <option value="mujer" ${state.editingProductGender === 'mujer' ? 'selected' : ''}>👩 Mujer</option>
              <option value="unisex" ${state.editingProductGender === 'unisex' ? 'selected' : ''}>⚧️ Unisex</option>
            </select>
          </div>
          <button type="submit" class="btn-primary" style="width:100%; height:45px; margin-top:20px; font-size:14px; font-weight:800;">Guardar Cambios</button>
        </form>
      </div>
    </div>
    ` : ''}
  `;

  const toastHtml = `<div id="toast-container"></div>`;

  app.innerHTML = html + modalHtml + toastHtml;
  
  if (state.view === 'manager_dashboard') {
    setTimeout(() => {
      const ctx = document.getElementById('managerChart');
      if (!ctx) return;
      if (state.chartInstance) state.chartInstance.destroy();
      
      const trx = state.currentBusinessId === 'all' ? state.transactions : state.transactions.filter(t => t.business_id === state.currentBusinessId);
      const now = new Date();
      let labels = [];
      let incomeData = [];
      let expenseData = [];

      if (state.timeFilter === 'daily') {
        labels = ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '23:59'];
        const groupByHour = (hour) => {
          const filtered = trx.filter(t => {
            const d = new Date(t.date);
            return d.getDate() === now.getDate() && d.getHours() >= hour && d.getHours() < hour + 4;
          });
          return {
            inc: filtered.filter(t => t.type === 'income').reduce((s,t) => s + Number(t.amount), 0),
            exp: filtered.filter(t => t.type === 'expense').reduce((s,t) => s + Number(t.amount), 0)
          };
        };
        [0,4,8,12,16,20].forEach(h => {
          const res = groupByHour(h);
          incomeData.push(res.inc);
          expenseData.push(res.exp);
        });
      } else {
        const days = state.timeFilter === 'weekly' ? 7 : 30;
        for (let i = days - 1; i >= 0; i--) {
          const d = new Date();
          d.setDate(now.getDate() - i);
          labels.push(d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }));
          
          const dayTrx = trx.filter(t => new Date(t.date).toDateString() === d.toDateString());
          incomeData.push(dayTrx.filter(t => t.type === 'income').reduce((s,t) => s + Number(t.amount), 0));
          expenseData.push(dayTrx.filter(t => t.type === 'expense').reduce((s,t) => s + Number(t.amount), 0));
        }
      }

      state.chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Ingresos', data: incomeData, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4 },
            { label: 'Gastos', data: expenseData, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.4 }
          ]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: true, position: 'bottom', labels: { color: '#94a3b8' } } },
          scales: {
            y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b' } },
            x: { grid: { display: false }, ticks: { color: '#64748b' } }
          }
        }
      });
    }, 50);
  }
  
  // INICIALIZAR MAPA LEAFLET PARA CENTRO DE CONTROL BYOD
  if (state.view === 'byod_dashboard') {
    setTimeout(() => {
      if (window.initByodMap) window.initByodMap();
      if (window.startByodLiveTracking) window.startByodLiveTracking();
    }, 100);
  }
  
  // ACTIVAR ICONOS LUCIDE
  if (window.lucide) {
    window.lucide.createIcons();
  }
};


// POS HELPER FUNCTIONS
window.addToCart = (productId) => {
  const product = state.products.find(p => p.id === productId);
  if (!product) return;
  
  const existing = state.cart.find(item => item.product_id === productId);
  if (existing) {
    existing.quantity += 1;
  } else {
    state.cart.push({ ...product, product_id: product.id, quantity: 1 });
  }
  render();
};

window.updateCartQuantity = (productId, delta) => {
  const item = state.cart.find(i => i.product_id === productId);
  if (item) {
    item.quantity = Math.max(1, item.quantity + delta);
    render();
  }
};

window.removeFromCart = (productId) => {
  state.cart = state.cart.filter(i => i.product_id !== productId);
  render();
};

window.updatePosDiscount = (val) => {
  const cartTotal = state.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  state.posDiscount = Math.min(cartTotal, Math.max(0, parseFloat(val) || 0));
  render();
};

window.finalizeSale = async () => {
  if (state.cart.length === 0) return;
  
  const pm = state.posPaymentMethod || 'Efectivo';
  const cartTotal = state.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const discount = state.posDiscount || 0;
  const total = Math.max(0, cartTotal - discount);
  const discountFactor = cartTotal > 0 ? total / cartTotal : 1;
  
  try {
    state.loading = true;
    render();

    // 1. Create Sale
    const { data: sale, error: saleErr } = await supabase.from('sales').insert({
      user_id: state.user.id,
      total: total,
      payment_method: pm
    }).select().single();

    if (saleErr) throw saleErr;

    // 2. Create Sale Items
    const saleItems = state.cart.map(item => ({
      sale_id: sale.id,
      product_id: item.product_id,
      quantity: item.quantity,
      price: Math.round(item.price * discountFactor)
    }));

    const { error: itemsErr } = await supabase.from('sale_items').insert(saleItems);
    if (itemsErr) throw itemsErr;

    // 3. Crear Transacciones Contables Inteligentes (División por Negocio)
    const totalsByBusiness = {};
    state.cart.forEach(item => {
       const bId = item.business_id || state.activeShiftBusinessId || state.user.business_id || (state.businesses.length > 0 ? state.businesses[0].id : null);
       if (bId) {
          totalsByBusiness[bId] = (totalsByBusiness[bId] || 0) + Math.round((item.price * item.quantity) * discountFactor);
       }
    });

    const ventaCat = state.categories.find(c => c.name === 'Venta' && c.type === 'income');
    const transactionRows = Object.entries(totalsByBusiness).map(([bizId, subTotal]) => ({
       amount: subTotal,
       type: 'income',
       category_id: ventaCat ? ventaCat.id : null,
       business_id: bizId,
       user_id: state.user.id,
       date: new Date().toISOString(),
       payment_method: pm,
       note: `[Venta POS #${sale.id.slice(0,5)}] Clúster Centralizado. Mét: ${pm}${discount > 0 ? ` (Desc: $${discount.toLocaleString()})` : ''}`
    }));

    if (transactionRows.length > 0) {
       const { error: trxErr } = await supabase.from('transactions').insert(transactionRows);
       if (trxErr) {
        console.error("Error al registrar dinero:", trxErr);
        window.showToast("⚠️ Venta guardada, pero hubo un error en el balance: " + trxErr.message, "warning");
      }
    }

    // 4. Clear Cart and Return
    state.cart = [];
    state.posDiscount = 0;
    state.view = 'app';
    await window.fetchData();
    window.showToast('✅ Venta y balance registrados', 'success');
    alert('Venta realizada con éxito');
  } catch (err) {
    console.error(err);
    alert('Error al procesar la venta');
  } finally {
    state.loading = false;
    render();
  }
};

window.editSupplier = (idx) => {
  const s = state.suppliers[idx];
  if (!s) return;
  state.editingSupplier = { ...s, index: idx };
  render();
};

window.deleteSupplier = async (idx) => {
  if (!confirm("¿Seguro que deseas eliminar este proveedor?")) return;
  state.suppliers.splice(idx, 1);
  await window.saveSuppliers();
  render();
};

window.handleSupplierSubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('sup-name').value;
  const phone = document.getElementById('sup-phone').value;
  const products_sold = document.getElementById('sup-products').value;
  const debt = parseFloat(document.getElementById('sup-debt').value) || 0;
  const cash_purchases = parseFloat(document.getElementById('sup-cash').value) || 0;

  if (state.editingSupplier && state.editingSupplier.index !== undefined) {
    const currentSup = state.suppliers[state.editingSupplier.index];
    state.suppliers[state.editingSupplier.index] = {
      ...currentSup,
      name, phone, products_sold, debt, cash_purchases
    };
    state.editingSupplier = null;
  } else {
    state.suppliers = state.suppliers || [];
    state.suppliers.push({
      name, phone, products_sold, debt, cash_purchases,
      invoices: []
    });
  }

  await window.saveSuppliers();
  render();
};

window.openSupplierLedger = (idx) => {
  state.selectedSupplierIdx = idx;
  state.activeModal = 'supplier_ledger';
  render();
};

window.saveSupplierInvoice = async (e) => {
  e.preventDefault();
  const idx = state.selectedSupplierIdx;
  const s = state.suppliers[idx];
  if (!s) return;

  const formData = new FormData(e.target);
  const invoice_number = formData.get('invoice_number');
  const total_amount = window.getCleanNumber(formData.get('total_amount'));
  const date = formData.get('date') || new Date().toISOString().split('T')[0];

  if (!invoice_number || total_amount <= 0) {
    return window.showToast("🚫 Ingresa datos válidos de factura.", "danger");
  }

  s.invoices = s.invoices || [];
  s.invoices.push({
    id: Date.now().toString(),
    invoice_number,
    total_amount,
    date,
    payments: []
  });

  // Recalcular deudas para mantener consistencia
  const totalInvoicesDebt = s.invoices.reduce((acc, inv) => {
    const paid = (inv.payments || []).reduce((sum, p) => sum + p.amount, 0);
    return acc + (inv.total_amount - paid);
  }, 0);
  
  // Sumamos a la deuda inicial histórica
  s.debt = totalInvoicesDebt;

  await window.saveSuppliers();
  render();
};

window.saveInvoicePayment = async (e, invoiceId) => {
  e.preventDefault();
  const idx = state.selectedSupplierIdx;
  const s = state.suppliers[idx];
  if (!s) return;

  const inv = (s.invoices || []).find(i => i.id === invoiceId);
  if (!inv) return;

  const amountInput = e.target.querySelector('input[name="payment_amount"]');
  const amount = parseFloat(amountInput.value) || 0;
  const date = new Date().toISOString().split('T')[0];

  const currentlyPaid = (inv.payments || []).reduce((sum, p) => sum + p.amount, 0);
  const remaining = inv.total_amount - currentlyPaid;

  if (amount <= 0 || amount > remaining) {
    return window.showToast(`🚫 El monto debe ser mayor a 0 y no exceder el saldo pendiente (${formatCurrency(remaining)}).`, "warning");
  }

  inv.payments = inv.payments || [];
  inv.payments.push({ date, amount });

  // Recalcular deuda del proveedor
  s.debt = s.invoices.reduce((acc, i) => {
    const p = (i.payments || []).reduce((sum, pay) => sum + pay.amount, 0);
    return acc + (i.total_amount - p);
  }, 0);

  await window.saveSuppliers();
  render();
};

window.deleteSupplierInvoice = async (invoiceId) => {
  if (!confirm("⚠️ ¿Estás seguro de eliminar este registro de factura? Esto borrará también todos sus abonos asociados.")) return;
  const idx = state.selectedSupplierIdx;
  const s = state.suppliers[idx];
  if (!s) return;

  s.invoices = (s.invoices || []).filter(i => i.id !== invoiceId);

  // Recalcular deuda
  s.debt = s.invoices.reduce((acc, i) => {
    const p = (i.payments || []).reduce((sum, pay) => sum + pay.amount, 0);
    return acc + (i.total_amount - p);
  }, 0);

  await window.saveSuppliers();
  render();
};

window.generateSupplierPdf = async () => {
  const idx = state.selectedSupplierIdx;
  const s = state.suppliers[idx];
  if (!s) return;

  const startDate = document.getElementById('pdf-start-date')?.value;
  const endDate = document.getElementById('pdf-end-date')?.value;

  let filteredInvoices = s.invoices || [];
  if (startDate) filteredInvoices = filteredInvoices.filter(inv => inv.date >= startDate);
  if (endDate) filteredInvoices = filteredInvoices.filter(inv => inv.date <= endDate);

  try {
    window.showToast("⏳ Construyendo documento PDF...", "info");
    
    const doc = new jsPDF();
    
    // Bloque Encabezado Corporativo
    doc.setFillColor(15, 23, 42); // slate-900
    doc.rect(0, 0, 220, 35, 'F');
    
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text("SURTIHOGAR G&C - REPORTE CONTABLE", 15, 18);
    
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text("Historial de Facturación y Movimientos de Proveedor", 15, 26);
    
    // Información del Tercero
    doc.setTextColor(51, 65, 85);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("DATOS DEL PROVEEDOR", 15, 48);
    
    doc.setFont("helvetica", "normal");
    doc.text(`Nombre: ${s.name}`, 15, 55);
    doc.text(`Contacto: ${s.phone || 'No registrado'}`, 15, 61);
    
    // Datos de Emisión
    doc.setFont("helvetica", "bold");
    doc.text("INFORMACIÓN GENERAL", 120, 48);
    doc.setFont("helvetica", "normal");
    doc.text(`Generado: ${new Date().toLocaleString()}`, 120, 55);
    doc.text(`Rango: ${startDate || 'Inicio'} al ${endDate || 'Hoy'}`, 120, 61);

    // Línea Separadora
    doc.setDrawColor(226, 232, 240);
    doc.line(15, 70, 195, 70);
    
    // Construcción de la Tabla
    const head = [['Detalle Factura / Abono', 'Valor Compra', 'Valor Abonado', 'Saldo Deuda']];
    const body = [];
    let overallDebt = 0;
    
    filteredInvoices.forEach(inv => {
      const paid = (inv.payments || []).reduce((sum, p) => sum + p.amount, 0);
      const debt = inv.total_amount - paid;
      overallDebt += debt;
      
      // Fila de Factura
      body.push([
        `Factura: #${inv.invoice_number}\n(Fecha: ${inv.date})`,
        formatCurrency(inv.total_amount),
        formatCurrency(paid),
        formatCurrency(debt)
      ]);
      
      // Sub-filas con desglose de abonos
      (inv.payments || []).forEach(p => {
        body.push([
          `   ↳ Abono registrado el ${p.date}`,
          '',
          formatCurrency(p.amount),
          ''
        ]);
      });
    });
    
    if (body.length === 0) {
      body.push([{ content: 'Sin movimientos financieros registrados en este periodo.', colSpan: 4, styles: { halign: 'center', textColor: [100,116,139] } }]);
    }

    autoTable(doc, {
      startY: 78,
      head: head,
      body: body,
      theme: 'striped',
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: 'bold' },
      styles: { fontSize: 9, cellPadding: 4, font: 'helvetica' },
      columnStyles: {
        0: { cellWidth: 70 },
        1: { halign: 'right' },
        2: { halign: 'right' },
        3: { halign: 'right', fontStyle: 'bold' }
      }
    });
    
    // Cuadro Resumen de Deuda Total
    const finalY = (doc.lastAutoTable ? doc.lastAutoTable.finalY : 120) + 15;
    
    // Verificar desbordamiento de página para el cuadro de deuda
    if (finalY > 270) {
      doc.addPage();
      doc.setFillColor(254, 242, 242);
      doc.setDrawColor(248, 113, 113);
      doc.rect(110, 15, 85, 15, 'FD');
      doc.setFont("helvetica", "bold");
      doc.setTextColor(153, 27, 27);
      doc.setFontSize(11);
      doc.text(`DEUDA NETO TOTAL: ${formatCurrency(overallDebt)}`, 115, 24);
    } else {
      doc.setFillColor(254, 242, 242);
      doc.setDrawColor(248, 113, 113);
      doc.rect(110, finalY - 8, 85, 15, 'FD');
      doc.setFont("helvetica", "bold");
      doc.setTextColor(153, 27, 27);
      doc.setFontSize(11);
      doc.text(`DEUDA NETO TOTAL: ${formatCurrency(overallDebt)}`, 115, finalY + 1);
    }
    
    // Proceder a Guardar / Compartir
    const rawBlob = doc.output('blob');
    const safeName = `Reporte_${s.name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    const shareFile = new File([rawBlob], safeName, { type: 'application/pdf' });
    
    // SECUENCIACIÓN INDESTRUCTIBLE DE DESPACHO (Nativo -> Compartir -> Local)
    let isCompleted = false;

    // === MODO NATIVO COMPLETO (CELULAR / EMULADOR) ===
    if (Capacitor.isNativePlatform()) {
      try {
        window.showToast("⚙️ Procesando archivo nativo...", "info");
        const base64 = doc.output('datauristring').split(',')[1];
        
        // 1. Escribir el archivo en la caché interna y segura del aplicativo (Sin requerir permisos molestos)
        const writeResult = await Filesystem.writeFile({
          path: safeName,
          data: base64,
          directory: Directory.Cache,
          recursive: true
        });
        
        // 2. Lanzar la hoja de compartir nativa del celular de forma inmediata usando el archivo
        await Share.share({
          title: `Reporte Contable - ${s.name}`,
          text: `Adjunto reporte de ${s.name}.`,
          url: writeResult.uri
        });
        
        isCompleted = true;
        window.showToast("✅ Enviado al menú de compartir.", "success");
      } catch (nativeErr) {
        console.error("Fallo en almacenamiento/compartir nativo:", nativeErr);
        window.showToast("⚠️ Error al procesar en móvil. Intentando alternativas web...", "warning");
      }
    }

    // === MODO WEB STANDBY (NAVEGADOR DE COMPUTADORA O CAÍDA DE SEGURIDAD) ===
    if (!isCompleted) {
      const shareFile = new File([rawBlob], safeName, { type: 'application/pdf' });

      // A. Intentar Web Share API (Navegadores de escritorio soportados)
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [shareFile] })) {
        try {
          await navigator.share({
            files: [shareFile],
            title: `Reporte Contable - ${s.name}`,
            text: `Adjuntamos reporte contable con corte a la fecha.`
          });
          isCompleted = true;
          window.showToast("✅ Reporte compartido con éxito.", "success");
        } catch (shareErr) {
          console.warn("El menú web falló, procediendo a descarga:", shareErr);
        }
      }

      // B. Guardado físico vía navegador (Vite/Chrome)
      if (!isCompleted) {
        try {
          doc.save(safeName);
          isCompleted = true;
          window.showToast("✅ PDF descargado con éxito.", "success");
        } catch (saveErr) {
          console.error("Error en doc.save() web:", saveErr);
        }
      }

      // C. Fallback Extremo Web
      if (!isCompleted) {
        try {
          const blobUrl = URL.createObjectURL(rawBlob);
          const tempLink = document.createElement('a');
          tempLink.href = blobUrl;
          tempLink.download = safeName;
          document.body.appendChild(tempLink);
          tempLink.click();
          document.body.removeChild(tempLink);
          window.showToast("✅ Descarga forzada completada.", "success");
        } catch (fallbackErr) {
          console.error("Error en descarga forzada:", fallbackErr);
          window.showToast("❌ Dispositivo bloqueó la descarga.", "danger");
        }
      }
    }

  } catch (err) {
    console.error("Error absoluto al sintetizar reporte PDF:", err);
    window.showToast("❌ Error crítico inesperado al generar el documento.", "danger");
  }
};

window.setTodayReportingRange = () => {
  const today = new Date().toISOString().split('T')[0];
  const sInput = document.getElementById('rpt-start');
  const eInput = document.getElementById('rpt-end');
  if (sInput) sInput.value = today;
  if (eInput) eInput.value = today;
  window.showToast("📅 Rango de fechas establecido para hoy.", "info");
};

window.generateAdminSalesReportPDF = async () => {
  try {
    const bizId = document.getElementById('rpt-biz-select')?.value || 'all';
    const startVal = document.getElementById('rpt-start')?.value;
    const endVal = document.getElementById('rpt-end')?.value;

    if (!startVal || !endVal) {
      return window.showToast("🚫 Por favor, selecciona ambas fechas para procesar.", "warning");
    }

    window.showToast("⏳ Iniciando compilación de auditoría...", "info");

    // 📅 Extracción segura de límites temporales (Día completo en hora local)
    const startMs = new Date(startVal + 'T00:00:00').getTime();
    const endMs = new Date(endVal + 'T23:59:59').getTime();

    let filteredSales = state.sales.filter(sale => {
      const saleTime = new Date(sale.created_at).getTime();
      return saleTime >= startMs && saleTime <= endMs;
    });

    // 🏢 Filtrar ventas por pertenencia a la sede seleccionada
    if (bizId !== 'all') {
      filteredSales = filteredSales.filter(sale => {
        const items = state.saleItems.filter(si => si.sale_id === sale.id);
        const bizIdsFromProducts = items.map(i => i.products?.business_id).filter(Boolean);
        const saleShortId = sale.id.slice(0, 5);
        let relatedTx = state.transactions.filter(t => t.note && t.note.includes(saleShortId));
        
        if (relatedTx.length === 0 && sale.note && sale.note.startsWith('Venta informal: ')) {
          const descPart = sale.note.replace('Venta informal: ', '').trim();
          relatedTx = state.transactions.filter(tx => tx.type === 'income' && tx.user_id === sale.user_id && (tx.description === descPart || tx.description === 'Venta Rápida: ' + descPart) && Math.abs(new Date(tx.date) - new Date(sale.created_at)) < 120000);
        }
        
        if (relatedTx.length === 0 && bizIdsFromProducts.length === 0) {
          relatedTx = state.transactions.filter(tx => tx.type === 'income' && tx.user_id === sale.user_id && Math.abs(new Date(tx.date) - new Date(sale.created_at)) < 60000);
        }

        const bizIdsFromTransactions = relatedTx.map(t => t.business_id);
        const allBizIds = [...new Set([...bizIdsFromProducts, ...bizIdsFromTransactions])];
        return allBizIds.includes(bizId);
      });
    }

    // 💸 NUEVO: Extraer y filtrar gastos operativos en el mismo rango y local
    let filteredExpenses = state.transactions.filter(t => {
      if (t.type !== 'expense') return false;
      const tTime = new Date(t.date || t.created_at).getTime();
      const inRange = tTime >= startMs && tTime <= endMs;
      if (!inRange) return false;
      if (bizId !== 'all' && t.business_id !== bizId) return false;
      return true;
    });

    if (filteredSales.length === 0 && filteredExpenses.length === 0) {
      return window.showToast("ℹ️ No se registraron movimientos (ventas ni gastos) en este periodo.", "warning");
    }

    // Crear documento en formato apaisado (LANDSCAPE) para dar espacio a los detalles
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    // 🖌️ CABECERA ADMINISTRATIVA VECTORIAL (Estilo Premium Oscuro)
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, 297, 32, 'F');
    
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text("SURTIHOGAR G&C - REPORTE OFICIAL DE AUDITORÍA DE VENTAS", 15, 15);
    
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(148, 163, 184);
    doc.text("Módulo Administrativo de Inteligencia Comercial • Registro Detallado de Movimientos POS", 15, 23);

    // 🏷️ RESOLUCIÓN DE CRITERIOS DE EMISIÓN
    const bizName = bizId === 'all' ? 'Consolidado (Todos los Locales)' : (state.businesses.find(b => b.id === bizId)?.name || 'Local Seleccionado');
    
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("DETALLE DEL REPORTE", 15, 45);
    
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(`Local / Sede: ${bizName}`, 15, 51);
    doc.text(`Periodo Solicitado: ${startVal} al ${endVal}`, 15, 57);

    doc.setFont("helvetica", "bold");
    doc.text("AUDITORÍA DE SISTEMA", 180, 45);
    doc.setFont("helvetica", "normal");
    doc.text(`Generado por: ${state.user?.name || 'Administrador Global'}`, 180, 51);
    doc.text(`Fecha de Emisión: ${new Date().toLocaleString('es-CO')}`, 180, 57);

    // Línea divisoria elegante
    doc.setDrawColor(226, 232, 240);
    doc.line(15, 65, 282, 65);

    // 📊 CONSTRUCCIÓN DEL CUERPO DE LA TABLA
    const head = [['REF / FECHA', 'SEDE', 'VENDEDOR', 'DETALLE DE PRODUCTOS Y CANTIDADES', 'PAGO', 'TOTAL NETO']];
    const body = [];
    let totalRevenue = 0;
    let totalCost = 0;
    let totalUnits = 0;
    const paymentBreakdown = { Efectivo: 0, Sistecredito: 0, Addi: 0, 'Llano Gas': 0, Transferencia: 0, Daviplata: 0, 'Bonos Coopchipaque': 0 };
    
    // Nuevas métricas analíticas
    const sellerPerformance = {};
    const productPerformance = {};

    filteredSales.forEach(sale => {
      const items = state.saleItems.filter(si => si.sale_id === sale.id);
      
      // Vendedor
      const sellerObj = state.employees?.find(emp => emp.id === sale.user_id) || (state.user?.id === sale.user_id ? state.user : null);
      const sellerName = sellerObj?.name || 'Asignado';

      // Obtención del nombre de las sedes involucradas (Doble Verificación y Fallback a Empleado)
      const bizIdsFromProducts = items.map(i => i.products?.business_id).filter(Boolean);
      const saleShortId = sale.id.slice(0, 5);
      
      let relatedTxs = state.transactions.filter(t => t.note && t.note.includes(saleShortId));
      if (relatedTxs.length === 0 && sale.note && sale.note.startsWith('Venta informal: ')) {
        const descPart = sale.note.replace('Venta informal: ', '').trim();
        relatedTxs = state.transactions.filter(tx => tx.type === 'income' && tx.user_id === sale.user_id && (tx.description === descPart || tx.description === 'Venta Rápida: ' + descPart) && Math.abs(new Date(tx.date || tx.created_at) - new Date(sale.created_at)) < 120000);
      }
      if (relatedTxs.length === 0 && bizIdsFromProducts.length === 0) {
        relatedTxs = state.transactions.filter(tx => tx.type === 'income' && tx.user_id === sale.user_id && Math.abs(new Date(tx.date || tx.created_at) - new Date(sale.created_at)) < 60000);
      }

      const bizIdsFromTransactions = relatedTxs.map(t => t.business_id);
      const allBizIds = [...new Set([...bizIdsFromProducts, ...bizIdsFromTransactions])];
      
      // Fallback a la sede asignada al empleado si no se detectó por productos/transacciones
      if (allBizIds.length === 0 && sellerObj?.business_id) {
        allBizIds.push(sellerObj.business_id);
      }

      const bizNames = allBizIds.map(id => state.businesses.find(b => b.id === id)?.name || 'General').join(', ');
      
      const saleTotal = parseFloat(sale.total) || 0;

      // Métricas Vendedor
      if (!sellerPerformance[sellerName]) sellerPerformance[sellerName] = { total: 0, count: 0 };
      sellerPerformance[sellerName].total += saleTotal;
      sellerPerformance[sellerName].count += 1;

      // Forma de Pago
      let payMethod = sale.payment_method || 'Efectivo';
      if (payMethod.toLowerCase().includes('daviplata')) {
        payMethod = 'Daviplata';
      } else if (payMethod.toLowerCase().includes('nequi') || payMethod.toLowerCase().includes('transferencia')) {
        payMethod = 'Transferencia';
      }

      // Detalle textual concatenado de productos con recopilación de costos históricos
      let productsLabel = items.map(i => {
        // Prioridad 1: Relación cargada en RAM. Prioridad 2: Lookup directo en inventario
        let pName = i.products?.name;
        let pCost = parseFloat(i.products?.cost) || 0;

        if (!pName) {
          const linkedProd = state.products.find(p => p.id === i.product_id);
          if (linkedProd) {
            pName = linkedProd.name;
            pCost = parseFloat(linkedProd.cost) || 0;
          }
        }

        // Fallbacks de nombres y costos
        if (!pName) {
          const pending = state.pendingProducts.find(pp => pp.sale_id === sale.id);
          if (pending) {
            pName = `${pending.name} (Pte.)`;
            pCost = parseFloat(pending.cost) || 0;
          } else if (sale.note && sale.note.includes('Venta informal')) {
            pName = sale.note.replace('Venta informal: ', '');
            pCost = 0; // Ventas directas informales asumen costo base 0 por defecto
          } else {
            pName = 'Producto Especial';
            pCost = 0;
          }
        }

        const itemQty = Number(i.quantity) || 1;
        totalUnits += itemQty;
        totalCost += (pCost * itemQty);
        
        let productBizId = i.products?.business_id;
        if (!productBizId) {
          const linkedProd = state.products.find(p => p.id === i.product_id);
          if (linkedProd) productBizId = linkedProd.business_id;
        }

        // Solo agregar al Top de Productos si el producto pertenece a la sede consultada
        if (bizId === 'all' || !productBizId || productBizId === bizId) {
          if (!productPerformance[pName]) productPerformance[pName] = 0;
          productPerformance[pName] += itemQty;
        }

        return `${pName} [x${itemQty}]`;
      }).join(', ');

      if (!productsLabel && sale.note && sale.note.includes('Venta informal')) {
        productsLabel = sale.note.replace('Venta informal: ', '').trim() + ' (Directa)';
      }

      // CORRECCIÓN CRÍTICA: Usar 'sale.total' en vez de 'total_amount'
      totalRevenue += saleTotal;

      if (!paymentBreakdown[payMethod]) paymentBreakdown[payMethod] = 0;
      paymentBreakdown[payMethod] += saleTotal;

      const dateObj = new Date(sale.created_at);
      const dateStr = `${dateObj.getDate().toString().padStart(2,'0')}/${(dateObj.getMonth()+1).toString().padStart(2,'0')} ${dateObj.getHours().toString().padStart(2,'0')}:${dateObj.getMinutes().toString().padStart(2,'0')}`;

      body.push([
        `#${sale.id.slice(0, 8).toUpperCase()}\n${dateStr}`,
        bizNames || 'General',
        sellerName,
        productsLabel || 'Venta directa en POS',
        payMethod.toUpperCase(),
        formatCurrency(saleTotal)
      ]);
    });

    // Renderización de la tabla con jsPDF AutoTable
    autoTable(doc, {
      startY: 72,
      head: head,
      body: body,
      theme: 'grid',
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5, cellPadding: 4 },
      styles: { fontSize: 8, cellPadding: 3.5, font: 'helvetica', overflow: 'linebreak' },
      columnStyles: {
        0: { cellWidth: 35, fontStyle: 'bold' },
        1: { cellWidth: 35 },
        2: { cellWidth: 35 },
        3: { cellWidth: 120 },
        4: { cellWidth: 25, halign: 'center' },
        5: { halign: 'right', fontStyle: 'bold', cellWidth: 32 }
      }
    });

    // 💸 RENDER DE TABLA SECUNDARIA: EGRESOS Y GASTOS OPERATIVOS (Si existen)
    if (filteredExpenses.length > 0) {
      let currentY = (doc.lastAutoTable ? doc.lastAutoTable.finalY : 72) + 15;
      
      // Validar salto de página si no cabe la cabecera de gastos
      if (currentY > 175) {
        doc.addPage();
        currentY = 20;
      }

      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(185, 28, 28); // Rojo oscuro corporativo
      doc.text("📄 DESGLOSE DE EGRESOS Y GASTOS OPERATIVOS REGISTRADOS", 15, currentY);
      
      const expenseHead = [['REF / FECHA', 'SEDE / LOCAL', 'RESPONSABLE', 'MOTIVO / CATEGORÍA / DETALLE', 'PAGO', 'MONTO GASTO']];
      const expenseBody = filteredExpenses.map(t => {
        const bizNameObj = state.businesses.find(b => b.id === t.business_id)?.name || 'General';
        const userObj = state.employees?.find(e => e.id === t.user_id) || (state.user?.id === t.user_id ? state.user : null);
        const userName = userObj?.name || 'Colaborador';
        
        // Resolver categoría del gasto y notas
        const catName = state.categories.find(c => c.id === t.category_id)?.name || 'Gasto General';
        const desc = t.description ? `(${t.description})` : (t.note ? `(${t.note})` : '');
        const finalMotivo = `${catName} ${desc}`;

        const dateObj = new Date(t.date || t.created_at);
        const dateStr = `${dateObj.getDate().toString().padStart(2,'0')}/${(dateObj.getMonth()+1).toString().padStart(2,'0')} ${dateObj.getHours().toString().padStart(2,'0')}:${dateObj.getMinutes().toString().padStart(2,'0')}`;

        return [
          `#TRX-${(t.id || '').slice(0,6).toUpperCase()}\n${dateStr}`,
          bizNameObj,
          userName,
          finalMotivo,
          (t.payment_method || 'Efectivo').toUpperCase(),
          formatCurrency(parseFloat(t.amount) || 0)
        ];
      });

      autoTable(doc, {
        startY: currentY + 4,
        head: expenseHead,
        body: expenseBody,
        theme: 'grid',
        headStyles: { fillColor: [185, 28, 28], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5, cellPadding: 4 },
        styles: { fontSize: 8, cellPadding: 3.5, font: 'helvetica', overflow: 'linebreak' },
        columnStyles: {
          0: { cellWidth: 35, fontStyle: 'bold' },
          1: { cellWidth: 35 },
          2: { cellWidth: 35 },
          3: { cellWidth: 120 },
          4: { cellWidth: 25, halign: 'center' },
          5: { halign: 'right', fontStyle: 'bold', cellWidth: 32, textColor: [185, 28, 28] }
        }
      });
    }

    // 📊 RESUMEN FINANCIERO Y BALANCES FINALES (PIE DE PÁGINA EXPANDIDO CON CONTROL DE GASTOS)
    const finalY = (doc.lastAutoTable ? doc.lastAutoTable.finalY : 100) + 15;
    
    // Validar salto de página para el gran contenedor de balances
    if (finalY > 135) {
      doc.addPage();
      doc.setPage(doc.getNumberOfPages());
    }

    const rectY = finalY > 135 ? 20 : finalY;

    // Costos de mercancía calculados dinámicamente según productos vendidos

    // Cálculos Avanzados de EBITDA, Flujo de Caja y Utilidad Total
    let totalOpExpenses = 0;
    let cashExpenses = 0;
    const expenseBreakdown = {};

    filteredExpenses.forEach(t => {
       const amt = parseFloat(t.amount) || 0;
       totalOpExpenses += amt;
       const payMethod = (t.payment_method || 'Efectivo').toLowerCase();
       if (payMethod === 'efectivo') cashExpenses += amt;
       const catName = state.categories.find(c => c.id === t.category_id)?.name || 'Gasto General';
       if (!expenseBreakdown[catName]) expenseBreakdown[catName] = 0;
       expenseBreakdown[catName] += amt;
    });

    const cashRevenue = paymentBreakdown.Efectivo || 0;
    const digitalRevenue = totalRevenue - cashRevenue;
    const cashBalance = cashRevenue - cashExpenses; // Físicamente en Caja

    const realProfit = totalRevenue - totalCost - totalOpExpenses; // EBITDA Patrimonial Neto Real
    const profitMarginPct = totalRevenue > 0 ? ((realProfit / totalRevenue) * 100) : 0;
    
    // Métricas analíticas extras
    const totalTrx = filteredSales.length;
    const avgTicket = totalTrx > 0 ? totalRevenue / totalTrx : 0;

    // Calcular altura del cuadro dinámicamente
    const usedPayMethods = Object.entries(paymentBreakdown).filter(([_, amt]) => amt > 0);
    const usedExpCategories = Object.entries(expenseBreakdown).filter(([_, amt]) => amt > 0);
    const topSellers = Object.entries(sellerPerformance).sort((a,b) => b[1].total - a[1].total);
    const topProducts = Object.entries(productPerformance).sort((a,b) => b[1] - a[1]).slice(0,3);

    const hasBaratillo = (bizId === 'ec292ea5-5cfd-44d8-8b1c-e093cb719492' || bizId === 'all');
    const dynamicHeight = 106 + (hasBaratillo ? 15 : 0) + (usedPayMethods.length * 4) + (usedExpCategories.length * 4) + (topSellers.length * 4) + (topProducts.length * 4);

    // Dibujar contenedor estilizado de Balance General
    doc.setFillColor(248, 250, 252); // Gris neutro suave
    doc.setDrawColor(203, 213, 225); // Borde pizarra
    doc.rect(155, rectY - 8, 127, dynamicHeight, 'FD'); // Cuadro amplio dinámico
    
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    
    // BLOQUE A: Balance Físico de Flujo de Caja
    doc.setTextColor(30, 41, 59);
    doc.text("[=] BALANCE DE FLUJO DE CAJA POS", 160, rectY);
    
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.text(`(+) Ingresos por Ventas:`, 160, rectY + 6);
    doc.text(`${formatCurrency(totalRevenue)}`, 240, rectY + 6);

    let currentOffsetY = rectY + 11;
    usedPayMethods.forEach(([method, amt]) => {
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(`      > ${method}:`, 160, currentOffsetY);
      doc.text(`${formatCurrency(amt)}`, 240, currentOffsetY);
      currentOffsetY += 4;
    });

    doc.setTextColor(185, 28, 28);
    doc.setFontSize(8.5);
    doc.text(`(-) Gastos Operativos:`, 160, currentOffsetY + 2);
    doc.text(`(${formatCurrency(totalOpExpenses)})`, 240, currentOffsetY + 2);
    
    currentOffsetY += 6;
    usedExpCategories.forEach(([cat, amt]) => {
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(`      > ${cat}:`, 160, currentOffsetY);
      doc.text(`(${formatCurrency(amt)})`, 240, currentOffsetY);
      currentOffsetY += 4;
    });

    doc.setDrawColor(226, 232, 240);
    doc.line(160, currentOffsetY + 1, 277, currentOffsetY + 1);

    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(8.5);
    doc.text(`[+] DISPONIBLE FÍSICO EN CAJA (Efectivo):`, 160, currentOffsetY + 6);
    doc.text(`${formatCurrency(cashBalance)}`, 240, currentOffsetY + 6);
    
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(`[+] Dinero en Cuentas (Transf/Digital):`, 160, currentOffsetY + 11);
    doc.text(`${formatCurrency(digitalRevenue)}`, 240, currentOffsetY + 11);

    // Línea divisoria de bloques contables
    doc.setDrawColor(148, 163, 184);
    doc.line(160, currentOffsetY + 15, 277, currentOffsetY + 15);

    const grossProfit = totalRevenue - totalCost;
    const grossMarginPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    const netProfit = totalRevenue - totalCost - totalOpExpenses;
    const netMarginPct = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    // BLOQUE B: Estado de Resultados (EBITDA y Rentabilidad)
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(13, 148, 136); // Turquesa de rentabilidad
    doc.text("[*] ESTADO DE RESULTADOS (RENTABILIDAD)", 160, currentOffsetY + 21);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(30, 41, 59);
    
    doc.text(`(+) Ingresos por Ventas:`, 160, currentOffsetY + 26);
    doc.text(`${formatCurrency(totalRevenue)}`, 240, currentOffsetY + 26);
    doc.text(`(-) Costos de Mercancía:`, 160, currentOffsetY + 30);
    doc.text(`(${formatCurrency(totalCost)})`, 240, currentOffsetY + 30);

    doc.setFont("helvetica", "bold");
    doc.text(`(=) UTILIDAD BRUTA (Ganancia):`, 160, currentOffsetY + 35);
    doc.text(`${formatCurrency(grossProfit)}`, 240, currentOffsetY + 35);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(13, 148, 136);
    doc.text(`      > Margen de Ganancia:`, 160, currentOffsetY + 39);
    doc.text(`${grossMarginPct.toFixed(1)}%`, 240, currentOffsetY + 39);

    doc.setTextColor(185, 28, 28);
    doc.text(`(-) Gastos Operativos:`, 160, currentOffsetY + 44);
    doc.text(`(${formatCurrency(totalOpExpenses)})`, 240, currentOffsetY + 44);

    doc.setDrawColor(148, 163, 184);
    doc.line(160, currentOffsetY + 47, 277, currentOffsetY + 47);

    doc.setFont("helvetica", "bold");
    doc.setTextColor(15, 23, 42);
    doc.setFontSize(9);
    doc.text(`(=) UTILIDAD NETA REAL:`, 160, currentOffsetY + 51);
    doc.text(`${formatCurrency(netProfit)}`, 240, currentOffsetY + 51);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(`      > Margen Neto Final:`, 160, currentOffsetY + 55);
    doc.text(`${netMarginPct.toFixed(1)}%`, 240, currentOffsetY + 55);

    // Línea divisoria analíticas
    doc.setDrawColor(148, 163, 184);
    doc.line(160, currentOffsetY + 59, 277, currentOffsetY + 59);

    let nextSectionY = currentOffsetY + 65;

    // Calcular ahorro en Alcancía en base a cierres de caja
    if (hasBaratillo) {
      const filteredClosures = state.cashClosures.filter(c => {
        const cDateStr = new Date(c.created_at).toISOString().split('T')[0];
        return cDateStr >= startVal && cDateStr <= endVal && (bizId === 'all' || c.business_id === bizId);
      });
      const totalSavings = filteredClosures.reduce((s, c) => s + (parseFloat(c.savings_amount) || 0), 0);
      
      const timeDiff = Math.abs(endMs - startMs);
      const dayCount = Math.max(1, Math.ceil(timeDiff / (1000 * 60 * 60 * 24)));
      const targetSavings = dayCount * 137000;
      
      const isGreen = totalSavings >= targetSavings;

      doc.setFontSize(8.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(isGreen ? 16 : 185, isGreen ? 185 : 28, isGreen ? 129 : 28);
      doc.text(`[+] ALCANCÍA (AHORRO PARA MANTENIMIENTO):`, 160, nextSectionY);
      doc.text(`${formatCurrency(totalSavings)}`, 240, nextSectionY);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(`      > Meta (${dayCount} días a $137k):`, 160, nextSectionY + 4);
      doc.text(`${formatCurrency(targetSavings)}`, 240, nextSectionY + 4);

      doc.setFont("helvetica", "bold");
      doc.setTextColor(isGreen ? 16 : 185, isGreen ? 185 : 28, isGreen ? 129 : 28);
      doc.text(`      > Estado Sede: ${isGreen ? '🟢 BIEN' : '🔴 NÚMEROS ROJOS / MAL'}`, 160, nextSectionY + 8);

      // Rediseñar divisor
      doc.setDrawColor(148, 163, 184);
      doc.line(160, nextSectionY + 12, 277, nextSectionY + 12);
      
      nextSectionY += 18;
    }

    // BLOQUE C: Métricas y Rendimiento Comercial
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);
    doc.setFont("helvetica", "bold");
    doc.text("[i] RENDIMIENTO Y MÉTRICAS COMERCIALES", 160, nextSectionY);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(`Total Transacciones (Facturas):`, 160, nextSectionY + 5);
    doc.text(`${totalTrx}`, 240, nextSectionY + 5);
    doc.text(`Ticket Promedio de Venta:`, 160, nextSectionY + 9);
    doc.text(`${formatCurrency(avgTicket)}`, 240, nextSectionY + 9);

    currentOffsetY = nextSectionY + 15;

    if (topSellers.length > 0) {
      doc.setFont("helvetica", "bold");
      doc.text(`Rendimiento por Asesor:`, 160, currentOffsetY);
      doc.setFont("helvetica", "normal");
      currentOffsetY += 4;
      topSellers.forEach(([seller, perf]) => {
         doc.setFontSize(7.5);
         doc.text(`      > ${seller}:`, 160, currentOffsetY);
         doc.text(`${formatCurrency(perf.total)} (${perf.count} ventas)`, 240, currentOffsetY);
         currentOffsetY += 4;
      });
    }

    if (topProducts.length > 0) {
      currentOffsetY += 2;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.text(`Top 3 Artículos Más Vendidos:`, 160, currentOffsetY);
      doc.setFont("helvetica", "normal");
      currentOffsetY += 4;
      topProducts.forEach(([prod, qty], index) => {
         doc.setFontSize(7.5);
         doc.text(`      ${index + 1}. ${prod}`, 160, currentOffsetY);
         doc.text(`${qty} unds.`, 240, currentOffsetY);
         currentOffsetY += 4;
      });
    }

    // 🚀 BÚNKER DE DESPACHO INDESTRUCTIBLE (NATIVO -> COMPARTIR -> DESCARGA)

    const rawBlob = doc.output('blob');
    const cleanBizName = bizName.replace(/[^a-zA-Z0-9]/g, '_');
    const safeName = `Auditoria_Ventas_${cleanBizName}_${startVal}.pdf`;
    const shareFile = new File([rawBlob], safeName, { type: 'application/pdf' });

    let isCompleted = false;

    // 1. Intento Nativo (Móvil/Emulador Capacitor)
    if (Capacitor.isNativePlatform()) {
      try {
        const base64 = doc.output('datauristring').split(',')[1];
        const writeResult = await Filesystem.writeFile({
          path: safeName,
          data: base64,
          directory: Directory.Cache,
          recursive: true
        });
        
        await Share.share({
          title: `Auditoría de Ventas J&M`,
          text: `Comparto planilla oficial de auditoría del local ${bizName}.`,
          url: writeResult.uri
        });
        
        isCompleted = true;
        window.showToast("✅ Enviado exitosamente al menú de compartir.", "success");
      } catch (nativeErr) {
        console.error("Fallo en despacho nativo de admin PDF:", nativeErr);
      }
    }

    // 2. Intento Web Standby
    if (!isCompleted) {
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [shareFile] })) {
        try {
          await navigator.share({
            files: [shareFile],
            title: `Auditoría de Ventas`,
            text: `Planilla administrativa.`
          });
          isCompleted = true;
          window.showToast("✅ Compartido con éxito.", "success");
        } catch (shareErr) {
          console.warn("Menú web omitido, procediendo a descarga física:", shareErr);
        }
      }

      if (!isCompleted) {
        try {
          doc.save(safeName);
          isCompleted = true;
          window.showToast("✅ Auditoría PDF descargada con éxito.", "success");
        } catch (saveErr) {
          console.error("Fallo doc.save() en Admin PDF:", saveErr);
          // Fallback extremo de ancla RAM
          const blobUrl = URL.createObjectURL(rawBlob);
          const tempLink = document.createElement('a');
          tempLink.href = blobUrl;
          tempLink.download = safeName;
          document.body.appendChild(tempLink);
          tempLink.click();
          document.body.removeChild(tempLink);
          window.showToast("✅ Descarga forzada completada.", "success");
        }
      }
    }

  } catch (error) {
    console.error("Error fatal en auditoría PDF Admin:", error);
    window.showToast("❌ Error crítico e inesperado al sintetizar la auditoría.", "danger");
  }
};

window.sendTelegramSalesReport = async (period, isHistorical = false, silent = false) => {
  try {
    if (!silent) window.showToast(`⏳ Generando reporte ${period} para Telegram...`, "info");

    const getBogotaDateStr = (date = new Date()) => {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      return formatter.format(date);
    };

    const now = new Date();
    let startMs, endMs, periodLabel, dateRangeLabel, periodId;

    if (isHistorical) {
      if (period === 'daily') {
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const yDateStr = getBogotaDateStr(yesterday);
        startMs = new Date(yDateStr + 'T00:00:00-05:00').getTime();
        endMs = new Date(yDateStr + 'T23:59:59-05:00').getTime();
        periodLabel = 'DIARIO (AYER)';
        dateRangeLabel = yDateStr;
        periodId = `daily_${yDateStr}`;
      } else if (period === 'weekly') {
        const day = now.getDay();
        const diffToMonday = now.getDate() - day + (day === 0 ? -6 : 1);
        const mondayThisWeek = new Date(now.getFullYear(), now.getMonth(), diffToMonday);
        const lastMonday = new Date(mondayThisWeek.getTime() - 7 * 24 * 60 * 60 * 1000);
        const lastSunday = new Date(lastMonday.getTime() + 6 * 24 * 60 * 60 * 1000);
        const lmStr = getBogotaDateStr(lastMonday);
        const lsStr = getBogotaDateStr(lastSunday);
        startMs = new Date(lmStr + 'T00:00:00-05:00').getTime();
        endMs = new Date(lsStr + 'T23:59:59-05:00').getTime();
        periodLabel = 'SEMANAL (SEMANA ANTERIOR)';
        dateRangeLabel = `${lmStr}_al_${lsStr}`;
        periodId = `weekly_${lmStr}_${lsStr}`;
      } else if (period === 'monthly') {
        const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonth = new Date(startThisMonth.getFullYear(), startThisMonth.getMonth() - 1, 1);
        const lastMonthEnd = new Date(startThisMonth.getTime() - 24 * 60 * 60 * 1000);
        const lmStr = getBogotaDateStr(lastMonth);
        const lmeStr = getBogotaDateStr(lastMonthEnd);
        startMs = new Date(lmStr + 'T00:00:00-05:00').getTime();
        endMs = new Date(lmeStr + 'T23:59:59-05:00').getTime();
        const year = lastMonth.getFullYear();
        const month = (lastMonth.getMonth() + 1).toString().padStart(2, '0');
        periodLabel = `MENSUAL (${year}-${month})`;
        dateRangeLabel = `${year}-${month}`;
        periodId = `monthly_${year}_${month}`;
      }
    } else {
      if (period === 'daily') {
        const todayStr = getBogotaDateStr(now);
        startMs = new Date(todayStr + 'T00:00:00-05:00').getTime();
        endMs = new Date(todayStr + 'T23:59:59-05:00').getTime();
        periodLabel = 'DIARIO (HOY)';
        dateRangeLabel = todayStr;
        periodId = `daily_live_${todayStr}`;
      } else if (period === 'weekly') {
        const day = now.getDay();
        const diffToMonday = now.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(now.getFullYear(), now.getMonth(), diffToMonday);
        const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);
        const mStr = getBogotaDateStr(monday);
        const sStr = getBogotaDateStr(sunday);
        startMs = new Date(mStr + 'T00:00:00-05:00').getTime();
        endMs = new Date(sStr + 'T23:59:59-05:00').getTime();
        periodLabel = 'SEMANAL (ESTA SEMANA)';
        dateRangeLabel = `${mStr}_al_${sStr}`;
        periodId = `weekly_live_${mStr}`;
      } else if (period === 'monthly') {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        const sStr = getBogotaDateStr(start);
        const eStr = getBogotaDateStr(end);
        startMs = new Date(sStr + 'T00:00:00-05:00').getTime();
        endMs = new Date(eStr + 'T23:59:59-05:00').getTime();
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        periodLabel = `MENSUAL (${year}-${month})`;
        dateRangeLabel = `${year}-${month}`;
        periodId = `monthly_live_${year}-${month}`;
      }
    }

    let filteredSales = state.sales.filter(sale => {
      const saleTime = new Date(sale.created_at).getTime();
      return saleTime >= startMs && saleTime <= endMs;
    });

    let filteredExpenses = state.transactions.filter(t => {
      if (t.type !== 'expense') return false;
      const tTime = new Date(t.date || t.created_at).getTime();
      return tTime >= startMs && tTime <= endMs;
    });

    if (filteredSales.length === 0 && filteredExpenses.length === 0) {
      if (!silent) window.showToast(`ℹ️ No se registraron movimientos en el periodo ${periodLabel}.`, "warning");
      return;
    }

    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, 297, 32, 'F');
    
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text(`SURTIHOGAR G&C - REPORTE DE VENTAS ${periodLabel}`, 15, 15);
    
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(148, 163, 184);
    doc.text("Planilla de Control y Resumen Financiero Consolidado • Telegram Auto-Report System", 15, 23);

    doc.setTextColor(30, 41, 59);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("DETALLE DEL PERIODO", 15, 45);
    
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(`Tipo de Reporte: ${periodLabel}`, 15, 51);
    doc.text(`Rango de Fechas: ${dateRangeLabel.replace(/_/g, ' ')}`, 15, 57);

    doc.setFont("helvetica", "bold");
    doc.text("AUDITORÍA DE TELEGRAM", 180, 45);
    doc.setFont("helvetica", "normal");
    doc.text(`Generado automáticamente para el canal administrativo`, 180, 51);
    doc.text(`Fecha de Emisión: ${new Date().toLocaleString('es-CO')}`, 180, 57);

    doc.setDrawColor(226, 232, 240);
    doc.line(15, 65, 282, 65);

    const head = [['REF / FECHA', 'SEDE', 'VENDEDOR', 'DETALLE DE PRODUCTOS', 'PAGO', 'TOTAL NETO']];
    const body = [];
    let totalRevenue = 0;
    let totalCost = 0;
    let totalUnits = 0;
    const paymentBreakdown = { Efectivo: 0, Sistecredito: 0, Addi: 0, 'Llano Gas': 0, Transferencia: 0, Daviplata: 0, 'Bonos Coopchipaque': 0 };
    
    filteredSales.forEach(sale => {
      const items = state.saleItems.filter(si => si.sale_id === sale.id);
      const bizIdsFromProducts = items.map(i => i.products?.business_id).filter(Boolean);
      const saleShortId = sale.id.slice(0, 5);
      const bizIdsFromTransactions = state.transactions.filter(t => t.note && t.note.includes(saleShortId)).map(t => t.business_id);
      const allBizIds = [...new Set([...bizIdsFromProducts, ...bizIdsFromTransactions])];
      const bizNames = allBizIds.map(id => state.businesses.find(b => b.id === id)?.name || 'General').join(', ');

      const sellerObj = state.employees?.find(emp => emp.id === sale.user_id) || (state.user?.id === sale.user_id ? state.user : null);
      const sellerName = sellerObj?.name || 'Asignado';
      const saleTotal = parseFloat(sale.total) || 0;

      let payMethod = sale.payment_method || 'Efectivo';
      if (payMethod.toLowerCase().includes('daviplata')) payMethod = 'Daviplata';
      else if (payMethod.toLowerCase().includes('nequi') || payMethod.toLowerCase().includes('transferencia')) payMethod = 'Transferencia';

      let productsLabel = items.map(i => {
        let pName = i.products?.name;
        let pCost = parseFloat(i.products?.cost) || 0;
        if (!pName) {
          const linkedProd = state.products.find(p => p.id === i.product_id);
          if (linkedProd) {
            pName = linkedProd.name;
            pCost = parseFloat(linkedProd.cost) || 0;
          }
        }
        if (!pName) {
          const pending = state.pendingProducts.find(pp => pp.sale_id === sale.id);
          if (pending) {
            pName = `${pending.name} (Pte.)`;
            pCost = parseFloat(pending.cost) || 0;
          } else if (sale.note && sale.note.includes('Venta informal')) {
            pName = sale.note.replace('Venta informal: ', '');
            pCost = 0;
          } else {
            pName = 'Producto Especial';
            pCost = 0;
          }
        }
        const itemQty = Number(i.quantity) || 1;
        totalUnits += itemQty;
        totalCost += (pCost * itemQty);
        return `${pName} [x${itemQty}]`;
      }).join(', ');

      if (!productsLabel && sale.note && sale.note.includes('Venta informal')) {
        productsLabel = sale.note.replace('Venta informal: ', '').trim() + ' (Directa)';
      }

      totalRevenue += saleTotal;
      if (!paymentBreakdown[payMethod]) paymentBreakdown[payMethod] = 0;
      paymentBreakdown[payMethod] += saleTotal;

      const dateObj = new Date(sale.created_at);
      const dateStr = `${dateObj.getDate().toString().padStart(2,'0')}/${(dateObj.getMonth()+1).toString().padStart(2,'0')} ${dateObj.getHours().toString().padStart(2,'0')}:${dateObj.getMinutes().toString().padStart(2,'0')}`;

      body.push([
        `#${sale.id.slice(0, 8).toUpperCase()}\n${dateStr}`,
        bizNames || 'J&M',
        sellerName,
        productsLabel || 'Venta directa en POS',
        payMethod.toUpperCase(),
        formatCurrency(saleTotal)
      ]);
    });

    autoTable(doc, {
      startY: 72,
      head: head,
      body: body,
      theme: 'grid',
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5, cellPadding: 4 },
      styles: { fontSize: 8, cellPadding: 3.5, font: 'helvetica', overflow: 'linebreak' },
      columnStyles: {
        0: { cellWidth: 35, fontStyle: 'bold' },
        1: { cellWidth: 35 },
        2: { cellWidth: 35 },
        3: { cellWidth: 120 },
        4: { cellWidth: 25, halign: 'center' },
        5: { halign: 'right', fontStyle: 'bold', cellWidth: 32 }
      }
    });

    if (filteredExpenses.length > 0) {
      let currentY = (doc.lastAutoTable ? doc.lastAutoTable.finalY : 72) + 15;
      if (currentY > 175) {
        doc.addPage();
        currentY = 20;
      }

      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(185, 28, 28);
      doc.text("📄 DESGLOSE DE EGRESOS Y GASTOS OPERATIVOS REGISTRADOS", 15, currentY);
      
      const expenseHead = [['REF / FECHA', 'SEDE / LOCAL', 'RESPONSABLE', 'MOTIVO / DETALLE', 'PAGO', 'MONTO GASTO']];
      const expenseBody = filteredExpenses.map(t => {
        const bizNameObj = state.businesses.find(b => b.id === t.business_id)?.name || 'General';
        const userObj = state.employees?.find(e => e.id === t.user_id) || (state.user?.id === t.user_id ? state.user : null);
        const userName = userObj?.name || 'Colaborador';
        const catName = state.categories.find(c => c.id === t.category_id)?.name || 'Gasto General';
        const desc = t.description ? `(${t.description})` : (t.note ? `(${t.note})` : '');
        const finalMotivo = `${catName} ${desc}`;
        const dateObj = new Date(t.date || t.created_at);
        const dateStr = `${dateObj.getDate().toString().padStart(2,'0')}/${(dateObj.getMonth()+1).toString().padStart(2,'0')} ${dateObj.getHours().toString().padStart(2,'0')}:${dateObj.getMinutes().toString().padStart(2,'0')}`;

        return [
          `#TRX-${(t.id || '').slice(0,6).toUpperCase()}\n${dateStr}`,
          bizNameObj,
          userName,
          finalMotivo,
          (t.payment_method || 'Efectivo').toUpperCase(),
          formatCurrency(parseFloat(t.amount) || 0)
        ];
      });

      autoTable(doc, {
        startY: currentY + 4,
        head: expenseHead,
        body: expenseBody,
        theme: 'grid',
        headStyles: { fillColor: [185, 28, 28], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5, cellPadding: 4 },
        styles: { fontSize: 8, cellPadding: 3.5, font: 'helvetica', overflow: 'linebreak' },
        columnStyles: {
          0: { cellWidth: 35, fontStyle: 'bold' },
          1: { cellWidth: 35 },
          2: { cellWidth: 35 },
          3: { cellWidth: 120 },
          4: { cellWidth: 25, halign: 'center' },
          5: { halign: 'right', fontStyle: 'bold', cellWidth: 32, textColor: [185, 28, 28] }
        }
      });
    }

    const finalY = (doc.lastAutoTable ? doc.lastAutoTable.finalY : 100) + 15;
    if (finalY > 135) {
      doc.addPage();
      doc.setPage(doc.getNumberOfPages());
    }
    const rectY = finalY > 135 ? 20 : finalY;

    let totalOpExpenses = 0;
    let cashExpenses = 0;
    filteredExpenses.forEach(t => {
       const amt = parseFloat(t.amount) || 0;
       totalOpExpenses += amt;
       if ((t.payment_method || 'Efectivo').toLowerCase() === 'efectivo') cashExpenses += amt;
    });

    const totalProfit = totalRevenue - totalCost;
    const profitMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;
    const netEbitda = totalRevenue - totalCost - totalOpExpenses;

    doc.setFillColor(241, 245, 249);
    doc.setDrawColor(203, 213, 225);
    doc.rect(15, rectY, 267, 58, 'FD');

    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("RESUMEN DE SALDOS FINANCIEROS DEL PERIODO", 20, rectY + 8);

    doc.setFontSize(8.5);
    doc.setFont("helvetica", "normal");
    doc.text(`• Total Ventas Netas: ${formatCurrency(totalRevenue)}`, 20, rectY + 16);
    doc.text(`• Costo de Mercancía (CMV): ${formatCurrency(totalCost)}`, 20, rectY + 23);
    
    doc.setFont("helvetica", "bold");
    doc.setTextColor(21, 128, 61);
    doc.text(`• Ganancia Real en Ventas: ${formatCurrency(totalProfit)}`, 20, rectY + 30);
    
    doc.setFont("helvetica", "normal");
    doc.setTextColor(15, 23, 42);
    doc.text(`• Ingresos en Efectivo: ${formatCurrency(cashRevenue)}`, 20, rectY + 37);
    doc.text(`• Ingresos en Digital: ${formatCurrency(digitalRevenue)}`, 20, rectY + 44);
    doc.text(`• Unidades Totales Despachadas: ${totalUnits} unds`, 20, rectY + 51);

    doc.text(`• Total Gastos Operativos: ${formatCurrency(totalOpExpenses)}`, 140, rectY + 16);
    doc.text(`• Gastos Pagados en Efectivo: ${formatCurrency(cashExpenses)}`, 140, rectY + 23);
    doc.text(`• Flujo Efectivo Caja (Efectivo Ventas - Gastos): ${formatCurrency(cashBalance)}`, 140, rectY + 30);
    
    doc.setFont("helvetica", "bold");
    doc.setTextColor(21, 128, 61);
    doc.text(`• Porcentaje de Ganancia: ${profitMargin.toFixed(1)}%`, 140, rectY + 37);
    
    doc.setTextColor(netEbitda >= 0 ? 21 : 185, netEbitda >= 0 ? 128 : 28, netEbitda >= 0 ? 61 : 28);
    doc.text(`• Excedente Neto Estimado: ${formatCurrency(netEbitda)}`, 140, rectY + 44);

    const { data: configs } = await supabase
      .from('system_logs')
      .select('message')
      .eq('type', 'TELEGRAM_CONFIG')
      .order('timestamp', { ascending: false })
      .limit(1);

    let config = null;
    if (configs && configs.length > 0) config = JSON.parse(configs[0].message);

    const botToken = (config && config.botToken) ? config.botToken : '8037545998:AAH4zgAxhoNbZ1WKJXmCElwq7oHzi7IJ1LY';
    const chatId = (config && config.chatId) ? config.chatId : '6736325362,8676279926';

    if (!botToken || !chatId) {
      console.warn("Falta token o chatid.");
      return;
    }

    const rawBlob = doc.output('blob');
    const cleanLabel = periodLabel.replace(/\s+/g, '_');
    const safeName = `Reporte_Ventas_${cleanLabel}_${dateRangeLabel}.pdf`;
    
    const chatIds = chatId.split(',').map(id => id.trim()).filter(Boolean);
    let anySuccess = false;
    let errorMsg = '';

    for (const id of chatIds) {
      try {
        const formData = new FormData();
        formData.append('chat_id', id);
        formData.append('caption', `📊 <b>REPORTE DE VENTAS ${periodLabel}</b>\n📅 Rango: <code>${dateRangeLabel.replace(/_/g, ' ')}</code>\n🕒 Generado: ${new Date().toLocaleString('es-CO')}\n💰 Total Ventas: <b>${formatCurrency(totalRevenue)}</b>\n🏷️ Costo Mercancía: <b>${formatCurrency(totalCost)}</b>\n📈 Ganancia Ventas (Utilidad): <b>${formatCurrency(totalProfit)} (${profitMargin.toFixed(1)}%)</b>\n🔻 Gastos: <b>${formatCurrency(totalOpExpenses)}</b>\n📈 Excedente Neto: <b>${formatCurrency(netEbitda)}</b>`);
        formData.append('parse_mode', 'HTML');
        formData.append('document', rawBlob, safeName);

        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
          method: 'POST',
          body: formData
        });
        const result = await res.json();
        if (result.ok) {
          anySuccess = true;
        } else {
          console.error(`Error Telegram para chat ${id}:`, result);
          errorMsg = result.description || 'Fallo de API';
        }
      } catch (err) {
        console.error(`Excepción enviando a Telegram chat ${id}:`, err);
        errorMsg = err.message;
      }
    }

    if (anySuccess) {
      // Registrar log local para blindaje contra duplicidad inmediata
      localStorage.setItem(`telegram_report_sent_v1_${periodId}`, 'true');

      if (!silent) window.showToast(`✅ Reporte ${periodLabel} enviado a Telegram!`, "success");
      
      try {
        await supabase.from('system_logs').insert({
          type: 'TELEGRAM_REPORT_SENT',
          module: 'Reportes',
          user_id: state.user?.id || null,
          message: JSON.stringify({ periodId, timestamp: new Date().toISOString() })
        });
      } catch(dbErr) {
        console.warn("Log de reporte enviado no guardado en Supabase (RLS), pero guardado localmente en localStorage:", dbErr.message);
      }
    } else {
      if (!silent) window.showToast(`❌ Error enviando a Telegram: ${errorMsg}`, "danger");
    }
  } catch (err) {
    console.error("Error enviando reporte a Telegram:", err);
    if (!silent) window.showToast("❌ Error al generar o enviar el reporte PDF.", "danger");
  }
};

window.runAutomaticTelegramReports = async () => {
  if (state.user?.role !== 'admin') return;
  if (state.runningAutoReports) return;
  state.runningAutoReports = true;

  try {
    const getBogotaDateStr = (date = new Date()) => {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      return formatter.format(date);
    };

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: sentLogs } = await supabase
      .from('system_logs')
      .select('message')
      .eq('type', 'TELEGRAM_REPORT_SENT')
      .gte('timestamp', thirtyDaysAgo.toISOString());

    const sentSet = new Set();
    if (sentLogs) {
      sentLogs.forEach(l => {
        try {
          const parsed = JSON.parse(l.message);
          if (parsed && parsed.periodId) sentSet.add(parsed.periodId);
        } catch(e) {}
      });
    }

    const now = new Date();

    // A. Reporte Diario de AYER
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yDateStr = getBogotaDateStr(yesterday);
    const dailyId = `daily_${yDateStr}`;
    const localSentDaily = localStorage.getItem(`telegram_report_sent_v1_${dailyId}`) === 'true';
    if (!localSentDaily && !sentSet.has(dailyId)) {
      console.log(`[AUTO_REPORT] Enviando reporte diario para ${yDateStr}...`);
      await window.sendTelegramSalesReport('daily', true, true);
    }

    // B. Reporte Semanal (Solo Lunes)
    // 0 = Domingo, 1 = Lunes, etc.
    const dayOfWeek = now.getDay();
    if (dayOfWeek === 1) {
      const mondayThisWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek + 1);
      const lastMonday = new Date(mondayThisWeek.getTime() - 7 * 24 * 60 * 60 * 1000);
      const lastSunday = new Date(lastMonday.getTime() + 6 * 24 * 60 * 60 * 1000);
      const lmStr = getBogotaDateStr(lastMonday);
      const lsStr = getBogotaDateStr(lastSunday);
      const weeklyId = `weekly_${lmStr}_${lsStr}`;
      const localSentWeekly = localStorage.getItem(`telegram_report_sent_v1_${weeklyId}`) === 'true';

      if (!localSentWeekly && !sentSet.has(weeklyId)) {
        console.log(`[AUTO_REPORT] Enviando reporte semanal para la semana ${lmStr} al ${lsStr}...`);
        await window.sendTelegramSalesReport('weekly', true, true);
      }
    }

    // C. Reporte Mensual (Solo día 1)
    const bogotaTodayStr = getBogotaDateStr(now);
    const dayOfMonth = parseInt(bogotaTodayStr.split('-')[2]);
    if (dayOfMonth === 1) {
      const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastMonth = new Date(startThisMonth.getFullYear(), startThisMonth.getMonth() - 1, 1);
      const year = lastMonth.getFullYear();
      const month = (lastMonth.getMonth() + 1).toString().padStart(2, '0');
      const monthlyId = `monthly_${year}_${month}`;
      const localSentMonthly = localStorage.getItem(`telegram_report_sent_v1_${monthlyId}`) === 'true';

      if (!localSentMonthly && !sentSet.has(monthlyId)) {
        console.log(`[AUTO_REPORT] Enviando reporte mensual para el mes ${year}-${month}...`);
        await window.sendTelegramSalesReport('monthly', true, true);
      }
    }
  } catch(e) {
    console.error("[AUTO_REPORT] Error en comprobador de reportes:", e);
  } finally {
    state.runningAutoReports = false;
  }
};

window.fetchSuppliers = async () => {
  state.loading = true;
  state.view = 'loading';
  render();
  try {
    state.suppliers = await SupplierService.loadAll(state.user?.id);
    state.view = 'suppliers_admin';
  } catch(e) {
    console.error("No se pudieron cargar los proveedores:", e);
    state.view = 'manager_dashboard';
    window.showToast("No se pudo cargar los proveedores.", "warning");
  } finally {
    state.loading = false;
    render();
  }
};

window.saveSuppliers = async () => {
  const ok = await SupplierService.saveAll(state.suppliers || [], state.user?.id);
  if (ok) {
    window.showToast("✅ Proveedores guardados con éxito", "success");
  } else {
    window.showToast("⚠️ Error al guardar en base de datos", "warning");
  }
};

window.openPos = () => {
  state.view = 'pos';
  state.cart = [];
  state.posSearch = '';
  render();
};

window.state = state;
window.render = render;

fetchData();

window.uploadPhoto = async (file, bucket = 'photos') => {
  if (!file || !file.size || file.size === 0) return null;
  try {
    const fileExt = (file.name && file.name.includes('.')) ? file.name.split('.').pop() : 'png';
    const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}.${fileExt}`;
    const filePath = `${fileName}`;
    
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(filePath, file);

    if (uploadError) {
      console.warn('Error al subir imagen (no bloqueante):', uploadError);
      return null;
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
    return data ? data.publicUrl : null;
  } catch (err) {
    console.warn('Excepción al subir foto (no bloqueante):', err);
    return null;
  }
};


window.saveQuickSale = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const originalHtml = btn.innerHTML;
  
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> VENDIENDO...';
    
    const formData = new FormData(e.target);
    const name = formData.get('name');
    const price = window.getCleanNumber(formData.get('price'));
    const quantity = window.getCleanNumber(formData.get('quantity'));
    const discount = window.getCleanNumber(formData.get('discount')) || 0;
    const photoFile = formData.get('photo');
    
    const grossTotal = price * quantity;
    const total = Math.max(0, grossTotal - discount);
    const noteStr = discount > 0 
      ? `Venta informal: ${name} (Descuento aplicado: $${discount.toLocaleString('es-CO')})` 
      : `Venta informal: ${name}`;

    const paymentMethod = formData.get('payment_method') || 'Efectivo';

    // BLOQUEO DE SEGURIDAD: Venta Rápida (Excluye Admin)
    const isAdmin = state.user?.role === 'admin';
    if (!isAdmin && state.user?.role !== 'admin' && !state.activeShiftBusinessId) {
      window.showToast("⛔ No tienes turno activo para registrar esta mercancía.", "danger");
      return;
    }

    // 1. Subir foto (Opcional - Nunca bloquea la venta)
    let photoUrl = null;
    if (photoFile && photoFile.size > 0) {
      photoUrl = await window.uploadPhoto(photoFile, 'pending_products');
    }

    // 2. Crear Venta
    const { data: sale, error: saleErr } = await supabase.from('sales').insert({
      user_id: state.user.id,
      total: total,
      note: noteStr,
      payment_method: paymentMethod
    }).select().single();

    if (saleErr) throw saleErr;

    // 3. Crear Item de Venta (product_id NULL)
    const { error: itemErr } = await supabase.from('sale_items').insert({
      sale_id: sale.id,
      product_id: null,
      quantity: quantity,
      price: price
    });

    if (itemErr) throw itemErr;

    // 4. Registrar Producto Pendiente
    const pendingPayload = {
      name,
      photo_url: photoUrl,
      created_by: state.user.id,
      sale_id: sale.id,
      quantity,
      price
    };
    const genderVal = formData.get('gender');
    if (genderVal) pendingPayload.gender = genderVal;
    const { error: pendingErr } = await supabase.from('pending_products').insert(pendingPayload);

    if (pendingErr) throw pendingErr;
    
    // 5. Crear Transacción Contable para Venta Rápida (Con Fallback)
    let saleBusId = state.activeShiftBusinessId || state.user.business_id;
    if (!saleBusId && state.businesses.length > 0) saleBusId = state.businesses[0].id;

    if (saleBusId) {
      const ventaCat = state.categories.find(c => c.name === 'Venta' && c.type === 'income');
      const { error: trxErr } = await supabase.from('transactions').insert({
        amount: total,
        type: 'income',
        category_id: ventaCat ? ventaCat.id : null,
        business_id: saleBusId,
        user_id: state.user.id,
        date: new Date().toISOString(),
        description: `Venta Rápida: ${name}`,
        payment_method: paymentMethod
      });
      if (trxErr) console.error("Error balance venta rápida:", trxErr);
    }

    window.showToast('✅ Venta rápida registrada con éxito', 'success');
    state.activeModal = null;
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    alert('Error al procesar venta rápida: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
};

window.convertToRealProduct = (pendingId) => {
  const pending = state.pendingProducts.find(p => p.id === pendingId);
  if (!pending) return;

  state.fromPending = true;
  state.selectedPendingProductId = pendingId;
  state.activeModal = 'new_product';
  render();
};

window.saveExpense = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]') || e.target.querySelector('button');
  const originalHtml = btn.innerHTML;
  
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> GUARDANDO...';
    
    const formData = new FormData(e.target);
    const rawAmount = formData.get('amount');
    const categoryId = formData.get('category');
    const description = formData.get('description') || '';
    const businessId = formData.get('business') || state.activeShiftBusinessId;

    // Sanitización Profesional del Monto
    const cleanAmount = typeof rawAmount === 'string' ? rawAmount.replace(/\./g, '').replace(',', '.') : rawAmount;
    const parsedAmount = parseFloat(cleanAmount);

    if (!parsedAmount || parsedAmount <= 0) {
      throw new Error("El monto ingresado no es válido.");
    }

    if (!businessId) {
      throw new Error("No se detectó una sede o turno activo para este gasto.");
    }

    const photoFile = formData.get('photo');

    // Subida de Foto Profesional (Si existe)
    let photoUrl = null;
    if (photoFile && photoFile.size > 0) {
      btn.innerHTML = '<span class="loading-spinner"></span> SUBIENDO FOTO...';
      photoUrl = await window.uploadPhoto(photoFile, 'expenses');
    }

    btn.innerHTML = '<span class="loading-spinner"></span> REGISTRANDO CONTABILIDAD...';

    // REGISTRO DEFINITIVO EN LIBRO MAYOR (transactions)
    const { error } = await supabase.from('transactions').insert({
      amount: parsedAmount,
      type: 'expense',
      business_id: businessId,
      category_id: categoryId,
      user_id: state.user.id,
      date: new Date().toISOString(),
      description: description,
      note: photoUrl ? `[CON COMPROBANTE: ${photoUrl}]` : null
    });

    if (error) throw error;

    window.showToast('✅ Gasto registrado exitosamente en la contabilidad.', 'success');
    state.activeModal = null;
    
    // Refrescar datos de inmediato
    await window.fetchData();
    render();

  } catch (err) {
    console.error("FALLO EN REGISTRO DE GASTO:", err);
    window.showToast('❌ Error al registrar el gasto: ' + (err.message || 'Problema de red'), 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
};


window.updateInventoryInfo = (productId) => {
  const infoDiv = document.getElementById('inventory-prod-info');
  if (!infoDiv) return;
  const p = state.products.find(item => item.id === productId);
  if (p) {
    infoDiv.innerHTML = `ðŸ“¦ Stock actual: ${p.stock} | ðŸ’µ íšltimo costo: ${formatCurrency(p.cost || 0)}`;
  } else {
    infoDiv.innerHTML = '';
  }
};

window.saveInventoryIn = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const originalHtml = btn.innerHTML;
  
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> REGISTRANDO...';
    
    const formData = new FormData(e.target);
    const productId = formData.get('product_id');
    const quantity = window.getCleanNumber(formData.get('quantity'));
    const cost = window.getCleanNumber(formData.get('cost'));
    const note = formData.get('note');

    const { error } = await supabase.from('inventory_movements').insert({
      product_id: productId,
      type: 'in',
      quantity: quantity,
      cost: cost,
      user_id: state.user.id,
      note: note
    });

    if (error) throw error;
    
    alert('Inventario actualizado con éxito');
    state.activeModal = null;
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    alert('Error al registrar inventario: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
};

// --- SUITE DE PRUEBAS QA ---
window.logQa = (name, status, message) => {
  state.qaResults.unshift({ name, status, message, date: new Date().toISOString() });
  render();
};

window.runAllTests = async () => {
  state.qaResults = [];
  await window.testNormalSale();
  await window.testStockManagement();
  window.showToast("✅ Suite completa terminada", "success");
};

window.testNormalSale = async () => {
  try {
    window.logQa("Venta Normal", "RUNNING", "Iniciando simulación de venta...");
    
    // 1. Crear producto temporal
    const testName = `TEST-PROD-${Date.now()}`;
    const { data: prod, error: pErr } = await supabase.from('products').insert({
      name: testName, price: 1000, cost: 500, stock: 10
    }).select().single();
    if (pErr) throw pErr;

    // 2. Realizar Venta
    const { data: sale, error: sErr } = await supabase.from('sales').insert({
      user_id: state.user.id, total: 2000
    }).select().single();
    if (sErr) throw sErr;

    const { error: iErr } = await supabase.from('sale_items').insert({
      sale_id: sale.id, product_id: prod.id, quantity: 2, price: 1000
    });
    if (iErr) throw iErr;

    // 3. Validar Stock (Esperar a trigger)
    await new Promise(r => setTimeout(r, 1500));
    const { data: updatedProd } = await supabase.from('products').select('stock').eq('id', prod.id).single();

    if (updatedProd.stock === 8) {
      window.logQa("Venta Normal", "PASSED", `Stock deducido correctamente: ${updatedProd.stock}`);
    } else {
      window.logQa("Venta Normal", "FAILED", `Error en deducción de stock. Esperado: 8, Obtenido: ${updatedProd.stock}`);
    }

    // Limpiar test
    await supabase.from('products').delete().eq('id', prod.id);

  } catch (err) {
    window.logQa("Venta Normal", "FAILED", err.message);
  }
};

window.testStockManagement = async () => {
  try {
    window.logQa("Carga Inventario", "RUNNING", "Validando entrada de stock...");

    // 1. Crear producto temporal para prueba limpia
    const testName = `TEST-STOCK-${Date.now()}`;
    const { data: prod, error: pErr } = await supabase.from('products').insert({
      name: testName, price: 1000, cost: 500, stock: 5
    }).select().single();
    if (pErr) throw pErr;

    const oldStock = Number(prod.stock);
    const addQty = 10;

    // 2. Insertar movimiento
    const { error: mErr } = await supabase.from('inventory_movements').insert({
      product_id: prod.id, type: 'in', quantity: addQty, cost: 2000, user_id: state.user.id
    });
    if (mErr) throw mErr;

    await new Promise(r => setTimeout(r, 1500));
    const { data: updatedProd } = await supabase.from('products').select('stock').eq('id', prod.id).single();

    if (Number(updatedProd.stock) === oldStock + addQty) {
      window.logQa("Carga Inventario", "PASSED", `Entrada exitosa. Stock final: ${updatedProd.stock}`);
    } else {
      window.logQa("Carga Inventario", "FAILED", `Stock no coincide. Esperado: ${oldStock + addQty}, Obtenido: ${updatedProd.stock}`);
    }

    // Limpiar test
    await supabase.from('products').delete().eq('id', prod.id);

  } catch (err) {
    window.logQa("Carga Inventario", "FAILED", err.message);
  }
};

window.purgeStagingData = async () => {
  if (!confirm("🚨 ¡ADVERTENCIA CRÍTICA DE PRODUCCIÓN!\n\nEsta acción eliminará permanentemente:\n- TODOS los turnos de prueba\n- TODOS los productos e inventarios creados hasta hoy\n- TODAS las ventas, ítems de ventas y el historial de movimientos\n- TODOS los registros de auditoría central\n- TODOS los logs y dispositivos\n\n¿Estás 100% seguro de que deseas vaciar la base de datos para empezar de cero?")) return;
  
  const secondConfirm = prompt("Escribe 'BORRAR' en mayúsculas para confirmar la purga definitiva de la base de datos:");
  if (secondConfirm !== 'BORRAR') {
    window.showToast("Operación cancelada", "info");
    return;
  }

  state.loading = true;
  window.render();

  try {
    window.showToast("⏳ Iniciando purga de datos relacionales...", "info");
    
    // 1. Detalle de Ventas (sale_items) — debe ir antes que sales por FK
    const { error: e1 } = await supabase.from('sale_items').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e1) throw e1;

    // 2. Ventas (sales) — historial de auditoría central y listado de movimientos
    const { error: e1b } = await supabase.from('sales').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e1b) throw e1b;
    
    // 3. Movimientos de Kárdex (inventory_movements)
    const { error: e2 } = await supabase.from('inventory_movements').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e2) throw e2;
    
    // 4. Transacciones de Caja (transactions)
    const { error: e3 } = await supabase.from('transactions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e3) throw e3;

    // 4. Turnos Abiertos/Cerrados (shifts)
    const { error: e4 } = await supabase.from('shifts').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e4) throw e4;

    // 5. Catálogo de Productos (products)
    const { error: e5 } = await supabase.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e5) throw e5;

    // 6. Latidos BYOD (device_heartbeats)
    const { error: e6 } = await supabase.from('device_heartbeats').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e6) console.warn('[PURGE] device_heartbeats:', e6.message);

    // 7. Logs GPS / Asistencia — columna "Marcación Real (GPS)" en nómina
    const { error: e7a } = await supabase.from('system_logs').delete().eq('type', 'GEOLOCATION_TRACK');
    if (e7a) console.warn('[PURGE] GEOLOCATION_TRACK:', e7a.message);

    // 8. Alertas de geocerca y seguridad
    const { error: e7b } = await supabase.from('system_logs').delete().eq('type', 'SECURITY_ALERT');
    if (e7b) console.warn('[PURGE] SECURITY_ALERT:', e7b.message);

    // 9. Auditoría de productividad
    const { error: e7c } = await supabase.from('system_logs').delete().eq('type', 'PRODUCTIVITY_AUDIT');
    if (e7c) console.warn('[PURGE] PRODUCTIVITY_AUDIT:', e7c.message);

    // 10. Cierres de caja y configuraciones
    const { error: e7d } = await supabase.from('system_logs').delete().eq('type', 'CASH_CLOSURE');
    if (e7d) console.warn('[PURGE] CASH_CLOSURE:', e7d.message);

    // 11. Cualquier log restante (si RLS lo permite)
    await supabase.from('system_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    // 12. MARCADOR LÓGICO DE PURGA: Debido a que Supabase RLS bloquea los DELETE en system_logs,
    // insertamos un marcador para que la nómina y el mapa ignoren los datos anteriores a este punto.
    await supabase.from('system_logs').insert({ 
      type: 'PURGE_EVENT', 
      module: 'sistema', 
      message: 'Limpieza de pruebas ejecutada', 
      user_id: state.user.id 
    });

    window.showToast("🎯 BASE DE DATOS LIMPIA. GPS, ventas, auditoría y nómina reiniciados. Lista para producción.", "success");
    
  } catch(err) {
    console.error("Purge execution error:", err);
    window.showToast("❌ Error crítico de base de datos: " + err.message, "danger");
  } finally {
    state.loading = false;
    await window.fetchData();
  }
};

window.saveNewBusiness = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const orig = btn.innerHTML;
  
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> GUARDANDO...';
    
    const fd = new FormData(e.target);
    const name = fd.get('name');
    const type = fd.get('type');
    
    // Referenciar coordenadas base de un negocio existente para evitar fallos en GPS
    let baseLat = 4.1447;
    let baseLng = -73.6275;
    if (state.businesses && state.businesses.length > 0) {
       const ref = state.businesses.find(b => b.lat && b.lng);
       if (ref) {
          baseLat = ref.lat;
          baseLng = ref.lng;
       }
    }

    const { data, error } = await supabase.from('businesses').insert({
      name,
      type,
      lat: baseLat,
      lng: baseLng,
      geofence_radius_meters: 150
    }).select();

    if (error) throw error;

    window.showToast(`✅ Negocio "${name}" creado con éxito`, "success");
    state.activeModal = null;
    
    // Recargar todos los datos del sistema para propagar cambios
    await window.fetchData();
    
  } catch(err) {
    console.error(err);
    window.showToast("⚠️ Error: " + err.message, "warning");
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
};

window.updateMarginCalc = () => {
  const price = window.getCleanNumber(document.getElementById('new-prod-price')?.value);
  const cost = window.getCleanNumber(document.getElementById('new-prod-cost')?.value);
  const badge = document.getElementById('margin-badge');
  if (!badge) return;

  if (price > 0) {
    const margin = ((price - cost) / price) * 100;
    badge.innerText = `Margen Estimado: ${margin.toFixed(1)}%`;
    badge.style.background = margin > 30 ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)';
    badge.style.color = margin > 30 ? 'var(--success)' : 'var(--danger)';
  } else {
    badge.innerText = 'Margen Estimado: 0%';
    badge.style.background = '#f1f5f9';
    badge.style.color = 'var(--text-muted)';
  }
};

window.fillFromPending = (id) => {
  const pending = state.pendingProducts.find(p => p.id === id);
  if (!pending) return;
  const nameInput = document.getElementById('new-prod-name');
  const priceInput = document.getElementById('new-prod-price');
  if (nameInput) nameInput.value = pending.name;
  if (priceInput) priceInput.value = pending.price;
  window.updateMarginCalc();
};

window.deletePendingProduct = async (id) => {
  if (!confirm("¿Estás seguro de que deseas eliminar este producto pendiente de formalización?")) return;
  try {
    const { error } = await supabase.from('pending_products').delete().eq('id', id);
    if (error) throw error;
    window.showToast("✅ Producto pendiente eliminado", "success");
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("⚠️ Error: " + err.message, "danger");
  }
};

window.deleteProduct = async (id) => {
  if (!confirm("¿Estás seguro de que deseas eliminar este producto permanentemente del inventario? Esta acción no se puede deshacer y fallará si el producto tiene ventas asociadas.")) return;
  try {
    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) {
      if (error.code === '23503') {
        throw new Error("No se puede eliminar este producto porque ya tiene ventas o movimientos de inventario registrados.");
      }
      throw error;
    }
    window.showToast("✅ Producto eliminado del inventario", "success");
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("⚠️ " + err.message, "danger");
  }
};

window.replicateSelectedWeek = async () => {
  if (!state.rosterConfig || !state.rosterConfig.startDate) {
    window.showToast("⚠️ No hay una fecha seleccionada.", "danger");
    return;
  }
  
  // Encontrar el lunes de la semana seleccionada
  const selectedDate = new Date(state.rosterConfig.startDate + 'T00:00:00');
  const day = selectedDate.getDay();
  const monday = new Date(selectedDate);
  monday.setDate(selectedDate.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);
  
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  
  // Buscar turnos locales en esa semana
  const currentWeekShifts = (state.shifts || []).filter(s => {
    const d = new Date(s.start_time);
    return d >= monday && d <= sunday;
  });
  
  if (currentWeekShifts.length === 0) {
    alert("No hay turnos registrados en esta semana para replicar.");
    return;
  }
  
  if (!confirm(`Se copiarán los ${currentWeekShifts.length} turnos de la semana del ${monday.toLocaleDateString()} a las próximas 4 semanas en el futuro.\n\n⚠️ ¡Atención!: Esto eliminará cualquier turno previamente planificado en esas fechas de destino. ¿Deseas continuar?`)) {
    return;
  }
  
  try {
    window.showToast("⏳ Replicando turnos...", "info");
    
    // Rango de fechas a eliminar y re-crear en las próximas 4 semanas
    const deleteStart = new Date(monday);
    deleteStart.setDate(monday.getDate() + 7); // Empieza el lunes siguiente
    
    const deleteEnd = new Date(monday);
    deleteEnd.setDate(monday.getDate() + 7 + 27); // 4 semanas completas
    deleteEnd.setHours(23, 59, 59, 999);
    
    // 1. Eliminar turnos existentes en el rango de destino
    const { error: delErr } = await supabase
      .from('shifts')
      .delete()
      .gte('start_time', deleteStart.toISOString())
      .lte('start_time', deleteEnd.toISOString());
      
    if (delErr) throw delErr;
    
    // 2. Generar turnos clonados para cada una de las 4 semanas
    const shiftsToInsert = [];
    
    for (let w = 1; w <= 4; w++) {
      const daysOffset = w * 7;
      
      currentWeekShifts.forEach(s => {
        const origStart = new Date(s.start_time);
        const origEnd = new Date(s.end_time);
        
        const start = new Date(origStart);
        start.setDate(origStart.getDate() + daysOffset);
        
        const end = new Date(origEnd);
        end.setDate(origEnd.getDate() + daysOffset);
        
        shiftsToInsert.push({
          user_id: s.user_id,
          business_id: s.business_id,
          start_time: start.toISOString(),
          end_time: end.toISOString()
        });
      });
    }
    
    // 3. Insertar los nuevos turnos en batches
    if (shiftsToInsert.length > 0) {
      const BATCH_SIZE = 50;
      for (let i = 0; i < shiftsToInsert.length; i += BATCH_SIZE) {
        const batch = shiftsToInsert.slice(i, i + BATCH_SIZE);
        const { error: insErr } = await supabase.from('shifts').insert(batch);
        if (insErr) throw insErr;
      }
    }
    
    window.showToast("✅ Turnos replicados exitosamente para las próximas 4 semanas.", "success");
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("⚠️ Error replicando turnos: " + err.message, "danger");
  }
};

window.copySupplierOrderText = () => {
  const selectedBusId = state.selectedInventoryAIBusinessId || 'all';
  const targetDays = state.inventoryAITargetDays || 15;
  const selectedBusName = selectedBusId === 'all' 
    ? 'Todas las Sedes' 
    : (state.businesses.find(b => b.id === selectedBusId)?.name || 'Sede');

  const analysis = analyzeInventoryAI({
    products: state.products || [],
    sales: state.sales || [],
    saleItems: state.saleItems || [],
    businessId: selectedBusId,
    targetDays
  });

  const orderText = generateSupplierOrderText(analysis.replenishmentOrders, selectedBusName);

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(orderText).then(() => {
      window.showToast('📋 ¡Orden de compra copiada al portapapeles!', 'success');
    }).catch(() => {
      window.showToast('⚠️ No se pudo copiar automáticamente.', 'warning');
    });
  }
};

window.runGeminiInventoryAnalysis = async () => {
  const selectedBusId = state.selectedInventoryAIBusinessId || 'all';
  const targetDays = state.inventoryAITargetDays || 15;
  const selectedBusName = selectedBusId === 'all' 
    ? 'Todas las Sedes' 
    : (state.businesses.find(b => b.id === selectedBusId)?.name || 'Sede');

  const apiKey = state.geminiApiKey || localStorage.getItem('gemini_api_key') || '';

  const container = document.getElementById('gemini-result-container');
  if (container) {
    container.innerHTML = `<div style="text-align:center; padding:15px; color:#818cf8; font-weight:800; font-size:13px;">⚡ Analizando inventarios con Google Gemini IA... Por favor espera...</div>`;
  }

  const analysis = analyzeInventoryAI({
    products: state.products || [],
    sales: state.sales || [],
    saleItems: state.saleItems || [],
    businessId: selectedBusId,
    targetDays
  });

  try {
    const resultText = await fetchGeminiInventoryAnalysis({
      analysis,
      businessName: selectedBusName,
      apiKey
    });

    state.geminiAnalysisResult = resultText;
    window.showToast('✨ Diagnóstico de Gemini IA generado con éxito', 'success');
    render();
  } catch (err) {
    console.error('Error Gemini IA:', err);
    if (container) {
      container.innerHTML = `<div style="color:#f87171; font-weight:700; text-align:center; padding:10px;">⚠️ Error de Gemini IA: ${err.message}</div>`;
    }
    window.showToast('❌ Error llamando a Gemini IA: ' + err.message, 'danger');
  }
};

window.editIdealStock = async (id, currentVal) => {
  const newValStr = prompt("Ingresa el nuevo Stock Fijo / Ideal para este producto (el inventario que siempre deseas mantener):", currentVal);
  if (newValStr === null) return;
  const newVal = parseInt(newValStr, 10);
  if (isNaN(newVal) || newVal < 0) {
    window.showToast("⚠️ Debes ingresar un número válido mayor o igual a 0.", "danger");
    return;
  }
  
  try {
    const { error } = await supabase
      .from('products')
      .update({ purchase_price: newVal })
      .eq('id', id);
      
    if (error) throw error;
    window.showToast("✅ Stock Fijo / Ideal actualizado", "success");
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("⚠️ Error: " + err.message, "danger");
  }
};

window.autoReplenishStock = async () => {
  // Encontrar productos que tengan stock menor al ideal (purchase_price > stock) y purchase_price > 0
  const lowStockProducts = (state.products || []).filter(p => (p.purchase_price || 0) > 0 && p.stock < p.purchase_price);
  
  if (lowStockProducts.length === 0) {
    alert("Todos los productos tienen su stock completo según el Stock Fijo / Ideal configurado.");
    return;
  }
  
  if (!confirm(`Se detectaron ${lowStockProducts.length} productos con stock menor al nivel fijo.\n\n¿Deseas agregarlos automáticamente a la lista de compras con la cantidad necesaria para completarlos?`)) {
    return;
  }
  
  try {
    window.showToast("⏳ Agregando a la lista...", "info");
    
    // Generar items para insertar en la tabla shopping_list
    const itemsToInsert = [];
    
    for (const p of lowStockProducts) {
      const neededQty = p.purchase_price - p.stock;
      
      // Comprobar si ya existe este producto pendiente en la lista de compras para no duplicar
      const alreadyListed = (state.shoppingList || []).some(item => 
        item.status === 'pending' && 
        item.business_id === p.business_id && 
        item.name.toLowerCase().includes(p.name.toLowerCase())
      );
      
      if (!alreadyListed) {
        itemsToInsert.push({
          name: `${p.name} (Rellenar stock)`,
          quantity: neededQty,
          business_id: p.business_id,
          created_by: state.user.id,
          status: 'pending'
        });
      }
    }
    
    if (itemsToInsert.length === 0) {
      window.showToast("✅ Los artículos ya estaban agregados en la lista de compras.", "success");
      return;
    }
    
    const { error } = await supabase.from('shopping_list').insert(itemsToInsert);
    if (error) throw error;
    
    window.showToast(`✅ Se agregaron ${itemsToInsert.length} artículos a la lista de compras`, "success");
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("⚠️ Error auto-rellenando stock: " + err.message, "danger");
  }
};

window.syncAllIdealStocksToCurrent = async () => {
  if (!confirm("⚠️ ¿Estás seguro de que deseas establecer el Stock Fijo/Ideal de TODOS los productos igual a su Stock Actual?\n\nEsto sobrescribirá tus configuraciones actuales de stock fijo.")) {
    return;
  }
  
  try {
    window.showToast("⏳ Actualizando stocks fijos...", "info");
    
    // Obtener los productos locales
    const products = state.products || [];
    
    for (const p of products) {
      const { error } = await supabase
        .from('products')
        .update({ purchase_price: p.stock })
        .eq('id', p.id);
        
      if (error) console.error(`Error actualizando ${p.name}:`, error);
    }
    
    window.showToast("✅ Todos los stocks fijos se actualizaron al stock actual", "success");
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("⚠️ Error: " + err.message, "danger");
  }
};

window.previewAndReplenishSold = async () => {
  const startVal = document.getElementById('replenish-start-date')?.value;
  const endVal = document.getElementById('replenish-end-date')?.value;
  
  if (!startVal || !endVal) {
    alert("Por favor selecciona ambas fechas.");
    return;
  }
  
  const start = new Date(startVal + 'T00:00:00');
  const end = new Date(endVal + 'T23:59:59');
  
  try {
    window.showToast("⏳ Consultando ventas...", "info");
    
    // 1. Obtener todas las ventas creadas en el rango de fechas
    const { data: sales, error: sErr } = await supabase
      .from('sales')
      .select('id, created_at')
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString());
      
    if (sErr) throw sErr;
    
    if (!sales || sales.length === 0) {
      alert(`No se registraron ventas en el rango desde el ${start.toLocaleDateString()} hasta el ${end.toLocaleDateString()}.`);
      return;
    }
    
    const saleIds = sales.map(s => s.id);
    
    // 2. Obtener todos los items vendidos
    const { data: items, error: iErr } = await supabase
      .from('sale_items')
      .select('product_id, quantity, price')
      .in('sale_id', saleIds);
      
    if (iErr) throw iErr;
    
    if (!items || items.length === 0) {
      alert("No se encontraron artículos vendidos en las ventas de este período.");
      return;
    }
    
    // 3. Agrupar por product_id y sumar cantidad sold
    const soldTotals = {};
    items.forEach(item => {
      if (!item.product_id) return; // Omitir ventas rápidas sin producto asociado
      if (!soldTotals[item.product_id]) {
        soldTotals[item.product_id] = 0;
      }
      soldTotals[item.product_id] += (item.quantity || 0);
    });
    
    const productIds = Object.keys(soldTotals);
    if (productIds.length === 0) {
      alert("No hay productos con registro oficial vendidos en este período.");
      return;
    }
    
    // 4. Buscar nombres de productos para mostrar en el diálogo
    const { data: prods, error: pErr } = await supabase
      .from('products')
      .select('id, name, business_id')
      .in('id', productIds);
      
    if (pErr) throw pErr;
    
    // 5. Preparar la confirmación con el listado
    const listDescription = prods.map(p => {
      const qty = soldTotals[p.id];
      const bizName = state.businesses.find(b => b.id === p.business_id)?.name || 'General';
      return `• ${p.name} (Sede: ${bizName}) -> Cantidad vendida: ${qty}`;
    }).join('\n');
    
    if (!confirm(`Se encontraron ${prods.length} productos vendidos entre el ${start.toLocaleDateString()} y el ${end.toLocaleDateString()}:\n\n${listDescription}\n\n¿Deseas agregar estos artículos faltantes a la lista de compras semanal?`)) {
      return;
    }
    
    // 6. Insertar en la lista de compras
    const itemsToInsert = [];
    
    for (const p of prods) {
      const qty = soldTotals[p.id];
      
      // Evitar duplicar si ya existe el pendiente idéntico
      const alreadyListed = (state.shoppingList || []).some(item => 
        item.status === 'pending' && 
        item.business_id === p.business_id && 
        item.name.toLowerCase().includes(p.name.toLowerCase())
      );
      
      if (!alreadyListed) {
        itemsToInsert.push({
          name: `${p.name} (Reponer ventas)`,
          quantity: qty,
          business_id: p.business_id,
          created_by: state.user.id,
          status: 'pending'
        });
      }
    }
    
    if (itemsToInsert.length === 0) {
      window.showToast("✅ Los artículos ya estaban agregados en la lista de compras.", "success");
      return;
    }
    
    const { error: insErr } = await supabase.from('shopping_list').insert(itemsToInsert);
    if (insErr) throw insErr;
    
    window.showToast(`✅ Se agregaron ${itemsToInsert.length} artículos a la lista de compras`, "success");
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("⚠️ Error: " + err.message, "danger");
  }
};

window.saveShoppingItem = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const orig = btn.innerHTML;
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> AGREGANDO...';
    
    const formData = new FormData(e.target);
    const name = formData.get('name');
    const quantity = parseInt(formData.get('quantity'), 10) || 1;
    const businessId = formData.get('business_id');
    
    const { error } = await supabase.from('shopping_list').insert({
      name,
      quantity,
      business_id: businessId,
      created_by: state.user.id,
      status: 'pending'
    });
    
    if (error) throw error;
    
    window.showToast("✅ Agregado a la lista de compras", "success");
    e.target.reset();
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("⚠️ Error: " + err.message, "danger");
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
};

window.toggleShoppingItemStatus = async (id, newStatus) => {
  try {
    const { error } = await supabase
      .from('shopping_list')
      .update({ status: newStatus })
      .eq('id', id);
      
    if (error) throw error;
    
    window.showToast(newStatus === 'completed' ? "✓ Producto comprado" : "📌 Producto marcado como pendiente", "success");
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("⚠️ Error al actualizar estado: " + err.message, "danger");
  }
};

window.deleteShoppingItem = async (id) => {
  if (!confirm("¿Seguro que deseas eliminar este producto de la lista?")) return;
  try {
    const { error } = await supabase
      .from('shopping_list')
      .delete()
      .eq('id', id);
      
    if (error) throw error;
    
    window.showToast("🗑️ Producto eliminado de la lista", "success");
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("⚠️ Error al eliminar: " + err.message, "danger");
  }
};

window.toggleNewSupplierField = (val) => {
  const block = document.getElementById('quick-supplier-block');
  if (block) {
    block.style.display = val === 'NEW_SUPPLIER' ? 'block' : 'none';
  }
};

window.saveNewProduct = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const originalHtml = btn.innerHTML;
  
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> FORMALIZANDO...';
    
    const formData = new FormData(e.target);
    const name = formData.get('name');
    const price = window.getCleanNumber(formData.get('price'));
    const cost = window.getCleanNumber(formData.get('cost'));
    const stock = window.getCleanNumber(formData.get('stock'));
    const purchase_price = window.getCleanNumber(formData.get('purchase_price')) || 0;
    const busId = formData.get('business_id');
    const pendingId = formData.get('pending_id');

    const supplierIndex = formData.get('supplier_index');
    const newSupplierName = formData.get('new_supplier_name')?.trim();
    const newSupplierPhone = formData.get('new_supplier_phone')?.trim();

    if (!busId) throw new Error("Debes seleccionar una sede para este producto.");

    // A. Vincular Proveedor (Mantener al día qué vende cada proveedor automáticamente)
    let supplierNameForNote = '';
    if (supplierIndex === 'NEW_SUPPLIER' && newSupplierName) {
      state.suppliers = state.suppliers || [];
      state.suppliers.push({
        name: newSupplierName,
        phone: newSupplierPhone || '',
        products_sold: name,
        debt: 0,
        cash_purchases: 0
      });
      await window.saveSuppliers();
      supplierNameForNote = newSupplierName;
    } else if (supplierIndex !== "" && supplierIndex !== null && state.suppliers && state.suppliers[supplierIndex]) {
      const sup = state.suppliers[supplierIndex];
      let curr = (sup.products_sold || "").trim();
      if (!curr.toLowerCase().includes(name.toLowerCase())) {
        sup.products_sold = curr ? (curr + ", " + name) : name;
      }
      await window.saveSuppliers();
      supplierNameForNote = sup.name;
    }

    // 1. Crear el producto (Stock inicial siempre 0 para trazabilidad vía movement)
    const productPayload = { name, price, cost, stock: 0, purchase_price, business_id: busId, created_by: state.user.id };
    const genderVal = formData.get('gender');
    if (genderVal) productPayload.gender = genderVal;
    const { data: prod, error: pErr } = await supabase.from('products').insert(productPayload).select().single();

    if (pErr) throw pErr;

    // 2. Registrar Movimiento de Inventario si hay stock inicial
    if (stock > 0) {
      const { error: mErr } = await supabase.from('inventory_movements').insert({
        product_id: prod.id,
        business_id: busId,
        type: 'in',
        quantity: stock,
        cost: cost,
        user_id: state.user.id,
        note: supplierNameForNote ? `Stock inicial - Prov: ${supplierNameForNote}` : 'Stock inicial en registro oficial'
      });
      if (mErr) throw mErr;
    }

    // 3. Si viene de un producto pendiente, limpiar y vincular
    if (pendingId) {
      const pending = state.pendingProducts.find(p => p.id === pendingId);
      if (pending) {
        // Vincular sale_items anteriores que tengan product_id NULL
        const { error: uErr } = await supabase.from('sale_items')
          .update({ product_id: prod.id })
          .is('product_id', null)
          .eq('sale_id', pending.sale_id);
        
        if (uErr) console.warn("No se pudieron vincular algunos sale_items:", uErr);

        // Eliminar de pendientes
        await supabase.from('pending_products').delete().eq('id', pendingId);
      }
    }

    window.showToast('✅ Producto formalizado con éxito', 'success');
    state.activeModal = null;
    state.fromPending = false;
    state.selectedPendingProductId = null;
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast('â Œ Error: ' + err.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
};

window.toggleInventoryPermission = async (userId, currentStatus) => {
  try {
    const { error } = await supabase.from('users')
      .update({ can_manage_inventory: !currentStatus })
      .eq('id', userId);
    
    if (error) throw error;
    
    window.showToast('✅ Permiso de inventario actualizado', 'success');
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast('❌ Error al actualizar permiso: ' + err.message, 'danger');
  }
};

window.toggleAdminPermission = async (userId, currentRole) => {
  try {
    const newRole = currentRole === 'admin' ? 'colaborador' : 'admin';
    const { error } = await supabase.from('users')
      .update({ role: newRole })
      .eq('id', userId);
    
    if (error) throw error;
    
    window.showToast(`✅ Rol de administrador ${newRole === 'admin' ? 'asignado' : 'retirado'} exitosamente`, 'success');
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast('❌ Error al actualizar rol: ' + err.message, 'danger');
  }
};

window.updateUserBusiness = async (userId, businessId) => {
  try {
    const { error } = await supabase.from('users')
      .update({ business_id: businessId || null })
      .eq('id', userId);
      
    if (error) throw error;
    window.showToast('✅ Negocio asignado correctamente', 'success');
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast('âŒ Error al asignar negocio: ' + err.message, 'danger');
  }
};

window.toggleCashierPermission = async (userId, currentStatus) => {
  try {
    const { error } = await supabase.from('users')
      .update({ is_cashier: !currentStatus })
      .eq('id', userId);
    
    if (error) throw error;
    
    window.showToast('✅ Permiso de cajero actualizado', 'success');
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast('❌ Error al actualizar permiso: ' + err.message, 'danger');
  }
};

window.toggleInventoryPermission = async (userId, currentStatus) => {
  try {
    const { error } = await supabase.from('users')
      .update({ can_manage_inventory: !currentStatus })
      .eq('id', userId);
    
    if (error) throw error;
    
    window.showToast('✅ Permiso de inventario actualizado', 'success');
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast('âŒ Error al actualizar permiso: ' + err.message, 'danger');
  }
};

window.updateUserHourlyRate = async (userId, rate) => {
  try {
    const { error } = await supabase.from('users')
      .update({ hourly_rate: parseFloat(rate) || 0 })
      .eq('id', userId);
    
    if (error) throw error;
    
    window.showToast('✅ Tarifa horaria actualizada', 'success');
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast('â Œ Error al actualizar tarifa: ' + err.message, 'danger');
  }
};

window.editHourlyRate = (userId, userName) => {
  const user = state.employees.find(e => e.id === userId);
  state.editingRateUser = user;
  state.activeModal = 'edit_rate';
  render();
};

window.saveRateModal = async (e) => {
  e.preventDefault();
  const rate = e.target.querySelector('input[name="rate"]').value;
  if (state.editingRateUser) {
    await window.updateUserHourlyRate(state.editingRateUser.id, rate);
    state.activeModal = null;
    state.editingRateUser = null;
    const shiftsList = document.getElementById('shifts-list');
    if (shiftsList) shiftsList.innerHTML = '<div class="col-span-full text-center py-4"><i class="fas fa-spinner fa-spin text-2xl text-blue-500"></i></div>';

    render();
  }
};
window.setupRealtime = () => {
  if (!state.user?.id) return;
  console.log("ðŸ›°ï¸  Iniciando Sincronización Realtime para:", state.user.name);

  // CANAL GLOBAL: Escuchar cualquier cambio relevante
  supabase
    .channel('system_sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, async (payload) => {
      console.log('âš¡ Cambio en TURNOS detectado:', payload);
      await window.fetchData();
      render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'users', filter: `id=eq.${state.user.id}` }, async (payload) => {
      console.log('👤 Cambio en PERFIL detectado:', payload);
      await window.fetchData();
      render();
    })
    .subscribe((status) => {
      console.log("ðŸ“¡ Estado del canal Realtime:", status);
    });
};

// ============================================================
// BUSCADOR INTELIGENTE POS — Fuzzy + Multi-word + Ranking
// ============================================================

// Utilidad: distancia de Levenshtein simplificada (fuzzy)
window._levenshtein = (a, b) => {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[b.length][a.length];
};

// Utilidad: resaltar coincidencias en el nombre
window._highlightMatch = (text, query) => {
  if (!query || query.trim() === '') return text;
  const words = query.trim().toLowerCase().split(/\s+/);
  let result = text;
  words.forEach(w => {
    if (w.length < 2) return;
    const regex = new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(regex, '<mark style="background:#fde68a;color:#92400e;border-radius:3px;padding:0 2px;">$1</mark>');
  });
  return result;
};

// Motor de búsqueda inteligente: puntúa y ordena productos
window._smartSearch = (products, query) => {
  if (!query || query.trim() === '') return products.map(p => ({ product: p, score: 0, highlighted: p.name }));

  const q = query.trim().toLowerCase();
  const qClean = q.replace(/[.,]/g, '');
  const words = q.split(/\s+/).filter(w => w.length > 0);

  return products.map(p => {
    const name = p.name.toLowerCase();
    const barcode = (p.barcode || '').toLowerCase();
    const priceStr = String(p.price || '');
    let score = 0;

    // 1. Coincidencia exacta de nombre completo → máxima prioridad
    if (name === q) score += 1000;
    // Coincidencia exacta de precio (limpiando puntos/comas)
    else if (qClean && !isNaN(qClean) && priceStr === qClean) score += 950;
    // 2. El nombre EMPIEZA con la búsqueda
    else if (name.startsWith(q)) score += 500;
    // 3. El nombre CONTIENE la búsqueda entera
    else if (name.includes(q)) score += 300;
    // El precio contiene la búsqueda
    else if (qClean && !isNaN(qClean) && qClean.length >= 3 && priceStr.includes(qClean)) score += 250;

    // 4. Multi-word: cada palabra que se encuentre en el nombre suma puntos, o si es un número y coincide con el precio
    let allWordsMatch = true;
    words.forEach(w => {
      const wClean = w.replace(/[.,]/g, '');
      const isNum = wClean && !isNaN(wClean) && wClean.length >= 3;

      if (name.includes(w)) {
        score += 100;
        // Bonus si el nombre empieza con esa palabra o una de sus palabras empieza con ella
        const nameWords = name.split(/\s+/);
        if (nameWords.some(nw => nw.startsWith(w))) score += 50;
      } else if (isNum && (priceStr === wClean || priceStr.startsWith(wClean))) {
        score += 150; // Coincidencia de precio parcial/total por palabra
      } else {
        allWordsMatch = false;
        // 5. Fuzzy: si la palabra no se encuentra exacta, probar distancia Levenshtein
        const nameWords = name.split(/\s+/);
        const bestDist = Math.min(...nameWords.map(nw => window._levenshtein(w, nw.substring(0, w.length + 2))));
        const threshold = w.length <= 3 ? 1 : 2; // tolerancia según longitud
        if (bestDist <= threshold) {
          score += 40 - (bestDist * 10);
        }
      }
    });
    if (allWordsMatch && words.length > 1) score += 200; // Bonus si TODAS las palabras coinciden

    // 6. Código de barras
    if (barcode && barcode.includes(q)) score += 800;

    return {
      product: p,
      score,
      highlighted: window._highlightMatch(p.name, query)
    };
  })
  .filter(r => r.score > 0)
  .sort((a, b) => b.score - a.score);
};

// Debounce: esperar 150ms después de la última tecla
let _posSearchTimer = null;
window.handlePosSearch = (val) => {
  state.posSearch = val;
  clearTimeout(_posSearchTimer);
  _posSearchTimer = setTimeout(() => {
    const grid = document.getElementById('pos-product-grid');
    if (grid) {
      grid.innerHTML = window.renderPosProducts();
    }
  }, 150);
};

window.renderPosProducts = () => {
  let results = window._smartSearch(state.products, state.posSearch);
  
  // Filtro por género (solo para J&M)
  if (state.posGenderFilter && state.posGenderFilter !== 'all') {
    results = results.filter(r => r.product.gender === state.posGenderFilter);
  }
  
  if (results.length === 0) {
    const q = state.posSearch.trim();
    const genderMsg = state.posGenderFilter !== 'all' ? `<br>Filtro activo: <b>${state.posGenderFilter === 'hombre' ? '👨 Hombre' : state.posGenderFilter === 'mujer' ? '👩 Mujer' : '⚧️ Unisex'}</b>` : '';
    return `<div style="grid-column:1/-1; text-align:center; padding:50px 20px;">
      <div style="font-size:40px; margin-bottom:15px;">🔍</div>
      <p style="font-weight:700; font-size:16px; color:#334155; margin-bottom:8px;">${q ? `No se encontró "${q}"` : 'Sin productos en esta categoría'}</p>
      <p style="color:#94a3b8; font-size:13px; line-height:1.5;">Intenta con menos letras o revisa la ortografía.${genderMsg}</p>
    </div>`;
  }
  
  return results.map(r => {
    const p = r.product;
    const stockColor = p.stock <= 0 ? '#ef4444' : p.stock < 5 ? '#f59e0b' : '#10b981';
    const stockLabel = p.stock <= 0 ? '⚠️ AGOTADO' : `${p.stock} uds`;
    const isLowStock = p.stock <= 0;
    const genderBadge = p.gender === 'hombre' ? '<span style="display:inline-block; font-size:8px; background:#dbeafe; color:#1d4ed8; padding:2px 6px; border-radius:5px; font-weight:800; margin-left:4px;">👨 H</span>' : p.gender === 'mujer' ? '<span style="display:inline-block; font-size:8px; background:#fce7f3; color:#be185d; padding:2px 6px; border-radius:5px; font-weight:800; margin-left:4px;">👩 M</span>' : p.gender === 'unisex' ? '<span style="display:inline-block; font-size:8px; background:#ede9fe; color:#6d28d9; padding:2px 6px; border-radius:5px; font-weight:800; margin-left:4px;">⚧️ U</span>' : '';
    
    return `
    <div class="card" onclick="${isLowStock ? '' : `window.addToCart('${p.id}')`}" 
      style="cursor:${isLowStock ? 'not-allowed' : 'pointer'}; padding:15px; min-height:150px; height:100%; margin-bottom:0; border-radius:16px; display:flex; flex-direction:column; justify-content:space-between; transition:all 0.15s ease; border:1px solid ${isLowStock ? '#fecaca' : '#e2e8f0'}; ${isLowStock ? 'opacity:0.6;' : ''} position:relative; overflow:hidden;"
      ${isLowStock ? '' : 'onmouseenter="this.style.transform=\'translateY(-3px)\';this.style.boxShadow=\'0 8px 25px rgba(0,0,0,0.1)\'"  onmouseleave="this.style.transform=\'none\';this.style.boxShadow=\'none\'"'}>
      ${r.score >= 300 && state.posSearch.trim() ? '<div style="position:absolute; top:0; right:0; background:#10b981; color:white; font-size:8px; font-weight:800; padding:3px 8px; border-radius:0 0 0 8px;">MEJOR RESULTADO</div>' : ''}
      <div>
        <span style="display:inline-block; font-size:9px; font-weight:800; text-transform:uppercase; color:#4f46e5; background:#e0e7ff; padding:3px 8px; border-radius:6px; margin-bottom:8px; border:1px solid #c7d2fe;">🏬 ${p.businesses?.name || 'Sin asignar'}</span>
        <p style="font-weight:700; font-size:15px; margin-bottom:5px; line-height:1.3;">${r.highlighted}${genderBadge}</p>
        <p style="color:var(--text-muted); font-size:12px;">Stock: <span style="color:${stockColor}; font-weight:700;">${stockLabel}</span></p>
      </div>
      <p style="font-size:18px; font-weight:800; color:var(--primary); margin-top:10px;">${formatCurrency(p.price)}</p>
    </div>
  `}).join('');
};

const originalRender = render;
window.render = () => {
  try {
    originalRender();
    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    console.error("ERROR CRí TICO EN RENDER:", err);
    document.getElementById('app').innerHTML = `
      <div style="padding:40px; text-align:center; color:var(--danger);">
        <h2>âš ï¸  Error de Visualización</h2>
        <p>${err.message}</p>
        <button onclick="location.reload()" class="btn-primary" style="margin-top:20px;">REINICIAR APLICACIí“N</button>
      </div>
    `;
  }
};
window.executePayrollCalculation = async () => {
  const empSelect = document.getElementById('payroll-emp');
  const startInput = document.getElementById('payroll-start');
  const endInput = document.getElementById('payroll-end');

  if (!empSelect || !startInput || !endInput) return;

  state.payrollFilters = {
    employeeId: empSelect.value,
    startDate: startInput.value,
    endDate: endInput.value
  };

  await window.calculatePayroll();
};

window.calculatePayroll = async () => {
  const btn = document.querySelector('button[onclick="window.executePayrollCalculation()"]');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="spin" style="width:16px;"></i> CALCULANDO...';
    if (window.lucide) window.lucide.createIcons();
  }

  try {
    if (!state.payrollFilters) {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      state.payrollFilters = {
        employeeId: 'all',
        startDate: first.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0]
      };
    }

    const results = {};
    const startLimit = new Date(state.payrollFilters.startDate + 'T00:00:00').toISOString();
    const endLimit = new Date(state.payrollFilters.endDate + 'T23:59:59').toISOString();

    // 0. Obtener timestamp del último evento de "Limpiar Pruebas" para ignorar logs viejos bloqueados por RLS
    const { data: purgeLogs } = await supabase.from('system_logs')
      .select('timestamp')
      .eq('type', 'PURGE_EVENT')
      .order('timestamp', { ascending: false })
      .limit(1);
    const lastPurgeTime = purgeLogs?.[0]?.timestamp;

    // 1. Extraer bitácora de GPS dentro del rango temporal del calendario
    let gpsQuery = supabase
      .from('system_logs')
      .select('*')
      .eq('type', 'GEOLOCATION_TRACK')
      .gte('timestamp', startLimit)
      .lte('timestamp', endLimit);

    if (lastPurgeTime) {
      gpsQuery = gpsQuery.gt('timestamp', lastPurgeTime);
    }

    const { data: gpsLogs } = await gpsQuery.order('timestamp', { ascending: true });

    // Procesar para cada empleado
    state.employees.forEach(emp => {
      // 0. EXCLUSIÓN DE CUENTAS DE PRUEBA (Para mantener limpia la vista de producción)
      const lowerName = emp.name.toLowerCase();
      if (lowerName.includes('tester') || lowerName.includes('selenium') || lowerName.includes('empleado') || lowerName.includes('sebastian')) return;

      // 1. FILTRO POR NEGOCIO: Si estamos en una sede específica, solo mostrar personal de esa sede
      if (state.currentBusinessId !== 'all' && emp.business_id && emp.business_id !== state.currentBusinessId) return;

      // A. PLANILLA FIJA (Horas programadas en turnos de la base de datos)
      const empShifts = state.shifts.filter(s => {
        if (s.user_id !== emp.id || !s.end_time) return false;
        // Filtrar por negocio si no estamos en vista global
        if (state.currentBusinessId !== 'all' && s.business_id !== state.currentBusinessId) return false;
        
        const shiftStart = new Date(s.start_time);
        return shiftStart >= new Date(startLimit) && shiftStart <= new Date(endLimit);
      });

      const totalHours = empShifts.reduce((acc, s) => {
        const start = new Date(s.start_time);
        const end = new Date(s.end_time);
        return acc + (end - start) / (1000 * 60 * 60);
      }, 0);

      // B. MARCACIÓN REAL (Horas reales basadas en el primer GPS Entrada y último GPS Salida del día)
      let gpsHours = 0;
      if (gpsLogs) {
        // Filtrar logs por empleado Y por negocio actual (si aplica)
        const empGps = gpsLogs.filter(l => {
          if (l.user_id !== emp.id) return false;
          if (state.currentBusinessId !== 'all') {
            try {
              const ctx = JSON.parse(l.message).context;
              if (ctx && ctx.businessId !== state.currentBusinessId) return false;
            } catch(e) { return false; }
          }
          return true;
        });
        const dailyPairs = {};

        empGps.forEach(log => {
          let msgText = '';
          try {
            msgText = JSON.parse(log.message).text || '';
          } catch(e) { msgText = log.message || ''; }

          const isArr = msgText.includes('LLEGADA');
          const logTime = new Date(log.timestamp);

          // Tratamiento de horario nocturno idéntico al dashboard de asistencia
          let groupDate = new Date(log.timestamp);
          if (!isArr && logTime.getHours() < 6) {
            groupDate = new Date(logTime.getTime() - 12 * 60 * 60 * 1000);
          }

          const key = `${groupDate.getFullYear()}-${String(groupDate.getMonth()+1).padStart(2,'0')}-${String(groupDate.getDate()).padStart(2,'0')}`;
          if (!dailyPairs[key]) dailyPairs[key] = { arrival: null, departure: null };

          if (isArr) {
            if (!dailyPairs[key].arrival || logTime < dailyPairs[key].arrival) {
              dailyPairs[key].arrival = logTime;
            }
          } else {
            if (!dailyPairs[key].departure || logTime > dailyPairs[key].departure) {
              dailyPairs[key].departure = logTime;
            }
          }
        });

        // Acumular tiempo total por cada par diario consolidado
        Object.values(dailyPairs).forEach(pair => {
          if (pair.arrival && pair.departure && pair.departure > pair.arrival) {
            // DOBLE VALIDACIÓN: Solo sumar si el log pertenece al negocio actual o si estamos en vista global
            // Se asume que el log ya fue filtrado arriba por el negocio en el filter de empGps
            gpsHours += (pair.departure - pair.arrival) / (1000 * 60 * 60);
          }
        });
      }

      // D. FILTRO DE VISIBILIDAD: Solo incluir si tiene actividad en ESTE negocio
      if (totalHours > 0 || gpsHours > 0) {
        results[emp.id] = {
          hours: totalHours,
          gpsHours: gpsHours,
          scheduledPay: totalHours * (parseFloat(emp.hourly_rate) || 0),
          pay: gpsHours * (parseFloat(emp.hourly_rate) || 0),
          shiftsCount: empShifts.length
        };
      }
    });

    state.payrollData = results;
    window.showToast('📊 Auditoría cruzada de nómina finalizada con éxito', 'success');
  } catch(e) {
    console.error("Payroll calculation error:", e);
    window.showToast('Error calculando nómina: ' + e.message, 'danger');
  } finally {
    render();
  }
};

window.syncOfflineLogs = async () => {
  if (!navigator.onLine) return;
  const offlineLogs = JSON.parse(localStorage.getItem('offline_gps_logs') || '[]');
  if (offlineLogs.length === 0) return;
  
  try {
    for (const log of offlineLogs) {
      await supabase.from('system_logs').insert(log);
    }
    localStorage.removeItem('offline_gps_logs');
    window.showToast("✅ Logs offline sincronizados con éxito.", "success");
  } catch(e) {
    console.error("Fallo al sincronizar offline", e);
  }
};
window.addEventListener('online', window.syncOfflineLogs);
setTimeout(window.syncOfflineLogs, 3000); // Intento inicial al cargar la app

window.getDistanceInMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // Radio de la Tierra en metros
  const φ1 = lat1 * Math.PI/180; 
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c; // Distancia en metros
};

// 📐 FUNCIÓN DE VALIDACIÓN DE PUNTO EN POLÍGONO (Ray-casting)
window.isPointInPolygon = (point, polygon) => {
  const x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

// 📡 BYOD TACTICAL DASHBOARD - MAPA INTERACTIVO LEAFLET
window.initByodMap = () => {
  const container = document.getElementById('byod-leaflet-map');
  if (!container || typeof L === 'undefined') {
    console.warn("[BYOD_MAP] Contenedor de mapa o librería Leaflet no disponibles.");
    return;
  }

  // Prevenir instanciaciones múltiples
  if (window.byodLeafletInstance) {
    try {
      window.byodLeafletInstance.remove();
    } catch(e) {}
    window.byodLeafletInstance = null;
  }
  // Limpiar el registro de marcadores al reiniciar el mapa
  window.byodMarkerRegistry = {};

  // Resolver locales con GPS válido
  const validSedes = (state.businesses || []).filter(b => b.lat && b.lng);
  
  // Centrado inicial por defecto (Bogotá) si no hay locales creados
  let centerLat = 4.60971;
  let centerLng = -74.08175;

  if (validSedes.length > 0) {
    centerLat = validSedes[0].lat;
    centerLng = validSedes[0].lng;
  }

  try {
    // 1. Inicializar Mapa
    const map = L.map('byod-leaflet-map', {
      zoomControl: true,
      fadeAnimation: true
    }).setView([centerLat, centerLng], 16);
    window.byodLeafletInstance = map;

    // 2. Tile Layer (Estilo Moderno y Limpio: CartoDB Voyager)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: 'J&M &copy; CartoDB'
    }).addTo(map);

    const bounds = [];

    // 3. Dibujar Geocercas (Zonas Seguras)
    (state.businesses || []).forEach(s => {
      const poly = state.geofencePolygons?.[s.id];
      if (poly && poly.length >= 3) {
        L.polygon(poly, {
          color: '#10b981',
          fillColor: '#10b981',
          fillOpacity: 0.12,
          weight: 2,
          dashArray: '6, 8'
        }).addTo(map).bindPopup(`<b>📍 SEDE: ${s.name}</b><br>Geocerca: <b>Medida Exacta</b>`);
        poly.forEach(p => bounds.push(p));
      } else if (s.lat && s.lng) {
        const radius = s.geofence_radius_meters || 100;
        L.circle([s.lat, s.lng], {
          color: '#10b981',
          fillColor: '#10b981',
          fillOpacity: 0.12,
          weight: 2,
          dashArray: '6, 8'
        }).addTo(map).bindPopup(`<b>📍 SEDE: ${s.name}</b><br>Radio seguro: <b>${radius} metros</b>`);
        bounds.push([s.lat, s.lng]);
      }
    });

    // 4. Dibujar Colaboradores Activos
    const latestByEmployee = {};
    (state.byodHeartbeats || []).forEach(hb => {
      if (!latestByEmployee[hb.user_id] && hb.lat && hb.lng) {
        latestByEmployee[hb.user_id] = hb;
      }
    });

    Object.values(latestByEmployee).forEach(hb => {
      const emp = state.employees?.find(e => e.id === hb.user_id) || (state.user?.id === hb.user_id ? state.user : null);
      const name = emp?.name || 'Colaborador';
      
      const activeShift = (state.byodActiveShifts || []).find(s => s.user_id === hb.user_id);
      const biz = activeShift?.businesses || validSedes.find(b => b.id === activeShift?.business_id);
      
      let isOutside = false;
      if (biz) {
        const poly = state.geofencePolygons?.[biz.id];
        if (poly && poly.length >= 3) {
          isOutside = !window.isPointInPolygon([hb.lat, hb.lng], poly);
        } else if (biz.lat && biz.lng) {
          const dist = window.getDistanceInMeters(hb.lat, hb.lng, biz.lat, biz.lng);
          isOutside = dist > (biz.geofence_radius_meters || 100);
        }
      }

      const color = isOutside ? '#ef4444' : '#3b82f6';
      const customClass = isOutside ? 'marker-pulse-red' : '';

      // Crear Marcador con Inicial Flotante
      const icon = L.divIcon({
        className: 'custom-div-icon',
        html: `<div class="${customClass}" style="background:${color}; color:white; width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:12px; border:3px solid white; box-shadow:0 4px 10px rgba(0,0,0,0.25); transition: background 0.3s;">${name.charAt(0).toUpperCase()}</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
      });

      const lastPing = new Date(hb.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

      L.marker([hb.lat, hb.lng], { icon })
        .addTo(map)
        .bindPopup(`
          <div style="font-family:sans-serif; font-size:12px;">
            <b style="font-size:13px; color:#1e293b;">👤 ${name}</b><br>
            <span style="display:inline-block; margin-top:4px; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:bold; color:white; background:${isOutside ? '#ef4444':'#10b981'};">
              ${isOutside ? '🔴 FUERA DE RANGO':'🟢 DENTRO DE SEDE'}
            </span><br>
            <span style="color:#64748b; display:block; margin-top:5px;">⚡ Batería: <b>${hb.battery_level || 0}%</b></span>
            <span style="color:#64748b;">⏱️ Reporte: <b>${lastPing}</b></span>
          </div>
        `);
      
      bounds.push([hb.lat, hb.lng]);
    });

    // 5. Auto-escalar zoom para encuadrar todo
    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [50, 50] });
    }

  } catch(err) {
    console.error("[BYOD_MAP] Error de renderizado:", err);
  }
};

// 🔴 ACTUALIZA MARCADORES EN EL MAPA SIN DESTRUIRLO (sin parpadeo)
window.updateByodMarkers = (latestByEmployee) => {
  const map = window.byodLeafletInstance;
  if (!map || typeof L === 'undefined') return;
  if (!window.byodMarkerRegistry) window.byodMarkerRegistry = {};

  const buildLiveIcon = (name, color, isOutside) => L.divIcon({
    className: 'custom-div-icon',
    html: `<div class="${isOutside ? 'marker-pulse-red' : ''}" style="background:${color}; color:white; width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:13px; border:3px solid white; box-shadow:0 4px 12px rgba(0,0,0,0.3); transition: background 0.4s;">${name.charAt(0).toUpperCase()}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });

  Object.values(latestByEmployee).forEach(hb => {
    const emp = (state.employees || []).find(e => e.id === hb.user_id);
    const name = emp?.name || 'Colaborador';

    // Evaluar geocerca en tiempo real
    const activeShift = (state.byodActiveShifts || []).find(s => s.user_id === hb.user_id);
    const bizId = activeShift?.business_id;
    const biz = (state.businesses || []).find(b => b.id === bizId);
    let isOutside = false;
    if (biz && hb.lat && hb.lng) {
      const poly = state.geofencePolygons?.[biz.id];
      if (poly && poly.length >= 3) {
        isOutside = !window.isPointInPolygon([hb.lat, hb.lng], poly);
      } else if (biz.lat && biz.lng) {
        const dist = window.getDistanceInMeters(hb.lat, hb.lng, biz.lat, biz.lng);
        isOutside = dist > (biz.geofence_radius_meters || 100);
      }
    }

    const color = isOutside ? '#ef4444' : '#3b82f6';
    const newLatLng = L.latLng(hb.lat, hb.lng);
    const lastPing = new Date(hb.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const popupHtml = `
      <div style="font-family:sans-serif; font-size:12px; min-width:150px;">
        <b style="font-size:13px; color:#1e293b;">👤 ${name}</b><br>
        <span style="display:inline-block; margin-top:4px; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:bold; color:white; background:${isOutside ? '#ef4444':'#10b981'};">
          ${isOutside ? '🔴 FUERA DE RANGO' : '🟢 DENTRO DE SEDE'}
        </span><br>
        <span style="color:#64748b; display:block; margin-top:5px;">⚡ Batería: <b>${hb.battery_level || 0}%</b></span>
        <span style="color:#64748b;">⏱️ Último pulso: <b>${lastPing}</b></span>
      </div>`;

    if (window.byodMarkerRegistry[hb.user_id]) {
      // Mover marcador existente suavemente
      window.byodMarkerRegistry[hb.user_id].setLatLng(newLatLng);
      window.byodMarkerRegistry[hb.user_id].setIcon(buildLiveIcon(name, color, isOutside));
      window.byodMarkerRegistry[hb.user_id].setPopupContent(popupHtml);
    } else {
      // Crear marcador nuevo
      const marker = L.marker(newLatLng, { icon: buildLiveIcon(name, color, isOutside) })
        .addTo(map)
        .bindPopup(popupHtml);
      window.byodMarkerRegistry[hb.user_id] = marker;
    }
  });

  // Actualizar contador de empleados activos en el badge EN VIVO
  const counter = document.getElementById('byod-live-counter');
  if (counter) counter.textContent = `${Object.keys(latestByEmployee).length} activo${Object.keys(latestByEmployee).length !== 1 ? 's' : ''}`;
};

// ⏱️ POLLING EN TIEMPO REAL: ACTUALIZA POSICIONES CADA 15 SEGUNDOS
// 🧹 LIMPIEZA AUTOMÁTICA: Borra heartbeats de más de 24h para mantener la DB ligera
window.cleanOldHeartbeats = async () => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from('device_heartbeats')
      .delete()
      .lt('timestamp', cutoff);
    if (!error) console.log('[BYOD_LIVE] Limpieza de heartbeats antiguos completada.');
  } catch (e) {
    console.warn('[BYOD_LIVE] Error en limpieza de heartbeats:', e.message);
  }
};

// ⚡ REALTIME EN TIEMPO REAL: Supabase escucha inserts en device_heartbeats y actualiza el mapa al instante
window.startByodLiveTracking = () => {
  // Cerrar canal previo si existe
  if (window.byodRealtimeChannel) {
    supabase.removeChannel(window.byodRealtimeChannel);
    window.byodRealtimeChannel = null;
  }

  // Carga inicial de posiciones para poblar el mapa y el badge EN VIVO
  (async () => {
    try {
      const { data: heartbeats } = await supabase
        .from('device_heartbeats')
        .select('user_id, lat, lng, battery_level, timestamp')
        .not('lat', 'is', null)
        .not('lng', 'is', null)
        .order('timestamp', { ascending: false })
        .limit(200);

      if (heartbeats && heartbeats.length > 0) {
        const latestByEmployee = {};
        heartbeats.forEach(hb => {
          if (!latestByEmployee[hb.user_id]) latestByEmployee[hb.user_id] = hb;
        });
        window.updateByodMarkers(latestByEmployee);
      }
    } catch (e) {
      console.warn('[BYOD_LIVE] Error en carga inicial:', e.message);
    }
  })();

  // Ejecutar limpieza de heartbeats viejos al abrir el panel (mantiene DB ligera)
  window.cleanOldHeartbeats();

  // Suscribirse a Supabase Realtime: reacciona al instante cuando un empleado envía su posición
  window.byodRealtimeChannel = supabase
    .channel('byod_live_positions')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'device_heartbeats' },
      (payload) => {
        // Se dispara en < 1 segundo cuando el empleado se mueve
        if (state.view !== 'byod_dashboard') {
          supabase.removeChannel(window.byodRealtimeChannel);
          window.byodRealtimeChannel = null;
          console.log('[BYOD_LIVE] Panel cerrado — canal Realtime desconectado.');
          return;
        }

        const hb = payload.new;
        if (!hb || !hb.lat || !hb.lng) return;

        // Mover el marcador del empleado en el mapa AL INSTANTE
        window.updateByodMarkers({ [hb.user_id]: hb });
        console.log(`[BYOD_LIVE] Posición en tiempo real: user ${hb.user_id} → ${hb.lat.toFixed(5)}, ${hb.lng.toFixed(5)}`);
      }
    )
    .subscribe((status) => {
      console.log('[BYOD_LIVE] Estado canal Realtime:', status);
      // Actualizar color del badge según estado de conexión
      const badge = document.getElementById('byod-live-badge');
      if (badge) {
        badge.style.background = status === 'SUBSCRIBED' ? '#f0fdf4' : '#fff1f2';
        badge.style.borderColor = status === 'SUBSCRIBED' ? '#86efac' : '#fecdd3';
        badge.style.color = status === 'SUBSCRIBED' ? '#15803d' : '#be123c';
      }
    });

  console.log('[BYOD_LIVE] Canal Realtime iniciado — esperando posiciones en tiempo real.');
};

// 🔔 GUARDAR CONFIGURACIÓN DE TELEGRAM PARA EL ADMINISTRADOR
window.saveTelegramConfig = async (e) => {
  e.preventDefault();
  const form = e.target;
  const botToken = form.bot_token.value.trim() || "8037545998:AAH4zgAxhoNbZ1WKJXmCElwq7oHzi7IJ1LY";
  const chatId = form.chat_id.value.trim();

  if (!chatId) {
    window.showToast("Por favor escribe tu ID de Telegram.", "warning");
    return;
  }

  state.loading = true;
  render();

  try {
    const payload = { botToken, chatId };
    const { error } = await supabase.from('system_logs').insert({
      type: 'TELEGRAM_CONFIG',
      module: 'Configuración',
      severity: 'INFO',
      message: JSON.stringify(payload)
    });

    if (error) throw error;
    
    window.showToast("✅ ¡Celular vinculado con éxito! Recibirás alertas inmediatas.", "success");
    
    // Recargar la vista para refrescar el dashboard
    await window.fetchByodDashboard();
  } catch(err) {
    window.showToast("Error al vincular celular: " + err.message, "danger");
  } finally {
    state.loading = false;
    render();
  }
};

// 🗺️ ASIGNADOR VISUAL DE GEOCERCAS PARA NEGOCIOS
window.pickCoordinatesOnMap = () => {
  const modalHtml = `
    <div class="modal-overlay" id="geofence-picker-modal" style="z-index:9999;">
      <div class="modal-card card" style="max-width:800px; padding:0; overflow:hidden; border-radius:24px;">
        <div style="padding:20px 25px; background:#0f172a; color:white; display:flex; justify-content:space-between; align-items:center;">
          <h2 style="font-size:16px; font-weight:800; display:flex; align-items:center; gap:8px; margin:0;"><i data-lucide="map-pin" style="color:#38bdf8;"></i> Fijar Ubicación de Sede</h2>
          <div class="modal-close" style="color:white; cursor:pointer;" onclick="document.getElementById('geofence-picker-modal').remove()">✕</div>
        </div>
        
        <div style="padding:20px 25px; background:#f8fafc; border-bottom:1px solid #e2e8f0;">
          <label style="font-size:11px; font-weight:800; color:#475569; text-transform:uppercase; display:block; margin-bottom:8px;">1. Selecciona la Sede Operativa</label>
          <select id="geo-business-select" class="form-input" style="width:100%; border-radius:12px; font-weight:700;" onchange="window.geoPickerUpdateRadius()">
            <option value="">-- Elige un Negocio --</option>
            ${state.businesses.map(b => `<option value="${b.id}" data-lat="${b.lat || ''}" data-lng="${b.lng || ''}" data-rad="${b.geofence_radius_meters || 100}">${b.name}</option>`).join('')}
          </select>
          
          <div style="display:flex; gap:15px; margin-top:15px; align-items:flex-end;">
            <div style="flex:1.2;">
              <label style="font-size:11px; font-weight:800; color:#475569; text-transform:uppercase; display:block; margin-bottom:8px;">Modo de Geocerca</label>
              <select id="geo-mode-select" class="form-input" style="width:100%; border-radius:12px;" onchange="window.geoPickerToggleMode()">
                <option value="circle">📍 Círculo y Radio</option>
                <option value="polygon">📐 Dibujar Polígono</option>
              </select>
            </div>
            <div style="flex:1;" id="geo-radius-container">
              <label style="font-size:11px; font-weight:800; color:#475569; text-transform:uppercase; display:block; margin-bottom:8px;">Radio Seguro (m)</label>
              <input type="number" id="geo-radius-input" class="form-input" value="100" style="width:100%; border-radius:12px; font-weight:800; color:var(--primary);" oninput="window.geoPickerDrawCircle()">
            </div>
            <div style="flex:1; display:none;" id="geo-buffer-container">
              <label style="font-size:11px; font-weight:800; color:#475569; text-transform:uppercase; display:block; margin-bottom:8px;">Buffer / Tolerancia (m)</label>
              <input type="number" id="geo-buffer-input" class="form-input" value="30" style="width:100%; border-radius:12px; font-weight:800; color:#3b82f6;">
            </div>
            <div style="flex:1; display:none;" id="geo-polygon-actions">
              <label style="font-size:11px; font-weight:800; color:#475569; text-transform:uppercase; display:block; margin-bottom:8px;">Limpiar Dibujo</label>
              <button onclick="window.geoPickerClearPolygon()" class="btn-secondary" style="width:100%; height:45px; border-radius:12px; font-weight:800; color:#dc2626; border-color:#fecaca; background:#fef2f2;">🗑️ BORRAR</button>
            </div>
            <div style="flex:1;">
              <label style="font-size:11px; font-weight:800; color:#475569; text-transform:uppercase; display:block; margin-bottom:8px;">Posición</label>
              <button onclick="window.geoPickerUseMyGps()" class="btn-secondary" style="width:100%; height:45px; font-size:11px; font-weight:800; border-radius:12px; display:flex; justify-content:center; align-items:center; gap:5px;"><i data-lucide="crosshair" style="width:14px;"></i> GPS</button>
            </div>
          </div>
          <p id="geo-instructions" style="font-size:11px; color:#64748b; margin:15px 0 0 0; text-align:center; font-weight:600;">Haz clic en el mapa para fijar el centro de la sede.</p>
        </div>

        <div id="geo-picker-map" style="height:400px; width:100%;"></div>
        
        <div style="padding:20px 25px; background:white; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center;">
           <button onclick="window.deleteBusinessLocation()" class="btn-secondary" style="color:#ef4444; border-color:#fecaca; background:#fef2f2; font-weight:800; padding:10px 20px; border-radius:12px; display:flex; align-items:center; gap:8px;"><i data-lucide="trash-2" style="width:16px;"></i> ELIMINAR SEDE</button>
           <button onclick="window.saveMapCoordinates()" class="btn-primary" style="background:#10b981; font-weight:800; padding:12px 25px; border-radius:12px; display:flex; align-items:center; gap:8px;"><i data-lucide="save" style="width:16px;"></i> GUARDAR CONFIGURACIÓN</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  if (window.lucide) window.lucide.createIcons();

  window.geoPickerPolygonPoints = [];
  window.geoPickerPolygonLayer = null;

  setTimeout(() => {
    let initialLat = 4.60971, initialLng = -74.08175;

    const map = L.map('geo-picker-map').setView([initialLat, initialLng], 15);
    window.geoPickerMapInstance = map;

    const mapboxToken = 'YOUR_MAPBOX_TOKEN_HERE'; // Reemplazado para evitar bloqueo de Git
    
    const streetLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
    const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Esri, Maxar, Earthstar Geographics'
    });

    const baseMaps = {
      "🗺️ Calles": streetLayer,
      "🛰️ Satelital": satelliteLayer
    };
    L.control.layers(baseMaps).addTo(map);

    window.geoPickerMarker = L.marker([initialLat, initialLng], { draggable: true }).addTo(map);
    window.geoPickerCircle = L.circle([initialLat, initialLng], { radius: 100, color: '#10b981', fillOpacity: 0.2 }).addTo(map);

    // Sync Circulo al mover pin
    window.geoPickerMarker.on('drag', function(e) {
      if (document.getElementById('geo-mode-select').value === 'circle') {
        const pos = e.target.getLatLng();
        window.geoPickerCircle.setLatLng(pos);
      }
    });

    // Mover al click o agregar punto a polígono
    map.on('click', function(e) {
      const mode = document.getElementById('geo-mode-select').value;
      if (mode === 'circle') {
        window.geoPickerMarker.setLatLng(e.latlng);
        window.geoPickerCircle.setLatLng(e.latlng);
      } else {
        window.geoPickerPolygonPoints.push([e.latlng.lat, e.latlng.lng]);
        window.geoPickerDrawPolygonLayer();
      }
    });
    
    setTimeout(() => { map.invalidateSize(); }, 300);
  }, 100);
};

window.geoPickerDrawPolygonLayer = () => {
  if (window.geoPickerPolygonLayer) {
    window.geoPickerMapInstance.removeLayer(window.geoPickerPolygonLayer);
  }
  if (window.geoPickerPolygonPoints.length > 0) {
    window.geoPickerPolygonLayer = L.polygon(window.geoPickerPolygonPoints, {
      color: '#3b82f6',
      fillColor: '#3b82f6',
      fillOpacity: 0.3,
      weight: 3
    }).addTo(window.geoPickerMapInstance);
  }
};

window.geoPickerClearPolygon = () => {
  window.geoPickerPolygonPoints = [];
  window.geoPickerDrawPolygonLayer();
};

window.geoPickerToggleMode = () => {
  const mode = document.getElementById('geo-mode-select').value;
  if (mode === 'circle') {
    document.getElementById('geo-radius-container').style.display = 'block';
    document.getElementById('geo-buffer-container').style.display = 'none';
    document.getElementById('geo-polygon-actions').style.display = 'none';
    document.getElementById('geo-instructions').innerText = 'Haz clic en el mapa para mover el centro de la sede (Modo Círculo).';
    if (window.geoPickerPolygonLayer) window.geoPickerMapInstance.removeLayer(window.geoPickerPolygonLayer);
    window.geoPickerMarker.setOpacity(1);
    window.geoPickerCircle.setStyle({opacity:1, fillOpacity:0.2});
  } else {
    document.getElementById('geo-radius-container').style.display = 'none';
    document.getElementById('geo-buffer-container').style.display = 'block';
    document.getElementById('geo-polygon-actions').style.display = 'block';
    document.getElementById('geo-instructions').innerText = 'Dibuja el polígono exacto del local. El "Buffer" permitirá a los empleados alejarse unos metros extra de las paredes.';
    window.geoPickerMarker.setOpacity(0);
    window.geoPickerCircle.setStyle({opacity:0, fillOpacity:0});
    window.geoPickerDrawPolygonLayer();
  }
};

window.geoPickerUpdateRadius = () => {
  const sel = document.getElementById('geo-business-select');
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) return;

  const r = parseInt(opt.getAttribute('data-rad')) || 100;
  document.getElementById('geo-radius-input').value = r;

  const lat = parseFloat(opt.getAttribute('data-lat'));
  const lng = parseFloat(opt.getAttribute('data-lng'));
  const bizId = opt.value;

  // Restaurar polígono y buffer si existen
  const polyConfig = state.geofencePolygons?.[bizId];
  window.geoPickerPolygonPoints = polyConfig?.polygon || [];
  document.getElementById('geo-buffer-input').value = polyConfig?.buffer || 30;

  if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
    window.geoPickerMarker.setLatLng([lat, lng]);
    window.geoPickerMapInstance.setView([lat, lng], 18);
    window.geoPickerDrawCircle();
  }
  
  // Cambiar a modo polígono si ya tiene uno configurado
  if (window.geoPickerPolygonPoints.length >= 3) {
    document.getElementById('geo-mode-select').value = 'polygon';
  } else {
    document.getElementById('geo-mode-select').value = 'circle';
  }
  window.geoPickerToggleMode();
};

window.geoPickerDrawCircle = () => {
  if (!window.geoPickerCircle || !window.geoPickerMarker) return;
  const r = parseInt(document.getElementById('geo-radius-input').value) || 100;
  window.geoPickerCircle.setRadius(r);
  window.geoPickerCircle.setLatLng(window.geoPickerMarker.getLatLng());
};

window.geoPickerUseMyGps = () => {
  if (!navigator.geolocation) return window.showToast("Tu dispositivo no soporta GPS", "danger");
  
  const btn = document.querySelector('button[onclick="window.geoPickerUseMyGps()"]');
  const original = btn.innerHTML;
  btn.innerHTML = '<span class="loading-spinner"></span> CALCULANDO...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.innerHTML = original;
      const { latitude: lat, longitude: lng } = pos.coords;
      window.geoPickerMarker.setLatLng([lat, lng]);
      window.geoPickerMapInstance.setView([lat, lng], 18);
      window.geoPickerDrawCircle();
      window.showToast("📍 Posición centrada en tu ubicación actual.", "success");
    },
    (err) => {
      btn.innerHTML = original;
      window.showToast("Error de GPS: " + err.message, "danger");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
};

window.saveMapCoordinates = async () => {
  const bizId = document.getElementById('geo-business-select').value;
  if (!bizId) return window.showToast("Debes seleccionar una sede primero.", "warning");

  const mode = document.getElementById('geo-mode-select').value;
  const radius = parseInt(document.getElementById('geo-radius-input').value) || 100;
  const buffer = parseInt(document.getElementById('geo-buffer-input').value) || 30;
  const pos = window.geoPickerMarker.getLatLng();
  
  state.loading = true;
  render();

  try {
    // 1. Guardar centro en tabla de businesses
    const { error } = await supabase.from('businesses').update({
      lat: pos.lat,
      lng: pos.lng,
      geofence_radius_meters: radius
    }).eq('id', bizId);

    if (error) throw error;

    // 2. Guardar Polígono y Buffer en system_logs
    if (mode === 'polygon' && window.geoPickerPolygonPoints.length >= 3) {
      const payload = { business_id: bizId, polygon: window.geoPickerPolygonPoints, buffer: buffer };
      await supabase.from('system_logs').insert({
        type: 'GEOFENCE_POLYGON',
        module: 'Configuración',
        user_id: state.user.id,
        message: JSON.stringify(payload)
      });
      if (!state.geofencePolygons) state.geofencePolygons = {};
      state.geofencePolygons[bizId] = payload;
    } else {
      // Si eligió círculo, borrar polígono existente registrando uno vacío
      await supabase.from('system_logs').insert({
        type: 'GEOFENCE_POLYGON',
        module: 'Configuración',
        user_id: state.user.id,
        message: JSON.stringify({ business_id: bizId, polygon: [], buffer: 0 })
      });
      if (state.geofencePolygons) state.geofencePolygons[bizId] = null;
    }

    window.showToast("✅ ¡Geocerca configurada exitosamente!", "success");
    document.getElementById('geofence-picker-modal').remove();
    
    // Recargar memoria
    const { data: busRes } = await supabase.from('businesses').select('id, name, type, lat, lng, geofence_radius_meters');
    state.businesses = busRes || [];
    
    // Repintar Dashboard BYOD
    if (state.view === 'byod_dashboard') {
      window.initByodMap();
    }
  } catch(err) {
    window.showToast("Error guardando mapa: " + err.message, "danger");
  } finally {
    state.loading = false;
    render();
  }
};

window.deleteBusinessLocation = async () => {
  const bizId = document.getElementById('geo-business-select').value;
  if (!bizId) return window.showToast("Selecciona una sede para eliminar sus coordenadas.", "warning");
  
  if (!confirm("⚠️ ¿Estás seguro de eliminar la ubicación y geocerca de esta sede? Los empleados ya no tendrán restricciones para marcar aquí.")) return;
  
  state.loading = true;
  render();
  
  try {
    // 1. Limpiar coordenadas en tabla principal
    const { error } = await supabase.from('businesses').update({
      lat: null,
      lng: null,
      geofence_radius_meters: 100
    }).eq('id', bizId);
    
    if (error) throw error;
    
    // 2. Limpiar polígono en logs
    await supabase.from('system_logs').insert({
      type: 'GEOFENCE_POLYGON',
      module: 'Configuración',
      user_id: state.user.id,
      message: JSON.stringify({ business_id: bizId, polygon: [] })
    });
    
    if (state.geofencePolygons) state.geofencePolygons[bizId] = null;
    
    window.showToast("🗑️ Ubicación eliminada correctamente.", "success");
    document.getElementById('geofence-picker-modal').remove();
    
    await fetchData();
    if (state.view === 'byod_dashboard') window.initByodMap();
    
  } catch(err) {
    window.showToast("Error eliminando ubicación: " + err.message, "danger");
  } finally {
    state.loading = false;
    render();
  }
};

window.registerGeolocation = async (type) => {
  if (!state.user || !state.user.id) {
    window.showToast("Sesión expirada. Por favor cierra sesión y vuelve a ingresar.", "danger");
    state.view = 'login';
    render();
    return;
  }

  // REGLA DE NEGOCIO MAESTRA: Impedir duplicados o salidas sin entrada previa usando el estado sincronizado global
  if (type === 'arrival' && state.hasActiveAttendance) {
    window.showToast("⚠️ Ya tienes un registro de LLEGADA activo. Marca SALIDA primero para cerrar tu turno.", "warning");
    return;
  }
  if (type === 'departure' && !state.hasActiveAttendance) {
    window.showToast("⚠️ No puedes registrar SALIDA sin haber registrado una LLEGADA previa.", "warning");
    return;
  }

  // REGLA: Validar turno asignado y horario de inicio (Solo para empleados)
  if (type === 'arrival' && state.user.role !== 'admin') {
    const now = new Date();
    const userShiftsToday = (state.shifts || []).filter(s => {
      if (s.user_id !== state.user.id) return false;
      const sStart = new Date(s.start_time);
      return sStart.toDateString() === now.toDateString();
    });

    if (userShiftsToday.length === 0) {
      window.showToast("🚫 No tienes ningún turno programado para hoy. No puedes registrar llegada.", "warning");
      return;
    }

    const canCheckIn = userShiftsToday.some(s => {
      const sStart = new Date(s.start_time);
      // Permitir marcar entrada hasta 10 minutos antes del turno
      return now >= new Date(sStart.getTime() - (10 * 60000));
    });

    if (!canCheckIn) {
      const earliestShift = userShiftsToday.sort((a,b) => new Date(a.start_time) - new Date(b.start_time))[0];
      const earliestTime = new Date(earliestShift.start_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      window.showToast(`🚫 No puedes registrar llegada antes de tu turno (Inicia a las ${earliestTime}).`, "warning");
      return;
    }
  }

  state.loading = true;
  render();

  try {
    // Validación de respaldo offline...
    if (navigator.onLine) {
      try {
        const { data: lastLog } = await supabase
          .from('system_logs')
          .select('message')
          .eq('type', 'GEOLOCATION_TRACK')
          .eq('user_id', state.user.id)
          .order('timestamp', { ascending: false })
          .limit(1);

        if (lastLog && lastLog.length > 0) {
          const lastMsg = lastLog[0].message || '';
          const isLastArrival = lastMsg.includes('LLEGADA');

          if (type === 'arrival' && isLastArrival) {
            window.showToast("⚠️ Ya tienes un turno abierto. Debes registrar tu salida antes de iniciar otro.", "warning");
            state.loading = false;
            render();
            return;
          }
          if (type === 'departure' && !isLastArrival) {
            window.showToast("⚠️ No tienes ningún turno abierto. Debes registrar tu llegada primero.", "warning");
            state.loading = false;
            render();
            return;
          }
        } else if (type === 'departure') {
          window.showToast("⚠️ No tienes ningún turno abierto. Debes registrar tu llegada primero.", "warning");
          state.loading = false;
          render();
          return;
        }
      } catch (checkErr) {
        console.warn("Fallo validación online, se omite para permitir marcación de emergencia:", checkErr);
      }
    } else {
      const offlineLogs = JSON.parse(localStorage.getItem('offline_gps_logs') || '[]');
      const lastOffline = offlineLogs.filter(l => l.user_id === state.user.id).pop();
      if (lastOffline) {
        const isLastArrival = lastOffline.message.includes('LLEGADA');
        if (type === 'arrival' && isLastArrival) {
          window.showToast("⚠️ Ya tienes un turno abierto en modo offline. Debes registrar tu salida primero.", "warning");
          state.loading = false;
          render();
          return;
        }
        if (type === 'departure' && !isLastArrival) {
          window.showToast("⚠️ No tienes ningún turno abierto offline. Debes registrar tu llegada primero.", "warning");
          state.loading = false;
          render();
          return;
        }
      }
    }

    try {
      const permissions = await Geolocation.checkPermissions();
      if (permissions.location !== 'granted') {
        const request = await Geolocation.requestPermissions();
        if (request.location !== 'granted') {
          window.showToast("Permiso de GPS denegado. Es necesario para marcar.", "danger");
          state.loading = false;
          render();
          return;
        }
      }
    } catch (permErr) {
      console.warn("[GPS] Fallo comprobación de permisos, intentando de todas formas:", permErr);
    }

    // 🎯 OBTENCIÓN RÁPIDA DE GPS (Lectura Única Instantánea)
    const samples = [];
    window.showToast("📡 Obteniendo señal GPS...", "info");

    try {
      // Intento rápido de alta precisión (máximo 6.5s) permitiendo caché muy reciente
      const pos = await Promise.race([
        Geolocation.getCurrentPosition({ enableHighAccuracy: true, maximumAge: 3000, timeout: 6000 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_GPS")), 6500))
      ]);
      samples.push(pos.coords);
    } catch (err) {
      console.warn("[GPS] Fallo primera lectura, intentando alternativa:", err);
      try {
        // Fallback rápido con menor precisión
        const pos = await Promise.race([
          Geolocation.getCurrentPosition({ enableHighAccuracy: false, maximumAge: 15000, timeout: 4000 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_FALLBACK")), 4500))
        ]);
        samples.push(pos.coords);
      } catch (err2) {
        console.error("[GPS] Fallo definitivo obteniendo ubicación:", err2);
      }
    }

    if (samples.length === 0) {
      window.showToast("🚫 No se pudo obtener una señal GPS estable. Revisa si tienes el GPS activo e intenta de nuevo.", "danger");
      state.loading = false;
      render();
      return;
    }

    const coords = {
      lat: samples[0].latitude,
      lng: samples[0].longitude,
      accuracy: samples[0].accuracy || 10
    };

    // 🛡️ VALIDACIÓN DE GEOCERCA INTELIGENTE
    let targetBizId = state.currentBusinessId;
    if (state.user.role !== 'admin') {
      const now = new Date();
      const userShiftsToday = (state.shifts || []).filter(s => s.user_id === state.user.id && new Date(s.start_time).toDateString() === now.toDateString());
      if (userShiftsToday.length > 0) {
        const currentShift = userShiftsToday.find(s => {
          const sStart = new Date(s.start_time);
          const sEnd = new Date(s.end_time);
          return now >= new Date(sStart.getTime() - (10 * 60000)) && now <= sEnd;
        }) || userShiftsToday.sort((a,b) => new Date(a.start_time) - new Date(b.start_time))[0];
        
        if (currentShift && currentShift.business_id) {
          targetBizId = currentShift.business_id;
        }
      }
    }
    const biz = state.businesses.find(b => b.id === targetBizId);
    if (biz) {
      const polyConfig = state.geofencePolygons?.[biz.id];
      let isOutside = false;

      if (polyConfig && polyConfig.polygon && polyConfig.polygon.length >= 3) {
        try {
          // Validación exacta por POLÍGONO
          const inside = window.isPointInPolygon([coords.lat, coords.lng], polyConfig.polygon);
          
          if (!inside) {
            // Si está fuera del polígono, chequear si está dentro del BUFFER de tolerancia
            const distToCenter = window.getDistanceInMeters(coords.lat, coords.lng, biz.lat, biz.lng);
            const tolerance = polyConfig.buffer || 30;
            if (distToCenter > tolerance + 20) { // +20m de margen por GPS drift
               isOutside = true;
            }
          }
        } catch (polyErr) {
          console.error("[GPS] Error en validación por polígono, haciendo fallback a clásica:", polyErr);
          if (biz.lat && biz.lng && biz.lat !== 0 && biz.lng !== 0) {
            const distanceMeters = window.getDistanceInMeters(coords.lat, coords.lng, biz.lat, biz.lng);
            const maxRadius = biz.geofence_radius_meters || 100;
            isOutside = distanceMeters > maxRadius;
          }
        }
      } else if (biz.lat && biz.lng && biz.lat !== 0 && biz.lng !== 0) {
        // Fallback a validación circular clásica (Evitando la trampa de la isla nula 0,0)
        const distanceMeters = window.getDistanceInMeters(coords.lat, coords.lng, biz.lat, biz.lng);
        const maxRadius = biz.geofence_radius_meters || 100;
        isOutside = distanceMeters > maxRadius;
      }

      if (isOutside) {
         window.showToast("🚫 FUERA DE RANGO: Estás fuera del perímetro permitido para esta sede.", "danger");
         state.loading = false;
         render();
         return;
      }
    }

    const eventType = type === 'arrival' ? 'LLEGADA' : 'SALIDA';
    const msg = `Registro de ${eventType}`;
    
    try {
      const userId = state.user.id;
      const msgData = JSON.stringify({ text: msg, context: { coords, businessId: targetBizId } });
      const { error } = await supabase.from('system_logs').insert({ type: 'GEOLOCATION_TRACK', message: msgData, module: 'Asistencia', user_id: userId });
      
      if (error) {
         if (error.message?.includes('fetch') || error.code === 'PGRST301' || error.message?.includes('Failed to fetch')) throw error;
         else { 
           window.showToast(`Error en BD: ${error.message}`, "danger"); 
           state.loading = false;
           render();
           return; 
         }
      }
      window.showToast(`✅ ${eventType} registrada con éxito. (Precisión: ${Math.round(coords.accuracy)}m)`, "success");

      // 🟢 LLEGADA: Activar motor de rastreo GPS en tiempo real
      if (type === 'arrival') {
        const activeBiz = state.businesses.find(b => b.id === targetBizId);
        if (activeBiz) {
          activeBiz.polygonConfig = state.geofencePolygons?.[activeBiz.id];
          byodService.startTracking(state.user.id, activeBiz);
          console.log("[ASISTENCIA] Motor BYOD activado por LLEGADA en:", activeBiz.name);
        }
      }

      // 🔴 SALIDA: Detener motor + notificar cierre de turno al admin vía Telegram
      if (type === 'departure') {
        const mapsLink = (coords.lat && coords.lng) ? `https://maps.google.com/?q=${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}` : null;
        const bizName = state.businesses.find(b => b.id === state.currentBusinessId)?.name || 'sede';
        const closingMsg = `🟡 <b>CIERRE DE TURNO</b>\n\n<b>${state.user?.name || 'Colaborador'}</b> registró SALIDA de 📍 <b>${bizName}</b>.\n\n🕒 Hora: ${new Date().toLocaleTimeString()}${coords.lat ? `\n📌 Coords: ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}` : ''}${mapsLink ? `\n🗺️ Ver en mapa: ${mapsLink}` : ''}`;
        byodService.triggerTelegramAlert(closingMsg);
        byodService.stopTracking();
        console.log("[ASISTENCIA] Motor BYOD detenido por SALIDA.");
      }
    } catch(dbErr) {
      if (!navigator.onLine || dbErr.message?.includes('fetch') || dbErr.message?.includes('Failed')) {
        const offlineLogs = JSON.parse(localStorage.getItem('offline_gps_logs') || '[]');
        const msgData = JSON.stringify({ text: msg, context: { coords, businessId: state.currentBusinessId } });
        offlineLogs.push({ type: 'GEOLOCATION_TRACK', message: msgData, module: 'Asistencia', user_id: state.user.id, timestamp: new Date().toISOString() });
        localStorage.setItem('offline_gps_logs', JSON.stringify(offlineLogs));
        window.showToast(`📴 Conexión perdida. ${eventType} guardada OFFLINE. Se sincronizará en cuanto regrese internet.`, "info");
      } else {
        window.showToast(`Error guardando ubicación: ${dbErr.message}`, "danger");
      }
    }
    
    // Actualizar estado global de inmediato para que se desbloquee el POS sin recargar
    await window.fetchData();
  } catch (e) {
    window.showToast(`Error obteniendo GPS: ${e.message}`, "danger");
  } finally {
    state.loading = false;
    render();
  }
};

window.setBusinessLocation = async () => {
  if (!state.currentBusinessId || state.currentBusinessId === 'all') {
     window.showToast("Primero selecciona un negocio específico.", "warning");
     return;
  }
  
  if (!confirm("¿Establecer tu ubicación GPS ACTUAL como la ubicación oficial del negocio? Los empleados deberán estar cerca de este punto para marcar.")) return;

  try {
    state.loading = true;
    render();
    
    const permissions = await Geolocation.checkPermissions();
    if (permissions.location !== 'granted') {
      await Geolocation.requestPermissions();
    }

    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    
    // VALIDACIÓN DE INTEGRIDAD Y PRECISIÓN
    if (lat === null || lat === undefined || lng === null || lng === undefined) {
      throw new Error("Coordenadas GPS recibidas son nulas.");
    }
    
    // Validar precisión GPS (alerta si la precisión en metros es muy mala)
    if (accuracy && accuracy > 30) {
      window.showToast(`⚠️ Señal GPS débil (precisión: ${Math.round(accuracy)}m). Intenta en exteriores.`, "warning");
    }

    const getDecimalPlaces = (num) => {
      const parts = num.toString().split('.');
      return parts.length > 1 ? parts[1].length : 0;
    };

    if (getDecimalPlaces(lat) < 4 || getDecimalPlaces(lng) < 4) {
      window.showToast("⚠️ Ubicación demasiado imprecisa. Confirme el GPS.", "warning");
      alert("⚠️ Ubicación demasiado imprecisa. Confirme el GPS.");
    }

    // VALIDACIÓN ADICIONAL: Desviación histórica de 5 km
    let hasHistoricalDeviation = false;
    try {
      const { data: recentLogs } = await supabase
        .from('system_logs')
        .select('*')
        .eq('type', 'GEOLOCATION_TRACK')
        .order('timestamp', { ascending: false })
        .limit(100);

      if (recentLogs && recentLogs.length > 0) {
        let matchingLogs = [];
        for (const log of recentLogs) {
          try {
            const parsed = JSON.parse(log.message);
            if (parsed?.context?.businessId === state.currentBusinessId && parsed?.context?.coords?.lat) {
              matchingLogs.push(parsed.context.coords);
            }
          } catch (e) {}
        }

        if (matchingLogs.length > 0) {
          const lastHistorical = matchingLogs[0];
          const distToHistorical = window.getDistanceInMeters(lat, lng, lastHistorical.lat, lastHistorical.lng);
          if (distToHistorical > 5000) { // 5 km
            hasHistoricalDeviation = true;
          }
        }
      }
    } catch (logErr) {
      console.warn("Fallo cargando historial para desvío de 5km:", logErr);
    }

    if (hasHistoricalDeviation) {
      const alertMsg = `⚠️ <b>Posible coordenada incorrecta configurada para la sede</b>\n\nSe configuró una nueva ubicación que está a más de 5 km de los registros históricos de asistencia.`;
      try {
        await supabase.from('system_logs').insert({
          type: 'SECURITY_ALERT',
          module: 'Seguridad',
          message: JSON.stringify({
            text: "Posible coordenada incorrecta configurada para la sede.",
            context: { businessId: state.currentBusinessId, newLat: lat, newLng: lng, alert: alertMsg }
          })
        });
      } catch (insertErr) {
        console.warn("Fallo guardando alerta de seguridad en BD:", insertErr);
      }
      window.showToast("⚠️ Posible coordenada incorrecta configurada para la sede.", "warning");
    }

    const { error } = await supabase
      .from('businesses')
      .update({ lat, lng, geofence_radius_meters: 100 })
      .eq('id', state.currentBusinessId);

    if (error) throw error;

    window.showToast("✅ Ubicación del negocio establecida correctamente. Geocerca activada (100m).", "success");
    await window.fetchData();
  } catch (err) {
    window.showToast("Error fijando ubicación: " + err.message, "danger");
  } finally {
    state.loading = false;
    render();
  }
};

// 🛡️ MONITOR DE COMPORTAMIENTO Y PRODUCTIVIDAD (Stealth Audit)
// Detecta si el empleado sale de la app, abre redes sociales, o minimiza el sistema durante su turno
document.addEventListener('visibilitychange', async () => {
  if (state.user && state.user.role !== 'admin' && state.hasActiveAttendance) {
     const isHidden = document.visibilityState === 'hidden';
     const type = isHidden ? 'APP_MINIMIZED' : 'APP_RESUMED';
     const text = isHidden 
        ? "⚠️ FUERA DE APP: El colaborador salió de la pantalla o bloqueó el dispositivo durante su turno."
        : "ℹ️ REINGRESO: El colaborador volvió a abrir la aplicación del negocio.";

     try {
        await supabase.from('system_logs').insert({
           type: 'PRODUCTIVITY_AUDIT',
           module: 'Seguridad',
           user_id: state.user.id,
           message: JSON.stringify({
              text: text,
              context: { action: type, timestamp: new Date().toISOString() }
           })
        });
     } catch (e) {
        console.warn("Fallo al enviar reporte de productividad:", e);
     }
  }
});

// 📊 COMPONENTES GLOBALES DE ANALÍTICA DE COLABORADORES (v1.8.0)
window.openCollabAnalytics = (userId) => {
  state.selectedCollabId = userId;
  state.collabSelectedCalDay = null; // Reiniciar día seleccionado
  state.activeModal = 'collab_analytics';
  render();
};

window.changeCollabCalendarMonth = (direction) => {
  if (state.collabCalendarMonth === undefined) {
    const d = new Date();
    state.collabCalendarYear = d.getFullYear();
    state.collabCalendarMonth = d.getMonth();
  }
  state.collabCalendarMonth += direction;
  if (state.collabCalendarMonth > 11) {
    state.collabCalendarMonth = 0;
    state.collabCalendarYear += 1;
  } else if (state.collabCalendarMonth < 0) {
    state.collabCalendarMonth = 11;
    state.collabCalendarYear -= 1;
  }
  state.collabSelectedCalDay = null; // Reiniciar día seleccionado al cambiar de mes
  render();
};

window.saveCashClosure = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]') || e.target.querySelector('button');
  const originalHtml = btn ? btn.innerHTML : 'REGISTRAR CIERRE';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⚡ Guardando cierre...';
  }

  const formData = new FormData(e.target);
  
  let bizId = state.activeShiftBusinessId || state.user?.business_id;
  if (state.user?.role === 'admin') {
    bizId = formData.get('business_id');
  }

  if (!bizId || bizId === 'all') {
    window.showToast('❌ Error: No se pudo determinar el local o sede para el cierre.', 'danger');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
    return;
  }

  const payload = {
    user_id: state.user.id,
    business_id: bizId,
    date: new Date().toLocaleDateString('en-CA'), // Formato YYYY-MM-DD local
    cash_amount: window.getCleanNumber(formData.get('cash_amount')),
    addi_amount: window.getCleanNumber(formData.get('addi_amount')),
    sistecredito_amount: window.getCleanNumber(formData.get('sistecredito_amount')),
    daviplata_amount: window.getCleanNumber(formData.get('daviplata_amount')),
    nequi_amount: window.getCleanNumber(formData.get('nequi_amount')),
    bonos_amount: window.getCleanNumber(formData.get('bonos_amount')),
    other_expenses_amount: window.getCleanNumber(formData.get('other_expenses_amount')),
    other_expenses_description: formData.get('other_expenses_description') || '',
    savings_amount: window.getCleanNumber(formData.get('savings_amount')),
    savings_description: formData.get('savings_description') || '',
    observations: formData.get('observations') || ''
  };

  const next_day_base_amount = window.getCleanNumber(formData.get('next_day_base_amount'));
  if (next_day_base_amount > 0) {
    payload.next_day_base_amount = next_day_base_amount;
  }

  try {
    const { error } = await supabase.from('cash_closures').insert(payload);
    if (error) throw error;

    window.showToast('✅ Cierre de caja registrado exitosamente.', 'success');
    state.activeModal = null;
    await window.fetchData();
    render();
  } catch (err) {
    console.error("Error al guardar cierre de caja:", err);
    window.showToast('❌ Error al guardar: ' + err.message, 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
};

window.openEditSaleModal = (saleId, currentTotal, currentPaymentMethod) => {
  state.editingSaleId = saleId;
  state.editingSaleTotal = currentTotal;
  state.editingSalePaymentMethod = currentPaymentMethod || 'Efectivo';
  state.activeModal = 'edit_sale';
  render();
};

window.saveEditSale = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const oldHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> Guardando...';

  try {
    const formData = new FormData(e.target);
    const newTotal = window.getCleanNumber(formData.get('new_total'));
    const newPaymentMethod = formData.get('payment_method') || 'Efectivo';
    
    if (newTotal < 0) throw new Error("El monto no puede ser negativo.");

    // 1. Update sale total and payment method
    const { error: saleErr } = await supabase.from('sales')
      .update({ total: newTotal, payment_method: newPaymentMethod })
      .eq('id', state.editingSaleId);
      
    if (saleErr) throw saleErr;

    // 2. Find and update the associated transaction
    const saleShortId = state.editingSaleId.slice(0,5);
    const sale = state.sales.find(s => s.id === state.editingSaleId);
    let tx = state.transactions.find(t => t.note && t.note.includes(saleShortId));
    
    // Fallback para ventas rápidas/informales que no guardaron la nota
    if (!tx && sale) {
      tx = state.transactions.find(t => 
        t.type === 'income' && 
        t.user_id === sale.user_id && 
        Number(t.amount) === Number(state.editingSaleTotal) &&
        Math.abs(new Date(t.created_at || t.date) - new Date(sale.created_at)) < 60000
      );
    }

    if (tx) {
      const { error: txErr } = await supabase.from('transactions')
        .update({ 
          amount: newTotal, 
          payment_method: newPaymentMethod,
          note: `[Venta POS #${saleShortId}] Clúster Centralizado. Mét: ${newPaymentMethod}`
        })
        .eq('id', tx.id);
      if (txErr) console.warn("Error actualizando transacción:", txErr);
    }

    // 3. Alinear el precio del ítem si es venta única (para de ecosistema completo)
    const sItems = state.saleItems.filter(si => si.sale_id === state.editingSaleId);
    if (sItems.length === 1) {
      await supabase.from('sale_items').update({ price: newTotal }).eq('id', sItems[0].id);
    } else if (sItems.length > 1) {
      // Si hay varios ítems, prorrateamos el nuevo total
      const oldTotal = sItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const ratio = oldTotal > 0 ? newTotal / oldTotal : 1;
      for (const item of sItems) {
        await supabase.from('sale_items').update({ price: Math.round(item.price * ratio) }).eq('id', item.id);
      }
    }
    const pItems = state.pendingProducts.filter(p => p.sale_id === state.editingSaleId);
    if (pItems.length === 1) {
      await supabase.from('pending_products').update({ price: newTotal }).eq('id', pItems[0].id);
    }

    window.showToast("✅ Venta modificada correctamente.", "success");
    state.activeModal = null;
    state.editingSaleId = null;
    await window.fetchData();
    render();
  } catch(err) {
    console.error(err);
    window.showToast("❌ Error al modificar la venta: " + err.message, "danger");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  }
};

window.deleteSale = async (saleId) => {
  if (!confirm("¿Está seguro de que desea eliminar esta venta de forma permanente? Se restablecerá el inventario de los productos asociados.")) return;
  try {
    // 1. Get sale items to restore stock
    const { data: items, error: itemsErr } = await supabase
      .from('sale_items')
      .select('product_id, quantity')
      .eq('sale_id', saleId);
    
    if (itemsErr) throw itemsErr;

    // 2. Restore stock for each product
    if (items && items.length > 0) {
      for (const item of items) {
        if (item.product_id) {
          // Increment stock back
          const { data: p } = await supabase.from('products').select('stock').eq('id', item.product_id).single();
          if (p) {
            await supabase.from('products').update({ stock: p.stock + item.quantity }).eq('id', item.product_id);
          }
        }
      }
    }

    // 3. Delete sale items
    await supabase.from('sale_items').delete().eq('sale_id', saleId);

    // 4. Delete pending products if any
    await supabase.from('pending_products').delete().eq('sale_id', saleId);

    // 5. Delete associated transaction
    const saleShortId = saleId.slice(0,5);
    const sale = state.sales.find(s => s.id === saleId);
    let tx = state.transactions.find(t => t.note && t.note.includes(saleShortId));
    if (!tx && sale) {
      tx = state.transactions.find(t => 
        t.type === 'income' && 
        t.user_id === sale.user_id && 
        Number(t.amount) === Number(sale.total) &&
        Math.abs(new Date(t.created_at || t.date) - new Date(sale.created_at)) < 60000
      );
    }
    if (tx) {
      await supabase.from('transactions').delete().eq('id', tx.id);
    }

    // 6. Delete sale
    const { error: delSaleErr } = await supabase.from('sales').delete().eq('id', saleId);
    if (delSaleErr) throw delSaleErr;

    window.showToast("🗑️ Venta eliminada e inventario restablecido.", "success");
    state.activeModal = null;
    state.editingSaleId = null;
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("❌ Error al eliminar la venta: " + err.message, "danger");
  }
};

window.openEditTransactionModal = (trxId) => {
  const t = state.transactions.find(tx => tx.id === trxId);
  if (!t) return;
  state.editingTransactionId = trxId;
  state.editingTransactionAmount = t.amount;
  state.editingTransactionType = t.type;
  state.editingTransactionCategoryId = t.category_id;
  state.editingTransactionBusinessId = t.business_id;
  state.editingTransactionNote = t.note || '';
  state.editingTransactionPaymentMethod = t.payment_method || 'Efectivo';
  state.activeModal = 'edit_transaction';
  render();
};

window.saveEditTransaction = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const oldHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> Guardando...';

  try {
    const formData = new FormData(e.target);
    const amount = window.getCleanNumber(formData.get('amount'));
    const type = formData.get('type');
    const category_id = formData.get('category_id');
    const business_id = formData.get('business_id');
    const note = formData.get('note');
    const payment_method = formData.get('payment_method');

    const { error } = await supabase.from('transactions')
      .update({
        amount,
        type,
        category_id: category_id || null,
        business_id: business_id || null,
        note: note || null,
        payment_method
      })
      .eq('id', state.editingTransactionId);

    if (error) throw error;

    window.showToast("✅ Transacción modificada correctamente.", "success");
    state.activeModal = null;
    state.editingTransactionId = null;
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("❌ Error al modificar transacción: " + err.message, "danger");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  }
};

window.deleteTransaction = async (trxId) => {
  if (!confirm("¿Está seguro de que desea eliminar esta transacción de forma permanente?")) return;
  try {
    const { error } = await supabase.from('transactions').delete().eq('id', trxId);
    if (error) throw error;

    window.showToast("🗑️ Transacción eliminada.", "success");
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("❌ Error al eliminar transacción: " + err.message, "danger");
  }
};

window.openEditProductModal = (productId) => {
  const p = state.products.find(prod => prod.id === productId);
  if (!p) return;
  state.editingProductId = productId;
  state.editingProductName = p.name;
  state.editingProductPrice = p.price;
  state.editingProductCost = p.cost;
  state.editingProductStock = p.stock;
  state.editingProductIdealStock = p.purchase_price || 0;
  state.editingProductBusinessId = p.business_id;
  state.editingProductGender = p.gender || '';
  state.activeModal = 'edit_product';
  render();
};

window.saveEditProduct = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const oldHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> Guardando...';

  try {
    const formData = new FormData(e.target);
    const name = formData.get('name');
    const price = window.getCleanNumber(formData.get('price'));
    const cost = window.getCleanNumber(formData.get('cost'));
    const stock = window.getCleanNumber(formData.get('stock'));
    const purchase_price = window.getCleanNumber(formData.get('purchase_price')) || 0;
    const business_id = formData.get('business_id');
    const gender = formData.get('gender') || null;

    const { error } = await supabase.from('products')
      .update({
        name,
        price,
        cost,
        stock,
        purchase_price,
        business_id,
        gender
      })
      .eq('id', state.editingProductId);

    if (error) throw error;

    window.showToast("✅ Producto modificado correctamente.", "success");
    state.activeModal = null;
    state.editingProductId = null;
    await window.fetchData();
    render();
  } catch (err) {
    console.error(err);
    window.showToast("❌ Error al modificar producto: " + err.message, "danger");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  }
};
