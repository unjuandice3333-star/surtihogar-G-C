import { describe, it, expect, vi } from 'vitest';

// Simulación del estado y lógica del proveedor
const validateSupplier = (payload) => {
  if (!payload.name || payload.name.trim() === '') return 'Nombre requerido';
  if (payload.debt < 0) return 'La deuda no puede ser negativa';
  if (payload.cash_purchases < 0) return 'El monto de contado no puede ser negativo';
  return 'ok';
};

describe('Módulo de Proveedores: Pruebas Unitarias', () => {
  it('Debe validar un proveedor correctamente', () => {
    const payload = {
      name: 'Proveedor A',
      phone: '3001234567',
      products_sold: 'Varios',
      debt: 100000,
      cash_purchases: 50000
    };
    expect(validateSupplier(payload)).toBe('ok');
  });

  it('Debe rechazar proveedores sin nombre', () => {
    const payload = {
      name: '',
      phone: '3001234567',
      products_sold: 'Varios',
      debt: 100000,
      cash_purchases: 50000
    };
    expect(validateSupplier(payload)).toBe('Nombre requerido');
  });

  it('Debe rechazar deudas negativas', () => {
    const payload = {
      name: 'Proveedor B',
      debt: -5000,
      cash_purchases: 100
    };
    expect(validateSupplier(payload)).toBe('La deuda no puede ser negativa');
  });
});
