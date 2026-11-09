// ============================================================
// src/lib/push.ts
// Alta y baja de notificaciones push del navegador (Web Push).
//
// No requiere tiendas de aplicaciones. Funciona con la app cerrada porque el
// service worker sigue disponible aunque no haya pestaña abierta.
//
// EL ASTERISCO DE iOS: desde iOS 16.4 sí hay Web Push, pero SOLO si el usuario
// agregó la app a la pantalla de inicio. Desde una pestaña de Safari el
// navegador ni siquiera expone la API. Por eso `estadoPush()` distingue ese
// caso y devuelve 'requiere-instalar': hay que decirle al usuario qué hacer,
// no dejarlo con un botón que no responde.
// ============================================================
import { sb } from './supabase';
import { esIOS } from './plataforma';

export type EstadoPush =
  | 'no-soportado'      // el navegador no tiene Web Push
  | 'requiere-instalar' // iPhone en Safari: hay que "Agregar a inicio"
  | 'sin-permiso'       // se puede pedir permiso
  | 'bloqueado'         // el usuario dijo no; hay que ir a ajustes del navegador
  | 'caido'             // el navegador cree que está suscrito, pero la base no le manda
  | 'activo';           // suscrito y funcionando

/**
 * Lo que la app sabe de los avisos de esta persona: el estado de ESTE
 * dispositivo y cuántos dispositivos suyos reciben push según la base
 * (null si no se pudo consultar, por ejemplo sin señal).
 */
export type RevisionPush = {
  estado: EstadoPush;
  dispositivosActivos: number | null;
};

const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

