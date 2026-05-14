import './style.css'
import { supabase } from './lib/supabase'
import { SupplierService } from './services/SupplierService'
import { DatabaseService } from './services/DatabaseService'
import { byodService } from './services/ByodComplianceService'
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
  timeFilter: 'monthly',
  loading: true,
  view: 'loading',
  authError: null,
  activeModal: null,
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
  sales: [],
  saleItems: [],
  pendingProducts: [],
  payrollData: null,
  qaResults: [],
  editingRateUser: null,
  posPaymentMethod: 'Efectivo'
};

window.fetchData = async () => {
  try {
    state.loading = true;
    
    // 1. Cargar Negocios (con datos de geocerca)
    const { data: busRes } = await supabase.from('businesses').select('id, name, type, lat, lng, geofence_radius_meters');
    state.businesses = busRes || [];

    // 2. Verificar Sesión
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { 
      if (state.view !== 'register') state.view = 'auth'; 
      state.loading = false;
      render(); 
      return; 
    }

    // 3. Cargar Perfil del Usuario logueado
    const { data: profRes } = await supabase.from('users').select('*').eq('id', session.user.id).maybeSingle();
    
    state.user = profRes || { id: session.user.id, name: 'Admin', role: 'admin' };

    // 3. Determinar Negocio Actual antes de seguir
    // (Aún no tenemos turnos, así que usamos el del perfil como fallback temporal)
    const initialBusId = state.currentBusinessId === 'all' ? 'all' : (state.currentBusinessId || state.user?.business_id || 'all');

    // 4. Cargar Transacciones y Categorías vía DatabaseService
    const [categories, transactions] = await Promise.all([
      DatabaseService.fetchCategories(),
      DatabaseService.fetchTransactions(initialBusId)
    ]);

    state.categories = categories || [];
    state.transactions = transactions || [];

    // 5. Cargas Administrativas o de Colaborador (Turnos)
    if (state.user.role === 'admin') {
      const [shRes, empRes, salesRes, itemsRes, pendingRes, loadedSuppliers] = await Promise.all([
        supabase.from('shifts').select('*, businesses(name)').order('start_time', { ascending: false }),
        supabase.from('users').select('*').neq('role', 'admin'),
        supabase.from('sales').select('*').order('created_at', { ascending: false }).limit(200),
        supabase.from('sale_items').select('*, products(name, business_id)'),
        supabase.from('pending_products').select('*').order('created_at', { ascending: false }),
        SupplierService.loadAll(state.user.id)
      ]);
      state.shifts = shRes.data || [];
      state.employees = empRes.data || [];
      state.sales = salesRes.data || [];
      state.saleItems = itemsRes.data || [];
      state.pendingProducts = pendingRes.data || [];
      state.suppliers = loadedSuppliers || [];
    } else {
      const [shRes, attRes] = await Promise.all([
        supabase.from('shifts').select('*').eq('user_id', session.user.id),
        supabase.from('system_logs').select('message').eq('user_id', session.user.id).eq('type', 'GEOLOCATION_TRACK').order('timestamp', { ascending: false }).limit(1)
      ]);
      state.shifts = shRes.data || [];
      
      // Validar si hay un turno físico activo por GPS
      let hasGeoActive = false;
      try {
        if (attRes.data?.[0]) {
          const msg = JSON.parse(attRes.data[0].message);
          if (msg.text && msg.text.includes('LLEGADA')) hasGeoActive = true;
        }
      } catch(e) {}
      state.hasActiveAttendance = hasGeoActive;
      
      // Activar/Desactivar motor de telemetría silenciosa BYOD
      if (hasGeoActive && state.user?.role !== 'admin') {
         byodService.startTracking(session.user.id);
      } else {
         byodService.stopTracking();
      }
    }

    // 6. Actualizar Turno Activo y Negocio Definitivo
    const nowLocal = new Date();
    const activeShift = (state.shifts || []).find(s => {
      const start = new Date(s.start_time);
      const end = new Date(s.end_time);
      return nowLocal >= new Date(start.getTime() - 60000) && nowLocal <= end;
    });

    // Prioridad: Se aprueba por Horario Programado O por Marcación Real de Asistencia (GPS)
    state.activeShiftBusinessId = activeShift?.business_id || (state.hasActiveAttendance ? state.user?.business_id : null);
    state.currentBusinessId = state.activeShiftBusinessId || state.user?.business_id || 'all';

    // 7. Carga de productos (Agrupación Inteligente para Clúster Centralizado)
    let prodQuery = supabase.from('products').select('*, businesses(name)').order('name');
    const finalFilterId = state.activeShiftBusinessId || (state.currentBusinessId !== 'all' ? state.currentBusinessId : null);
    
    if (finalFilterId) {
       const activeBiz = state.businesses.find(b => b.id === finalFilterId);
       const clusterKeywords = ['electro', 'mueble', 'ropa', 'pañalera'];
       const isCentralHub = activeBiz && clusterKeywords.some(kw => activeBiz.name?.toLowerCase().includes(kw));

       if (isCentralHub) {
          // Habilitar inventario consolidado unificado entre todas las sedes del clúster operativo centralizado
          const clusterIds = state.businesses
            .filter(b => clusterKeywords.some(kw => b.name?.toLowerCase().includes(kw)))
            .map(b => b.id);
          
          prodQuery = prodQuery.in('business_id', clusterIds);
       } else {
          prodQuery = prodQuery.eq('business_id', finalFilterId);
       }
    } else if (state.user.role !== 'admin' && state.user.business_id) {
       prodQuery = prodQuery.eq('business_id', state.user.business_id);
    }
    
    const { data: prodData } = await prodQuery;
    state.products = prodData || [];

  } catch (e) { 
    console.error("Error Crítico en fetchData:", e);
    window.showToast('âš ï¸  Error de conexión: ' + e.message, 'danger');
  } finally { state.loading = false; render(); }
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
    const [hbRes, scRes, logsRes, shiftRes] = await Promise.all([
      supabase.from('device_heartbeats').select('*').order('timestamp', { ascending: false }).limit(150),
      supabase.from('operational_scores').select('*').order('score', { ascending: false }),
      supabase.from('system_logs').select('*').eq('type', 'SECURITY_ALERT').order('timestamp', { ascending: false }).limit(10),
      supabase.from('shifts').select('*, businesses(id, name, lat, lng, geofence_radius_meters)').is('end_time', null)
    ]);
    
    if (hbRes.error) throw hbRes.error;
    if (scRes.error) throw scRes.error;
    if (logsRes.error) throw logsRes.error;
    if (shiftRes.error) throw shiftRes.error;

    state.byodHeartbeats = hbRes.data || [];
    state.byodScores = scRes.data || [];
    state.byodSecurityLogs = logsRes.data || [];
    state.byodActiveShifts = shiftRes.data || [];
    
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
      state.activeShiftBusinessId = shiftBusId;
    } catch(e) { console.warn("Error en RPC get_active_shift:", e); }
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

