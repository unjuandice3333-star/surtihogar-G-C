/**
 * POS Engine - Lógica de negocio pura para Surtihogar G&C
 * Este archivo no contiene interacciones con el DOM para ser testeable.
 */

export const posEngine = {
  /**
   * Calcula el total de un carrito de compras
   */
  calculateTotal: (cart) => {
    return cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  },

  /**
   * Valida si hay stock suficiente para una cantidad solicitada
   */
  hasEnoughStock: (product, requestedQty) => {
    if (!product) return false;
    return product.stock >= requestedQty;
  },

  /**
   * Prepara el payload para insertar en sale_items
   */
  prepareSaleItemPayload: (saleId, productId, quantity, price) => {
    if (!saleId) throw new Error("sale_id es obligatorio");
    if (quantity <= 0) throw new Error("La cantidad debe ser mayor a 0");
    
    return {
      sale_id: saleId,
      product_id: productId || null, // Permitir NULL para ventas rápidas
      quantity,
      price
    };
  },

  /**
   * Valida integridad de un gasto
   */
  validateExpense: (amount, category) => {
    if (isNaN(amount) || amount <= 0) return { valid: false, error: "Monto inválido" };
    if (!category) return { valid: false, error: "Categoría obligatoria" };
    return { valid: true };
  }
};
