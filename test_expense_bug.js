import { createClient } from '@supabase/supabase-js'

const url = 'https://ohlfzkshypvxmgztnzub.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obGZ6a3NoeXB2eG1nenRuenViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNTI2NDcsImV4cCI6MjA5MjgyODY0N30.vFoil43f1bRVCO26AZMVzKDXW5mnNAKSpDt6Qf0epjw'
const supabase = createClient(url, key)

async function testExpenseInsert() {
  console.log("== PROBANDO INSERCIÓN DE GASTO ==")
  
  // 1. Test de conexión y lectura simple
  const { data: busData, error: busErr } = await supabase.from('businesses').select('id').limit(1)
  if (busErr) { console.log("❌ Error de conexión básico:", busErr); return; }
  const busId = busData[0].id
  console.log("✅ Conexión exitosa. Usando negocio:", busId)

  // 2. INTENTO DE INSERCIÓN EN TABLA EXPENSES
  console.log("Intentando insertar en tabla 'expenses'...")
  const { data, error } = await supabase.from('expenses').insert({
    amount: 1000,
    category: 'Test',
    description: 'Diagnostic Test'
  })

  if (error) {
    console.log("❌ ERROR CRÍTICO EN 'expenses':", error.code, error.message)
  } else {
    console.log("✅ Inserción en 'expenses' EXITOSA. La tabla sí existe.")
  }
  
  // 3. INTENTO DE INSERCIÓN EN TABLA TRANSACTIONS (Como respaldo contable)
  console.log("Intentando insertar en tabla general 'transactions'...")
  const { error: tError } = await supabase.from('transactions').insert({
    amount: 1000,
    type: 'expense',
    business_id: busId,
    date: new Date().toISOString()
  })
  
  if (tError) {
    console.log("❌ ERROR EN 'transactions':", tError.code, tError.message)
  } else {
    console.log("✅ Inserción en 'transactions' EXITOSA.")
  }
}

testExpenseInsert()
