import { describe, it, expect } from 'vitest';

const anchorMonday = new Date(2026, 4, 25);
anchorMonday.setHours(0,0,0,0);

const getMondayOfDate = (d) => {
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = monday.getDay();
  monday.setDate(monday.getDate() - day + (day === 0 ? -6 : 1));
  monday.setHours(0,0,0,0);
  return monday;
};

const getWeekIndex = (d) => {
  const targetMonday = getMondayOfDate(d);
  const diffMs = targetMonday.getTime() - anchorMonday.getTime();
  const diffWeeks = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
  return ((2 + diffWeeks) % 4 + 4) % 4; // 2 corresponds to Semana 3
};

describe('Generador de Turnos - Continuidad de 4 Semanas con Epoch Real', () => {
  it('Debe retornar Semana 3 (index 2) para cualquier día de la semana actual (Lunes 25 Mayo - Domingo 31 Mayo 2026)', () => {
    // Lunes 25 Mayo
    expect(getWeekIndex(new Date(2026, 4, 25))).toBe(2);
    // Miércoles 27 Mayo
    expect(getWeekIndex(new Date(2026, 4, 27))).toBe(2);
    // Viernes 29 Mayo (hoy)
    expect(getWeekIndex(new Date(2026, 4, 29))).toBe(2);
    // Domingo 31 Mayo
    expect(getWeekIndex(new Date(2026, 4, 31))).toBe(2);
  });

  it('Debe retornar Semana 4 (index 3) para la próxima semana (Lunes 1 Junio - Domingo 7 Junio 2026)', () => {
    // Lunes 1 Junio
    expect(getWeekIndex(new Date(2026, 5, 1))).toBe(3);
    // Miércoles 3 Junio
    expect(getWeekIndex(new Date(2026, 5, 3))).toBe(3);
    // Domingo 7 Junio
    expect(getWeekIndex(new Date(2026, 5, 7))).toBe(3);
  });

  it('Debe retornar Semana 1 (index 0) para la semana subsiguiente (Lunes 8 Junio - Domingo 14 Junio 2026)', () => {
    // Lunes 8 Junio
    expect(getWeekIndex(new Date(2026, 5, 8))).toBe(0);
    // Domingo 14 Junio
    expect(getWeekIndex(new Date(2026, 5, 14))).toBe(0);
  });

  it('Debe retornar Semana 2 (index 1) para la semana posterior (Lunes 15 Junio - Domingo 21 Junio 2026)', () => {
    // Lunes 15 Junio
    expect(getWeekIndex(new Date(2026, 5, 15))).toBe(1);
    // Domingo 21 Junio
    expect(getWeekIndex(new Date(2026, 5, 21))).toBe(1);
  });

  it('Debe retornar Semana 2 (index 1) para la semana anterior (Lunes 18 Mayo - Domingo 24 Mayo 2026)', () => {
    // Lunes 18 Mayo
    expect(getWeekIndex(new Date(2026, 4, 18))).toBe(1);
    // Domingo 24 Mayo
    expect(getWeekIndex(new Date(2026, 4, 24))).toBe(1);
  });

  it('Debe retornar Semana 1 (index 0) para hace dos semanas (Lunes 11 Mayo - Domingo 17 Mayo 2026)', () => {
    // Lunes 11 Mayo
    expect(getWeekIndex(new Date(2026, 4, 11))).toBe(0);
    // Domingo 17 Mayo
    expect(getWeekIndex(new Date(2026, 4, 17))).toBe(0);
  });
});
