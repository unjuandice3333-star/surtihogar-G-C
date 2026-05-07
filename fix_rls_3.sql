-- ========================================================
-- BLINDAJE FINAL: LECTURA Y BORRADO DE TRANSACCIONES
-- ========================================================

-- Eliminar políticas ambiguas de transacciones
DROP POLICY IF EXISTS "Employees can view business transactions" ON transactions;
DROP POLICY IF EXISTS "Admins can view all transactions" ON transactions;

-- 1. Políticas de LECTURA (SELECT) con referencias explícitas
CREATE POLICY "Admins can view all transactions" ON transactions FOR SELECT 
USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

CREATE POLICY "Employees can view business transactions" ON transactions FOR SELECT 
USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.business_id = transactions.business_id));

-- 2. Asegurarnos que el DELETE esté completamente bloqueado para empleados
-- Las políticas FOR ALL cubren DELETE, pero vamos a ser explícitos.
DROP POLICY IF EXISTS "Admins can update/delete transactions" ON transactions;
CREATE POLICY "Admins can update transactions" ON transactions FOR UPDATE 
USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

CREATE POLICY "Admins can delete transactions" ON transactions FOR DELETE 
USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));
