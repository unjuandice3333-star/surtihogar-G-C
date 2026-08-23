import { describe, it, expect } from 'vitest';
import { calculateProductVMD, analyzeInventoryAI, generateSupplierOrderText } from '../src/inventoryAI.js';

describe('Motor de IA de Inventarios (inventoryAI)', () => {
  const sampleSales = [
    { id: 's1', created_at: new Date().toISOString() },
    { id: 's2', created_at: new Date().toISOString() }
  ];

  const sampleSaleItems = [
    { sale_id: 's1', product_id: 'p1', quantity: 30 }, // 30 unds vendidas en 30 días -> VMD = 1.0/día
    { sale_id: 's2', product_id: 'p2', quantity: 15 }  // 15 unds vendidas en 30 días -> VMD = 0.5/día
  ];

  const oldDate = new Date(Date.now() - (40 * 24 * 60 * 60 * 1000)).toISOString(); // 40 días atrás
  const recentDate = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000)).toISOString(); // 3 días atrás

  const sampleProducts = [
    { id: 'p1', name: 'Cobija Térmica', stock: 2, cost: 20000, price: 35000, business_id: 'b1', created_at: oldDate }, // Costo: 40k, Venta: 70k
    { id: 'p2', name: 'Sabana Eco', stock: 20, cost: 10000, price: 18000, business_id: 'b1', created_at: oldDate }, // Costo: 200k, Venta: 360k
    { id: 'p3', name: 'Almohada Inmóvil Antigua', stock: 10, cost: 15000, price: 25000, business_id: 'b1', created_at: oldDate }, // Costo: 150k, Venta: 250k
    { id: 'p4', name: 'Blusa Nueva Recién Creada', stock: 5, cost: 12000, price: 20000, business_id: 'b1', created_at: recentDate } // Costo: 60k, Venta: 100k
  ]; // Total Costo: 450.000 | Total Venta: 780.000 | Profit: 330.000 | Total Units: 37

  it('debe calcular la Velocidad Media Diaria (VMD) correctamente', () => {
    const vmd = calculateProductVMD(sampleSales, sampleSaleItems, 'all', 30);
    expect(vmd['p1']).toBe(1.0);
    expect(vmd['p2']).toBe(0.5);
    expect(vmd['p3']).toBeUndefined();
  });

  it('debe calcular la inversión total en mercancía y la ganancia potencial', () => {
    const analysis = analyzeInventoryAI({
      products: sampleProducts,
      sales: sampleSales,
      saleItems: sampleSaleItems,
      businessId: 'all',
      targetDays: 15
    });

    expect(analysis.totalUnitsInStock).toBe(37);
    expect(analysis.totalInventoryCostValue).toBe(450000);
    expect(analysis.totalInventorySaleValue).toBe(780000);
    expect(analysis.totalPotentialProfit).toBe(330000);
  });

  it('debe diferenciar mercancía estancada verdadera (30+ días) de productos nuevos recién creados', () => {
    const analysis = analyzeInventoryAI({
      products: sampleProducts,
      sales: sampleSales,
      saleItems: sampleSaleItems,
      businessId: 'all',
      targetDays: 15
    });

    expect(analysis.criticalStockouts.length).toBe(1);
    expect(analysis.criticalStockouts[0].id).toBe('p1');

    // p3 es antiguo (40 días) -> Estancado
    expect(analysis.stagnantProducts.length).toBe(1);
    expect(analysis.stagnantProducts[0].id).toBe('p3');
    expect(analysis.totalCapitalInStagnant).toBe(150000);

    // p4 es reciente (3 días) -> Clasificado como nuevo producto, NO estancado
    expect(analysis.newProducts.length).toBe(1);
    expect(analysis.newProducts[0].id).toBe('p4');
  });

  it('debe generar el texto de orden de compra correctamente', () => {
    const analysis = analyzeInventoryAI({
      products: sampleProducts,
      sales: sampleSales,
      saleItems: sampleSaleItems,
      businessId: 'all',
      targetDays: 15
    });

    const orderText = generateSupplierOrderText(analysis.replenishmentOrders, 'Baratillo');
    expect(orderText).toContain('SUGERIDO DE COMPRA INTELIGENTE');
    expect(orderText).toContain('Cobija Térmica');
    expect(orderText).toContain('Baratillo');
  });
});
