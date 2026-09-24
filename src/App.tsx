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
  useEffect,
  useCallback,
  useRef,
  Suspense,
  type ComponentType,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { sb } from './lib/supabase';
import { ROLE_LABEL, ROLE_ICON, ROLE_PRIORITY, UNIDADES } from './lib/constants';
import { initials } from './lib/helpers';
import { useNotificaciones } from './lib/useNotificaciones';
import { vigilarNuevaVersion } from './lib/versionApp';
import CampanaNotifs from './components/CampanaNotifs';
import BotonPush from './components/BotonPush';
import MenuUsuario from './components/MenuUsuario';
import ErrorBoundary from './components/ErrorBoundary';
import EnviosPendientes from './components/EnviosPendientes';
import { confirmarRecargaConEnvios } from './lib/envios';
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

  const entrar = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    setBusy(true);
    // .trim(): un espacio pegado al correo produce "Invalid login
    // credentials" sin ninguna pista para el usuario.
    const { error } = await sb.auth.signInWithPassword({
      email: email.trim(),
      password: pass,
    });
    setBusy(false);
    if (error) setErr(error.message);
  };

  const entrarConGoogle = async () => {
    setErr('');
    setMsg('');
    // OAuth redirige fuera de la app y vuelve; onAuthStateChange recoge la
    // sesión al regresar. redirectTo debe estar dado de alta en
    // Supabase → Authentication → URL Configuration.
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) setErr(error.message);
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
    if (error) setErr(error.message);
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
function Main({ session }: { session: Session }) {
  const email = (session.user.email || '').toLowerCase();
  const [roles, setRoles] = useState<UsuarioRol[] | null>(null);
  const [errRoles, setErrRoles] = useState('');
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState('dashboard');
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
   * Cómo escribe la siguiente sincronía pestaña → URL. La PRIMERA tras
   * arrancar reemplaza (no apila una entrada extra de "/" o de la URL del
   * aviso push); las demás apilan, para que Atrás regrese de pestaña.
   */
  const modoHistorial = useRef<'reemplazar' | 'apilar'>('reemplazar');
  const [actualizacionDisponible, setActualizacionDisponible] = useState(false);
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
    // El destino del aviso manda sobre la ruta con que se abrió la app.
    if (record || ir === 'pauta' || ir === 'bitacora') setRutaPedida(null);
    if (record) enfocarDesdePush(record);
    // `?ir=pauta`: push de pauta con la app cerrada (toma regresada, por
    // comprobar, ruta asignada) — aterriza directo en su pestaña.
    else if (ir === 'pauta') irAPauta();
    // `?ir=bitacora`: push de la Bitácora VV con la app cerrada.
    else if (ir === 'bitacora') irABitacora();
    // Solo al montar: el parámetro llega únicamente en el arranque.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      const { data, error } = await sb
        .from('usuario_roles')
        .select('rol,unidad_negocio,departamento')
        .ilike('usuario_email', email);
      // Distinguir "falló la consulta" de "no tiene roles": si no, un error
      // de red o RLS se ve como "no tienes rol asignado" y manda al usuario
      // a pedir un alta que no necesita.
      if (error) setErrRoles('usuario_roles: ' + error.message);
      setRoles((data as UsuarioRol[]) || []);
      setReady(true);
    })();
  }, [email]);

  const misRoles = [...new Set((roles || []).map((r) => r.rol))] as string[];
  const misDep = [
    ...new Set((roles || []).map((r) => r.departamento).filter(Boolean)),
  ] as string[];
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
  const misUnidades =
    misRoles.includes('manager') ||
    misRoles.includes('viewer') ||
    (roles || []).some((r) => !r.unidad_negocio)
      ? UNIDADES
      : UNIDADES.filter((u) =>
          (roles || []).some(
            (r) => (r.unidad_negocio || '').toLowerCase() === u.toLowerCase()
          )
        );

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
   */
  const salir = () => {
    if (!confirm('¿Deseas salir de la app?')) return;
    sb.auth.signOut();
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
    if (rutaPedida && tabsConRuta.includes(rutaPedida)) setTab(rutaPedida);
    else setTab((t) => (t === 'dashboard' ? tabDeSiempre : t));
  }

  /**
   * La URL solo se toca con menú de verdad. En "Falta darte acceso" o si
   * falló la consulta de roles se deja como llegó: al recargar (o cuando le
   * den acceso) el enlace /pauta sigue abriendo Pauta.
   */
  const rutasActivas = ready && !errRoles && !!roles && roles.length > 0;

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

      {actualizacionDisponible && (
        <div className="banner" style={{ margin: '10px 16px 0' }}>
          Hay una versión nueva de la app.
          {/* Un reporte que se está enviando o que no cupo en el teléfono
              se perdería con la recarga: se pregunta antes (integración
              primer mes, 24-sep-2026). */}
          <button
            className="btn sm"
            style={{ marginLeft: 10 }}
            onClick={() => {
              if (confirmarRecargaConEnvios()) window.location.reload();
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
            resetKey={`${tab}|${recargarSignal}|${focoRecordId || ''}|${nuevaAbierta}`}
          >
          {/* Una sola instancia para ambas pestañas: no se remonta al
            alternar, así que conserva lista, filtros y búsqueda. */}
            {esTabIncidencias && (
              <IncidenciasView
                email={email}
                nombre={nombre}
                misRoles={misRoles}
                misDep={misDep}
                rolesDetalle={roles || []}
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
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = sb.auth.onAuthStateChange((e, s) => {
      setSession(s);
      // Al llegar del correo de restablecimiento, Supabase abre sesión y
      // emite PASSWORD_RECOVERY: hay que pedir la contraseña nueva antes
      // de dejar entrar a la app.
      if (e === 'PASSWORD_RECOVERY') setRecovery(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <div className="loading">Cargando…</div>;
  if (recovery) return <UpdatePassword onDone={() => setRecovery(false)} />;
  if (!session) return <Login />;
  return <Main session={session} />;
}
