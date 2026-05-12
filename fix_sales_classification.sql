-- ======================================================
-- CLASIFICACIÓN PROFESIONAL DE FORMAS DE PAGO (POS)
-- ======================================================
-- Este script habilita las columnas oficiales para guardar 
-- si una venta fue pagada con Addi, Sistecredito, Efectivo, etc.

-- 1. Agregar columna a la tabla de VENTAS
ALTER TABLE sales 
ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'Efectivo';

-- 2. Agregar columna a la tabla de TRANSACCIONES (Contabilidad)
ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'Efectivo';

-- 3. Comentarios para documentación automática
COMMENT ON COLUMN sales.payment_method IS 'Clasificación del método de pago utilizado en el POS';
COMMENT ON COLUMN transactions.payment_method IS 'Clasificación del método de pago del movimiento financiero';
