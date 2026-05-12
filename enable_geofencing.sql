-- EJECUTAR ESTO EN EL SQL EDITOR DE SUPABASE PARA HABILITAR GEOCERCAS

-- 1. Agregar columnas de coordenadas a la tabla de negocios
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS geofence_radius_meters INTEGER DEFAULT 100;

COMMENT ON COLUMN businesses.lat IS 'Latitud central del negocio';
COMMENT ON COLUMN businesses.lng IS 'Longitud central del negocio';
COMMENT ON COLUMN businesses.geofence_radius_meters IS 'Radio de tolerancia en metros (por defecto 100m)';

-- 2. Otorga permisos si es necesario
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;

-- 3. Asegurar que usuarios logueados puedan ver los negocios (para comparar GPS)
-- (Ya debería existir, pero reforzamos que se puedan leer lat/lng)
GRANT SELECT ON businesses TO authenticated;
GRANT SELECT ON businesses TO anon;
