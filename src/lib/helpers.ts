// ============================================================
// src/lib/helpers.ts
// Funciones utilitarias puras (sin React).
// Traducidas del HTML: slaHoras, slaInfo, distKm, codigoCara,
// caraLabel, initials, fueraHorarioValidador.
// ============================================================

/**
 * Id aleatorio corto (8 hex) para record_id / reassign_id.
 *
 * NO usar crypto.randomUUID() a pelo: solo existe en contextos seguros, y la
 * app también se prueba por http://IP-de-red (npm run dev:http). Ahí el
 * TypeError reventaba la promesa de guardar sin alert y el botón se quedaba
 * en "Guardando…" para siempre. getRandomValues sí existe en http.
 */
export function idCorto(): string {
  // typeof y no `in`: los tipos del DOM juran que randomUUID siempre existe
  // y el narrowing dejaba a crypto en `never` en la rama del fallback.
  if (typeof crypto.randomUUID === 'function')
    return crypto.randomUUID().slice(0, 8);
  const b = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(b, (x: number) => x.toString(16).padStart(2, '0')).join('');
}

// Convierte texto de intervalo ("1 day, 03:00:00" o "5.5") a horas (number).
export function slaHoras(txt: string | number | null): number | null {
  if (txt == null) return null;
  const m = String(txt).match(/(?:(\d+)\s*days?[, ]*)?(\d+):(\d+):(\d+)/);
  if (m) {
    return +(m[1] || 0) * 24 + +m[2] + +m[3] / 60;
  }
  const n = parseFloat(String(txt));
  return isNaN(n) ? null : n;
}

export type SlaInfo = { color: string; label: string };

// Calcula el estado de SLA (en tiempo / por vencer / vencido) dado un inicio y horas.
export function slaInfo(
  inicio: string | number | Date,
  horas: number
): SlaInfo | null {
  if (!inicio || !horas) return null;
  const target = new Date(inicio).getTime() + horas * 3600000;
  const remH = (target - Date.now()) / 3600000;
  const fmt = (h: number) =>
    h >= 1 ? `${Math.round(h)} h` : `${Math.max(1, Math.round(h * 60))} min`;
  if (remH <= 0) return { color: '#ef4444', label: `vencido +${fmt(-remH)}` };
  if (remH / horas <= 0.25)
    return { color: '#f59e0b', label: `por vencer · ${fmt(remH)}` };
  return { color: '#22c55e', label: `en tiempo · ${fmt(remH)}` };
}

