// ============================================================
// src/lib/supabase.ts
// Cliente único de Supabase para toda la app.
// Las credenciales vienen de variables de entorno (.env.local),
// NO hardcodeadas como en el HTML original.
// ============================================================
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  // Aviso claro en desarrollo si faltan las variables de entorno.
  console.error(
    'Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY en .env.local'
  );
}

/**
 * Tope de /auth/v1/token (renovar la sesión o entrar con contraseña).
 *
 * 15 s y no menos (revisión del blindaje, 24-sep-2026): si una renovación
 * LLEGA al servidor, este rota el token; si luego abortamos por tope y auth-js
 * reintenta con el token viejo FUERA del "Refresh token reuse interval" de
 * Supabase (10 s por omisión), GoTrue contesta "Already Used", auth-js borra
 * la sesión y el técnico queda fuera — y sin red suficiente ni para volver a
 * entrar. Un tope corto convertía una red lenta pero viva en esa trampa. Por
 * eso: tope holgado, y el intervalo de reuso en Supabase (Auth → Sessions)
 * debe subirse a 60 s o más; el tope SIEMPRE debe quedar por debajo de ese
 * intervalo.
 */
const TOPE_TOKEN_MS = 15_000;
/** Si un /token acaba de vencer por tope, al siguiente se le da más tiempo. */
const TOPE_TOKEN_LARGO_MS = 25_000;
const VENTANA_TOPE_LARGO_MS = 60_000;
let ultimoTopeToken = 0;

/**
 * fetch con tope SOLO para /auth/v1/token (app pasmada sin señal,
 * 24-sep-2026). auth-js 2.112 manda /token sin tope, y TODA consulta a la
 * base o a Storage espera antes a getSession(), que espera a esa renovación:
 * un /token colgado (cambio de red en iOS, señal fantasma) dejaba la app sin
 * ninguna consulta para siempre, aunque la señal volviera (medido: 0
 * peticiones en 2,5 min). Con el tope, el cuelgue se vuelve una falla de red:
 * auth-js la reintenta dentro de su ventana de 30 s, la da por fallida y se
 * recupera sola.
 *
 * El resto de /auth/v1/ NO lleva tope: recuperar contraseña manda el correo
 * dentro de la misma petición (un SMTP lento decía "sin señal" aunque el
 * correo sí salía) y cambiar la contraseña la cambiaba pero la pantalla decía
 * que falló. Tampoco PostgREST, Storage ni funciones: sus topes los pone cada
 * llamador con abortSignal, y una subida de video puede tardar minutos.
 * Respeta la señal de quien llama, si trae una. supabase-js 2.112 usa
 * `global.fetch` también para auth (SupabaseClient._initSupabaseAuthClient
 * recibe settings.global.fetch).
 */
const conTopeAuth: typeof fetch = (entrada, init) => {
  const destino =
    typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
  if (!destino.split('?')[0].endsWith('/auth/v1/token')) return fetch(entrada, init);
  const TOPE_AUTH_MS =
    Date.now() - ultimoTopeToken < VENTANA_TOPE_LARGO_MS ? TOPE_TOKEN_LARGO_MS : TOPE_TOKEN_MS;
  const control = new AbortController();
  const deQuienLlama = init?.signal ?? (entrada instanceof Request ? entrada.signal : undefined);
  const alAbortar = () => control.abort(deQuienLlama?.reason);
  if (deQuienLlama?.aborted) alAbortar();
  else deQuienLlama?.addEventListener('abort', alAbortar, { once: true });
  // El reloj no se apaga al llegar las cabeceras: también cubre leer el
  // cuerpo (abortar después de terminar no hace nada).
  const reloj = setTimeout(() => {
    ultimoTopeToken = Date.now();
    try {
      control.abort(new DOMException('La red tardó demasiado', 'TimeoutError'));
    } catch {
      control.abort();
    }
  }, TOPE_AUTH_MS);
  return fetch(entrada, { ...init, signal: control.signal }).catch((e) => {
    clearTimeout(reloj);
    throw e;
  });
};

export const sb = createClient(url, anonKey, { global: { fetch: conTopeAuth } });
