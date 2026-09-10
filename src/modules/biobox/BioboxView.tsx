// Máquinas por ruta, estado del inventario e incidencias abiertas.
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { sb } from '../../lib/supabase';
import IrAqui from '../../components/IrAqui';
import { resumenMaquinas, HORAS_ALARMA } from '../../lib/estadoMaquina';
import type { MapaResumen } from '../../lib/estadoMaquina';
import { fmtHoras, sinAcentos } from '../../lib/helpers';
import { tramosGoogleMaps } from '../../lib/navegacion';
import { UNIDADES_BIOBOX } from '../../lib/constants';
import { fueraDeLinea, maquinasUnicas, indicadoresMaquinas, pendienteRevision } from '../../lib/maquinasBiobox';
import type { MaquinaBiobox } from '../../lib/maquinasBiobox';
import EstadoMaquinaPanel from './EstadoMaquinaPanel';
import RevisionModal from './RevisionModal';
import HistorialModal from './HistorialModal';

type Orden = 'abandono' | 'secuencia' | 'nombre';

function nombreRuta(u: MaquinaBiobox): string {
  return u.ruta_nombre || 'Ruta ' + u.ruta_numero;
}

function BioboxView({ email, misDep, recargarSignal = 0 }: {
  email: string;
  misDep: string[];
  recargarSignal?: number;
}) {
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState('');
  const [ubics, setUbics] = useState<MaquinaBiobox[]>([]);
  const [estado, setEstado] = useState<MapaResumen>({});
  const [unidad, setUnidad] = useState(UNIDADES_BIOBOX[0] || 'Biobox');
  const [medio, setMedio] = useState('todos');
  const [rutaFoco, setRutaFoco] = useState<string | null>(null);
  const [orden, setOrden] = useState<Orden>('abandono');
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [revisando, setRevisando] = useState<MaquinaBiobox | null>(null);
  const [historial, setHistorial] = useState<MaquinaBiobox | null>(null);
  const [busca, setBusca] = useState('');
  const [actualizado, setActualizado] = useState<Date | null>(null);
  const [detalle, setDetalle] = useState<string | null>(null);
  const [maquinaAbierta, setMaquinaAbierta] = useState<string | null>(null);
  const solicitud = useRef(0);

  const cargar = useCallback(async () => {
    const turno = ++solicitud.current;
    setCargando(true);
    setErr('');
    try {
      // La vista aporta rutas, ubicación y última revisión. El estado de
      // inventario se consulta aparte para el indicador Fuera de línea.
      const filas: MaquinaBiobox[] = [];
      for (let inicio = 0; ; inicio += 500) {
        const { data, error } = await sb.from('vw_revision_ubicaciones')
          .select('ubicacion_id,ruta_id,ruta_numero,ruta_nombre,ruta_color,unidad_negocio,tipo_medio,ruta_activa,site_id,secuencia,vendor_face_id,site_legacy_id,direccion,municipio,estado,tipo_mueble,medio,latitud,longitud,navegable,revision_id,ultima_revision,ultimo_revisor,estado_maquina,puntos_anomalia,dias_sin_revision')
          .eq('unidad_negocio', unidad)
          .order('ubicacion_id')
          .range(inicio, inicio + 499);
        if (error) throw new Error('No se pudieron cargar las máquinas: ' + error.message);
        if (turno !== solicitud.current) return;
        filas.push(...(data || []).map((u) => ({ ...u, face_status: null })));
        if (!data || data.length < 500) break;
      }
      const claves = [...new Set(filas.map((u) => u.vendor_face_id).filter((v): v is string => !!v))];
      const estadosInventario = new Map<string, string | null>();
      // Se cruza por la misma cara que selecciona la vista para esta máquina.
      for (let inicio = 0; inicio < claves.length; inicio += 100) {
        const { data, error } = await sb.from('inventario')
          .select('vendor_face_id,face_status')
          .in('vendor_face_id', claves.slice(inicio, inicio + 100));
        if (error) throw new Error('No se pudo consultar el estado del inventario: ' + error.message);
        if (turno !== solicitud.current) return;
        for (const u of data || []) estadosInventario.set(u.vendor_face_id, u.face_status);
      }
      const resumen: MapaResumen = {};
      const sitios = [...new Set(filas.map((u) => u.site_id))];
      for (let inicio = 0; inicio < sitios.length; inicio += 100) {
        Object.assign(resumen, await resumenMaquinas(sitios.slice(inicio, inicio + 100), true));
        if (turno !== solicitud.current) return;
      }
      setUbics(filas.map((u) => ({ ...u, face_status: estadosInventario.get(u.vendor_face_id || '') ?? null })));
      setEstado(resumen);
      setActualizado(new Date());
    } catch (error) {
      if (turno === solicitud.current) setErr(error instanceof Error ? error.message : 'No se pudieron actualizar las máquinas.');
    } finally {
      if (turno === solicitud.current) setCargando(false);
    }
  }, [unidad]);

  useEffect(() => {
    void cargar();
    // Descarta respuestas de una unidad anterior o de una recarga superada.
    return () => { solicitud.current++; };
  }, [cargar, recargarSignal]);

  useEffect(() => {
    if (!detalle) return;
    const cerrar = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetalle(null); };
    document.addEventListener('keydown', cerrar);
    return () => document.removeEventListener('keydown', cerrar);
  }, [detalle]);

  const rutas = useMemo(() => {
    const m = new Map<string, { nombre: string; color: string; sitios: Set<string> }>();
    ubics.forEach((u) => {
      const nombre = nombreRuta(u);
      const ruta = m.get(nombre) || { nombre, color: u.ruta_color, sitios: new Set<string>() };
      ruta.sitios.add(u.site_id);
      m.set(nombre, ruta);
    });
    return [...m.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [ubics]);

  const visibles = useMemo(() => {
    const q = sinAcentos(busca.trim());
    const filas = maquinasUnicas(ubics
      .filter((u) => rutaFoco == null || nombreRuta(u) === rutaFoco)
      .filter((u) => medio === 'todos' || u.medio === medio)
      .filter((u) => !soloPendientes || pendienteRevision(u))
      .filter((u) => !q || sinAcentos([u.site_legacy_id, u.direccion, u.site_id].join(' ')).includes(q)));
    return filas.sort((a, b) => orden === 'abandono'
      ? (b.dias_sin_revision ?? Number.MAX_SAFE_INTEGER) - (a.dias_sin_revision ?? Number.MAX_SAFE_INTEGER)
      : orden === 'secuencia'
      ? (a.secuencia ?? 9999) - (b.secuencia ?? 9999) || a.site_id.localeCompare(b.site_id)
      : (a.site_legacy_id || a.site_id).localeCompare(b.site_legacy_id || b.site_id, undefined, { numeric: true }));
  }, [ubics, rutaFoco, medio, busca, orden, soloPendientes]);

  const indicadores = useMemo(() => indicadoresMaquinas(visibles, estado), [visibles, estado]);
  const indicadorAbierto = indicadores.find((i) => i.id === detalle);
  const tramos = useMemo(() => {
    if (rutaFoco == null) return [];
    return tramosGoogleMaps(visibles.filter((u) => u.navegable).slice()
      .sort((a, b) => (a.secuencia ?? 9999) - (b.secuencia ?? 9999) || a.site_id.localeCompare(b.site_id))
      .map((u) => ({ lat: u.latitud as number, lng: u.longitud as number, nombre: u.site_legacy_id || u.site_id })));
  }, [visibles, rutaFoco]);

  const tarjetaMaquina = (u: MaquinaBiobox, enDetalle = false) => {
    const e = estado[u.site_id];
    const alarma = (e?.horas_peor ?? 0) > HORAS_ALARMA;
    const panelId = (enDetalle ? 'detalle-' : 'lista-') + u.site_id;
    return (
      <div key={u.site_id} style={{ background: 'var(--panel2)', border: '1px solid var(--line)', borderLeft: '3px solid ' + u.ruta_color, borderRadius: 10, padding: '11px 12px', minWidth: 0, overflowWrap: 'anywhere' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
            <b>{u.site_legacy_id ? '#' + u.site_legacy_id : u.site_id}</b>
            {u.site_legacy_id && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{u.site_id}</div>}
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              {u.direccion || '(sin dirección)'}{u.municipio ? ' · ' + u.municipio : ''}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
              <span className="tag" style={{ color: u.ruta_color }}>{nombreRuta(u)}</span>
              {u.medio && <span className="tag" style={{ whiteSpace: 'normal' }}>{u.medio}{u.tipo_mueble ? ' · ' + u.tipo_mueble : ''}</span>}
              <span className="tag" style={{ color: pendienteRevision(u) ? '#f59e0b' : 'var(--ok)' }}>
                {u.dias_sin_revision == null ? 'Nunca revisada' : 'Revisada hace ' + u.dias_sin_revision + ' día' + (u.dias_sin_revision === 1 ? '' : 's')}
              </span>
              {!!u.puntos_anomalia && <span className="tag" style={{ color: '#f97316' }}>
                {u.puntos_anomalia} anomalía{u.puntos_anomalia === 1 ? '' : 's'}
              </span>}
              <span className="tag" style={{ color: fueraDeLinea(u) ? 'var(--bad)' : 'var(--muted)', whiteSpace: 'normal' }}>
                {fueraDeLinea(u) ? 'Fuera de línea' : u.face_status || 'Sin estado en inventario'}
              </span>
              {!!e?.abiertas && <span className="tag" style={{ color: alarma ? 'var(--bad)' : '#f97316', whiteSpace: 'normal', maxWidth: '100%' }}>
                ⚠ {e.abiertas} abierta{e.abiertas === 1 ? '' : 's'}
                {e.horas_peor != null ? ' · ' + fmtHoras(e.horas_peor) : ''}
                {e.areas ? ' · ' + e.areas : ''}
              </span>}
              {!u.navegable && <span className="tag">Sin coordenadas</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <IrAqui destino={{ lat: u.latitud, lng: u.longitud, nombre: u.site_legacy_id || u.direccion || u.site_id }} />
            <button className="btn ghost sm" onClick={() => setMaquinaAbierta(maquinaAbierta === panelId ? null : panelId)} aria-expanded={maquinaAbierta === panelId}>
              Ver incidencias
            </button>
            <button className="btn ghost sm" onClick={() => { setDetalle(null); setHistorial(u); }}>
              📖 Historial
            </button>
            <button className="btn sm" onClick={() => { setDetalle(null); setRevisando(u); }}>
              ✅ Revisar
            </button>
          </div>
        </div>
        {maquinaAbierta === panelId && <div style={{ marginTop: 12 }}>
          <EstadoMaquinaPanel key={u.site_id + '-' + actualizado?.getTime()} siteId={u.site_id} />
        </div>}
      </div>
    );
  };

  return (
    <div>
      <h2 className="page">Máquinas Biobox</h2>
      <p className="phint">Revisión de máquinas por ruta, estado del inventario e incidencias abiertas.</p>
      <div className="toolbar">
        <select aria-label="Unidad" value={unidad} onChange={(e) => {
          setUnidad(e.target.value); setRutaFoco(null); setDetalle(null); setMaquinaAbierta(null);
          setUbics([]); setEstado({}); setActualizado(null);
        }}>
          {UNIDADES_BIOBOX.map((u) => <option key={u} value={u}>Unidad: {u}</option>)}
        </select>
        <select aria-label="Medio" value={medio} onChange={(e) => setMedio(e.target.value)}>
          <option value="todos">Medio: Digital e Impreso</option>
          <option value="Digital">Digital</option><option value="Impreso">Impreso</option>
        </select>
        <button className="btn sm ghost" onClick={() => void cargar()} disabled={cargando}>
          {cargando ? 'Actualizando…' : '↻ Actualizar'}
        </button>
      </div>
      <div role="status" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        {cargando ? 'Consultando máquinas, inventario e incidencias…' : actualizado ? 'Actualizado: ' + actualizado.toLocaleTimeString('es-MX') : ''}
      </div>
      {err && <div className="err" role="alert">{err}{actualizado ? ' Se conservan los últimos datos cargados.' : ''}</div>}
      {!cargando && !ubics.length && !err && <div className="banner">
        No hay máquinas asignadas a rutas para {unidad}. Se dan de alta desde <b>Rutas de Monitoreo → Importar mapa (KML)</b>.
      </div>}

      {!!ubics.length && <>
        <div className="toolbar">
          <input className="search" aria-label="Buscar máquina" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por número, dirección o clave" />
          <select aria-label="Orden de máquinas" value={orden} onChange={(e) => setOrden(e.target.value as Orden)}>
            <option value="abandono">Ordenar: más urgente primero</option>
            <option value="secuencia">Ordenar: secuencia de la ruta</option>
            <option value="nombre">Ordenar: número de máquina</option>
          </select>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={soloPendientes} onChange={(e) => setSoloPendientes(e.target.checked)} style={{ width: 'auto' }} />
            Solo las que toca revisar
          </label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
          <button className="btn ghost sm" aria-pressed={rutaFoco == null} onClick={() => setRutaFoco(null)} style={{ color: rutaFoco == null ? 'var(--accent)' : undefined }}>
            Todas ({maquinasUnicas(ubics).length})
          </button>
          {rutas.map((r) => <button key={r.nombre} className="btn ghost sm" aria-pressed={rutaFoco === r.nombre} onClick={() => setRutaFoco(rutaFoco === r.nombre ? null : r.nombre)} style={{ color: r.color, borderColor: rutaFoco === r.nombre ? r.color : undefined }}>
            {r.nombre} ({r.sitios.size})
          </button>)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 9, margin: '14px 0' }}>
          {indicadores.map((i) => <button key={i.id} type="button" disabled={cargando} onClick={() => { setDetalle(i.id); setMaquinaAbierta(null); }} style={{ background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', minWidth: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: i.color }}>{i.filas.length}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>{i.titulo}</div>
          </button>)}
        </div>
        {rutaFoco != null && !!tramos.length && <div className="card" style={{ marginBottom: 12 }}>
          <b>🧭 Recorrido de la ruta</b>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 8 }}>
            {tramos.map((t, i) => <a key={i} className="btn sm ghost" href={t.url} target="_blank" rel="noopener noreferrer">Tramo {i + 1} ({t.paradas.length})</a>)}
          </div>
        </div>}
        <div style={{ display: 'grid', gap: 9 }}>{visibles.map((u) => tarjetaMaquina(u))}</div>
        {!visibles.length && <div className="banner">Nada coincide con el filtro.</div>}
      </>}

      {indicadorAbierto && createPortal(
        <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) setDetalle(null); }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="biobox-indicador-titulo" style={{ maxWidth: 800 }}>
            <h2 id="biobox-indicador-titulo">{indicadorAbierto.titulo}</h2>
            <p className="phint">{indicadorAbierto.filas.length} máquinas · {unidad}{rutaFoco ? ' · ' + rutaFoco : ''}{medio !== 'todos' ? ' · ' + medio : ''}{busca ? ' · ' + busca : ''}{soloPendientes ? ' · Pendientes de revisión' : ''}</p>
            <div style={{ display: 'grid', gap: 9, maxHeight: '60dvh', overflowY: 'auto' }}>
              {indicadorAbierto.filas.map((u) => tarjetaMaquina(u, true))}
              {!indicadorAbierto.filas.length && <p>Sin máquinas para este indicador con los filtros seleccionados.</p>}
            </div>
            <div className="modal-actions" style={{ marginTop: 12 }}><button autoFocus className="btn ghost" onClick={() => setDetalle(null)}>Cerrar</button></div>
          </section>
        </div>, document.body
      )}
      {revisando && <RevisionModal
        ubic={revisando}
        email={email}
        misDep={misDep}
        onClose={() => setRevisando(null)}
        onGuardada={() => { void cargar(); }}
      />}
      {historial && <HistorialModal
        siteId={historial.site_id}
        titulo={(historial.site_legacy_id ? '#' + historial.site_legacy_id + ' · ' : '') + (historial.direccion || historial.site_id)}
        onClose={() => setHistorial(null)}
      />}
    </div>
  );
}

export default BioboxView;
