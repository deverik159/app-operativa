// ============================================================
// src/modules/reportes-app-biobox/ReportesAppBioboxView.tsx
// Bandeja «Reportes App Biobox» (Erik, 9-nov-2026; ficha
// reportes-app-biobox del contexto).
//
// Los reportes que los usuarios levantan en la app de Biobox llegan aquí cada
// 20 min desde la PC con VPN (tabla biobox_app_reportes). Son APARTE de las
// incidencias hasta que la validadora decide:
//   · Clasificar → elige la falla de nuestro catálogo (SelectorFalla, con la
//     sugerencia de la tabla de equivalencias) y nace la incidencia ligada,
//     ya validada y En proceso, con el técnico del área.
//   · Ligar      → a una incidencia abierta (varios usuarios, misma máquina).
//   · Descartar  → pruebas, repetidos, no es falla (con motivo).
// Los de puntos entran solos a TI («Directo»). Al cerrarse la incidencia (o
// al repararla, si lo marca el técnico) el reporte pasa a «Marcar Atendido»:
// alguien lo marca en el Webadmin y el siguiente sync lo detecta solo.
//
// Todo cambio va por funciones de la base (clasificar_/ligar_/descartar_
// reporte_biobox_app) que vuelven a revisar quién llama. El coordinador y
// Consulta solo ven. Nunca se escribe en la base de Biobox.
// ============================================================
import { Ban, ExternalLink, Image as IconoImagen, Link2, RefreshCw, Smartphone, Tags, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sb } from '../../lib/supabase';
import { haySenal } from '../../lib/datosLocales';
import { fechaHoraCdmx } from '../../lib/fechasCdmx';
import { cargarNombres, nombreDe, type MapaNombres } from '../../lib/nombres';
import {
  ETIQUETA_ESTADO,
  MINUTOS_SYNC_ATRASADO,
  atiendeUnidad,
  coincideBusqueda,
  desfase,
  equivalenciaDe,
  estadoBandeja,
  fechaCoreAIso,
  leerErrorBandeja,
  minutosDesde,
  textoEstatusCore,
  unidadesBandeja,
  type Equivalencia,
  type EstadoBandeja,
  type IncLigada,
  type ReporteAppBiobox,
} from '../../lib/reportesAppBiobox';
import type { CatalogoIncidencia } from '../../types/db';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';
import SelectorFalla, { Derivado } from '../incidencias/SelectorFalla';

type FilaRol = { rol: string; unidad_negocio: string | null };
type Props = { roles: readonly FilaRol[]; recargarSignal?: number };

type Maquina = { vendor_face_id: string; tipo_mueble: string | null; site_legacy_id: string | null; direccion: string | null };
type SyncEstado = { ultima_carga: string | null; ultimo_resultado: Record<string, unknown> | null };

const TODAS = 'Todas';
const ESTADOS: EstadoBandeja[] = ['por_clasificar', 'en_proceso', 'marcar_atendido', 'terminado', 'descartado'];
const TONO: Record<EstadoBandeja, string> = {
  por_clasificar: 'var(--st-ambar)',
  en_proceso: 'var(--accent)',
  marcar_atendido: 'var(--warn)',
  terminado: 'var(--ok)',
  descartado: 'var(--muted)',
};
const ESTATUS_INC: Record<string, string> = {
  por_validar: 'Por validar',
  rechazada: 'Devuelta',
  en_proceso: 'En proceso',
  reparado: 'Reparado',
  cerrada: 'Cerrada',
  no_reparado: 'No reparado',
};
const ABIERTOS = ['por_validar', 'en_proceso', 'reparado', 'rechazada'];
const COLS_INC = 'record_id,folio,estatus,nombre_incidencia,area_responsable,assigned_area,repaired_by_email';
const SIN_SENAL = 'Necesitas señal para esto.';

/** La fecha de Biobox viene en UTC: se enseña en hora de CDMX, como toda la app. */
const fechaReporte = (texto: string) => {
  const iso = fechaCoreAIso(texto);
  return iso ? fechaHoraCdmx(iso) : texto;
};

