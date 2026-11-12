// ============================================================
// src/lib/validaEn.ts
// ¿Puede ESTE usuario validar ESTA incidencia? (Erik, 12-nov-2026)
//
// Espejo de la política `inc_upd_validador` de la base: validador DE ESA
// unidad (sin unidad no cuenta) y, si su rol trae medio, del mismo medio
// (Impreso/Digital). El manager valida todo.
//
// Por qué hace falta: la app ve más incidencias de las que puede validar.
// Ana (validadora de Ecovallas y Vía Verde, Digital) también es reportante
// del área Operaciones, y `inc_sel_reportante` le enseña lo que reportó
// Operaciones en CUALQUIER unidad. Mis pendientes contaba como suya la
// reasignación pendiente de una de Biobox (BBMM00044) solo por tener el rol
// de validador; la base no la hubiera dejado resolverla.
// ============================================================

type FilaRol = {
  rol: string;
  unidad_negocio: string | null;
  medio?: string | null;
};

type IncMin = { unidad_negocio?: string | null; medio?: string | null };

const minus = (s: string | null | undefined) => (s ?? '').toLowerCase();

export function validaEnIncidencia(roles: readonly FilaRol[], inc: IncMin): boolean {
  if (roles.some((r) => r.rol === 'manager')) return true;
  return roles.some(
    (r) =>
      r.rol === 'validador' &&
      r.unidad_negocio != null &&
      inc.unidad_negocio != null &&
      minus(r.unidad_negocio) === minus(inc.unidad_negocio) &&
      (r.medio == null || (inc.medio != null && minus(r.medio) === minus(inc.medio)))
  );
}
