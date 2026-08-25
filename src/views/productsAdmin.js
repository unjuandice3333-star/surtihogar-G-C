let _invSearchTimer = null;

const createInventoryRowHtml = (p, fmt, state) => {
  const genderBadge = p.gender === 'hombre' ? '<span style="font-size:9px; background:#dbeafe; color:#1d4ed8; padding:2px 5px; border-radius:5px; font-weight:700; margin-left:4px;">👨 H</span>' : p.gender === 'mujer' ? '<span style="font-size:9px; background:#fce7f3; color:#be185d; padding:2px 5px; border-radius:5px; font-weight:700; margin-left:4px;">👩 M</span>' : p.gender === 'unisex' ? '<span style="font-size:9px; background:#ede9fe; color:#6d28d9; padding:2px 5px; border-radius:5px; font-weight:700; margin-left:4px;">⚧️ U</span>' : '';
  const bizName = state.businesses.find(b => b.id === p.business_id)?.name || 'General';
  const bizBadge = `<span style="font-size:9px; background:#e2e8f0; color:#475569; padding:2px 5px; border-radius:5px; font-weight:700; margin-left:4px; display:inline-block; margin-top:2px;">📍 ${bizName}</span>`;
  const creatorName = state.employees.find(e => e.id === p.created_by)?.name || 'Admin';

  return `
  <tr style="border-bottom:1px solid #f1f5f9;">
    <td style="padding:10px 8px; font-weight:600; min-width:120px;">
      <div style="font-size:13px; line-height:1.2; color:#0f172a;">${p.name}</div>
      <div style="display:flex; flex-wrap:wrap; align-items:center; gap:2px; margin-top:2px;">${genderBadge}${bizBadge}</div>
      <div style="font-size:10px; color:#94a3b8; font-weight:400; margin-top:2px;">👤 ${creatorName}</div>
    </td>
    <td style="padding:10px 6px; font-size:12px; white-space:nowrap; font-weight:600; color:#1e293b;">${fmt(p.price)}</td>
    <td style="padding:10px 6px; font-size:12px; color:var(--text-muted); white-space:nowrap;">${fmt(p.cost || 0)}</td>
    <td style="padding:10px 6px; font-size:12px; white-space:nowrap;">
      <span style="background:${p.stock < (p.purchase_price || 0) ? '#fee2e2' : '#f0f9ff'}; color:${p.stock < (p.purchase_price || 0) ? '#b91c1c' : '#0369a1'}; padding:3px 8px; border-radius:8px; font-weight:700;">
        ${p.stock}
      </span>
      <span style="font-size: 10px; color: var(--text-muted); margin-left: 3px;" title="Stock Fijo / Ideal">
        / Fijo: 
        <span onclick="window.editIdealStock('${p.id}', ${p.purchase_price || 0})" style="color:var(--primary); font-weight:bold; cursor:pointer; text-decoration:underline;">
          ${p.purchase_price || 0}
        </span>
      </span>
    </td>
    <td style="padding:10px 6px; text-align:center; white-space:nowrap; min-width:70px;">
      <button onclick="window.openEditProductModal('${p.id}')" style="background:#f1f5f9; border:none; color:var(--primary); cursor:pointer; padding:6px 8px; border-radius:6px; margin-right:4px; display:inline-flex; align-items:center; justify-content:center;" title="Editar Producto">
        <i data-lucide="edit-3" style="width:15px; height:15px;"></i>
      </button>
      <button onclick="window.deleteProduct('${p.id}')" style="background:#fef2f2; border:none; color:var(--danger); cursor:pointer; padding:6px 8px; border-radius:6px; display:inline-flex; align-items:center; justify-content:center;" title="Eliminar Producto">
        <i data-lucide="trash-2" style="width:15px; height:15px;"></i>
      </button>
    </td>
  </tr>
  `;
};

