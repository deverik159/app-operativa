// ============================================================
// src/modules/aviso-nuc/AvisoNucView.tsx
// Aviso NUC (Erik, 29-oct-2026): tablero de las máquinas Biobox con el
// estado de su NUC, para que el técnico de Op. Bio Box sepa de un vistazo
// cuáles están fuera de línea y cuáles ya está revisando Digital.
//
//   Digital  → lo revisa y repara a distancia: «Marcar fuera de línea»,
//              «Estoy revisándolo» y «Ya está en línea».
//   Técnico  → solo ve el estado y el historial; le llegan los avisos de
//              fuera de línea y de en línea.
//
// Todo cambio va por las funciones nuc_aviso_* de la base, que vuelven a
// revisar quién llama y en qué estado está el aviso; aquí solo se ofrece lo
// que la base va a aceptar. La lista se refresca sola cada minuto.
// ============================================================
import { Check, History, RefreshCw, Router, ScanSearch, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sb } from '../../lib/supabase';
import { cargarNombres, nombreDe, type MapaNombres } from '../../lib/nombres';
import { colorTono, fondoTono, bordeTono } from '../../lib/tonos';
import { fechaHoraCdmx } from '../../lib/fechasCdmx';
import {
  ESTADOS_NUC,
  ETIQUETA_NUC,
  TONO_NUC,
  RESPUESTAS_DIGITAL,
  coincideMaquina,
  contarEstados,
  esDigitalNuc,
  estadoNuc,
  haceCuanto,
  maquinasDeInventario,
  ordenarTablero,
  type AvisoNuc,
  type EstadoNuc,
  type EventoNuc,
  type FilaInventarioNuc,
  type MaquinaNuc,
} from '../../lib/avisoNuc';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';

type Rol = { rol: string; unidad_negocio: string | null; departamento: string | null };

/** Qué ventana está abierta y sobre qué máquina. */
type Accion =
  | { tipo: 'abrir'; m: MaquinaNuc }
  | { tipo: 'en_linea'; m: MaquinaNuc; a: AvisoNuc };

/** Filtro de la lista: los avisos abiertos, un estado o todas. */
type Filtro = 'abiertos' | EstadoNuc | 'todas';

const REFRESCO_MS = 60 * 1000;

const COLUMNAS_INV =
  'site_id,site_legacy_id,vendor_face_id,unidad_negocio,tipo_medio,tipo_mueble,direccion,municipio';

const ACCION_TXT: Record<EventoNuc['accion'], string> = {
  abierto: 'Lo marcó fuera de línea',
  tomado: 'Empezó a revisarlo',
  en_linea: 'Lo puso en línea',
};

function pastilla(estado: EstadoNuc) {
  const t = TONO_NUC[estado];
  return { color: colorTono(t), background: fondoTono(t), borderColor: bordeTono(t) };
}

