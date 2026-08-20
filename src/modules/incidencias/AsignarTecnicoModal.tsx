// ============================================================
// src/modules/incidencias/AsignarTecnicoModal.tsx
// Asigna un técnico del catálogo `tecnicos` (filtrado por área) a una
// incidencia, o a TODAS las activas del mismo sitio+área de un jalón.
// Permite dar de alta un técnico nuevo sin salir del modal.
// ============================================================
import { useState, useEffect } from 'react';
import { sb } from '../../lib/supabase';
import { areaEfectiva } from '../../lib/helpers';
import type { Incidencia, Tecnico } from '../../types/db';

/** Valor especial del <select> para "dar de alta uno nuevo". */
const NUEVO = '__nuevo__';

/** Estatus que ya NO admiten asignación: la incidencia está terminada. */
const ESTATUS_TERMINADOS = '(cerrada,no_reparado)';

/**
 * Filtro PostgREST para "las de esta área", contando tanto las que la tienen
 * por catálogo como las que se le redirigieron.
 * Los valores van entre comillas porque hay áreas con punto y espacios
 * ("Op. Bio Box") y la sintaxis de or() separa por comas.
 */
const filtroPorArea = (area: string) =>
  `area_responsable.eq."${area}",assigned_area.eq."${area}"`;

type Alcance = 'una' | 'sitio';

type Props = {
  inc: Incidencia;
  /** Correo del usuario que asigna (queda en asignado_por). */
  email: string;
  onClose: () => void;
  /** El padre recarga: un alcance 'sitio' toca filas que no tiene en memoria. */
  onDone: () => void;
};

function AsignarTecnicoModal({ inc, email, onClose, onDone }: Props) {
  // El área EFECTIVA: si el validador la redirigió, los técnicos que aplican
  // son los del área destino, no los del catálogo.
  const area = areaEfectiva(inc);
  const [tecnicos, setTecnicos] = useState<Tecnico[]>([]);
  const [sel, setSel] = useState('');
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoEmail, setNuevoEmail] = useState('');
  const [alcance, setAlcance] = useState<Alcance>('una');
  const [cuantasSitio, setCuantasSitio] = useState(1);
  const [busy, setBusy] = useState(false);
  const filtroArea = filtroPorArea(area);

  useEffect(() => {
    (async () => {
      const { data } = await sb
        .from('tecnicos')
        .select('*')
        .eq('area', area)
        .eq('activo', true)
        .order('nombre');
      setTecnicos((data as Tecnico[]) || []);

      // Cuántas incidencias activas hay en este sitio + área: es el número
      // que se le muestra al coordinador en la opción "todas del sitio".
      const { count } = await sb
        .from('incidencias')
        .select('record_id', { count: 'exact', head: true })
        .eq('clave_sitio', inc.clave_sitio)
        .or(filtroArea)
        .not('estatus', 'in', ESTATUS_TERMINADOS);
      setCuantasSitio(count || 1);
    })();
    // Solo al abrir: el modal se monta por incidencia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const guardar = async () => {
    let nombre: string;
    let correo: string | null = null;

    if (sel === NUEVO) {
      if (!nuevoNombre.trim()) {
        alert('Escribe el nombre del técnico.');
        return;
      }
      nombre = nuevoNombre.trim();
      correo = nuevoEmail.trim() || null;
      const { data, error } = await sb
        .from('tecnicos')
        .insert({ nombre, area, email: correo })
        .select()
        .single();
      // Un duplicado no es error: el técnico ya existía, se sigue asignando.
      if (error && !String(error.message).includes('duplicate')) {
        alert('No se pudo crear el técnico: ' + error.message);
        return;
      }
      if (data) correo = (data as Tecnico).email;
    } else {
      const t = tecnicos.find((x) => String(x.id) === sel);
      if (!t) {
        alert('Elige un técnico.');
        return;
      }
      nombre = t.nombre;
      correo = t.email;
    }

    setBusy(true);
    const patch = {
      asignado_tecnico: nombre,
      asignado_tecnico_email: correo ? correo.toLowerCase() : null,
      asignado_por: email,
      asignado_en: new Date().toISOString(),
    };

    let q = sb.from('incidencias').update(patch);
    if (alcance === 'sitio') {
      q = q
        .eq('clave_sitio', inc.clave_sitio)
        .or(filtroArea)
        .not('estatus', 'in', ESTATUS_TERMINADOS);
    } else {
      q = q.eq('record_id', inc.record_id);
    }

    const { error } = await q;
    setBusy(false);
    if (error) {
      alert('No se pudo asignar: ' + error.message);
      return;
    }
    onDone();
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onClose();
      }}
    >
      <div className="modal">
        <h2 style={{ margin: '0 0 3px' }}>Asignar técnico</h2>
        <p className="phint">
          {inc.folio} · {inc.nombre_incidencia} · Área: <b>{area}</b> · Sitio:{' '}
          {inc.clave_sitio}
        </p>

        <div className="field">
          <label>
            Técnico ({tecnicos.length} en {area})
          </label>
          <select value={sel} onChange={(e) => setSel(e.target.value)}>
            <option value="">— Selecciona —</option>
            {tecnicos.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nombre}
                {t.email ? ` (${t.email})` : ''}
              </option>
            ))}
            <option value={NUEVO}>➕ Agregar nuevo técnico…</option>
          </select>
        </div>

        {sel === NUEVO && (
          <div className="row2">
            <div className="field">
              <label>Nombre</label>
              <input
                value={nuevoNombre}
                onChange={(e) => setNuevoNombre(e.target.value)}
                placeholder="Nombre del técnico"
              />
            </div>
            <div className="field">
              <label>Correo (opcional, si usa la app)</label>
              <input
                value={nuevoEmail}
                onChange={(e) => setNuevoEmail(e.target.value)}
                placeholder="correo@gpovallas.com"
              />
            </div>
          </div>
        )}

        <div className="field">
          <label>Alcance</label>
          <select
            value={alcance}
            onChange={(e) => setAlcance(e.target.value as Alcance)}
          >
            <option value="una">Solo esta incidencia</option>
            <option value="sitio">
              Todas las de este sitio y área ({cuantasSitio})
            </option>
          </select>
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn" onClick={guardar} disabled={busy}>
            {busy
              ? 'Asignando…'
              : `Asignar${alcance === 'sitio' ? ` (${cuantasSitio})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AsignarTecnicoModal;
