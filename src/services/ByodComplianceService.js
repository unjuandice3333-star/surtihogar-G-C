import { supabase } from '../lib/supabase';
import { Geolocation } from '@capacitor/geolocation';

class ByodComplianceService {
  constructor() {
    this.heartbeatInterval = null;
    this.currentUserId = null;
    this.geofence = null; // { lat, lng, geofence_radius_meters, name }
    this.isCurrentlyBreached = false;
    this.batteryInfo = { level: null, isCharging: null };
    
    // Auto-inicializar inspectores de hardware (Batería)
    if (typeof navigator !== 'undefined' && navigator.getBattery) {
      navigator.getBattery().then(battery => {
        this.updateBatteryData(battery);
        battery.addEventListener('levelchange', () => this.updateBatteryData(battery));
        battery.addEventListener('chargingchange', () => this.updateBatteryData(battery));
      });
    }
  }

  updateBatteryData(battery) {
    this.batteryInfo.level = Math.round(battery.level * 100);
    this.batteryInfo.isCharging = battery.charging;
  }

  getDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
    const R = 6371e3; // metros
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

  isPointInPolygon(point, polygon) {
    const x = point[0], y = point[1];
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1];
      const xj = polygon[j][0], yj = polygon[j][1];
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * Inicia el ciclo de telemetría silenciosa del dispositivo.
   */
  startTracking(userId, geofenceData = null) {
    if (!userId) return;
    this.currentUserId = userId;
    this.geofence = geofenceData;
    this.isCurrentlyBreached = false; // Resetear estado al iniciar

    // Detener cualquier instancia previa para evitar loops duplicados
    this.stopTracking();

    console.log("[BYOD_SERVICE] Iniciando motor con Geocerca activa:", geofenceData);

    // 1. Primer pulso inmediato al iniciar el turno
    this.dispatchHeartbeat();

    // 2. Programar pulso silencioso cada 30 segundos para detección rápida de salidas
    this.heartbeatInterval = setInterval(() => {
      this.dispatchHeartbeat();
    }, 30000);
  }

