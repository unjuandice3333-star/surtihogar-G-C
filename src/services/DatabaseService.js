import { supabase } from '../lib/supabase';

export class DatabaseService {
  /**
   * Obtiene todas las transacciones ordenadas por fecha descendente.
   */
  static async fetchTransactions(businessId = 'all') {
    let query = supabase.from('transactions').select('*').order('date', { ascending: false });
    if (businessId && businessId !== 'all') {
      query = query.eq('business_id', businessId);
    }
    const { data, error } = await query.limit(500);
    if (error) throw error;
    return data || [];
  }

  /**
   * Obtiene todas las categorías disponibles.
   */
  static async fetchCategories() {
    const { data, error } = await supabase.from('categories').select('*');
    if (error) throw error;
    return data || [];
  }

  /**
   * Registra una nueva transacción en el balance.
   */
  static async insertTransaction(transactionData) {
    const { data, error } = await supabase.from('transactions').insert(transactionData).select().single();
    if (error) throw error;
    return data;
  }
}
