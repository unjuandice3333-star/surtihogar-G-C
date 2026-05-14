import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = fs.readFileSync('.env','utf8');
const url = env.match(/VITE_SUPABASE_URL=(.*)/)[1].trim();
const key = env.match(/VITE_SUPABASE_ANON_KEY=(.*)/)[1].trim();

const supabase = createClient(url, key);

async function runRegularSaleFlow() {
  console.log("=== AUDITORÍA: FLUJO DE VENTA REGULAR (CARRITO POS) ===");
  
  try {
    // 1. Usuario
    const { data: users } = await supabase.from('users').select('id, name').limit(1);
    const testUser = users?.[0];
    if (!testUser) throw new Error("No hay usuarios en DB");
    console.log(`✅ Vendedor: ${testUser.name}`);

    // 2. Negocio
    const { data: biz } = await supabase.from('businesses').select('id, name').limit(1);
    const testBiz = biz?.[0];
    if (!testBiz) throw new Error("No hay negocios en DB");
    console.log(`✅ Negocio de Venta: ${testBiz.name}`);

    // 3. Verificar si hay productos, si no, CREAR UNO para la prueba
    let { data: prods } = await supabase.from('products').select('id, name, price').limit(1);
    let testProd = prods?.[0];

    if (!testProd) {
      console.log("\n[DUMMY] Creando producto temporal de prueba...");
      const { data: newP, error: newPErr } = await supabase.from('products').insert({
         name: 'Televisor LED 32" Prueba',
         price: 450000,
         cost: 300000,
         stock: 10,
         business_id: testBiz.id,
         created_by: testUser.id
      }).select().single();

      if (newPErr) {
        console.error("❌ FALLO CREAR PRODUCTO DUMMY:", newPErr);
        throw newPErr;
      }
      testProd = newP;
      console.log("✅ Producto dummy creado:", testProd.name);
    } else {
      console.log(`✅ Producto existente para test: ${testProd.name}`);
    }

    // 4. EJECUTAR VENTA POS (Match Exacto con window.finalizeSale)
    console.log("\n[1] Creando venta POS en 'sales'...");
    const { data: sale, error: saleErr } = await supabase.from('sales').insert({
       user_id: testUser.id,
       total: testProd.price,
       payment_method: 'Efectivo'
    }).select().single();

    if (saleErr) {
       console.error("❌ FALLO CRÍTICO EN INSERT SALES:", saleErr);
       throw saleErr;
    }
    console.log("✅ VENTA MAESTRA CREADA:", sale);

    // 5. INSERTAR ITEMS DEL CARRITO
    console.log("\n[2] Registrando item del carrito en 'sale_items'...");
    const saleItems = [{
       sale_id: sale.id,
       product_id: testProd.id,
       quantity: 1,
       price: testProd.price
    }];

    const { data: itemsData, error: itemsErr } = await supabase.from('sale_items').insert(saleItems).select();
    if (itemsErr) {
       console.error("❌ FALLO CRÍTICO EN INSERT SALE_ITEMS:", itemsErr);
       throw itemsErr;
    }
    console.log("✅ ITEM DEL CARRITO REGISTRADO:", itemsData);

    // 6. REGISTRAR TRANSACCION CONTABLE
    console.log("\n[3] Simulando split contable en 'transactions'...");
    const { data: trxData, error: trxErr } = await supabase.from('transactions').insert({
       amount: testProd.price,
       type: 'income',
       business_id: testBiz.id,
       user_id: testUser.id,
       payment_method: 'Efectivo',
       note: `[Venta POS #${sale.id.slice(0,5)}] Test de Kárdex`
    }).select();

    if (trxErr) {
       console.error("❌ FALLO CRÍTICO EN REGISTRO DE CAJA:", trxErr);
       throw trxErr;
    }
    console.log("✅ ASIENTO CONTABLE CREADO:", trxData);

    console.log("\n================================================");
    console.log("🎉 ÉXITO ROTUNDO: ¡EL FLUJO DE CARRITO PASA 100% LIMPIO!");
    console.log("================================================");

  } catch (e) {
    console.error("\n🔴 EL FLUJO FALLÓ EN LA BASE DE DATOS.");
    process.exit(1);
  }
}

runRegularSaleFlow();
