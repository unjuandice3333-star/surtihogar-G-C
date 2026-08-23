import { analyzeInventoryAI, generateSupplierOrderText, fetchGeminiInventoryAnalysis } from '../inventoryAI.js';

export function renderInventoryAIView(state, formatCurrency) {
  const selectedBusId = state.selectedInventoryAIBusinessId || 'all';
  const targetDays = state.inventoryAITargetDays || 15;

  const analysis = analyzeInventoryAI({
    products: state.products || [],
    sales: state.sales || [],
    saleItems: state.saleItems || [],
    businessId: selectedBusId,
    targetDays
  });

  const selectedBusName = selectedBusId === 'all' 
    ? 'Todas las Sedes' 
    : (state.businesses.find(b => b.id === selectedBusId)?.name || 'Sede');

  const orderText = generateSupplierOrderText(analysis.replenishmentOrders, selectedBusName);

  return `
    <header class="main-header" style="background:#ffffff; z-index:1000; box-shadow:0 2px 8px rgba(0,0,0,0.04);">
      <div class="logo-container">
        <div class="logo-icon" style="background:linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color:white; width:40px; height:40px; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:20px; box-shadow:0 4px 12px rgba(99,102,241,0.3);">🧠</div>
        <div class="header-title">
          <p class="role-tag" style="margin:0; color:#818cf8; font-weight:800;">INTELIGENCIA ARTIFICIAL</p>
          <h1>Analítica Predictiva & Gemini IA</h1>
        </div>
      </div>
      <div class="header-actions">
        <button onclick="state.view='products_admin';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px;">📦 VER CATÁLOGO</button>
        <button onclick="state.view='app';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px; margin-left:8px;">VOLVER</button>
      </div>
    </header>

    <div class="container" style="padding-top:20px;">
      
      <!-- BARRA DE FILTROS INTELIGENTES -->
      <div class="card" style="margin-bottom: 20px; padding: 18px; background: #ffffff; border-radius:18px; border: 1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:15px;">
        <div style="display:flex; align-items:center; gap:15px; flex-wrap:wrap; flex:1;">
          <div style="min-width:200px;">
            <label style="font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; display:block; margin-bottom:4px;">📍 Sede a Analizar</label>
            <select onchange="state.selectedInventoryAIBusinessId = this.value; window.render()" class="form-input" style="padding:8px 12px; border-radius:10px; font-size:13px; font-weight:700; width:100%; border:1px solid #cbd5e1;">
              <option value="all" ${selectedBusId === 'all' ? 'selected' : ''}>🏢 Todas las Sedes</option>
              ${(state.businesses || []).map(b => `<option value="${b.id}" ${selectedBusId === b.id ? 'selected' : ''}>🏬 ${b.name}</option>`).join('')}
            </select>
          </div>

          <div style="min-width:180px;">
            <label style="font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; display:block; margin-bottom:4px;">📅 Días de Cobertura Deseados</label>
            <select onchange="state.inventoryAITargetDays = parseInt(this.value); window.render()" class="form-input" style="padding:8px 12px; border-radius:10px; font-size:13px; font-weight:700; width:100%; border:1px solid #cbd5e1;">
              <option value="7" ${targetDays === 7 ? 'selected' : ''}>7 Días (Semanal)</option>
              <option value="15" ${targetDays === 15 ? 'selected' : ''}>15 Días (Quincenal)</option>
              <option value="30" ${targetDays === 30 ? 'selected' : ''}>30 Días (Mensual)</option>
            </select>
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:10px;">
          <button onclick="window.copySupplierOrderText()" class="btn-primary" style="background:#4f46e5; border:none; padding:10px 16px; border-radius:12px; font-size:12px; font-weight:800; display:flex; align-items:center; gap:6px; box-shadow:0 4px 12px rgba(79,70,229,0.25);">
            📋 COPIAR ORDEN DE COMPRA
          </button>
        </div>
      </div>

      <!-- PANEL INTELIGENTE CON GOOGLE GEMINI AI -->
      <div class="card" style="padding:22px; border-radius:24px; margin-bottom:25px; background:linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); color:white; border:none; box-shadow:0 12px 30px rgba(15,23,42,0.25); position:relative; overflow:hidden;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:15px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px; margin-bottom:15px;">
          <div>
            <h3 style="font-size:17px; font-weight:900; color:white; margin:0; display:flex; align-items:center; gap:8px;">
              ✨ CONSULTOR DE INVENTARIO GOOGLE GEMINI IA
            </h3>
            <p style="font-size:11.5px; color:#a5b4fc; margin-top:3px;">Auditoría ejecutiva en tiempo real impulsada por Gemini 1.5/2.0 Flash API</p>
          </div>
          
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="password" id="gemini-key-input" placeholder="Google Gemini API Key..." value="${state.geminiApiKey || ''}" onchange="state.geminiApiKey=this.value; localStorage.setItem('gemini_api_key', this.value)" style="background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.2); color:white; padding:8px 12px; border-radius:10px; font-size:11px; width:180px;">
            <button onclick="window.runGeminiInventoryAnalysis()" class="btn-primary" style="background:linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); border:none; padding:9px 18px; border-radius:12px; font-weight:800; font-size:12px; cursor:pointer; box-shadow:0 4px 12px rgba(99,102,241,0.4); display:flex; align-items:center; gap:6px;">
              ⚡ CONSULTAR A GEMINI
            </button>
          </div>
        </div>

        <!-- RESULTADO DE GEMINI -->
        <div id="gemini-result-container" style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); padding:16px; border-radius:16px; font-size:12.5px; line-height:1.6; color:#e0e7ff; min-height:60px;">
          ${state.geminiAnalysisResult ? `
            <div style="white-space:pre-wrap; font-family:'Outfit', sans-serif;">${state.geminiAnalysisResult}</div>
          ` : `
            <div style="text-align:center; color:#94a3b8; font-size:12px; padding:10px 0;">
              💡 Haz clic en <b>"⚡ CONSULTAR A GEMINI"</b> para generar un diagnóstico financiero y recomendaciones estratégicas en tiempo real.
            </div>
          `}
        </div>
      </div>

      <!-- METRICAS RESUMEN DE SALUD DE INVENTARIO -->
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:18px; margin-bottom:25px;">
        
        <!-- CARD 0: INVERSIÓN TOTAL EN MERCANCÍA -->
        <div class="card" style="padding:20px; border-radius:20px; border:none; background:linear-gradient(135deg, #1e1b4b 0%, #311042 100%); color:white; box-shadow:0 10px 20px rgba(0,0,0,0.08);">
          <p style="font-size:11px; font-weight:800; color:#c084fc; text-transform:uppercase; letter-spacing:0.5px; margin:0 0 6px 0;">💰 Valor Total Invertido (Costo)</p>
          <h2 style="font-size:26px; font-weight:900; margin:0; color:#ffffff;">${formatCurrency(analysis.totalInventoryCostValue || 0)}</h2>
          <p style="font-size:11px; color:#e9d5ff; margin-top:8px;">
            🏷️ Venta: <b>${formatCurrency(analysis.totalInventorySaleValue || 0)}</b> | 📈 Bruta: <b style="color:#34d399;">+${formatCurrency(analysis.totalPotentialProfit || 0)}</b>
          </p>
        </div>

        <!-- CARD 0.5: GANANCIA NETA REAL (DEDUCCIÓN COSTOS FIJOS) -->
        <div class="card" style="padding:20px; border-radius:20px; border:none; background:linear-gradient(135deg, #0284c7 0%, #0369a1 100%); color:white; box-shadow:0 10px 20px rgba(0,0,0,0.08);">
          <p style="font-size:11px; font-weight:800; color:#7dd3fc; text-transform:uppercase; letter-spacing:0.5px; margin:0 0 6px 0;">💵 Utilidad Neta Real (Deducida)</p>
          <h2 style="font-size:26px; font-weight:900; margin:0; color:#ffffff;">${formatCurrency(analysis.netEstimatedProfit || 0)}</h2>
          <p style="font-size:11px; color:#bae6fd; margin-top:8px;">
            Menos <b>${formatCurrency(analysis.periodFixedCosts || 0)}</b> de costos (${targetDays} días × $137k)
          </p>
        </div>

        <!-- CARD 1: AGOTAMIENTOS CRÍTICOS -->
        <div class="card" style="padding:20px; border-radius:20px; border:none; background:linear-gradient(135deg, #1e293b 0%, #0f172a 100%); color:white; box-shadow:0 10px 20px rgba(0,0,0,0.08);">
          <p style="font-size:11px; font-weight:800; color:#f87171; text-transform:uppercase; letter-spacing:0.5px; margin:0 0 6px 0;">🚨 Agotamiento Inminente</p>
          <h2 style="font-size:32px; font-weight:900; margin:0; color:#ffffff;">${analysis.criticalStockouts.length} <span style="font-size:14px; font-weight:600; color:#cbd5e1;">artículos</span></h2>
          <p style="font-size:11px; color:#94a3b8; margin-top:8px;">Se agotan en menos de 5 días</p>
        </div>

        <!-- CARD 2: CAPITAL ESTANCADO REAL -->
        <div class="card" style="padding:20px; border-radius:20px; border:none; background:linear-gradient(135deg, #431407 0%, #7c2d12 100%); color:white; box-shadow:0 10px 20px rgba(0,0,0,0.08);">
          <p style="font-size:11px; font-weight:800; color:#fb923c; text-transform:uppercase; letter-spacing:0.5px; margin:0 0 6px 0;">🧊 Capital Estancado Real</p>
          <h2 style="font-size:26px; font-weight:900; margin:0; color:#ffffff;">${formatCurrency(analysis.totalCapitalInStagnant)}</h2>
          <p style="font-size:11px; color:#fdba74; margin-top:8px;">${analysis.stagnantProducts.length} productos sin ventas (30+ días en sistema)</p>
        </div>

        <!-- CARD 3: ESTIMADO ORDEN DE COMPRA -->
        <div class="card" style="padding:20px; border-radius:20px; border:none; background:linear-gradient(135deg, #064e3b 0%, #047857 100%); color:white; box-shadow:0 10px 20px rgba(0,0,0,0.08);">
          <p style="font-size:11px; font-weight:800; color:#34d399; text-transform:uppercase; letter-spacing:0.5px; margin:0 0 6px 0;">📋 Pedido Sugerido (${targetDays} Días)</p>
          <h2 style="font-size:26px; font-weight:900; margin:0; color:#ffffff;">${formatCurrency(analysis.totalEstimatedReplenishmentCost)}</h2>
          <p style="font-size:11px; color:#a7f3d0; margin-top:8px;">Inversión sugerida para ${analysis.replenishmentOrders.length} productos</p>
        </div>

      </div>

      <!-- TABLA 1: PRODUCTOS EN ALERTA ROJA (AGOTAMIENTO < 5 DÍAS) -->
      <div class="card" style="padding:20px; border-radius:20px; margin-bottom:25px; border:1px solid #fee2e2; background:#fff5f5;">
        <h3 style="font-size:16px; font-weight:900; color:#991b1b; margin:0 0 15px 0; display:flex; align-items:center; gap:8px;">
          🚨 Alertas de Agotamiento Crítico (Rotación Alta vs. Stock Bajo)
        </h3>

        ${analysis.criticalStockouts.length === 0 ? `
          <div style="padding:20px; text-align:center; color:#047857; font-weight:700; font-size:13px;">
            ✅ ¡Excelente! Ningún producto corre riesgo de agotarse en los próximos 5 días.
          </div>
        ` : `
          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:12.5px;">
              <thead>
                <tr style="border-bottom:2px solid #fecdd3; text-align:left; color:#991b1b; font-size:11px; text-transform:uppercase;">
                  <th style="padding:10px;">Producto</th>
                  <th style="padding:10px;">Stock Actual</th>
                  <th style="padding:10px;">Rotación (VMD)</th>
                  <th style="padding:10px;">Días Restantes</th>
                  <th style="padding:10px;">Pedido Sugerido</th>
                </tr>
              </thead>
              <tbody>
                ${analysis.criticalStockouts.map(item => `
                  <tr style="border-bottom:1px solid #ffe4e6; font-weight:600;">
                    <td style="padding:12px; color:#1e293b;">${item.name}</td>
                    <td style="padding:12px; color:#b91c1c; font-weight:900;">${item.stock} unds</td>
                    <td style="padding:12px; color:#475569;">${item.vmd} unds/día</td>
                    <td style="padding:12px;">
                      <span style="background:#fee2e2; color:#991b1b; padding:4px 10px; border-radius:12px; font-weight:900; font-size:11px;">
                        ⏳ ${item.daysOfStock} días
                      </span>
                    </td>
                    <td style="padding:12px; color:#047857; font-weight:900;">+ ${item.suggestedRestock} unds</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <!-- TABLA 2: SUGERIDO DE COMPRA DETALLADO -->
      <div class="card" style="padding:20px; border-radius:20px; margin-bottom:25px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; flex-wrap:wrap; gap:10px;">
          <h3 style="font-size:16px; font-weight:900; color:#1e293b; margin:0; display:flex; align-items:center; gap:8px;">
            📦 Sugerido de Reabastecimiento Automatizado
          </h3>
          <span style="font-size:11px; font-weight:700; background:#e0e7ff; color:#3730a3; padding:4px 12px; border-radius:20px;">
            Cobertura para ${targetDays} Días
          </span>
        </div>

        ${analysis.replenishmentOrders.length === 0 ? `
          <div style="padding:20px; text-align:center; color:#64748b; font-size:13px;">
            No hay solicitudes de reabastecimiento pendientes para este periodo.
          </div>
        ` : `
          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:12.5px;">
              <thead>
                <tr style="border-bottom:2px solid #e2e8f0; text-align:left; color:#64748b; font-size:11px; text-transform:uppercase;">
                  <th style="padding:10px;">Producto</th>
                  <th style="padding:10px;">Stock</th>
                  <th style="padding:10px;">VMD (Ventas/Día)</th>
                  <th style="padding:10px;">Cantidad a Pedir</th>
                  <th style="padding:10px;">Costo Estimado</th>
                </tr>
              </thead>
              <tbody>
                ${analysis.replenishmentOrders.map(item => `
                  <tr style="border-bottom:1px solid #f1f5f9; font-weight:600;">
                    <td style="padding:12px; color:#1e293b;">${item.name}</td>
                    <td style="padding:12px; color:#64748b;">${item.stock}</td>
                    <td style="padding:12px; color:#475569;">${item.vmd}</td>
                    <td style="padding:12px; color:#4f46e5; font-weight:900;">+ ${item.quantityToOrder} unds</td>
                    <td style="padding:12px; color:#047857; font-weight:800;">${formatCurrency(item.estimatedCost)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <!-- TABLA 3: CAPITAL ESTANCADO REAL (> 30 DÍAS CREADO) -->
      <div class="card" style="padding:20px; border-radius:20px; margin-bottom:25px; border:1px solid #ffedd5; background:#fff7ed;">
        <h3 style="font-size:16px; font-weight:900; color:#c2410c; margin:0 0 5px 0; display:flex; align-items:center; gap:8px;">
          🧊 Mercancía Estancada Real (Lleva más de 30 días registrada sin ventas)
        </h3>
        <p style="font-size:11.5px; color:#9a3412; margin:0 0 15px 0; font-weight:600;">Filtro de veracidad activo: Excluye automáticamente productos recién ingresados al catálogo.</p>

        ${analysis.stagnantProducts.length === 0 ? `
          <div style="padding:20px; text-align:center; color:#047857; font-weight:700; font-size:13px;">
            🎉 ¡Excelente! No hay mercancía antigua (30+ días) retenida sin movimiento en esta sede.
          </div>
        ` : `
          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:12.5px;">
              <thead>
                <tr style="border-bottom:2px solid #fed7aa; text-align:left; color:#9a3412; font-size:11px; text-transform:uppercase;">
                  <th style="padding:10px;">Producto</th>
                  <th style="padding:10px;">Antigüedad</th>
                  <th style="padding:10px;">Stock Estancado</th>
                  <th style="padding:10px;">Dinero Retenido (Costo)</th>
                  <th style="padding:10px;">Recuperación Potencial</th>
                </tr>
              </thead>
              <tbody>
                ${analysis.stagnantProducts.map(item => `
                  <tr style="border-bottom:1px solid #ffedd5; font-weight:600;">
                    <td style="padding:12px; color:#1e293b;">${item.name}</td>
                    <td style="padding:12px; color:#c2410c;">${item.daysInSystem} días</td>
                    <td style="padding:12px; color:#c2410c; font-weight:900;">${item.stock} unds</td>
                    <td style="padding:12px; color:#9a3412; font-weight:900;">${formatCurrency(item.capitalEstancado)}</td>
                    <td style="padding:12px; color:#047857; font-weight:800;">${formatCurrency(item.potentialRevenue)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <!-- SECCIÓN 4: PRODUCTOS RECIÉN INGRESADOS (NUEVOS EN SISTEMA) -->
      ${analysis.newProducts.length > 0 ? `
        <div class="card" style="padding:20px; border-radius:20px; margin-bottom:25px; border:1px solid #e2e8f0; background:#f8fafc;">
          <h3 style="font-size:15px; font-weight:800; color:#334155; margin:0 0 5px 0; display:flex; align-items:center; gap:8px;">
            ✨ Productos Nuevos en Catálogo (Creados recientemente, &lt; 30 días)
          </h3>
          <p style="font-size:11px; color:#64748b; margin:0 0 12px 0;">Se encuentran en periodo de evaluación inicial y no cuentan como mercancía estancada.</p>
          
          <div style="display:flex; flex-wrap:wrap; gap:8px;">
            ${analysis.newProducts.map(p => `
              <span style="font-size:11px; font-weight:700; background:#ffffff; border:1px solid #cbd5e1; padding:4px 10px; border-radius:10px; color:#1e293b;">
                📦 ${p.name} <span style="color:#64748b; font-weight:500;">(${p.daysInSystem} días | ${p.stock} unds)</span>
              </span>
            `).join('')}
          </div>
        </div>
      ` : ''}

    </div>
  `;
}
