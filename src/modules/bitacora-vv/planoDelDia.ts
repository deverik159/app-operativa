// ============================================================
// src/modules/bitacora-vv/planoDelDia.ts
// Leer el plano de columnas (vv_ocupacion) desde la Bitácora.
//
// Lo usan Disponibilidad (un rango de fechas, o el plano de un mes para
// Ocupación) y «Hoy al aire» (lo que el plano pone al aire en UNA fecha,
// cruzado con las campañas de la Bitácora; Erik, 19-oct-2026). Lee por
// páginas: PostgREST entrega de a 1,000 filas y un plano trae miles.
// ============================================================
import { sb } from '../../lib/supabase';
import { activaEn, cuenta, type LineaOcup } from '../../lib/ocupacionVV';

/** Fila de vv_ocupacion como la usa el cálculo. */
type FilaBD = {
  espacio_clave: string;
  slot: number;
  campana: string;
  negociacion: LineaOcup['negociacion'];
  convencional: boolean;
  inicio: string;
  fin: string;
  dias: number[] | null;
  horas: number[];
  estatus: LineaOcup['estatus'];
  reservada_hasta: string | null;
};

const COLUMNAS =
  'espacio_clave,slot,campana,negociacion,convencional,inicio,fin,dias,horas,estatus,reservada_hasta';

const aLinea = (f: FilaBD): LineaOcup => ({
  espacio: f.espacio_clave,
  slot: f.slot,
  campana: f.campana,
  negociacion: f.negociacion,
  convencional: f.convencional,
  inicio: f.inicio,
  fin: f.fin,
  dias: f.dias,
  horas: f.horas,
  estatus: f.estatus,
  reservadaHasta: f.reservada_hasta,
});

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** '2026-08' → 'agosto 2026'. */
export const etiquetaMes = (mes: string) => {
  const [a, m] = mes.split('-').map(Number);
  return m ? `${MESES[m - 1]} ${a}` : mes;
};

/** La tabla todavía no existe (falta la migración): se dice así, no como error raro. */
export const faltaTabla = (e: { code?: string; message?: string }) =>
  e.code === '42P01' || e.code === 'PGRST205';

/** 'YYYY-MM' del plano importado más reciente, o null si no hay ninguno. */
export async function planoMasReciente(): Promise<{ mes: string | null; error?: { code?: string; message: string } }> {
  const { data, error } = await sb
    .from('vv_ocupacion')
    .select('plano_mes')
    .eq('origen', 'plano')
    .order('plano_mes', { ascending: false })
    .limit(1);
  if (error) return { mes: null, error };
  return { mes: (data?.[0] as { plano_mes?: string } | undefined)?.plano_mes || null };
}

/** 'YYYY-MM' válido: lo que no cumpla no llega a la base ni al cálculo. */
export const esMes = (m: unknown): m is string => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

/**
 * El plano que vale para un mes: el más reciente que NO sea posterior (un
 * plano trae lo que sigue al aire de meses anteriores); si no hay ninguno
 * así, el primero que venga después.
 */
export async function planoParaMes(mes: string): Promise<{ mes: string | null; error?: string }> {
  if (!esMes(mes)) return { mes: null, error: 'Mes inválido: ' + mes };
  const antes = await sb
    .from('vv_ocupacion')
    .select('plano_mes')
    .eq('origen', 'plano')
    .lte('plano_mes', mes)
    .order('plano_mes', { ascending: false })
    .limit(1);
  if (antes.error) return { mes: null, error: antes.error.message };
  const m = (antes.data?.[0] as { plano_mes?: string } | undefined)?.plano_mes;
  if (m) return { mes: m };
  const despues = await sb
    .from('vv_ocupacion')
    .select('plano_mes')
    .eq('origen', 'plano')
    .gt('plano_mes', mes)
    .order('plano_mes', { ascending: true })
    .limit(1);
  if (despues.error) return { mes: null, error: despues.error.message };
  return { mes: (despues.data?.[0] as { plano_mes?: string } | undefined)?.plano_mes || null };
}

