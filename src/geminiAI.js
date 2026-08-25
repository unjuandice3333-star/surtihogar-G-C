/**
 * Asistente Global e Integración Universal de Google Gemini IA
 * SurtiHogar & Baratillo
 */

/**
 * Prepara el contexto en tiempo real de toda la aplicación para enviarlo a Gemini
 */
export const buildFullAppContext = (state) => {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // A. Ventas del día
  const todaySales = (state.sales || []).filter(s => {
    const sDate = s.created_at || s.date || '';
    return sDate.startsWith(todayStr);
  });
  const todaySalesTotal = todaySales.reduce((sum, s) => sum + (Number(s.total) || 0), 0);

  // B. Gastos del día
  const todayExpenses = (state.transactions || []).filter(t => {
    const tDate = t.created_at || t.date || '';
    return t.type === 'expense' && tDate.startsWith(todayStr);
  });
  const todayExpensesTotal = todayExpenses.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  // C. Valoración de Inventario
  const totalProductsCount = (state.products || []).length;
  const totalCostVal = (state.products || []).reduce((sum, p) => sum + ((Number(p.stock) || 0) * (parseFloat(p.cost) || 0)), 0);
  const totalSaleVal = (state.products || []).reduce((sum, p) => sum + ((Number(p.stock) || 0) * (parseFloat(p.price) || 0)), 0);
  const lowStockCount = (state.products || []).filter(p => Number(p.stock) <= (Number(p.purchase_price) || 2)).length;

  // D. Sedes y Turnos
  const activeShiftBus = state.businesses?.find(b => b.id === (state.activeShiftBusinessId || state.currentBusinessId));
  const activeShiftName = activeShiftBus ? activeShiftBus.name : 'Sin Turno Activo';

  return {
    fecha: now.toLocaleDateString('es-CO'),
    hora: now.toLocaleTimeString('es-CO'),
    usuario: state.user?.name || state.user?.email || 'Usuario',
    rol: state.user?.role || 'Empleado',
    sedeActual: activeShiftName,
    ventasHoyCount: todaySales.length,
    ventasHoyTotal: todaySalesTotal,
    gastosHoyTotal: todayExpensesTotal,
    ingresoNetoHoy: todaySalesTotal - todayExpensesTotal,
    descuentoMantenimientoDiario: 137000,
    utilidadRealHoy: (todaySalesTotal - todayExpensesTotal) - 137000,
    totalProductosEnCatalogo: totalProductsCount,
    totalInvertidoCosto: totalCostVal,
    totalValorComercialVenta: totalSaleVal,
    gananciaPotencialInventario: totalSaleVal - totalCostVal,
    productosBajoStockCount: lowStockCount
  };
};

/**
 * Consulta universal al Asistente de Gemini IA
 */
export const askGlobalGeminiAssistant = async ({ query, state, apiKey, contextType = 'general' }) => {
  const key = apiKey || state.geminiApiKey || localStorage.getItem('gemini_api_key') || (import.meta && import.meta.env && import.meta.env.VITE_GEMINI_API_KEY) || '';
  if (!key) {
    throw new Error('Por favor ingresa o configura tu API Key de Google Gemini.');
  }

  const ctx = buildFullAppContext(state);

  const prompt = `Eres el Asistente Ejecutivo de Inteligencia Artificial (impulsado por Google Gemini) para la empresa SurtiHogar & Baratillo en Colombia.
Tu función es responder con precisión, empatía profesional y utilidad estratégica a cualquier consulta del administrador o los colaboradores.

DATOS OPERATIVOS EN TIEMPO REAL (${ctx.fecha} ${ctx.hora}):
- Usuario: ${ctx.usuario} (${ctx.rol}) | Sede actual: ${ctx.sedeActual}
- Ventas registradas hoy: ${ctx.ventasHoyCount} ventas por $${ctx.ventasHoyTotal.toLocaleString('es-CO')}
- Gastos registrados hoy: $${ctx.gastosHoyTotal.toLocaleString('es-CO')}
- Mantenimiento base diario (costos fijos): $137.000 COP/día
- Resultado neto estimado de hoy (Ventas - Gastos - $137k fijos): $${ctx.utilidadRealHoy.toLocaleString('es-CO')}
- Catálogo de inventario: ${ctx.totalProductosEnCatalogo} productos
- Capital total invertido en inventario (a costo): $${ctx.totalInvertidoCosto.toLocaleString('es-CO')}
- Valor total a precio de venta: $${ctx.totalValorComercialVenta.toLocaleString('es-CO')}
- Productos con stock crítico/bajo: ${ctx.productosBajoStockCount} artículos

PREGUNTA / SOLICITUD DEL USUARIO:
"${query}"

Responde de forma clara, concisa (máximo 3 párrafos o viñetas), práctica y con emojis explicativos. Da recomendaciones directas si se requiere.`;

  const candidateModels = [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-flash-latest'
  ];

  let lastError = null;

  for (const model of candidateModels) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      } else {
        const errData = await response.json().catch(() => ({}));
        lastError = new Error(errData.error?.message || `Error HTTP ${response.status}`);
      }
    } catch (e) {
      clearTimeout(timeoutId);
      lastError = e;
    }
  }

  throw lastError || new Error('No se pudo conectar con los servidores de Gemini IA.');
};
