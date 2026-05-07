import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: bData } = await supabase.from('businesses').select('id').limit(1);
  const busId = bData[0].id;

  const email = `dbg_${Date.now()}@test.com`;
  const { data: authData, error: authErr } = await supabase.auth.signUp({
    email, password: 'password123', options: { data: { name: 'Dbg', business_id: busId } }
  });
  
  if (authErr) {
    console.error("Auth error", authErr);
    return;
  }
  
  await supabase.auth.signInWithPassword({ email, password: 'password123' });
  const uid = authData.user.id;
  
  const { data: catData } = await supabase.from('categories').select('id').limit(1);
  
  const testStartTime = new Date().toISOString();
  
  const { error: insErr } = await supabase.from('transactions').insert({
    amount: 999, type: 'income', business_id: busId, category_id: catData[0].id, user_id: uid
  });
  
  if (insErr) {
    console.error("Insert error", insErr);
  } else {
    console.log("Inserted perfectly.");
  }
  
  const { data: tData, error: selErr } = await supabase.from('transactions').select('*').eq('user_id', uid).gte('date', testStartTime);
  console.log("Selected:", tData ? tData.length : 0, selErr);
}

run().catch(console.error);
