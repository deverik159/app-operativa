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
import { Ban, ClipboardPaste, ExternalLink, Image as IconoImagen, Link2, RefreshCw, Repeat, Smartphone, Tags, Trash, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sb } from '../../lib/supabase';
import { haySenal } from '../../lib/datosLocales';
import { codigoCara } from '../../lib/helpers';
import { comprimirImagen } from '../../lib/comprimirImagen';
import { BUCKET_EVIDENCIAS, CACHE_INMUTABLE, subirMiniatura } from '../../lib/storage';
import { reportarError } from '../../lib/reportarError';
import { fechaHoraCdmx } from '../../lib/fechasCdmx';
import { cargarNombres, nombreDe, type MapaNombres } from '../../lib/nombres';
import {
  ETIQUETA_ESTADO,
  MINUTOS_SYNC_ATRASADO,
  atiendeUnidad,
  coincideBusqueda,
  desfase,
  enlaceWebadmin,
  equivalenciaDe,
  estadoBandeja,
  fechaCoreAIso,
  filtrarMaquinas,
  leerErrorBandeja,
  llaveReincidencia,
  minutosDesde,
  reincidencias,
  textoEstatusCore,
  unidadesBandeja,
  VENTANAS_REINCIDENCIA,
  type Equivalencia,
  type EstadoBandeja,
  type IncLigada,
  type Reincidencia,
  type ReporteAppBiobox,
} from '../../lib/reportesAppBiobox';
import type { CatalogoIncidencia } from '../../types/db';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';
import SelectorFalla, { Derivado } from '../incidencias/SelectorFalla';

type FilaRol = { rol: string; unidad_negocio: string | null };
type Props = { roles: readonly FilaRol[]; recargarSignal?: number };

type Maquina = {
  vendor_face_id: string; tipo_mueble: string | null; site_legacy_id: string | null; direccion: string | null;
  municipio?: string | null;
};
type SyncEstado = { ultima_carga: string | null; ultimo_resultado: Record<string, unknown> | null };

