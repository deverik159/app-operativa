// ============================================================
// src/lib/reportesAppBiobox.ts
// Reportes de la app Biobox (9-nov-2026; ficha reportes-app-biobox del
// contexto). Los reportes que los usuarios finales levantan en la app de
// Biobox llegan cada 20 min a una bandeja APARTE (tabla biobox_app_reportes,
// la llena la PC con VPN). La validadora los clasifica con nuestro catálogo,
// los liga a una incidencia abierta o los descarta; los de puntos entran
// directo a TI. Cuando la incidencia se cierra (o, si lo marca el técnico,
// cuando la repara) toca marcar «Atendido» en el Webadmin, y el sync lo
// detecta solo.
//
// Aquí vive solo la lógica pura (sin red), para poder probarla.
// ============================================================

export type DecisionReporte =
  | 'clasificado'
  | 'ligado'
  | 'directo'
  | 'descartado'
  | 'atendido_en_webadmin';

export type ReporteAppBiobox = {
  report_id: number;
  folio_app: string | null;
  unidad_negocio: string;
  pais: string | null;
  caso_id: number | null;
  motivo: string | null;
  tipo: string | null;
  descripcion: string | null;
  codigo_maquina: string | null;
  nombre_maquina: string | null;
  clave_inventario: string | null;
  evidencia_url: string | null;
  fecha_reporte_core: string | null;
  estatus_core: number | null;
  estatus_core_nombre: string | null;
  etiqueta: string | null;
  presente: boolean;
  primera_vez: string;
  estatus_cambio_en: string | null;
  atendido_core_en: string | null;
  decision: DecisionReporte | null;
  record_id: string | null;
  marca_atendido: 'validador' | 'tecnico' | null;
  decidido_por: string | null;
  decidido_en: string | null;
  motivo_descarte: string | null;
};

/** Lo que la bandeja necesita de la incidencia ligada. */
export type IncLigada = {
  record_id: string;
  folio: string | null;
  estatus: string;
  nombre_incidencia: string | null;
  area_responsable: string | null;
  assigned_area: string | null;
  repaired_by_email: string | null;
};

export type Equivalencia = {
  unidad_negocio: string;
  caso_id: number;
  catalogo_detalle: string;
  etiqueta: string | null;
  directo_al_area: boolean;
  marca_atendido: 'validador' | 'tecnico';
  activo: boolean;
};

type FilaRol = { rol: string; unidad_negocio: string | null; departamento?: string | null };

export const UNIDADES_APP_BIOBOX = ['Biobox', 'Biobox Perú'] as const;

