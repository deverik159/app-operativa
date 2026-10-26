// ============================================================
// src/lib/franjaHorario.ts
// ¿La hora de ahora cae en la franja de la toma? Comprobaciones, fase 3
// (26-oct-2026). PURA; la prueba tests/franjaHorario.test.mjs.
//
// QUÉ LEE. comp_tomas.horario_texto tal como lo guardó la carga:
//   · «24 HORAS» (o «24 hrs», «24h») o vacío = siempre;
//   · franjas «HH:MM–HH:MM» separadas por «/» (también «,», «;», «|» o
//     « y »); el guion puede ser «-», «–», «—», « a » o « al ». Acepta
//     «7:01 pm a 6:59 am», «de 7 a 10» y franjas que cruzan la medianoche.
// Si una parte no se entiende, todo el texto queda «ilegible»: se enseña tal
// cual y sin color (mejor no decir «fuera de franja» por un texto raro).
//
// SOLO AVISA (Erik, 26-oct-2026; especificación §6.1): verde «en franja» o
// ámbar «fuera de franja». Nunca bloquea una toma.
//
// La hora es la de CDMX (minutosCdmx), no la del teléfono: un teléfono con
// otra zona no debe cambiar el aviso. Los bordes cuentan como dentro, al
// minuto: «07:00-09:59» incluye las 09:59 y no las 10:00.
// ============================================================

/** Minutos desde la medianoche: 0 … 1440 (24:00 = fin del día). */
export type Franja = { ini: number; fin: number };

export type LecturaFranja =
  | { tipo: 'siempre' }
  | { tipo: 'franjas'; franjas: Franja[] }
  | { tipo: 'ilegible'; texto: string };

export type EstadoFranja = 'siempre' | 'dentro' | 'fuera' | 'ilegible';

/** Sin acentos, minúsculas, espacios simples y «a. m.» → «am». */
function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ /g, ' ')
    .replace(/\ba\.?\s?m\.?(?=\s|$|[-–—/,;|])/g, 'am')
    .replace(/\bp\.?\s?m\.?(?=\s|$|[-–—/,;|])/g, 'pm')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ¿Dice «24 horas» (o «todo el día»)? */
function diceSiempre(s: string): boolean {
  return /^(24\s*(horas?|hrs?|h|x\s*7)?|todo el dia|las 24 horas)\.?$/.test(s);
}

/** «7», «07:00», «7.30», «7:01 pm», «14:00 hrs» → minutos; null si no es hora. */
function leerHora(s: string): number | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:hrs?|h)?$/.exec(s.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59 || h > 24) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
  }
  if (h === 24 && min > 0) return null;
  return h * 60 + min;
}

/** Lee el horario de una toma. Nunca lanza. */
export function leerFranjas(texto: string | null | undefined): LecturaFranja {
  const crudo = typeof texto === 'string' ? texto.trim() : '';
  if (!crudo) return { tipo: 'siempre' };
  const s = normalizar(crudo);
  if (diceSiempre(s)) return { tipo: 'siempre' };
  const partes = s
    .split(/\s*(?:\/|,|;|\||\by\b)\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!partes.length) return { tipo: 'ilegible', texto: crudo };
  const franjas: Franja[] = [];
  for (const crudoParte of partes) {
    // «de 7 a 10», «desde las 7 hasta las 10».
    const parte = crudoParte.replace(/^(de|desde)\s+(las\s+)?/, '').replace(/\b(hasta|a|al)\s+las\s+/, '$1 ');
    const lados = parte.split(/\s*(?:-|–|—|\ba\b|\bal\b|\bhasta\b)\s*/).filter((x) => x.trim() !== '');
    if (lados.length !== 2) return { tipo: 'ilegible', texto: crudo };
    const ini = leerHora(lados[0]);
    const fin = leerHora(lados[1]);
    if (ini === null || fin === null || ini === fin) return { tipo: 'ilegible', texto: crudo };
    franjas.push({ ini, fin });
  }
  return { tipo: 'franjas', franjas };
}

/** ¿El minuto cae en la franja? Con ini > fin la franja cruza la medianoche. */
export function enFranja(f: Franja, minuto: number): boolean {
  if (f.ini <= f.fin) return minuto >= f.ini && minuto <= f.fin;
  return minuto >= f.ini || minuto <= f.fin;
}

const dos = (n: number) => String(n).padStart(2, '0');

/** 425 → «07:05»; 1440 → «24:00». */
export function textoMinuto(m: number): string {
  return `${dos(Math.floor(m / 60))}:${dos(m % 60)}`;
}

/** «07:00–09:59 / 14:00–14:59». */
export function textoFranjas(franjas: readonly Franja[]): string {
  return franjas.map((f) => `${textoMinuto(f.ini)}–${textoMinuto(f.fin)}`).join(' / ');
}

/**
 * Estado del horario a una hora dada (minutos CDMX). `minuto` null (no se
 * pudo saber la hora) = 'ilegible' para las franjas: no se pinta color.
 */
export function estadoFranja(
  texto: string | null | undefined,
  minuto: number | null
): { estado: EstadoFranja; texto: string } {
  const l = leerFranjas(texto);
  if (l.tipo === 'siempre') return { estado: 'siempre', texto: '24 horas' };
  if (l.tipo === 'ilegible') return { estado: 'ilegible', texto: l.texto };
  const t = textoFranjas(l.franjas);
  if (minuto === null) return { estado: 'ilegible', texto: t };
  return { estado: l.franjas.some((f) => enFranja(f, minuto)) ? 'dentro' : 'fuera', texto: t };
}

/** Uno solo, creado al primer uso (en iPhone crear un Intl con zona es caro). */
let formato: Intl.DateTimeFormat | null = null;

/** Minutos desde la medianoche en CDMX; null si el teléfono no conoce la zona. */
export function minutosCdmx(ahora: Date = new Date()): number | null {
  try {
    if (!formato)
      formato = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Mexico_City',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    const partes = formato.formatToParts(ahora);
    const h = Number(partes.find((x) => x.type === 'hour')?.value);
    const m = Number(partes.find((x) => x.type === 'minute')?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return (h % 24) * 60 + m;
  } catch {
    return null;
  }
}
