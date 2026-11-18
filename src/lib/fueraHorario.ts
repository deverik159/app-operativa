// ============================================================
// src/lib/fueraHorario.ts
// Lo que entró directo al área fuera del horario del validador (auto-ruteo,
// lib/crearReporte.ts) y en qué quedó su prevalidación (Erik, 18-nov-2026:
// filtro para que el validador lo revise).
//
// La base guarda requiere_prevalidacion (entró directo) y prevalidada (el
// área ya la prevalidó). Descartar la regresa a 'rechazada' con
// prevalidada = false (lib/acciones.ts).
// Sin supabase: se prueba en tests/fueraHorario.test.mjs.
// ============================================================
export type EstadoFueraHorario = 'pendiente' | 'prevalidada' | 'descartada';

type ParaEstado = {
  requiere_prevalidacion?: boolean | null;
  prevalidada?: boolean | null;
  estatus?: string | null;
};

/** null = no entró fuera de horario (pasó por el validador). */
export function estadoFueraHorario(i: ParaEstado): EstadoFueraHorario | null {
  if (!i.requiere_prevalidacion) return null;
  if (i.prevalidada) return 'prevalidada';
  if (i.estatus === 'rechazada') return 'descartada';
  // En proceso sin prevalidar. Si después avanzó sin la marca (filas
  // viejas), cuenta igual como pendiente de revisar.
  return 'pendiente';
}

export const FUERA_HORARIO_LABEL: Record<EstadoFueraHorario, string> = {
  pendiente: 'Por prevalidar',
  prevalidada: 'Prevalidada por el área',
  descartada: 'Descartada por el área',
};

/** Cuántas hay de cada estado (para las opciones del filtro). */
export function contarFueraHorario(
  lista: readonly ParaEstado[]
): Record<EstadoFueraHorario, number> & { total: number } {
  const n = { pendiente: 0, prevalidada: 0, descartada: 0, total: 0 };
  for (const i of lista) {
    const e = estadoFueraHorario(i);
    if (!e) continue;
    n[e]++;
    n.total++;
  }
  return n;
}
