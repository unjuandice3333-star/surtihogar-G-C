-- 1. Agregar columna de telegram_chat_id a la tabla de usuarios
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS telegram_chat_id text;

-- 2. Crear tabla de solicitudes de cambios de turnos
CREATE TABLE IF NOT EXISTS public.shift_requests (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    requester_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
    type text NOT NULL, -- 'change_hours' o 'swap_employee'
    date date NOT NULL,
    details jsonb NOT NULL, -- Contiene datos del cambio
    status text DEFAULT 'pending' NOT NULL, -- 'pending', 'approved', 'rejected'
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Habilitar RLS en la tabla shift_requests
ALTER TABLE public.shift_requests ENABLE ROW LEVEL SECURITY;

-- 4. Crear políticas de seguridad para RLS en shift_requests (Permite acceso total para el rol anon/autenticado ya que el backend usa la API clave)
DROP POLICY IF EXISTS "Permitir todo al backend" ON public.shift_requests;
CREATE POLICY "Permitir todo al backend" ON public.shift_requests FOR ALL USING (true) WITH CHECK (true);
