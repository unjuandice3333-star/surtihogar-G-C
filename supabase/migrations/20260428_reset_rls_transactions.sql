-- Migración: Reinicio de políticas RLS para transactions
-- Objetivo: Eliminar restricciones complejas que causan errores 403 y simplificar a propiedad de usuario

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- 1. Limpieza total de políticas previas
DO $$ 
BEGIN
    EXECUTE (
        SELECT string_agg('DROP POLICY IF EXISTS ' || quote_ident(policyname) || ' ON transactions;', ' ')
        FROM pg_policies 
        WHERE tablename = 'transactions'
    );
END $$;

-- 2. Crear Política de INSERCIÓN (Mínima necesaria)
CREATE POLICY "transacciones_insert_propio" 
ON transactions 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- 3. Crear Política de LECTURA (Mínima necesaria)
CREATE POLICY "transacciones_select_propio" 
ON transactions 
FOR SELECT 
USING (auth.uid() = user_id);

-- Comentarios de auditoría
COMMENT ON POLICY "transacciones_insert_propio" ON transactions IS 'Permite a los usuarios registrar sus propios movimientos financieros.';
COMMENT ON POLICY "transacciones_select_propio" ON transactions IS 'Permite a los usuarios visualizar únicamente sus propios movimientos financieros.';
