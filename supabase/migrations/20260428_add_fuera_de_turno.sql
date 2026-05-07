-- Migración: Agregar campo fuera_de_turno a transactions
ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS fuera_de_turno BOOLEAN DEFAULT FALSE;

-- Comentario para auditoría
COMMENT ON COLUMN transactions.fuera_de_turno IS 'Indica si la transacción fue registrada fuera del horario de turno asignado.';
