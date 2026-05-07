import { describe, it, expect } from 'vitest';

// Simulación de lógica de control de acceso (RBAC)
const checkAccess = (user, action, targetBusinessId) => {
  if (user.role === 'admin') return true; // El admin puede hacer todo
  
  if (user.role === 'empleado') {
    if (action === 'delete') return false; // Empleado no puede borrar
    if (action === 'view' || action === 'create') {
      return user.business_id === targetBusinessId; // Solo su negocio
    }
  }
  return false;
};

describe('Validación de Roles y Permisos (RBAC)', () => {

  const admin = { id: 'a1', role: 'admin' };
  const empleadoBus1 = { id: 'e1', role: 'empleado', business_id: 'bus-1' };

  it('ADMIN: Debe poder ver cualquier negocio', () => {
    expect(checkAccess(admin, 'view', 'bus-1')).toBe(true);
    expect(checkAccess(admin, 'view', 'bus-2')).toBe(true);
  });

  it('ADMIN: Debe poder eliminar registros', () => {
    expect(checkAccess(admin, 'delete', 'bus-1')).toBe(true);
  });

  it('EMPLEADO: Solo debe ver su negocio asignado', () => {
    expect(checkAccess(empleadoBus1, 'view', 'bus-1')).toBe(true);
    expect(checkAccess(empleadoBus1, 'view', 'bus-2')).toBe(false);
  });

  it('EMPLEADO: Debe tener prohibido eliminar registros', () => {
    expect(checkAccess(empleadoBus1, 'delete', 'bus-1')).toBe(false);
  });

  it('INTENTOS INVÁLIDOS: Deben ser denegados', () => {
    const anonimo = { role: 'invitado' };
    expect(checkAccess(anonimo, 'create', 'bus-1')).toBe(false);
  });

});
