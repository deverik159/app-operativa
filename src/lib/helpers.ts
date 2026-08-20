// ============================================================
// src/lib/helpers.ts
// Funciones utilitarias puras (sin React).
// Traducidas del HTML: slaHoras, slaInfo, distKm, codigoCara,
// caraLabel, initials, fueraHorarioValidador.
// ============================================================

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
