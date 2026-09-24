// ============================================================
// src/lib/reportarError.ts
// Registro de errores del cliente en la tabla `errores_cliente`.
//
// POR QUÉ (auditoría, 24-sep-2026): con 300 celulares, un error de render o
// una subida fallida solo lo veía quien lo sufría —en un alert() que se
// cierra sin leer—. El equipo se enteraba por queja, días después, y sin
// saber en qué pantalla, versión ni tipo de red pasó.
//
// Reglas:
//   · NUNCA revienta ni bloquea: todo va en try/catch y el envío es de
//     disparar y olvidar. Un reporte que falla no genera otro reporte.
//   · Tope por sesión y sin repetidos: un bucle de errores no puede
//     inundar la tabla ni el plan.
//   · Solo cuenta como reportado lo que la BASE confirmó. Lo que falla sin
//     señal (justo cuando más errores hay) va a una cola chica y se reenvía
//     al volver la red o al renovarse la sesión.
//   · El correo lo pone la BASE (default auth_email()), no el cliente.
// Ver prelanzamiento_300.sql, PASO 3.
// ============================================================
import { sb } from './supabase';
import { BUILD_ID } from './versionApp';

/** Máximo de reportes CONFIRMADOS por sesión de navegador. */
const MAX_POR_SESION = 25;
/** Máximo de reportes esperando red. */
const MAX_PENDIENTES = 10;

/** Ruido conocido del navegador que no dice nada de la app. */
const IGNORAR = [/ResizeObserver loop/i, /^Script error\.?$/i];

type Fila = {
  modulo: string;
  mensaje: string;
  stack: string | null;
  ruta: string;
  version: string;
  user_agent: string;
  en_linea: boolean;
  extra: Record<string, unknown> | null;
};

let confirmados = 0;
/** Envíos sin respuesta todavía: cuentan para el tope (una ráfaga no lo brinca). */
let enCamino = 0;
/** Firmas ya enviadas O en camino (evita duplicar mientras viaja). */
const vistos = new Set<string>();
const pendientes: { firma: string; fila: Fila }[] = [];

function normalizar(e: unknown): { mensaje: string; stack: string | null } {
  if (e instanceof Error) return { mensaje: e.message || e.name, stack: e.stack || null };
  if (e && typeof e === 'object' && 'message' in e)
    return { mensaje: String((e as { message: unknown }).message), stack: null };
  return { mensaje: String(e ?? 'error desconocido'), stack: null };
}

function enviar(firma: string, fila: Fila): void {
  vistos.add(firma);
  enCamino++;
  sb.from('errores_cliente')
    .insert(fila)
    .then(
      ({ error, status }) => {
        enCamino--;
        // Rechazo DEFINITIVO de la base (RLS, CHECK, tabla que aún no
        // existe…): reintentar no lo arregla. Cuenta como intento consumido
        // y la firma se queda vista, para no reenviarla en cada regreso a
        // primer plano (auth-js emite SIGNED_IN en cada visibilitychange).
        if (!error || (status !== 0 && status !== 401)) {
          confirmados++;
          return;
        }
        // Falla de transporte (status 0: sin red) o sesión vencida (401):
        // postgrest-js no rechaza la promesa, resuelve con {error}. Se
        // libera la firma y se encola para reintentar.
        vistos.delete(firma);
        encolar(firma, fila);
      },
      () => {
        enCamino--;
        vistos.delete(firma);
        encolar(firma, fila);
      }
    );
}

function hayCupo(): boolean {
  return confirmados + enCamino < MAX_POR_SESION;
}

function encolar(firma: string, fila: Fila): void {
  if (pendientes.some((p) => p.firma === firma)) return;
  if (pendientes.length >= MAX_PENDIENTES) pendientes.shift();
  pendientes.push({ firma, fila });
}

/** Reenvía una sola vez lo que quedó pendiente (sin red o sin sesión). */
function reenviarPendientes(): void {
  try {
    const lote = pendientes.splice(0, pendientes.length);
    for (const p of lote) {
      if (!hayCupo()) return;
      if (vistos.has(p.firma)) continue;
      enviar(p.firma, { ...p.fila, en_linea: navigator.onLine });
    }
  } catch {
    /* nunca debe causar otro error */
  }
}

/**
 * @param claveDedupe opcional: distingue ocurrencias del mismo error que
 *   importan por separado (p. ej. la ruta del archivo que no se subió). Sin
 *   ella, todas las subidas fallidas de la sesión caían en UNA sola fila.
 */
export function reportarError(
  modulo: string,
  e: unknown,
  extra?: Record<string, unknown>,
  claveDedupe?: string
): void {
  try {
    const { mensaje, stack } = normalizar(e);
    if (IGNORAR.some((r) => r.test(mensaje))) return;
    const firma = modulo + '|' + mensaje + (claveDedupe ? '|' + claveDedupe : '');
    if (vistos.has(firma) || !hayCupo()) return;
    enviar(firma, {
      modulo: modulo.slice(0, 120),
      mensaje: mensaje.slice(0, 1000),
      stack: stack ? stack.slice(0, 4000) : null,
      ruta: window.location.pathname.slice(0, 200),
      version: BUILD_ID,
      user_agent: navigator.userAgent.slice(0, 300),
      en_linea: navigator.onLine,
      extra: extra ?? null,
    });
  } catch {
    /* el reporte de errores jamás debe causar otro error */
  }
}

/** Errores que no atrapa nadie, y el reenvío de pendientes. */
export function instalarReporteGlobal(): void {
  window.addEventListener('error', (ev) =>
    reportarError('window.error', ev.error || ev.message, {
      archivo: ev.filename,
      linea: ev.lineno,
    })
  );
  window.addEventListener('unhandledrejection', (ev) =>
    reportarError('promesa', ev.reason)
  );
  // Al volver la red, o al recuperar/renovar la sesión, sale lo pendiente.
  window.addEventListener('online', reenviarPendientes);
  sb.auth.onAuthStateChange((evento) => {
    if (evento === 'SIGNED_IN' || evento === 'TOKEN_REFRESHED') reenviarPendientes();
  });
}
