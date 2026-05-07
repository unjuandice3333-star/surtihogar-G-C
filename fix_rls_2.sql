-- ========================================================
-- RESTAURACIÓN DE LECTURA DE NEGOCIOS (PARA REGISTRO)
-- ========================================================

-- Permitir que cualquier persona vea la lista de negocios para poder registrarse en la app
DROP POLICY IF EXISTS "Enable read access for all users" ON businesses;
DROP POLICY IF EXISTS "Admins see all businesses" ON businesses;
DROP POLICY IF EXISTS "Employees see their business" ON businesses;

CREATE POLICY "Enable read access for all users" ON businesses FOR SELECT USING (true);

-- Las políticas de transacciones se mantienen BLINDADAS (ya están aplicadas)