export function renderProductsAdmin(state, formatCurrency) {
  window.formatCurrencyGlobal = formatCurrency;
  const activeFilter = state.selectedInventoryBusinessId || 'all';
  
  const filteredProducts = state.products.filter(p => {
    if (activeFilter !== 'all' && p.business_id !== activeFilter) return false;
    if (state.inventorySearchQuery) {
      const q = state.inventorySearchQuery.toLowerCase();
      return p.name.toLowerCase().includes(q);
    }
    return true;
  });

  const totalCostVal = filteredProducts.reduce((sum, p) => sum + ((Number(p.stock) || 0) * (parseFloat(p.cost) || 0)), 0);
  const totalSaleVal = filteredProducts.reduce((sum, p) => sum + ((Number(p.stock) || 0) * (parseFloat(p.price) || 0)), 0);
  const totalUnits = filteredProducts.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);

  // Registrar manejador de búsqueda no destructivo (mantiene el foco y teclado del buscador)
  window.handleInventorySearch = (val) => {
    state.inventorySearchQuery = val;
    clearTimeout(_invSearchTimer);
    _invSearchTimer = setTimeout(() => {
      const tbody = document.getElementById('inventory-table-body');
      const summaryCard = document.getElementById('inventory-summary-card');
      
      const currentActiveFilter = state.selectedInventoryBusinessId || 'all';
      const searchRes = state.products.filter(p => {
        if (currentActiveFilter !== 'all' && p.business_id !== currentActiveFilter) return false;
        if (state.inventorySearchQuery) {
          const q = state.inventorySearchQuery.toLowerCase();
          return p.name.toLowerCase().includes(q);
        }
        return true;
      });

      const resCost = searchRes.reduce((sum, p) => sum + ((Number(p.stock) || 0) * (parseFloat(p.cost) || 0)), 0);
      const resSale = searchRes.reduce((sum, p) => sum + ((Number(p.stock) || 0) * (parseFloat(p.price) || 0)), 0);
      const resUnits = searchRes.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);

      const fmt = window.formatCurrencyGlobal || formatCurrency;

      if (summaryCard) {
        summaryCard.innerHTML = `
          <div>
            <span style="font-size: 11px; font-weight: 800; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; display: block;">💰 Total Invertido en Mercancía (Costo)</span>
            <h2 style="font-size: 24px; font-weight: 900; margin: 2px 0 0 0; color: #ffffff;">${fmt(resCost)}</h2>
          </div>
          <div style="display: flex; gap: 20px; flex-wrap: wrap; font-size: 12px;">
            <div>
              <span style="color: #94a3b8; font-weight: 600; display: block; font-size: 10px; text-transform: uppercase;">Valor Comercial (Venta)</span>
              <span style="font-weight: 800; color: #f1f5f9; font-size: 15px;">${fmt(resSale)}</span>
            </div>
            <div>
              <span style="color: #94a3b8; font-weight: 600; display: block; font-size: 10px; text-transform: uppercase;">Ganancia Bruta</span>
              <span style="font-weight: 800; color: #34d399; font-size: 15px;">+${fmt(resSale - resCost)}</span>
            </div>
            <div>
              <span style="color: #94a3b8; font-weight: 600; display: block; font-size: 10px; text-transform: uppercase;" title="Descontando $137.000/día de mantenimiento base">Utilidad Neta (Deducida)</span>
              <span style="font-weight: 900; color: #38bdf8; font-size: 15px;">+${fmt(Math.max(0, (resSale - resCost) - 137000))}</span>
            </div>
            <div>
              <span style="color: #94a3b8; font-weight: 600; display: block; font-size: 10px; text-transform: uppercase;">Unidades Físicas</span>
              <span style="font-weight: 800; color: #bae6fd; font-size: 15px;">${resUnits} unds</span>
            </div>
          </div>
        `;
      }

      if (tbody) {
        if (searchRes.length === 0) {
          tbody.innerHTML = `
            <tr>
              <td colspan="5" style="padding:40px; text-align:center; color:var(--text-muted); font-size:14px;">
                🔍 No se encontraron productos que coincidan con "<b>${val}</b>"
              </td>
            </tr>
          `;
        } else {
          tbody.innerHTML = searchRes
            .sort((a,b) => a.name.localeCompare(b.name))
            .map(p => createInventoryRowHtml(p, fmt, state))
            .join('');
          if (window.lucide) window.lucide.createIcons();
        }
      }
    }, 60);
  };

  return `
    <header class="main-header">
      <div class="logo-container">
        <div class="logo-icon">📦</div>
        <div class="header-title">
          <p class="role-tag" style="margin:0;">INVENTARIO</p>
          <h1>Catálogo de Productos</h1>
        </div>
      </div>
      <div class="header-actions">
        <button onclick="state.view='inventory_ai';render()" class="btn-primary" style="padding:8px 15px; font-size:12px; background:linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); border:none; box-shadow:0 4px 12px rgba(99,102,241,0.3);" title="Ver analítica predictiva de inventarios e IA">🧠 IA INVENTARIO</button>
        <button onclick="state.activeModal='add_inventory';render()" class="btn-primary" style="padding:8px 15px; font-size:12px; background:#10b981; border:none; margin-left:10px;" title="Cargar / Ingresar mercancía al inventario">+ CARGAR INVENTARIO</button>
        <button onclick="window.syncAllIdealStocksToCurrent()" class="btn-primary" style="padding:8px 15px; font-size:12px; background:#0284c7; border:none; margin-left:10px;" title="Copia el stock actual al stock fijo/ideal para todos los productos">🔄 FIJAR STOCK ACTUAL</button>
        <button onclick="state.activeModal='new_product';render()" class="btn-primary" style="padding:8px 15px; font-size:12px; margin-left:10px;">+ NUEVO PRODUCTO</button>
        <button onclick="state.view='manager_dashboard';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px; margin-left:10px;">VOLVER</button>
      </div>
    </header>

    <div class="container">
      
      <!-- TARJETA CONSOLIDADA DE INVERSIÓN EN INVENTARIO -->
      <div id="inventory-summary-card" style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: white; padding: 18px 22px; border-radius: 18px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; box-shadow: 0 10px 20px rgba(15,23,42,0.12);">
        <div>
          <span style="font-size: 11px; font-weight: 800; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px; display: block;">💰 Total Invertido en Mercancía (Costo)</span>
          <h2 style="font-size: 24px; font-weight: 900; margin: 2px 0 0 0; color: #ffffff;">${formatCurrency(totalCostVal)}</h2>
        </div>
        <div style="display: flex; gap: 20px; flex-wrap: wrap; font-size: 12px;">
          <div>
            <span style="color: #94a3b8; font-weight: 600; display: block; font-size: 10px; text-transform: uppercase;">Valor Comercial (Venta)</span>
            <span style="font-weight: 800; color: #f1f5f9; font-size: 15px;">${formatCurrency(totalSaleVal)}</span>
          </div>
          <div>
            <span style="color: #94a3b8; font-weight: 600; display: block; font-size: 10px; text-transform: uppercase;">Ganancia Bruta</span>
            <span style="font-weight: 800; color: #34d399; font-size: 15px;">+${formatCurrency(totalSaleVal - totalCostVal)}</span>
          </div>
          <div>
            <span style="color: #94a3b8; font-weight: 600; display: block; font-size: 10px; text-transform: uppercase;" title="Descontando $137.000/día de mantenimiento base">Utilidad Neta (Deducida)</span>
            <span style="font-weight: 900; color: #38bdf8; font-size: 15px;">+${formatCurrency(Math.max(0, (totalSaleVal - totalCostVal) - 137000))}</span>
          </div>
          <div>
            <span style="color: #94a3b8; font-weight: 600; display: block; font-size: 10px; text-transform: uppercase;">Unidades Físicas</span>
            <span style="font-weight: 800; color: #bae6fd; font-size: 15px;">${totalUnits} unds</span>
          </div>
        </div>
      </div>

      <!-- Barra de Filtros y Búsqueda de Inventario -->
      <div class="card" style="margin-bottom: 15px; padding: 15px; display: flex; gap: 15px; flex-wrap: wrap; align-items: center; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0;">
        <div style="display: flex; gap: 15px; flex-wrap: wrap; align-items: center; flex: 1; width: 100%;">
          
          <!-- Selector de Sede -->
          <div style="display: flex; flex-direction: column; gap: 4px; min-width: 200px; flex: 1;">
            <label style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">📍 Filtrar por Sede</label>
            <select onchange="state.selectedInventoryBusinessId = this.value; window.render()" class="form-control" style="padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 13px; background: white; cursor: pointer;">
              <option value="all" ${(state.selectedInventoryBusinessId || 'all') === 'all' ? 'selected' : ''}>Mostrar todas las Sedes</option>
              ${state.businesses.map(b => `
                <option value="${b.id}" ${(state.selectedInventoryBusinessId || 'all') === b.id ? 'selected' : ''}>${b.name}</option>
              `).join('')}
            </select>
          </div>

          <!-- Entrada de Búsqueda -->
          <div style="display: flex; flex-direction: column; gap: 4px; min-width: 220px; flex: 2;">
            <label style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">🔍 Buscar Producto por Nombre</label>
            <input type="text" id="inventory-search-input" placeholder="Escribe para buscar..." value="${state.inventorySearchQuery || ''}" oninput="window.handleInventorySearch(this.value)" style="padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 13px; width: 100%;">
          </div>

        </div>
      </div>

      <!-- Tabla Responsiva de Inventario -->
      <div class="card" style="padding: 0; overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 14px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; min-width: 380px;">
          <thead style="background: #f8fafc; color: var(--text-muted);">
            <tr>
              <th style="padding: 10px 8px; text-align: left; border-bottom: 1px solid #f1f5f9; font-size: 12px;">Nombre</th>
              <th style="padding: 10px 6px; text-align: left; border-bottom: 1px solid #f1f5f9; font-size: 12px;">Precio</th>
              <th style="padding: 10px 6px; text-align: left; border-bottom: 1px solid #f1f5f9; font-size: 12px;">Costo</th>
              <th style="padding: 10px 6px; text-align: left; border-bottom: 1px solid #f1f5f9; font-size: 12px;">Stock</th>
              <th style="padding: 10px 6px; text-align: center; border-bottom: 1px solid #f1f5f9; font-size: 12px;">Acciones</th>
            </tr>
          </thead>
          <tbody id="inventory-table-body">
            ${filteredProducts
              .sort((a,b) => a.name.localeCompare(b.name))
              .map(p => createInventoryRowHtml(p, formatCurrency, state))
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}
