const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://ohlfzkshypvxmgztnzub.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obGZ6a3NoeXB2eG1nenRuenViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNTI2NDcsImV4cCI6MjA5MjgyODY0N30.vFoil43f1bRVCO26AZMVzKDXW5mnNAKSpDt6Qf0epjw';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function setupBusiness() {
  console.log("Fetching current businesses...");
  const { data: existing, error: fetchErr } = await supabase.from('businesses').select('*');
  if (fetchErr) {
    console.error("Error fetching businesses:", fetchErr);
    return;
  }
  
  console.log("Current Businesses in DB:");
  console.log(existing);

  // Copying lat/lng/radius from the first valid business if available to ensure geofence doesn't crash, or set default values
  const reference = existing.find(b => b.lat && b.lng) || { lat: 4.14, lng: -73.63, geofence_radius_meters: 150 };

  const newBiz = {
     name: 'J&M ROPA',
     type: 'operativo',
     lat: reference.lat,
     lng: reference.lng,
     geofence_radius_meters: reference.geofence_radius_meters
  };

  console.log("\nCreating new business:", newBiz);
  const { data: inserted, error: insertErr } = await supabase.from('businesses').insert(newBiz).select();
  
  if (insertErr) {
    console.error("Error creating business:", insertErr);
  } else {
    console.log("SUCCESS! New business created:", inserted);
  }
}

setupBusiness();
