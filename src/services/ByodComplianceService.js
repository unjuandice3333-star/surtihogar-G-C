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

    // 2. Programar pulso silencioso cada 5 minutos (300,000 ms)
    this.heartbeatInterval = setInterval(() => {
      this.dispatchHeartbeat();
    }, 300000);
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

      if (error || !configs || configs.length === 0) {
        console.log("[BYOD_SERVICE] Telegram no configurado en Admin.");
        return;
      }

      const config = JSON.parse(configs[0].message);
      if (!config.botToken || !config.chatId) {
        console.log("[BYOD_SERVICE] Configuración incompleta en system_logs.");
        return;
      }

      const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
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

      // C. EVALUAR GEOCERCA EN LOCAL
      let isBreach = false;
      let distance = 0;

      if (this.geofence && this.geofence.lat && this.geofence.lng && coords.lat) {
        distance = this.getDistance(coords.lat, coords.lng, this.geofence.lat, this.geofence.lng);
        const maxRadius = this.geofence.geofence_radius_meters || 100;
        
        if (distance > maxRadius) {
          isBreach = true;
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

      // E. MANEJO DE ALARMAS PROACTIVAS (Sólo se dispara ante cambio de estado)
      if (isBreach && !this.isCurrentlyBreached) {
        this.isCurrentlyBreached = true;
        
        // Consultar el nombre del empleado para la alerta personalizada
        const { data: user } = await supabase.from('users').select('name').eq('id', this.currentUserId).single();
        const employeeName = user?.name || 'Colaborador';
        const alertMsg = `🚨 <b>ALERTA DE SEGURIDAD</b> 🚨\n\nEl colaborador <b>${employeeName}</b> ha ABANDONADO el perímetro de seguridad de la sede 📍 <b>${this.geofence.name || 'Sede'}</b>.\n\n📏 Distancia registrada: <b>${Math.round(distance)} metros</b> de la sede.\n🕒 Hora: ${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
        
        // 1. Registrar Alerta Crítica en base de datos
        await supabase.from('system_logs').insert({
          user_id: this.currentUserId,
          type: 'SECURITY_ALERT',
          severity: 'CRITICAL',
          module: 'Geocerca BYOD',
          message: JSON.stringify({ 
            text: `ABANDONO DE SEDE: ${employeeName} salió del perímetro. Distancia: ${Math.round(distance)}m.`, 
            context: { type: 'GEOFENCE_EXIT', distance, geofenceName: this.geofence.name } 
          })
        });

        // 2. Enviar mensaje a Telegram
        await this.triggerTelegramAlert(alertMsg);
      } 
      
      else if (!isBreach && this.isCurrentlyBreached) {
        // El empleado regresó a la sede
        this.isCurrentlyBreached = false;
        const { data: user } = await supabase.from('users').select('name').eq('id', this.currentUserId).single();
        const employeeName = user?.name || 'Colaborador';
        
        const resolveMsg = `✅ <b>SISTEMA RESTABLECIDO</b>\n\nEl colaborador <b>${employeeName}</b> ha regresado al perímetro seguro de la sede 📍 <b>${this.geofence.name || 'Sede'}</b>.\n\n🕒 Hora de Reingreso: ${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;

        // 1. Registrar retorno
        await supabase.from('system_logs').insert({
          user_id: this.currentUserId,
          type: 'SECURITY_ALERT',
          severity: 'INFO',
          module: 'Geocerca BYOD',
          message: JSON.stringify({ 
            text: `REINGRESO A SEDE: ${employeeName} regresó al perímetro seguro.`, 
            context: { type: 'GEOFENCE_RETURN', geofenceName: this.geofence.name } 
          })
        });

        // 2. Enviar resolución a Telegram
        await this.triggerTelegramAlert(resolveMsg);
      }

    } catch (e) {
      console.error("[BYOD_SERVICE] Error en heartbeat:", e.message);
    }
  }
}

export const byodService = new ByodComplianceService();
