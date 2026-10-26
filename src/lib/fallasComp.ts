// ============================================================
// src/lib/fallasComp.ts
// Cómo se clasifica y se explica una falla de Comprobaciones (sin red, la
// base contestó, falta la migración, candado…). Salió de comprobacionesApi.ts
// en la revisión del 26-oct-2026 (regresiones-1) para que la lista del
// monitorista (misTomasApi.ts, en Mis rutas) no arrastre toda el API del
// Supervisor. comprobacionesApi.ts lo vuelve a exportar: nada cambia para
// las pantallas. Sin red ni React propios (solo pareceSinRed).
// ============================================================

import { pareceSinRed } from './enLinea';

/**
 * Por qué falló, decidido SOLO por el código de Postgres o PostgREST y el
 * status (fase 3, 26-oct-2026): la pantalla y, después, la cola deciden con
 * esto y nunca leyendo el texto del error.
 *   · sin_red: no hubo respuesta (o la red tardó);
 *   · falta_migracion: la función, tabla o columna no existe (la migración
 *     de esa fase no está aplicada);
 *   · sin_sesion: CP001 o el token no sirve;
 *   · sin_permiso: 42501 o la RPC contestó {ok:false, codigo:'sin_permiso'};
 *   · ocupada: candado (55P03, 40P01 o {codigo:'ocupada'}): se reintenta;
 *   · tardo: statement_timeout (57014);
 *   · datos: CP002/CP003/CP005 o un valor fuera de rango (no debe pasar);
 *   · otro: lo demás.
 */
export type CodigoFallaComp =
  | 'sin_red'
  | 'falta_migracion'
  | 'sin_sesion'
  | 'sin_permiso'
  | 'ocupada'
  | 'tardo'
  | 'datos'
  | 'otro';

/** Lo que regresa toda función de aquí: nunca lanza. */
export type ResultadoComp<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; sinRed: boolean; codigo?: CodigoFallaComp };

export type ErrorPg = { message?: string; code?: string; details?: string | null; hint?: string | null } | null;

/**
 * Error de la base en palabras de campo. Los raise exception de las RPC
 * comp_ ya están en español y se dejan tal cual; solo se traducen los de
 * Postgres y PostgREST que la pantalla no debe enseñar en inglés.
 */
export function textoErrorComp(error: ErrorPg | unknown): string {
  const e = (error && typeof error === 'object' ? error : {}) as { message?: unknown; code?: unknown };
  const msg = typeof e.message === 'string' ? e.message : typeof error === 'string' ? error : '';
  const code = typeof e.code === 'string' ? e.code : '';
  // Candado: otra carga o lote tiene tomadas las filas (lock_timeout 3 s).
  if (code === '55P03' || /lock timeout/i.test(msg))
    return 'Otra persona está guardando en estas campañas. Espera unos segundos y vuelve a intentar.';
  if (code === '57014' || /statement timeout|canceling statement/i.test(msg))
    return 'La base tardó demasiado. Intenta con menos campañas a la vez.';
  // La migración comp_base no está aplicada en esta base (o cambió una firma).
  if (code === 'PGRST202' || /could not find the function/i.test(msg))
    return 'La base todavía no tiene Comprobaciones (falta aplicar su migración). Avisa a Erik.';
  if (code === '42P01' || code === 'PGRST205' || /relation .* does not exist|could not find the table/i.test(msg))
    return 'La base todavía no tiene las tablas de Comprobaciones. Avisa a Erik.';
  if (code === '42501' || /permission denied/i.test(msg))
    return 'No tienes permiso para esto en Comprobaciones.';
  if (/JWT expired|invalid jwt/i.test(msg)) return 'Tu sesión venció: vuelve a entrar.';
  // Número fuera de rango, texto que no es número o fecha inválida.
  if (code === '22003' || code === '22P02' || code === '22008' || code === '22007')
    return 'Hay un número o una fecha fuera de rango o que no se entiende. Revisa lo que escribiste.';
  return msg || 'Algo falló en la base.';
}

/** Texto para el usuario de un resultado fallido (lectura). */
export function textoFallaComp(r: { error: string; sinRed: boolean }): string {
  return r.sinRed ? 'Sin señal o la red tardó demasiado. Vuelve a intentarlo cuando tengas señal.' : r.error;
}

