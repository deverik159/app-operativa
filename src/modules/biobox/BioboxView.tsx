// Máquinas por ruta, estado del inventario e incidencias abiertas.
import { CircleCheck, Compass, MapPinCheck } from 'lucide-react';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { sb } from '../../lib/supabase';
import IrAqui from '../../components/IrAqui';
import { resumenMaquinas, HORAS_ALARMA } from '../../lib/estadoMaquina';
import type { MapaResumen } from '../../lib/estadoMaquina';
import { fmtHoras, sinAcentos, NARANJA } from '../../lib/helpers';
import { colorTono } from '../../lib/tonos';
import { tramosGoogleMaps } from '../../lib/navegacion';
import { UNIDADES_BIOBOX } from '../../lib/constants';
import { fueraDeLinea, maquinasUnicas, indicadoresMaquinas, pendienteRevision } from '../../lib/maquinasBiobox';
import type { MaquinaBiobox } from '../../lib/maquinasBiobox';
import {
  DIAS_VISITA_AMBAR,
  LEJOS_M,
  diasDesde,
  semaforoVisita,
  textoDiasVisita,
  ultimoContacto,
} from '../../lib/visitaMaquina';
import {
  suscribirVisitas,
  visitasMaquinaEnviadasEnSesion,
  visitasPendientes,
  type VisitaPendiente,
} from '../../lib/visitas';
import { guardarMaquinasBioboxLocal, haySesionReal, leerMaquinasBioboxLocal } from '../../lib/datosLocales';
import EstadoMaquinaPanel from './EstadoMaquinaPanel';
import RevisionModal from './RevisionModal';
import HistorialModal from './HistorialModal';
import VisitaMaquinaModal from './VisitaMaquinaModal';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';

type Orden = 'abandono' | 'secuencia' | 'nombre';

function nombreRuta(u: MaquinaBiobox): string {
  return u.ruta_nombre || 'Ruta ' + u.ruta_numero;
}

/**
 * El color de la ruta como variable CSS (--ruta) para `.ruta-nombre`. En el
 * tema claro index.css lo pinta como punto junto al nombre en vez de como
 * color de letra: los colores que cada quien elige en Rutas (ámbar, verde
 * azulado…) no se leen como texto sobre claro. En oscuro no se usa: ahí
 * sigue mandando el `color` en línea de siempre (tema claro/oscuro,
 * 24-sep-2026).
 */
function varRuta(color: string | null | undefined): CSSProperties {
  return color ? ({ '--ruta': color } as CSSProperties) : {};
}

/** La última visita rápida de una máquina (vw_maquina_ultima_visita). */
type UltimaVisita = {
  visitado_en: string;
  usuario_email: string | null;
  funciona: boolean;
  distancia_m: number | null;
};

