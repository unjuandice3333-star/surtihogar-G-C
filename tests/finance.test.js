import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock de Supabase
const mockInsert = vi.fn().mockResolvedValue({ error: null });
const supabase = {
  from: vi.fn(() => ({
    insert: mockInsert
  }))
};

// Mock de UI y Estado
const state = {
  user: { id: '123', role: 'admin' },
  business_id: 'bus-1'
};

const validateTransaction = (amount, cat) => {
  if (!amount || amount <= 0) return 'Monto inválido';
  if (!cat) return 'Categoría requerida';
  return 'ok';
};

describe('Flujo de Finanzas: Ingresos y Gastos', () => {
  
  it('Debe permitir un ingreso válido', () => {
    const result = validateTransaction(150000, 'cat-123');
    expect(result).toBe('ok');
  });

  it('Debe permitir un gasto válido', () => {
    const result = validateTransaction(50000, 'cat-456');
    expect(result).toBe('ok');
  });

  it('Debe rechazar montos negativos o cero', () => {
    expect(validateTransaction(-100, 'cat-1')).toBe('Monto inválido');
    expect(validateTransaction(0, 'cat-1')).toBe('Monto inválido');
  });

  it('Debe rechazar transacciones sin categoría', () => {
    expect(validateTransaction(10000, null)).toBe('Categoría requerida');
    expect(validateTransaction(10000, '')).toBe('Categoría requerida');
  });

});
