// ============================================================
// src/lib/contratoComp.ts
// Contrato de comp_cargar_campanas, en UN solo lugar (23-oct-2026).
//
// POR QUÉ. Los tipos del p_campanas vivían dentro de bitacoraComp.ts y las
// otras piezas (pantalla, Excel, pruebas de la SQL) los iban a copiar. Aquí
// queda la única definición; bitacoraComp.ts los vuelve a exportar para no
// romper los imports que ya existen. Si el contrato cambia, cambia aquí y en
// el comentario de comp_cargar_campanas (supabase/migrations/…_comp_base.sql).
//
// Lo que NO es contrato (los planes sugeridos que salen del encabezado de la
// bitácora) va aparte: la pantalla los aplica con comp_generar_tomas después
// de cargar, y Victor los confirma.
// ============================================================

import { llaveComp, type PlanTomas } from './comprobaciones';

export type FuenteComp = 'bitacora' | 'pauta_vv' | 'plano' | 'manual';
/** La base solo guarda VENTA o BONUS; INTERCAMBIO, EXCLUSIVA o CORTESÍA van en observaciones. */
export type TipoVenta = 'VENTA' | 'BONUS';

export type SitioContrato = {
  /** Con la forma de inventario.vendor_face_id (MX_CM_VV_COL_856, MX_CM_BB_MED_0114). */
  sitio_clave: string;
  /** Como venía en el archivo o en la base ('856', 'MX_CM_BB_MED_ 0114'). */
  sitio_original: string;
  /** Vía Verde: la clave de vv_espacios ('856', 'POR_0008'); en lo demás null. */
  espacio_vv: string | null;
  inicio: string | null;
  fin: string | null;
  horario_lv: string | null;
  horario_sd: string | null;
  tipo_venta: TipoVenta | null;
  testigos: boolean | null;
  observaciones: string | null;
};

export type CampanaContrato = {
  fuente: FuenteComp;
  /** Bitácora: 'archivo · hoja'; Pauta VV: id de vv_campanas; plano: 'plano AAAA-MM'. */
  origen_ref: string | null;
  cliente: string | null;
  campana: string;
  version: string;
  vendedor: string | null;
  administrador: string | null;
  quantum: string | null;
  mediamonitor: boolean | null;
  especificacion: string | null;
  arte: 'NUEVO' | 'REPITE' | null;
  inicio: string | null;
  fin: string | null;
  es_full: boolean;
  full_minutos: number | null;
  /**
   * PROPUESTA de analista: la base solo la usa si la campaña es nueva o si
   * su analista también vino de archivo; nunca pisa la asignada en la app.
   */
  analista_email: string | null;
  sitios: SitioContrato[];
};

/** Periodo del contrato; inicio/fin hacen falta en catorcena (el calendario vive en la base). */
export type PeriodoBit = { tipo: 'catorcena' | 'mes'; anio: number; numero: number; inicio?: string | null; fin?: string | null };

/**
 * Llave de una entrada del contrato dentro de un periodo y medio: la misma
 * que usa la base, (comp_llave(campana), comp_llave(version)). Sirve para
 * cruzar los planes sugeridos con las campañas ya cargadas (comp_campanas
 * trae campana_llave y version_llave).
 */
export function llaveContrato(c: { campana: string | null | undefined; version: string | null | undefined }): string {
  return `${llaveComp(c.campana)}|${llaveComp(c.version)}`;
}

/**
 * Plan de tomas que PROPONE la bitácora (Biobox: «COMPROBACIÓN: MENSUAL /
 * CATORCENAL», 23-oct-2026). No es parte del contrato: la pantalla lo
 * muestra, Victor lo confirma y se aplica con comp_generar_tomas.
 */
export type PlanSugerido = {
  plan: PlanTomas;
  /** Lo que decía el encabezado, tal cual ('MENSUAL', 'TESTIGS CATORCENALES'). */
  comprobacion: string;
  /** Cómo se leyó, para mostrarlo junto al plan. */
  lectura: string;
  /** Hoja(s) de donde salió. */
  hojas: string[];
  /** Siempre true hasta que Erik/Victor confirmen la lectura. */
  porConfirmar: boolean;
};
