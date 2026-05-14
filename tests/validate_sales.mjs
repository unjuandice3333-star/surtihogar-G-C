import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  const { data, error } = await supabase.from('sales').select('*').limit(3);
  console.log("Sales data sample:");
  console.dir(data, { depth: null });
  
  const { data: trx, error: tErr } = await supabase.from('transactions').select('*').eq('type', 'expense').limit(3);
  console.log("Expenses sample:");
  console.dir(trx, { depth: null });
}
test();
