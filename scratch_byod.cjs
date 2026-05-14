const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://ohlfzkshypvxmgztnzub.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obGZ6a3NoeXB2eG1nenRuenViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNTI2NDcsImV4cCI6MjA5MjgyODY0N30.vFoil43f1bRVCO26AZMVzKDXW5mnNAKSpDt6Qf0epjw';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function testQuery() {
  console.log("--- Testing EXPLICIT RELATIONAL System Logs ---");
  const { data, error } = await supabase.from('system_logs').select('*, users!user_id(name)').limit(5);
  console.log("Explicit system_logs:", { hasData: !!data, rowCount: data?.length, error: error?.message });
}

testQuery();
