// ============================================================
// src/lib/historialInc.ts
// Historial de una incidencia en la tarjeta (Erik, 17-nov-2026).
//
// La base anota cada cambio de estatus y cada reasignación en
// `incidencias_historial` (triggers; migración incidencias_historial). La
// tarjeta enseña, bajo «Capturada», una línea por evento con fecha y quién:
// solo lo que sí pasó.
// ============================================================
export type EventoHistorial = {
  record_id: string;
  evento: string;
  estatus_antes: string | null;
  estatus_nuevo: string | null;
  por_email: string | null;
  en: string;
  detalle: string | null;
  reconstruido: boolean;
};

const ETIQUETA: Record<string, string> = {
  validada: 'Validada',
  devuelta: 'Devuelta al reportante',
  descartada: 'Descartada por el área',
  reabierta: 'Reabierta',
  pasada_op_biobox: 'Pasada a Op. Bio Box',
  area_corregida: 'Área corregida',
  corregida: 'Corregida y reenviada',
  reparada: 'Reparada',
  reparacion_rechazada: 'Reparación rechazada',
  cerrada: 'Reparación aprobada',
  no_reparado: 'No reparado',
  reasignacion_solicitada: 'Reasignación solicitada',
  reasignacion_aprobada: 'Reasignación aprobada',
  reasignacion_rechazada: 'Reasignación rechazada',
  reporte_app_ligado: 'Reporte de la app ligado',
  prevalidada: 'Prevalidada por el área',
};

const ESTATUS_LEGIBLE: Record<string, string> = {
  reportado: 'Reportado',
  por_validar: 'Por validar',
  rechazada: 'Devuelta',
  en_proceso: 'En proceso',
  reparado: 'Reparado',
  cerrada: 'Cerrada',
  no_reparado: 'No reparado',
};

/** Una línea lista para la tarjeta. */
export type LineaHistorial = {
  clave: string;
  titulo: string;
  /** Áreas de la reasignación o motivo del rechazo, si los hay. */
  detalle: string | null;
  en: string;
  por: string | null;
};

/**
 * Del historial crudo a las líneas de la tarjeta, de la más vieja a la más
 * nueva. `por` es la parte del correo antes de la @, como «Capturada … por».
 */
export function lineasHistorial(eventos: readonly EventoHistorial[]): LineaHistorial[] {
  return [...eventos]
    .filter((e) => !!e.en)
    .sort((a, b) => Date.parse(a.en) - Date.parse(b.en))
    .map((e, k) => ({
      clave: `${e.evento}-${e.en}-${k}`,
      // El reporte ligado lleva su folio en el título: «Reporte de la app
      // BBOTR-00437 ligado» (17-nov-2026).
      titulo:
        e.evento === 'reporte_app_ligado' && e.detalle?.trim()
          ? `Reporte de la app ${e.detalle.trim()} ligado`
          : ETIQUETA[e.evento] ||
            `Cambió a ${ESTATUS_LEGIBLE[e.estatus_nuevo || ''] || e.estatus_nuevo || 'otro estatus'}`,
      detalle: e.evento === 'reporte_app_ligado' ? null : e.detalle?.trim() || null,
      en: e.en,
      por: e.por_email ? e.por_email.split('@')[0] : null,
    }));
}
