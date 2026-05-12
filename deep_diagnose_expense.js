import { createClient } from '@supabase/supabase-js'

const url = 'https://ohlfzkshypvxmgztnzub.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obGZ6a3NoeXB2eG1nenRuenViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNTI2NDcsImV4cCI6MjA5MjgyODY0N30.vFoil43f1bRVCO26AZMVzKDXW5mnNAKSpDt6Qf0epjw'
const supabase = createClient(url, key)

async function deepDiagnoseExpense() {
  console.log("== INICIANDO DIAGNÓSTICO DE ALTO NIVEL: COLABORADOR GASTO ==")
  
  // 1. Loguear como el colaborador de pruebas para tener su TOKEN Real!
  console.log("1. Autenticando como colaborador...")
  const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
    email: 'tester2@domain.com',
    password: 'Password123!'
  })
  if (authErr) { console.error("ERROR FATAL DE LOGIN:", authErr); return; }
  
  const userId = authData.user.id
  console.log("✅ Autenticado exitosamente. ID de Usuario:", userId)

  // 2. Obtener el Negocio de su Perfil
  console.log("2. Obteniendo negocio asignado al usuario...")
  const { data: profile } = await supabase.from('users').select('business_id').eq('id', userId).single()
  const busId = profile?.business_id
  console.log("✅ Negocio del colaborador detectado:", busId)
  
  if (!busId) {
     console.log("❌ ALERTA: El usuario no tiene un business_id asignado en su perfil!");
  }

  // 3. Obtener una categoría de gasto válida
  const { data: cats } = await supabase.from('categories').select('id, name').eq('type', 'expense').limit(1)
  const catId = cats?.[0]?.id || null
  const catName = cats?.[0]?.name || 'General'
  console.log("3. Usando Categoría de Gasto:", catName, "ID:", catId)

  // 4. SIMULAR INSERCIÓN EXACTA DE main.js PARA TABLA 'expenses'
  console.log("4. Simulando inserción exacta en tabla 'expenses'...")
  try {
    const resp1 = await supabase.from('expenses').insert({
      amount: parseFloat("20000"),
      category: catName,
      description: `Negocio: ${busId}`,
      image_url: null
    });
    
    if (resp1.error) {
      console.log("❌ ERROR DEVUELTO POR TABLA 'expenses':", resp1.error.code, resp1.error.message, resp1.error.details)
    } else {
      console.log("✅ La tabla 'expenses' ACEPTÓ el registro correctamente.")
    }
  } catch (e) {
    console.error("💥 CRASH INESPERADO AL INSERTAR EN EXPENSES:", e)
  }

  // 5. SIMULAR INSERCIÓN EXACTA DE main.js PARA TABLA 'transactions'
  console.log("5. Simulando inserción exacta en tabla 'transactions'...")
  try {
    const resp2 = await supabase.from('transactions').insert({
      amount: parseFloat("20000"),
      type: 'expense',
      business_id: busId,
      category_id: catId,
      user_id: userId,
      date: new Date().toISOString(),
      note: null
    });
    
    if (resp2.error) {
      console.log("❌ ERROR DEVUELTO POR TABLA 'transactions':", resp2.error.code, resp2.error.message, resp2.error.details)
    } else {
      console.log("✅ La tabla 'transactions' ACEPTÓ el registro correctamente.")
    }
  } catch (e) {
    console.error("💥 CRASH INESPERADO AL INSERTAR EN TRANSACTIONS:", e)
  }
  
  console.log("== FIN DEL DIAGNÓSTICO PROFUNDO ==")
}

deepDiagnoseExpense()
