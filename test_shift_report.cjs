const state = {
  user: { id: 'admin-123', role: 'admin' },
  currentBusinessId: 'all',
  shifts: [
     { user_id: 'emp-456', start_time: '2026-05-12T21:00:00.000Z', end_time: '2026-05-13T06:00:00.000Z' }
  ],
  transactions: [
     { user_id: 'emp-456', amount: 100000, type: 'income', date: '2026-05-12T23:30:00.000Z' },
     { user_id: 'emp-456', amount: 50000, type: 'income', date: '2026-05-13T01:15:00.000Z' },
     { user_id: 'emp-456', amount: 20000, type: 'expense', date: '2026-05-13T02:00:00.000Z' }
  ]
};

// Mock formatCurrency
const formatCurrency = v => '$' + v;

// The algorithm implementation
function simulateShowShiftReport(timeframe = 'daily') {
  const now = new Date('2026-05-13T04:00:00.000Z'); // Simulated time: early morning today (May 13)
  
  let startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  
  if (timeframe === 'daily') {
    const activeUserShift = (state.shifts || []).find(s => {
      const targetUserId = state.user?.role === 'admin' ? s.user_id : state.user?.id;
      const isUserMatch = s.user_id === targetUserId;
      const sStart = new Date(s.start_time);
      const sEnd = new Date(s.end_time);
      return isUserMatch && now >= new Date(sStart.getTime() - 60 * 60 * 1000) && now <= new Date(sEnd.getTime() + 60 * 60 * 1000);
    });
    if (activeUserShift) {
      startDate = new Date(activeUserShift.start_time);
    }
  }

  const myTrx = state.transactions.filter(t => {
    const isRoleMatch = (state.user?.role === 'admin') ? true : (t.user_id === state.user?.id);
    const isDateMatch = new Date(t.date) >= startDate;
    return isRoleMatch && isDateMatch;
  });

  const totalSales = myTrx.filter(t => t.type === 'income').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const totalExpenses = myTrx.filter(t => t.type === 'expense').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const balance = totalSales - totalExpenses;

  return { totalSales, totalExpenses, balance, count: myTrx.length, startDate: startDate.toISOString() };
}

console.log("--- MOCK SCENARIO: ADMIN VIEWING REPORT ---");
console.log(simulateShowShiftReport('daily'));

state.user = { id: 'emp-456', role: 'empleado' };
console.log("\n--- MOCK SCENARIO: EMPLOYEE VIEWING OWN NOCTURNAL REPORT ---");
console.log(simulateShowShiftReport('daily'));

state.user = { id: 'emp-OTHER', role: 'empleado' };
console.log("\n--- MOCK SCENARIO: DIFFERENT EMPLOYEE (SHOULD SEE $0) ---");
console.log(simulateShowShiftReport('daily'));
