import { supabase } from '../lib/supabase';
import { Geolocation } from '@capacitor/geolocation';

class ByodComplianceService {
  constructor() {
    this.watchId = null;           // ID del stream watchPosition activo
    this.currentUserId = null;
    this.geofence = null;          // { lat, lng, geofence_radius_meters, name, polygonConfig }
    this.isCurrentlyBreached = false;
    this.lastLat = null;           // Última posición enviada (filtro de 5 metros)
    this.lastLng = null;
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
    const R = 6371e3;
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
   * Inicia el stream GPS en tiempo real (como WhatsApp Live Location).
   * Solo envía a la DB cuando el empleado se mueve más de 5 metros.
   */
  startTracking(userId, geofenceData = null) {
    if (!userId) return;
    this.stopTracking(); // Limpiar cualquier stream previo
    this.currentUserId = userId;
    this.geofence = geofenceData;
    this.isCurrentlyBreached = false;
    this.lastLat = null;
    this.lastLng = null;

    console.log('[BYOD_SERVICE] Iniciando stream GPS en tiempo real para usuario:', userId);
    console.log('[BYOD_SERVICE] Geocerca activa:', geofenceData?.name || 'Sin geocerca');

    Geolocation.watchPosition(
      { enableHighAccuracy: true, timeout: 10000 },
      (position, err) => {
        if (err) {
          console.warn('[BYOD_SERVICE] Error GPS en stream:', err.message || err);
          return;
        }
        if (!position) return;

        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = position.coords.accuracy;

        // 🎯 FILTRO DE 5 METROS: No enviar si el empleado no se ha movido lo suficiente
        if (this.lastLat !== null && this.lastLng !== null) {
          const distMoved = this.getDistance(this.lastLat, this.lastLng, lat, lng);
          if (distMoved < 5) return; // Quieto → no gastar DB ni batería
        }

        this.lastLat = lat;
        this.lastLng = lng;

        // Enviar posición nueva a la DB (dispara Supabase Realtime al admin)
        this.sendPosition(lat, lng, accuracy);
      }
    ).then(watchId => {
      this.watchId = watchId;
      console.log('[BYOD_SERVICE] watchPosition activo. ID:', watchId);
    }).catch(err => {
      console.error('[BYOD_SERVICE] No se pudo iniciar watchPosition:', err.message || err);
    });
  }

  /**
   * Detiene instantáneamente el stream GPS.
   */
  stopTracking() {
    if (this.watchId !== null) {
      Geolocation.clearWatch({ id: this.watchId });
      this.watchId = null;
      console.log('[BYOD_SERVICE] Stream GPS detenido.');
    }
    this.geofence = null;
    this.isCurrentlyBreached = false;
    this.lastLat = null;
    this.lastLng = null;
  }

  /**
   * Inserta la posición en device_heartbeats y evalúa la geocerca.
   * Este insert dispara el evento Realtime en el mapa del admin al instante.
   */
  async sendPosition(lat, lng, accuracy) {
    if (!this.currentUserId) return;

    try {
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
      const networkState = isOnline ? (navigator.connection?.type || 'online') : 'offline';
      const appState = typeof document !== 'undefined' ?
        (document.visibilityState === 'visible' ? 'FOREGROUND' : 'BACKGROUND') : 'UNKNOWN';

      // C. EVALUAR GEOCERCA (Polígono + Círculo)
      let isBreach = false;
      let distance = 0;

      if (this.geofence && lat) {
        const polyConfig = this.geofence.polygonConfig;

        if (polyConfig && polyConfig.polygon && polyConfig.polygon.length >= 3) {
          const inside = this.isPointInPolygon([lat, lng], polyConfig.polygon);
          if (!inside) {
            distance = this.getDistance(lat, lng, this.geofence.lat, this.geofence.lng);
            const tolerance = polyConfig.buffer || 30;
            if (distance > (tolerance + 20)) isBreach = true;
          }
        } else if (this.geofence.lat && this.geofence.lng) {
          distance = this.getDistance(lat, lng, this.geofence.lat, this.geofence.lng);
          const maxRadius = this.geofence.geofence_radius_meters || 100;
          if (distance > maxRadius) isBreach = true;
        }
      }

      // D. Insertar en device_heartbeats → dispara Supabase Realtime al instante
      const payload = {
        user_id: this.currentUserId,
        lat,
        lng,
        accuracy,
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

        // Registrar Alerta Crítica en BD
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

        // Alerta Telegram con coordenadas y enlace de mapa
        const mapsLink = `https://maps.google.com/?q=${lat.toFixed(5)},${lng.toFixed(5)}`;
        const alertMsg = `🚨 <b>ALERTA DE SEGURIDAD</b> 🚨\n\nEl colaborador <b>${employeeName}</b> ha ABANDONADO el perímetro seguro de 📍 <b>${this.geofence.name || 'Sede'}</b>.\n\n📏 Distancia: <b>${Math.round(distance)}m</b>\n🕒 Hora: ${new Date().toLocaleTimeString()}\n📌 Coords: ${lat.toFixed(5)}, ${lng.toFixed(5)}\n🗺️ Ver en mapa: ${mapsLink}`;
        this.triggerTelegramAlert(alertMsg);

      } else if (!isBreach && this.isCurrentlyBreached) {
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
      console.error('[BYOD_SERVICE] Error enviando posición:', e.message);
    }
  }

  /**
   * Envía notificaciones a Telegram si hay configuración guardada.
   */
  async triggerTelegramAlert(messageText) {
    try {
      const { data: configs } = await supabase
        .from('system_logs')
        .select('message')
        .eq('type', 'TELEGRAM_CONFIG')
        .order('timestamp', { ascending: false })
        .limit(1);

      let config = null;
      if (configs && configs.length > 0) config = JSON.parse(configs[0].message);

      // 🛡️ Respaldo de seguridad si la DB falla
      const botToken = (config && config.botToken) ? config.botToken : '8037545998:AAH4zgAxhoNbZ1WKJXmCElwq7oHzi7IJ1LY';
      const chatId = (config && config.chatId) ? config.chatId : '6736325362';

      if (!botToken || !chatId) {
        console.warn('[BYOD_SERVICE] Alerta cancelada: No hay Token o ChatID disponible.');
        return;
      }

      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: messageText, parse_mode: 'HTML' })
      });
      console.log('[BYOD_SERVICE] Alerta de Telegram enviada con éxito.');
    } catch (e) {
      console.warn('[BYOD_SERVICE] Error enviando Telegram:', e.message);
    }
  }
}

export const byodService = new ByodComplianceService();
