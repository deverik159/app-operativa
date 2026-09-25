// ============================================================
// src/App.tsx
// Raíz de la app: sesión, recuperación de contraseña, carga de roles y
// navegación.
//
// A diferencia del HTML viejo —donde App() cargaba también las incidencias—
// aquí App SOLO hace sesión y navegación; cada módulo carga sus datos.
// Lo global es la campana de notificaciones, porque la comparten todos.
//
// IMPORTANTE: 'bandeja' y 'todas' renderizan el MISMO <IncidenciasView> en la
// misma posición del árbol, cambiando solo la prop `modo`. React lo reconcilia
// como el mismo componente, así que al alternar entre las dos pestañas NO se
// remonta: se conservan la lista, los filtros y la búsqueda, igual que en el
// HTML (donde todo vivía en App).
//
// Desde la auditoría del primer mes (24-sep-2026): cada pestaña tiene su
// ruta (/pendientes, /pauta…; ver RUTA_DE_TAB) y todos los módulos salvo
// Incidencias se descargan al abrirlos (lazyConReintento).
// ============================================================
import {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
  Suspense,
  type ComponentType,
} from 'react';
import { isAuthRetryableFetchError, type Session } from '@supabase/supabase-js';
import { sb } from './lib/supabase';
import { ROLE_LABEL, ROLE_ICON, ROLE_PRIORITY, UNIDADES } from './lib/constants';
import { initials } from './lib/helpers';
import { useNotificaciones } from './lib/useNotificaciones';
import { vigilarNuevaVersion, traerVersionNueva } from './lib/versionApp';
import CampanaNotifs from './components/CampanaNotifs';
import BotonPush from './components/BotonPush';
import MenuUsuario from './components/MenuUsuario';
import ErrorBoundary from './components/ErrorBoundary';
import EnviosPendientes from './components/EnviosPendientes';
import {
  confirmarRecargaConEnvios,
  hayEnviosEnRiesgo,
  listarPendientes,
} from './lib/envios';
import { accionesPendientes } from './lib/acciones';
import { borrarListaLocal, iniciarSincronizacion } from './lib/datosLocales';
import { useEnLinea, enLineaAhora, pareceSinRed } from './lib/enLinea';
import { lazyConReintento, fijarModuloEnPantalla } from './lib/cargaDiferida';
// Incidencias se queda ESTÁTICO: es el núcleo (Mis pendientes y el alta
// NuevaInc que abre el botón Nueva). Un alta nunca debe esperar —ni
// fallar— por la descarga de un chunk.
import IncidenciasView from './modules/incidencias/IncidenciasView';
import type { UsuarioRol } from './types/db';

/**
 * Los demás módulos se descargan al abrir su pestaña (auditoría primer mes,
 * 24-sep-2026). El bundle único pesaba ~1.3 MB y cada arranque bajaba xlsx
 * y leaflet aunque el usuario solo atendiera su bandeja. lazyConReintento
 * reintenta y, si el chunk ya no existe por un despliegue nuevo, recarga
 * la app una vez (ver src/lib/cargaDiferida.ts).
 */
const IndicadoresView = lazyConReintento(
  () => import('./modules/incidencias/IndicadoresView'),
  'IndicadoresView'
);
const FijacionExternaView = lazyConReintento(
  () => import('./modules/fijacion-externa/FijacionExternaView'),
  'FijacionExternaView'
);
const RutasView = lazyConReintento(() => import('./modules/rutas/RutasView'), 'RutasView');
const PautaView = lazyConReintento(() => import('./modules/pauta/PautaView'), 'PautaView');
const BioboxView = lazyConReintento(() => import('./modules/biobox/BioboxView'), 'BioboxView');
const DisponibilidadView = lazyConReintento(
  () => import('./modules/inventario/DisponibilidadView'),
  'DisponibilidadView'
);
const BitacoraVVView = lazyConReintento(
  () => import('./modules/bitacora-vv/BitacoraVVView'),
  'BitacoraVVView'
);
const UsuariosView = lazyConReintento(
  () => import('./modules/usuarios/UsuariosView'),
  'UsuariosView'
);

/**
 * Módulo diferido de cada pestaña. App le avisa a cargaDiferida cuál está
 * en pantalla: la recarga automática por un chunk fallido solo procede si
 * es la de ESE módulo (revisión primer mes, 24-sep-2026; ver
 * fijarModuloEnPantalla). Las pestañas de Incidencias no van: son estáticas.
 */
const DIFERIDO_DE_TAB: Record<string, ComponentType<any>> = {
  dashboard: IndicadoresView,
  disponibilidad: DisponibilidadView,
  bitacora_vv: BitacoraVVView,
  fijacion_externa: FijacionExternaView,
  rutas: RutasView,
  pauta: PautaView,
  biobox: BioboxView,
  usuarios: UsuariosView,
};

/** A los cuántos ms el "Cargando…" de un módulo diferido ofrece salidas. */
const AVISO_CARGA_LENTA_MS = 15 * 1000;

/**
 * "Cargando…" de los módulos diferidos, con salida si se atora (revisión
 * primer mes, 24-sep-2026).
 *
 * El import() de un chunk no tiene tope: con la señal colgada (conecta pero
 * no transmite) el navegador tarda minutos en darlo por fallido, y mientras
 * tanto no hay error que atrape el ErrorBoundary; ↻ no toca un lazy
 * pendiente y la PWA instalada no tiene jalar-para-recargar. A los ~15 s se
 * avisa y se ofrece recargar, SIN cortar la descarga: en 2G un chunk lento
 * pero vivo termina bien, y un tope que recargara solo la reiniciaría desde
 * cero cada vez. No se ofrece "Reintentar": Chrome une un import() nuevo a
 * la descarga colgada de la misma URL, así que no destrabaría nada.
 */
function CargandoModulo() {
  const [lento, setLento] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setLento(true), AVISO_CARGA_LENTA_MS);
    return () => window.clearTimeout(t);
  }, []);
  if (!lento) return <div className="loading">Cargando…</div>;
  return (
    <div className="loading" role="status" style={{ lineHeight: 1.5 }}>
      <b>Tarda más de lo normal.</b>
      <br />
      Puede ser la señal. Puedes esperar, cambiarte de módulo desde el menú
      o recargar la app.
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            if (confirmarRecargaConEnvios()) window.location.reload();
          }}
        >
          Recargar la app
        </button>
      </div>
    </div>
  );
}

/**
 * Marca de la entrada de historial que apila "Nueva" (ver su action). Lleva
 * un valor propio de ESTE documento: tras una recarga, el history.state de
 * esa entrada sigue diciendo "alta", pero la de abajo ya es de otro
 * documento y un history.back() recargaría la app (revisión primer mes,
 * 24-sep-2026).
 */
