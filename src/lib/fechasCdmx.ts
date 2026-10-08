// ============================================================
// src/lib/fechasCdmx.ts
// El "día" de una marca de tiempo en la hora de la Ciudad de México.
//
// Las fechas se guardan en UTC. Tomar los primeros 10 caracteres del ISO da
// el día UTC: lo reportado después de las 18:00 de México contaba como del
// día siguiente en el filtro Desde/Hasta, en la semana de KPIs y en el CSV
// (8-oct-2026). Se usa la zona de CDMX y no la del teléfono, igual que el
// horario del validador (helpers.ts): el día de una incidencia no debe
// cambiar según quién la mire.
// ============================================================

const ZONA = 'America/Mexico_City';

/** Uno solo, creado al primer uso: en iPhone crear un Intl con zona es caro. */
let formato: Intl.DateTimeFormat | null = null;

/** Año, mes, día, hora y minuto civiles de CDMX, o null si no se pudo. */
function partesCdmx(ms: number): number[] | null {
  try {
    if (!formato)
      formato = new Intl.DateTimeFormat('en-US', {
        timeZone: ZONA,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    const p = formato.formatToParts(new Date(ms));
    const v = (t: Intl.DateTimeFormatPartTypes) =>
      Number(p.find((x) => x.type === t)?.value ?? NaN);
    const r = [v('year'), v('month'), v('day'), v('hour'), v('minute')];
    return r.some(Number.isNaN) ? null : r;
  } catch {
    return null;
  }
}

const dos = (n: number) => String(n).padStart(2, '0');

/** El filtro de la lista lo pide por cada incidencia en cada tecla. */
const memoDia = new Map<string, string>();

/**
 * 'YYYY-MM-DD' del día en CDMX de una marca ISO (o Date). Si el teléfono no
 * conoce la zona, cae al día UTC, como antes.
 */
export function diaCdmx(fecha: string | Date): string {
  if (typeof fecha !== 'string') return calcularDia(fecha);
  let d = memoDia.get(fecha);
  if (d === undefined) {
    if (memoDia.size > 20000) memoDia.clear();
    d = calcularDia(fecha);
    memoDia.set(fecha, d);
  }
  return d;
}

function calcularDia(fecha: string | Date): string {
  const ms = typeof fecha === 'string' ? Date.parse(fecha) : fecha.getTime();
  if (Number.isNaN(ms)) return typeof fecha === 'string' ? fecha.slice(0, 10) : '';
  const p = partesCdmx(ms);
  if (!p) return new Date(ms).toISOString().slice(0, 10);
  return `${p[0]}-${dos(p[1])}-${dos(p[2])}`;
}

/** 'YYYY-MM-DD HH:mm' en CDMX, para el Excel/CSV. Vacío si no hay fecha. */
export function fechaHoraCdmx(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const p = partesCdmx(ms);
  if (!p) return iso;
  return `${p[0]}-${dos(p[1])}-${dos(p[2])} ${dos(p[3])}:${dos(p[4])}`;
}

/**
 * Instante (ms) en que EMPIEZA en CDMX un día 'YYYY-MM-DD', o null si no es
 * una fecha completa y creíble (el input date de escritorio emite el año a
 * medio teclear: 0002, 0020…). México no tiene horario de verano desde
 * oct-2022, pero el desfase se mide con Intl por si eso cambia.
 */
export function inicioDiaCdmx(dia: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || Number(dia.slice(0, 4)) < 2000) return null;
  const medianocheUtc = Date.parse(dia + 'T00:00:00Z');
  if (Number.isNaN(medianocheUtc)) return null;
  // Lo que marca el reloj de CDMX en la medianoche UTC de ese día da el
  // desfase; con él se ubica la medianoche de CDMX.
  const p = partesCdmx(medianocheUtc);
  if (!p) return medianocheUtc;
  const relojCdmx = Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4]);
  return medianocheUtc + (medianocheUtc - relojCdmx);
}
