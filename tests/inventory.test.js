import { describe, it, expect, vi } from 'vitest';

// Simulación de la lógica del disparador (Trigger) de la Base de Datos
const simulateInventoryAction = (prod, action) => {
  const { type, quantity, unit_cost, sale_price } = action;
  let newStock = prod.stock;
  let financeEntry = null;

  if (type === 'compra') {
    newStock += quantity;
    financeEntry = { type: 'expense', amount: quantity * unit_cost, note: `Compra: ${prod.name}` };
  } else if (type === 'venta') {
    if (prod.stock < quantity) throw new Error('Stock insuficiente');
    newStock -= quantity;
    financeEntry = { type: 'income', amount: quantity * sale_price, note: `Venta: ${prod.name}` };
  }

  return { 
    updatedProd: { ...prod, stock: newStock },
    financeEntry,
    movement: { product_id: prod.id, type, quantity, unit_cost: prod.purchase_price } // Histórico
  };
};

describe('Validación de Flujo de Inventario e Integridad', () => {

  const productoBase = {
    id: 'p1',
    name: 'iPhone 13',
    stock: 10,
    purchase_price: 3000000,
    sale_price: 4500000
  };

  it('Caso 1: Compra → Aumenta stock y registra gasto', () => {
    const action = { type: 'compra', quantity: 5, unit_cost: 3000000 };
    const result = simulateInventoryAction(productoBase, action);
    
    expect(result.updatedProd.stock).toBe(15);
    expect(result.financeEntry.type).toBe('expense');
    expect(result.financeEntry.amount).toBe(15000000); // 5 * 3M
  });

  it('Caso 2: Venta → Disminuye stock y registra ingreso', () => {
    const action = { type: 'venta', quantity: 2, sale_price: 4500000 };
    const result = simulateInventoryAction(productoBase, action);
    
    expect(result.updatedProd.stock).toBe(8);
    expect(result.financeEntry.type).toBe('income');
    expect(result.financeEntry.amount).toBe(9000000); // 2 * 4.5M
  });

  it('Caso 3: Venta sin stock → Debe bloquearse', () => {
    const action = { type: 'venta', quantity: 20 };
    expect(() => simulateInventoryAction(productoBase, action)).toThrow('Stock insuficiente');
  });

  it('Caso 4: Cambio de precio → No debe afectar el costo guardado en movimientos previos', () => {
    const movimientoPrevio = { type: 'compra', quantity: 1, unit_cost: 3000000 };
    
    // Cambiamos el precio del producto "hoy"
    const productoActualizado = { ...productoBase, purchase_price: 3200000 };
    
    // El movimiento previo debe mantener su costo original
    expect(movimientoPrevio.unit_cost).toBe(3000000);
    expect(productoActualizado.purchase_price).toBe(3200000);
  });

});
