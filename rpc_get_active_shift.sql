-- ==========================================
-- RPC: OBTENER TURNO ACTIVO
-- ==========================================

CREATE OR REPLACE FUNCTION get_active_shift(p_user_id UUID, p_current_time TIMESTAMP WITH TIME ZONE)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_business_id UUID;
BEGIN
    SELECT business_id INTO v_business_id
    FROM shifts
    WHERE user_id = p_user_id
    AND start_time <= p_current_time
    AND (end_time >= p_current_time OR end_time IS NULL)
    LIMIT 1;

    RETURN v_business_id;
END;
$$;

-- Permisos
GRANT EXECUTE ON FUNCTION get_active_shift(UUID, TIMESTAMP WITH TIME ZONE) TO authenticated;
GRANT EXECUTE ON FUNCTION get_active_shift(UUID, TIMESTAMP WITH TIME ZONE) TO anon;
