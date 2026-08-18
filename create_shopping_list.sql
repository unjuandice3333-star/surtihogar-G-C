-- 1. Crear la tabla shopping_list
CREATE TABLE IF NOT EXISTS public.shopping_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  quantity INTEGER DEFAULT 1,
  business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'pending'
);

-- 2. Habilitar RLS
ALTER TABLE public.shopping_list ENABLE ROW LEVEL SECURITY;

-- 3. Crear Políticas de Seguridad
CREATE POLICY "Permitir lectura de lista de compras a usuarios autenticados" 
ON public.shopping_list FOR SELECT 
USING (true);

CREATE POLICY "Permitir inserción de lista de compras a usuarios autenticados" 
ON public.shopping_list FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Permitir actualización de lista de compras a usuarios autenticados" 
ON public.shopping_list FOR UPDATE 
USING (true);

CREATE POLICY "Permitir eliminación de lista de compras a usuarios autenticados" 
ON public.shopping_list FOR DELETE 
USING (true);
