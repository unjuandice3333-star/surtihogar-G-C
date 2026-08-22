import { describe, it, expect } from 'vitest';

const resolveActiveBusiness = (shifts, user) => {
  if (!user) return null;
  if (user.role === 'admin') return 'all';

  const userShifts = (shifts || []).filter(s => s.user_id === user.id);
  if (userShifts.length === 0) return user.business_id;

  const nowLocal = new Date();

  // A. Turno activo estricto por hora (comparar start_time/end_time con hora actual)
  const strictShift = userShifts.find(s => {
    const start = new Date(s.start_time);
    const end = s.end_time ? new Date(s.end_time) : null;
    return nowLocal >= new Date(start.getTime() - 60000) && (!end || nowLocal <= end);
  });
  if (strictShift) return strictShift.business_id;

  // B. Turno programado HOY (si existe turno en fecha calendario actual, usar ese business_id)
  const todayStr = nowLocal.toDateString();
  const todayShift = userShifts.find(s => {
    const start = new Date(s.start_time);
    return start.toDateString() === todayStr;
  });
  if (todayShift) return todayShift.business_id;

  // C. Último turno reciente (programado hace menos de 12 horas)
  const sortedShifts = [...userShifts].sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  if (sortedShifts.length > 0) {
    const lastShift = sortedShifts[0];
    const lastShiftStart = new Date(lastShift.start_time);
    const diffMs = Math.abs(nowLocal.getTime() - lastShiftStart.getTime());
    if (diffMs < 12 * 60 * 60 * 1000) { // Menos de 12 horas
      return lastShift.business_id;
    }
  }

  // D. Fallback final
  return user.business_id;
};

describe('Arquitectura de Resolución de Negocio Activo (resolveActiveBusiness)', () => {
  const user = { id: 'usr-123', role: 'empleado', business_id: 'default-jm' };
  const admin = { id: 'usr-admin', role: 'admin', business_id: null };

  it('ADMIN: Debe retornar always "all"', () => {
    const shifts = [{ user_id: 'usr-admin', business_id: 'electro', start_time: new Date().toISOString(), end_time: null }];
    expect(resolveActiveBusiness(shifts, admin)).toBe('all');
  });

  it('CRITERIO A: Debe retornar el negocio del turno activo estricto por hora', () => {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 60 * 1000).toISOString(); // Hace 30 mins
    const end = new Date(now.getTime() + 30 * 60 * 1000).toISOString();  // En 30 mins
    const shifts = [
      { user_id: 'usr-123', business_id: 'electro', start_time: start, end_time: end }
    ];
    expect(resolveActiveBusiness(shifts, user)).toBe('electro');
  });

  it('CRITERIO B: Debe retornar el negocio del turno programado para HOY aunque esté fuera de rango horario', () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0).toISOString(); // 6 PM de hoy
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 22, 0, 0).toISOString();   // 10 PM de hoy
    
    const shifts = [
      { user_id: 'usr-123', business_id: 'electro', start_time: start, end_time: end }
    ];
    // Supongamos que entramos antes de la hora (ej: 8 AM), debe resolver a 'electro'
    expect(resolveActiveBusiness(shifts, user)).toBe('electro');
  });

  it('CRITERIO C: Debe retornar el último turno reciente si fue hace menos de 12 horas', () => {
    const now = new Date();
    const start = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(); // Hace 2 horas
    const shifts = [
      { user_id: 'usr-123', business_id: 'electro', start_time: start, end_time: null }
    ];
    expect(resolveActiveBusiness(shifts, user)).toBe('electro');
  });

  it('CRITERIO C (Exclusión): NO debe retornar el último turno si fue hace más de 12 horas', () => {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString(); // Hace 30 horas (ayer)
    const end = new Date(now.getTime() - 22 * 60 * 60 * 1000).toISOString();   // Finalizó hace 22 horas
    const shifts = [
      { user_id: 'usr-123', business_id: 'electro', start_time: start, end_time: end }
    ];
    // Debe usar el fallback final (default-jm) ya que pasaron más de 12 horas
    expect(resolveActiveBusiness(shifts, user)).toBe('default-jm');
  });

  it('CRITERIO D: Debe retornar el negocio por defecto del usuario si no hay turnos', () => {
    expect(resolveActiveBusiness([], user)).toBe('default-jm');
  });
});
