// ============================================================
// src/modules/usuarios/UsuariosView.tsx
// Alta de usuarios y asignación de roles. Solo para manager
// (la RLS `ur_manager_all` y `usr_write` lo exigen del lado de la base).
//
// Un usuario puede tener VARIOS roles, y cada rol se acota con
// unidad_negocio / departamento / medio. Esos tres campos no son decorativos:
// las políticas RLS de incidencias los leen para decidir qué ve cada quien.
//   - unidad_negocio vacío  → todas las unidades
//   - departamento vacío    → todas las áreas
//   - medio (solo validador) vacío → Impreso y Digital
// ============================================================
import { useState, useEffect } from 'react';
import { sb } from '../../lib/supabase';
import {
  ROLE_LABEL,
  UNIDADES,
  AREAS_RESP,
  DEPARTAMENTOS_REPORTE,
} from '../../lib/constants';
import type { AppRole, Usuario, UsuarioRol } from '../../types/db';

/** Borrador del alta de usuario. */
type NuevoUsuario = { nombre: string; email: string; telefono: string };

/** Borrador de la asignación de rol. */
type NuevoRol = {
  rol: string;
  unidad: string;
  depto: string;
  medio: string;
};

const ROL_VACIO: NuevoRol = {
  rol: 'reportante',
  unidad: '',
  depto: '',
  medio: '',
};

const USUARIO_VACIO: NuevoUsuario = { nombre: '', email: '', telefono: '' };

