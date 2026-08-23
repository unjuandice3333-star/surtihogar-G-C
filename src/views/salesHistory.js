export function renderSalesHistory(state, formatCurrency) {
  const activeTab = state.salesHistoryTab;
  const sellerObjResolver = (userId, employees, currentUser) => {
    return employees?.find(emp => emp.id === userId) || (currentUser?.id === userId ? currentUser : null);
  };

  return `
    <header class="main-header">
      <div class="logo-container">
        <div class="logo-icon"><img src="logo_v3.png" alt="Logo"></div>
        <div class="header-title">
          <p class="role-tag" style="background:var(--primary);">Auditoría Central</p>
          <h1>Historial y Movimientos</h1>
        </div>
      </div>
      <div class="header-actions">
        <button onclick="state.view='manager_dashboard';window.render()" class="btn-secondary" style="padding:8px 15px; font-size:12px; font-weight:700; display:flex; align-items:center; gap:5px;"><i data-lucide="arrow-left" style="width:14px;"></i> VOLVER</button>
      </div>
    </header>

    <div class="container" style="max-width:1200px; padding-top:20px;">
      <div style="display:flex; gap:10px; margin-bottom:20px;">
        <button onclick="state.salesHistoryTab='sales';render()" class="btn-primary" style="background:${activeTab === 'sales' ? 'var(--primary)' : '#64748b'}; border:none; padding:10px 20px; border-radius:12px; font-weight:700; font-size:13px; cursor:pointer;">🛍️ Ventas (POS)</button>
        <button onclick="state.salesHistoryTab='transactions';render()" class="btn-primary" style="background:${activeTab === 'transactions' ? 'var(--primary)' : '#64748b'}; border:none; padding:10px 20px; border-radius:12px; font-weight:700; font-size:13px; cursor:pointer;">💵 Flujo de Caja (Transacciones)</button>
      </div>

      <div class="card" style="padding:0; overflow:hidden; border-radius:20px; box-shadow: var(--shadow-lg);">
        ${activeTab === 'sales' ? `
        <div style="padding:20px 24px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; background:linear-gradient(to right, #f8fafc, #ffffff);">
          <div>
            <h3 style="font-size:18px; font-weight:800; color:#1e293b;">Listado Detallado de Ventas</h3>
            <p style="font-size:12px; color:#64748b; margin-top:2px;">Auditoría por Local Operativo y Producto Vendido</p>
          </div>
          <div style="background:var(--secondary); color:white; font-weight:800; font-size:12px; padding:6px 14px; border-radius:30px;">
            ${state.sales.length} Ventas
          </div>
        </div>

        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; text-align:left; font-size:13px; min-width:850px;">
            <thead>
              <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0;">
                <th style="padding:16px 20px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px;">Referencia / Fecha</th>
                <th style="padding:16px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px;">Vendedor</th>
                <th style="padding:16px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px;">Negocio / Local</th>
                <th style="padding:16px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px;">Detalle de Productos</th>
                <th style="padding:16px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px; text-align:center;">Método</th>
                <th style="padding:16px 20px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px; text-align:right;">Monto Total</th>
              </tr>
            </thead>
            <tbody>
              ${state.sales.length === 0 ? `
                <tr><td colspan="6" style="padding:80px; text-align:center; color:#94a3b8;">
                  <div style="font-size:40px; margin-bottom:15px;">📦</div> Sin ventas registradas en el sistema todavía.
                </td></tr>
              ` : state.sales.map(sale => {
                const items = state.saleItems.filter(si => si.sale_id === sale.id);
                
                // 👤 Resolución de Vendedor en Memoria para Evitar Dependencias de Relaciones en BD
                const sellerObj = sellerObjResolver(sale.user_id, state.employees, state.user);
                const sellerName = sellerObj?.name || 'Sistema';

                // 🏢 Atribución Avanzada del Negocio (Doble Verificación: Producto, Transacciones vinculadas y Empleado)
                const bizIdsFromProducts = items.map(i => i.products?.business_id).filter(Boolean);
                const saleShortId = sale.id.slice(0,5);
                
                let relatedTxs = state.transactions.filter(t => t.note && t.note.includes(saleShortId));
                if (relatedTxs.length === 0 && sale.note && sale.note.startsWith('Venta informal: ')) {
                  const descPart = sale.note.replace('Venta informal: ', '').trim();
                  relatedTxs = state.transactions.filter(tx => tx.type === 'income' && tx.user_id === sale.user_id && (tx.description === descPart || tx.description === 'Venta Rápida: ' + descPart) && Math.abs(new Date(tx.date || tx.created_at) - new Date(sale.created_at)) < 120000);
                }
                if (relatedTxs.length === 0 && bizIdsFromProducts.length === 0) {
                  relatedTxs = state.transactions.filter(tx => tx.type === 'income' && tx.user_id === sale.user_id && Math.abs(new Date(tx.date || tx.created_at) - new Date(sale.created_at)) < 60000);
                }

                const bizIdsFromTransactions = relatedTxs.map(t => t.business_id);
                const allBizIds = [...new Set([...bizIdsFromProducts, ...bizIdsFromTransactions])];
                
                // Fallback a la sede asignada al empleado si no se detectó por productos/transacciones
                if (allBizIds.length === 0 && sellerObj?.business_id) {
                  allBizIds.push(sellerObj.business_id);
                }

                const bizNames = allBizIds.map(id => state.businesses.find(b => b.id === id)?.name || 'General');

                // 🛍️ Render de Productos (soporta productos del inventario y ventas rápidas no formalizadas)
                let itemsHtml = items.map(i => {
                  let prodName = i.products?.name;
                  let pendingBadge = '';
                  
                  if (!prodName) {
                     const pending = state.pendingProducts.find(pp => pp.sale_id === sale.id);
                     if (pending) {
                        prodName = pending.name;
                        pendingBadge = '<span style="background:#fff7ed; color:#c2410c; font-size:9px; font-weight:800; padding:1px 4px; border-radius:4px; border:1px solid #fed7aa; margin-left:4px;">POR ASIGNAR</span>';
                     } else if (sale.note && sale.note.includes('Venta informal')) {
                        prodName = sale.note.replace('Venta informal: ', '');
                     } else {
                        prodName = 'Producto Especial';
                     }
                  }

                  return `
                    <div style="display:flex; justify-content:space-between; margin-bottom:6px; padding-bottom:6px; border-bottom:1px dashed #e2e8f0; gap:10px; line-height:1.3;">
                      <span style="font-weight:600; color:#334155;">
                        ${prodName} ${pendingBadge}
                        <span style="color:#94a3b8; font-weight:700; margin-left:3px;">(x${i.quantity})</span>
                      </span>
                      <span style="font-weight:700; color:#64748b; font-family:monospace;">${formatCurrency(i.price)}</span>
                    </div>
                  `;
                }).join('');

                if (!itemsHtml && sale.note && sale.note.includes('Venta informal')) {
                  const informalProdName = sale.note.replace('Venta informal: ', '').trim();
                  itemsHtml = `
                    <div style="display:flex; justify-content:space-between; margin-bottom:6px; padding-bottom:6px; border-bottom:1px dashed #e2e8f0; gap:10px; line-height:1.3;">
                      <span style="font-weight:600; color:#334155;">
                        ${informalProdName} <span style="background:#fefce8; color:#a16207; font-size:9px; font-weight:800; padding:1px 4px; border-radius:4px; border:1px solid #fef08a; margin-left:4px;">DIRECTA</span>
                        <span style="color:#94a3b8; font-weight:700; margin-left:3px;">(x1)</span>
                      </span>
                      <span style="font-weight:700; color:#64748b; font-family:monospace;">${formatCurrency(sale.total)}</span>
                    </div>
                  `;
                }

                return `
                  <tr style="border-bottom:1px solid #f1f5f9; background:white; transition:background 0.15s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='white'">
                    <td style="padding:18px 20px; vertical-align:top;">
                      <div style="font-weight:800; color:#0f172a; font-family:monospace; background:#f1f5f9; padding:3px 6px; border-radius:6px; display:inline-block; font-size:11px;">#${sale.id.slice(0,8).toUpperCase()}</div>
                      <div style="font-size:11px; color:#64748b; margin-top:6px; display:flex; align-items:center; gap:4px;"><i data-lucide="calendar" style="width:11px;"></i> ${new Date(sale.created_at).toLocaleString('es-CO', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})}</div>
                    </td>
                    <td style="padding:18px; vertical-align:top;">
                      <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:32px; height:32px; background:#e0f2fe; color:#0369a1; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:12px; flex-shrink:0;">${(sellerName).slice(0,2).toUpperCase()}</div>
                        <div style="font-weight:700; color:#334155; font-size:13px;">${sellerName}</div>
                      </div>
                    </td>
                    <td style="padding:18px; vertical-align:top;">
                      <div style="display:flex; flex-wrap:wrap; gap:4px;">
                        ${bizNames.length > 0 ? bizNames.map(n => `<span style="background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; font-size:11px; font-weight:800; padding:3px 8px; border-radius:8px; white-space:nowrap;">🏬 ${n}</span>`).join('') : `<span style="background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; font-size:11px; font-weight:800; padding:3px 8px; border-radius:8px;">📦 Sin Atribuir</span>`}
                      </div>
                    </td>
                    <td style="padding:18px; min-width:280px; vertical-align:top;">
                      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:12px; font-size:12px;">
                        ${itemsHtml || '<span style="font-style:italic; color:#94a3b8;">Sin detalle cargado</span>'}
                      </div>
                    </td>
                    <td style="padding:18px; text-align:center; vertical-align:top;">
                      <span style="background:#f8fafc; color:#475569; font-weight:800; font-size:11px; padding:4px 10px; border-radius:20px; border:1px solid #e2e8f0; white-space:nowrap;">${sale.payment_method || 'Efectivo'}</span>
                    </td>
                    <td style="padding:18px 20px; text-align:right; vertical-align:top;">
                      <div style="font-weight:900; color:var(--success); font-size:15px; font-family:monospace; display:flex; justify-content:flex-end; align-items:center; gap:8px;">
                        ${formatCurrency(sale.total)}
                        ${state.user?.role === 'admin' ? `
                          <button onclick="window.openEditSaleModal('${sale.id}', ${sale.total}, '${sale.payment_method || 'Efectivo'}')" style="background:none; border:none; padding:4px; cursor:pointer; color:#94a3b8; border-radius:4px; display:flex; align-items:center; justify-content:center; transition:0.2s;" onmouseover="this.style.background='#f1f5f9'; this.style.color='#0369a1'" onmouseout="this.style.background='none'; this.style.color='#94a3b8'" title="Editar venta">
                            <i data-lucide="edit-3" style="width:14px; height:14px;"></i>
                          </button>
                        ` : ''}
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
        ` : `
        <div style="padding:20px 24px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; background:linear-gradient(to right, #f8fafc, #ffffff);">
          <div>
            <h3 style="font-size:18px; font-weight:800; color:#1e293b;">Listado Detallado de Transacciones</h3>
            <p style="font-size:12px; color:#64748b; margin-top:2px;">Auditoría e Historial Completo del Flujo de Caja</p>
          </div>
          <div style="background:var(--secondary); color:white; font-weight:800; font-size:12px; padding:6px 14px; border-radius:30px;">
            ${state.transactions.length} Transacciones
          </div>
        </div>

        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; text-align:left; font-size:13px; min-width:850px;">
            <thead>
              <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0;">
                <th style="padding:16px 20px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px;">Referencia / Fecha</th>
                <th style="padding:16px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px;">Sede / Negocio</th>
                <th style="padding:16px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px;">Categoría / Concepto</th>
                <th style="padding:16px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px;">Tipo</th>
                <th style="padding:16px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px; text-align:center;">Método</th>
                <th style="padding:16px 20px; color:#475569; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.5px; text-align:right;">Monto</th>
              </tr>
            </thead>
            <tbody>
              ${state.transactions.length === 0 ? `
                <tr><td colspan="6" style="padding:80px; text-align:center; color:#94a3b8;">
                  <div style="font-size:40px; margin-bottom:15px;">💸</div> Sin transacciones registradas.
                </td></tr>
              ` : state.transactions.map(t => {
                const bizName = state.businesses.find(b => b.id === t.business_id)?.name || 'General';
                const catName = state.categories.find(c => c.id === t.category_id)?.name || (t.type === 'income' ? 'Ingreso' : 'Egreso');
                const isIncome = t.type === 'income';

                return `
                  <tr style="border-bottom:1px solid #f1f5f9; background:white; transition:background 0.15s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='white'">
                    <td style="padding:18px 20px; vertical-align:top;">
                      <div style="font-weight:800; color:#0f172a; font-family:monospace; background:#f1f5f9; padding:3px 6px; border-radius:6px; display:inline-block; font-size:11px;">#${t.id.slice(0,8).toUpperCase()}</div>
                      <div style="font-size:11px; color:#64748b; margin-top:6px; display:flex; align-items:center; gap:4px;"><i data-lucide="calendar" style="width:11px;"></i> ${new Date(t.date || t.created_at).toLocaleString('es-CO', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})}</div>
                    </td>
                    <td style="padding:18px; vertical-align:top;">
                      <span style="background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; font-size:11px; font-weight:800; padding:3px 8px; border-radius:8px; white-space:nowrap;">🏬 ${bizName}</span>
                    </td>
                    <td style="padding:18px; vertical-align:top;">
                      <div style="font-weight:700; color:#334155;">${catName}</div>
                      <div style="font-size:11px; color:#64748b; margin-top:4px;">${t.note || t.description || ''}</div>
                    </td>
                    <td style="padding:18px; vertical-align:top;">
                      <span style="background:${isIncome ? '#dcfce7' : '#fee2e2'}; color:${isIncome ? '#15803d' : '#b91c1c'}; font-weight:800; font-size:11px; padding:4px 10px; border-radius:20px;">
                        ${isIncome ? 'INGRESO' : 'EGRESO'}
                      </span>
                    </td>
                    <td style="padding:18px; text-align:center; vertical-align:top;">
                      <span style="background:#f8fafc; color:#475569; font-weight:800; font-size:11px; padding:4px 10px; border-radius:20px; border:1px solid #e2e8f0; white-space:nowrap;">${t.payment_method || 'Efectivo'}</span>
                    </td>
                    <td style="padding:18px 20px; text-align:right; vertical-align:top;">
                      <div style="font-weight:900; color:${isIncome ? 'var(--success)' : 'var(--danger)'}; font-size:15px; font-family:monospace; display:flex; justify-content:flex-end; align-items:center; gap:8px;">
                        ${isIncome ? '+' : '-'} ${formatCurrency(t.amount)}
                        ${state.user?.role === 'admin' ? `
                          <button onclick="window.openEditTransactionModal('${t.id}')" style="background:none; border:none; padding:4px; cursor:pointer; color:#94a3b8; border-radius:4px; display:flex; align-items:center; justify-content:center; transition:0.2s;" onmouseover="this.style.background='#f1f5f9'; this.style.color='#0369a1'" onmouseout="this.style.background='none'; this.style.color='#94a3b8'" title="Editar transacción">
                            <i data-lucide="edit-3" style="width:14px; height:14px;"></i>
                          </button>
                        ` : ''}
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
        `}
      </div>
    </div>
  `;
}