function AvisoNucView({ roles, unidades, recargarSignal = 0 }: {
  roles: Rol[];
  /** Unidades Biobox que puede ver (unidadesAvisoNuc). */
  unidades: string[];
  recargarSignal?: number;
}) {
  const [unidad, setUnidad] = useState(unidades[0] || 'Biobox');
  const [maquinas, setMaquinas] = useState<MaquinaNuc[]>([]);
  const [avisos, setAvisos] = useState<Map<string, AvisoNuc>>(new Map());
  const [nombres, setNombres] = useState<MapaNombres>({});
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState('');
  const [actualizado, setActualizado] = useState<Date | null>(null);
  const [filtro, setFiltro] = useState<Filtro>('abiertos');
  const [busca, setBusca] = useState('');
  const [accion, setAccion] = useState<Accion | null>(null);
  const [nota, setNota] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [errAccion, setErrAccion] = useState('');
  const [historial, setHistorial] = useState<{ m: MaquinaNuc; eventos: EventoNuc[] | null; err: string } | null>(null);
  const [ahora, setAhora] = useState(Date.now());
  const turno = useRef(0);

  const digital = esDigitalNuc(roles);

  const cargar = useCallback(async (silencioso = false) => {
    const t = ++turno.current;
    if (!silencioso) setCargando(true);
    try {
      const filas: FilaInventarioNuc[] = [];
      for (let inicio = 0; ; inicio += 1000) {
        const { data, error } = await sb.from('inventario').select(COLUMNAS_INV)
          .eq('unidad_negocio', unidad).order('vendor_face_id').range(inicio, inicio + 999);
        if (error) throw new Error('No se pudieron cargar las máquinas: ' + error.message);
        filas.push(...((data || []) as FilaInventarioNuc[]));
        if (!data || data.length < 1000) break;
      }
      const { data: abiertos, error: e2 } = await sb.from('nuc_avisos').select('*')
        .eq('unidad_negocio', unidad).neq('estado', 'en_linea');
      if (e2) throw new Error('No se pudieron cargar los avisos: ' + e2.message);
      if (t !== turno.current) return;
      setMaquinas(maquinasDeInventario(filas));
      setAvisos(new Map(((abiertos || []) as AvisoNuc[]).map((a) => [a.site_id, a])));
      setActualizado(new Date());
      setAhora(Date.now());
      setErr('');
    } catch (e) {
      if (t === turno.current) setErr(e instanceof Error ? e.message : 'No se pudo actualizar el tablero.');
    } finally {
      if (t === turno.current) setCargando(false);
    }
  }, [unidad]);

  useEffect(() => {
    void cargar();
    return () => { turno.current++; };
  }, [cargar, recargarSignal]);

  // Refresco cada minuto mientras la pestaña está a la vista; al volver a
  // ella, de inmediato.
  useEffect(() => {
    const tic = () => { if (document.visibilityState === 'visible') void cargar(true); };
    const id = window.setInterval(tic, REFRESCO_MS);
    document.addEventListener('visibilitychange', tic);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', tic); };
  }, [cargar]);

  useEffect(() => {
    let vivo = true;
    void cargarNombres().then((n) => { if (vivo) setNombres(n); });
    return () => { vivo = false; };
  }, []);

  const conteo = useMemo(() => contarEstados(maquinas, avisos), [maquinas, avisos]);

  const visibles = useMemo(() => {
    const q = busca.trim();
    // Con texto se busca en todas: Digital necesita encontrar la máquina que
    // va a marcar aunque esté en línea.
    const filtradas = maquinas.filter((m) => {
      if (q) return coincideMaquina(m, q);
      const e = estadoNuc(avisos.get(m.site_id));
      return filtro === 'todas' || (filtro === 'abiertos' ? e !== 'en_linea' : e === filtro);
    });
    return ordenarTablero(filtradas, avisos);
  }, [maquinas, avisos, filtro, busca]);

  const abrirAccion = (a: Accion) => { setAccion(a); setNota(''); setErrAccion(''); };

  const tomar = async (a: AvisoNuc) => {
    setGuardando(true);
    const { error } = await sb.rpc('nuc_aviso_tomar', { p_id: a.id });
    setGuardando(false);
    if (error) setErr(error.message);
    await cargar(true);
  };

  const guardarAccion = async () => {
    if (!accion) return;
    const n = nota.trim() || null;
    setGuardando(true);
    setErrAccion('');
    const { error } = accion.tipo === 'abrir'
      ? await sb.rpc('nuc_aviso_abrir', { p_site_id: accion.m.site_id, p_nota: n })
      : await sb.rpc('nuc_aviso_en_linea', { p_id: accion.a.id, p_nota: n });
    setGuardando(false);
    if (error) {
      setErrAccion(error.message);
      return;
    }
    setAccion(null);
    await cargar(true);
  };

  const verHistorial = async (m: MaquinaNuc) => {
    setHistorial({ m, eventos: null, err: '' });
    const { data: avs, error } = await sb.from('nuc_avisos').select('id').eq('site_id', m.site_id)
      .order('abierto_en', { ascending: false }).limit(10);
    if (error) { setHistorial({ m, eventos: [], err: error.message }); return; }
    const ids = (avs || []).map((x) => x.id as number);
    if (!ids.length) { setHistorial({ m, eventos: [], err: '' }); return; }
    const { data: evs, error: e2 } = await sb.from('nuc_avisos_eventos').select('*')
      .in('aviso_id', ids).order('en', { ascending: false });
    setHistorial({ m, eventos: (evs || []) as EventoNuc[], err: e2 ? e2.message : '' });
  };

  const persona = (correo: string | null) => nombreDe(nombres, correo);

  /** Qué dice la pastilla de estado: el estado, desde cuándo y quién. */
  const detalleEstado = (a: AvisoNuc | undefined): string => {
    const e = estadoNuc(a);
    if (!a || e === 'en_linea') return ETIQUETA_NUC.en_linea;
    const hace = haceCuanto(a.actualizado_en, ahora);
    if (e === 'fuera_linea') return `Fuera de línea ${hace} · Digital aún no la revisa`;
    return `En revisión · ${persona(a.tomado_por)} (Digital) ${hace}`;
  };

  const tarjeta = (m: MaquinaNuc) => {
    const a = avisos.get(m.site_id);
    const e = estadoNuc(a);
    const p = pastilla(e);
    return (
      <div key={m.site_id} style={{ background: 'var(--panel2)', border: '1px solid ' + (e === 'en_linea' ? 'var(--line)' : p.borderColor), borderLeft: '4px solid ' + p.color, borderRadius: 10, padding: '11px 12px', minWidth: 0, overflowWrap: 'anywhere' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            {/* La clave del mueble va primero: es la nomenclatura con que trabaja
                el técnico (Erik, 29-oct-2026); el nombre, debajo. */}
            <b>{m.site_id}</b>
            {m.nombre !== m.site_id && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{m.nombre}</div>}
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              {m.direccion || '(sin dirección)'}{m.municipio ? ' · ' + m.municipio : ''}{m.tipo_mueble ? ' · ' + m.tipo_mueble : ''}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
              <span className="tag" style={{ ...p, whiteSpace: 'normal' }}>{detalleEstado(a)}</span>
            </div>
            {a && e !== 'en_linea' && a.nota_digital && <div style={{ fontSize: 12, marginTop: 6 }}>
              <span style={{ color: 'var(--muted)' }}>Digital:</span> {a.nota_digital}
            </div>}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn ghost sm" onClick={() => void verHistorial(m)}><Ic i={History} />Historial</button>
            {digital && e === 'en_linea' && <button className="btn ghost sm" onClick={() => abrirAccion({ tipo: 'abrir', m })}>
              <Ic i={TriangleAlert} />Marcar fuera de línea
            </button>}
            {digital && a && e === 'fuera_linea' && <button className="btn ghost sm" disabled={guardando} onClick={() => void tomar(a)}>
              <Ic i={ScanSearch} />Estoy revisándolo
            </button>}
            {digital && a && e !== 'en_linea' && <button className={'btn sm' + (e === 'en_revision' ? '' : ' ghost')} onClick={() => abrirAccion({ tipo: 'en_linea', m, a })}>
              <Ic i={Check} />Ya está en línea
            </button>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div>
      <h2 className="page"><Ic i={Router} />Aviso NUC</h2>
      <p className="phint">
        {digital
          ? 'Marca las máquinas Biobox con el NUC fuera de línea, revísalas y ponlas en línea; el técnico de Op. Bio Box recibe el aviso en cada caso.'
          : 'Máquinas Biobox con el NUC fuera de línea o en revisión por Digital. Te llega un aviso cuando una se cae y cuando vuelve a estar en línea.'}
      </p>
      <div className="toolbar filtros-pildora">
        {unidades.length > 1 && <select aria-label="Unidad" value={unidad} onChange={(e) => {
          setUnidad(e.target.value); setMaquinas([]); setAvisos(new Map()); setActualizado(null);
        }}>
          {unidades.map((u) => <option key={u} value={u}>Unidad: {u}</option>)}
        </select>}
        <button className="btn sm ghost" onClick={() => void cargar()} disabled={cargando}>
          <Ic i={RefreshCw} />{cargando ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>
      <div role="status" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        {cargando ? 'Consultando máquinas y avisos…' : actualizado ? 'Actualizado: ' + actualizado.toLocaleTimeString('es-MX') + ' · se actualiza solo cada minuto' : ''}
      </div>
      {err && <div className="err" role="alert">{err}{actualizado ? ' Se conservan los últimos datos cargados.' : ''}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', gap: 9, margin: '4px 0 14px' }}>
        {ESTADOS_NUC.map((e) => {
          const p = pastilla(e);
          const activo = filtro === e;
          return <button key={e} type="button" aria-pressed={activo} onClick={() => { setFiltro(activo ? 'abiertos' : e); setBusca(''); }} className="card" style={{ minWidth: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', background: conteo[e] && e !== 'en_linea' ? p.background : undefined, borderColor: activo ? p.color : undefined }}>
            <div className="n" style={{ color: p.color }}>{conteo[e]}</div>
            <div className="l">{ETIQUETA_NUC[e]}</div>
          </button>;
        })}
      </div>

      <div className="toolbar">
        <input className="search" aria-label="Buscar máquina" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por número, clave o dirección" />
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
        {busca.trim() ? `Buscando en las ${maquinas.length} máquinas de ${unidad}`
          : filtro === 'abiertos' ? 'Máquinas con aviso abierto'
          : filtro === 'todas' ? 'Todas las máquinas'
          : ETIQUETA_NUC[filtro as EstadoNuc]}
        {' · '}
        <button type="button" className="btn ghost sm" style={{ padding: '2px 8px' }} onClick={() => { setFiltro(filtro === 'todas' ? 'abiertos' : 'todas'); setBusca(''); }}>
          {filtro === 'todas' ? 'Ver solo con aviso' : 'Ver todas'}
        </button>
      </div>

      {!cargando && !err && !maquinas.length && <div className="banner">No hay máquinas de {unidad} en el inventario.</div>}
      <div style={{ display: 'grid', gap: 9 }}>{visibles.map(tarjeta)}</div>
      {!!maquinas.length && !visibles.length && <div className="banner">
        {busca.trim() ? 'Ninguna máquina coincide con la búsqueda.'
          : filtro === 'abiertos' ? 'Todas las máquinas están en línea: no hay avisos abiertos.'
          : 'No hay máquinas en este estado.'}
      </div>}

      {accion && createPortal(
        <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !guardando) setAccion(null); }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="nuc-accion-titulo" style={{ maxWidth: 520 }}>
            <CerrarModal onClick={() => setAccion(null)} disabled={guardando} />
            <h2 id="nuc-accion-titulo">{accion.tipo === 'abrir' ? 'Marcar NUC fuera de línea' : 'Poner el NUC en línea'}</h2>
            <p className="phint">{accion.m.site_id} · {accion.m.nombre !== accion.m.site_id ? accion.m.nombre : accion.m.direccion}</p>
            {accion.tipo === 'en_linea' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {RESPUESTAS_DIGITAL.map((r) => <button key={r} type="button" className="btn ghost sm" aria-pressed={nota === r} onClick={() => setNota(r)}>{r}</button>)}
            </div>}
            <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }} htmlFor="nuc-nota">
              {accion.tipo === 'abrir' ? 'Nota para el técnico (opcional)' : 'Qué se hizo (opcional; le llega al técnico)'}
            </label>
            <textarea id="nuc-nota" rows={3} maxLength={500} value={nota} onChange={(e) => { setNota(e.target.value); setErrAccion(''); }} style={{ width: '100%', fontSize: 16 }} />
            {errAccion && <div className="err" role="alert" style={{ marginTop: 8 }}>{errAccion}</div>}
            <div className="modal-actions pie-fijo" style={{ marginTop: 12 }}>
              <button className="btn ghost" onClick={() => setAccion(null)} disabled={guardando}>Cancelar</button>
              <button className="btn" onClick={() => void guardarAccion()} disabled={guardando}>
                {guardando ? 'Guardando…' : accion.tipo === 'abrir' ? 'Avisar al técnico' : 'Poner en línea y avisar'}
              </button>
            </div>
          </section>
        </div>, document.body
      )}

      {historial && createPortal(
        <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) setHistorial(null); }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="nuc-historial-titulo" style={{ maxWidth: 560 }}>
            <CerrarModal onClick={() => setHistorial(null)} />
            <h2 id="nuc-historial-titulo">Historial del NUC</h2>
            <p className="phint">{historial.m.site_id} · últimos 10 avisos</p>
            {historial.err && <div className="err" role="alert">{historial.err}</div>}
            {!historial.eventos && <p>Cargando…</p>}
            {historial.eventos && !historial.eventos.length && !historial.err && <p>Esta máquina no ha tenido avisos de NUC.</p>}
            <div style={{ display: 'grid', gap: 8, maxHeight: '60dvh', overflowY: 'auto' }}>
              {historial.eventos?.map((ev) => <div key={ev.id} style={{ borderLeft: '3px solid ' + colorTono(TONO_NUC[ev.estado]), paddingLeft: 10 }}>
                <div style={{ fontSize: 13 }}><b>{ACCION_TXT[ev.accion]}</b> · {persona(ev.por)}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{fechaHoraCdmx(ev.en)}</div>
                {ev.nota && <div style={{ fontSize: 13 }}>{ev.nota}</div>}
              </div>)}
            </div>
            <div className="modal-actions pie-fijo" style={{ marginTop: 12 }}><button autoFocus className="btn ghost" onClick={() => setHistorial(null)}>Cerrar</button></div>
          </section>
        </div>, document.body
      )}
    </div>
  );
}

export default AvisoNucView;
