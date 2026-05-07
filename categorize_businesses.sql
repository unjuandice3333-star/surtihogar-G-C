-- ==========================================
-- CATEGORIZACIÓN DE NEGOCIOS RIVO
-- ==========================================

-- 1. Asegurar que la columna 'type' existe (ya debería existir por pasos anteriores)
-- ALTER TABLE businesses ADD COLUMN IF NOT EXISTS type TEXT CHECK (type IN ('operativo', 'arriendo'));

-- 2. Actualizar tipos según lista proporcionada por el usuario
UPDATE businesses 
SET type = 'operativo' 
WHERE name ILIKE '%Electrodomésticos%' 
   OR name ILIKE '%Celulares%'
   OR name ILIKE '%Muebles%' 
   OR name ILIKE '%Ropa niños%' 
   OR name ILIKE '%Baratillo%';

UPDATE businesses 
SET type = 'arriendo' 
WHERE name ILIKE '%Droguería%' 
   OR name ILIKE '%Billar%' 
   OR name ILIKE '%Local ropa%' 
   OR name ILIKE '%Restaurante%';

-- 3. Verificación rápida (Opcional, para logs)
-- SELECT name, type FROM businesses;
