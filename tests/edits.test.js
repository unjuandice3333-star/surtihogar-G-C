import { describe, it, expect } from 'vitest';

// Simulated functions to mock the new edit/delete capabilities for unit testing.
function simulateEditSale(sale, originalItems, currentTransactions, newTotal, newPaymentMethod) {
  const updatedSale = { ...sale, total: newTotal, payment_method: newPaymentMethod };
  
  // Update associated transaction
  const updatedTransactions = currentTransactions.map(tx => {
    if (tx.note && tx.note.includes(sale.id.slice(0, 5))) {
      return { ...tx, amount: newTotal, payment_method: newPaymentMethod };
    }
    return tx;
  });

  // Prorate item prices
  const oldTotal = originalItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const ratio = oldTotal > 0 ? newTotal / oldTotal : 1;
  const updatedItems = originalItems.map(item => ({
    ...item,
    price: Math.round(item.price * ratio)
  }));

  return { updatedSale, updatedItems, updatedTransactions };
}

function simulateDeleteSale(sale, saleItems, products, transactions) {
  // 1. Restore stock
  const updatedProducts = products.map(p => {
    const item = saleItems.find(si => si.product_id === p.id && si.sale_id === sale.id);
    if (item) {
      return { ...p, stock: p.stock + item.quantity };
    }
    return p;
  });

  // 2. Remove transaction
  const saleShortId = sale.id.slice(0, 5);
  const updatedTransactions = transactions.filter(t => !(t.note && t.note.includes(saleShortId)));

  return {
    updatedProducts,
    updatedTransactions,
    saleDeleted: true
  };
}

function simulateEditProduct(product, updates) {
  return { ...product, ...updates };
}

describe('Edición y Anulación de Ventas, Transacciones e Inventarios', () => {
  it('Debería modificar el total y el método de pago de una venta y sincronizar la transacción e ítems', () => {
    const sale = { id: 'abcde12345', total: 10000, payment_method: 'Efectivo' };
    const items = [
      { id: 'item1', sale_id: 'abcde12345', product_id: 'p1', quantity: 2, price: 5000 }
    ];
    const transactions = [
      { id: 'tx1', amount: 10000, payment_method: 'Efectivo', note: '[Venta POS #abcde]' }
    ];

    const result = simulateEditSale(sale, items, transactions, 8000, 'Addi');

    expect(result.updatedSale.total).toBe(8000);
    expect(result.updatedSale.payment_method).toBe('Addi');
    expect(result.updatedTransactions[0].amount).toBe(8000);
    expect(result.updatedTransactions[0].payment_method).toBe('Addi');
    expect(result.updatedItems[0].price).toBe(4000);
  });

  it('Debería eliminar una venta y restaurar el stock del producto e invalidar la transacción', () => {
    const sale = { id: 'abcde12345', total: 10000, payment_method: 'Efectivo' };
    const items = [
      { id: 'item1', sale_id: 'abcde12345', product_id: 'p1', quantity: 2, price: 5000 }
    ];
    const products = [
      { id: 'p1', name: 'Zapatos', stock: 8 }
    ];
    const transactions = [
      { id: 'tx1', amount: 10000, payment_method: 'Efectivo', note: '[Venta POS #abcde]' }
    ];

    const result = simulateDeleteSale(sale, items, products, transactions);

    expect(result.updatedProducts.find(p => p.id === 'p1').stock).toBe(10); // Restored from 8 + 2
    expect(result.updatedTransactions.length).toBe(0); // Transaction deleted
    expect(result.saleDeleted).toBe(true);
  });

  it('Debería poder modificar todos los campos de un producto en el inventario', () => {
    const product = { id: 'p1', name: 'Zapatos', price: 10000, cost: 5000, stock: 8, purchase_price: 10, gender: 'unisex' };
    const updates = { name: 'Zapatos Deluxe', price: 12000, cost: 6000, stock: 15, purchase_price: 20, gender: 'hombre' };

    const updated = simulateEditProduct(product, updates);

    expect(updated.name).toBe('Zapatos Deluxe');
    expect(updated.price).toBe(12000);
    expect(updated.cost).toBe(6000);
    expect(updated.stock).toBe(15);
    expect(updated.purchase_price).toBe(20);
    expect(updated.gender).toBe('hombre');
  });
});