/** Acción abierta sobre un reporte. */
type Accion =
  | { tipo: 'clasificar'; r: ReporteAppBiobox }
  | { tipo: 'ligar'; r: ReporteAppBiobox; folio?: string }
  | { tipo: 'descartar'; r: ReporteAppBiobox };

export default function ReportesAppBioboxView({ roles, recargarSignal }: Props) {
  const unidades = useMemo(() => unidadesBandeja(roles), [roles]);
  const [unidad, setUnidad] = useState<string>(TODAS);
  const [reportes, setReportes] = useState<ReporteAppBiobox[]>([]);
  const [incs, setIncs] = useState<Map<string, IncLigada>>(new Map());
  const [maquinas, setMaquinas] = useState<Map<string, Maquina>>(new Map());
  const [equivalencias, setEquivalencias] = useState<Equivalencia[]>([]);
  const [sync, setSync] = useState<SyncEstado | null>(null);
  const [nombres, setNombres] = useState<MapaNombres>({});
  const [filtro, setFiltro] = useState<EstadoBandeja>('por_clasificar');
  const [busca, setBusca] = useState('');
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState('');
  const [actualizado, setActualizado] = useState<Date | null>(null);
  const [accion, setAccion] = useState<Accion | null>(null);
  const turno = useRef(0);

  const cargar = useCallback(async () => {
    const mio = ++turno.current;
    setCargando(true);
    setErr('');
    try {
      const lista = unidad === TODAS ? unidades : [unidad];
      const [rr, re, rs] = await Promise.all([
        sb.from('biobox_app_reportes').select('*').in('unidad_negocio', lista)
          .order('report_id', { ascending: false }).limit(1000),
        sb.from('biobox_app_equivalencias').select('unidad_negocio,caso_id,catalogo_detalle,etiqueta,directo_al_area,marca_atendido,activo'),
        sb.from('biobox_app_sync_estado').select('ultima_carga,ultimo_resultado').eq('id', 1).maybeSingle(),
      ]);
      if (rr.error) throw rr.error;
      const filas = (rr.data || []) as ReporteAppBiobox[];
      const ids = [...new Set(filas.map((f) => f.record_id).filter(Boolean))] as string[];
      const claves = [...new Set(filas.map((f) => f.clave_inventario).filter(Boolean))] as string[];
      const [ri, rm] = await Promise.all([
        ids.length ? sb.from('incidencias').select(COLS_INC).in('record_id', ids) : Promise.resolve({ data: [], error: null }),
        claves.length
          ? sb.from('inventario').select('vendor_face_id,tipo_mueble,site_legacy_id,direccion').in('vendor_face_id', claves)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (ri.error) throw ri.error;
      if (mio !== turno.current) return;
      setReportes(filas);
      setIncs(new Map(((ri.data || []) as IncLigada[]).map((i) => [i.record_id, i])));
      setMaquinas(new Map(((rm.data || []) as Maquina[]).map((m) => [m.vendor_face_id, m])));
      setEquivalencias((re.data || []) as Equivalencia[]);
      setSync((rs.data as SyncEstado | null) ?? null);
      setActualizado(new Date());
    } catch (e) {
      if (mio !== turno.current) return;
      setErr(haySenal() ? 'No se pudo cargar la bandeja: ' + ((e as Error).message || e) : 'Sin señal.');
    } finally {
      if (mio === turno.current) setCargando(false);
    }
  }, [unidad, unidades]);

  useEffect(() => { void cargar(); }, [cargar, recargarSignal]);
  // Cada minuto con la app a la vista (el sync de la PC es cada 20 min).
  useEffect(() => {
    const tic = () => { if (document.visibilityState === 'visible') void cargar(); };
    const id = window.setInterval(tic, 60000);
    document.addEventListener('visibilitychange', tic);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', tic); };
  }, [cargar]);
  useEffect(() => {
    let vivo = true;
    void cargarNombres().then((n) => { if (vivo) setNombres(n); });
    return () => { vivo = false; };
  }, []);

  const conEstado = useMemo(
    () => reportes.map((r) => {
      const inc = r.record_id ? incs.get(r.record_id) : undefined;
      return { r, inc, estado: estadoBandeja(r, inc) };
    }),
    [reportes, incs]
  );
  const conteo = useMemo(() => {
    const c = Object.fromEntries(ESTADOS.map((e) => [e, 0])) as Record<EstadoBandeja, number>;
    conEstado.forEach((x) => { c[x.estado]++; });
    return c;
  }, [conEstado]);
  const visibles = useMemo(
    () => conEstado.filter((x) => (busca.trim() ? true : x.estado === filtro) && coincideBusqueda(x.r, x.inc, busca)),
    [conEstado, filtro, busca]
  );

  const minSync = minutosDesde(sync?.ultima_carga);
  const persona = (correo: string | null) => nombreDe(nombres, correo);

  const tarjeta = ({ r, inc, estado }: (typeof conEstado)[number]) => {
    const m = r.clave_inventario ? maquinas.get(r.clave_inventario) : undefined;
    const puede = atiendeUnidad(roles, r.unidad_negocio);
    const aviso = desfase(r, inc);
    return (
      <div key={r.report_id} className="card" style={{ textAlign: 'left', borderLeft: '4px solid ' + TONO[estado] }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            <b style={{ color: 'var(--txt)' }}>App {r.folio_app || r.report_id}</b>
            {' · '}{r.unidad_negocio}{r.fecha_reporte_core ? ' · ' + fechaReporte(r.fecha_reporte_core) : ''}
          </div>
          <span className="tag" title="Estatus que ve el usuario en la app Biobox">
            App Biobox: {textoEstatusCore(r)}
          </span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, margin: '6px 0 2px' }}>
          {r.motivo || 'Sin motivo'}{r.etiqueta ? <span style={{ fontWeight: 400, color: 'var(--muted)' }}> · {r.etiqueta}</span> : null}
        </div>
        {r.descripcion && <div style={{ fontSize: 14, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.descripcion}</div>}
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, overflowWrap: 'anywhere' }}>
          {r.clave_inventario
            ? <>Máquina {r.clave_inventario}{m?.site_legacy_id || r.nombre_maquina ? ' · ' + (m?.site_legacy_id || r.nombre_maquina) : ''}</>
            : r.codigo_maquina ? <>Máquina {r.codigo_maquina} (no está en el inventario)</> : <>Sin máquina en el reporte</>}
        </div>
        {inc && (
          <div style={{ fontSize: 13, marginTop: 6 }}>
            <b>{inc.folio || '—'}</b> · {ESTATUS_INC[inc.estatus] || inc.estatus} · {inc.assigned_area || inc.area_responsable || '—'}
            {' · '}{r.decision === 'directo' ? 'Directo al área' : r.decision === 'ligado' ? 'Ligado' : 'Clasificado'}
            {r.marca_atendido && <> · Marca Atendido: {r.marca_atendido === 'tecnico' ? 'el técnico' : 'la validadora'}</>}
          </div>
        )}
        {r.decision === 'descartado' && (
          <div style={{ fontSize: 13, marginTop: 6 }}>Descartado por {persona(r.decidido_por)}: «{r.motivo_descarte}»</div>
        )}
        {r.decision === 'atendido_en_webadmin' && (
          <div style={{ fontSize: 13, marginTop: 6, color: 'var(--muted)' }}>Se atendió en el Webadmin antes de clasificarlo.</div>
        )}
        {!r.presente && (
          <div style={{ fontSize: 12, marginTop: 6, color: 'var(--warn)' }}>Ya no aparece en la base de Biobox (se conserva, no se da por cerrado).</div>
        )}
        {estado === 'marcar_atendido' && (
          <div className="banner" style={{ marginTop: 8 }}>
            Marca este reporte como <b>Atendido</b> en el Webadmin (folio {r.folio_app || r.report_id}): así le llega el aviso al usuario. Aquí se quita solo en la siguiente carga.
          </div>
        )}
        {aviso && <div style={{ fontSize: 13, marginTop: 6, color: 'var(--warn)' }}><Ic i={TriangleAlert} />{aviso}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {r.evidencia_url && /^https:\/\//i.test(r.evidencia_url) && (
            <a className="btn ghost sm" href={r.evidencia_url} target="_blank" rel="noopener noreferrer nofollow">
              <Ic i={IconoImagen} />Foto del usuario<Ic i={ExternalLink} />
            </a>
          )}
          {puede && estado === 'por_clasificar' && <>
            <button className="btn sm" onClick={() => setAccion({ tipo: 'clasificar', r })}><Ic i={Tags} />Clasificar</button>
            <button className="btn ghost sm" onClick={() => setAccion({ tipo: 'ligar', r })}><Ic i={Link2} />Ligar a un folio</button>
            <button className="btn ghost sm" onClick={() => setAccion({ tipo: 'descartar', r })}><Ic i={Ban} />Descartar</button>
          </>}
        </div>
      </div>
    );
  };

  const alTerminar = () => { setAccion(null); void cargar(); };

  return (
    <div>
      <h2 className="page"><Ic i={Smartphone} />Reportes App Biobox</h2>
      <p className="phint">
        Lo que los usuarios reportan en la app de Biobox. Clasifícalo con nuestro catálogo para que entre al
        flujo con el técnico; cuando se cierre, márcalo «Atendido» en el Webadmin para que le llegue el aviso al usuario.
      </p>
      <div className="toolbar filtros-pildora">
        {unidades.length > 1 && (
          <select aria-label="Unidad" value={unidad} onChange={(e) => setUnidad(e.target.value)}>
            <option value={TODAS}>Unidad: todas</option>
            {unidades.map((u) => <option key={u} value={u}>Unidad: {u}</option>)}
          </select>
        )}
        <button className="btn sm ghost" onClick={() => void cargar()} disabled={cargando}>
          <Ic i={RefreshCw} />{cargando ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>
      <div role="status" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
        {sync?.ultima_carga
          ? <>Última carga desde la app Biobox: {fechaHoraCdmx(sync.ultima_carga)} (hace {minSync} min) · se carga cada 20 min</>
          : 'Todavía no llega ninguna carga desde la app Biobox.'}
        {actualizado ? ' · pantalla actualizada ' + actualizado.toLocaleTimeString('es-MX') : ''}
      </div>
      {minSync != null && minSync > MINUTOS_SYNC_ATRASADO && (
        <div className="err" role="alert">
          <Ic i={TriangleAlert} />Hace {minSync} min que no llegan datos de la app Biobox: la carga depende de la PC de Erik encendida y con VPN.
        </div>
      )}
      {err && <div className="err" role="alert">{err}{actualizado ? ' Se conservan los últimos datos cargados.' : ''}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', gap: 9, margin: '4px 0 14px' }}>
        {ESTADOS.map((e) => {
          const activo = filtro === e && !busca.trim();
          return (
            <button key={e} type="button" aria-pressed={activo} className="card"
              onClick={() => { setFiltro(e); setBusca(''); }}
              style={{ minWidth: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', borderColor: activo ? TONO[e] : undefined }}>
              <div className="n" style={{ color: TONO[e] }}>{conteo[e]}</div>
              <div className="l">{ETIQUETA_ESTADO[e]}</div>
            </button>
          );
        })}
      </div>

      <div className="toolbar">
        <input className="search" aria-label="Buscar reporte" value={busca} onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por folio, máquina, motivo o descripción" />
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
        {busca.trim() ? `Buscando en los ${reportes.length} reportes` : ETIQUETA_ESTADO[filtro]}
      </div>

      <div style={{ display: 'grid', gap: 9 }}>{visibles.map(tarjeta)}</div>
      {!cargando && !err && !visibles.length && (
        <div className="banner">
          {busca.trim() ? 'Ningún reporte coincide con la búsqueda.'
            : filtro === 'por_clasificar' ? 'No hay reportes por clasificar.'
            : filtro === 'marcar_atendido' ? 'No hay nada pendiente de marcar en el Webadmin.'
            : 'No hay reportes aquí.'}
        </div>
      )}

      {accion?.tipo === 'clasificar' && (
        <ClasificarModal
          r={accion.r}
          mueble={(accion.r.clave_inventario && maquinas.get(accion.r.clave_inventario)?.tipo_mueble) || null}
          sugerida={equivalenciaDe(accion.r, equivalencias)?.catalogo_detalle || null}
          onCerrar={() => setAccion(null)}
          onListo={alTerminar}
          onLigar={(folio) => setAccion({ tipo: 'ligar', r: accion.r, folio })}
        />
      )}
      {accion?.tipo === 'ligar' && (
        <LigarModal r={accion.r} folioInicial={accion.folio} onCerrar={() => setAccion(null)} onListo={alTerminar} />
      )}
      {accion?.tipo === 'descartar' && (
        <DescartarModal r={accion.r} onCerrar={() => setAccion(null)} onListo={alTerminar} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

function Encabezado({ r }: { r: ReporteAppBiobox }) {
  return (
    <p className="phint" style={{ overflowWrap: 'anywhere' }}>
      App {r.folio_app || r.report_id} · {r.motivo || 'Sin motivo'}{r.etiqueta ? ' · ' + r.etiqueta : ''}
      {r.descripcion ? <><br />«{r.descripcion.slice(0, 200)}{r.descripcion.length > 200 ? '…' : ''}»</> : null}
    </p>
  );
}

function Modal({ titulo, onCerrar, ocupado, children }: { titulo: string; onCerrar: () => void; ocupado: boolean; children: React.ReactNode }) {
  return createPortal(
    <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !ocupado) onCerrar(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={titulo} style={{ maxWidth: 560 }}>
        <CerrarModal onClick={onCerrar} disabled={ocupado} />
        <h2 style={{ margin: '0 0 3px' }}>{titulo}</h2>
        {children}
      </section>
    </div>,
    document.body
  );
}

function ClasificarModal({ r, mueble, sugerida, onCerrar, onListo, onLigar }: {
  r: ReporteAppBiobox; mueble: string | null; sugerida: string | null;
  onCerrar: () => void; onListo: () => void; onLigar: (folio: string) => void;
}) {
  const [sel, setSel] = useState<CatalogoIncidencia | null>(null);
  const [sinMaquina, setSinMaquina] = useState(!r.clave_inventario);
  const [obs, setObs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ texto: string; folioDuplicado: string | null } | null>(null);

  const guardar = async () => {
    if (!sel) return;
    if (!haySenal()) { setError({ texto: SIN_SENAL, folioDuplicado: null }); return; }
    setBusy(true);
    setError(null);
    const { data, error: e } = await sb.rpc('clasificar_reporte_biobox_app', {
      p_report_id: r.report_id,
      p_falla: { detalle: sel.detalle, area: sel.area, impacto: sel.impacto, origen: sel.origen, tipo: sel.tipo },
      p_clave_medio: sinMaquina ? 'SIN-MAQUINA' : r.clave_inventario,
      p_observaciones: obs.trim() || null,
    });
    setBusy(false);
    if (e) { setError(leerErrorBandeja(e.message)); return; }
    alert(`Listo: se creó la incidencia ${data} y se avisó al área ${sel.area}.`);
    onListo();
  };

  return (
    <Modal titulo="Clasificar reporte" onCerrar={onCerrar} ocupado={busy}>
      <Encabezado r={r} />
      <div className="field">
        <span className="etiqueta">Máquina</span>
        <div style={{ fontSize: 14, overflowWrap: 'anywhere' }}>
          {r.clave_inventario && !sinMaquina
            ? r.clave_inventario
            : r.clave_inventario
              ? 'Sin máquina: es de puntos, de la cuenta o de la app'
              : 'Sin máquina (el técnico la elige al reparar)'}
        </div>
      </div>
      {/* Fuera de .field: su regla `.field label` (bloque, 12 px, gris) le
          ganaba a la píldora. Misma casilla que los filtros de Máquinas Biobox. */}
      {r.clave_inventario && (
        <div style={{ margin: '-4px 0 13px' }}>
          <label className="pildora-check" style={{ maxWidth: '100%' }}>
            <input type="checkbox" checked={sinMaquina} onChange={(e) => setSinMaquina(e.target.checked)} />
            No es falla de la máquina
          </label>
        </div>
      )}
      {sugerida && <div className="phint" style={{ margin: '0 0 6px' }}>Sugerida por la tabla de equivalencias: <b>{sugerida}</b></div>}
      <SelectorFalla unidad={r.unidad_negocio} mueble={sinMaquina ? null : mueble} actual={sugerida} onElegir={setSel} />
      <div className="row2">
        <Derivado label="Nivel" valor={(sel?.impacto || '').trim()} />
        <Derivado label="Área responsable" valor={(sel?.area || '').trim()} />
      </div>
      <div className="field">
        <label>Observaciones para el técnico (opcional)</label>
        <textarea rows={2} maxLength={500} value={obs} onChange={(e) => setObs(e.target.value)} />
      </div>
      <div className="phint" style={{ margin: '0 0 8px' }}>
        La incidencia nace <b>validada y En proceso</b>; el folio, el motivo y lo que escribió el usuario van en sus observaciones.
      </div>
      {error && (
        <div className="err" role="alert">
          {error.texto}
          {error.folioDuplicado && (
            <div style={{ marginTop: 6 }}>
              <button className="btn sm" onClick={() => onLigar(error.folioDuplicado!)}><Ic i={Link2} />Ligar a {error.folioDuplicado}</button>
            </div>
          )}
        </div>
      )}
      <div className="modal-actions pie-fijo">
        <button className="btn ghost" onClick={onCerrar} disabled={busy}>Cancelar</button>
        <button className="btn" onClick={() => void guardar()} disabled={busy || !sel}>
          {busy ? 'Guardando…' : 'Crear incidencia'}
        </button>
      </div>
    </Modal>
  );
}

type Candidata = IncLigada & { clave_medio: string | null; creado_en: string | null };

function LigarModal({ r, folioInicial, onCerrar, onListo }: {
  r: ReporteAppBiobox; folioInicial?: string; onCerrar: () => void; onListo: () => void;
}) {
  const [candidatas, setCandidatas] = useState<Candidata[] | null>(null);
  const [folio, setFolio] = useState(folioInicial || '');
  const [elegida, setElegida] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Las abiertas de la misma máquina; sin máquina, se busca por folio.
  useEffect(() => {
    let vivo = true;
    (async () => {
      let q = sb.from('incidencias').select(COLS_INC + ',clave_medio,creado_en')
        .eq('unidad_negocio', r.unidad_negocio).in('estatus', ABIERTOS)
        .order('creado_en', { ascending: false }).limit(30);
      const f = folio.trim().toUpperCase();
      if (f) q = q.eq('folio', f);
      else if (r.clave_inventario) q = q.eq('clave_medio', r.clave_inventario);
      else { if (vivo) setCandidatas([]); return; }
      const { data, error: e } = await q;
      if (!vivo) return;
      if (e) { setError(e.message); setCandidatas([]); return; }
      const lista = (data || []) as unknown as Candidata[];
      setCandidatas(lista);
      if (lista.length === 1) setElegida(lista[0].record_id);
    })();
    return () => { vivo = false; };
  }, [r, folio]);

  const guardar = async () => {
    if (!elegida) return;
    if (!haySenal()) { setError(SIN_SENAL); return; }
    setBusy(true);
    setError('');
    const { data, error: e } = await sb.rpc('ligar_reporte_biobox_app', { p_report_id: r.report_id, p_record_id: elegida });
    setBusy(false);
    if (e) { setError(leerErrorBandeja(e.message).texto); return; }
    alert(`Listo: el reporte quedó ligado a ${data}.`);
    onListo();
  };

  return (
    <Modal titulo="Ligar a una incidencia abierta" onCerrar={onCerrar} ocupado={busy}>
      <Encabezado r={r} />
      <div className="field">
        <label>Folio (opcional)</label>
        <input value={folio} onChange={(e) => { setFolio(e.target.value); setElegida(''); }}
          placeholder={r.clave_inventario ? 'Vacío: las abiertas de esta máquina' : 'Escribe el folio, p. ej. BBMM00031'} />
      </div>
      {candidatas === null ? <div className="loading">Buscando…</div>
        : !candidatas.length ? <div className="banner">No hay incidencias abiertas {folio.trim() ? 'con ese folio' : 'de esta máquina'} en {r.unidad_negocio}.</div>
        : (
          <div role="radiogroup" aria-label="Incidencia" style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
            {candidatas.map((c) => (
              <label key={c.record_id} className="card"
                style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', textAlign: 'left',
                  borderColor: elegida === c.record_id ? 'var(--accent)' : undefined }}>
                {/* width:auto — la regla general `input{width:100%}` estiraba el
                    círculo y dejaba el texto en un pedazo de la fila. */}
                <input type="radio" name="ligar" checked={elegida === c.record_id} onChange={() => setElegida(c.record_id)}
                  style={{ width: 'auto', flex: 'none', margin: '3px 0 0', accentColor: 'var(--accent)' }} />
                <span style={{ fontSize: 14, minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
                  <b>{c.folio}</b> · {c.nombre_incidencia} · {ESTATUS_INC[c.estatus] || c.estatus}
                  <br /><span style={{ fontSize: 12, color: 'var(--muted)' }}>{c.clave_medio || 'Sin máquina'} · {fechaHoraCdmx(c.creado_en)}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      {error && <div className="err" role="alert">{error}</div>}
      <div className="modal-actions pie-fijo">
        <button className="btn ghost" onClick={onCerrar} disabled={busy}>Cancelar</button>
        <button className="btn" onClick={() => void guardar()} disabled={busy || !elegida}>{busy ? 'Guardando…' : 'Ligar'}</button>
      </div>
    </Modal>
  );
}

function DescartarModal({ r, onCerrar, onListo }: { r: ReporteAppBiobox; onCerrar: () => void; onListo: () => void }) {
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const guardar = async () => {
    if (!haySenal()) { setError(SIN_SENAL); return; }
    setBusy(true);
    setError('');
    const { error: e } = await sb.rpc('descartar_reporte_biobox_app', { p_report_id: r.report_id, p_motivo: motivo });
    setBusy(false);
    if (e) { setError(leerErrorBandeja(e.message).texto); return; }
    onListo();
  };
  return (
    <Modal titulo="Descartar reporte" onCerrar={onCerrar} ocupado={busy}>
      <Encabezado r={r} />
      <div className="field">
        <label>Motivo (obligatorio)</label>
        <textarea rows={3} maxLength={500} value={motivo} onChange={(e) => setMotivo(e.target.value)}
          placeholder="Prueba, repetido, no es una falla…" />
      </div>
      <div className="phint" style={{ margin: '0 0 8px' }}>No crea incidencia. En la app Biobox el reporte sigue igual: atiéndelo en el Webadmin si hace falta.</div>
      {error && <div className="err" role="alert">{error}</div>}
      <div className="modal-actions pie-fijo">
        <button className="btn ghost" onClick={onCerrar} disabled={busy}>Cancelar</button>
        <button className="btn" onClick={() => void guardar()} disabled={busy || motivo.trim().length < 3}>{busy ? 'Guardando…' : 'Descartar'}</button>
      </div>
    </Modal>
  );
}
