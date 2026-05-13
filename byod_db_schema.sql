-- ====================================================================
-- 🛡️ ENTERPRISE BYOD COMPLIANCE SYSTEM - BASE DE DATOS
-- ====================================================================

-- 1. TABLA DE LATIDOS (HEARTBEATS) DE DISPOSITIVOS
CREATE TABLE IF NOT EXISTS public.device_heartbeats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    timestamp TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    accuracy REAL,
    battery_level INTEGER, -- 0 to 100
    network_status TEXT, -- 'wifi', 'cellular', 'offline'
    app_state TEXT, -- 'FOREGROUND', 'BACKGROUND', 'INACTIVE'
    is_charging BOOLEAN,
    device_platform TEXT, -- 'android', 'ios', 'web'
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- Índices de rendimiento para consultas rápidas de geolocalización y latidos vivos
CREATE INDEX IF NOT EXISTS idx_heartbeats_user_time ON public.device_heartbeats(user_id, timestamp DESC);

-- 2. TABLA DE SCORES OPERACIONALES
CREATE TABLE IF NOT EXISTS public.operational_scores (
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
    score NUMERIC(5,2) DEFAULT 100.00, -- 0.00 to 100.00
    productive_minutes INTEGER DEFAULT 0,
    idle_minutes INTEGER DEFAULT 0,
    incidents_count INTEGER DEFAULT 0,
    missing_heartbeats INTEGER DEFAULT 0,
    last_sync TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- 3. EXTENSIÓN DE TABLA LOGS EXISTENTE (Respaldo para alertas críticas)
-- Si no existe column severity, la agregamos
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_logs' AND column_name='severity') THEN
        ALTER TABLE public.system_logs ADD COLUMN severity TEXT DEFAULT 'INFO'; -- INFO, WARNING, CRITICAL
    END IF;
END
$$;

-- 4. PERMISOS RLS (Row Level Security)
ALTER TABLE public.device_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_scores ENABLE ROW LEVEL SECURITY;

-- Políticas para heartbeats (El usuario puede insertar el suyo, el admin puede ver todos)
CREATE POLICY "Users can insert their own heartbeats" ON public.device_heartbeats
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can read all heartbeats" ON public.device_heartbeats
    FOR SELECT TO authenticated USING (
        EXISTS (
            SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
        )
    );

-- Políticas para operational_scores (Todos autenticados leen, sistema/admin modifican)
CREATE POLICY "Authenticated users can view operational scores" ON public.operational_scores
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can modify operational scores" ON public.operational_scores
    FOR ALL TO authenticated USING (
        EXISTS (
            SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
        )
    );

-- 5. FUNCIÓN TRIGGER: Auto-crear perfil de score al insertar un nuevo usuario
CREATE OR REPLACE FUNCTION public.handle_new_user_operational_score()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.operational_scores (user_id, score)
    VALUES (NEW.id, 100.00)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger asociado a la creación en la tabla de perfiles
DROP TRIGGER IF EXISTS on_user_created_score ON public.users;
CREATE TRIGGER on_user_created_score
    AFTER INSERT ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_operational_score();
