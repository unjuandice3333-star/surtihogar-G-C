-- Actualización del sistema: Añadir permisos de Cajero
-- Corre esto en el Editor SQL de tu panel de Supabase
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_cashier BOOLEAN DEFAULT false;