/** ¿La app está corriendo instalada (no en una pestaña del navegador)? */
export function estaInstalada(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari en iOS no soporta display-mode: usa esta propiedad propietaria.
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

/**
 * La llave VAPID viaja en base64url y la API la pide como bytes.
 *
 * El buffer se crea explícitamente como ArrayBuffer (no ArrayBufferLike):
 * `applicationServerKey` exige un BufferSource respaldado por ArrayBuffer, y
 * TypeScript rechaza el tipo genérico que devuelve `new Uint8Array(n)`.
 */
function base64UrlABytes(base64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Registra el service worker. Idempotente: se puede llamar varias veces. */
export async function registrarSW(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (e) {
    console.error('[push] no se pudo registrar el service worker:', e);
    return null;
  }
}

/** Estado según el navegador, más el endpoint si está suscrito. */
async function estadoLocal(): Promise<{ estado: EstadoPush; endpoint: string | null }> {
  // En iPhone, dentro de Safari, PushManager no existe. Hay que instalar.
  if (esIOS() && !estaInstalada()) return { estado: 'requiere-instalar', endpoint: null };
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    return { estado: 'no-soportado', endpoint: null };
  if (Notification.permission === 'denied') return { estado: 'bloqueado', endpoint: null };

  const reg = await navigator.serviceWorker.getRegistration();
  const sus = await reg?.pushManager.getSubscription();
  if (sus && Notification.permission === 'granted')
    return { estado: 'activo', endpoint: sus.endpoint };
  return { estado: 'sin-permiso', endpoint: null };
}

/** Estado según el navegador solamente (no pregunta a la base). */
export async function estadoPush(): Promise<EstadoPush> {
  return (await estadoLocal()).estado;
}

/** Tope de la consulta a la base: sin señal no se espera de más. */
const TOPE_CONSULTA_MS = 8000;

/**
 * Estado de este dispositivo comparado con la base, más cuántos dispositivos
 * de la persona reciben push.
 *
 * El navegador solo sabe que se suscribió; no sabe si la base lo sigue
 * teniendo. Cuando el servicio de push responde 404/410, `enviar-push` marca
 * la suscripción como inválida y deja de mandarle, pero el teléfono sigue
 * diciendo "activo". Así se quedó Irving sin avisos (revisión del 9-nov-2026:
 * 14 de 33 personas con avisos no tenían ningún dispositivo activo). Aquí
 * ese caso sale como 'caido'.
 *
 * La RLS de push_suscripciones solo deja ver las filas propias. Si la
 * consulta falla o tarda (sin señal), se confía en el navegador y
 * dispositivosActivos queda en null: nunca se acusa una caída sin saberlo.
 */
export async function revisarPush(): Promise<RevisionPush> {
  const local = await estadoLocal();
  let endpoints: string[] | null = null;
  try {
    const consulta = sb
      .from('push_suscripciones')
      .select('endpoint')
      .eq('invalida', false)
      .then(({ data, error }) =>
        error ? null : (data || []).map((f) => (f as { endpoint: string }).endpoint)
      );
    const tope = new Promise<null>((r) => setTimeout(() => r(null), TOPE_CONSULTA_MS));
    endpoints = await Promise.race([consulta, tope]);
  } catch {
    endpoints = null;
  }
  if (endpoints === null) return { estado: local.estado, dispositivosActivos: null };

  const estado =
    local.estado === 'activo' && local.endpoint && !endpoints.includes(local.endpoint)
      ? 'caido'
      : local.estado;
  return { estado, dispositivosActivos: endpoints.length };
}

/**
 * Pide permiso, se suscribe y guarda la suscripción en la base.
 *
 * IMPORTANTE: hay que llamarla desde un gesto del usuario (un clic). Safari
 * ignora la petición de permiso si no viene de una interacción directa.
 *
 * Con `renovar` (estado 'caido') se tira la suscripción que el navegador
 * guarda y se crea otra: la vieja la rechazó el servicio de push o es de
 * otra cuenta que usó este mismo teléfono, y volver a guardarla no serviría.
 *
 * @returns null si todo salió bien, o un mensaje explicando qué faltó.
 */
export async function activarPush(email: string, renovar = false): Promise<string | null> {
  if (!VAPID)
    return 'Falta VITE_VAPID_PUBLIC_KEY en .env.local. Pídesela al administrador.';

  if (esIOS() && !estaInstalada())
    return 'En iPhone hay que agregar la app a la pantalla de inicio antes de activar las notificaciones.';

  const reg = (await navigator.serviceWorker.getRegistration()) || (await registrarSW());
  if (!reg) return 'Tu navegador no soporta notificaciones push.';

  const permiso = await Notification.requestPermission();
  if (permiso !== 'granted')
    return 'No se concedió el permiso de notificaciones. Puedes activarlo desde los ajustes del navegador.';

  let sus: PushSubscription | null;
  try {
    sus = await reg.pushManager.getSubscription();

    if (sus && renovar) {
      await sus.unsubscribe();
      sus = null;
    }

    // Si la suscripción existente es de OTRA llave VAPID (se regeneraron las
    // llaves), reutilizarla guardaría un registro muerto: el push service
    // rechaza con 403 los envíos firmados con la privada nueva, y la función
    // reporta enviados:0 sin invalidar nada. Se tira y se crea una fresca.
    // (Esto pasó el 31-ago-2026: "reactivar la campanita" re-guardaba la
    // suscripción zombi porque este código la reutilizaba tal cual.)
    if (sus) {
      const actual = base64UrlABytes(VAPID);
      const vieja = sus.options?.applicationServerKey
        ? new Uint8Array(sus.options.applicationServerKey as ArrayBuffer)
        : null;
      const mismaLlave =
        !!vieja &&
        vieja.length === actual.length &&
        vieja.every((b, i) => b === actual[i]);
      if (!mismaLlave) {
        await sus.unsubscribe();
        sus = null;
      }
    }

    if (!sus)
      sus = await reg.pushManager.subscribe({
        // Obligatorio: el navegador no permite push silencioso.
        userVisibleOnly: true,
        applicationServerKey: base64UrlABytes(VAPID),
      });
  } catch (e) {
    return 'No se pudo suscribir: ' + (e as Error).message;
  }

  const j = sus.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth)
    return 'La suscripción llegó incompleta del navegador.';

  // upsert por endpoint: si el mismo dispositivo se vuelve a suscribir, se
  // actualiza en vez de duplicar. `invalida: false` la revive si estaba
  // marcada como muerta.
  const { error } = await sb.from('push_suscripciones').upsert(
    {
      usuario_email: email.toLowerCase(),
      endpoint: j.endpoint,
      p256dh: j.keys.p256dh,
      auth: j.keys.auth,
      user_agent: navigator.userAgent.slice(0, 300),
      invalida: false,
    },
    { onConflict: 'endpoint' }
  );
  if (error) return 'No se pudo guardar la suscripción: ' + error.message;

  return null;
}

/** Da de baja este dispositivo. */
export async function desactivarPush(): Promise<string | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sus = await reg?.pushManager.getSubscription();
  if (!sus) return null;

  const endpoint = sus.endpoint;
  await sus.unsubscribe();
  // Se borra la fila: si el usuario se dio de baja, no hay por qué guardar
  // sus llaves de cifrado.
  const { error } = await sb
    .from('push_suscripciones')
    .delete()
    .eq('endpoint', endpoint);
  return error ? 'No se pudo borrar la suscripción: ' + error.message : null;
}