const igual = (a: string | null | undefined, b: string | null | undefined) =>
  (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

const sinUnidad = (u: string | null | undefined) => !(u || '').trim();

/** Técnico de TI: ve la bandeja solo para consulta (Erik, 9-nov-2026). */
const esTecnicoTi = (r: FilaRol) => r.rol === 'reparacion' && igual(r.departamento, 'TI');

/** Roles que ven la bandeja de su unidad, o de todas si no tienen unidad. */
const vePorUnidad = (r: FilaRol) => r.rol === 'coordinador' || r.rol === 'viewer' || esTecnicoTi(r);

/**
 * ¿Abre la bandeja? Espejo de `biobox_app_ve_bandeja()` en la base
 * (migración 20261109201008, Erik, 9-nov-2026):
 *  · manager;
 *  · validador DE Biobox o Biobox Perú (sin unidad no cuenta, como en
 *    inc_sel_validador);
 *  · coordinador, Consulta (viewer) o técnico de TI de Biobox o Biobox Perú,
 *    o sin unidad (= todas). Consulta de otra unidad (p. ej. Ecovallas) ya no.
 * Solo la validadora y el manager actúan: ver `atiendeUnidad`.
 */
export function abreReportesAppBiobox(roles: readonly FilaRol[]): boolean {
  return unidadesBandeja(roles).length > 0;
}

/** Unidades cuya bandeja puede VER (en el orden de UNIDADES_APP_BIOBOX). */
export function unidadesBandeja(roles: readonly FilaRol[]): string[] {
  const todas = roles.some(
    (r) => r.rol === 'manager' || (vePorUnidad(r) && sinUnidad(r.unidad_negocio))
  );
  return UNIDADES_APP_BIOBOX.filter(
    (u) =>
      todas ||
      roles.some(
        (r) => (r.rol === 'validador' || vePorUnidad(r)) && igual(r.unidad_negocio, u)
      )
  );
}

/**
 * ¿Puede clasificar, ligar o descartar en esa unidad? Espejo de
 * `biobox_app_exige_validador()`: validador DE ESA unidad (no sin unidad) o
 * manager. El coordinador y el viewer solo consultan.
 */
export function atiendeUnidad(roles: readonly FilaRol[], unidad: string): boolean {
  return roles.some(
    (r) => r.rol === 'manager' || (r.rol === 'validador' && igual(r.unidad_negocio, unidad))
  );
}

const ABIERTA = new Set(['por_validar', 'en_proceso', 'reparado', 'rechazada']);
const EN_FLUJO = new Set<DecisionReporte>(['clasificado', 'ligado', 'directo']);

/**
 * ¿Toca marcar «Atendido» en el Webadmin? Igual que el aviso de la base
 * (notificar_webadmin_atendido): ligado a una incidencia, Biobox todavía no
 * dice Atendido, y la incidencia ya está cerrada (lo marca la validadora) o
 * ya está reparada o cerrada (lo marca el técnico).
 */
export function pideMarcarAtendido(r: ReporteAppBiobox, inc: IncLigada | undefined): boolean {
  if (!r.decision || !EN_FLUJO.has(r.decision) || !inc || r.estatus_core === 3) return false;
  if (r.marca_atendido === 'tecnico') return inc.estatus === 'reparado' || inc.estatus === 'cerrada';
  return inc.estatus === 'cerrada';
}

export type EstadoBandeja =
  | 'por_clasificar'
  | 'en_proceso'
  | 'marcar_atendido'
  | 'terminado'
  | 'descartado';

/** En qué pestaña de la bandeja cae cada reporte. */
export function estadoBandeja(r: ReporteAppBiobox, inc: IncLigada | undefined): EstadoBandeja {
  if (r.decision === 'descartado') return 'descartado';
  if (!r.decision) return 'por_clasificar';
  if (r.decision === 'atendido_en_webadmin') return 'terminado';
  if (pideMarcarAtendido(r, inc)) return 'marcar_atendido';
  if (r.estatus_core === 3 && (!inc || !ABIERTA.has(inc.estatus))) return 'terminado';
  return 'en_proceso';
}

export const ETIQUETA_ESTADO: Record<EstadoBandeja, string> = {
  por_clasificar: 'Por clasificar',
  en_proceso: 'En proceso',
  marcar_atendido: 'Marcar Atendido',
  terminado: 'Terminados',
  descartado: 'Descartados',
};

/** Estatus de la app Biobox tal como lo ve el usuario final. */
export function textoEstatusCore(r: Pick<ReporteAppBiobox, 'estatus_core' | 'estatus_core_nombre'>): string {
  if (r.estatus_core === 1) return 'Abierto';
  if (r.estatus_core === 2) return 'En atención';
  if (r.estatus_core === 3) return 'Atendido';
  return (r.estatus_core_nombre || '').trim() || 'Sin estatus';
}

/** Desfase que vale la pena enseñar: Biobox ya dice Atendido y aquí sigue abierta. */
export function desfase(r: ReporteAppBiobox, inc: IncLigada | undefined): string | null {
  if (r.estatus_core === 3 && inc && ABIERTA.has(inc.estatus))
    return 'En la app Biobox ya dice «Atendido», pero la incidencia sigue abierta aquí.';
  return null;
}

/** La equivalencia activa de un reporte (o null). */
export function equivalenciaDe(
  r: Pick<ReporteAppBiobox, 'unidad_negocio' | 'caso_id'>,
  equivalencias: readonly Equivalencia[]
): Equivalencia | null {
  return (
    equivalencias.find(
      (e) => e.activo && e.caso_id === r.caso_id && igual(e.unidad_negocio, r.unidad_negocio)
    ) || null
  );
}

/**
 * Error de las funciones de la base en palabras del usuario. Un DUPLICADO
 * trae el folio de la incidencia abierta: la pantalla ofrece ligarlo.
 */
export function leerErrorBandeja(mensaje: string): { texto: string; folioDuplicado: string | null } {
  const dup = /DUPLICADO:\s*([A-Z0-9]+)/.exec(mensaje || '');
  if (dup)
    return {
      texto: `Esa misma falla ya está abierta en esta máquina con el folio ${dup[1]}. Liga el reporte a ese folio en vez de crear otro.`,
      folioDuplicado: dup[1],
    };
  return { texto: (mensaje || 'No se pudo guardar.').replace(/^ERROR:\s*/, ''), folioDuplicado: null };
}

/**
 * La fecha del reporte llega como texto de la base de Biobox
 * ('2026-11-09 18:25:09'), y esa base trabaja en UTC: el monitor registra
 * session_timezone y system_timezone = UTC (verificado el 9-nov-2026; Erik
 * vio BBMAQ-00369 «a las 18:25» cuando se levantó a las 12:25 de CDMX).
 * Devuelve el instante en ISO (UTC) para pintarlo en hora de CDMX, o null si
 * el texto no tiene esa forma (entonces se enseña tal cual).
 */
export function fechaCoreAIso(texto: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?$/.exec((texto || '').trim());
  if (!m) return null;
  const iso = `${m[1]}T${m[2].length === 5 ? m[2] + ':00' : m[2]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** Minutos desde la última carga del sync (null si nunca ha cargado). */
export function minutosDesde(iso: string | null | undefined, ahora: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((ahora - t) / 60000));
}

/** La carga es cada 20 min: pasada 1 hora sin datos, se avisa. */
export const MINUTOS_SYNC_ATRASADO = 60;

/** Busca por folio de la app, folio nuestro, máquina, motivo o descripción. */
export function coincideBusqueda(
  r: ReporteAppBiobox,
  inc: IncLigada | undefined,
  texto: string
): boolean {
  const norm = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const partes = norm(texto).split(/\s+/).filter(Boolean);
  if (!partes.length) return true;
  const pajar = norm(
    [
      r.folio_app,
      String(r.report_id),
      r.codigo_maquina,
      r.nombre_maquina,
      r.clave_inventario,
      r.motivo,
      r.etiqueta,
      r.descripcion,
      inc?.folio,
      inc?.nombre_incidencia,
    ]
      .filter(Boolean)
      .join(' ')
  );
  return partes.every((p) => pajar.includes(p));
}
