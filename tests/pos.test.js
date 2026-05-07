import { describe, it, expect } from 'vitest';
import { posEngine } from '../src/pos-engine.js';

describe('Surtihogar G&C - POS Engine Tests', () => {
  
  describe('Cálculo de Totales', () => {
    it('debe calcular el total de un carrito con un item', () => {
      const cart = [{ price: 1000, quantity: 2 }];
      expect(posEngine.calculateTotal(cart)).toBe(2000);
    });

    it('debe calcular el total de un carrito con múltiples items', () => {
      const cart = [
        { price: 1000, quantity: 2 },
        { price: 500, quantity: 1 }
      ];
      expect(posEngine.calculateTotal(cart)).toBe(2500);
    });

    it('debe retornar 0 para un carrito vacío', () => {
      expect(posEngine.calculateTotal([])).toBe(0);
    });
  });

  describe('Validación de Stock', () => {
    it('debe permitir venta si hay stock exacto', () => {
      const product = { stock: 5 };
      expect(posEngine.hasEnoughStock(product, 5)).toBe(true);
    });

    it('debe denegar venta si el stock es insuficiente', () => {
      const product = { stock: 2 };
      expect(posEngine.hasEnoughStock(product, 3)).toBe(false);
    });
  });

  describe('Validación de Gastos', () => {
    it('debe validar un gasto correcto', () => {
      const res = posEngine.validateExpense(5000, 'Servicios');
      expect(res.valid).toBe(true);
    });

    it('debe fallar si el monto es cero o negativo', () => {
      expect(posEngine.validateExpense(0, 'Servicios').valid).toBe(false);
      expect(posEngine.validateExpense(-100, 'Servicios').valid).toBe(false);
    });
  });

  describe('Integridad de Datos de Venta', () => {
    it('debe preparar un payload correcto para un item', () => {
      const payload = posEngine.prepareSaleItemPayload('sale-123', 'prod-abc', 2, 1500);
      expect(payload).toEqual({
        sale_id: 'sale-123',
        product_id: 'prod-abc',
        quantity: 2,
        price: 1500
      });
    });

    it('debe permitir product_id NULL (Venta Rápida)', () => {
      const payload = posEngine.prepareSaleItemPayload('sale-123', null, 1, 5000);
      expect(payload.product_id).toBeNull();
    });
  });

});
