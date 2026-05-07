-- ==========================================
-- PARCHE 7: GESTIÓN DE TURNOS (SHIFTS)
-- ==========================================

CREATE TABLE IF NOT EXISTS shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Habilitar RLS
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;

-- POLÍTICAS DE SEGURIDAD

-- 1. Admin puede todo
CREATE POLICY "Admins have full access to shifts"
ON shifts FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.id = auth.uid()
    AND users.role = 'admin'
  )
);

-- 2. Empleados pueden ver sus propios turnos
CREATE POLICY "Employees can view their own shifts"
ON shifts FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- 3. Empleados pueden ver qué negocios tienen asignados (opcional, pero útil)
-- (Ya cubierto por la política anterior si solo ven los suyos)

-- Dar permisos a los roles de Supabase
GRANT ALL ON shifts TO authenticated;
GRANT ALL ON shifts TO service_role;