// Distancia en km entre dos coordenadas sueltas (haversine con args planos).
export function distKm(
  la1: number,
  lo1: number,
  la2: number,
  lo2: number
): number {
  const R = 6371;
  const r = Math.PI / 180;
  const dla = (la2 - la1) * r;
  const dlo = (lo2 - lo1) * r;
  const a =
    Math.sin(dla / 2) ** 2 +
    Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Código de mueble/cara del VendorFaceID (4º segmento).
export function codigoCara(vfid: string | null): string {
  if (!vfid) return '—';
  const p = String(vfid).split('_');
  return p.length >= 4 ? p[3] : String(vfid);
}

// Sigla de la cara: MX_CM_EV_L05_1-5_3492 -> "L05 1-5".
export function caraLabel(vfid: string | null): string {
  if (!vfid) return '—';
  const p = String(vfid).split('_');
  if (p.length >= 6) return p[3] + ' ' + p[4];
  if (p.length === 5) return p[3];
  return String(vfid);
}

/**
 * Cara de una incidencia PARA MOSTRAR.
 *
 * En las unidades que capturan lado (Vía Verde, Verde Vertical) la cara
 * física del inventario es la columna ("COL") y no orienta a nadie: lo que
 * dice a cuál cara ir es el lado que eligió el reportante (Norte/Sur/Ambas),
 * así que ese manda cuando existe. En el resto de unidades no hay lado y se
 * sigue mostrando la sigla de siempre.
 */
export function caraIncidencia(i: {
  clave_medio?: string | null;
  lado?: string | null;
}): string {
  return i.lado || caraLabel(i.clave_medio ?? null);
}

/**
 * Texto en minúsculas y SIN acentos, para comparar búsquedas.
 *
 * Sin esto, buscar "lampara" no encontraba "Lámpara": había que escribir el
 * acento exacto, que en el teclado del celular casi nadie pone. NFD separa
 * la letra de su acento y el replace tira el acento (rango de diacríticos
 * combinantes). La ñ también se descompone (n + tilde) y queda como "n":
 * para BUSCAR es lo deseable —"dañada" y "danada" se encuentran igual porque
 * las dos puntas pasan por esta misma función—, pero por lo mismo esta
 * función es SOLO para comparar, nunca para mostrar texto.
 */
export function sinAcentos(s: string | null | undefined): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Iniciales de un nombre para el avatar.
export function initials(n: string | null): string {
  return (n || '?')
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

// ============================================================
// Horario del validador
// ============================================================
import { VAL_DIAS, VAL_DESDE, VAL_HASTA } from './constants';

/**
 * ¿Estamos FUERA del horario del validador (Lun–Vie 9:30–18:30 CDMX)?
 *
 * Se evalúa en la zona horaria de la Ciudad de México a propósito: el
 * dispositivo del reportante puede estar en otra zona, y el horario que
 * importa es el del validador. Si algo falla al formatear, devuelve false
 * (= "estamos en horario") para no auto-rutear por error.
 */
export function fueraHorarioValidador(): boolean {
  try {
    const partes = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Mexico_City',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());

    const nombreDia = partes.find((x) => x.type === 'weekday')?.value || '';
    const dia = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as
      Record<string, number>)[nombreDia];
    if (dia === undefined) return false;

    const hora = Number(partes.find((x) => x.type === 'hour')?.value ?? NaN);
    const min = Number(partes.find((x) => x.type === 'minute')?.value ?? NaN);
    if (isNaN(hora) || isNaN(min)) return false;

    // %24 porque en hour12:false la medianoche puede venir como "24".
    const mins = (hora % 24) * 60 + min;
    const dentro = VAL_DIAS.includes(dia) && mins >= VAL_DESDE && mins <= VAL_HASTA;
    return !dentro;
  } catch {
    return false;
  }
}

// ============================================================
// Área efectiva de reparación
// ============================================================

/**
 * Área que REALMENTE va a reparar.
 *
 * `area_responsable` la fija el catálogo de incidencias al reportar, pero
 * seguido el diagnóstico revela que le toca a otra área. En ese caso el
 * validador escribe `assigned_area`, que manda sobre la del catálogo.
 *
 * `area_responsable` se conserva intacta a propósito: es el dato con el que
 * los KPIs miden qué área ORIGINA la carga. `assigned_area` es quién la
 * atiende. No son lo mismo y no deben mezclarse.
 *
 * La RLS ya razona igual: inc_sel_reparacion e inc_upd_reparacion aceptan
 * `area_responsable IN mis_departamentos() OR assigned_area IN mis_departamentos()`.
 */
export function areaEfectiva(i: {
  area_responsable?: string | null;
  assigned_area?: string | null;
}): string {
  return i.assigned_area || i.area_responsable || '';
}

/** ¿La incidencia se redirigió a un área distinta a la del catálogo? */
export function tieneAreaRedirigida(i: {
  area_responsable?: string | null;
  assigned_area?: string | null;
}): boolean {
  return !!i.assigned_area && i.assigned_area !== i.area_responsable;
}


/**
 * Horas entre la validación y la reparación de una incidencia.
 *
 * "Desde que se valida" es `validator_at`, que es cuando el validador apretó
 * Aprobar. Cuando viene en null se cae a `sla_reparacion_inicio`, que es lo
 * que pone el trigger `set_sla` al entrar a 'en_proceso': eso cubre las
 * incidencias de auto-ruteo, que nacen ya en proceso fuera del horario del
 * validador y por eso nunca tuvieron un `validator_at`.
 *
 * Devuelve null cuando no se puede medir —falta alguna de las dos puntas, o
 * el resultado sale negativo por fechas migradas incoherentes—. Null no es
 * cero: significa "esta no cuenta", y quien la promedie tiene que excluirla,
 * no sumarle un 0 que abarataría el promedio.
 */
export function horasValidacionReparacion(i: {
  validator_at?: string | null;
  sla_reparacion_inicio?: string | null;
  repaired_at?: string | null;
}): number | null {
  const inicio = i.validator_at || i.sla_reparacion_inicio;
  if (!inicio || !i.repaired_at) return null;
  const h =
    (new Date(i.repaired_at).getTime() - new Date(inicio).getTime()) / 3600000;
  return h >= 0 ? h : null;
}

/**
 * Horas a texto legible, con minutos.
 *
 * ANTES redondeaba a horas enteras, y todo lo que se resolvía rápido salía
 * como "0 h" — que se lee como "no hay dato", no como "veinte minutos". Justo
 * las reparaciones buenas quedaban invisibles.
 *
 *      12 min  →  "12 min"
 *    1.33 h    →  "1 h 20 min"
 *       5 h    →  "5 h"
 *    47.6 h    →  "1 d 23 h"
 *
 * Todo se calcula sobre MINUTOS TOTALES y de ahí se descompone. Redondear por
 * separado los días y las horas produce cosas como "1 d 24 h": 47.6 h son 1
 * día y 23.6 horas, y ese 23.6 redondeado a 24 debería haber sido otro día.
 */
export function fmtHoras(h: number | null): string {
  if (h == null) return '—';
  const totalMin = Math.round(h * 60);
  if (totalMin < 60) return `${totalMin} min`;

  const totalH = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (totalH < 24) return min ? `${totalH} h ${min} min` : `${totalH} h`;

  const dias = Math.floor(totalH / 24);
  const horas = totalH % 24;
  return horas ? `${dias} d ${horas} h` : `${dias} d`;
}


// ------------------------------------------------------------
// Semanas de lunes a domingo
// ------------------------------------------------------------
/**
 * El mismo ancla que usa el trigger `set_derivados` en la base:
 *
 *     new.semana := floor((d - date '2026-01-05') / 7.0) + 1
 *
 * 2026-01-05 fue lunes, así que la numeración ya corre de lunes a domingo. Se
 * repite aquí a propósito, con la misma fórmula, para que el número que
 * calcula el filtro sea EL MISMO que la columna `semana` que se ve en la
 * tarjeta. Calcularlo distinto —por ejemplo con la semana ISO— daría dos
 * numeraciones que casi siempre coinciden y de vez en cuando no, que es la
 * clase de desacuerdo que nadie alcanza a explicar.
 *
 * Se usa UTC en las dos puntas para que el resultado no cambie con la zona
 * horaria del navegador.
 */
const ANCLA_SEMANA = Date.UTC(2026, 0, 5);
const MS_SEMANA = 7 * 24 * 3600 * 1000;

/** Número de semana de una fecha ISO. null si no hay fecha. */
export function semanaDe(fechaIso: string | null | undefined): number | null {
  if (!fechaIso) return null;
  const [a, m, d] = String(fechaIso).slice(0, 10).split('-').map(Number);
  if (!a || !m || !d) return null;
  return Math.floor((Date.UTC(a, m - 1, d) - ANCLA_SEMANA) / MS_SEMANA) + 1;
}

/** Etiqueta de una semana: "Sem 27 · 29 jun – 5 jul". */
export function etiquetaSemana(num: number): string {
  const ini = new Date(ANCLA_SEMANA + (num - 1) * MS_SEMANA);
  const fin = new Date(ini.getTime() + 6 * 24 * 3600 * 1000);
  const fmt = (x: Date) =>
    x.toLocaleDateString('es-MX', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  return `Sem ${num} · ${fmt(ini)} – ${fmt(fin)}`;
}


/**
 * Horas que una incidencia lleva DETENIDA en 'en_proceso'.
 *
 * El reloj arranca cuando entró al área: `validator_at` si el validador la
 * aprobó, o `sla_reparacion_inicio` —que es lo que pone el trigger `set_sla`—
 * para las de auto-ruteo, que nacen ya en proceso y nunca tuvieron validador.
 *
 * Devuelve null si no está en ese estatus o si no hay de dónde medir. Es una
 * cuenta contra AHORA, así que cambia entre pintados: no sirve para comparar
 * dos capturas de pantalla, sirve para saber qué está atorado hoy.
 *
 * OJO CON LA RELACIÓN CON EL SLA: `set_sla` reinicia `sla_reparacion_inicio`
 * cuando cambia el área estando en proceso. Si una incidencia se reclasificó,
 * este número mide desde ese cambio, no desde la aprobación original —
 * `validator_at`, cuando existe, la protege de eso.
 */
export function horasEnProceso(i: {
  estatus?: string | null;
  validator_at?: string | null;
  sla_reparacion_inicio?: string | null;
}): number | null {
  if (i.estatus !== 'en_proceso') return null;
  const inicio = i.validator_at || i.sla_reparacion_inicio;
  if (!inicio) return null;
  const h = (Date.now() - new Date(inicio).getTime()) / 3600000;
  return h >= 0 ? h : null;
}