function UsuariosView() {
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [roles, setRoles] = useState<UsuarioRol[]>([]);
  const [loading, setLoading] = useState(true);
  const [nu, setNu] = useState<NuevoUsuario>(USUARIO_VACIO);
  /** Correo del usuario cuyo formulario de rol está abierto (uno a la vez). */
  const [rolesFor, setRolesFor] = useState<string | null>(null);
  const [nr, setNr] = useState<NuevoRol>(ROL_VACIO);
  const [q, setQ] = useState('');

  const cargar = async () => {
    setLoading(true);
    const [{ data: u }, { data: r }] = await Promise.all([
      sb.from('usuarios').select('*').order('nombre'),
      sb.from('usuario_roles').select('*'),
    ]);
    setUsuarios((u as Usuario[]) || []);
    setRoles((r as UsuarioRol[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    cargar();
  }, []);

  const addUser = async () => {
    if (!nu.email.trim()) {
      alert('El correo es obligatorio.');
      return;
    }
    const { error } = await sb.from('usuarios').insert({
      // El correo es la llave de todo el sistema de permisos: siempre en
      // minúsculas, porque las políticas RLS comparan con lower().
      email: nu.email.trim().toLowerCase(),
      nombre: nu.nombre.trim() || null,
      telefono: nu.telefono.trim() || null,
    });
    if (error) {
      alert('No se pudo crear: ' + error.message);
      return;
    }
    setNu(USUARIO_VACIO);
    cargar();
  };

  /** Guarda al salir del campo (onBlur). No recarga la lista completa. */
  const updUser = async (em: string, patch: Partial<Usuario>) => {
    const { error } = await sb
      .from('usuarios')
      .update(patch)
      .eq('email', em);
    if (error) {
      alert(error.message);
      return;
    }
    // Refleja el cambio en memoria para que la lista no quede desfasada.
    setUsuarios((prev) =>
      prev.map((u) => (u.email === em ? { ...u, ...patch } : u))
    );
  };

  const delUser = async (em: string) => {
    if (!confirm('¿Eliminar a ' + em + ' y todos sus roles?')) return;
    const { error } = await sb.from('usuarios').delete().eq('email', em);
    if (error) alert(error.message);
    else cargar();
  };

  const addRole = async (em: string) => {
    const { error } = await sb.from('usuario_roles').insert({
      usuario_email: em.toLowerCase(),
      rol: nr.rol as AppRole,
      unidad_negocio: nr.unidad || null,
      departamento: nr.depto || null,
      // `medio` solo aplica al validador; en cualquier otro rol se ignora
      // para no dejar un filtro colgado que después confunda.
      medio: nr.rol === 'validador' ? nr.medio || null : null,
    });
    // Duplicado = el rol ya existía: no es un error que valga reportar.
    if (error && !String(error.message).includes('duplicate')) {
      alert(error.message);
      return;
    }
    setNr(ROL_VACIO);
    cargar();
  };

  const delRole = async (id: number, etiqueta: string) => {
    // confirm como en delUser: en táctil, un roce al hacer scroll caía en
    // el ✕ y borraba permisos RLS al instante y sin aviso.
    if (!confirm(`¿Quitar el rol "${etiqueta}"?`)) return;
    const { error } = await sb.from('usuario_roles').delete().eq('id', id);
    if (error) alert(error.message);
    else cargar();
  };

  const rolesDe = (em: string) =>
    roles.filter(
      (r) => (r.usuario_email || '').toLowerCase() === em.toLowerCase()
    );

  const lista = usuarios.filter((u) => {
    if (!q) return true;
    return `${u.nombre || ''} ${u.email}`.toLowerCase().includes(q.toLowerCase());
  });

  /** Etiqueta del campo departamento: cambia de significado según el rol. */
  const labelDepto =
    nr.rol === 'reportante'
      ? 'Departamento de reporte'
      : nr.rol === 'coordinador' || nr.rol === 'reparacion'
        ? 'Área responsable'
        : 'Área / departamento (opcional)';

  /** Opciones del departamento según el rol. */
  const opcionesDepto =
    nr.rol === 'reportante' ? DEPARTAMENTOS_REPORTE : AREAS_RESP;

  return (
    <>
      <h2 className="page">Usuarios y roles</h2>
      <p className="phint">
        Da de alta usuarios, edita sus datos y asigna roles por unidad de
        negocio y departamento.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>
          ➕ Nuevo usuario
        </div>
        <div className="row2">
          <div className="field">
            <label>Nombre</label>
            <input
              value={nu.nombre}
              onChange={(e) => setNu({ ...nu, nombre: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Correo</label>
            <input
              value={nu.email}
              onChange={(e) => setNu({ ...nu, email: e.target.value })}
              placeholder="correo@gpovallas.com"
            />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label>Teléfono (WhatsApp)</label>
            <input
              value={nu.telefono}
              onChange={(e) => setNu({ ...nu, telefono: e.target.value })}
              placeholder="+52..."
            />
          </div>
          <div className="field" style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className="btn" onClick={addUser} style={{ width: '100%' }}>
              Agregar usuario
            </button>
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          Recuerda invitarlo también en Supabase → Authentication para que pueda
          iniciar sesión.
        </div>
      </div>

      <div className="toolbar">
        <input
          className="search"
          placeholder="Buscar usuario…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="loading">Cargando…</div>
      ) : lista.length === 0 ? (
        <div className="empty">Sin usuarios que coincidan.</div>
      ) : (
        <div className="inc-list">
          {lista.map((u) => (
            <div key={u.email} className="inc">
              <div className="row2">
                <div className="field" style={{ marginBottom: 6 }}>
                  <label>Nombre</label>
                  {/* No controlado + onBlur: se guarda al salir del campo,
                      no en cada tecla. */}
                  <input
                    defaultValue={u.nombre || ''}
                    onBlur={(e) => {
                      if (e.target.value !== (u.nombre || ''))
                        updUser(u.email, { nombre: e.target.value || null });
                    }}
                  />
                </div>
                <div className="field" style={{ marginBottom: 6 }}>
                  <label>Teléfono</label>
                  <input
                    defaultValue={u.telefono || ''}
                    onBlur={(e) => {
                      if (e.target.value !== (u.telefono || ''))
                        updUser(u.email, { telefono: e.target.value || null });
                    }}
                  />
                </div>
              </div>

              <div
                style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}
              >
                {u.email}
              </div>

              <div className="chips">
                {rolesDe(u.email).length === 0 && (
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Sin roles
                  </span>
                )}
                {rolesDe(u.email).map((r) => (
                  <span
                    key={r.id}
                    className="pill"
                    style={{ background: '#4f8cff22', color: '#4f8cff' }}
                  >
                    {ROLE_LABEL[r.rol] || r.rol}
                    {r.unidad_negocio ? ` · ${r.unidad_negocio}` : ''}
                    {r.medio ? ` · ${r.medio}` : ''}
                    {r.departamento ? ` · ${r.departamento}` : ''}
                    <button
                      type="button"
                      className="btn-icono"
                      onClick={() => delRole(r.id, ROLE_LABEL[r.rol] || r.rol)}
                      aria-label="Quitar este rol"
                      title="Quitar este rol"
                      style={{
                        // Dentro del pill: área táctil amplia sin engordar
                        // el chip — el padding negativo la expande hacia
                        // afuera del renglón.
                        minWidth: 32,
                        minHeight: 32,
                        margin: '-8px 0 -8px 2px',
                        fontSize: 13,
                        fontWeight: 800,
                        color: 'inherit',
                      }}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>

              <div
                className="inc-actions"
                style={{ justifyContent: 'space-between' }}
              >
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    const abriendo = rolesFor !== u.email;
                    setRolesFor(abriendo ? u.email : null);
                    // Borrador limpio por usuario: si no, se arrastran los
                    // valores del usuario anterior.
                    if (abriendo) setNr(ROL_VACIO);
                  }}
                >
                  {rolesFor === u.email ? 'Cerrar' : '➕ Asignar rol'}
                </button>
                <button className="btn ghost sm" onClick={() => delUser(u.email)}>
                  🗑 Eliminar
                </button>
              </div>

              {rolesFor === u.email && (
                <div
                  style={{
                    border: '1px dashed var(--line)',
                    borderRadius: 10,
                    padding: 10,
                    marginTop: 8,
                  }}
                >
                  <div className="row2">
                    <div className="field">
                      <label>Rol</label>
                      <select
                        value={nr.rol}
                        onChange={(e) => setNr({ ...nr, rol: e.target.value })}
                      >
                        {/* viewer no se asigna a mano: es el rol por defecto
                            cuando alguien no tiene ninguno. */}
                        {Object.keys(ROLE_LABEL)
                          .filter((k) => k !== 'viewer')
                          .map((k) => (
                            <option key={k} value={k}>
                              {ROLE_LABEL[k]}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="field">
                      <label>Unidad</label>
                      <select
                        value={nr.unidad}
                        onChange={(e) => setNr({ ...nr, unidad: e.target.value })}
                      >
                        <option value="">(todas)</option>
                        {UNIDADES.map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {nr.rol === 'validador' && (
                    <div className="field">
                      <label>Medio (para validador)</label>
                      <select
                        value={nr.medio}
                        onChange={(e) => setNr({ ...nr, medio: e.target.value })}
                      >
                        <option value="">Ambos</option>
                        <option>Impreso</option>
                        <option>Digital</option>
                      </select>
                    </div>
                  )}

                  <div className="field">
                    <label>{labelDepto}</label>
                    <select
                      value={nr.depto}
                      onChange={(e) => setNr({ ...nr, depto: e.target.value })}
                    >
                      <option value="">(ninguna / todas)</option>
                      {opcionesDepto.map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </div>

                  <button className="btn sm" onClick={() => addRole(u.email)}>
                    Agregar rol
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default UsuariosView;
