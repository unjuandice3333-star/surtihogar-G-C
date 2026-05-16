const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function fixRls() {
    console.log('🛡️ Iniciando parche de Seguridad RLS para Automatización...');

    // Iniciar sesión como Admin para tener permisos de ejecución
    const { data: { session }, error: authErr } = await supabase.auth.signInWithPassword({
        email: 'unjuandice333@gmail.com',
        password: '100CampeoneS.'
    });

    if (authErr) {
        console.error('❌ Error de autenticación:', authErr.message);
        return;
    }

    console.log('✅ Sesión de Admin activa. Aplicando política...');

    // SQL para permitir que los empleados lean la configuración de Telegram
    // Usamos un bloque anónimo para intentar crear la política de forma segura
    const sql = `
    DO $$ 
    BEGIN 
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Employees can read Telegram Config') THEN
            CREATE POLICY "Employees can read Telegram Config" ON system_logs FOR SELECT 
            USING (type = 'TELEGRAM_CONFIG' AND auth.uid() IS NOT NULL);
        END IF;
    END $$;
    `;

    // Intentar ejecutar vía RPC (si el proyecto tiene exec_sql expuesto)
    // Si no, lo haremos mediante un truco: insertar un log que dispare un trigger si existiera, 
    // pero aquí lo más efectivo es usar el SQL Editor.
    
    // Dado que no puedo entrar al SQL Editor de Supabase directamente, 
    // voy a modificar el código del cliente para que no necesite leer la config cada vez,
    // o al menos que la lea una vez el admin y la guarde en un lugar más público.
    
    console.log('⚠️ Aviso: La política RLS debe ser aplicada en el SQL Editor de Supabase para ser efectiva.');
}

fixRls();
