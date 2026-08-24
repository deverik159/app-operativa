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
// ============================================================
import { useState, useEffect, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { sb } from './lib/supabase';
import { ROLE_LABEL, ROLE_ICON, ROLE_PRIORITY } from './lib/constants';
import { initials } from './lib/helpers';
import { useNotificaciones } from './lib/useNotificaciones';
import CampanaNotifs from './components/CampanaNotifs';
import BotonPush from './components/BotonPush';
import IncidenciasView from './modules/incidencias/IncidenciasView';
import IndicadoresView from './modules/incidencias/IndicadoresView';
import FijacionExternaView from './modules/fijacion-externa/FijacionExternaView';
import RutasView from './modules/rutas/RutasView';
import PautaView from './modules/pauta/PautaView';
import BioboxView from './modules/biobox/BioboxView';
import UsuariosView from './modules/usuarios/UsuariosView';
import type { UsuarioRol } from './types/db';

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
    <svg viewBox="0 0 48 48" style={{ width: 18, height: 18 }} aria-hidden="true">
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
  const [nuevaAbierta, setNuevaAbierta] = useState(false);
  // Contador que dispara la recarga de incidencias desde el botón ↻.
  const [recargarSignal, setRecargarSignal] = useState(0);
  // Lo reporta IncidenciasView: alimenta el badge de "Mi bandeja".
  const [bandejaCount, setBandejaCount] = useState(0);

  const notifs = useNotificaciones();

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
  const nombre =
    (session.user.user_metadata?.name as string) || email.split('@')[0];

  // manager es comodín: puede lo que puede cualquier otro rol.
  const has = (r: string) => misRoles.includes(r) || misRoles.includes('manager');

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
        setNuevaAbierta(true);
      },
    },
    (has('validador') || has('reparacion') || has('reportante')) && {
      k: 'bandeja',
      ic: '📥',
      t: 'Mi bandeja',
      badge: bandejaCount,
    },
    (has('manager') || has('validador') || has('coordinador')) && {
      k: 'todas',
      ic: '🗂️',
      t: 'Incidencias',
    },
    { k: 'dashboard', ic: '📊', t: 'Indicadores' },
    (has('manager') || has('reparacion') || has('coordinador')) && {
      k: 'fijacion_externa',
      ic: '📎',
      t: 'Fijación Externa',
    },
    (has('manager') || has('coordinador')) && {
      k: 'rutas',
      ic: '🗺️',
      t: 'Rutas de Monitoreo',
    },
    // Trabajo de campo sobre la pauta. Lo ve también reparación/fijador:
    // son quienes recorren la ruta, no solo quien la administra.
    (has('manager') ||
      has('coordinador') ||
      has('reparacion') ||
      has('fijador')) && {
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
      has('fijador')) && {
      k: 'biobox',
      ic: '♻️',
      t: 'Máquinas Biobox',
    },
    // Usuarios NO usa has(): solo el manager real, no por comodín.
    // La RLS (ur_manager_all / usr_write) exige manager de todos modos.
    misRoles.includes('manager') && { k: 'usuarios', ic: '👥', t: 'Usuarios' },
  ].filter(Boolean) as NavItem[];

  if (!ready) return <div className="loading">Cargando tu perfil…</div>;
  // Sin roles Y sin error de consulta = la cuenta existe pero nadie le ha
  // dado permisos. Se atiende antes de pintar el menú: no tiene caso mostrar
  // pestañas que estarían vacías.
  if (!errRoles && roles && roles.length === 0)
    return <SinAcceso email={email} />;

  const irANav = (n: NavItem) => (n.action ? n.action() : setTab(n.k));

  const recargarTodo = () => {
    setRecargarSignal((n) => n + 1);
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
          <div className="avatar">{initials(nombre)}</div>
          <button className="btn ghost sm" onClick={() => sb.auth.signOut()}>
            Salir
          </button>
        </div>
      </div>

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

          {/* Una sola instancia para ambas pestañas: no se remonta al
            alternar, así que conserva lista, filtros y búsqueda. */}
            {esTabIncidencias && (
              <IncidenciasView
                email={email}
                nombre={nombre}
                misRoles={misRoles}
                misDep={misDep}
                role={role}
                modo={tab === 'bandeja' ? 'bandeja' : 'todas'}
                chatCounts={notifs.chatCounts}
                onChatLeido={notifs.marcarChatLeido}
                onRecargarNotifs={notifs.recargar}
                focoRecordId={focoRecordId}
                onFocoAplicado={limpiarFoco}
                nuevaAbierta={nuevaAbierta}
                onCerrarNueva={() => setNuevaAbierta(false)}
                recargarSignal={recargarSignal}
                onBandejaCount={setBandejaCount}
              />
            )}
            {tab === 'dashboard' && <IndicadoresView />}
            {tab === 'fijacion_externa' && (
              <FijacionExternaView
                email={email}
                verTodo={has('manager') || has('coordinador')}
              />
            )}
            {tab === 'rutas' && (
              <RutasView
                puedeGestionar={has('manager') || has('coordinador')}
              />
            )}
          {tab === 'pauta' && (
            <PautaView
              email={email}
              puedeImportar={has('manager') || has('coordinador')}
            />
          )}
          {tab === 'biobox' && (
            <BioboxView
              email={email}
              misDep={misDep}
              puedeConfigurar={has('manager') || has('coordinador')}
            />
          )}
          {tab === 'usuarios' && <UsuariosView />}
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
