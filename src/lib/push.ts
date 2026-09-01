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
  | 'activo';           // suscrito y funcionando

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

export async function estadoPush(): Promise<EstadoPush> {
  // En iPhone, dentro de Safari, PushManager no existe. Hay que instalar.
  if (esIOS() && !estaInstalada()) return 'requiere-instalar';
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    return 'no-soportado';
  if (Notification.permission === 'denied') return 'bloqueado';

  const reg = await navigator.serviceWorker.getRegistration();
  const sus = await reg?.pushManager.getSubscription();
  if (sus && Notification.permission === 'granted') return 'activo';
  return 'sin-permiso';
}

/**
 * Pide permiso, se suscribe y guarda la suscripción en la base.
 *
 * IMPORTANTE: hay que llamarla desde un gesto del usuario (un clic). Safari
 * ignora la petición de permiso si no viene de una interacción directa.
 *
 * @returns null si todo salió bien, o un mensaje explicando qué faltó.
 */
export async function activarPush(email: string): Promise<string | null> {
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
