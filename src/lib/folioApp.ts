// ============================================================
// src/lib/folioApp.ts
// Folios de la app Biobox de una incidencia, para el buscador de
// Incidencias (Erik, 17-nov-2026): «BBOTR-00437» o «otr 437» la encuentran.
//
//   · Si la incidencia nació de un reporte de la app, su folio va en la
//     primera línea de observaciones («App Biobox · reporte BBOTR-00422 ·…»,
//     lo escribe la base al crearla).
//   · Si se le ligaron reportes después, cada uno está en su historial
//     (evento reporte_app_ligado, detalle = folio).
// Sin supabase: se prueba en tests/folioApp.test.mjs.
// ============================================================
import type { EventoHistorial } from './historialInc';

const DE_OBS = /^App Biobox · reporte (\S+)/;

export function foliosApp(
  observaciones: string | null | undefined,
  historial: readonly Pick<EventoHistorial, 'evento' | 'detalle'>[] | undefined
): string[] {
  const folios: string[] = [];
  const m = DE_OBS.exec((observaciones || '').trimStart());
  if (m) folios.push(m[1]);
  for (const e of historial || []) {
    if (e.evento === 'reporte_app_ligado' && e.detalle?.trim()) folios.push(e.detalle.trim());
  }
  return [...new Set(folios)];
}