/** ¿Hay plano importado de ese mes exacto? (Ocupación no debe inventar 0 %.) */
export async function hayPlanoDe(mes: string): Promise<{ hay: boolean; error?: string }> {
  if (!esMes(mes)) return { hay: false, error: 'Mes inválido: ' + mes };
  const { count, error } = await sb
    .from('vv_ocupacion')
    .select('id', { count: 'exact', head: true })
    .eq('origen', 'plano')
    .eq('plano_mes', mes);
  if (error) return { hay: false, error: error.message };
  return { hay: !!count };
}

/**
 * Las líneas de uno o varios planos más lo capturado en la app (fase 2).
 * Con `desde`/`hasta`, solo las que tocan ese rango (filtra la base).
 */
export async function lineasDelPlano(
  planos: string | string[] | null,
  desde?: string,
  hasta?: string
): Promise<{ lineas: LineaOcup[]; error?: string }> {
  const lista = (Array.isArray(planos) ? planos : planos ? [planos] : []).filter(esMes);
  const filtro = lista.length ? `plano_mes.in.(${lista.join(',')}),origen.eq.app` : 'origen.eq.app';
  const todas: FilaBD[] = [];
  for (let i = 0; ; i += 1000) {
    let q = sb.from('vv_ocupacion').select(COLUMNAS).or(filtro);
    if (hasta) q = q.lte('inicio', hasta);
    if (desde) q = q.gte('fin', desde);
    const { data, error } = await q.order('id').range(i, i + 999);
    if (error) return { lineas: [], error: error.message };
    todas.push(...((data as FilaBD[]) || []));
    if (!data || data.length < 1000) break;
  }
  return { lineas: todas.map(aLinea) };
}

/** Meses 'YYYY-MM' que toca un rango de fechas. */
export function mesesDelRango(desde: string, hasta: string): string[] {
  const out: string[] = [];
  let [a, m] = desde.slice(0, 7).split('-').map(Number);
  const fin = hasta.slice(0, 7);
  for (let i = 0; i < 60; i++) {
    const mes = `${a}-${String(m).padStart(2, '0')}`;
    if (mes > fin) break;
    out.push(mes);
    m += 1;
    if (m > 12) {
      m = 1;
      a += 1;
    }
  }
  return out;
}

export type LineasDelRango = {
  lineas: LineaOcup[];
  /** Qué plano se usó para cada mes del rango (null = no hay ninguno). */
  planos: { mes: string; plano: string | null }[];
  error?: string;
};

/**
 * Disponibilidad de un rango (Libres y Matriz): el plano que vale para
 * CADA mes que toca. Antes se usaba un solo plano y, por ejemplo, tras
 * importar noviembre las ventas de octubre salían libres (revisión del
 * 19-oct-2026). Repetir una línea en dos planos no hace daño: en la
 * matriz manda la más firme y una hora ocupada sigue ocupada.
 */
export async function lineasDelRango(desde: string, hasta: string): Promise<LineasDelRango> {
  const meses = mesesDelRango(desde, hasta);
  const r = await Promise.all(meses.map((m) => planoParaMes(m)));
  const falla = r.find((x) => x.error);
  if (falla) return { lineas: [], planos: [], error: falla.error };
  const planos = meses.map((m, i) => ({ mes: m, plano: r[i].mes }));
  const distintos = [...new Set(planos.map((p) => p.plano).filter((p): p is string => !!p))];
  const { lineas, error } = await lineasDelPlano(distintos, desde, hasta);
  return { lineas, planos, error };
}

export type PlanoDelDia = {
  /** Lo que el plano pone al aire esa fecha (días de la semana y reservas vigentes ya filtrados). */
  lineas: LineaOcup[];
  /** El plano que se usó: el del mes de la fecha, o el más reciente si ese mes no tiene. */
  plano: string | null;
  error?: string;
};

/**
 * Qué pone al aire el plano en una fecha, con el plano que vale para ese
 * mes (planoParaMes).
 */
export async function planoDelDia(fecha: string): Promise<PlanoDelDia> {
  const p = await planoParaMes(fecha.slice(0, 7));
  if (p.error) return { lineas: [], plano: null, error: p.error };
  const { lineas, error } = await lineasDelPlano(p.mes, fecha, fecha);
  if (error) return { lineas: [], plano: p.mes, error };
  const ahora = new Date();
  return { lineas: lineas.filter((l) => activaEn(l, fecha) && cuenta(l, ahora)), plano: p.mes };
}
