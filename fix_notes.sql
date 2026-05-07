-- ==========================================
-- PARCHE 5: HABILITAR NOTAS EN TRANSACCIONES
-- ==========================================

-- Añade la columna 'note' a la tabla de transacciones
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS note TEXT NULL;

-- (Opcional) Si en algún momento necesitas buscar notas por texto, puedes agregar un índice
-- CREATE INDEX idx_transactions_note ON transactions USING gin (to_tsvector('spanish', note));
