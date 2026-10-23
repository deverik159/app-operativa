// ============================================================
// src/modules/comprobaciones/AvanceComun.tsx
// Piezas chicas que comparten Avance, Mis campañas y el detalle de una
// campaña (23-oct-2026): la barra de avance, el semáforo de la fecha límite
// en palabras de campo y los días cortos («mié 21 oct»). Viven aquí para que
// las tres pantallas digan lo mismo con las mismas palabras.
// ============================================================

import { hoyCdmx, semaforoLimite, type Semaforo } from '../../lib/comprobaciones';
import type { EntregaTipo, VwCampana } from '../../lib/comprobacionesApi';
import { colorTono, fondoTono, type Tono } from '../../lib/tonos';

const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const DIAS_TABLA = ['DO', 'LU', 'MA', 'MI', 'JU', 'VI', 'SA'];
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const ES_DIA = /^\d{4}-\d{2}-\d{2}/;

/** Día de la semana (0 = domingo) de un 'YYYY-MM-DD', leído en UTC para no moverlo; -1 si no sirve. */
export function diaSemanaDe(dia: string | null | undefined): number {
  const d = (dia || '').slice(0, 10);
  if (!ES_DIA.test(d)) return -1;
  const ms = Date.parse(d + 'T00:00:00Z');
  return Number.isNaN(ms) ? -1 : new Date(ms).getUTCDay();
}

/**
 * '2026-10-21' → 'mié 21 oct'. Vacío si no es fecha. Un timestamptz
 * («2026-10-24T01:30:00+00:00», como lo manda PostgREST en UTC) se pasa
 * antes al día de CDMX: si no, lo de después de las 18:00 salía al día
 * siguiente (revisión 2, contrato-5).
 */
export function fechaCorta(dia: string | null | undefined): string {
  const x = dia || '';
  const d = x.length > 10 && x.includes('T') ? hoyCdmx(new Date(x)) || x.slice(0, 10) : x.slice(0, 10);
  const w = diaSemanaDe(d);
  if (w < 0) return '';
  return `${DIAS_CORTOS[w]} ${Number(d.slice(8, 10))} ${MESES_CORTOS[Number(d.slice(5, 7)) - 1] ?? ''}`;
}

/** '2026-10-21' → '21 oct' (sin día de la semana: para vigencias «del 1 al 15 oct»). */
export function diaMes(dia: string | null | undefined): string {
  const d = (dia || '').slice(0, 10);
  if (!ES_DIA.test(d)) return '';
  return `${Number(d.slice(8, 10))} ${MESES_CORTOS[Number(d.slice(5, 7)) - 1] ?? ''}`;
}

/** Encabezado de la tabla diaria: 'LU' y '03' en dos renglones. */
export function cabezaDia(dia: string): { sem: string; num: string; finde: boolean } {
  const w = diaSemanaDe(dia);
  return { sem: w < 0 ? '' : DIAS_TABLA[w], num: dia.slice(8, 10), finde: w === 0 || w === 6 };
}

/** «del 1 al 15 oct» / «desde 3 oct» / '' si no hay vigencia. */
export function vigenciaTexto(inicio: string | null | undefined, fin: string | null | undefined): string {
  const a = diaMes(inicio);
  const b = diaMes(fin);
  if (a && b) return a === b ? `el ${a}` : `del ${a} al ${b}`;
  if (a) return `desde el ${a}`;
  if (b) return `hasta el ${b}`;
  return '';
}

/** Número con separador de miles de México (1,437). */
export const nf = (n: number | null | undefined) => (Number.isFinite(n as number) ? (n as number).toLocaleString('es-MX') : '0');

/** % redondeado para la barra (0 a 100; puede pasar de 100 en el texto, no en la barra). */
export const pctBarra = (pct: number | null | undefined) => Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));

const TONO_SEMAFORO: Record<Semaforo, Tono> = { verde: 'verde', gris: 'gris', ambar: 'ambar', rojo: 'rojo' };

/** Lo que sigue de una campaña abierta que ya no tiene nada que marcar. */
export const TEXTO_SIN_POR_COMPROBAR = 'Sin sitios por comprobar';

