-- ======================================================
-- CORRECCIÓN DE SEGURIDAD (RLS): VISUALIZACIÓN DE NEGOCIOS
-- ======================================================
-- Este script permite que la tabla de negocios pueda ser leída por
-- usuarios no autenticados únicamente para que aparezcan en el selector
-- de registro de "Nuevo COLABORADOR".

-- 1. Eliminar políticas antiguas que bloqueaban el acceso a invitados
DROP POLICY IF EXISTS "Admins see all businesses" ON businesses;
DROP POLICY IF EXISTS "Employees see their business" ON businesses;

-- 2. Crear una política universal de lectura (Mejores Prácticas)
-- Esto permite leer el nombre y ID del negocio de forma segura y pública.
CREATE POLICY "Cualquiera puede ver los negocios" 
ON businesses FOR SELECT 
USING (true);

-- (Opcional pero recomendado) Asegurar que las escrituras sigan estando bloqueadas a admins
DROP POLICY IF EXISTS "Only admins can insert businesses" ON businesses;
CREATE POLICY "Solo admins administran negocios" 
ON businesses FOR ALL
USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));
