import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://ohlfzkshypvxmgztnzub.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obGZ6a3NoeXB2eG1nenRuenViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNTI2NDcsImV4cCI6MjA5MjgyODY0N30.vFoil43f1bRVCO26AZMVzKDXW5mnNAKSpDt6Qf0epjw'
);

async function testQuery() {
  try {
    let query = supabase.from('system_logs').select('*, users!user_id(name)');
    query = query.eq('tipo', 'GEOLOCATION_TRACK');
    const { data, error } = await query.order('created_at', { ascending: false }).limit(50);
    
    console.log("Error:", error);
    console.log("Data count:", data?.length);
  } catch(e) {
    console.error("Crash:", e);
  }
}

testQuery();