const COLOR_SEMAFORO = { verde: 'var(--ok)', ambar: 'var(--st-ambar)', rojo: 'var(--bad)' } as const;

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
  // Visita rápida (29-oct-2026).
  const [visitas, setVisitas] = useState<Record<string, UltimaVisita>>({});
  const [visitando, setVisitando] = useState<MaquinaBiobox | null>(null);
  const [aviso, setAviso] = useState('');
  const [pend, setPend] = useState<VisitaPendiente[]>([]);
  const [enviadasMaq, setEnviadasMaq] = useState<{ site_id: string; visitado_en: string; funciona: boolean }[]>([]);
  /** Fecha de la copia del teléfono que se está enseñando (sin señal). */
  const [copiaDe, setCopiaDe] = useState<string | null>(null);
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
      // Última visita rápida de cada máquina. Si falla no tumba la lista:
      // solo faltan los días sin visita (cuentan las revisiones).
      const ultimas: Record<string, UltimaVisita> = {};
      let visitasCompletas = true;
      for (let inicio = 0; inicio < sitios.length; inicio += 100) {
        const { data, error } = await sb.from('vw_maquina_ultima_visita')
          .select('site_id,visitado_en,usuario_email,funciona,distancia_m')
          .in('site_id', sitios.slice(inicio, inicio + 100));
        if (turno !== solicitud.current) return;
        if (error) {
          visitasCompletas = false;
          break;
        }
        for (const v of data || []) ultimas[v.site_id] = v as UltimaVisita;
      }
      const maquinas = filas.map((u) => ({ ...u, face_status: estadosInventario.get(u.vendor_face_id || '') ?? null }));
      setUbics(maquinas);
      setEstado(resumen);
      setVisitas(ultimas);
      setCopiaDe(null);
      setActualizado(new Date());
      if (!visitasCompletas) setErr('No se pudieron leer las visitas rápidas: los días sin visita solo cuentan las revisiones.');
      // Copia para abrir el módulo sin señal: solo lo que llegó completo y
      // con sesión REAL (una consulta anónima trae [] sin error).
      else if (await haySesionReal(email))
        void guardarMaquinasBioboxLocal(email, unidad, { maquinas, estado: resumen, visitas: ultimas });
    } catch (error) {
      if (turno !== solicitud.current) return;
      const copia = await leerMaquinasBioboxLocal<MaquinaBiobox, MapaResumen[string], UltimaVisita>(email, unidad);
      if (turno !== solicitud.current) return;
      if (copia && copia.maquinas.length) {
        setUbics(copia.maquinas);
        setEstado(copia.estado as MapaResumen);
        setVisitas(copia.visitas);
        setCopiaDe(copia.guardado);
        setActualizado(null);
      } else setErr(error instanceof Error ? error.message : 'No se pudieron actualizar las máquinas.');
    } finally {
      if (turno === solicitud.current) setCargando(false);
    }
  }, [unidad, email]);

  // La cola de visitas rápidas: ⏳ en cada máquina mientras no entre, y las
  // que ya entraron en esta pestaña cuentan aunque no se haya recargado.
  useEffect(() => {
    let vivo = true;
    let t: number | undefined;
    const leer = async () => {
      const l = await visitasPendientes(email).catch(() => [] as VisitaPendiente[]);
      if (!vivo) return;
      setPend(l.filter((p) => p.destino === 'maquina'));
      setEnviadasMaq(visitasMaquinaEnviadasEnSesion(email));
    };
    const alCambiar = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => void leer(), 200);
    };
    const quitar = suscribirVisitas(alCambiar);
    void leer();
    return () => {
      vivo = false;
      window.clearTimeout(t);
      quitar();
    };
  }, [email]);

  /** Por máquina: la marca más reciente (visita rápida, en cola o revisión). */
  const contacto = useMemo(() => {
    const m = new Map<string, { dias: number | null; pendiente: VisitaPendiente | null }>();
    const enSesion = new Map<string, string>();
    for (const e of enviadasMaq) enSesion.set(e.site_id, ultimoContacto(enSesion.get(e.site_id), e.visitado_en) || e.visitado_en);
    const enCola = new Map<string, VisitaPendiente>();
    for (const p of pend) {
      const prev = enCola.get(p.site_id);
      if (!prev || ultimoContacto(prev.visitado_en, p.visitado_en) === p.visitado_en) enCola.set(p.site_id, p);
    }
    const ahora = new Date();
    for (const u of ubics) {
      if (m.has(u.site_id)) continue;
      const cola = enCola.get(u.site_id) || null;
      const ultimo = ultimoContacto(
        visitas[u.site_id]?.visitado_en,
        enSesion.get(u.site_id),
        cola?.visitado_en,
        u.ultima_revision
      );
      m.set(u.site_id, { dias: diasDesde(ultimo, ahora), pendiente: cola });
    }
    return m;
  }, [ubics, visitas, enviadasMaq, pend]);

  const diasVisita = useCallback((u: MaquinaBiobox) => contacto.get(u.site_id)?.dias ?? null, [contacto]);

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
    // "Más urgente": la que lleva más días sin que nadie pase (visita rápida
    // o revisión); nunca visitada va primero.
    return filas.sort((a, b) => orden === 'abandono'
      ? (diasVisita(b) ?? Number.MAX_SAFE_INTEGER) - (diasVisita(a) ?? Number.MAX_SAFE_INTEGER)
      : orden === 'secuencia'
      ? (a.secuencia ?? 9999) - (b.secuencia ?? 9999) || a.site_id.localeCompare(b.site_id)
      : (a.site_legacy_id || a.site_id).localeCompare(b.site_legacy_id || b.site_id, undefined, { numeric: true }));
  }, [ubics, rutaFoco, medio, busca, orden, soloPendientes, diasVisita]);

  const indicadores = useMemo(() => {
    const base = indicadoresMaquinas(visibles, estado);
    // Sin visita (29-oct-2026): ni visita rápida ni revisión en más de
    // DIAS_VISITA_AMBAR días, o nunca. Va segundo, junto al total.
    const sinVisita = {
      id: 'sin_visita',
      titulo: 'Sin visita +' + DIAS_VISITA_AMBAR + ' días',
      color: 'var(--bad)',
      filas: maquinasUnicas(visibles).filter((u) => semaforoVisita(diasVisita(u)) === 'rojo'),
    };
    return [base[0], sinVisita, ...base.slice(1)];
  }, [visibles, estado, diasVisita]);
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
    const c = contacto.get(u.site_id);
    const dias = c?.dias ?? null;
    const uv = visitas[u.site_id];
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
              <span className="tag ruta-nombre" style={{ color: u.ruta_color, ...varRuta(u.ruta_color) }}>{nombreRuta(u)}</span>
              {/* Días sin que nadie pase: visita rápida o revisión (29-oct-2026). */}
              <span className="tag" style={{ color: COLOR_SEMAFORO[semaforoVisita(dias)], fontWeight: 600 }}>
                {textoDiasVisita(dias)}
              </span>
              {c?.pendiente && <span className="tag" style={{ color: c.pendiente.conError ? 'var(--bad)' : 'var(--muted)', whiteSpace: 'normal' }}>
                {c.pendiente.conError ? '⚠ Visita sin enviar' : c.pendiente.enviando ? '⏳ Enviando visita…' : '⏳ Visita por enviar'}
              </span>}
              {uv && !uv.funciona && <span className="tag" style={{ color: 'var(--bad)' }}>No funcionaba en la última visita</span>}
              {uv && uv.distancia_m != null && uv.distancia_m > LEJOS_M && <span className="tag" style={{ color: colorTono('ambar'), whiteSpace: 'normal' }}>
                Última visita marcada a {uv.distancia_m >= 1000 ? (uv.distancia_m / 1000).toFixed(1) + ' km' : Math.round(uv.distancia_m) + ' m'}
              </span>}
              {u.medio && <span className="tag" style={{ whiteSpace: 'normal' }}>{u.medio}{u.tipo_mueble ? ' · ' + u.tipo_mueble : ''}</span>}
              {/* Ámbar y naranja con pareja legible en el tema claro (tema
                  claro/oscuro, 24-sep-2026). */}
              <span className="tag" style={{ color: pendienteRevision(u) ? colorTono('ambar') : 'var(--ok)' }}>
                {u.dias_sin_revision == null ? 'Nunca revisada' : 'Revisada hace ' + u.dias_sin_revision + ' día' + (u.dias_sin_revision === 1 ? '' : 's')}
              </span>
              {!!u.puntos_anomalia && <span className="tag" style={{ color: NARANJA }}>
                {u.puntos_anomalia} anomalía{u.puntos_anomalia === 1 ? '' : 's'}
              </span>}
              <span className="tag" style={{ color: fueraDeLinea(u) ? 'var(--bad)' : 'var(--muted)', whiteSpace: 'normal' }}>
                {fueraDeLinea(u) ? 'Fuera de línea' : u.face_status || 'Sin estado en inventario'}
              </span>
              {!!e?.abiertas && <span className="tag" style={{ color: alarma ? 'var(--bad)' : NARANJA, whiteSpace: 'normal', maxWidth: '100%' }}>
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
            <button className="btn ghost sm" onClick={() => { setDetalle(null); setRevisando(u); }}>
              <Ic i={CircleCheck} />Revisar
            </button>
            <button className="btn sm" onClick={() => { setDetalle(null); setAviso(''); setVisitando(u); }}>
              <Ic i={MapPinCheck} />Visita rápida
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
      {/* Píldoras (rediseño, oct-2026). */}
      <div className="toolbar filtros-pildora">
        <select aria-label="Unidad" value={unidad} onChange={(e) => {
          setUnidad(e.target.value); setRutaFoco(null); setDetalle(null); setMaquinaAbierta(null);
          setUbics([]); setEstado({}); setActualizado(null);
        }}>
          {UNIDADES_BIOBOX.map((u) => <option key={u} value={u}>Unidad: {u}</option>)}
        </select>
        <select aria-label="Medio" className={medio !== 'todos' ? 'on' : undefined} value={medio} onChange={(e) => setMedio(e.target.value)}>
          <option value="todos">Medio: Digital e Impreso</option>
          <option value="Digital">Digital</option><option value="Impreso">Impreso</option>
        </select>
        <button className="btn sm ghost" onClick={() => void cargar()} disabled={cargando}>
          {cargando ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>
      <div role="status" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        {cargando ? 'Consultando máquinas, inventario e incidencias…' : actualizado ? 'Actualizado: ' + actualizado.toLocaleTimeString('es-MX') : ''}
      </div>
      {copiaDe && <div className="banner" role="status">
        Sin señal: es la lista guardada en el teléfono
        {Number.isFinite(Date.parse(copiaDe)) ? ' el ' + new Date(copiaDe).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}.
        La visita rápida funciona igual y se envía sola al volver la señal.
      </div>}
      {aviso && <div className="banner" role="status" style={{ color: 'var(--ok)' }}>{aviso}</div>}
      {err && <div className="err" role="alert">{err}{actualizado ? ' Se conservan los últimos datos cargados.' : ''}</div>}
      {!cargando && !ubics.length && !err && <div className="banner">
        No hay máquinas asignadas a rutas para {unidad}. Se dan de alta desde <b>Rutas de Operación → Importar mapa (KML)</b>.
      </div>}

      {!!ubics.length && <>
        <div className="toolbar">
          <input className="search" aria-label="Buscar máquina" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por número, dirección o clave" />
        </div>
        <div className="toolbar filtros-pildora">
          <select aria-label="Orden de máquinas" value={orden} onChange={(e) => setOrden(e.target.value as Orden)}>
            <option value="abandono">Ordenar: más urgente primero</option>
            <option value="secuencia">Ordenar: secuencia de la ruta</option>
            <option value="nombre">Ordenar: número de máquina</option>
          </select>
          {/* Casilla real dentro de una píldora (.pildora-check). */}
          <label className="pildora-check">
            <input type="checkbox" checked={soloPendientes} onChange={(e) => setSoloPendientes(e.target.checked)} />
            Solo las que toca revisar
          </label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
          <button className="btn ghost sm" aria-pressed={rutaFoco == null} onClick={() => setRutaFoco(null)} style={{ color: rutaFoco == null ? 'var(--accent-txt)' : undefined }}>
            Todas ({maquinasUnicas(ubics).length})
          </button>
          {rutas.map((r) => <button key={r.nombre} className="btn ghost sm ruta-nombre" aria-pressed={rutaFoco === r.nombre} onClick={() => setRutaFoco(rutaFoco === r.nombre ? null : r.nombre)} style={{ color: r.color, borderColor: rutaFoco === r.nombre ? r.color : undefined, ...varRuta(r.color) }}>
            {r.nombre} ({r.sitios.size})
          </button>)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 9, margin: '14px 0' }}>
          {indicadores.map((i) => <button key={i.id} type="button" disabled={cargando} onClick={() => { setDetalle(i.id); setMaquinaAbierta(null); }} className="card" style={{ minWidth: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }}>
            <div className="n" style={{ color: i.color }}>{i.filas.length}</div>
            <div className="l">{i.titulo}</div>
          </button>)}
        </div>
        {rutaFoco != null && !!tramos.length && <div className="card" style={{ marginBottom: 12 }}>
          <b><Ic i={Compass} />Recorrido de la ruta</b>
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
            <CerrarModal onClick={() => setDetalle(null)} />
            <h2 id="biobox-indicador-titulo">{indicadorAbierto.titulo}</h2>
            <p className="phint">{indicadorAbierto.filas.length} máquinas · {unidad}{rutaFoco ? ' · ' + rutaFoco : ''}{medio !== 'todos' ? ' · ' + medio : ''}{busca ? ' · ' + busca : ''}{soloPendientes ? ' · Pendientes de revisión' : ''}</p>
            <div style={{ display: 'grid', gap: 9, maxHeight: '60dvh', overflowY: 'auto' }}>
              {indicadorAbierto.filas.map((u) => tarjetaMaquina(u, true))}
              {!indicadorAbierto.filas.length && <p>Sin máquinas para este indicador con los filtros seleccionados.</p>}
            </div>
            <div className="modal-actions pie-fijo" style={{ marginTop: 12 }}><button autoFocus className="btn ghost" onClick={() => setDetalle(null)}>Cerrar</button></div>
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
      {visitando && <VisitaMaquinaModal
        email={email}
        maquina={visitando}
        onClose={() => setVisitando(null)}
        onGuardada={(texto) => { setVisitando(null); setAviso(texto); }}
        onRevisar={() => { const u = visitando; setVisitando(null); setRevisando(u); }}
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
