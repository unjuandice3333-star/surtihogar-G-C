-- ========================================================
-- SISTEMA DE AUDITORÍA DE ERRORES (SYSTEM LOGS)
-- ========================================================

-- 1. Crear la tabla de logs
CREATE TABLE IF NOT EXISTS system_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo TEXT NOT NULL,
    mensaje TEXT NOT NULL,
    modulo TEXT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Activar Row Level Security
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

-- 3. Políticas de Seguridad (RLS)
-- Cualquier usuario autenticado puede reportar un error
CREATE POLICY "Users can insert logs" ON system_logs FOR INSERT 
WITH CHECK (auth.uid() IS NOT NULL);

-- SOLO los administradores pueden ver el panel de errores
CREATE POLICY "Admins can view logs" ON system_logs FOR SELECT 
USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

-- 4. Permitir a los administradores ver los nombres de los usuarios en los logs
DROP POLICY IF EXISTS "Admins can view all users" ON users;
CREATE POLICY "Admins can view all users" ON users FOR SELECT 
USING ((SELECT role FROM users WHERE id = auth.uid() LIMIT 1) = 'admin');
