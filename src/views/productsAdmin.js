export function renderProductsAdmin(state, formatCurrency) {
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
      <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: white; padding: 18px 22px; border-radius: 18px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; box-shadow: 0 10px 20px rgba(15,23,42,0.12);">
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
          <div style="display: flex; flex-direction: column; gap: 4px; min-width: 220px; flex: 1;">
            <label style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">📍 Filtrar por Sede</label>
            <select onchange="state.selectedInventoryBusinessId = this.value; window.render()" class="form-control" style="padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 13px; background: white; cursor: pointer;">
              <option value="all" ${(state.selectedInventoryBusinessId || 'all') === 'all' ? 'selected' : ''}>Mostrar todas las Sedes</option>
              ${state.businesses.map(b => `
                <option value="${b.id}" ${(state.selectedInventoryBusinessId || 'all') === b.id ? 'selected' : ''}>${b.name}</option>
              `).join('')}
            </select>
          </div>

          <!-- Entrada de Búsqueda -->
          <div style="display: flex; flex-direction: column; gap: 4px; min-width: 250px; flex: 2;">
            <label style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">🔍 Buscar Producto por Nombre</label>
            <input type="text" placeholder="Escribe para buscar..." value="${state.inventorySearchQuery || ''}" oninput="state.inventorySearchQuery = this.value; window.render()" style="padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 13px; width: 100%;">
          </div>

        </div>
      </div>

      <div class="card" style="padding:0; overflow:hidden;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead style="background:#f8fafc; color:var(--text-muted);">
            <tr>
              <th style="padding:15px; text-align:left; border-bottom:1px solid #f1f5f9;">Nombre</th>
              <th style="padding:15px; text-align:left; border-bottom:1px solid #f1f5f9;">Precio</th>
              <th style="padding:15px; text-align:left; border-bottom:1px solid #f1f5f9;">Costo</th>
              <th style="padding:15px; text-align:left; border-bottom:1px solid #f1f5f9;">Stock</th>
              <th style="padding:15px; text-align:left; border-bottom:1px solid #f1f5f9;">Registrado por</th>
              <th style="padding:15px; text-align:center; border-bottom:1px solid #f1f5f9;">Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${filteredProducts
              .sort((a,b) => a.name.localeCompare(b.name))
              .map(p => {
                const genderBadge = p.gender === 'hombre' ? '<span style="font-size:9px; background:#dbeafe; color:#1d4ed8; padding:2px 6px; border-radius:6px; font-weight:700; margin-left:6px;">👨 H</span>' : p.gender === 'mujer' ? '<span style="font-size:9px; background:#fce7f3; color:#be185d; padding:2px 6px; border-radius:6px; font-weight:700; margin-left:6px;">👩 M</span>' : p.gender === 'unisex' ? '<span style="font-size:9px; background:#ede9fe; color:#6d28d9; padding:2px 6px; border-radius:6px; font-weight:700; margin-left:6px;">⚧️ U</span>' : '';
                const bizName = state.businesses.find(b => b.id === p.business_id)?.name || 'General';
                const bizBadge = `<span style="font-size:9px; background:#e2e8f0; color:#475569; padding:2px 6px; border-radius:6px; font-weight:700; margin-left:6px;">📍 ${bizName}</span>`;
                return `
                <tr style="border-bottom:1px solid #f1f5f9;">
                  <td style="padding:15px; font-weight:600;">${p.name}${genderBadge}${bizBadge}</td>
                  <td style="padding:15px;">${formatCurrency(p.price)}</td>
                  <td style="padding:15px; color:var(--text-muted);">${formatCurrency(p.cost || 0)}</td>
                  <td style="padding:15px; white-space:nowrap;">
                    <span style="background:${p.stock < (p.purchase_price || 0) ? '#fee2e2' : '#f0f9ff'}; color:${p.stock < (p.purchase_price || 0) ? '#b91c1c' : '#0369a1'}; padding:4px 10px; border-radius:10px; font-weight:700;">
                      ${p.stock}
                    </span>
                    <span style="font-size: 11px; color: var(--text-muted); margin-left: 5px;" title="Stock Fijo / Ideal">
                      / Fijo: 
                      <span onclick="window.editIdealStock('${p.id}', ${p.purchase_price || 0})" style="color:var(--primary); font-weight:bold; cursor:pointer; text-decoration:underline;">
                        ${p.purchase_price || 0}
                      </span>
                    </span>
                  </td>
                  <td style="padding:15px; font-size:11px; color:var(--primary); font-weight:600;">👤 ${state.employees.find(e => e.id === p.created_by)?.name || 'Admin'}</td>
                  <td style="padding:15px; text-align:center;">
                    <button onclick="window.openEditProductModal('${p.id}')" style="background:none; border:none; color:var(--primary); cursor:pointer; padding:6px; display:inline-flex; align-items:center; justify-content:center; margin-right:8px;" title="Editar Producto">
                      <i data-lucide="edit-3" style="width:16px; height:16px;"></i>
                    </button>
                    <button onclick="window.deleteProduct('${p.id}')" style="background:none; border:none; color:var(--danger); cursor:pointer; padding:6px; display:inline-flex; align-items:center; justify-content:center;" title="Eliminar Producto">
                      <i data-lucide="trash-2" style="width:16px; height:16px;"></i>
                    </button>
                  </td>
                </tr>
              `}).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}