const TODAS = 'Todas';
const ESTADOS: EstadoBandeja[] = ['por_clasificar', 'en_proceso', 'marcar_atendido', 'terminado', 'descartado', 'atendido_app'];
const TONO: Record<EstadoBandeja, string> = {
  por_clasificar: 'var(--st-ambar)',
  en_proceso: 'var(--accent)',
  marcar_atendido: 'var(--warn)',
  terminado: 'var(--ok)',
  descartado: 'var(--muted)',
  atendido_app: 'var(--muted)',
};
/** PostgREST entrega como máximo 1000 filas por consulta: se pide por páginas. */
const PAGINA = 1000;
const TOPE_REPORTES = 10000;
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
      // Todos los reportes (con los Atendidos viejos ya pasan de 1000), por
      // páginas: las reincidencias de 90 días necesitan el historial completo.
      const leerReportes = async (): Promise<ReporteAppBiobox[]> => {
        const todas: ReporteAppBiobox[] = [];
        for (let desde = 0; desde < TOPE_REPORTES; desde += PAGINA) {
          const { data, error } = await sb.from('biobox_app_reportes').select('*').in('unidad_negocio', lista)
            .order('report_id', { ascending: false }).range(desde, desde + PAGINA - 1);
          if (error) throw error;
          todas.push(...((data || []) as ReporteAppBiobox[]));
          if (!data || data.length < PAGINA) break;
        }
        return todas;
      };
      const [filas, re, rs] = await Promise.all([
        leerReportes(),
        sb.from('biobox_app_equivalencias').select('unidad_negocio,caso_id,catalogo_detalle,etiqueta,directo_al_area,marca_atendido,activo'),
        sb.from('biobox_app_sync_estado').select('ultima_carga,ultimo_resultado').eq('id', 1).maybeSingle(),
      ]);
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

  const reinc = useMemo(() => reincidencias(reportes), [reportes]);
  const reincDe = (r: ReporteAppBiobox) => {
    const llave = llaveReincidencia(r);
    return llave ? reinc.get(llave) : undefined;
  };

  const minSync = minutosDesde(sync?.ultima_carga);
  const persona = (correo: string | null) => nombreDe(nombres, correo);

  const tarjeta = ({ r, inc, estado }: (typeof conEstado)[number]) => {
    const m = r.clave_inventario ? maquinas.get(r.clave_inventario) : undefined;
    const puede = atiendeUnidad(roles, r.unidad_negocio);
    const aviso = desfase(r, inc);
    const webadmin = enlaceWebadmin(r.report_id);
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
        <AvisoReincidencia x={reincDe(r)} propio={r.report_id} />
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
          {webadmin && (
            <a className="btn ghost sm" href={webadmin} target="_blank" rel="noopener noreferrer nofollow" style={{ textDecoration: 'none' }}>
              <Ic i={r.evidencia_url ? IconoImagen : ExternalLink} />{r.evidencia_url ? 'Ver foto en Webadmin' : 'Ver en Webadmin'}
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
          maquinaReporte={(accion.r.clave_inventario && maquinas.get(accion.r.clave_inventario)) || null}
          // La que dejó la regla automática (también en «Otro»); si no, la equivalencia.
          sugerida={accion.r.sugerencia_detalle || equivalenciaDe(accion.r, equivalencias)?.catalogo_detalle || null}
          reinc={reincDe(accion.r)}
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

/** Tope de la foto pegada (una captura de pantalla pesa mucho menos). */
const FOTO_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Sube la foto que la validadora pegó como evidencia de REPORTE de la
 * incidencia recién creada (10-nov-2026, Erik). La foto del usuario vive en
 * un bucket privado de Biobox: Dulce la recorta del Webadmin con Recortes de
 * Windows y la pega aquí. Mismo bucket, ruta y tabla que 📎 Evidencia.
 * Devuelve null si quedó, o el texto del problema.
 */
async function subirFotoPegada(foto: File, reportId: number, folio: string, clave: string): Promise<string | null> {
  const { data: rep, error: eRep } = await sb.from('biobox_app_reportes').select('record_id').eq('report_id', reportId).maybeSingle();
  const recordId = (rep as { record_id: string | null } | null)?.record_id;
  if (eRep || !recordId) return 'no se encontró la incidencia recién creada';
  const { data: ses } = await sb.auth.getSession();
  const email = ses.session?.user?.email || null;

  const f = await comprimirImagen(foto);
  const ext = f.type === 'image/jpeg' ? 'jpg' : (f.type.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '') || 'png';
  const cara = clave === 'SIN-MAQUINA' ? 'sin_maquina' : (codigoCara(clave) || 'maquina');
  const fecha = new Date().toISOString().slice(0, 10);
  const path = `${recordId}/${`${folio}_${cara}_${fecha}_reporte_webadmin_${Date.now()}.${ext}`.replace(/[^\w.\-]/g, '_')}`;

  const { error: upErr } = await sb.storage.from(BUCKET_EVIDENCIAS)
    .upload(path, f, { upsert: false, cacheControl: CACHE_INMUTABLE, contentType: f.type || 'image/png' });
  if (upErr) {
    reportarError('ReportesAppBiobox.foto', upErr, { path, bytes: f.size }, path);
    return upErr.message;
  }
  await subirMiniatura(path, f);
  const url = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path).data.publicUrl;
  const { error: insErr } = await sb.from('evidencias').insert({
    record_id: recordId, etapa: 'reporte', tipo: 'foto', url, path,
    subido_por: email, referencia: 'Foto del usuario (Webadmin)',
  });
  if (insErr) {
    reportarError('ReportesAppBiobox.fotoFila', insErr, { path }, path);
    return 'se subió pero no se pudo registrar: ' + insErr.message;
  }
  return null;
}

/**
 * Reincidencia: la misma máquina reportada por el mismo motivo en 30, 60 y 90
 * días, con todos los estatus (Erik, 10-nov-2026). Solo aparece si hay al
 * menos otro reporte además del propio. La lista dice fecha y estatus.
 */
function AvisoReincidencia({ x, propio }: { x: Reincidencia | undefined; propio: number }) {
  if (!x || x.porVentana[90] < 2) return null;
  const otros = x.reportes.filter((o) => o.report_id !== propio);
  return (
    <details style={{ fontSize: 13, marginTop: 6 }}>
      <summary style={{ cursor: 'pointer', color: 'var(--warn)' }}>
        <Ic i={Repeat} />Reincide: {VENTANAS_REINCIDENCIA.map((v) => `${x.porVentana[v]} en ${v} días`).join(' · ')}
      </summary>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {otros.map((o) => (
          <li key={o.report_id}>App {o.folio_app || o.report_id} · {fechaHoraCdmx(o.fechaIso)} · {o.estatus}</li>
        ))}
      </ul>
    </details>
  );
}

function ClasificarModal({ r, maquinaReporte, sugerida, reinc, onCerrar, onListo, onLigar }: {
  r: ReporteAppBiobox; maquinaReporte: Maquina | null; sugerida: string | null; reinc: Reincidencia | undefined;
  onCerrar: () => void; onListo: () => void; onLigar: (folio: string) => void;
}) {
  const [sel, setSel] = useState<CatalogoIncidencia | null>(null);
  // La máquina de la incidencia (Erik, 12-nov-2026): la del reporte, otra que
  // elija la validadora (por la foto o el Webadmin) o ninguna (SIN-MAQUINA;
  // el técnico la elige al reparar). La base revisa que sea de la unidad.
  const delReporte: Maquina | null = maquinaReporte
    ?? (r.clave_inventario ? { vendor_face_id: r.clave_inventario, tipo_mueble: null, site_legacy_id: null, direccion: null } : null);
  const [maq, setMaq] = useState<Maquina | null>(delReporte);
  const [maqBusca, setMaqBusca] = useState('');
  const [maqLista, setMaqLista] = useState<Maquina[] | null>(null);
  const [maqError, setMaqError] = useState(false);
  const [obs, setObs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ texto: string; folioDuplicado: string | null } | null>(null);
  const [foto, setFoto] = useState<File | null>(null);
  const [vista, setVista] = useState<string | null>(null);
  const [avisoFoto, setAvisoFoto] = useState('');

  // Las máquinas de la unidad (Biobox ~200), una vez, para buscar aquí mismo.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      const { data, error: e } = await sb.from('inventario')
        .select('vendor_face_id,tipo_mueble,site_legacy_id,direccion,municipio')
        .eq('unidad_negocio', r.unidad_negocio).order('vendor_face_id').limit(2000);
      if (!vivo) return;
      if (e) { setMaqError(true); return; }
      setMaqLista((data || []) as Maquina[]);
    })();
    return () => { vivo = false; };
  }, [r.unidad_negocio]);
  const maqOpciones = useMemo(() => filtrarMaquinas(maqLista || [], maqBusca), [maqLista, maqBusca]);

  // La vista previa se libera al cambiar de foto o al cerrar.
  useEffect(() => {
    if (!foto) { setVista(null); return; }
    const u = URL.createObjectURL(foto);
    setVista(u);
    return () => URL.revokeObjectURL(u);
  }, [foto]);

  const tomarImagen = useCallback((b: Blob) => {
    if (!b.type.startsWith('image/')) { setAvisoFoto('Lo copiado no es una imagen.'); return; }
    if (b.size > FOTO_MAX_BYTES) { setAvisoFoto('La imagen pesa demasiado (más de 15 MB).'); return; }
    const ext = (b.type.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '') || 'png';
    setFoto(new File([b], `webadmin.${ext}`, { type: b.type }));
    setAvisoFoto('');
  }, []);

  // Ctrl+V en cualquier parte del modal: si lo copiado es imagen, se toma
  // como foto; si es texto, el pegado normal sigue (p. ej. en Observaciones).
  useEffect(() => {
    const alPegar = (ev: ClipboardEvent) => {
      if (busy) return;
      const item = Array.from(ev.clipboardData?.items || []).find((i) => i.kind === 'file' && i.type.startsWith('image/'));
      const b = item?.getAsFile();
      if (!b) return;
      ev.preventDefault();
      tomarImagen(b);
    };
    window.addEventListener('paste', alPegar);
    return () => window.removeEventListener('paste', alPegar);
  }, [busy, tomarImagen]);

  // Botón «Pegar foto»: lee el portapapeles. Si el navegador no lo permite
  // (Firefox viejo, permiso negado), Ctrl+V sigue funcionando.
  const pegar = async () => {
    setAvisoFoto('');
    if (!navigator.clipboard?.read) { setAvisoFoto('Este navegador no deja leer el portapapeles con el botón: usa Ctrl+V.'); return; }
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const tipo = it.types.find((t) => t.startsWith('image/'));
        if (tipo) { tomarImagen(await it.getType(tipo)); return; }
      }
      setAvisoFoto('No hay una imagen copiada. Recórtala en el Webadmin con Win + Shift + S y vuelve a pegar.');
    } catch {
      setAvisoFoto('El navegador no dejó leer el portapapeles: usa Ctrl+V.');
    }
  };

  const guardar = async () => {
    if (!sel) return;
    if (!haySenal()) { setError({ texto: SIN_SENAL, folioDuplicado: null }); return; }
    setBusy(true);
    setError(null);
    const clave = maq?.vendor_face_id || 'SIN-MAQUINA';
    const { data, error: e } = await sb.rpc('clasificar_reporte_biobox_app', {
      p_report_id: r.report_id,
      p_falla: { detalle: sel.detalle, area: sel.area, impacto: sel.impacto, origen: sel.origen, tipo: sel.tipo },
      p_clave_medio: clave,
      p_observaciones: obs.trim() || null,
    });
    if (e) { setBusy(false); setError(leerErrorBandeja(e.message)); return; }
    const folio = String(data);
    // La incidencia ya existe: si la foto falla, no se deshace; se dice
    // cómo agregarla después desde 📎 Evidencia.
    const problemaFoto = foto ? await subirFotoPegada(foto, r.report_id, folio, clave) : null;
    setBusy(false);
    alert(
      `Listo: se creó la incidencia ${folio} y se avisó al área ${sel.area}.` +
      (foto && !problemaFoto ? ' La foto quedó como evidencia del reporte.' : '') +
      (problemaFoto ? `\n\nLa foto NO se guardó (${problemaFoto}). Agrégala desde Incidencias → ${folio} → 📎 Evidencia.` : '')
    );
    onListo();
  };

  return (
    <Modal titulo="Clasificar reporte" onCerrar={onCerrar} ocupado={busy}>
      <Encabezado r={r} />
      <div className="field">
        <span className="etiqueta">Máquina</span>
        {maq ? (
          <>
            <div className="banner" style={{ marginBottom: 0, overflowWrap: 'anywhere' }}>
              <b>{maq.vendor_face_id}</b>
              {maq.site_legacy_id ? ` · ${maq.site_legacy_id}` : ''}
              {maq.direccion ? ` · ${maq.direccion}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              <button type="button" className="btn ghost sm" onClick={() => { setMaq(null); setMaqBusca(''); }} disabled={busy}>
                <Ic i={Repeat} />Cambiar o quitar
              </button>
            </div>
            {r.clave_inventario && maq.vendor_face_id !== r.clave_inventario && (
              <div className="phint" style={{ margin: '6px 0 0' }}>El usuario reportó la {r.clave_inventario}.</div>
            )}
          </>
        ) : (
          <>
            <div className="phint" style={{ margin: '0 0 6px' }}>
              {r.clave_inventario
                ? <>Sin máquina: es de puntos, de la cuenta o de la app. Si sí es de una máquina, búscala.</>
                : <>El usuario no dijo la máquina. Si la sabes (por la foto o el Webadmin), búscala por su clave, nombre o dirección; si no, déjala vacía y el técnico la elige al reparar.</>}
            </div>
            <input
              value={maqBusca}
              onChange={(e) => setMaqBusca(e.target.value)}
              placeholder={maqLista ? 'Escribe para buscar la máquina…' : maqError ? 'No se pudo cargar la lista de máquinas' : 'Cargando máquinas…'}
              disabled={busy || !maqLista}
              aria-label="Buscar máquina"
            />
            {!!maqBusca.trim() && maqLista && maqOpciones.length === 0 && (
              <div className="phint" style={{ margin: '4px 0 0' }}>Sin resultados.</div>
            )}
            {maqOpciones.length > 0 && (
              <div className="lista-scroll" style={{ border: '1px solid var(--line)', borderRadius: 9, marginTop: 4, maxHeight: 220, overflow: 'auto' }}>
                {maqOpciones.map((o) => (
                  <button key={o.vendor_face_id} type="button" className="btn ghost"
                    style={{ display: 'block', width: '100%', textAlign: 'left', borderRadius: 0, border: 'none', overflowWrap: 'anywhere' }}
                    onClick={() => { setMaq(o); setMaqBusca(''); }}>
                    <b>{o.vendor_face_id}</b>
                    {o.site_legacy_id && <span style={{ color: 'var(--muted)' }}> · {o.site_legacy_id}</span>}
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {[o.direccion, o.municipio].filter(Boolean).join(' · ') || 'sin dirección'}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {delReporte && (
              <div style={{ marginTop: 6 }}>
                <button type="button" className="btn ghost sm" onClick={() => setMaq(delReporte)} disabled={busy}>
                  Usar la del reporte ({delReporte.vendor_face_id})
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <div style={{ margin: '-6px 0 10px' }}><AvisoReincidencia x={reinc} propio={r.report_id} /></div>
      {sugerida && <div className="phint" style={{ margin: '0 0 6px' }}>Sugerida automáticamente (por el motivo o por las palabras del usuario): <b>{sugerida}</b></div>}
      <SelectorFalla unidad={r.unidad_negocio} mueble={maq?.tipo_mueble || null} actual={sugerida} onElegir={setSel} />
      <div className="row2">
        <Derivado label="Nivel" valor={(sel?.impacto || '').trim()} />
        <Derivado label="Área responsable" valor={(sel?.area || '').trim()} />
      </div>
      <div className="field">
        <span className="etiqueta">Foto del usuario (opcional)</span>
        <div className="phint" style={{ margin: '0 0 6px' }}>
          Ábrela en el Webadmin, recórtala con <b>Win + Shift + S</b> y pégala aquí (botón o Ctrl+V). Queda como evidencia del reporte.
        </div>
        {vista ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <img src={vista} alt="Foto pegada del Webadmin"
              style={{ maxHeight: 160, maxWidth: '100%', borderRadius: 8, border: '1px solid var(--line)' }} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn ghost sm" onClick={() => void pegar()} disabled={busy}><Ic i={ClipboardPaste} />Pegar otra</button>
              <button type="button" className="btn ghost sm" onClick={() => setFoto(null)} disabled={busy}><Ic i={Trash} />Quitar</button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn ghost sm" onClick={() => void pegar()} disabled={busy}><Ic i={ClipboardPaste} />Pegar foto</button>
            {enlaceWebadmin(r.report_id) && (
              <a className="btn ghost sm" href={enlaceWebadmin(r.report_id)!} target="_blank" rel="noopener noreferrer nofollow" style={{ textDecoration: 'none' }}>
                <Ic i={ExternalLink} />Abrir en Webadmin
              </a>
            )}
          </div>
        )}
        {avisoFoto && <div style={{ fontSize: 13, marginTop: 6, color: 'var(--warn)' }}>{avisoFoto}</div>}
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