  /**
   * Detiene instantáneamente el motor al cerrar el turno.
   */
  stopTracking() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.geofence = null;
      this.isCurrentlyBreached = false;
      console.log("[BYOD_SERVICE] Motor de cumplimiento detenido.");
    }
  }

  /**
   * Envia notificaciones a Telegram si hay configuración guardada.
   */
  async triggerTelegramAlert(messageText) {
    try {
      const { data: configs, error } = await supabase
        .from('system_logs')
        .select('message')
        .eq('type', 'TELEGRAM_CONFIG')
        .order('timestamp', { ascending: false })
        .limit(1);

      let config = null;
      if (configs && configs.length > 0) {
        config = JSON.parse(configs[0].message);
      }

      // 🛡️ RESPALDO DE SEGURIDAD (Hardcoded Fallback)
      // Si la DB falla (por permisos RLS) o está vacía, usamos la config verificada del usuario.
      const botToken = (config && config.botToken) ? config.botToken : '8037545998:AAH4zgAxhoNbZ1WKJXmCElwq7oHzi7IJ1LY';
      const chatId = (config && config.chatId) ? config.chatId : '6736325362';

      if (!botToken || !chatId) {
        console.warn("[BYOD_SERVICE] Alerta cancelada: No hay Token o ChatID disponible.");
        return;
      }

      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: messageText,
          parse_mode: 'HTML'
        })
      });
      console.log("[BYOD_SERVICE] Alerta de Telegram enviada con éxito.");
    } catch (e) {
      console.warn("[BYOD_SERVICE] Error enviando Telegram:", e.message);
    }
  }

  /**
   * Recolecta telemetría y evalúa la geocerca localmente.
   */
  async dispatchHeartbeat() {
    if (!this.currentUserId) return;

    try {
      // A. Obtener geolocalización precisa
      let coords = { lat: null, lng: null, accuracy: null };
      try {
        const permissions = await Geolocation.checkPermissions();
        if (permissions.location === 'granted') {
          const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
          coords.lat = pos.coords.latitude;
          coords.lng = pos.coords.longitude;
          coords.accuracy = pos.coords.accuracy;
        }
      } catch (geoErr) {
        console.warn("[BYOD_SERVICE] GPS inalcanzable:", geoErr.message);
      }

      // B. Estado de red y hardware
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
      const networkState = isOnline ? (navigator.connection?.type || 'online') : 'offline';
      const appState = typeof document !== 'undefined' ? 
        (document.visibilityState === 'visible' ? 'FOREGROUND' : 'BACKGROUND') : 'UNKNOWN';

      // C. EVALUAR GEOCERCA EN LOCAL (Polígono + Círculo)
      let isBreach = false;
      let distance = 0;

      if (this.geofence && coords.lat) {
        const polyConfig = this.geofence.polygonConfig;
        
        if (polyConfig && polyConfig.polygon && polyConfig.polygon.length >= 3) {
          // 1. Validación por Polígono
          const inside = this.isPointInPolygon([coords.lat, coords.lng], polyConfig.polygon);
          if (!inside) {
            // 2. Validación por Buffer (Tolerancia)
            distance = this.getDistance(coords.lat, coords.lng, this.geofence.lat, this.geofence.lng);
            const tolerance = polyConfig.buffer || 30;
            if (distance > (tolerance + 20)) { // +20m de margen por drift
              isBreach = true;
            }
          }
        } else if (this.geofence.lat && this.geofence.lng) {
          // 3. Fallback Circular
          distance = this.getDistance(coords.lat, coords.lng, this.geofence.lat, this.geofence.lng);
          const maxRadius = this.geofence.geofence_radius_meters || 100;
          if (distance > maxRadius) {
            isBreach = true;
          }
        }
      }

      // D. Construir payload y guardar pulso
      const payload = {
        user_id: this.currentUserId,
        lat: coords.lat,
        lng: coords.lng,
        accuracy: coords.accuracy,
        battery_level: this.batteryInfo.level || 100,
        is_charging: this.batteryInfo.isCharging || false,
        network_status: String(networkState),
        app_state: appState,
        device_platform: (typeof window !== 'undefined' && window.Capacitor) ? window.Capacitor.getPlatform() : 'web'
      };

      const { error } = await supabase.from('device_heartbeats').insert(payload);
      if (error) throw error;

      // E. MANEJO DE ALARMAS PROACTIVAS (Detección de Cambio de Estado)
      if (isBreach && !this.isCurrentlyBreached) {
        this.isCurrentlyBreached = true;
        
        const { data: user } = await supabase.from('users').select('name').eq('id', this.currentUserId).single();
        const employeeName = user?.name || 'Colaborador';
        
        // 1. Registrar Alerta Crítica (Base de Datos)
        await supabase.from('system_logs').insert({
          user_id: this.currentUserId,
          type: 'SECURITY_ALERT',
          severity: 'CRITICAL',
          module: 'Geocerca BYOD',
          message: JSON.stringify({ 
            text: `🔴 ABANDONO DETECTADO: ${employeeName} salió del perímetro.`, 
            context: { type: 'GEOFENCE_EXIT', distance: Math.round(distance), geofenceName: this.geofence.name } 
          })
        });

        // 2. Notificación Inmediata Telegram con coordenadas y enlace de mapa (Async sin await para no bloquear heartbeat)
        const mapsLink = (coords.lat && coords.lng) ? `https://maps.google.com/?q=${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}` : null;
        const alertMsg = `🚨 <b>ALERTA DE SEGURIDAD</b> 🚨\n\nEl colaborador <b>${employeeName}</b> ha ABANDONADO el perímetro seguro de 📍 <b>${this.geofence.name || 'Sede'}</b>.\n\n📏 Distancia: <b>${Math.round(distance)}m</b>\n🕒 Hora: ${new Date().toLocaleTimeString()}${coords.lat ? `\n📌 Coords: ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}` : ''}${mapsLink ? `\n🗺️ Ver en mapa: ${mapsLink}` : ''}`;
        this.triggerTelegramAlert(alertMsg);
      } 
      
      else if (!isBreach && this.isCurrentlyBreached) {
        this.isCurrentlyBreached = false;
        const { data: user } = await supabase.from('users').select('name').eq('id', this.currentUserId).single();
        const employeeName = user?.name || 'Colaborador';

        await supabase.from('system_logs').insert({
          user_id: this.currentUserId,
          type: 'SECURITY_ALERT',
          severity: 'INFO',
          module: 'Geocerca BYOD',
          message: JSON.stringify({ 
            text: `🟢 REINGRESO: ${employeeName} regresó a la sede.`, 
            context: { type: 'GEOFENCE_RETURN', geofenceName: this.geofence.name } 
          })
        });

        const resolveMsg = `✅ <b>SISTEMA NORMALIZADO</b>\n\nEl colaborador <b>${employeeName}</b> ha reingresado a la sede 📍 <b>${this.geofence.name || 'Sede'}</b>.`;
        this.triggerTelegramAlert(resolveMsg);
      }

    } catch (e) {
      console.error("[BYOD_SERVICE] Error en heartbeat:", e.message);
    }
  }
}

export const byodService = new ByodComplianceService();