const MARCA_ALTA = `alta-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Pestaña ↔ ruta (auditoría primer mes, 24-sep-2026).
 *
 * Antes la app vivía siempre en "/": el botón Atrás de Android (PWA
 * instalada) CERRABA la app en vez de regresar a la pestaña anterior, un
 * enlace no podía abrir Pauta directo, y errores_cliente.ruta decía "/"
 * para todo. Ahora cada pestaña tiene su ruta con la History API (sin
 * dependencias). vercel.json ya reescribe todo lo que no sea /assets a
 * index.html y Vite dev hace lo mismo, así que recargar en /pauta funciona.
 */
const RUTA_DE_TAB: Record<string, string> = {
  bandeja: '/pendientes',
  todas: '/incidencias',
  dashboard: '/indicadores',
  disponibilidad: '/disponibilidad',
  bitacora_vv: '/bitacora-vv',
  fijacion_externa: '/fijacion-externa',
  rutas: '/rutas',
  pauta: '/pauta',
  biobox: '/biobox',
  usuarios: '/usuarios',
};
const TAB_DE_RUTA: Record<string, string> = Object.fromEntries(
  Object.entries(RUTA_DE_TAB).map(([tab, ruta]) => [ruta, tab])
);

/** Pestaña que corresponde a una ruta ('/pauta/' y '/Pauta' también valen). */
function tabDeRuta(pathname: string): string | null {
  const limpia = (pathname.replace(/\/+$/, '') || '/').toLowerCase();
  return TAB_DE_RUTA[limpia] ?? null;
}

// ---- Sesión y roles sin señal (modo sin señal, 24-sep-2026) --------------
//
// Antes, abrir la app sin red con el token vencido (casi todo arranque en
// frío tras ~1 h sin usarla) dejaba ~25 s en "Cargando…" y luego el Login:
// auth-js reintenta la renovación ~25 s y getSession devuelve null con un
// error REINTENTABLE, pero la sesión sigue guardada y se recupera sola al
// volver la red. Ahora App entra de inmediato con la sesión guardada
// ("sin verificar") y auth-js la confirma o la renueva cuando pueda. Si la
// sesión muere de verdad (refresh token revocado), auth-js borra la clave
// y emite SIGNED_OUT: ahí sí se va al Login.

/**
 * Clave de la sesión en localStorage. La misma que arma supabase-js
 * (SupabaseClient: `sb-<primer tramo del host>-auth-token`); si el cliente
 * expone la suya en tiempo de ejecución, manda esa. NO fijar
 * auth.storageKey en supabase.ts con otro valor: sacaría a todos de su
 * sesión.
 */
function claveSesion(): string {
  const propia = (sb.auth as unknown as { storageKey?: unknown }).storageKey;
  if (typeof propia === 'string' && propia) return propia;
  try {
    const host = new URL(String(import.meta.env.VITE_SUPABASE_URL || '').trim()).hostname;
    return `sb-${host.split('.')[0]}-auth-token`;
  } catch {
    return '';
  }
}

/**
 * La sesión guardada por auth-js, leída de forma síncrona. Solo si tiene la
 * forma que auth-js acepta (access/refresh token y expires_at) y trae el
 * correo: Main solo usa user.email y user_metadata.name. No se revisa
 * expires_at: sin red se espera que esté vencida.
 */
function leerSesionGuardada(): Session | null {
  try {
    const clave = claveSesion();
    if (!clave) return null;
    const crudo = window.localStorage.getItem(clave);
    if (!crudo) return null;
    const s = JSON.parse(crudo) as Partial<Session> | null;
    if (
      !s ||
      typeof s !== 'object' ||
      typeof s.access_token !== 'string' ||
      typeof s.refresh_token !== 'string' ||
      !s.refresh_token ||
      !('expires_at' in s) ||
      !s.user ||
      typeof s.user.email !== 'string' ||
      !s.user.email
    )
      return null;
    return s as Session;
  } catch {
    return null;
  }
}

function borrarSesionGuardada(): void {
  try {
    const clave = claveSesion();
    if (!clave) return;
    window.localStorage.removeItem(clave);
    // Copia del usuario que auth-js guarda aparte en algunas configuraciones
    // (su _removeSession también la quita; revisión sin señal, 24-sep-2026).
    window.localStorage.removeItem(`${clave}-user`);
  } catch {
    /* sin localStorage no hay nada guardado que borrar */
  }
}

/**
 * ¿Se está regresando de Google o del correo de restablecimiento? Ahí la
 * URL trae la sesión NUEVA (o un error) y la guardada puede ser de otra
 * cuenta: se espera a auth-js como antes, sin arranque optimista.
 */
function esRegresoDeAuth(): boolean {
  const { hash, search } = window.location;
  return (
    /(^#|&)(access_token|refresh_token|error|error_description)=/.test(hash) ||
    /[?&](code|error_description)=/.test(search)
  );
}

/**
 * true tras un "Salir" que auth-js no pudo completar (sin red). Si en ese
 * rato termina una renovación que ya iba en camino, auth-js vuelve a guardar
 * la sesión y emite TOKEN_REFRESHED: se ignora y se cierra otra vez. Se
 * apaga al intentar entrar desde el Login.
 */
let salidaForzada = false;

/** Tope para "Salir": si auth-js no contesta en este tiempo, sale a mano. */
const TOPE_SALIR_MS = 4000;
/** Tope de getSession antes de dar la sesión por "no confirmada todavía". */
const TOPE_SESION_MS = 5000;
/** Tope de la consulta de roles con copia en el teléfono (sin reintentos). */
const TOPE_ROLES_CON_COPIA_MS = 8000;
/** Tope de la consulta de roles sin copia (con los reintentos de siempre). */
const TOPE_ROLES_SIN_COPIA_MS = 20000;
/**
 * Hasta cuándo una ruta que la copia de roles no tenía se abre al llegar los
 * de la red (ver rutaPendiente en Main). Después, aunque no haya cambiado
 * de pestaña, el usuario ya está usando la suya: no se le mueve.
 */
const RUTA_PENDIENTE_MS = 30000;

/** AbortSignal con tope; AbortSignal.timeout no existe en Safari < 16. */
function tope(ms: number): AbortSignal {
  const AS = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof AS.timeout === 'function') return AS.timeout(ms);
  const c = new AbortController();
  window.setTimeout(() => c.abort(), ms);
  return c.signal;
}

/** Resuelve `valor` si la promesa no termina a tiempo (nunca rechaza). */
function conTope<T>(p: PromiseLike<T>, ms: number, valor: T): Promise<T> {
  return new Promise<T>((res) => {
    const t = window.setTimeout(() => res(valor), ms);
    Promise.resolve(p).then(
      (v) => {
        window.clearTimeout(t);
        res(v);
      },
      () => {
        window.clearTimeout(t);
        res(valor);
      }
    );
  });
}

/**
 * Renueva la sesión YA al volver la señal (app pasmada sin señal,
 * 24-sep-2026). Sin red y con el token vencido, auth-js 2.112.3 guarda la
 * renovación fallida en `lastRefreshFailure` y durante 60 s
 * (REFRESH_FAILURE_COOLDOWN_MS) getSession devuelve null SIN intentar la
 * red: al volver la señal, ↻ y 'online' solo enseñaban la copia ("se
 * reintenta sola") hasta un minuto. refreshSession con el mismo token
 * devuelve la misma falla guardada, así que no sirve para saltarla.
 *
 * Solo se olvida una falla de TRANSPORTE (AuthRetryableFetchError con status
 * 0: el fetch ni llegó): la de un token rechazado se respeta, y una caída
 * 5xx de Auth también — ahí olvidarla multiplicaría la carga de 300
 * teléfonos contra un servidor que ya está mal (revisión del blindaje,
 * 24-sep-2026). Y a lo más una vez cada 20 s, aunque el usuario toque ↻ o
 * mueva la app al frente seguido. Es un campo
 * INTERNO: tests/authInterno.test.mjs truena si una actualización de
 * supabase-js lo quita, lo renombra o le cambia la forma. Si pasa, esto no
 * hace nada y se vuelve a esperar el minuto (no rompe nada).
 */
let ultimoOlvido = 0;
const OLVIDO_CADA_MS = 20_000;

function renovarSesionYa(): void {
  if (!enLineaAhora()) return;
  try {
    const auth = sb.auth as unknown as {
      lastRefreshFailure?: { result?: { error?: unknown } } | null;
    };
    const falla = 'lastRefreshFailure' in auth ? auth.lastRefreshFailure : null;
    const error = falla?.result?.error as { status?: number } | undefined;
    if (
      falla &&
      isAuthRetryableFetchError(error) &&
      !error?.status &&
      Date.now() - ultimoOlvido >= OLVIDO_CADA_MS
    ) {
      ultimoOlvido = Date.now();
      auth.lastRefreshFailure = null;
    }
    void sb.auth.getSession().catch(() => {});
  } catch {
    /* auth-js distinto: queda el enfriamiento de siempre */
  }
}

// Al volver la red o la app al frente con señal. A nivel de módulo y no en
// un efecto: así se registran ANTES que los de las vistas (IncidenciasView,
// la cola, los roles), y el getSession que ellos piden con el mismo
// 'online' ya encuentra la falla olvidada y se une a la renovación nueva.
if (typeof window !== 'undefined') {
  window.addEventListener('online', renovarSesionYa);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renovarSesionYa();
  });
}

/**
 * Roles guardados en el teléfono, por correo: {filas, guardado}. Son 1–5
 * filas (<1 KB). Con ellos Main arranca sin los ~7 s de "Cargando tu
 * perfil…" y, sin red, con su menú completo (antes quedaba solo
 * Indicadores: no se podía capturar, validar ni reparar).
 */
const claveRoles = (email: string) => `gpovallas_roles:${email}`;

function leerRolesGuardados(email: string): UsuarioRol[] | null {
  try {
    const crudo = window.localStorage.getItem(claveRoles(email));
    if (!crudo) return null;
    const g = JSON.parse(crudo) as { filas?: unknown } | null;
    const filas = g?.filas;
    if (!Array.isArray(filas) || filas.length === 0) return null;
    if (!filas.every((f) => f && typeof f === 'object' && typeof (f as UsuarioRol).rol === 'string'))
      return null;
    return filas as UsuarioRol[];
  } catch {
    return null;
  }
}

function guardarRoles(email: string, filas: UsuarioRol[]): void {
  try {
    window.localStorage.setItem(
      claveRoles(email),
      JSON.stringify({ filas, guardado: new Date().toISOString() })
    );
  } catch {
    /* sin espacio o modo privado: se sigue con los de memoria */
  }
}

function borrarRolesGuardados(email: string): void {
  try {
    window.localStorage.removeItem(claveRoles(email));
  } catch {
    /* nada guardado */
  }
}

/** Mismas filas (orden incluido: la consulta no ordena, pero es estable). */
function mismosRoles(a: UsuarioRol[] | null, b: UsuarioRol[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every(
    (r, i) =>
      r.rol === b[i].rol &&
      (r.unidad_negocio ?? null) === (b[i].unidad_negocio ?? null) &&
      (r.departamento ?? null) === (b[i].departamento ?? null)
  );
}

/**
 * Pide UNA vez que el navegador no borre lo guardado (cola de envíos,
 * copias de datos, armazón) cuando le falte espacio. Safari 17+ y Chrome;
 * donde no existe o lo niega, no pasa nada.
 */
let persistenciaPedida = false;
function pedirAlmacenamientoPersistente(): void {
  if (persistenciaPedida) return;
  persistenciaPedida = true;
  try {
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* sin StorageManager */
  }
}

/** Texto para quien intenta entrar sin red. */
const NECESITAS_SENAL = 'Necesitas señal para iniciar sesión.';

/** Ícono de la app: una valla / espectacular. */
function LogoValla() {
  return (
    <svg
      viewBox="0 0 24 24"
      style={{ width: '62%', height: '62%' }}
      fill="none"
      stroke="#141414"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3.5" width="18" height="11" rx="1.8" />
      <line x1="6.5" y1="7.4" x2="13" y2="7.4" />
      <line x1="6.5" y1="10.7" x2="17.5" y2="10.7" />
      <line x1="9" y1="14.5" x2="9" y2="20.5" />
      <line x1="15" y1="14.5" x2="15" y2="20.5" />
      <line x1="6.5" y1="20.5" x2="17.5" y2="20.5" />
    </svg>
  );
}

/** Logotipo de Google (SVG oficial de 4 colores). */
function LogoGoogle() {
  return (
    <svg viewBox="0 0 48 48" style={{ width: 18, height: 18, flexShrink: 0 }} aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

// --- Login ---
function Login() {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // Sin red no hay forma de entrar: se dice claro en vez del "Load failed"
  // crudo de Safari (modo sin señal, 24-sep-2026).
  const enLinea = useEnLinea();

  const entrar = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    setBusy(true);
    salidaForzada = false;
    // .trim(): un espacio pegado al correo produce "Invalid login
    // credentials" sin ninguna pista para el usuario.
    const { error } = await sb.auth.signInWithPassword({
      email: email.trim(),
      password: pass,
    });
    setBusy(false);
    if (error) setErr(pareceSinRed(error) ? NECESITAS_SENAL : error.message);
  };

  const entrarConGoogle = async () => {
    setErr('');
    setMsg('');
    // Sin red, la redirección a Google acabaría en la página de error del
    // navegador, fuera de la app.
    if (!enLinea) {
      setErr(NECESITAS_SENAL);
      return;
    }
    salidaForzada = false;
    // OAuth redirige fuera de la app y vuelve; onAuthStateChange recoge la
    // sesión al regresar. redirectTo debe estar dado de alta en
    // Supabase → Authentication → URL Configuration.
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) setErr(pareceSinRed(error) ? NECESITAS_SENAL : error.message);
  };

  const recuperar = async () => {
    if (!email.trim()) {
      setErr('Escribe tu correo primero.');
      return;
    }
    setErr('');
    const { error } = await sb.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.href,
    });
    if (error)
      setErr(pareceSinRed(error) ? 'Necesitas señal para pedir el correo de recuperación.' : error.message);
    else setMsg('Te enviamos un correo para restablecer la contraseña.');
  };

  return (
    <div className="login">
      {/* <form>: así Enter envía desde cualquier campo. */}
      <form className="login-card" onSubmit={entrar}>
        <div className="logo">
          <LogoValla />
        </div>
        <h1>Central de Operaciones</h1>
        <div className="sub">
          GPO VALLAS · Incidencias · Comprobaciones · Monitoreo
          <br />
          Inicia sesión con tu correo corporativo
        </div>
        {!enLinea && !err && (
          <div className="banner" role="status">
            📴 Sin señal. {NECESITAS_SENAL}
          </div>
        )}
        {err && <div className="err">{err}</div>}
        {msg && <div className="ok-msg">{msg}</div>}
        <div className="field">
          <label>Correo</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="nombre@gpovallas.com"
            autoComplete="username"
          />
        </div>
        <div className="field">
          <label>Contraseña</label>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <button className="btn" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            margin: '16px 0 12px',
            color: 'var(--muted)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '.4px',
          }}
        >
          <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
          O CONTINÚA CON
          <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
        </div>

        <button
          type="button"
          className="btn ghost"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 9,
          }}
          onClick={entrarConGoogle}
        >
          <LogoGoogle />
          Continuar con Google
        </button>

        <button
          type="button"
          className="btn ghost sm"
          style={{ width: '100%', marginTop: 10 }}
          onClick={recuperar}
        >
          Olvidé mi contraseña
        </button>
      </form>
    </div>
  );
}

// --- Restablecer contraseña (tras el clic en el correo) ---
function UpdatePassword({ onDone }: { onDone: () => void }) {
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    // 6 caracteres es el mínimo que exige Supabase Auth por defecto.
    if (p1.length < 6) {
      setErr('La contraseña debe tener al menos 6 caracteres.');
      return;
    }
    if (p1 !== p2) {
      setErr('Las contraseñas no coinciden.');
      return;
    }
    setBusy(true);
    const { error } = await sb.auth.updateUser({ password: p1 });
    setBusy(false);
    if (error) setErr(error.message);
    else onDone();
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={guardar}>
        <div className="logo">🔑</div>
        <h1>Nueva contraseña</h1>
        <div className="sub">Escribe tu nueva contraseña para continuar.</div>
        {err && <div className="err">{err}</div>}
        <div className="field">
          <label>Nueva contraseña</label>
          <input
            type="password"
            value={p1}
            onChange={(e) => setP1(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="field">
          <label>Confirmar contraseña</label>
          <input
            type="password"
            value={p2}
            onChange={(e) => setP2(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <button className="btn" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar contraseña'}
        </button>
      </form>
    </div>
  );
}

/**
 * Cuenta autenticada pero sin rol en `usuario_roles`.
 *
 * Pasa sobre todo con Google: Supabase crea la cuenta al primer inicio de
 * sesión, pero eso NO da permisos — los permisos viven en usuario_roles y los
 * asigna un manager. Sin esta pantalla, la persona entraría a una app vacía
 * sin entender por qué.
 */
function SinAcceso({ email }: { email: string }) {
  return (
    <div className="login">
      <div className="login-card">
        <div className="logo">🔒</div>
        <h1>Falta darte acceso</h1>
        <div className="sub">
          Tu cuenta se creó correctamente, pero todavía no tiene permisos en la
          Central de Operaciones.
        </div>

        <div className="banner" style={{ marginBottom: 16 }}>
          Cuenta: <b>{email}</b>
        </div>

        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          Pídele a un administrador que te asigne un rol desde{' '}
          <b>Usuarios y roles</b>, indicándole tu correo tal como aparece
          arriba. En cuanto lo haga, vuelve a entrar.
        </p>

        <button
          className="btn"
          style={{ width: '100%', marginTop: 8 }}
          onClick={() => window.location.reload()}
        >
          Ya me dieron acceso — reintentar
        </button>
        <button
          className="btn ghost sm"
          style={{ width: '100%', marginTop: 10 }}
          onClick={() => sb.auth.signOut()}
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}

/** Entrada del menú lateral. `action` la convierte en botón, no en pestaña. */
type NavItem = {
  k: string;
  ic: string;
  t: string;
  badge?: number;
  action?: () => void;
};

// --- App principal (con sesión activa) ---
function Main({
  session,
  verificada,
  onSalidaForzada,
}: {
  session: Session;
  /**
   * false = la sesión es la guardada en el teléfono y auth-js todavía no la
   * confirma (arranque sin red con el token vencido). Main funciona igual;
   * solo no confía en respuestas que dependan de la sesión (ver roles).
   */
  verificada: boolean;
  /** "Salir" no pudo cerrar la sesión con auth-js (sin red): App va al Login. */
  onSalidaForzada: () => void;
}) {
  const email = (session.user.email || '').toLowerCase();
  // Roles: la copia del teléfono si la hay (listo al instante) y se
  // refrescan en segundo plano (modo sin señal, 24-sep-2026).
  const [copiaRoles] = useState(() => leerRolesGuardados(email));
  const [roles, setRoles] = useState<UsuarioRol[] | null>(copiaRoles);
  const [errRoles, setErrRoles] = useState('');
  const [ready, setReady] = useState(copiaRoles !== null);
  const [tab, setTab] = useState('dashboard');
  const enLinea = useEnLinea();
  /**
   * La pestaña que pide la URL al arrancar (/pauta → 'pauta'). Todavía no
   * se sabe si el usuario la TIENE en su menú: eso se decide cuando cargan
   * los roles (ver "Resolución de la ruta de arranque", junto al menú).
   * Un aviso push (?record=, ?ir=) la anula: su destino manda.
   */
  const [rutaPedida, setRutaPedida] = useState<string | null>(() =>
    tabDeRuta(window.location.pathname)
  );
  const [rutaResuelta, setRutaResuelta] = useState(false);
  /**
   * Ruta pedida que el menú de la COPIA de roles no tenía (revisión sin
   * señal, 24-sep-2026). Con copia, la ruta se resuelve al instante con
   * esos roles; si a este teléfono todavía no le llegaba un rol recién
   * dado (le mandan /pauta al volverlo monitorista), el enlace caía en su
   * pestaña de siempre y ya no se volvía a resolver. Se guarda aquí y, con
   * la primera respuesta buena de usuario_roles (rolesDeRed), se abre si
   * ahora sí está en su menú y el usuario no se movió. `desde` = la pestaña
   * en que lo dejó la resolución; `hasta` = después ya no se le mueve.
   */
  const rutaPendiente = useRef<{ tab: string; desde: string; hasta: number } | null>(null);
  const [rolesDeRed, setRolesDeRed] = useState(false);
  /**
   * Cómo escribe la siguiente sincronía pestaña → URL. La PRIMERA tras
   * arrancar reemplaza (no apila una entrada extra de "/" o de la URL del
   * aviso push); las demás apilan, para que Atrás regrese de pestaña.
   */
  const modoHistorial = useRef<'reemplazar' | 'apilar'>('reemplazar');
  const [actualizacionDisponible, setActualizacionDisponible] = useState(false);
  /** En qué va "Actualizar ahora" (revisión sin señal, 24-sep-2026; ver traerVersionNueva). */
  const [actualizando, setActualizando] = useState<
    '' | 'revisando' | 'descargando' | 'abriendo' | 'sinSenal'
  >('');
  const [focoRecordId, setFocoRecordId] = useState('');
  /**
   * Identidad estable para el callback del foco.
   *
   * Iba como flecha en línea (`onFocoAplicado={() => setFocoRecordId('')}`),
   * y eso creaba una función NUEVA en cada render de App. Como el efecto que
   * la consume la lleva en su lista de dependencias, se re-disparaba en cada
   * render —y App re-renderiza cada 25 s por el sondeo de notificaciones—.
   * Con `useCallback` el efecto corre cuando debe: al cambiar el foco.
   */
  const limpiarFoco = useCallback(() => setFocoRecordId(''), []);

  // Al cambiar de módulo se arranca ARRIBA, de inmediato y sin animación.
  // Llegar con el scroll de la vista anterior a un módulo que apenas está
  // en "Cargando…" obligaba a iOS a recolocar el scroll a media carga, y
  // la barra inferior daba un brinco antes de asentarse (Erik, 22-sep-2026).
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  // Qué módulo diferido está a la vista: una descarga que falle DESPUÉS de
  // salir de su pestaña ya no recarga la app a media captura en otra
  // (revisión primer mes, 24-sep-2026; ver src/lib/cargaDiferida.ts).
  useEffect(() => {
    fijarModuloEnPantalla(DIFERIDO_DE_TAB[tab] ?? null);
    return () => fijarModuloEnPantalla(null);
  }, [tab]);

  const [nuevaAbierta, setNuevaAbierta] = useState(false);
  /** Toques a "+ Nueva": entra en la llave del ErrorBoundary (ver la acción). */
  const [toquesNueva, setToquesNueva] = useState(0);
  // Contador que dispara la recarga de incidencias desde el botón ↻.
  const [recargarSignal, setRecargarSignal] = useState(0);
  /**
   * Solo el ↻ de la barra, para Indicadores (revisión primer mes,
   * 24-sep-2026). recargarSignal sube además con cada aviso nuevo (sondeo
   * de cada minuto) y con cada envío que sale de la cola: en Indicadores eso
   * volvería a bajar el periodo completo, de 1000 en 1000 filas, con cada
   * aviso, y es la pestaña de inicio de casi todos. Ahí basta el ↻ para
   * reintentar o refrescar.
   */
  const [recargaManual, setRecargaManual] = useState(0);
  // Lo reporta IncidenciasView: alimenta el badge de "Mi bandeja".
  const [bandejaCount, setBandejaCount] = useState(0);

  const notifs = useNotificaciones();

  // Una app instalada puede quedarse abierta durante días. Se avisa al volver
  // al frente o cada cinco minutos, pero no se recarga sin gesto: podría haber
  // una incidencia a medio capturar.
  useEffect(
    () => vigilarNuevaVersion(() => setActualizacionDisponible(true)),
    []
  );
  /**
   * La campana y la lista de incidencias consultan tablas distintas. Si se
   * actualizaba solo la campana, el validador veía el aviso pero la orden no
   * aparecía hasta tocar ↻. Este registro detecta los avisos NUEVOS (no los
   * que ya estaban sin leer al abrir la app) y dispara la recarga de lista.
   */
  const notifsVistas = useRef<Set<number> | null>(null);

  useEffect(() => {
    const actuales = new Set(notifs.notifs.map((n) => n.id));
    if (notifsVistas.current === null) {
      notifsVistas.current = actuales;
      return;
    }

    const hayNuevaIncidencia = notifs.notifs.some(
      (n) =>
        !notifsVistas.current?.has(n.id) &&
        n.evento !== 'chat' &&
        !!n.record_id
    );
    notifsVistas.current = actuales;

    // Solo refresca los datos: conserva pestaña, búsqueda y filtros del
    // validador. En "Mis pendientes" la nueva fila queda al inicio por
    // fecha_reporte descendente.
    if (hayNuevaIncidencia) setRecargarSignal((n) => n + 1);
  }, [notifs.notifs]);

  /** Enfoca una incidencia llegada por push: pestaña "todas" + foco. */
  const enfocarDesdePush = useCallback(
    (recordId: string) => {
      setTab('todas');
      setFocoRecordId(recordId);
      notifs.recargar();
    },
    // notifs.recargar es estable (useCallback en useNotificaciones).
    [notifs.recargar]
  );

  /** Eventos cuyo destino es Pauta y Monitoreo, no Incidencias. */
  const esEventoPauta = (e?: string | null) =>
    e === 'pauta_toma' || e === 'pauta_revision' || e === 'ruta';

  /** Eventos cuyo destino es la Bitácora VV (versión por programar / programada). */
  const esEventoBitacora = (e?: string | null) =>
    e === 'vv_version' || e === 'vv_programada';

  /** Abre Pauta RECARGADA: una lista ya abierta enseñaría la toma vieja. */
  const irAPauta = useCallback(() => {
    setTab('pauta');
    setRecargarSignal((n) => n + 1);
    notifs.recargar();
  }, [notifs.recargar]);

  /** Abre la Bitácora VV recargada: misma razón que irAPauta. */
  const irABitacora = useCallback(() => {
    setTab('bitacora_vv');
    setRecargarSignal((n) => n + 1);
    notifs.recargar();
  }, [notifs.recargar]);

  /**
   * Tocar una notificación push CON la app ya abierta.
   *
   * El service worker enfoca la ventana y manda este mensaje
   * (sw.js → notificationclick). Sin este listener, el postMessage caía al
   * vacío: la app solo pasaba al frente, sin navegar a la incidencia y con
   * la campana desactualizada hasta el siguiente sondeo (25 s).
   */
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.tipo !== 'notificacion-abierta') return;
      if (e.data.record_id) enfocarDesdePush(e.data.record_id);
      else if (esEventoPauta(e.data.evento)) irAPauta();
      else if (esEventoBitacora(e.data.evento)) irABitacora();
      else notifs.recargar();
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [enfocarDesdePush, irAPauta, irABitacora, notifs.recargar]);

  /**
   * Tocar una notificación push con la app CERRADA: el SW abre la app con
   * `?record=...` en la URL (no puede hacer postMessage a una ventana que
   * aún no existe). Se lee una vez al montar y se limpia la URL para que un
   * refresh no re-enfoque una incidencia vieja.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const record = params.get('record');
    const ir = params.get('ir');
    if (!record && !ir) return;
    // Se limpia la query SIN apilar. La ruta final (/incidencias, /pauta o
    // /bitacora-vv) la escribe la primera sincronía pestaña → URL, que
    // también reemplaza: el historial queda con UNA entrada, no con la URL
    // del aviso detrás (auditoría primer mes, 24-sep-2026).
    window.history.replaceState(null, '', window.location.pathname);
    // El destino del aviso manda sobre la ruta con que se abrió la app
    // (también sobre la que quedó pendiente de los roles de la red).
    if (record || ir === 'pauta' || ir === 'bitacora') {
      setRutaPedida(null);
      rutaPendiente.current = null;
    }
    if (record) enfocarDesdePush(record);
    // `?ir=pauta`: push de pauta con la app cerrada (toma regresada, por
    // comprobar, ruta asignada) — aterriza directo en su pestaña.
    else if (ir === 'pauta') irAPauta();
    // `?ir=bitacora`: push de la Bitácora VV con la app cerrada.
    else if (ir === 'bitacora') irABitacora();
    // Solo al montar: el parámetro llega únicamente en el arranque.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Roles con copia en el teléfono (modo sin señal, 24-sep-2026).
   *
   * Reglas al refrescar:
   *   · con filas → se guardan y se usan;
   *   · [] SIN error y CON sesión real → se borra la copia y SinAcceso,
   *     como siempre;
   *   · sin sesión real → NO se consulta: al volver la red hay hasta ~60 s
   *     en que auth-js aún no renueva el token, la consulta saldría como
   *     anon y la RLS respondería [] SIN ser verdad (mandaría a SinAcceso a
   *     un usuario con permisos);
   *   · error de red (o 401/5xx) → se queda la copia;
   *   · otro error → errRoles, como antes (si hay copia, el menú sigue).
   * Se refresca al montar, cuando auth-js confirma o renueva la sesión
   * (cambia el access_token: TOKEN_REFRESHED) y, si el último intento no
   * salió, al volver la red o la app a primer plano.
   */
  const rolesRef = useRef<UsuarioRol[] | null>(roles);
  rolesRef.current = roles;
  const errRolesRef = useRef('');
  errRolesRef.current = errRoles;
  /** access_token con que salió bien la última consulta (evita repetirla). */
  const tokenRolesOk = useRef<string | null>(null);
  const rolesEnCurso = useRef(false);
  /** Llegó otro disparo mientras corría una consulta: se repite al terminar. */
  const rolesOtraVez = useRef(false);

  const refrescarRoles = useCallback(async (): Promise<void> => {
    if (rolesEnCurso.current) {
      rolesOtraVez.current = true;
      return;
    }
    rolesEnCurso.current = true;
    rolesOtraVez.current = false;
    try {
      const hayCopia = !!rolesRef.current && rolesRef.current.length > 0;
      // Sesión REAL: la que auth-js confirma (vigente o ya renovada). Con
      // tope: sin red y con el token vencido getSession tarda ~25 s.
      const r = await conTope(sb.auth.getSession(), TOPE_SESION_MS, null);
      const real = r?.data.session ?? null;
      if (!real || (real.user.email || '').toLowerCase() !== email) {
        if (!hayCopia) {
          // Sin copia y sin sesión confirmada: no hay de dónde sacar el
          // menú. Se avisa y se reintenta solo (online / TOKEN_REFRESHED).
          setErrRoles(
            'Sin señal: no se pudieron cargar tus permisos. Se cargan solos al volver la red.'
          );
          setRoles((prev) => prev ?? []);
          setReady(true);
        }
        return;
      }
      if (tokenRolesOk.current === real.access_token) return;

      // Con copia no hace falta insistir: sin reintentos y con tope corto.
      // Sin copia, los reintentos de siempre, pero con un tope para que una
      // señal colgada no deje "Cargando tu perfil…" para siempre.
      // (No se pide `medio`: agregarlo cambia quién ve Fijación/Pauta; lo
      // decide Erik — ver enEcovallasImpreso.)
      const q = sb
        .from('usuario_roles')
        .select('rol,unidad_negocio,departamento')
        .ilike('usuario_email', email);
      const { data, error, status } =
        hayCopia || !enLineaAhora()
          ? await q.retry(false).abortSignal(tope(TOPE_ROLES_CON_COPIA_MS))
          : await q.abortSignal(tope(TOPE_ROLES_SIN_COPIA_MS));

      if (error) {
        const transitorio = pareceSinRed(error, status) || status === 401 || status >= 500;
        if (hayCopia && transitorio) return; // se queda la copia
        // Distinguir "falló la consulta" de "no tiene roles": si no, un error
        // de red o RLS se ve como "no tienes rol asignado" y manda al usuario
        // a pedir un alta que no necesita.
        setErrRoles(
          transitorio
            ? 'Sin señal: no se pudieron cargar tus permisos. Se cargan solos al volver la red.'
            : 'usuario_roles: ' + error.message
        );
        setRoles((prev) => (prev && prev.length ? prev : []));
        setReady(true);
        return;
      }

      const filas = (data as UsuarioRol[]) || [];
      tokenRolesOk.current = real.access_token;
      if (filas.length) guardarRoles(email, filas);
      else borrarRolesGuardados(email);
      // Si se estaba con el menú de emergencia (falló sin copia), la ruta de
      // arranque se vuelve a resolver con el menú de verdad: la URL no se
      // tocó mientras tanto. Con copia NO: movería al usuario de pestaña.
      if (!rolesRef.current || rolesRef.current.length === 0) setRutaResuelta(false);
      setErrRoles('');
      setRoles((prev) => (mismosRoles(prev, filas) ? prev : filas));
      setReady(true);
      // En el MISMO render que los roles nuevos: ahí se decide la ruta que
      // la copia no tenía (ver rutaPendiente).
      setRolesDeRed(true);
    } finally {
      rolesEnCurso.current = false;
      if (rolesOtraVez.current) {
        rolesOtraVez.current = false;
        window.setTimeout(() => void refrescarRolesRef.current(), 0);
      }
    }
  }, [email]);
  const refrescarRolesRef = useRef(refrescarRoles);
  refrescarRolesRef.current = refrescarRoles;

  // Al montar y cada vez que auth-js confirma o renueva la sesión.
  useEffect(() => {
    void refrescarRoles();
  }, [refrescarRoles, session.access_token, verificada]);

  // Si el último intento no salió: al volver la red o la app al frente.
  useEffect(() => {
    const reintentar = () => {
      if (document.visibilityState !== 'visible') return;
      if (tokenRolesOk.current && !errRolesRef.current) return;
      void refrescarRoles();
    };
    window.addEventListener('online', reintentar);
    document.addEventListener('visibilitychange', reintentar);
    return () => {
      window.removeEventListener('online', reintentar);
      document.removeEventListener('visibilitychange', reintentar);
    };
  }, [refrescarRoles]);

  /**
   * Derivados de los roles con identidad ESTABLE (app pasmada sin señal,
   * 24-sep-2026). Eran arreglos nuevos en cada render de Main: cada
   * setNuevaAbierta, aviso o badge rehacía en IncidenciasView la bandeja,
   * las alertas de SLA y las 150 tarjetas (60-75 ms en escritorio, varias
   * veces más en iPhone). La llave es TEXTO y no el arreglo `roles`: roles
   * también se arma con updaters (`prev ?? []`), y un updater re-aplicado
   * da un arreglo nuevo con el mismo contenido.
   */
  const firmaRoles = JSON.stringify(roles ?? null);
  const misRoles = useMemo(
    () => [...new Set((roles || []).map((r) => r.rol))] as string[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [firmaRoles]
  );
  const misDep = useMemo(
    () =>
      [...new Set((roles || []).map((r) => r.departamento).filter(Boolean))] as string[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [firmaRoles]
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rolesDetalle = useMemo(() => roles || [], [firmaRoles]);
  const role = ROLE_PRIORITY.find((r) => misRoles.includes(r)) || 'viewer';

  /**
   * ¿SOLO monitorista? Entonces su app es Pauta y Monitoreo y nada más:
   * ni indicadores ni bandejas — el monitoreo va separado de la
   * reparación (Erik, 21-sep-2026). Si además tiene otro rol, ese rol
   * abre lo suyo con normalidad.
   */
  const esMonitoristaPuro =
    misRoles.length > 0 && misRoles.every((r) => r === 'monitorista');

  /**
   * Mismo criterio para la dupla de la Bitácora VV: si SOLO es comercial
   * y/o pautas, los indicadores de reparación no son su mundo — su app
   * empieza en la bitácora.
   */
  const esBitacoraPuro =
    misRoles.length > 0 &&
    misRoles.every((r) => r === 'comercial' || r === 'pautas');

  /**
   * Su pestaña de inicio es la suya, no un dashboard que no ve. También es
   * a donde cae una ruta que el usuario no tiene en su menú.
   *
   * Antes era un efecto que, con los roles ya cargados, cambiaba
   * 'dashboard' por 'pauta'/'bitacora_vv'. Ahora lo aplica la resolución de
   * la ruta (más abajo, junto al menú) en el MISMO render en que llegan los
   * roles: una ruta válida pedida por URL (p. ej. /biobox) no se pisa, y el
   * monitorista ya no monta un instante Indicadores —que además pediría su
   * chunk— antes de saltar a Pauta (auditoría primer mes, 24-sep-2026).
   */
  const tabDeSiempre = esMonitoristaPuro
    ? 'pauta'
    : esBitacoraPuro
      ? 'bitacora_vv'
      : 'dashboard';
  const nombre =
    (session.user.user_metadata?.name as string) || email.split('@')[0];

  // manager es comodín: puede lo que puede cualquier otro rol.
  const has = (r: string) => misRoles.includes(r) || misRoles.includes('manager');

  /**
   * Unidades del usuario, para acotar módulos y filtros. Una fila sin
   * unidad (= todas), el manager o el viewer abren la lista completa.
   */
  const tieneTodasLasUnidades =
    misRoles.includes('manager') ||
    misRoles.includes('viewer') ||
    (roles || []).some((r) => !r.unidad_negocio);
  // Misma llave que misRoles (ver firmaRoles): la lista filtrada era nueva
  // en cada render.
  const misUnidades = useMemo(
    () =>
      tieneTodasLasUnidades
        ? UNIDADES
        : UNIDADES.filter((u) =>
            (roles || []).some(
              (r) => (r.unidad_negocio || '').toLowerCase() === u.toLowerCase()
            )
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [firmaRoles]
  );

  /**
   * Copias de datos en el teléfono (inventario, catálogos, árbol Digital…)
   * para buscar sitios, validar y reparar sin señal (modo sin señal,
   * 24-sep-2026; src/lib/datosLocales.ts). Arranca en cuanto hay roles —de
   * la copia o de la red— y se detiene al salir o cambiar de usuario o de
   * unidades. null = todas las unidades. Ella misma decide cuándo bajar
   * (con red y sesión real, solo lo que esté viejo).
   */
  const conAcceso = ready && !!roles && roles.length > 0;
  const unidadesSync = tieneTodasLasUnidades ? '*' : misUnidades.join('|');
  useEffect(() => {
    if (!conAcceso) return;
    pedirAlmacenamientoPersistente();
    let detener: (() => void) | null = null;
    try {
      detener = iniciarSincronizacion({
        email,
        unidades: unidadesSync === '*' ? null : unidadesSync ? unidadesSync.split('|') : [],
      });
    } catch (e) {
      // Una copia que no arranca no debe tumbar la app: se trabaja con red.
      console.error('[datosLocales] no arrancó la sincronización:', e);
    }
    return () => {
      try {
        detener?.();
      } catch {
        /* nada que detener */
      }
    };
  }, [conAcceso, email, unidadesSync]);

  /**
   * Fijación Externa y Pauta y Monitoreo son operación de Ecovallas
   * IMPRESO (Erik, ago-2026): los ve quien tenga alguna fila en esa unidad
   * cuyo medio no lo excluya. `medio` solo existe en filas de validador
   * (null = ambos medios), así que a los demás roles solo se les pide la
   * unidad. Fila sin unidad = todas; manager pasa.
   */
  const enEcovallasImpreso =
    misRoles.includes('manager') ||
    (roles || []).some(
      (r) =>
        (!r.unidad_negocio || /^ecovallas$/i.test(r.unidad_negocio.trim())) &&
        (!r.medio || /^impreso$/i.test(r.medio.trim()))
    );

  /**
   * ¿Este usuario pertenece a la unidad Biobox? El módulo de máquinas es DE
   * esa unidad: quien solo opera Ecovallas/Vía Verde no tiene nada que hacer
   * ahí (Erik, ago-2026). Una fila sin unidad (= todas) o el manager pasan.
   * Cubre "Biobox" y "Biobox Perú" con el mismo prefijo.
   */
  const enBiobox =
    misRoles.includes('manager') ||
    (roles || []).some(
      (r) => !r.unidad_negocio || /^biobox/i.test(r.unidad_negocio.trim())
    );

  /**
   * LA confirmación de salir vive AQUÍ, una sola vez, y los dos botones que
   * cierran sesión —el del menú del avatar y el de la barra de escritorio—
   * llaman a esta misma función.
   *
   * La primera versión puso el confirm dentro de MenuUsuario, y el botón de
   * escritorio quedó sin él: mismo texto, mismo icono, distinta conducta
   * según por dónde salieras (lo cachó Erik, 29-ago-2026). Cuando una
   * conducta tiene que ser idéntica en dos lugares, no se copia — se
   * centraliza, y el gemelo no puede volver a divergir.
   *
   * La pantalla de "sin acceso" NO usa esto a propósito: ahí cerrar sesión
   * es la salida esperada y preguntarlo solo estorbaría.
   *
   * SIN SEÑAL (modo sin señal, 24-sep-2026):
   *   · Si hay envíos o acciones en cola, el aviso dice que se quedan en el
   *     teléfono y se mandan al volver a entrar con ESTA cuenta (la cola es
   *     por correo; con otra cuenta no salen).
   *   · Con el token vencido y sin red, auth-js no cierra nada: signOut
   *     devuelve el error de la renovación fallida (o tarda ~25 s) y el
   *     usuario creía haber salido. Ahora, si falla o no contesta a tiempo,
   *     se borra la sesión del teléfono a mano y se va al Login. Con la
   *     sesión sin confirmar, directo a mano, sin signOut (ver abajo).
   *   · Se borran la copia de roles y la lista guardada de esta cuenta
   *     (teléfonos compartidos). La cola NO: se manda al volver a entrar.
   */
  const salir = async () => {
    // Lo pendiente de ESTA cuenta, con tope: una IndexedDB colgada no debe
    // trabar el botón.
    const contar = async () => {
      const [envios, acciones] = await Promise.all([
        listarPendientes(email).then((l) => l.length).catch(() => 0),
        accionesPendientes(email).then((l) => l.length).catch(() => 0),
      ]);
      return envios + acciones;
    };
    const pendientes = await conTope(contar(), 2000, -1);
    const enRiesgo = (() => {
      try {
        return hayEnviosEnRiesgo();
      } catch {
        return false;
      }
    })();
    let texto = '¿Deseas salir de la app?';
    if (pendientes !== 0 || enRiesgo) {
      const cuantos =
        pendientes > 0
          ? `Tienes ${pendientes === 1 ? '1 envío pendiente' : `${pendientes} envíos pendientes`} en este teléfono.`
          : 'Puede que tengas envíos pendientes en este teléfono.';
      texto =
        `${cuantos} Se quedan guardados y se mandan solos cuando vuelvas a entrar con esta cuenta (${email}).` +
        (enRiesgo
          ? '\n\nOjo: uno se está enviando ahora o no cupo en el teléfono; si cierras la app se puede perder.'
          : '') +
        '\n\n¿Salir de todos modos?';
    }
    if (!confirm(texto)) return;
    borrarRolesGuardados(email);
    void borrarListaLocal(email);
    // Sin sesión confirmada NO se llama signOut() (revisión sin señal,
    // 24-sep-2026): la inicialización de auth-js puede seguir reintentando
    // renovar el token sin red (~25-60 s) y signOut la espera. Colgado tras
    // el tope, corría al terminar la inicialización, leía la sesión que
    // hubiera ENTONCES —la de quien acabara de entrar en este teléfono— y
    // la revocaba en el servidor con scope global. Aquí se sale solo en el
    // teléfono: la renovación vieja la descarta auth-js al ver la clave
    // borrada, y la que se cuele la cierra salidaForzada. Con la sesión
    // confirmada la inicialización ya terminó y signOut lee la de ESTA
    // cuenta al empezar; si el servidor tarda más del tope, lo colgado a lo
    // más cierra en este teléfono una sesión abierta en ese rato (no revoca
    // otra cuenta).
    const resultado = verificada
      ? await conTope(
          sb.auth.signOut().then(({ error }) => (error ? 'error' : 'ok')),
          TOPE_SALIR_MS,
          'tope' as const
        )
      : ('local' as const);
    if (resultado !== 'ok') {
      borrarSesionGuardada();
      onSalidaForzada();
    }
    // Otra vez ya fuera de Main: al desmontarse, IncidenciasView escribe la
    // copia que tuviera pendiente y la volvería a dejar.
    setTimeout(() => void borrarListaLocal(email), 2000);
  };

  const esTabIncidencias = tab === 'bandeja' || tab === 'todas';

  const nav: NavItem[] = [
    has('reportante') && {
      k: 'nueva',
      ic: '➕',
      t: 'Nueva',
      action: () => {
        // Si no estamos en una pestaña de incidencias hay que ir a una:
        // el modal lo renderiza IncidenciasView (es quien sabe insertar).
        if (!esTabIncidencias) setTab('todas');
        // Ya en Incidencias no hay cambio de pestaña y no se apilaba nada:
        // si esa era la ÚNICA entrada del documento (app abierta por un
        // push, o recargada en /incidencias), Atrás cerraba la app —o
        // volvía al documento anterior— sin pasar por la protección de
        // onPop, y el alta en memoria se perdía. Una entrada propia,
        // apilada con el toque del usuario, deja debajo otra del MISMO
        // documento (revisión primer mes, 24-sep-2026).
        else if (!nuevaAbierta)
          window.history.pushState({ alta: MARCA_ALTA }, '', window.location.pathname);
        setNuevaAbierta(true);
        // Cada toque cambia la llave del ErrorBoundary: si el vigía cortó el
        // alta (AppPasmada), `nuevaAbierta` seguía en true y "+ Nueva" ya no
        // hacía nada mientras estaba el aviso de error (verificación del
        // blindaje, 24-sep-2026).
        setToquesNueva((n) => n + 1);
      },
    },
    (has('validador') || has('reparacion') || has('reportante')) && {
      k: 'bandeja',
      ic: '📥',
      // Para quien ACCIONA (validador/técnico) la bandeja es su lista de
      // trabajo y así se llama: "Mis pendientes" — lo cerrado se consulta
      // en Incidencias. El reportante puro conserva "Mi bandeja": la suya
      // enseña TODAS sus capturas, no solo lo accionable (Erik, ago-2026).
      t:
        has('validador') || has('reparacion')
          ? 'Mis pendientes'
          : 'Mi bandeja',
      badge: bandejaCount,
    },
    // El técnico también entra a Incidencias: ahí vive su HISTORIAL — las
    // reparadas y cerradas de sus áreas, que la bandeja de pendientes ya no
    // enseña. Sin esto, al cerrar una orden la perdía de vista para siempre.
    // El viewer también: consulta pura sin hurgar KPI por KPI (Erik, 2-sep-2026).
    (has('manager') ||
      has('validador') ||
      has('coordinador') ||
      has('reparacion') ||
      has('viewer')) && {
      k: 'todas',
      ic: '🗂️',
      t: 'Incidencias',
    },
    // Indicadores no es del monitorista puro ni de comercial/pautas puros:
    // mide reparación y carga de áreas, trabajo que no es el suyo.
    !esMonitoristaPuro && !esBitacoraPuro && { k: 'dashboard', ic: '📊', t: 'Indicadores' },
    // Disponibilidad nació para comercial cuando aún no tenía rol propio;
    // desde el 22-sep-2026 el rol `comercial` existe (Bitácora VV) y entra
    // por derecho propio. Viewer sigue: es el rol de quien solo consulta.
    (has('manager') || has('coordinador') || has('comercial') || has('viewer')) && {
      k: 'disponibilidad',
      ic: '🔎',
      t: 'Disponibilidad',
    },
    // Bitácora de Vía Verde: comercial captura campañas y cambios de
    // versión; pautas los programa. Sustituye el Excel "BITACORA <MES>"
    // que viajaba por correo (Erik, 22-sep-2026).
    (has('manager') || has('comercial') || has('pautas')) && {
      k: 'bitacora_vv',
      ic: '🛣️',
      t: 'Bitácora VV',
    },
    // Fijación Externa es operación de Ecovallas Impreso. El coordinador
    // ya no la ve: gestiona pauta y rutas, la fijación es de los técnicos
    // (Erik, 21-sep-2026).
    (has('manager') || has('reparacion')) &&
      enEcovallasImpreso && {
        k: 'fijacion_externa',
        ic: '📎',
        t: 'Fijación Externa',
      },
    (has('manager') || has('coordinador')) && {
      k: 'rutas',
      ic: '🗺️',
      t: 'Rutas de Monitoreo',
    },
    // Trabajo de campo sobre la pauta: del MONITORISTA (rol propio desde
    // el 21-sep-2026) y del fijador, que recorre las mismas rutas. El
    // técnico de reparación YA NO la ve: su trabajo es otro y mezclarlos
    // empalmaba funciones (antes se le daba 'reparacion' al monitorista
    // por no existir su rol). Pauta y Monitoreo es de Ecovallas Impreso.
    (has('manager') ||
      has('coordinador') ||
      has('monitorista') ||
      has('fijador')) &&
      enEcovallasImpreso && {
        k: 'pauta',
        ic: '📋',
        t: 'Pauta y Monitoreo',
      },
    // Revisión de máquinas Biobox. La lista es a propósito más amplia que la
    // de Pauta: además de quien administra y quien repara, revisa el
    // monitorista (reportante) —es quien levanta la incidencia desde el
    // checklist— y el fijador, que recorre las mismas rutas.
    (has('manager') ||
      has('coordinador') ||
      has('reparacion') ||
      has('reportante') ||
      has('fijador')) &&
      enBiobox && {
        k: 'biobox',
        ic: '♻️',
        t: 'Máquinas Biobox',
      },
    // Usuarios NO usa has(): solo el manager real, no por comodín.
    // La RLS (ur_manager_all / usr_write) exige manager de todos modos.
    misRoles.includes('manager') && { k: 'usuarios', ic: '👥', t: 'Usuarios' },
  ].filter(Boolean) as NavItem[];

  // ---- Rutas por URL (auditoría primer mes, 24-sep-2026) ----------------

  /** Pestañas del menú de ESTE usuario que tienen ruta. Solo esas abre una URL. */
  const tabsConRuta = nav
    .filter((n) => !n.action && RUTA_DE_TAB[n.k])
    .map((n) => n.k);
  // Texto estable para las dependencias: `nav` es un arreglo nuevo en cada render.
  const clavesConRuta = tabsConRuta.join('|');

  /**
   * Resolución de la ruta de arranque, en el MISMO render en que llegan los
   * roles (patrón de React "ajustar estado al renderizar"): React descarta
   * este render y repinta con la pestaña buena antes de mostrar nada, así
   * que nunca se monta —ni se descarga— un módulo que no toca.
   *   · Ruta que el usuario TIENE en su menú → esa pestaña.
   *   · Si no, la de siempre; pero si un aviso push ya eligió pestaña antes
   *     de que cargaran los roles (?record= → 'todas'), esa se respeta.
   * Cerrar sesión y volver a entrar remonta Main: la ruta actual se vuelve
   * a leer y, si es válida para la cuenta nueva, se respeta.
   */
  if (ready && !rutaResuelta) {
    setRutaResuelta(true);
    if (rutaPedida && tabsConRuta.includes(rutaPedida)) {
      setTab(rutaPedida);
      rutaPendiente.current = null;
    } else {
      setTab((t) => (t === 'dashboard' ? tabDeSiempre : t));
      // Resuelta con roles que la red aún no confirma (la copia): la pedida
      // se vuelve a probar cuando lleguen (revisión sin señal, 24-sep-2026).
      rutaPendiente.current =
        rutaPedida && tokenRolesOk.current === null
          ? {
              tab: rutaPedida,
              desde: tab === 'dashboard' ? tabDeSiempre : tab,
              hasta: Date.now() + RUTA_PENDIENTE_MS,
            }
          : null;
    }
  }

  /**
   * La URL solo se toca con menú de verdad. En "Falta darte acceso" o si
   * falló la consulta de roles se deja como llegó: al recargar (o cuando le
   * den acceso) el enlace /pauta sigue abriendo Pauta. Con los roles de la
   * copia del teléfono el menú SÍ es de verdad, aunque el refresco haya
   * fallado (modo sin señal, 24-sep-2026): ahí roles no viene vacío.
   */
  const rutasActivas = conAcceso;

  /**
   * Los roles refrescados pueden quitar una pestaña que la copia del
   * teléfono sí tenía (le cambiaron el rol mientras tanto): si la que está
   * a la vista ya no es de su menú, a la de siempre. Incidencias no se toca:
   * "Nueva" lleva al reportante puro a 'todas' aunque no esté en su menú.
   */
  useEffect(() => {
    if (!rutaResuelta || !rutasActivas) return;
    if (tab === 'bandeja' || tab === 'todas' || !RUTA_DE_TAB[tab]) return;
    if (!clavesConRuta.split('|').includes(tab)) setTab(tabDeSiempre);
    // Solo cuando cambia el menú, no en cada cambio de pestaña.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clavesConRuta]);

  /**
   * Primera respuesta buena de usuario_roles: la ruta que la copia no tenía
   * se abre si ahora SÍ está en el menú, el usuario sigue en la pestaña en
   * que lo dejó la resolución y no ha pasado RUTA_PENDIENTE_MS. Se usa o se
   * descarta una sola vez (revisión sin señal, 24-sep-2026). Va DESPUÉS del
   * efecto de arriba: si ese manda a la de siempre, este gana. La URL se
   * REEMPLAZA, como si el enlace hubiera abierto así desde el principio.
   */
  useEffect(() => {
    const p = rutaPendiente.current;
    if (!rolesDeRed || !p) return;
    rutaPendiente.current = null;
    if (Date.now() > p.hasta || tab !== p.desde || tab === p.tab) return;
    if (!rutasActivas || !clavesConRuta.split('|').includes(p.tab)) return;
    modoHistorial.current = 'reemplazar';
    setTab(p.tab);
    // Solo al llegar los roles de la red.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rolesDeRed]);

  // Refs para el manejador de popstate, que vive fuera del ciclo de render.
  // El alta solo cuenta como abierta si se VE: `nuevaAbierta` puede quedarse
  // en true si se salió de Incidencias por la campana con el alta abierta, y
  // entonces bloquearía el Atrás en un módulo sin alta a la vista.
  const tabActual = useRef(tab);
  const altaVisible = useRef(false);
  useEffect(() => {
    tabActual.current = tab;
    altaVisible.current = nuevaAbierta && esTabIncidencias;
  }, [tab, nuevaAbierta, esTabIncidencias]);
  /** El siguiente popstate es el history.back() de cerrarNueva: se ignora. */
  const ignorarPop = useRef(false);

  /**
   * Cierra el alta con sus propios botones (Cancelar, o al guardar). Si
   * "Nueva" apiló su entrada y sigue siendo la actual, se consume con
   * history.back(): si no, el siguiente Atrás caería en la misma pestaña y
   * parecería no hacer nada. Ese popstate se ignora: la entrada de abajo es
   * de la misma pestaña, y onPop, con el alta aún "visible" en su ref,
   * volvería a apilar (revisión primer mes, 24-sep-2026).
   */
  const cerrarNueva = () => {
    setNuevaAbierta(false);
    if (window.history.state?.alta === MARCA_ALTA) {
      ignorarPop.current = true;
      window.history.back();
    }
  };

  /**
   * Pestaña → URL. Todos los setTab (menú, irAPauta, irABitacora,
   * enfocarDesdePush, la campana, "Nueva") quedan sincronizados aquí sin
   * tocar su lógica. La query no se conserva: ?record= e ?ir= ya se
   * consumieron al montar.
   */
  useEffect(() => {
    if (!rutasActivas) return;
    const ruta = RUTA_DE_TAB[tab];
    // Pestaña sin ruta (el prototipo local): la URL se queda como está.
    if (!ruta) return;
    const { pathname, search, hash } = window.location;
    const reemplazar = modoHistorial.current === 'reemplazar';
    modoHistorial.current = 'apilar';
    if (pathname === ruta) {
      // Misma pestaña; solo se limpia lo que sobre, sin apilar.
      if (search || hash) window.history.replaceState(null, '', ruta);
      return;
    }
    if (reemplazar) window.history.replaceState(null, '', ruta);
    else window.history.pushState(null, '', ruta);
  }, [tab, rutasActivas]);

  /**
   * URL → pestaña (Atrás / Adelante). Con esto el botón Atrás de Android
   * regresa a la pestaña anterior en vez de cerrar la app.
   */
  useEffect(() => {
    if (!rutasActivas) return;
    // La app ya sube arriba al cambiar de pestaña (efecto de scroll de
    // arriba); que el navegador no intente además restaurar el scroll de
    // la entrada sobre un módulo que apenas está en "Cargando…".
    try {
      window.history.scrollRestoration = 'manual';
    } catch {
      /* navegador sin soporte: se queda el comportamiento por omisión */
    }
    const validas = clavesConRuta.split('|');
    const onPop = () => {
      if (ignorarPop.current) {
        ignorarPop.current = false;
        return;
      }
      // Con el alta abierta, Atrás NO la tira: antes cerraba la app y ahora
      // cambiaría de pestaña, y en ambos casos se perdían fotos y GPS ya
      // capturados. Se devuelve la entrada y el alta sigue ahí; se sale
      // con su propio botón de cerrar.
      if (altaVisible.current) {
        const ruta = RUTA_DE_TAB[tabActual.current];
        // Si se regresó a una entrada de la MISMA pestaña, la que se vuelve
        // a apilar lleva la marca del alta: así cerrarNueva la consume con
        // history.back() y no queda un Atrás muerto. Si la de abajo es de
        // otra pestaña va sin marca: ahí un back() dejaría la URL de esa
        // pestaña con Incidencias en pantalla (revisión primer mes,
        // 24-sep-2026).
        const mismaPestana = tabDeRuta(window.location.pathname) === tabActual.current;
        if (ruta)
          window.history.pushState(mismaPestana ? { alta: MARCA_ALTA } : null, '', ruta);
        return;
      }
      const pedida = tabDeRuta(window.location.pathname);
      if (pedida && validas.includes(pedida)) {
        setTab(pedida);
        return;
      }
      // Una entrada que no es de su menú (otra cuenta en este navegador,
      // una ruta vieja): va a su pestaña de siempre, REEMPLAZANDO la
      // entrada para no dejar basura en el historial.
      const ruta = RUTA_DE_TAB[tabDeSiempre];
      if (ruta) window.history.replaceState(null, '', ruta);
      setTab(tabDeSiempre);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [rutasActivas, clavesConRuta, tabDeSiempre]);

  if (!ready) return <div className="loading">Cargando tu perfil…</div>;
  // Sin roles Y sin error de consulta = la cuenta existe pero nadie le ha
  // dado permisos. Se atiende antes de pintar el menú: no tiene caso mostrar
  // pestañas que estarían vacías.
  if (!errRoles && roles && roles.length === 0)
    return <SinAcceso email={email} />;

  const irANav = (n: NavItem) => (n.action ? n.action() : setTab(n.k));

  const recargarTodo = () => {
    // Primero la sesión: las recargas de abajo esperan su getSession y, con
    // la falla de hace un rato guardada, saldrían sin sesión hasta 60 s
    // (ver renovarSesionYa).
    renovarSesionYa();
    setRecargarSignal((n) => n + 1);
    setRecargaManual((n) => n + 1);
    notifs.recargar();
  };

  return (
    <div>
      <div className="topbar">
        <div className="brand">
          <div className="logo">
            <LogoValla />
          </div>
          <div>
            <h1>Central de Operaciones</h1>
            <div className="sub">GPO VALLAS</div>
          </div>
        </div>
        <div className="who">
          <button
            className="btn ghost sm"
            onClick={recargarTodo}
            title="Recargar"
          >
            ↻
          </button>
          <BotonPush email={email} />
          <CampanaNotifs
            notifs={notifs.notifs}
            noLeidas={notifs.noLeidas}
            error={notifs.error}
            onMarcarTodas={notifs.marcarTodas}
            onIr={(n) => {
              notifs.marcarLeida(n.id);
              if (n.record_id) {
                // Se manda a la lista completa y se enfoca por record_id:
                // el folio lo pone un trigger y la notificación no lo trae.
                setTab('todas');
                setFocoRecordId(n.record_id);
              } else if (esEventoPauta(n.evento)) {
                // Toma regresada / por comprobar / ruta asignada: el
                // destino es Pauta, RECARGADA — una lista ya abierta
                // seguía enseñando la toma vieja.
                setTab('pauta');
                setRecargarSignal((x) => x + 1);
              } else if (esEventoBitacora(n.evento)) {
                // Versión por programar / programada: a la Bitácora VV,
                // también recargada.
                setTab('bitacora_vv');
                setRecargarSignal((x) => x + 1);
              }
            }}
          />
          <div className="info">
            <div className="n">{nombre}</div>
            <div className="r">
              {ROLE_ICON[role]}{' '}
              {misRoles.map((r) => ROLE_LABEL[r] || r).join(' · ') ||
                ROLE_LABEL[role]}
            </div>
          </div>
          {/* El avatar es el único lugar donde el rol se puede consultar
              desde el celular: ahí `.who .info` se oculta por espacio. */}
          <MenuUsuario
            nombre={nombre}
            email={email}
            iniciales={initials(nombre)}
            role={role}
            misRoles={misRoles}
            misDep={misDep}
            onSalir={salir}
          />
          {/* En celular «Salir» vive dentro del menú del avatar: aquí solo
              ocupaba espacio en la barra más apretada. */}
          <button className="btn ghost sm solo-escritorio" onClick={salir}>
            Salir
          </button>
        </div>
      </div>

      {/* Sin señal (modo sin señal, 24-sep-2026): que se sepa que se trabaja
          con lo guardado y que lo capturado no se pierde. */}
      {!enLinea && (
        <div className="banner" style={{ margin: '10px 16px 0' }} role="status">
          📴 Sin señal: trabajas con lo guardado en el teléfono. Lo que hagas se
          envía solo al volver la red.
        </div>
      )}

      {actualizacionDisponible && (
        <div className="banner" style={{ margin: '10px 16px 0' }} role="status">
          {actualizando === 'revisando'
            ? 'Buscando la versión nueva…'
            : actualizando === 'descargando'
              ? 'Descargando la versión nueva… con poca señal puede tardar hasta un minuto.'
              : actualizando === 'abriendo'
                ? 'Abriendo la versión nueva…'
                : actualizando === 'sinSenal'
                  ? 'Hay una versión nueva, pero necesitas señal para bajarla. Inténtalo cuando tengas señal.'
                  : 'Hay una versión nueva de la app.'}
          {/* Un reporte que se está enviando o que no cupo en el teléfono
              se perdería con la recarga: se pregunta antes (integración
              primer mes, 24-sep-2026). Ya no es un reload a secas: con
              señal lenta el SW volvía a servir la versión vieja; ver
              traerVersionNueva (revisión sin señal, 24-sep-2026). */}
          <button
            className="btn sm"
            style={{ marginLeft: 10 }}
            disabled={
              actualizando === 'revisando' ||
              actualizando === 'descargando' ||
              actualizando === 'abriendo'
            }
            onClick={async () => {
              if (!confirmarRecargaConEnvios()) return;
              setActualizando('revisando');
              const r = await traerVersionNueva(setActualizando, confirmarRecargaConEnvios);
              if (r === 'sinSenal') setActualizando('sinSenal');
              else if (r === 'cancelada') setActualizando('');
            }}
          >
            Actualizar ahora
          </button>
        </div>
      )}

      {/* Aviso de envíos que no han salido (frente B, auditoría primer mes).
          Vive en el armazón, no en un módulo: debe verse desde cualquier
          pestaña. Al salir uno, se recargan las listas como con ↻. */}
      <EnviosPendientes
        email={email}
        onEnviado={() => setRecargarSignal((n) => n + 1)}
      />

      <div className="layout">
        <div className="side">
          {nav.map((n) => (
            <div
              key={n.k}
              className={'nav-item' + (tab === n.k ? ' active' : '')}
              onClick={() => irANav(n)}
            >
              <span>{n.ic}</span>
              <span>{n.t}</span>
              {!!n.badge && n.badge > 0 && (
                <span className="badge">{n.badge}</span>
              )}
            </div>
          ))}
        </div>

        <div className="main">
          {errRoles && <div className="err">{errRoles}</div>}

          {/* Un error de render queda contenido en el módulo: la barra y el
              menú sobreviven. Las dos pestañas de incidencias comparten
              nombre para que alternar entre ellas no resetee nada. */}
          <ErrorBoundary
            modulo={esTabIncidencias ? 'incidencias' : tab}
            resetKey={`${tab}|${recargarSignal}|${focoRecordId || ''}|${nuevaAbierta}|${toquesNueva}`}
          >
          {/* Una sola instancia para ambas pestañas: no se remonta al
            alternar, así que conserva lista, filtros y búsqueda. */}
            {esTabIncidencias && (
              <IncidenciasView
                email={email}
                nombre={nombre}
                misRoles={misRoles}
                misDep={misDep}
                rolesDetalle={rolesDetalle}
                role={role}
                modo={tab === 'bandeja' ? 'bandeja' : 'todas'}
                chatCounts={notifs.chatCounts}
                onChatLeido={notifs.marcarChatLeido}
                onRecargarNotifs={notifs.recargar}
                onNotifAtendida={notifs.marcarDeRegistro}
                focoRecordId={focoRecordId}
                onFocoAplicado={limpiarFoco}
                nuevaAbierta={nuevaAbierta}
                onCerrarNueva={cerrarNueva}
                recargarSignal={recargarSignal}
                onBandejaCount={setBandejaCount}
              />
            )}
            {/* Módulos diferidos: su chunk se descarga al abrir la pestaña.
                El Suspense va DENTRO del ErrorBoundary para que un chunk
                que no llegó caiga en su aviso (con "Recargar la app") y la
                barra y el menú sigan vivos. Incidencias queda fuera: es
                estático y no debe pasar nunca por "Cargando…". La llave
                reinicia el aviso de "tarda más de lo normal" por módulo. */}
            <Suspense fallback={<CargandoModulo key={tab} />}>
              {/* recargarSignal: sin él, ↻ no reintentaba un periodo cuya
                  carga falló (revisión primer mes, 24-sep-2026). Va el
                  contador del ↻ y no el general: ver recargaManual. */}
              {tab === 'dashboard' && (
                <IndicadoresView
                  puedeConfigurarSla={has('manager')}
                  recargarSignal={recargaManual}
                />
              )}
              {tab === 'disponibilidad' && <DisponibilidadView />}
              {tab === 'bitacora_vv' && (
                <BitacoraVVView
                  email={email}
                  puedeCapturar={has('comercial')}
                  puedeProgramar={has('pautas')}
                  recargarSignal={recargarSignal}
                />
              )}
              {tab === 'fijacion_externa' && (
                <FijacionExternaView
                  email={email}
                  verTodo={has('manager')}
                  onNotifAtendida={notifs.marcarDeRegistro}
                />
              )}
              {tab === 'rutas' && (
                <RutasView
                  puedeGestionar={has('manager') || has('coordinador')}
                  unidades={misUnidades}
                />
              )}
              {tab === 'pauta' && (
                <PautaView
                  email={email}
                  misDep={misDep}
                  puedeImportar={has('manager') || has('coordinador')}
                  recargarSignal={recargarSignal}
                />
              )}
              {tab === 'biobox' && (
                <BioboxView
                  email={email}
                  misDep={misDep}
                  recargarSignal={recargarSignal}
                />
              )}
              {tab === 'usuarios' && <UsuariosView email={email} />}
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>

    </div>
  );
}

// --- Root: decide login / recuperación / app según la sesión ---
export default function App() {
  /**
   * Arranque optimista (modo sin señal, 24-sep-2026): con sesión guardada
   * se pinta Main de inmediato, sin esperar a getSession — que sin red y
   * con el token vencido tarda ~25 s y luego devuelve null—. Al regresar de
   * Google o del correo de restablecimiento se espera a auth-js como antes.
   */
  const [inicial] = useState<Session | null>(() =>
    esRegresoDeAuth() ? null : leerSesionGuardada()
  );
  const [session, setSession] = useState<Session | null>(inicial);
  /** false mientras la sesión sea la guardada y auth-js no la confirme. */
  const [verificada, setVerificada] = useState(false);
  const [ready, setReady] = useState(inicial !== null);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    let vivo = true;
    sb.auth
      .getSession()
      .then(({ data, error }) => {
        if (!vivo) return;
        if (data.session) {
          setSession(data.session);
          setVerificada(true);
        } else {
          // null + error REINTENTABLE (sin red, servidor caído) con la sesión
          // aún guardada: no murió, solo no se pudo renovar. Se entra (o se
          // sigue) con la guardada; auth-js la renueva sola al volver la red
          // y avisa con TOKEN_REFRESHED.
          const guardada = isAuthRetryableFetchError(error) ? leerSesionGuardada() : null;
          setSession((prev) => (guardada ? prev ?? guardada : null));
        }
        setReady(true);
      })
      .catch(() => {
        if (vivo) setReady(true);
      });
    const { data: sub } = sb.auth.onAuthStateChange((e, s) => {
      // Al llegar del correo de restablecimiento, Supabase abre sesión y
      // emite PASSWORD_RECOVERY: hay que pedir la contraseña nueva antes
      // de dejar entrar a la app.
      if (e === 'PASSWORD_RECOVERY') setRecovery(true);
      if (s) {
        if (salidaForzada && e !== 'PASSWORD_RECOVERY') {
          // Una renovación que ya iba en camino al tocar "Salir" sin red
          // volvió a guardar la sesión: se cierra otra vez. Fuera del
          // callback: auth-js no debe llamarse desde dentro de su aviso.
          window.setTimeout(() => {
            void sb.auth.signOut({ scope: 'local' }).catch(() => {});
          }, 0);
          return;
        }
        setSession(s);
        setVerificada(true);
        setReady(true);
        return;
      }
      if (e === 'SIGNED_OUT') {
        setSession(null);
        setVerificada(false);
        setReady(true);
        return;
      }
      // INITIAL_SESSION con null y la sesión todavía guardada = la
      // renovación falló por red (auth-js no borra nada en ese caso): se
      // queda la sesión optimista. Una muerte real borra la clave y llega
      // como SIGNED_OUT.
      if (e === 'INITIAL_SESSION' && leerSesionGuardada()) return;
      setSession(null);
      setVerificada(false);
    });
    return () => {
      vivo = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  /** "Salir" sin red: la sesión ya se borró a mano (ver Main.salir). */
  const alSalidaForzada = useCallback(() => {
    salidaForzada = true;
    setSession(null);
    setVerificada(false);
    setReady(true);
  }, []);

  if (!ready) return <div className="loading">Cargando…</div>;
  if (recovery) return <UpdatePassword onDone={() => setRecovery(false)} />;
  if (!session) return <Login />;
  // key por correo: si auth-js cambia de cuenta sin pasar por el Login
  // (regreso de Google con otra sesión guardada), Main arranca de cero.
  return (
    <Main
      key={(session.user.email || '').toLowerCase()}
      session={session}
      verificada={verificada}
      onSalidaForzada={alSalidaForzada}
    />
  );
}
