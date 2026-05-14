const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://ohlfzkshypvxmgztnzub.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obGZ6a3NoeXB2eG1nenRuenViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNTI2NDcsImV4cCI6MjA5MjgyODY0N30.vFoil43f1bRVCO26AZMVzKDXW5mnNAKSpDt6Qf0epjw'
);

async function checkTypes() {
  const { data } = await supabase.from('businesses').select('type');
  const types = [...new Set(data.map(b => b.type))];
  console.log("VALID BUSINESS TYPES IN DATABASE:");
  console.log(types);
}
checkTypes();