/**
 * ¿Abierta, viva, sin llegar a la meta y SIN nada que la analista pueda
 * marcar? (revisión de pantallas, 23-oct-2026). Pasa con todos los sitios
 * cancelados (meta 0: la vista nunca la da por completa) o con una meta a
 * mano mayor que los sitios. No cuenta como pendiente ni vencida: solo le
 * queda al Supervisor cerrarla. El FULL de Vía Verde sí tiene qué hacer:
 * agregar columnas.
 */
export function sinPorComprobar(
  c: Pick<VwCampana, 'estatus' | 'retirada' | 'completa' | 'pendientes' | 'es_full' | 'unidad'>
): boolean {
  return (
    c.estatus === 'abierta' &&
    !c.retirada &&
    !c.completa &&
    (c.pendientes || 0) === 0 &&
    !(c.es_full && c.unidad === 'Vía Verde')
  );
}

type FilaLimite = Pick<
  VwCampana,
  'dias_restantes' | 'completa' | 'estatus' | 'fecha_limite_efectiva' | 'retirada' | 'pendientes' | 'es_full' | 'unidad'
>;

/**
 * Fecha límite en palabras («vence hoy», «vence en 2 días», «venció hace 3
 * días») con su color. Usa semaforoLimite del núcleo con el estatus, para
 * que una cerrada no se pinte de rojo para siempre. Es el ÚNICO texto de la
 * fecha límite: lo usan Mis campañas, el detalle y Campañas (23-oct-2026).
 */
export function limiteDe(c: FilaLimite): {
  texto: string;
  tono: Tono;
  semaforo: Semaforo;
} {
  const nada = sinPorComprobar(c);
  const semaforo = nada ? 'gris' : semaforoLimite(c.dias_restantes, !!c.completa, c.estatus);
  const tono = TONO_SEMAFORO[semaforo];
  const d = c.dias_restantes;
  const f = fechaCorta(c.fecha_limite_efectiva);
  let texto: string;
  if (c.estatus === 'cerrada') texto = 'Cerrada';
  else if (c.completa) texto = 'Completa';
  else if (nada) texto = TEXTO_SIN_POR_COMPROBAR;
  else if (d == null) texto = 'Sin fecha límite';
  else if (d < 0) texto = `Venció hace ${-d} ${-d === 1 ? 'día' : 'días'}`;
  else if (d === 0) texto = 'Vence hoy';
  else if (d === 1) texto = 'Vence mañana';
  else texto = `Vence en ${d} días`;
  if (f && c.estatus !== 'cerrada') texto += ` · ${f}`;
  return { texto, tono, semaforo };
}

/** Pastilla de la fecha límite con su color (se lee en los dos temas). */
export function PildoraLimite({ c, title }: { c: FilaLimite; title?: string }) {
  const l = limiteDe(c);
  return (
    <span className="pill multilinea" title={title} style={{ color: colorTono(l.tono), background: fondoTono(l.tono) }}>
      {l.texto}
    </span>
  );
}

/** Cómo se entrega (comp_campanas.entrega_tipo) en palabras; null si es lo normal (enviar). */
export function textoEntrega(e: EntregaTipo | null | undefined): string | null {
  if (e === 'lista_sin_enviar') return 'Tener lista, no enviar';
  if (e === 'no_se_comprueba') return 'No se comprueba';
  return null;
}

/** Barra de avance (la de FilaBarra de IndicadoresPauta), sola. */
export function Barra({ pct, tono = 'verde', alto = 8 }: { pct: number | null | undefined; tono?: Tono; alto?: number }) {
  return (
    <div
      style={{ height: alto, background: 'var(--panel2)', borderRadius: alto / 2, overflow: 'hidden', border: '1px solid var(--line)' }}
      aria-hidden="true"
    >
      <div style={{ width: `${pctBarra(pct)}%`, height: '100%', background: colorTono(tono), transition: 'width .3s' }} />
    </div>
  );
}

/** «12/17 · 71 %» (o «12 comprobados · sin meta»). */
export function textoAvance(comprobados: number, meta: number, pct: number | null | undefined): string {
  if (!meta) return `${nf(comprobados)} comprobados · sin meta`;
  return `${nf(comprobados)}/${nf(meta)} · ${pct == null ? 0 : pct} %`;
}
