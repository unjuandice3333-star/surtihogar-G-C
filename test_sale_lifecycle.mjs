import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = fs.readFileSync('.env','utf8');
const url = env.match(/VITE_SUPABASE_URL=(.*)/)[1].trim();
const key = env.match(/VITE_SUPABASE_ANON_KEY=(.*)/)[1].trim();

const supabase = createClient(url, key);

async function testInformalSale() {
  console.log("=== RE-EJECUTANDO AUDITORÍA: VENTA NO REGISTRADA (MATCH EXACTO CON CLIENTE) ===");
  
  try {
    // 1. Usuario
    const { data: users } = await supabase.from('users').select('id, name').limit(1);
    const testUser = users?.[0];
    if (!testUser) throw new Error("No hay usuarios");
    console.log(`✅ Usuario: ${testUser.name}`);

    // 2. Negocio
    const { data: biz } = await supabase.from('businesses').select('id, name').limit(1);
    const testBiz = biz?.[0];
    if (!testBiz) throw new Error("No hay negocios");
    console.log(`✅ Negocio: ${testBiz.name}`);

    // 3. CREAR VENTA
    console.log("\n[1] Creando venta en 'sales'...");
    const { data: sale, error: saleErr } = await supabase.from('sales').insert({
      user_id: testUser.id,
      total: 85000,
      payment_method: 'Sistecredito',
      note: 'Venta informal: Taladro Bosch'
    }).select().single();

    if (saleErr) {
      console.error("❌ FALLO INSERTAR VENTA:", saleErr);
      throw saleErr;
    }
    console.log("✅ VENTA CREADA:", sale);

    // 4. CREAR ITEM (product_id: null)
    console.log("\n[2] Creando item informal en 'sale_items'...");
    const { data: item, error: itemErr } = await supabase.from('sale_items').insert({
      sale_id: sale.id,
      product_id: null,
      quantity: 1,
      price: 85000
    }).select();

    if (itemErr) {
      console.error("❌ FALLO INSERTAR SALE_ITEMS:", itemErr);
      throw itemErr;
    }
    console.log("✅ ITEM CREADO:", item);

    // 5. CREAR PENDING PRODUCT (Match exacto con main.js -> usando created_by)
    console.log("\n[3] Creando registro en 'pending_products'...");
    const { data: pending, error: pendingErr } = await supabase.from('pending_products').insert({
      name: 'Taladro Bosch',
      photo_url: null,
      created_by: testUser.id,
      sale_id: sale.id,
      quantity: 1,
      price: 85000
    }).select();

    if (pendingErr) {
      console.error("❌ FALLO INSERTAR PENDING_PRODUCTS:", pendingErr);
      throw pendingErr;
    }
    console.log("✅ PENDING_PRODUCT CREADO:", pending);

    // 6. CREAR TRANSACCION CONTABLE
    console.log("\n[4] Creando registro en 'transactions'...");
    const { data: trx, error: trxErr } = await supabase.from('transactions').insert({
      amount: 85000,
      type: 'income',
      business_id: testBiz.id,
      user_id: testUser.id,
      payment_method: 'Sistecredito',
      note: `[Venta POS #${sale.id.slice(0,5)}] Clúster Centralizado. Mét: Sistecredito`
    }).select();

    if (trxErr) {
      console.error("❌ FALLO INSERTAR TRANSACCION CONTABLE:", trxErr);
      throw trxErr;
    }
    console.log("✅ TRANSACCIÓN CREADA:", trx);

    console.log("\n================================================");
    console.log("🎉 ÉXITO TOTAL: ¡EL FLUJO COMPLETO EN BASE DE DATOS HA PASADO PERFECTAMENTE!");
    console.log("================================================");

  } catch (e) {
    console.error("\n🔴 DIAGNÓSTICO: ERROR EN EL FLUJO.");
    process.exit(1);
  }
}

testInformalSale();
