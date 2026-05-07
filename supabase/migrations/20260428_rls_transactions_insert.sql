-- Migración: Asegurar política de inserción estricta en transactions
-- Objetivo: Que ningún usuario pueda registrar transacciones a nombre de otro

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Eliminar cualquier política de inserción previa para evitar conflictos
DROP POLICY IF EXISTS "Permitir inserción propia" ON transactions;
DROP POLICY IF EXISTS "Users can only insert their own transactions" ON transactions;

-- Crear política estricta: validación de identidad y de tipo de negocio por rol
CREATE POLICY "Permitir inserción según rol y negocio" 
ON transactions 
FOR INSERT 
WITH CHECK (
  (auth.uid() = user_id) -- Validar identidad
  AND (
    -- 1. Los administradores pueden registrar en cualquier negocio
    EXISTS (
      SELECT 1 FROM users 
      WHERE id = auth.uid() AND role = 'admin'
    )
    OR
    -- 2. Los empleados SOLO pueden registrar en negocios de tipo 'operativo'
    (
      EXISTS (
        SELECT 1 FROM users 
        WHERE id = auth.uid() AND role = 'empleado'
      )
      AND 
      EXISTS (
        SELECT 1 FROM businesses 
        WHERE id = business_id AND type = 'operativo'
      )
    )
  )
);

-- Comentario para documentación
COMMENT ON POLICY "Permitir inserción según rol y negocio" ON transactions IS 'Garantiza que empleados solo operen en negocios operativos y que la identidad sea verificada.';
