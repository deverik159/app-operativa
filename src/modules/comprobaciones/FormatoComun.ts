// ============================================================
// src/modules/comprobaciones/FormatoComun.ts
// Ayudantes de la pestaña Formato (Formato general) y sus ventanas
// (Erik, 23-oct-2026). Sin React: fechas cortas, vigencia del sitio,
// el ESTATUS que se enseña y qué se puede hacer con cada toma.
//
// Lo que decide si una toma se puede editar o quitar es la base
// (comp_editar_tomas, comp_quitar_tomas); aquí solo se esconde el botón
// para no ofrecer algo que la base va a rechazar.
// ============================================================

import { diaIso, ventanasToma, type Ventana } from '../../lib/comprobaciones';
import { estatusToma } from '../../lib/excelComp';
import type { Tono } from '../../lib/tonos';
import type { VwCampana, VwToma } from '../../lib/comprobacionesApi';

const DIAS_SEMANA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** '03/08' de un 'YYYY-MM-DD' ('' si no se entiende). */
export function ddmm(dia: string | null | undefined): string {
  const d = diaIso(dia);
  return d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '';
}

/** 'lun 03/08'. El día ya es de CDMX: se lee en UTC para no moverlo. */
export function fechaCorta(dia: string | null | undefined): string {
  const d = diaIso(dia);
  if (!d) return '';
  return `${DIAS_SEMANA[new Date(d + 'T00:00:00Z').getUTCDay()]} ${ddmm(d)}`;
}

/** ¿Sábado o domingo? */
export function esFinde(dia: string): boolean {
  const d = diaIso(dia);
  if (!d) return false;
  const n = new Date(d + 'T00:00:00Z').getUTCDay();
  return n === 0 || n === 6;
}

/**
 * Ventanas de toma del sitio de esta toma (espejo de comp_ventanas): la
 * vigencia del sitio (o sus tramos) recortada por la de la campaña y la del
 * periodo. Sin la campaña a la mano se recorta solo con el periodo.
 */
export function ventanasDe(
  sitio: { inicio?: string | null; fin?: string | null; tramos?: { inicio: string | null; fin: string | null }[] | null },
  campana: Pick<VwCampana, 'inicio' | 'fin'> | null | undefined,
  periodo: { inicio: string; fin: string }
): Ventana[] {
  return ventanasToma(sitio, campana ?? null, periodo);
}

/** Las ventanas de una fila de vw_comp_tomas. */
export function ventanasDeToma(
  t: Pick<VwToma, 'sitio_inicio' | 'sitio_fin' | 'sitio_tramos'>,
  campana: Pick<VwCampana, 'inicio' | 'fin'> | null | undefined,
  periodo: { inicio: string; fin: string }
): Ventana[] {
  return ventanasDe({ inicio: t.sitio_inicio, fin: t.sitio_fin, tramos: t.sitio_tramos }, campana, periodo);
}

export function dentroDe(dia: string | null | undefined, vs: Ventana[]): boolean {
  const d = diaIso(dia);
  return !!d && vs.some((v) => d >= v.inicio && d <= v.fin);
}

/** 'del 03/08 al 10/08, del 15/08 al 20/08' (como lo dice la base al rechazar). */
export function textoVentanas(vs: Ventana[]): string {
  if (!vs.length) return 'no corre en este periodo';
  return vs.map((v) => (v.inicio === v.fin ? `el ${ddmm(v.inicio)}` : `del ${ddmm(v.inicio)} al ${ddmm(v.fin)}`)).join(', ');
}

const TONO_ESTATUS: Record<string, Tono> = {
  QUITADA: 'gris',
  COMPROBADA: 'verde',
  CERRADA: 'morado',
  'SITIO COMPROBADO': 'verde',
  'POR REVISAR': 'azul',
  REGRESADA: 'ambar',
};

/**
 * ESTATUS de la toma con el MISMO texto que lleva el Excel (estatusToma),
 * para que la pantalla y el archivo digan lo mismo. Una quitada por el
 * sistema (su sitio salió del plan) dice «BAJA AUTOMÁTICA»: Victor no la
 * quitó y no la puede regresar desde aquí.
 */
export function estatusPantalla(t: VwToma): { texto: string; tono: Tono } | null {
  if (t.estado === 'cancelada' && t.baja_auto) return { texto: 'BAJA AUTOMÁTICA', tono: 'gris' };
  const e = estatusToma(t);
  if (!e) return null;
  return { texto: e, tono: TONO_ESTATUS[e] ?? 'gris' };
}

/** Se edita o se quita: pendiente y de una campaña abierta (lo que acepta la base). */
export function sePuedeEditar(t: VwToma): boolean {
  return t.estado === 'pendiente' && t.campana_estatus === 'abierta' && !t.campana_retirada;
}

/**
 * Se regresa: la quitó alguien a mano (no baja_auto), su campaña sigue
 * abierta y su sitio sigue en el plan. comp_quitar_tomas no regresa las de
 * un sitio cancelado, fuera de la carga o de una campaña retirada.
 */
export function sePuedeRegresar(t: VwToma): boolean {
  return (
    t.estado === 'cancelada' &&
    !t.baja_auto &&
    t.campana_estatus === 'abierta' &&
    !t.campana_retirada &&
    t.sitio_estado !== 'cancelado' &&
    !t.sitio_fuera_de_carga
  );
}

/** 'CAMPAÑA / V1' (o la base sola). */
export function nombreCampana(c: { campana: string; version?: string | null }): string {
  const v = (c.version || '').trim();
  return v ? `${c.campana} / ${v}` : c.campana;
}

/** «1 toma» / «3 tomas». */
export const nTomas = (n: number) => `${n.toLocaleString('es-MX')} ${n === 1 ? 'toma' : 'tomas'}`;
