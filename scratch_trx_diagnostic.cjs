const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://ohlfzkshypvxmgztnzub.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obGZ6a3NoeXB2eG1nenRuenViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNTI2NDcsImV4cCI6MjA5MjgyODY0N30.vFoil43f1bRVCO26AZMVzKDXW5mnNAKSpDt6Qf0epjw';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function runDiagnostics() {
  console.log("--- DIAGNOSTIC START ---");
  const { data: trxs, error: trxErr } = await supabase
    .from('transactions')
    .select('*')
    .order('date', { ascending: false })
    .limit(10);
    
  if (trxErr) {
    console.error("Error fetching transactions:", trxErr);
  } else {
    console.log(`Retrieved ${trxs.length} total transactions.`);
    trxs.forEach(t => {
      console.log(`ID: ${t.id} | UserID: ${t.user_id} | Date: ${t.date} | Amount: ${t.amount} | Type: ${t.type} | Note: ${t.note}`);
    });
  }

  const { data: users, error: userErr } = await supabase.from('users').select('id, name, role');
  if (!userErr) {
     console.log("\nUsers List:");
     console.log(users);
  }
  console.log("--- DIAGNOSTIC END ---");
}

runDiagnostics();
