import { supabase } from '../lib/supabase';
import { Geolocation } from '@capacitor/geolocation';

class ByodComplianceService {
  constructor() {
    this.heartbeatInterval = null;
    this.currentUserId = null;
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

  /**
   * Inicia el ciclo de telemetría silenciosa del dispositivo.
   * Se ejecuta únicamente si hay un turno activo registrado.
   */
  startTracking(userId) {
    if (!userId) return;
    this.currentUserId = userId;

    // Detener cualquier instancia previa para evitar loops duplicados
    this.stopTracking();

    console.log("[BYOD_SERVICE] Iniciando motor de cumplimiento operacional para el usuario:", userId);

    // 1. Primer pulso inmediato al iniciar el turno
    this.dispatchHeartbeat();

    // 2. Programar pulso silencioso cada 5 minutos (300,000 ms)
    this.heartbeatInterval = setInterval(() => {
      this.dispatchHeartbeat();
    }, 300000);
  }

  /**
   * Detiene instantáneamente el motor al cerrar el turno (salida registrada).
   * Libera recursos de hardware y GPS inmediatamente.
   */
  stopTracking() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log("[BYOD_SERVICE] Motor de cumplimiento detenido. Modo pasivo activado.");
    }
  }

  /**
   * Recolecta telemetría de hardware y GPS, y la transmite de forma asíncrona.
   */
  async dispatchHeartbeat() {
    if (!this.currentUserId) return;

    try {
      // A. Obtener geolocalización precisa en segundo plano
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
        console.warn("[BYOD_SERVICE] GPS inalcanzable para el heartbeat:", geoErr.message);
      }

      // B. Estado de red
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
      const networkState = isOnline ? (navigator.connection?.type || 'online') : 'offline';

      // C. Estado visual (Foreground / Background)
      const appState = typeof document !== 'undefined' ? 
        (document.visibilityState === 'visible' ? 'FOREGROUND' : 'BACKGROUND') : 'UNKNOWN';

      // D. Construir payload y enviar a Supabase
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
      console.log("[BYOD_SERVICE] Pulse enviado exitosamente:", new Date().toLocaleTimeString());

    } catch (e) {
      console.error("[BYOD_SERVICE] Error crítico en heartbeat:", e.message);
    }
  }

  /**
   * Detecta manipulación potencial del dispositivo (Tamper Proofing).
   */
  async inspectAntiTamper() {
    const alerts = [];
    const ua = navigator.userAgent?.toLowerCase() || '';

    // 1. Detección simple de emulador (cuerdas conocidas)
    const isEmulator = ua.includes('android sdk') || ua.includes('emulator') || ua.includes('virtualbox');
    if (isEmulator) {
      alerts.push({ type: 'EMULATOR_DETECTED', severity: 'WARNING', text: "⚠️ Uso detectado de emulador del sistema operativo." });
    }

    // 2. Detección de permisos revocados en pleno turno
    try {
      const perm = await Geolocation.checkPermissions();
      if (perm.location !== 'granted') {
        alerts.push({ type: 'GPS_REVOKED', severity: 'CRITICAL', text: "🚨 PERMISO DENEGADO: El empleado desactivó el permiso de GPS a mitad del turno." });
      }
    } catch(e) {}

    // Reportar alertas a Supabase si existen
    for (const alert of alerts) {
      try {
        await supabase.from('system_logs').insert({
          user_id: this.currentUserId,
          type: 'SECURITY_ALERT',
          severity: alert.severity,
          module: 'Seguridad BYOD',
          message: JSON.stringify({ text: alert.text, context: { code: alert.type } })
        });
      } catch(err) {}
    }

    return alerts;
  }
}

export const byodService = new ByodComplianceService();
