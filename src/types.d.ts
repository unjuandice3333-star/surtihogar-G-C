/**
 * @typedef {Object} User
 * @property {string} id
 * @property {string} name
 * @property {string} role
 * @property {string} [business_id]
 */

/**
 * @typedef {Object} Business
 * @property {string} id
 * @property {string} name
 * @property {string} type
 */

/**
 * @typedef {Object} Transaction
 * @property {string} id
 * @property {number} amount
 * @property {'income'|'expense'} type
 * @property {string} [category_id]
 * @property {string} business_id
 * @property {string} user_id
 * @property {string} date
 * @property {string} [description]
 * @property {string} [note]
 */

/**
 * @typedef {Object} Product
 * @property {string} id
 * @property {string} name
 * @property {number} price
 * @property {number} cost
 * @property {number} stock
 * @property {string} business_id
 */

/**
 * @typedef {Object} Supplier
 * @property {string} name
 * @property {string} phone
 * @property {string} products_sold
 * @property {number} debt
 * @property {number} cash_purchases
 */
export {};
