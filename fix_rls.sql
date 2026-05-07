-- ========================================================
-- PARCHE DE SEGURIDAD CRÍTICA: RLS PARA EMPLEADOS
-- ========================================================

-- 1. Asegurarnos de que RLS esté activado
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- 2. Eliminar cualquier política laxa existente (para purgar la vulnerabilidad)
DROP POLICY IF EXISTS "Enable read access for all users" ON businesses;
DROP POLICY IF EXISTS "Admins see all businesses" ON businesses;
DROP POLICY IF EXISTS "Employees see their business" ON businesses;

-- 3. Instalar Políticas Blindadas para Negocios
CREATE POLICY "Admins see all businesses" ON businesses FOR SELECT 
USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

-- SOLUCIÓN AL BUG: Se especifica claramente businesses.id para evitar la ambigüedad en SQL
CREATE POLICY "Employees see their business" ON businesses FOR SELECT 
USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.business_id = businesses.id));

-- 4. Re-Asegurar Inserción de Transacciones
DROP POLICY IF EXISTS "Employees can insert in their business" ON transactions;

CREATE POLICY "Employees can insert in their business" ON transactions FOR INSERT 
WITH CHECK (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'empleado' AND users.business_id = transactions.business_id));

-- 5. Bloquear Borrado de Transacciones
DROP POLICY IF EXISTS "Admins can update/delete transactions" ON transactions;

CREATE POLICY "Admins can update/delete transactions" ON transactions FOR ALL 
USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));
