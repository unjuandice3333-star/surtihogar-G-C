import { supabase } from '../lib/supabase';

export class SupplierService {
  static async loadAll(user_id) {
    try {
      const { data } = await supabase
        .from('system_logs')
        .select('*')
        .eq('type', 'SUPPLIER_RECORD')
        .order('timestamp', { ascending: false })
        .limit(1);

      if (data && data[0] && data[0].message) {
        try {
          const parsed = JSON.parse(data[0].message);
          return parsed.text ? JSON.parse(parsed.text) : parsed; // Handle both old and new formats
        } catch(e) {
          return JSON.parse(data[0].message);
        }
      }
    } catch (e) {
      console.error("No se pudieron cargar los proveedores:", e);
    }
    return [];
  }

  static async saveAll(suppliers, user_id) {
    try {
      const msgData = JSON.stringify({ text: JSON.stringify(suppliers || []) });
      const { error } = await supabase.from('system_logs').insert({
        type: 'SUPPLIER_RECORD',
        module: 'financial',
        message: msgData,
        user_id: user_id || null
      });
      if (error) throw error;
      return true;
    } catch (e) {
      console.error("Error al guardar proveedores:", e);
      return false;
    }
  }
}