window.saveTransaction = async (e, type) => {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector('button[type="submit"]') || e.target.querySelector('button');
  const originalHtml = btn.innerHTML;
  
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> GUARDANDO...';
    
    const form = new FormData(e.target);
    const amount = form.get('amount');
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
  if (!confirm("Â¿Estás seguro de eliminar este turno?")) return;
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

window.handleLogin = async (e) => {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector('button');
  const originalHtml = btn.innerHTML;
  
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> ENTRANDO...';
    
    const email = e.target[0].value;
    const password = e.target[1].value;
    
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { 
      state.authError = error.message; 
      state.loading = false; 
      window.logSystemError('Auth Error', error.message, 'Login');
      render(); 
    }
    else { 
      state.view = 'app'; 
      await fetchData(); 
    }
  } catch (err) {
    console.error(err);
    window.showToast("Error de conexión", "danger");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
};

window.handleLogout = async () => {
  state.loading = true; render();
  byodService.stopTracking();
  await supabase.auth.signOut();
  location.reload();
};

window.handleRegister = async (e) => {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector('button');
  const originalHtml = btn.innerHTML;

  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> REGISTRANDO...';

    const name = e.target[0].value;
    const email = e.target[1].value;
    const password = e.target[2].value;
    const busId = e.target[3].value;
    
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
        state.view = 'app';
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

  state.shiftReportData = { totalSales, totalExpenses, balance, count: myTrx.length };
  state.activeModal = 'shift_report';
  render();
};


const render = () => {
  const app = document.getElementById('app');
  if (state.loading && state.view === 'loading') { app.innerHTML = '<div style="padding:100px;text-align:center;">Cargando...</div>'; return; }
  
  let html = '';
  if (state.view === 'auth') {
    html = `
      <div class="container auth-view">
        <div class="logo-container" style="justify-content:center; margin-bottom:30px;">
          <div class="logo-icon" style="width:80px; height:80px;">
            <img src="logo_v3.png" alt="Logo">
          </div>
          <div class="header-title">
            <h1 style="font-size:28px;">Surtihogar G&C</h1>
          </div>
        </div>
        <form onsubmit="window.handleLogin(event)" class="card">
          <input type="email" class="form-input" placeholder="Email" autocomplete="username" required style="margin-bottom:12px;">
          <input type="password" class="form-input" placeholder="Clave" autocomplete="current-password" required style="margin-bottom:12px;">
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
          <input type="password" class="form-input" placeholder="Clave" autocomplete="new-password" required style="margin-bottom:12px;">
          <select class="form-input" style="margin-bottom:12px;">
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
    const filteredProducts = state.products.filter(p => 
      p.name.toLowerCase().includes(state.posSearch.toLowerCase())
    );
    const cartTotal = state.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

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
        <div class="pos-main">
          <div style="display:flex; gap:10px;">
            <div style="position:relative; flex:1;">
              <i data-lucide="search" style="position:absolute; left:15px; top:15px; color:#94a3b8; width:20px;"></i>
              <input type="text" id="pos-search-input" class="form-input" placeholder="Buscar producto..." 
                value="${state.posSearch}" 
                oninput="window.handlePosSearch(this.value)" 
                style="width:100%; margin:0; height:50px; font-size:16px; padding-left:45px;">
            </div>
            <div style="display:flex; gap:10px;">
              ${(state.user?.role === 'admin' || state.user?.can_manage_inventory) ? `
                <button onclick="state.activeModal='new_product';render()" class="btn-primary" style="width:auto; padding:0 20px; background:var(--primary);">+ NUEVO</button>
                <button onclick="state.activeModal='add_inventory';render()" class="btn-primary" style="width:auto; padding:0 20px; background:#475569;">+ INVENTARIO</button>
              ` : ''}
              <button onclick="state.activeModal='pending_product';render()" class="btn-primary" style="width:auto; padding:0 20px; background:var(--secondary);">+ NO REGISTRADO</button>
            </div>
          </div>

          <div id="pos-product-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:15px; overflow-y:auto; padding-bottom:50px;">
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
                <option value="Llano Gas" ${state.posPaymentMethod === 'Llano Gas' ? 'selected' : ''}>🔥 Llano Gas</option>
              </select>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom:15px;">
              <span style="font-weight:600;">TOTAL</span>
              <span style="font-size:24px; font-weight:800; color:var(--primary);">${formatCurrency(cartTotal)}</span>
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
            <h1>Surtihogar G&C</h1>
          </div>
        </div>
        <div class="header-actions">
          <div style="display:flex; gap:8px; padding-right:10px; border-right:1px solid #e2e8f0; margin-right:5px;">
            <div onclick="state.view='logs';window.fetchLogs()" class="icon-btn" title="Logs"><i data-lucide="clipboard-list"></i></div>
            <div onclick="state.view='shifts_admin';window.render()" class="icon-btn" title="Turnos"><i data-lucide="clock"></i></div>
            <div onclick="window.fetchByodDashboard()" class="icon-btn" title="Auditoría BYOD" style="background:#f0fdf4; color:#16a34a; border-color:#bbf7d0;"><i data-lucide="shield"></i></div>
            <div onclick="window.fetchData()" class="icon-btn"><i data-lucide="refresh-cw"></i></div>
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
                ${state.currentBusinessId !== 'all' ? `
                  <button onclick="window.setBusinessLocation()" class="btn-secondary" style="padding:8px 12px; font-size:11px; height:40px; background:#eff6ff; border:1px solid #dbeafe; color:#1d4ed8; font-weight:700;" title="Guardar ubicación actual del GPS como centro del negocio"><i data-lucide="map-pin" style="width:14px; margin-right:4px;"></i> FIJAR GPS</button>
                ` : ''}
                <button onclick="window.purgeStagingData()" class="btn-secondary" style="padding:8px 12px; font-size:11px; height:40px; background:#fef2f2; border:1px solid #fee2e2; color:#dc2626; font-weight:700; display:flex; align-items:center; gap:4px;" title="Borrar datos de prueba y preparar producción"><i data-lucide="trash-2" style="width:14px;"></i> LIMPIAR PRUEBAS</button>
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

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:20px; margin-bottom:30px;">
          <button onclick="state.activeModal='sale';render()" class="btn-primary" style="padding:20px; background:var(--secondary); font-size:13px;">+ REGISTRAR VENTA</button>
          <button onclick="state.activeModal='expense';render()" class="btn-primary" style="padding:20px; font-size:13px;">+ REGISTRAR GASTO</button>
          <button onclick="state.view='sales_history_admin';render()" class="btn-primary" style="padding:20px; background:linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); font-size:13px; display:flex; align-items:center; justify-content:center; gap:8px;"><i data-lucide="shopping-bag" style="width:16px;"></i> AUDITAR VENTAS</button>
          <button onclick="state.view='products_admin';render()" class="btn-primary" style="padding:20px; background:#475569; font-size:13px; display:flex; align-items:center; justify-content:center; gap:8px;"><i data-lucide="package" style="width:16px;"></i> GESTIÓN PRODUCTOS</button>
          <button onclick="window.fetchSuppliers()" class="btn-primary" style="padding:20px; background:#0d9488; font-size:13px; display:flex; align-items:center; justify-content:center; gap:8px;"><i data-lucide="truck" style="width:16px;"></i> PROVEEDORES</button>
          <button onclick="window.fetchLogs('attendance_admin')" class="btn-primary" style="padding:20px; background:#10b981; font-size:13px; display:flex; align-items:center; justify-content:center; gap:8px;"><i data-lucide="map-pin" style="width:16px;"></i> ASISTENCIA GPS</button>
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

          <!-- VENTAS POR COLABORADOR -->
          <div class="card">
            <h3 style="font-size:16px; margin-bottom:15px; display:flex; align-items:center; gap:8px;"><i data-lucide="users" style="color:var(--primary); width:18px;"></i> Ventas por COLABORADOR</h3>
            <div style="display:flex; flex-direction:column; gap:10px;">
              ${(() => {
                const userSales = {};
                const ventaCatId = state.categories.find(c => c.name === 'Venta' && c.type === 'income')?.id;
                
                state.transactions
                  .filter(t => t.type === 'income' && (t.category_id === ventaCatId || t.description?.includes('Venta POS')))
                  .forEach(t => {
                    const emp = state.employees.find(e => e.id === t.user_id);
                    const name = emp ? emp.name : (t.user_id === state.user.id ? state.user.name : 'COLABORADOR');
                    userSales[name] = (userSales[name] || 0) + Number(t.amount);
                  });

                const sorted = Object.entries(userSales).sort((a, b) => b[1] - a[1]);

                return sorted.map(([name, total]) => `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:#f8fafc; border-radius:10px;">
                      <span style="font-weight:600; font-size:13px;">${name}</span>
                      <span style="font-weight:800; color:var(--success);">${formatCurrency(total)}</span>
                    </div>
                  `).join('') || '<p style="text-align:center; color:var(--text-muted); padding:20px;">Sin ventas registradas hoy</p>';
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
                  <th style="padding:15px; text-align:center; background:rgba(245,158,11,0.03); border-radius:0 10px 10px 0;">Desfase / Variación</th>
                  <th style="padding:15px; text-align:right;">Liquidación</th>
                </tr>
              </thead>
              <tbody>
                ${!state.payrollData ? `
                  <tr>
                    <td colspan="6" style="text-align:center; padding:60px; background:#f8fafc; border-radius:16px;">
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

  else if (state.view === 'attendance_admin') {
    // 1. AGRUPACIÓN PROFESIONAL DE LOGS POR DÍA Y USUARIO
    const attMap = {};
    
    state.systemLogs.filter(l => l.type === 'GEOLOCATION_TRACK').forEach(l => {
      if (!l.timestamp || !l.users) return;
      
      let msgText = '';
      let context = null;
      try {
        const parsed = JSON.parse(l.message);
        msgText = parsed.text || '';
        context = parsed.context;
      } catch(e) { msgText = l.message || ''; }
      
      const isArr = msgText.includes('LLEGADA');
      const rawD = new Date(l.timestamp);
      
      // INTELIGENCIA DE TURNO NOCTURNO:
      // Si es una SALIDA y ocurre entre 00:00 y 06:00 AM, fusionar con el día anterior calendario
      let d = new Date(l.timestamp);
      if (!isArr && rawD.getHours() < 6) {
        d = new Date(rawD.getTime() - 12 * 60 * 60 * 1000); // Retroceder 12h para caer en la fecha del inicio del turno
      }
      
      // Agrupar por fecha YYYY-MM-DD
      const yr = d.getFullYear();
      const mt = String(d.getMonth() + 1).padStart(2, '0');
      const dy = String(d.getDate()).padStart(2, '0');
      const dateKey = `${yr}-${mt}-${dy}`;
      
      const uName = l.users.name || l.users[0]?.name || 'Desconocido';
      const userId = l.user_id || l.users.id;
      const groupKey = `${userId}_${dateKey}`;
      
      if (!attMap[groupKey]) {
        attMap[groupKey] = {
          user: uName,
          userId: userId,
          dateDisplay: d.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short' }),
          dateKey: dateKey,
          rawDate: d,
          firstArrival: null,
          lastDeparture: null,
          gpsArrival: null,
          gpsDeparture: null
        };
      }
      
      if (isArr) {
        if (!attMap[groupKey].firstArrival || d < new Date(attMap[groupKey].firstArrival)) {
          attMap[groupKey].firstArrival = l.timestamp;
          if (context?.coords) attMap[groupKey].gpsArrival = context.coords;
        }
      } else {
        if (!attMap[groupKey].lastDeparture || d > new Date(attMap[groupKey].lastDeparture)) {
          attMap[groupKey].lastDeparture = l.timestamp;
          if (context?.coords) attMap[groupKey].gpsDeparture = context.coords;
        }
      }
    });

    const rows = Object.values(attMap).sort((a,b) => b.rawDate - a.rawDate);

    html = `
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon" style="background:var(--primary); color:white;"><i data-lucide="calendar-check"></i></div>
          <div class="header-title">
            <p class="role-tag" style="margin:0; background:rgba(59,130,246,0.2); color:var(--primary);">AUDITORÍA DE PERSONAL</p>
            <h1>Consolidado de Asistencia</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="state.view='manager_dashboard';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px;">VOLVER</button>
        </div>
      </header>

      <div class="container" style="max-width:1200px;">
        <div class="card" style="padding:0; overflow:hidden; border-radius:16px;">
          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; text-align:left; font-size:12px;">
              <thead>
                <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0;">
                  <th style="padding:18px 20px; color:var(--text-muted); font-weight:800; letter-spacing:0.5px; text-transform:uppercase; font-size:10px;">Empleado / Fecha</th>
                  <th style="padding:18px; color:var(--text-muted); font-weight:800; letter-spacing:0.5px; text-transform:uppercase; font-size:10px;">Horario Programado</th>
                  <th style="padding:18px; color:var(--text-muted); font-weight:800; letter-spacing:0.5px; text-transform:uppercase; font-size:10px;">Entrada Real</th>
                  <th style="padding:18px; color:var(--text-muted); font-weight:800; letter-spacing:0.5px; text-transform:uppercase; font-size:10px;">Salida Real</th>
                  <th style="padding:18px; color:var(--text-muted); font-weight:800; letter-spacing:0.5px; text-transform:uppercase; font-size:10px;">Estado / GPS</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length === 0 ? `
                  <tr><td colspan="5" style="padding:60px; text-align:center; color:#94a3b8; font-size:14px;">
                    <div style="font-size:30px; margin-bottom:10px;">📅</div> No se encontraron marcaciones consolidadas.
                  </td></tr>
                ` : rows.map(r => {
                  // Buscar si hay un turno programado en el calendario para ese día exacto
                  const scheduled = state.shifts.find(s => {
                    if (s.user_id !== r.userId) return false;
                    const sDate = new Date(s.start_time);
                    const sYr = sDate.getFullYear();
                    const sMt = String(sDate.getMonth() + 1).padStart(2, '0');
                    const sDy = String(sDate.getDate()).padStart(2, '0');
                    return `${sYr}-${sMt}-${sDy}` === r.dateKey;
                  });

                  let scheduledText = '<span style="color:#94a3b8; font-style:italic;">Sin asignar</span>';
                  let statusBadge = '';
                  
                  if (scheduled) {
                    const sStart = new Date(scheduled.start_time);
                    const sEnd = new Date(scheduled.end_time);
                    scheduledText = `<div style="font-weight:700; color:#334155;">${sStart.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} - ${sEnd.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>`;
                    
                    if (r.firstArrival) {
                       const arrTime = new Date(r.firstArrival);
                       // Tolerancia de 10 minutos
                       const isLate = arrTime > new Date(sStart.getTime() + (10 * 60000));
                       statusBadge = isLate 
                         ? `<span style="background:#fffbeb; color:#b45309; padding:4px 8px; border-radius:6px; font-weight:800; font-size:10px; border:1px solid #fef3c7;">⏰ TARDE</span>`
                         : `<span style="background:#f0fdf4; color:#166534; padding:4px 8px; border-radius:6px; font-weight:800; font-size:10px; border:1px solid #dcfce7;">✅ A TIEMPO</span>`;
                    }
                  }

                  if (!statusBadge) {
                    statusBadge = r.lastDeparture 
                      ? `<span style="background:#f1f5f9; color:#475569; padding:4px 8px; border-radius:6px; font-weight:800; font-size:10px;">REGISTRADO</span>`
                      : `<span style="background:#eff6ff; color:#1d4ed8; padding:4px 8px; border-radius:6px; font-weight:800; font-size:10px; border:1px solid #dbeafe;">🟢 EN TURNO</span>`;
                  }

                  const formatTime = (ts) => ts ? `<div style="font-weight:800; font-size:14px; color:#1e293b;">${new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>` : '<div style="color:#cbd5e1; font-weight:500;">--:--</div>';
                  
                  const mapLink = (coords) => coords ? `
                    <a href="https://www.google.com/maps?q=${coords.lat},${coords.lng}" target="_blank" style="color:#10b981; display:inline-flex; align-items:center; gap:4px; text-decoration:none; font-weight:800; margin-left:8px;" title="Ver Mapa"><i data-lucide="map-pin" style="width:12px;"></i></a>
                  ` : '';

                  let arrivalDiffHtml = '';
                  let departureDiffHtml = '';

                  if (scheduled) {
                     const sStart = new Date(scheduled.start_time);
                     const sEnd = new Date(scheduled.end_time);

                     if (r.firstArrival) {
                        const arrT = new Date(r.firstArrival);
                        const diff = Math.floor((arrT.getTime() - sStart.getTime()) / 60000);
                        if (diff > 0) arrivalDiffHtml = `<div style="color:#b45309; font-size:9px; font-weight:800; text-transform:uppercase;">⚠ ${diff} min tarde</div>`;
                        else arrivalDiffHtml = `<div style="color:#166534; font-size:9px; font-weight:800; text-transform:uppercase;">✓ ${Math.abs(diff)} min antes</div>`;
                     }

                     if (r.lastDeparture) {
                        const depT = new Date(r.lastDeparture);
                        const diff = Math.floor((depT.getTime() - sEnd.getTime()) / 60000);
                        if (diff > 0) departureDiffHtml = `<div style="color:#1d4ed8; font-size:9px; font-weight:800; text-transform:uppercase;">⚡ ${diff} min extra</div>`;
                        else departureDiffHtml = `<div style="color:#b91c1c; font-size:9px; font-weight:800; text-transform:uppercase;">❌ ${Math.abs(diff)} min menos</div>`;
                     }
                  }

                  return `
                  <tr style="border-bottom:1px solid #f1f5f9; transition: background 0.2s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
                    <td style="padding:18px 20px;">
                      <div style="font-weight:800; color:var(--primary); font-size:13px;">${r.user}</div>
                      <div style="font-size:11px; color:#64748b; font-weight:600; text-transform: capitalize; margin-top:2px;">📅 ${r.dateDisplay}</div>
                    </td>
                    <td style="padding:18px;">${scheduledText}</td>
                    <td style="padding:18px;">
                      <div style="display:flex; align-items:center;">
                        ${formatTime(r.firstArrival)}
                        ${mapLink(r.gpsArrival)}
                      </div>
                      ${arrivalDiffHtml}
                    </td>
                    <td style="padding:18px;">
                      <div style="display:flex; align-items:center;">
                        ${formatTime(r.lastDeparture)}
                        ${mapLink(r.gpsDeparture)}
                      </div>
                      ${departureDiffHtml}
                    </td>
                    <td style="padding:18px;">
                      <div style="display:flex; align-items:center; gap:8px;">
                        ${statusBadge}
                      </div>
                    </td>
                  </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  else if (state.view === 'logs') {
    // UNIFICACIÓN DE INTELIGENCIA CORPORATIVA: El panel general de auditoría ahora también usa el motor avanzado de agrupamiento
    const attMap = {};
    
    state.systemLogs.filter(l => l.type === 'GEOLOCATION_TRACK').forEach(l => {
      if (!l.timestamp || !l.users) return;
      
      let msgText = '';
      let context = null;
      try {
        const parsed = JSON.parse(l.message);
        msgText = parsed.text || '';
        context = parsed.context;
      } catch(e) { msgText = l.message || ''; }
      
      const isArr = msgText.includes('LLEGADA');
      const rawD = new Date(l.timestamp);
      
      // INTELIGENCIA DE TURNO NOCTURNO:
      let d = new Date(l.timestamp);
      if (!isArr && rawD.getHours() < 6) {
        d = new Date(rawD.getTime() - 12 * 60 * 60 * 1000);
      }
      
      const yr = d.getFullYear();
      const mt = String(d.getMonth() + 1).padStart(2, '0');
      const dy = String(d.getDate()).padStart(2, '0');
      const dateKey = `${yr}-${mt}-${dy}`;
      
      const uName = l.users.name || l.users[0]?.name || 'Desconocido';
      const userId = l.user_id || l.users.id;
      const groupKey = `${userId}_${dateKey}`;
      
      if (!attMap[groupKey]) {
        attMap[groupKey] = {
          user: uName,
          userId: userId,
          dateDisplay: d.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short' }),
          dateKey: dateKey,
          rawDate: d,
          firstArrival: null,
          lastDeparture: null,
          gpsArrival: null,
          gpsDeparture: null
        };
      }
      
      if (isArr) {
        if (!attMap[groupKey].firstArrival || d < new Date(attMap[groupKey].firstArrival)) {
          attMap[groupKey].firstArrival = l.timestamp;
          if (context?.coords) attMap[groupKey].gpsArrival = context.coords;
        }
      } else {
        if (!attMap[groupKey].lastDeparture || d > new Date(attMap[groupKey].lastDeparture)) {
          attMap[groupKey].lastDeparture = l.timestamp;
          if (context?.coords) attMap[groupKey].gpsDeparture = context.coords;
        }
      }
    });

    const rows = Object.values(attMap).sort((a,b) => b.rawDate - a.rawDate);

    html = `
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon" style="background:var(--primary); color:white;"><i data-lucide="clipboard-list"></i></div>
          <div class="header-title">
            <p class="role-tag" style="margin:0; background:rgba(59,130,246,0.2); color:var(--primary);">AUDITORÍA PROFESIONAL</p>
            <h1>Registros del Sistema</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="state.view='manager_dashboard';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px;">DASHBOARD</button>
        </div>
      </header>

      <div class="container" style="max-width:1200px;">
        <div class="card" style="padding:0; overflow:hidden; border-radius:16px;">
          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; text-align:left; font-size:12px;">
              <thead>
                <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0;">
                  <th style="padding:18px 20px; color:var(--text-muted); font-weight:800; letter-spacing:0.5px; text-transform:uppercase; font-size:10px;">Empleado / Fecha</th>
                  <th style="padding:18px; color:var(--text-muted); font-weight:800; letter-spacing:0.5px; text-transform:uppercase; font-size:10px;">Horario Programado</th>
                  <th style="padding:18px; color:var(--text-muted); font-weight:800; letter-spacing:0.5px; text-transform:uppercase; font-size:10px;">Entrada Real</th>
                  <th style="padding:18px; color:var(--text-muted); font-weight:800; letter-spacing:0.5px; text-transform:uppercase; font-size:10px;">Salida Real</th>
                  <th style="padding:18px; color:var(--text-muted); font-weight:800; letter-spacing:0.5px; text-transform:uppercase; font-size:10px;">Estado Operativo</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length === 0 ? `
                  <tr><td colspan="5" style="padding:60px; text-align:center; color:#94a3b8; font-size:14px;">
                    <div style="font-size:30px; margin-bottom:10px;">📅</div> No hay marcaciones disponibles.
                  </td></tr>
                ` : rows.map(r => {
                  const scheduled = state.shifts.find(s => {
                    if (s.user_id !== r.userId) return false;
                    const sDate = new Date(s.start_time);
                    const sYr = sDate.getFullYear();
                    const sMt = String(sDate.getMonth() + 1).padStart(2, '0');
                    const sDy = String(sDate.getDate()).padStart(2, '0');
                    return `${sYr}-${sMt}-${sDy}` === r.dateKey;
                  });

                  let scheduledText = '<span style="color:#94a3b8; font-style:italic;">Sin programar</span>';
                  let statusBadge = '';
                  
                  if (scheduled) {
                    const sStart = new Date(scheduled.start_time);
                    const sEnd = new Date(scheduled.end_time);
                    scheduledText = `<div style="font-weight:700; color:#334155;">${sStart.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} - ${sEnd.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>`;
                    
                    if (r.firstArrival) {
                       const arrTime = new Date(r.firstArrival);
                       const isLate = arrTime > new Date(sStart.getTime() + (10 * 60000));
                       statusBadge = isLate 
                         ? `<span style="background:#fffbeb; color:#b45309; padding:4px 8px; border-radius:6px; font-weight:800; font-size:10px; border:1px solid #fef3c7;">⏰ TARDE</span>`
                         : `<span style="background:#f0fdf4; color:#166534; padding:4px 8px; border-radius:6px; font-weight:800; font-size:10px; border:1px solid #dcfce7;">✅ A TIEMPO</span>`;
                    }
                  }

                  if (!statusBadge) {
                    statusBadge = r.lastDeparture 
                      ? `<span style="background:#f1f5f9; color:#475569; padding:4px 8px; border-radius:6px; font-weight:800; font-size:10px;">FINALIZADO</span>`
                      : `<span style="background:#eff6ff; color:#1d4ed8; padding:4px 8px; border-radius:6px; font-weight:800; font-size:10px; border:1px solid #dbeafe;">🟢 ACTIVO</span>`;
                  }

                  const formatTime = (ts) => ts ? `<div style="font-weight:800; font-size:14px; color:#1e293b;">${new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>` : '<div style="color:#cbd5e1; font-weight:500;">--:--</div>';
                  
                  const mapLink = (coords) => coords ? `
                    <a href="https://www.google.com/maps?q=${coords.lat},${coords.lng}" target="_blank" style="color:#10b981; display:inline-flex; align-items:center; margin-left:8px;" title="GPS"><i data-lucide="map-pin" style="width:12px;"></i></a>
                  ` : '';

                  let arrivalDiffHtml = '';
                  let departureDiffHtml = '';

                  if (scheduled) {
                     const sStart = new Date(scheduled.start_time);
                     const sEnd = new Date(scheduled.end_time);

                     if (r.firstArrival) {
                        const arrT = new Date(r.firstArrival);
                        const diff = Math.floor((arrT.getTime() - sStart.getTime()) / 60000);
                        if (diff > 0) arrivalDiffHtml = `<div style="color:#b45309; font-size:9px; font-weight:800; text-transform:uppercase;">⚠ ${diff} min tarde</div>`;
                        else arrivalDiffHtml = `<div style="color:#166534; font-size:9px; font-weight:800; text-transform:uppercase;">✓ ${Math.abs(diff)} min antes</div>`;
                     }

                     if (r.lastDeparture) {
                        const depT = new Date(r.lastDeparture);
                        const diff = Math.floor((depT.getTime() - sEnd.getTime()) / 60000);
                        if (diff > 0) departureDiffHtml = `<div style="color:#1d4ed8; font-size:9px; font-weight:800; text-transform:uppercase;">⚡ ${diff} min extra</div>`;
                        else departureDiffHtml = `<div style="color:#b91c1c; font-size:9px; font-weight:800; text-transform:uppercase;">❌ ${Math.abs(diff)} min menos</div>`;
                     }
                  }

                  return `
                  <tr style="border-bottom:1px solid #f1f5f9; transition: background 0.2s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
                    <td style="padding:18px 20px;">
                      <div style="font-weight:800; color:var(--primary); font-size:13px;">${r.user}</div>
                      <div style="font-size:11px; color:#64748b; font-weight:600; text-transform: capitalize; margin-top:2px;">📅 ${r.dateDisplay}</div>
                    </td>
                    <td style="padding:18px;">${scheduledText}</td>
                    <td style="padding:18px;">
                      <div style="display:flex; align-items:center;">
                        ${formatTime(r.firstArrival)}
                        ${mapLink(r.gpsArrival)}
                      </div>
                      ${arrivalDiffHtml}
                    </td>
                    <td style="padding:18px;">
                      <div style="display:flex; align-items:center;">
                        ${formatTime(r.lastDeparture)}
                        ${mapLink(r.gpsDeparture)}
                      </div>
                      ${departureDiffHtml}
                    </td>
                    <td style="padding:18px;">${statusBadge}</td>
                  </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
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
        daysCount: 15, // Por defecto 15 días a un mes
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
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon" style="background:var(--primary); color:white;"><i data-lucide="calendar-days"></i></div>
          <div class="header-title">
            <p class="role-tag" style="margin:0; background:rgba(59,130,246,0.1); color:var(--primary);">PLANIFICACIÓN</p>
            <h1>Gestión de Turnos</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="window.openModal('shift')" class="btn-primary" style="padding:10px 20px; font-size:12px; display:flex; align-items:center; gap:6px;"><i data-lucide="plus-circle" style="width:14px;"></i> NUEVO TURNO</button>
          <button onclick="state.view='manager_dashboard';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px; margin-left:10px;">VOLVER</button>
        </div>
      </header>

      <div class="container" style="max-width:1200px;">
        <div class="card" style="padding:0; overflow:hidden;">
          <!-- CONTROLES DE CONFIGURACIÓN DE PLANILLA MÓVIL / MÁS DE 15 DÍAS -->
          <div style="padding:20px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:15px; background:#fafafa;">
            <div>
              <h3 style="font-size:16px; margin:0; font-weight:800; color:#1e293b; display:flex; align-items:center; gap:8px;">
                <i data-lucide="layout-grid" style="width:18px; color:var(--primary);"></i>
                Planilla Dinámica de Personal
              </h3>
              <p style="font-size:11px; color:#94a3b8; margin:2px 0 0 0;">Periodo de ${state.rosterConfig.daysCount} días visible en pantalla</p>
            </div>
            
            <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
              <div style="display:flex; align-items:center; gap:6px;">
                <label style="font-size:10px; font-weight:900; color:#64748b; text-transform:uppercase;">Vista Planilla:</label>
                <select onchange="state.rosterConfig.daysCount = parseInt(this.value); window.render()" class="form-input" style="width:auto; height:36px; font-size:12px; font-weight:700; border-radius:10px; padding:0 10px; border-color:#cbd5e1;">
                  <option value="7" ${state.rosterConfig.daysCount === 7 ? 'selected' : ''}>📋 Semanal (7d)</option>
                  <option value="15" ${state.rosterConfig.daysCount === 15 ? 'selected' : ''}>📋 Quincenal (15d)</option>
                  <option value="30" ${state.rosterConfig.daysCount === 30 ? 'selected' : ''}>📋 Mensual (30d)</option>
                </select>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <label style="font-size:10px; font-weight:900; color:#64748b; text-transform:uppercase;">A partir de:</label>
                <input type="date" onchange="state.rosterConfig.startDate = this.value; window.render()" class="form-input" style="width:auto; height:36px; font-size:12px; font-weight:700; border-radius:10px; padding:0 10px; border-color:#cbd5e1;" value="${state.rosterConfig.startDate}">
              </div>
            </div>
          </div>

          <!-- TABLA DE PLANILLA MATRIX (Horizontal Scroll) -->
          <div style="overflow-x:auto; background:#ffffff; max-height:550px; overflow-y:auto; -webkit-overflow-scrolling: touch; position: relative; border-radius: 0 0 16px 16px;">
            <table style="width: calc(180px + (${state.rosterConfig.daysCount} * 110px)); border-collapse:collapse; font-size:11px; table-layout:fixed;">
              <thead>
                <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0; position:sticky; top:0; z-index:10;">
                  <th style="padding:15px; text-align:left; width:180px; color:#64748b; background:#f8fafc; font-weight:800; text-transform:uppercase; letter-spacing:0.5px; border-right:1px solid #e2e8f0; position:sticky; left:0; z-index:11; box-shadow: 2px 0 5px rgba(0,0,0,0.05);">COLABORADOR</th>
                  ${rosterDates.map(d => {
                    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                    return `<th style="padding:10px; text-align:center; width:110px; color:${isWeekend ? 'var(--danger)' : '#475569'}; font-weight:800; background:${isWeekend ? '#fff1f2' : '#f8fafc'}; border-right:1px solid #edf2f7;">
                      <span style="font-size:9px; opacity:0.7; text-transform:uppercase; display:block;">${d.toLocaleDateString('es-ES', { weekday: 'short' })}</span>
                      <span style="font-size:14px; font-weight:900; display:block; margin-top:2px;">${d.getDate()}</span>
                      <span style="font-size:8px; opacity:0.6; text-transform:uppercase; display:block;">${d.toLocaleDateString('es-ES', { month: 'short' })}</span>
                    </th>`;
                  }).join('')}
                </tr>
              </thead>
              <tbody>
                ${state.employees.map(emp => {
                  const empShifts = state.shifts.filter(s => s.user_id === emp.id);

                  return `
                    <tr style="border-bottom:1px solid #edf2f7; transition: background 0.1s;">
                      <td style="padding:15px; font-weight:800; color:#1e293b; background:#fafbfc; border-right:1px solid #e2e8f0; position:sticky; left:0; z-index:2; box-shadow: 2px 0 5px rgba(0,0,0,0.02);">
                        <div style="display:flex; align-items:center; gap:8px;">
                          <div style="width:26px; height:26px; border-radius:50%; background:var(--primary); color:white; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:900;">${emp.name.charAt(0).toUpperCase()}</div>
                          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${emp.name}</span>
                        </div>
                      </td>
                      ${rosterDates.map(dayDate => {
                        const dayShift = empShifts.find(s => new Date(s.start_time).toDateString() === dayDate.toDateString());
                        const isWeekend = dayDate.getDay() === 0 || dayDate.getDay() === 6;
                        const isToday = dayDate.toDateString() === new Date().toDateString();

                        return `
                          <td style="padding:12px; text-align:center; vertical-align:middle; min-height:90px; border-right:1px solid #edf2f7; background:${isToday ? '#eff6ff' : (isWeekend ? '#fffafb' : '#ffffff')};">
                            ${dayShift ? `
                              <div style="background:linear-gradient(135deg, var(--primary) 0%, #1e293b 100%); color:white; padding:8px; border-radius:10px; font-size:9px; font-weight:700; box-shadow:0 2px 6px rgba(0,0,0,0.1); position:relative; overflow:hidden;" title="Turno asignado en ${dayShift.businesses?.name || 'Sede'}">
                                <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:2px; opacity:0.9; font-size:8px; font-weight:800; text-transform:uppercase;">📍 ${dayShift.businesses?.name || 'Local'}</div>
                                <div style="font-size:10px; display:flex; align-items:center; justify-content:center; gap:2px; font-weight:800;"><i data-lucide="clock" style="width:10px;"></i> ${new Date(dayShift.start_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12: false})}</div>
                                <div style="margin-top:6px; display:flex; justify-content:center; gap:12px; background:rgba(255,255,255,0.15); padding:3px 0; border-radius:6px;">
                                  <span onclick="window.openModal('shift', '${dayShift.id}')" style="cursor:pointer; display:flex; align-items:center; color:white;" title="Editar"><i data-lucide="edit-2" style="width:11px; height:11px;"></i></span>
                                  <span onclick="window.deleteShift('${dayShift.id}')" style="cursor:pointer; display:flex; align-items:center; color:#fca5a5;" title="Borrar"><i data-lucide="trash-2" style="width:11px; height:11px;"></i></span>
                                </div>
                              </div>
                            ` : `
                              <button onclick="window.openModal('shift', null, '${emp.id}', '${dayDate.toISOString()}')" style="width:28px; height:28px; background:#f1f5f9; border:1px dashed #cbd5e1; color:#94a3b8; cursor:pointer; border-radius:8px; font-size:14px; font-weight:800; transition:all 0.2s; display:inline-flex; align-items:center; justify-content:center;" onmouseover="this.style.background='var(--primary)'; this.style.color='white';" onmouseout="this.style.background='#f1f5f9'; this.style.color='#94a3b8';">+</button>
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

        <div class="card" style="margin-top:20px; padding:0; overflow:hidden;">
          <div style="padding:20px; border-bottom:1px solid #f1f5f9;">
            <h3 style="font-size:16px;">Listado de Personal</h3>
          </div>
          <div style="padding:10px;">
            ${state.employees.map(e => `
              <div style="display:flex; justify-content:space-between; align-items:center; padding:15px; background:#f8fafc; border-radius:16px; margin-bottom:10px;">
                <div style="flex:1;">
                  <p style="font-weight:700; font-size:15px;">${e.name}</p>
                  <div style="margin-top:5px; display:flex; gap:10px;">
                      <select onchange="window.updateUserBusiness('${e.id}', this.value)" style="font-size:11px; padding:4px 8px; border-radius:8px; border:1px solid #e2e8f0; background:white; color:var(--text); width:100%; max-width:180px;">
                        <option value="">ðŸ“ Seleccionar Local...</option>
                        ${state.businesses.map(b => `<option value="${b.id}" ${e.business_id === b.id ? 'selected' : ''}>${b.name}</option>`).join('')}
                      </select>
                      <div style="display:flex; align-items:center; gap:5px; background:white; border:1px solid #e2e8f0; border-radius:8px; padding:0 8px;">
                        <span style="font-size:10px; font-weight:800; color:var(--text-muted);">$</span>
                        <input type="number" value="${e.hourly_rate || 0}" onchange="window.updateUserHourlyRate('${e.id}', this.value)" style="border:none; width:60px; font-size:11px; font-weight:700; outline:none;" title="Valor Hora">
                      </div>
                    </div>
                  <p style="font-size:12px; color:var(--text-muted); margin-top:5px;">${state.shifts.filter(s => s.user_id === e.id).length} turnos esta semana</p>
                </div>
                <div style="display:flex; align-items:center; gap:15px;">
                  <label style="display:flex; flex-direction:column; align-items:center; gap:5px; cursor:pointer;">
                    <span style="font-size:9px; font-weight:800; color:${e.can_manage_inventory ? 'var(--success)' : 'var(--text-muted)'};">INVENTARIO</span>
                    <input type="checkbox" onchange="window.toggleInventoryPermission('${e.id}', ${e.can_manage_inventory})" ${e.can_manage_inventory ? 'checked' : ''}>
                  </label>
                  <button onclick="window.openModal('shift', null, '${e.id}')" class="btn-primary" style="padding:8px 16px; font-size:11px;">AGENDAR</button>
                </div>
              </div>
            `).join('')}
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
              <button onclick="window.convertToRealProduct('${p.id}')" class="btn-primary" style="width:auto; padding:8px 15px; font-size:12px;">FORMALIZAR</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
  else if (state.view === 'products_admin') {
    html = `
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon">ðŸ“¦</div>
          <div class="header-title">
            <p class="role-tag" style="margin:0;">INVENTARIO</p>
            <h1>Catálogo de Productos</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="state.activeModal='new_product';render()" class="btn-primary" style="padding:8px 15px; font-size:12px;">+ NUEVO PRODUCTO</button>
          <button onclick="state.view='manager_dashboard';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px; margin-left:10px;">VOLVER</button>
        </div>
      </header>

      <div class="container">
        <div class="card" style="padding:0; overflow:hidden;">
          <table style="width:100%; border-collapse:collapse; font-size:13px;">
            <thead style="background:#f8fafc; color:var(--text-muted);">
              <tr>
                <th style="padding:15px; text-align:left; border-bottom:1px solid #f1f5f9;">Nombre</th>
                <th style="padding:15px; text-align:left; border-bottom:1px solid #f1f5f9;">Precio</th>
                <th style="padding:15px; text-align:left; border-bottom:1px solid #f1f5f9;">Costo</th>
                <th style="padding:15px; text-align:left; border-bottom:1px solid #f1f5f9;">Stock</th>
                <th style="padding:15px; text-align:left; border-bottom:1px solid #f1f5f9;">Registrado por</th>
              </tr>
            </thead>
            <tbody>
              ${state.products.sort((a,b) => a.name.localeCompare(b.name)).map(p => `
                <tr style="border-bottom:1px solid #f1f5f9;">
                  <td style="padding:15px; font-weight:600;">${p.name}</td>
                  <td style="padding:15px;">${formatCurrency(p.price)}</td>
                  <td style="padding:15px; color:var(--text-muted);">${formatCurrency(p.cost || 0)}</td>
                  <td style="padding:15px;"><span style="background:${p.stock < 5 ? '#fee2e2' : '#f0f9ff'}; color:${p.stock < 5 ? '#b91c1c' : '#0369a1'}; padding:4px 10px; border-radius:10px; font-weight:700;">${p.stock}</span></td>
                  <td style="padding:15px; font-size:11px; color:var(--primary); font-weight:600;">👤 ${state.employees.find(e => e.id === p.created_by)?.name || 'Admin'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
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
                            <a href="https://wa.me/57${s.phone.replace(/\D/g, '')}?text=${encodeURIComponent('Hola ' + s.name + ', te saludamos desde Surtihogar G&C. Nos gustaría coordinar un pedido de mercancía para nuestro inventario. ¿Nos podrías confirmar disponibilidad? Quedamos atentos. ¡Muchas gracias!')}" target="_blank" style="background:#22c55e; color:white; padding:5px 10px; border-radius:20px; font-size:10px; font-weight:800; display:inline-flex; align-items:center; gap:4px; text-decoration:none; box-shadow:0 4px 6px -1px rgba(34,197,94,0.3); transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
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
                      <a href="https://wa.me/57${s.phone.replace(/\D/g, '')}?text=${encodeURIComponent('Hola ' + s.name + ', te saludamos desde Surtihogar G&C. Nos gustaría coordinar un pedido de mercancía para nuestro inventario. ¿Nos podrías confirmar disponibilidad? Quedamos atentos. ¡Muchas gracias!')}" target="_blank" style="background:#22c55e; color:white; padding:8px 14px; border-radius:25px; font-size:11px; font-weight:850; display:inline-flex; align-items:center; gap:6px; text-decoration:none; box-shadow:0 4px 12px rgba(34,197,94,0.25); flex-shrink:0;">
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
    html = `
      <header class="main-header" style="background:#0f172a; color:white; border-bottom: 1px solid #1e293b;">
        <div class="logo-container">
          <div class="logo-icon" style="background:rgba(255,255,255,0.1);"><i data-lucide="shield-check" style="color:#10b981;"></i></div>
          <div class="header-title">
            <p class="role-tag" style="background:#10b981; color:white;">BYOD SECURE</p>
            <h1 style="color:white;">Auditoría Operacional</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="window.fetchByodDashboard()" class="btn-secondary" style="background:rgba(255,255,255,0.1); border-color:#334155; color:white;"><i data-lucide="refresh-cw" style="width:14px; margin-right:5px;"></i> ACTUALIZAR</button>
          <div onclick="state.view='manager_dashboard';render()" class="icon-btn pill" style="background:rgba(255,255,255,0.1); color:white; border:none;">Regresar</div>
        </div>
      </header>

      <div class="container" style="max-width:1300px; margin-top:30px; padding-bottom:80px;">
        <!-- ALERTA DE SEGURIDAD FLOTANTE (Si hay logs recientes) -->
        ${(state.byodSecurityLogs || []).length > 0 ? `
          <div style="background:#fef2f2; border-left:5px solid #ef4444; padding:15px 20px; border-radius:12px; margin-bottom:30px; display:flex; align-items:center; gap:15px;">
            <div style="background:#fee2e2; color:#ef4444; width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
              <i data-lucide="alert-triangle" style="width:20px;"></i>
            </div>
            <div style="flex:1;">
              <p style="font-weight:800; font-size:13px; color:#991b1b; text-transform:uppercase; letter-spacing:0.5px;">ALERTA CRÍTICA RECIENTE</p>
              <p style="font-size:13px; color:#b91c1c; margin-top:2px;">${JSON.parse(state.byodSecurityLogs[0].message)?.text || 'Incidente de seguridad detectado'}</p>
            </div>
            <span style="font-size:11px; color:#ef4444; font-weight:700;">Hace un momento</span>
          </div>
        ` : ''}

        <div style="display:grid; grid-template-columns: 1fr 2fr; gap:30px; align-items:start;">
          
          <!-- 📊 COLUMNA IZQUIERDA: SCORES OPERACIONALES -->
          <div style="display:flex; flex-direction:column; gap:25px;">
            <div class="card" style="padding:25px;">
              <h3 style="font-size:15px; font-weight:800; margin-bottom:20px; display:flex; align-items:center; gap:8px; color:#334155;">
                <i data-lucide="award" style="width:16px; color:#6366f1;"></i> RANKING DE CUMPLIMIENTO
              </h3>
              
              <div style="display:flex; flex-direction:column; gap:15px;">
                ${(state.byodScores || []).length === 0 ? '<p style="text-align:center; font-size:12px; color:var(--text-muted); padding:20px;">Calculando primeros índices...</p>' : state.byodScores.map(scoreItem => {
                  const pct = parseFloat(scoreItem.score || 100).toFixed(1);
                  let color = '#10b981';
                  if (pct < 85) color = '#f59e0b';
                  if (pct < 70) color = '#ef4444';
                  
                  const scoreUser = state.employees?.find(e => e.id === scoreItem.user_id) || (state.user?.id === scoreItem.user_id ? state.user : null);
                  
                  return `
                    <div style="background:#f8fafc; border:1px solid #e2e8f0; padding:15px; border-radius:12px; display:flex; align-items:center; justify-content:space-between;">
                      <div>
                        <p style="font-weight:700; font-size:14px; color:#1e293b;">${scoreUser?.name || 'Colaborador'}</p>
                        <p style="font-size:11px; color:#64748b; margin-top:2px;">Incidencias: ${scoreItem.incidents_count || 0}</p>
                      </div>
                      <div style="text-align:right;">
                        <span style="font-size:18px; font-weight:900; color:${color}">${pct}%</span>
                        <div style="width:80px; height:6px; background:#e2e8f0; border-radius:3px; overflow:hidden; margin-top:5px;">
                          <div style="width:${pct}%; height:100%; background:${color}; border-radius:3px;"></div>
                        </div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>

            <!-- CAJA INFO TECNICA -->
            <div class="card" style="background:#0f172a; color:rgba(255,255,255,0.7); padding:20px; border:none;">
              <h4 style="color:white; font-size:13px; font-weight:700; margin-bottom:10px; display:flex; align-items:center; gap:6px;"><i data-lucide="info" style="width:14px;"></i> ¿Cómo funciona?</h4>
              <p style="font-size:11px; line-height:1.6;">Este monitor analiza el latido del dispositivo en tiempo real cada 5 minutos únicamente cuando hay turnos activos. El score deduce puntos automáticamente ante desconexiones y abandonos reiterados de la aplicación.</p>
            </div>
          </div>

          <!-- 📡 COLUMNA DERECHA: MONITOREO Y UBICACIÓN -->
          <div style="display:flex; flex-direction:column; gap:25px;">
            
            <!-- SECCIÓN DE LOCALIZACIÓN ACTIVA -->
            <div class="card" style="padding:25px;">
              <div style="margin-bottom:20px; display:flex; justify-content:space-between; align-items:center;">
                <h3 style="font-size:16px; font-weight:800; color:#1e293b; display:flex; align-items:center; gap:8px; margin:0;">
                  <i data-lucide="map-pin" style="width:18px; color:#ef4444;"></i> UBICACIÓN EN TIEMPO REAL
                </h3>
                <span style="font-size:11px; background:#ecfdf5; color:#047857; padding:4px 10px; border-radius:20px; font-weight:700;">GEOPERÍMETRO ACTIVO</span>
              </div>

              <div style="display:flex; flex-direction:column; gap:15px;">
                ${(() => {
                  // 1. Agrupar por colaborador para tomar solo la señal más reciente
                  const latestByEmployee = {};
                  (state.byodHeartbeats || []).forEach(hb => {
                    if (!latestByEmployee[hb.user_id]) {
                      latestByEmployee[hb.user_id] = hb;
                    }
                  });

                  const uniqueActiveList = Object.values(latestByEmployee);

                  if (uniqueActiveList.length === 0) {
                    return '<div style="padding:40px; text-align:center; color:#64748b; font-size:12px; background:#f8fafc; border-radius:12px;">No hay señales activas transmitiendo en este momento...</div>';
                  }

                  return uniqueActiveList.map(hb => {
                    const hbUser = state.employees?.find(e => e.id === hb.user_id) || (state.user?.id === hb.user_id ? state.user : null);
                    const activeShift = (state.byodActiveShifts || []).find(s => s.user_id === hb.user_id);
                    const biz = activeShift?.businesses || (state.businesses || []).find(b => b.id === activeShift?.business_id);

                    let geofenceStatus = "⚪ SIN COORDENADAS";
                    let statusColor = "#64748b";
                    let badgeBg = "#f1f5f9";
                    let distanceDetail = "Señal de GPS no enviada o desactivada.";
                    let isOutside = false;

                    if (hb.lat && hb.lng && biz && biz.lat && biz.lng) {
                       const distMeters = window.getDistanceInMeters(hb.lat, hb.lng, biz.lat, biz.lng);
                       const maxRadius = biz.geofence_radius_meters || 150;
                       isOutside = distMeters > maxRadius;

                       geofenceStatus = isOutside ? "🚨 FUERA DEL NEGOCIO" : "🟢 DENTRO DEL RANGO";
                       statusColor = isOutside ? "#ef4444" : "#10b981";
                       badgeBg = isOutside ? "#fef2f2" : "#ecfdf5";
                       
                       const distText = distMeters > 1000 ? `${(distMeters/1000).toFixed(2)} km` : `${Math.round(distMeters)} metros`;
                       distanceDetail = `Ubicado a <strong>${distText}</strong> de la sede <strong>${biz.name}</strong> (Límite: ${maxRadius}m).`;
                    } else if (hb.lat && hb.lng) {
                       geofenceStatus = "🔵 RASTREO ACTIVO";
                       statusColor = "#3b82f6";
                       badgeBg = "#eff6ff";
                       distanceDetail = "Transmitiendo coordenadas, pero no tiene turno registrado hoy en esta sede.";
                    }

                    const lastPingTime = new Date(hb.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
                    const mapLink = (hb.lat && hb.lng) ? `https://www.google.com/maps/search/?api=1&query=${hb.lat},${hb.lng}` : '#';

                    return `
                      <div style="background:white; border:1.5px solid ${isOutside ? '#fee2e2' : '#f1f5f9'}; border-radius:16px; padding:20px; display:flex; flex-direction:column; gap:15px; box-shadow:0 4px 6px -1px rgba(0,0,0,0.03);">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                          <div style="display:flex; align-items:center; gap:12px;">
                            <div style="background:${isOutside ? '#fee2e2' : '#f1f5f9'}; color:${isOutside ? '#ef4444' : '#475569'}; width:40px; height:40px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:16px;">
                              ${(hbUser?.name || 'C').charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p style="font-weight:800; font-size:15px; color:#1e293b; margin:0;">${hbUser?.name || 'Colaborador'}</p>
                              <p style="font-size:11px; color:#64748b; margin-top:2px;">Último reporte: ⏱️ ${lastPingTime}</p>
                            </div>
                          </div>
                          
                          <span style="display:inline-flex; align-items:center; font-size:11px; font-weight:800; padding:6px 12px; border-radius:30px; gap:4px; background:${badgeBg}; color:${statusColor}; border:1px solid ${statusColor}33;">
                             ${geofenceStatus}
                          </span>
                        </div>

                        <div style="background:#f8fafc; border-radius:12px; padding:12px 15px; font-size:12px; color:#475569; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                          <span>📍 ${distanceDetail}</span>
                          ${(hb.lat && hb.lng) ? `
                            <a href="${mapLink}" target="_blank" style="background:#1e293b; color:white; padding:8px 14px; border-radius:8px; font-size:11px; font-weight:800; display:inline-flex; align-items:center; gap:6px; text-decoration:none; transition:background 0.2s;" onmouseover="this.style.background='#334155'" onmouseout="this.style.background='#1e293b'">
                              <i data-lucide="map" style="width:12px;"></i> RASTREAR EN MAPA
                            </a>
                          ` : `
                            <span style="font-size:11px; color:#94a3b8; font-weight:700;">SIN GPS</span>
                          `}
                        </div>
                      </div>
                    `;
                  }).join('');
                })()}
              </div>
            </div>

            <!-- HISTORIAL RECIENTE DE SEÑALES (Simplificado) -->
            <div class="card" style="padding:0; overflow:hidden;">
              <div style="padding:15px 20px; border-bottom:1px solid #e2e8f0; background:#f8fafc; display:flex; justify-content:space-between; align-items:center;">
                <h4 style="font-size:13px; font-weight:800; color:#475569; margin:0; display:flex; align-items:center; gap:6px;">
                  <i data-lucide="activity" style="width:14px;"></i> DETALLE DE HISTORIAL COMPLETO
                </h4>
                <span style="font-size:10px; background:#e2e8f0; padding:3px 8px; border-radius:10px; font-weight:700; color:#64748b;">LOGS</span>
              </div>
              <div style="max-height:300px; overflow-y:auto;">
                <table style="width:100%; border-collapse:collapse; font-size:12px;">
                  <thead style="background:#f1f5f9; position:sticky; top:0; text-align:left; color:#64748b; border-bottom:1px solid #e2e8f0;">
                    <tr>
                      <th style="padding:10px 15px; font-weight:700;">COLABORADOR</th>
                      <th style="padding:10px 15px; font-weight:700;">ESTADO APP</th>
                      <th style="padding:10px 15px; font-weight:700; text-align:center;">BAT</th>
                      <th style="padding:10px 15px; font-weight:700; text-align:right;">HORA</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${(state.byodHeartbeats || []).slice(0, 20).map(hb => {
                      const isFg = hb.app_state === 'FOREGROUND';
                      const hbUser = state.employees?.find(e => e.id === hb.user_id) || (state.user?.id === hb.user_id ? state.user : null);
                      return `
                        <tr style="border-bottom:1px solid #f1f5f9;">
                          <td style="padding:10px 15px; font-weight:700; color:#334155;">${hbUser?.name || 'Colaborador'}</td>
                          <td style="padding:10px 15px;">
                            <span style="font-weight:700; color:${isFg ? '#10b981' : '#ea580c'};">${isFg ? 'ACTIVA' : 'BLOQUEADO'}</span>
                          </td>
                          <td style="padding:10px 15px; text-align:center; font-weight:700;">${hb.battery_level || 0}%</td>
                          <td style="padding:10px 15px; text-align:right; color:#64748b;">${new Date(hb.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>

          </div>

        </div>
      </div>
    `;
  }

  else if (state.view === 'sales_history_admin') {
    html = `
      <header class="main-header">
        <div class="logo-container">
          <div class="logo-icon"><img src="logo_v3.png" alt="Logo"></div>
          <div class="header-title">
            <p class="role-tag" style="background:var(--primary);">Auditoría Central</p>
            <h1>Historial de Ventas</h1>
          </div>
        </div>
        <div class="header-actions">
          <button onclick="state.view='manager_dashboard';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px; font-weight:700; display:flex; align-items:center; gap:5px;"><i data-lucide="arrow-left" style="width:14px;"></i> VOLVER</button>
        </div>
      </header>

      <div class="container" style="max-width:1200px; padding-top:20px;">
        <div class="card" style="padding:0; overflow:hidden; border-radius:20px; box-shadow: var(--shadow-lg);">
          <div style="padding:20px 24px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; background:linear-gradient(to right, #f8fafc, #ffffff);">
            <div>
              <h3 style="font-size:18px; font-weight:800; color:#1e293b;">Listado Detallado de Movimientos</h3>
              <p style="font-size:12px; color:#64748b; margin-top:2px;">Auditoría por Local Operativo y Producto Vendido</p>
            </div>
            <div style="background:var(--secondary); color:white; font-weight:800; font-size:12px; padding:6px 14px; border-radius:30px;">
              ${state.sales.length} Ventas
            </div>
          </div>

          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; text-align:left; font-size:13px; min-width:850px;">
              <thead>
                <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0;">
                  <th style="padding:16px 20px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px;">Referencia / Fecha</th>
                  <th style="padding:16px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px;">Vendedor</th>
                  <th style="padding:16px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px;">Negocio / Local</th>
                  <th style="padding:16px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px;">Detalle de Productos</th>
                  <th style="padding:16px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px; text-align:center;">Método</th>
                  <th style="padding:16px 20px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px; text-align:right;">Monto Total</th>
                </tr>
              </thead>
              <tbody>
                ${state.sales.length === 0 ? `
                  <tr><td colspan="6" style="padding:80px; text-align:center; color:#94a3b8;">
                    <div style="font-size:40px; margin-bottom:15px;">📦</div> Sin ventas registradas en el sistema todavía.
                  </td></tr>
                ` : state.sales.map(sale => {
                  const items = state.saleItems.filter(si => si.sale_id === sale.id);
                  
                  // 🏢 Atribución Avanzada del Negocio (Doble Verificación: Producto y Transacciones vinculadas)
                  const bizIdsFromProducts = items.map(i => i.products?.business_id).filter(Boolean);
                  const saleShortId = sale.id.slice(0,5);
                  const bizIdsFromTransactions = state.transactions
                    .filter(t => t.note && t.note.includes(saleShortId))
                    .map(t => t.business_id);
                  
                  const allBizIds = [...new Set([...bizIdsFromProducts, ...bizIdsFromTransactions])];
                  const bizNames = allBizIds.map(id => state.businesses.find(b => b.id === id)?.name || 'General');

                  // 👤 Resolución de Vendedor en Memoria para Evitar Dependencias de Relaciones en BD
                  const sellerObj = state.employees?.find(emp => emp.id === sale.user_id) || (state.user?.id === sale.user_id ? state.user : null);
                  const sellerName = sellerObj?.name || 'Sistema';

                  // 🛍️ Render de Productos (soporta productos del inventario y ventas rápidas no formalizadas)
                  const itemsHtml = items.map(i => {
                    let prodName = i.products?.name;
                    let pendingBadge = '';
                    
                    if (!prodName) {
                       const pending = state.pendingProducts.find(pp => pp.sale_id === sale.id);
                       if (pending) {
                          prodName = pending.name;
                          pendingBadge = '<span style="background:#fff7ed; color:#c2410c; font-size:9px; font-weight:800; padding:1px 4px; border-radius:4px; border:1px solid #fed7aa; margin-left:4px;">POR ASIGNAR</span>';
                       } else if (sale.note && sale.note.includes('Venta informal')) {
                          prodName = sale.note.replace('Venta informal: ', '');
                       } else {
                          prodName = 'Producto Especial';
                       }
                    }

                    return `
                      <div style="display:flex; justify-content:space-between; margin-bottom:6px; padding-bottom:6px; border-bottom:1px dashed #e2e8f0; gap:10px; line-height:1.3;">
                        <span style="font-weight:600; color:#334155;">
                          ${prodName} ${pendingBadge}
                          <span style="color:#94a3b8; font-weight:700; margin-left:3px;">(x${i.quantity})</span>
                        </span>
                        <span style="font-weight:700; color:#64748b; font-family:monospace;">${formatCurrency(i.price)}</span>
                      </div>
                    `;
                  }).join('');

                  return `
                    <tr style="border-bottom:1px solid #f1f5f9; background:white; transition:background 0.15s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='white'">
                      <td style="padding:18px 20px; vertical-align:top;">
                        <div style="font-weight:800; color:#0f172a; font-family:monospace; background:#f1f5f9; padding:3px 6px; border-radius:6px; display:inline-block; font-size:11px;">#${sale.id.slice(0,8).toUpperCase()}</div>
                        <div style="font-size:11px; color:#64748b; margin-top:6px; display:flex; align-items:center; gap:4px;"><i data-lucide="calendar" style="width:11px;"></i> ${new Date(sale.created_at).toLocaleString('es-CO', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})}</div>
                      </td>
                      <td style="padding:18px; vertical-align:top;">
                        <div style="display:flex; align-items:center; gap:10px;">
                          <div style="width:32px; height:32px; background:#e0f2fe; color:#0369a1; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:12px; flex-shrink:0;">${(sellerName).slice(0,2).toUpperCase()}</div>
                          <div style="font-weight:700; color:#334155; font-size:13px;">${sellerName}</div>
                        </div>
                      </td>
                      <td style="padding:18px; vertical-align:top;">
                        <div style="display:flex; flex-wrap:wrap; gap:4px;">
                          ${bizNames.length > 0 ? bizNames.map(n => `<span style="background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; font-size:11px; font-weight:800; padding:3px 8px; border-radius:8px; white-space:nowrap;">🏬 ${n}</span>`).join('') : `<span style="background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; font-size:11px; font-weight:800; padding:3px 8px; border-radius:8px;">📦 Sin Atribuir</span>`}
                        </div>
                      </td>
                      <td style="padding:18px; min-width:280px; vertical-align:top;">
                        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:12px; font-size:12px;">
                          ${itemsHtml || '<span style="font-style:italic; color:#94a3b8;">Sin detalle cargado</span>'}
                        </div>
                      </td>
                      <td style="padding:18px; text-align:center; vertical-align:top;">
                        <span style="background:#f8fafc; color:#475569; font-weight:800; font-size:11px; padding:4px 10px; border-radius:20px; border:1px solid #e2e8f0; white-space:nowrap;">${sale.payment_method || 'Efectivo'}</span>
                      </td>
                      <td style="padding:18px 20px; text-align:right; vertical-align:top;">
                        <div style="font-weight:900; color:var(--success); font-size:15px; font-family:monospace;">${formatCurrency(sale.total)}</div>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
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
          </div>
        </div>
      </div>
    `;
  }


  else {
    // Filtro de negocio: Respetar lo decidido en fetchData (que ya prioriza turnos)
    const currentBusId = state.currentBusinessId;

    const trx = state.transactions.filter(t => currentBusId === 'all' || t.business_id === currentBusId);
    
    // Filtro de fecha LOCAL (Evita problemas de medianoche UTC)
    const getLocalDate = (d) => new Date(d).toLocaleDateString('en-CA'); // Retorna YYYY-MM-DD en hora local
    const todayStr = getLocalDate(new Date());
    
    const timeFilteredTrx = trx.filter(t => {
      const tDateStr = getLocalDate(t.date);
      if (state.timeFilter === 'daily') return tDateStr === todayStr;
      
      const tDate = new Date(t.date);
      const now = new Date();
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
            <h1>Surtihogar G&C</h1>
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
          <p style="opacity: 0.8; font-size: 13px; font-weight: 600;">BALANCE TURNO ACTUAL</p>
          <h2 style="font-size: 38px; font-weight: 800; margin: 10px 0;">${formatCurrency(profit)}</h2>
            ${state.user?.role === 'admin' ? `
              <div class="pill" style="background:rgba(16,185,129,0.2); border:1.5px solid rgba(16,185,129,0.5); font-size:12px; padding:10px 18px; display:inline-flex; align-items:center; gap:8px; border-radius:12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                <span style="width:10px; height:10px; border-radius:50%; background:#10b981; box-shadow: 0 0 8px #10b981;"></span>
                <span style="color:#34d399; font-weight:900; letter-spacing:1.5px; font-size:13px; text-shadow: 0 0 4px rgba(52,211,153,0.3);">ADMINISTRADOR</span>
              </div>
            ` : `
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
          <button onclick="window.openModal('expense')" class="btn-primary" style="padding:15px;">+ GASTO</button>
          <button onclick="window.showShiftReport()" class="btn-primary" style="padding:15px; background:#475569;">📄 REPORTE TURNO</button>
          ${(state.user?.role === 'admin' || state.user?.can_manage_inventory) ? `
            <button onclick="state.activeModal='new_product';render()" class="btn-primary" style="padding:15px; background:var(--primary);">+ NUEVO PROD</button>
          ` : ''}
        </div>

        <div class="activity-section">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
            <h3 style="font-size:18px; font-weight:700;">Actividad Reciente</h3>
            <select class="btn-secondary" style="padding:6px 12px; font-size:12px;" onchange="state.timeFilter=this.value;render()">
              <option value="daily" ${state.timeFilter==='daily'?'selected':''}>Hoy</option>
              <option value="weekly" ${state.timeFilter==='weekly'?'selected':''}>Semana</option>
            </select>
          </div>
          
          <div class="card" style="padding:10px;">
            ${timeFilteredTrx.length === 0 ? `<p style="text-align:center; padding:20px; color:var(--text-muted);">Sin movimientos hoy</p>` : timeFilteredTrx.map(t=>`
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
            <div class="form-group"><label>Monto</label><input type="number" name="amount" class="form-input" placeholder="$ 0" required></div>
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
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
            <div class="form-group">
              <label>Precio Unitario</label>
              <input type="number" name="price" class="form-input" placeholder="$ 0" required>
            </div>
            <div class="form-group">
              <label>Cantidad</label>
              <input type="number" name="quantity" class="form-input" value="1" required min="1">
            </div>
          </div>
          <div class="form-group">
            <label>Foto</label>
            <input type="file" name="photo" class="form-input" accept="image/*" capture="environment" style="padding:10px;">
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
              <input type="number" name="cost" class="form-input" placeholder="$ 0" required min="1">
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
                <input type="number" name="price" id="new-prod-price" value="${selP ? selP.price : ''}" class="form-input" placeholder="$ 0" required min="1" oninput="window.updateMarginCalc()">
              </div>
              <div class="form-group">
                <label>Costo Base</label>
                <input type="number" name="cost" id="new-prod-cost" class="form-input" placeholder="$ 0" required min="1" oninput="window.updateMarginCalc()">
              </div>
            </div>

            <div id="margin-badge" style="font-size:11px; font-weight:800; padding:8px; border-radius:8px; background:#f1f5f9; text-align:center; margin-bottom:15px; color:var(--text-muted);">
              Margen Estimado: 0%
            </div>

            <div class="form-group">
              <label>Stock Inicial</label>
              <input type="number" name="stock" class="form-input" placeholder="0" required min="0">
              <p style="font-size:10px; color:var(--text-muted); margin-top:5px;">Se generará un movimiento de entrada automáticamente.</p>
            </div>
            
            <button class="btn-primary" style="width:100%; margin-top:10px; background:var(--secondary);">✅ REGISTRAR E INICIALIZAR</button>
          </form>
        </div>
      </div>`;
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
              ${state.businesses.filter(b => b.type === 'operativo').map(b => `<option value="${b.id}" ${state.editingShift?.business_id === b.id ? 'selected' : ''}>${b.name}</option>`).join('')}
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
      <div class="modal-card card" style="max-width:420px; background:#0f172a; color:white; border:1px solid rgba(255,255,255,0.1); border-radius:24px;">
        <div class="modal-close" onclick="state.activeModal=null;render()" style="background:rgba(255,255,255,0.1); color:white;">✕</div>
        <div style="text-align:center; padding:10px 0;">
          <h2 style="font-size:20px; font-weight:800; color:white;">Resumen de Turno</h2>
          <p style="font-size:11px; opacity:0.6; color:#94a3b8; margin-top:2px;">Detalle de actividad</p>
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
              <p style="font-size:11px; color:#34d399; font-weight:700; text-transform:uppercase;">Ventas Realizadas</p>
              <p style="font-size:11px; opacity:0.6; margin-top:2px; color:#94a3b8;">${state.shiftReportData?.count || 0} movimientos</p>
            </div>
            <p style="font-size:20px; font-weight:800; color:#34d399;">+ ${formatCurrency(state.shiftReportData?.totalSales || 0)}</p>
          </div>

          <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); padding:16px; border-radius:18px; display:flex; justify-content:space-between; align-items:center;">
            <p style="font-size:11px; color:#f87171; font-weight:700; text-transform:uppercase;">Gastos Registrados</p>
            <p style="font-size:20px; font-weight:800; color:#f87171;">- ${formatCurrency(state.shiftReportData?.totalExpenses || 0)}</p>
          </div>

          <div style="background:rgba(56,189,248,0.08); border:1px dashed rgba(56,189,248,0.3); padding:18px; border-radius:18px; display:flex; justify-content:space-between; align-items:center; margin-top:5px;">
            <span style="font-size:12px; font-weight:700; color:#e2e8f0;">Total Neto en Caja</span>
            <span style="font-size:22px; font-weight:900; color:${(state.shiftReportData?.balance || 0) >= 0 ? '#34d399' : '#f87171'};">${formatCurrency(state.shiftReportData?.balance || 0)}</span>
          </div>
        </div>

        <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
          <button onclick="state.activeModal=null;render()" class="btn-primary" style="background:#334155; border:none; padding:15px; color:#f1f5f9; border-radius:16px; font-weight:700; font-size:14px;">CONFIRMAR Y CERRAR</button>
        </div>
      </div>
    </div>` : ''}

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
                <input type="number" name="total_amount" class="form-input" placeholder="$ 0" required style="height:36px; font-size:12px; border-radius:8px;">
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
                      <input type="number" name="payment_amount" class="form-input" placeholder="$ Abonar" required style="height:32px; font-size:11px; width:95px; padding:0 8px; border-color:#cbd5e1; border-radius:8px;">
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

window.finalizeSale = async () => {
  if (state.cart.length === 0) return;
  
  const pm = state.posPaymentMethod || 'Efectivo';
  const total = state.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  
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
      price: item.price
    }));

    const { error: itemsErr } = await supabase.from('sale_items').insert(saleItems);
    if (itemsErr) throw itemsErr;

    // 3. Crear Transacciones Contables Inteligentes (División por Negocio)
    const totalsByBusiness = {};
    state.cart.forEach(item => {
       const bId = item.business_id || state.activeShiftBusinessId || state.user.business_id || (state.businesses.length > 0 ? state.businesses[0].id : null);
       if (bId) {
          totalsByBusiness[bId] = (totalsByBusiness[bId] || 0) + (item.price * item.quantity);
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
       note: `[Venta POS #${sale.id.slice(0,5)}] Clúster Centralizado. Mét: ${pm}`
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
  const total_amount = parseFloat(formData.get('total_amount')) || 0;
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
        
        // 1. Escribir físicamente el archivo en la carpeta pública "Documentos" del celular
        const writeResult = await Filesystem.writeFile({
          path: safeName,
          data: base64,
          directory: Directory.Documents,
          recursive: true
        });
        
        window.showToast(`📁 Guardado en Documentos (${safeName})`, "success");
        
        // 2. Lanzar la hoja de compartir nativa del celular con el enlace al archivo local
        await Share.share({
          title: `Reporte Contable - ${s.name}`,
          text: `Comparto el reporte contable de ${s.name}.`,
          url: writeResult.uri
        });
        
        isCompleted = true;
      } catch (nativeErr) {
        console.error("Fallo en almacenamiento/compartir nativo:", nativeErr);
        window.showToast("⚠️ Error al acceder al disco nativo. Intentando alternativas...", "warning");
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
  if (!file) return null;
  const fileExt = file.name.split('.').pop();
  const fileName = `${Math.random()}.${fileExt}`;
  const filePath = `${fileName}`;
  
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(filePath, file);

  if (uploadError) {
    console.error('Error al subir imagen:', uploadError);
    return null;
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
  return data.publicUrl;
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
    const price = parseFloat(formData.get('price'));
    const quantity = parseFloat(formData.get('quantity'));
    const photoFile = formData.get('photo');
    const total = price * quantity;

    // BLOQUEO DE SEGURIDAD: Venta Rápida (Excluye Admin)
    const isAdmin = state.user?.role === 'admin';
    if (!isAdmin && state.user?.role !== 'admin' && !state.activeShiftBusinessId) {
      window.showToast("ðŸš« No tienes turno activo para registrar esta mercancía.", "danger");
      return;
    }

    // 1. Subir foto
    let photoUrl = null;
    if (photoFile && photoFile.size > 0) {
      photoUrl = await window.uploadPhoto(photoFile, 'pending_products');
    }

    // 2. Crear Venta
    const { data: sale, error: saleErr } = await supabase.from('sales').insert({
      user_id: state.user.id,
      total: total,
      note: `Venta informal: ${name}`
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
    const { error: pendingErr } = await supabase.from('pending_products').insert({
      name,
      photo_url: photoUrl,
      created_by: state.user.id,
      sale_id: sale.id,
      quantity,
      price
    });

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
        description: `Venta Rápida: ${name}`
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
    const quantity = parseFloat(formData.get('quantity'));
    const cost = parseFloat(formData.get('cost'));
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
  if (!confirm("🚨 ¡ADVERTENCIA CRÍTICA DE PRODUCCIÓN!\n\nEsta acción eliminará permanentemente:\n- TODOS los turnos de prueba\n- TODOS los productos e inventarios creados hasta hoy\n- TODAS las ventas, movimientos y gastos registrados.\n\n¿Estás 100% seguro de que deseas vaciar la base de datos para empezar de cero?")) return;
  
  const secondConfirm = prompt("Escribe 'BORRAR' en mayúsculas para confirmar la purga definitiva de la base de datos:");
  if (secondConfirm !== 'BORRAR') {
    window.showToast("Operación cancelada", "info");
    return;
  }

  state.loading = true;
  window.render();

  try {
    window.showToast("⏳ Iniciando purga de datos relacionales...", "info");
    
    // 1. Detalle de Ventas (sale_items)
    const { error: e1 } = await supabase.from('sale_items').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e1) throw e1;
    
    // 2. Movimientos de Kárdex (inventory_movements)
    const { error: e2 } = await supabase.from('inventory_movements').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e2) throw e2;
    
    // 3. Transacciones de Caja (transactions)
    const { error: e3 } = await supabase.from('transactions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e3) throw e3;

    // 4. Turnos Abiertos/Cerrados (shifts)
    const { error: e4 } = await supabase.from('shifts').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e4) throw e4;

    // 5. Catálogo de Productos (products)
    const { error: e5 } = await supabase.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e5) throw e5;

    // 6. Latidos BYOD (device_heartbeats)
    await supabase.from('device_heartbeats').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    // 7. Logs Generales (system_logs)
    await supabase.from('system_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    window.showToast("🎯 BASE DE DATOS LIMPIA. Lista para producción absoluta.", "success");
    
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
  const price = parseFloat(document.getElementById('new-prod-price')?.value) || 0;
  const cost = parseFloat(document.getElementById('new-prod-cost')?.value) || 0;
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
    const price = parseFloat(formData.get('price'));
    const cost = parseFloat(formData.get('cost'));
    const stock = parseFloat(formData.get('stock'));
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
    const { data: prod, error: pErr } = await supabase.from('products').insert({
      name, price, cost, stock: 0, business_id: busId, created_by: state.user.id
    }).select().single();

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
    window.showToast('âŒ Error: ' + err.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
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

window.handlePosSearch = (val) => {
  state.posSearch = val;
  const list = document.getElementById('pos-products-list');
  if (list) {
    list.innerHTML = window.renderPosProducts();
  }
};

window.renderPosProducts = () => {
  const filtered = state.products.filter(p => 
    p.name.toLowerCase().includes(state.posSearch.toLowerCase()) ||
    (p.barcode && p.barcode.includes(state.posSearch))
  );
  
  if (filtered.length === 0) return '<p style="grid-column:1/-1; text-align:center; padding:40px; color:var(--text-muted);">Sin resultados</p>';
  
  return filtered.map(p => `
    <div class="card" onclick="window.addToCart(${JSON.stringify(p).replace(/"/g, '&quot;')})" style="padding:10px; cursor:pointer; text-align:center;">
      ${p.photo_url ? `<img src="${p.photo_url}" style="width:100%; height:80px; object-fit:cover; border-radius:8px; margin-bottom:5px;">` : '<div style="height:80px; background:#f1f5f9; border-radius:8px; display:flex; align-items:center; justify-content:center; margin-bottom:5px;">ðŸ“¦</div>'}
      <p style="font-size:11px; font-weight:700; margin:0; height:2.4em; overflow:hidden;">${p.name}</p>
      <p style="font-size:12px; font-weight:800; color:var(--primary); margin:5px 0 0 0;">${formatCurrency(p.price)}</p>
    </div>
  `).join('');
};

window.handlePosSearch = (val) => {
  state.posSearch = val;
  const grid = document.getElementById('pos-product-grid');
  if (grid) {
    grid.innerHTML = window.renderPosProducts();
  }
};

window.renderPosProducts = () => {
  const filtered = state.products.filter(p => 
    p.name.toLowerCase().includes(state.posSearch.toLowerCase()) ||
    (p.barcode && p.barcode.includes(state.posSearch))
  );
  
  if (filtered.length === 0) return '<p style="grid-column:1/-1; text-align:center; padding:40px; color:var(--text-muted);">No se encontraron productos</p>';
  
  return filtered.map(p => `
    <div class="card" onclick="window.addToCart('${p.id}')" style="cursor:pointer; padding:15px; display:flex; flex-direction:column; justify-content:space-between; transition:transform 0.1s; border:1px solid #e2e8f0;">
      <div>
        <span style="display:inline-block; font-size:9px; font-weight:800; text-transform:uppercase; color:#4f46e5; background:#e0e7ff; padding:3px 8px; border-radius:6px; margin-bottom:8px; border:1px solid #c7d2fe;">🏬 ${p.businesses?.name || 'Sin asignar'}</span>
        <p style="font-weight:700; font-size:15px; margin-bottom:5px;">${p.name}</p>
        <p style="color:var(--text-muted); font-size:12px;">Stock: <span style="color:${p.stock < 5 ? 'var(--danger)' : 'var(--success)'}; font-weight:700;">${p.stock}</span></p>
      </div>
      <p style="font-size:18px; font-weight:800; color:var(--primary); margin-top:10px;">${formatCurrency(p.price)}</p>
    </div>
  `).join('');
};

const originalRender = render;
window.render = () => {
  try {
    originalRender();
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

    // 1. Extraer bitácora de GPS dentro del rango temporal del calendario
    const { data: gpsLogs } = await supabase
      .from('system_logs')
      .select('*')
      .eq('type', 'GEOLOCATION_TRACK')
      .gte('timestamp', startLimit)
      .lte('timestamp', endLimit)
      .order('timestamp', { ascending: true });

    // Procesar para cada empleado
    state.employees.forEach(emp => {
      // A. PLANILLA FIJA (Horas programadas en turnos de la base de datos)
      const empShifts = state.shifts.filter(s => {
        if (s.user_id !== emp.id || !s.end_time) return false;
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
        const empGps = gpsLogs.filter(l => l.user_id === emp.id);
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
            gpsHours += (pair.departure - pair.arrival) / (1000 * 60 * 60);
          }
        });
      }

      // C. Guardar resultado cruzado del desfase
      results[emp.id] = {
        hours: totalHours,
        gpsHours: gpsHours,
        pay: gpsHours * (parseFloat(emp.hourly_rate) || 0), // Liquidamos sobre lo trabajado real!
        shiftsCount: empShifts.length
      };
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

    const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    
    const coords = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy
    };

    // 🛡️ VALIDACIÓN DE GEOCERCA INTELIGENTE
    // Buscar el negocio actual para ver si tiene habilitada la geocerca
    const biz = state.businesses.find(b => b.id === state.currentBusinessId);
    if (biz && biz.lat && biz.lng) {
      const distanceMeters = window.getDistanceInMeters(coords.lat, coords.lng, biz.lat, biz.lng);
      const maxRadius = biz.geofence_radius_meters || 100; // 100 metros por defecto

      if (distanceMeters > maxRadius) {
         window.showToast(`🚫 FUERA DE RANGO: Estás a ${Math.round(distanceMeters)} metros del negocio. Debes estar a menos de ${maxRadius}m para marcar.`, "danger");
         state.loading = false;
         render();
         return; // 🔒 BLOQUEO MAESTRO: Cancela la operación.
      }
    }

    const eventType = type === 'arrival' ? 'LLEGADA' : 'SALIDA';
    const msg = `Registro de ${eventType}`;
    
    try {
      const userId = state.user.id;
      const msgData = JSON.stringify({ text: msg, context: { coords, businessId: state.currentBusinessId } });
      const { error } = await supabase.from('system_logs').insert({ type: 'GEOLOCATION_TRACK', message: msgData, module: 'Asistencia', user_id: userId });
      
      if (error) {
         if (error.message?.includes('fetch') || error.code === 'PGRST301' || error.message?.includes('Failed to fetch')) throw error;
         else { window.showToast(`Error en BD: ${error.message}`, "danger"); return; }
      }
      window.showToast(`✅ ${eventType} registrada con éxito. (Precisión: ${Math.round(coords.accuracy)}m)`, "success");
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
    const { latitude: lat, longitude: lng } = pos.coords;
    
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
