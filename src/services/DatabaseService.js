import { supabase } from '../lib/supabase';

export class DatabaseService {
  /**
   * Obtiene todas las transacciones ordenadas por fecha descendente.
   */
  static async fetchTransactions(businessId = 'all') {
    let allData = [];
    let page = 0;
    const PAGE_SIZE = 1000;
    
    while (true) {
      let query = supabase
        .from('transactions')
        .select('*')
        .order('date', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        
      if (businessId && businessId !== 'all') {
        query = query.eq('business_id', businessId);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      
      if (!data || data.length === 0) break;
      allData.push(...data);
      if (data.length < PAGE_SIZE) break;
      page++;
    }
    
    return allData;
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
