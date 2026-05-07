-- ==========================================
-- PARCHE 6: RPC PARA VALIDACIÓN DE SCHEMA
-- ==========================================

CREATE OR REPLACE FUNCTION get_table_columns(t_name text)
RETURNS TABLE (column_name text) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT c.column_name::text
    FROM information_schema.columns c
    WHERE c.table_name = t_name
    AND c.table_schema = 'public';
END;
$$;

-- Dar permisos para que los usuarios autenticados puedan llamar a la función
GRANT EXECUTE ON FUNCTION get_table_columns(text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_table_columns(text) TO anon;