/**
 * Texto de una ESCRITURA fallida. Sin respuesta no se sabe si la base la
 * aplicó (pudo llegar y perderse la contestación): se pide recargar antes
 * de repetir. Las RPC comp_ son idempotentes (marcar dos veces no duplica),
 * pero el conteo que se enseñe después debe salir de la base.
 */
export function textoFallaEscrituraComp(r: { error: string; sinRed: boolean }): string {
  return r.sinRed
    ? 'Sin señal o la red tardó: no se sabe si se guardó. Recarga para ver cómo quedó antes de repetir.'
    : r.error;
}

/** Status HTTP que no son contestación de la base (los mismos de enLinea). */
const STATUS_SIN_RESPUESTA = new Set([0, 408, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * ¿El error trae un código que solo pone la base o PostgREST? Un SQLSTATE
 * (5 caracteres: «55P03», «57014», «P0001»…) o un «PGRSTxxx» quiere decir
 * que la base CONTESTÓ: no es falta de señal aunque el texto diga «timeout»
 * («canceling statement due to lock timeout»). Revisión 2, contrato-1.
 */
export function esRespuestaDeBase(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && (/^[0-9A-Z]{5}$/.test(code) || /^PGRST/.test(code));
}

/**
 * Clasifica un error en «sin señal» o «la base contestó». Sin respuesta
 * (status 0 o de gateway) siempre es sin señal; con código de la base nunca
 * lo es; lo demás lo decide pareceSinRed por el texto.
 */
export function clasificarErrorComp(error: unknown, status?: number | null): { error: string; sinRed: boolean } {
  const sinRespuesta = typeof status === 'number' && STATUS_SIN_RESPUESTA.has(status);
  const sinRed = sinRespuesta || (!esRespuestaDeBase(error) && pareceSinRed(error, status));
  return { error: sinRed ? 'Sin señal' : textoErrorComp(error), sinRed };
}

/** Códigos que dicen «esto no existe en la base»: falta aplicar una migración. */
const CODIGOS_FALTA_MIGRACION = new Set(['PGRST202', 'PGRST204', 'PGRST205', '42883', '42P01', '42703']);

/**
 * El código de una falla (ver CodigoFallaComp). Solo mira `code` y el
 * status: nunca el texto (fase 3, 26-oct-2026).
 */
export function codigoFallaComp(error: unknown, status?: number | null, sinRed?: boolean): CodigoFallaComp {
  if (sinRed) return 'sin_red';
  const raw = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const code = typeof raw === 'string' ? raw : '';
  if (CODIGOS_FALTA_MIGRACION.has(code)) return 'falta_migracion';
  if (code === 'CP001' || code === 'PGRST301' || code === 'PGRST303' || status === 401) return 'sin_sesion';
  if (code === '42501' || status === 403) return 'sin_permiso';
  if (code === '55P03' || code === '40P01') return 'ocupada';
  if (code === '57014') return 'tardo';
  if (/^CP00[2-9]$/.test(code) || /^22/.test(code) || code === '23514') return 'datos';
  return 'otro';
}

/** Texto para el usuario de una falla de la fase 3, por su código. */
export function textoFallaF3(r: { error: string; sinRed: boolean; codigo?: CodigoFallaComp }, escritura = false): string {
  switch (r.codigo) {
    case 'sin_red':
      return escritura
        ? 'Sin señal o la red tardó: no se sabe si se guardó. Recarga para ver cómo quedó antes de repetir.'
        : 'Sin señal o la red tardó demasiado. Vuelve a intentarlo cuando tengas señal.';
    case 'falta_migracion':
      return 'La base todavía no tiene esta parte de Comprobaciones (falta aplicar su migración). Avisa a Erik.';
    case 'sin_sesion':
      return 'Tu sesión venció: vuelve a entrar.';
    case 'sin_permiso':
      return 'No tienes permiso para esto en Comprobaciones.';
    case 'ocupada':
      return 'Otra persona está guardando en estas campañas. Espera unos segundos y vuelve a intentar.';
    case 'tardo':
      return 'La base tardó demasiado. Intenta con menos a la vez.';
    default:
      // datos/otro: el mensaje de la base ya viene en español (raise exception).
      return r.sinRed ? textoFallaComp(r) : r.error || 'Algo falló en la base.';
  }
}
