import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const url = 'https://ohlfzkshypvxmgztnzub.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obGZ6a3NoeXB2eG1nenRuenViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNTI2NDcsImV4cCI6MjA5MjgyODY0N30.vFoil43f1bRVCO26AZMVzKDXW5mnNAKSpDt6Qf0epjw'

const supabase = createClient(url, key)

async function diagnose() {
  console.log("== INICIANDO DIAGNÓSTICO DE BASE DE DATOS ==")
  
  // 1. Autenticarse con el usuario de prueba para simular RLS exactamente
  console.log("Autenticando usuario de prueba...")
  const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
    email: 'tester2@domain.com',
    password: 'Password123!'
  })
  
  if (authErr) {
    console.error("FALLO DE AUTENTICACIÓN:", authErr.message)
    return
  }
  
  const userId = authData.user.id
  console.log("Autenticación Exitosa. UserID:", userId)
  
  // 2. Ejecutar la misma consulta exacta que usa main.js para cargar logs
  console.log("Consultando tabla system_logs para GEOLOCATION_TRACK...")
  const { data: logs, error: logErr } = await supabase
    .from('system_logs')
    .select('message, timestamp, type')
    .eq('user_id', userId)
    .eq('type', 'GEOLOCATION_TRACK')
    .order('timestamp', { ascending: false })
    .limit(3)
    
  if (logErr) {
    console.error("ERROR AL CONSULTAR LOGS:", logErr)
  } else {
    console.log("RESULTADO DE LOGS ENCONTRADOS:", JSON.stringify(logs, null, 2))
  }
  
  console.log("== FIN DIAGNÓSTICO ==")
}

diagnose()
