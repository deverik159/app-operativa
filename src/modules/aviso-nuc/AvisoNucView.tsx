// ============================================================
// src/modules/aviso-nuc/AvisoNucView.tsx
// Aviso NUC (Erik, 29-oct-2026): tablero de las máquinas Biobox con el
// estado de su NUC, para que el técnico de Op. Bio Box sepa de un vistazo
// cuáles están fuera de línea.
//
//   Digital  → lo repara a distancia: «Marcar fuera de línea» (nota opcional
//              y foto obligatoria, Erik, 4-nov-2026) y «Ya está en línea»,
//              con una de tres respuestas y una foto obligatoria (Erik,
//              30-oct-2026: sin «Estoy revisándolo» ni nota libre).
//   Técnico  → solo ve el estado y el historial; le llegan los avisos de
//              fuera de línea y de en línea.
//
// Las fotos no se pintan en la tarjeta, para no ensuciar el tablero: solo un
// botón «Ver imagen» (la de fuera de línea mientras sigue abierto; si no, la
// del último cierre).
//
// Todo cambio va por las funciones nuc_aviso_* de la base, que vuelven a
// revisar quién llama y en qué estado está el aviso; aquí solo se ofrece lo
// que la base va a aceptar. La lista se refresca sola cada minuto.
// ============================================================
import { Camera, Check, History, Image as IconoImagen, PowerOff, RefreshCw, Router, TriangleAlert, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sb } from '../../lib/supabase';
import { cargarNombres, nombreDe, type MapaNombres } from '../../lib/nombres';
import { colorTono, fondoTono, bordeTono } from '../../lib/tonos';
import { fechaHoraCdmx } from '../../lib/fechasCdmx';
import { comprimirImagen } from '../../lib/comprimirImagen';
import { idCorto } from '../../lib/helpers';
import { BUCKET_EVIDENCIAS, CACHE_INMUTABLE } from '../../lib/storage';
import {
  ESTADOS_NUC,
  ETIQUETA_NUC,
  TONO_NUC,
  respuestasPara,
  MUEBLES_VV_NUC,
  coincideMaquina,
  contarEstados,
  contarPorUnidad,
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
import { sinAcentos } from '../../lib/helpers';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';
import GraficoNuc from './GraficoNuc';
import DestinatariosNuc from './DestinatariosNuc';

/** Valor del selector para ver todas las unidades juntas. */
const TODAS = 'Todas';

/** Lo que dice la tarjeta de cada unidad. */
const NOMBRE_UNIDAD: Record<string, string> = { 'Vía Verde': 'Vía Verde', Ecovallas: 'Ecovallas Digital' };

type Rol = { rol: string; unidad_negocio: string | null; departamento: string | null };

/** Qué ventana está abierta y sobre qué máquina. */
type Accion =
  | { tipo: 'abrir'; m: MaquinaNuc }
  | { tipo: 'apagado'; m: MaquinaNuc; a: AvisoNuc }
  | { tipo: 'en_linea'; m: MaquinaNuc; a: AvisoNuc };

/** Filtro de la lista: los avisos abiertos, un estado o todas. */
type Filtro = 'abiertos' | EstadoNuc | 'todas';

/** El último cierre con foto de una máquina. */
type Cierre = Pick<AvisoNuc, 'id' | 'site_id' | 'foto_cierre' | 'nota_cierre' | 'cerrado_por' | 'cerrado_en'>;

/** Un aviso del historial, con sus fotos. */
type AvisoHistorial = Cierre & Pick<AvisoNuc, 'foto_abierto' | 'nota_digital' | 'abierto_por' | 'abierto_en'
  | 'foto_apagado' | 'nota_apagado' | 'apagado_por' | 'apagado_en'>;

/** Lo que enseña «Ver imagen»: la foto, qué se dijo, quién y cuándo. */
type FotoVista = { path: string; titulo: string; detalle: string; por: string | null; en: string | null };

const fotoCierre = (c: Cierre | undefined): FotoVista | null =>
  c?.foto_cierre
    ? { path: c.foto_cierre, titulo: 'Foto del NUC en línea', detalle: c.nota_cierre || 'En línea', por: c.cerrado_por, en: c.cerrado_en }
    : null;

const fotoFuera = (a: Pick<AvisoNuc, 'foto_abierto' | 'nota_digital' | 'abierto_por' | 'abierto_en'> | undefined): FotoVista | null =>
  a?.foto_abierto
    ? { path: a.foto_abierto, titulo: 'Foto del NUC fuera de línea', detalle: a.nota_digital || 'Fuera de línea', por: a.abierto_por, en: a.abierto_en }
    : null;

const fotoApagado = (a: Pick<AvisoNuc, 'foto_apagado' | 'nota_apagado' | 'apagado_por' | 'apagado_en'> | undefined): FotoVista | null =>
  a?.foto_apagado
    ? { path: a.foto_apagado, titulo: 'Foto del sitio apagado', detalle: a.nota_apagado || 'Sitio apagado', por: a.apagado_por, en: a.apagado_en }
    : null;

const REFRESCO_MS = 60 * 1000;

const COLUMNAS_INV =
  'site_id,site_legacy_id,vendor_face_id,unidad_negocio,tipo_medio,tipo_mueble,direccion,municipio';

const ACCION_TXT: Record<EventoNuc['accion'], string> = {
  abierto: 'Lo marcó fuera de línea',
  tomado: 'Empezó a revisarlo',
  apagado: 'Marcó el sitio apagado',
  en_linea: 'Lo puso en línea',
};

function pastilla(estado: EstadoNuc) {
  const t = TONO_NUC[estado];
  return { color: colorTono(t), background: fondoTono(t), borderColor: bordeTono(t) };
}

const urlFoto = (path: string) => sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path).data.publicUrl;

function AvisoNucView({ roles, unidades, recargarSignal = 0 }: {
  roles: Rol[];
  /** Unidades que puede ver (unidadesAvisoNuc). */
  unidades: string[];
  recargarSignal?: number;
}) {
  // Con más de una unidad abre con todas juntas (Erik, 4-nov-2026): cada
  // tarjeta dice de qué unidad es.
  const [unidad, setUnidad] = useState(unidades.length > 1 ? TODAS : unidades[0] || 'Biobox');
  const lista = useMemo(() => (unidad === TODAS ? unidades : [unidad]), [unidad, unidades]);
  const [destinatarios, setDestinatarios] = useState(false);
  const [maquinas, setMaquinas] = useState<MaquinaNuc[]>([]);
  const [avisos, setAvisos] = useState<Map<string, AvisoNuc>>(new Map());
  /** El último cierre con foto de cada máquina, para «Ver imagen». */
  const [cierres, setCierres] = useState<Map<string, Cierre>>(new Map());
  const [nombres, setNombres] = useState<MapaNombres>({});
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState('');
  const [actualizado, setActualizado] = useState<Date | null>(null);
  const [filtro, setFiltro] = useState<Filtro>('abiertos');
  const [busca, setBusca] = useState('');
  const [accion, setAccion] = useState<Accion | null>(null);
  const [nota, setNota] = useState('');
  const [respuesta, setRespuesta] = useState('');
  const [foto, setFoto] = useState<{ file: File; preview: string } | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [errAccion, setErrAccion] = useState('');
  const [historial, setHistorial] = useState<{ m: MaquinaNuc; eventos: EventoNuc[] | null; avisos: Map<number, AvisoHistorial>; err: string } | null>(null);
  const [viendo, setViendo] = useState<{ f: FotoVista; m: MaquinaNuc } | null>(null);
  const [ahora, setAhora] = useState(Date.now());
  const turno = useRef(0);

  const digital = esDigitalNuc(roles);
  const manager = roles.some((r) => r.rol === 'manager');

  const cargar = useCallback(async (silencioso = false) => {
    const t = ++turno.current;
    if (!silencioso) setCargando(true);
    try {
      const filas: FilaInventarioNuc[] = [];
      for (const u of lista) {
        for (let inicio = 0; ; inicio += 1000) {
          let q = sb.from('inventario').select(COLUMNAS_INV).eq('unidad_negocio', u);
          // Ecovallas: solo pantallas; Vía Verde: columnas y pórticos (los
          // impresos de Ecovallas son miles y no tienen NUC).
          if (sinAcentos(u) === 'ecovallas') q = q.eq('tipo_medio', 'Digital');
          else if (sinAcentos(u) === 'via verde') q = q.in('tipo_mueble', [...MUEBLES_VV_NUC]);
          const { data, error } = await q.order('vendor_face_id').range(inicio, inicio + 999);
          if (error) throw new Error('No se pudieron cargar las máquinas: ' + error.message);
          filas.push(...((data || []) as FilaInventarioNuc[]));
          if (!data || data.length < 1000) break;
        }
      }
      const { data: abiertos, error: e2 } = await sb.from('nuc_avisos').select('*')
        .in('unidad_negocio', lista).neq('estado', 'en_linea');
      if (e2) throw new Error('No se pudieron cargar los avisos: ' + e2.message);
      // Último cierre con foto por máquina. Si falla, solo falta «Ver imagen».
      const { data: cerrados } = await sb.from('nuc_avisos')
        .select('id,site_id,foto_cierre,nota_cierre,cerrado_por,cerrado_en')
        .in('unidad_negocio', lista).eq('estado', 'en_linea').not('foto_cierre', 'is', null)
        .order('cerrado_en', { ascending: false }).limit(1000);
      if (t !== turno.current) return;
      const ultimos = new Map<string, Cierre>();
      for (const c of (cerrados || []) as Cierre[]) if (!ultimos.has(c.site_id)) ultimos.set(c.site_id, c);
      setMaquinas(maquinasDeInventario(filas));
      setAvisos(new Map(((abiertos || []) as AvisoNuc[]).map((a) => [a.site_id, a])));
      setCierres(ultimos);
      setActualizado(new Date());
      setAhora(Date.now());
      setErr('');
    } catch (e) {
      if (t === turno.current) setErr(e instanceof Error ? e.message : 'No se pudo actualizar el tablero.');
    } finally {
      if (t === turno.current) setCargando(false);
    }
  }, [lista]);

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

  // La vista previa de la foto se libera al cambiarla o al cerrar.
  useEffect(() => () => { if (foto) URL.revokeObjectURL(foto.preview); }, [foto]);

  const conteo = useMemo(() => contarEstados(maquinas, avisos), [maquinas, avisos]);
  const porUnidad = useMemo(() => contarPorUnidad(maquinas, avisos), [maquinas, avisos]);

  /** «2 Vía Verde · 1 Ecovallas · 1 Biobox», de mayor a menor. */
  const desglose = (e: EstadoNuc): string =>
    Object.entries(porUnidad[e]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([u, k]) => `${k} ${u}`).join(' · ');

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

  const abrirAccion = (a: Accion) => {
    setAccion(a); setNota(''); setRespuesta(''); setFoto(null); setErrAccion('');
  };

  const elegirFoto = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    if (!f.type.startsWith('image/')) { setErrAccion('Tiene que ser una foto.'); return; }
    setFoto({ file: f, preview: URL.createObjectURL(f) });
    setErrAccion('');
  };

  /**
   * Sube la foto y regresa su ruta: nuc/<aviso>/… al ponerlo en línea, o
   * nuc/fuera/… al marcarlo fuera de línea (el aviso aún no existe).
   */
  const subirFoto = async (carpeta: string, file: File): Promise<string> => {
    let archivo = file;
    try {
      archivo = await comprimirImagen(file);
    } catch {
      /* sube la original */
    }
    // Nombre no adivinable: con upsert apagado, nadie puede ocuparlo antes.
    const path = `nuc/${carpeta}/${Date.now()}_${idCorto()}.jpg`;
    const { error } = await sb.storage.from(BUCKET_EVIDENCIAS).upload(path, archivo, {
      upsert: false,
      contentType: archivo.type || 'image/jpeg',
      cacheControl: CACHE_INMUTABLE,
    });
    if (error) throw new Error('No se pudo subir la foto: ' + error.message);
    return path;
  };

  const guardarAccion = async () => {
    if (!accion) return;
    setErrAccion('');
    if (accion.tipo === 'en_linea' && !respuesta) { setErrAccion('Elige qué se hizo.'); return; }
    if (!foto) { setErrAccion('Agrega la foto.'); return; }
    setGuardando(true);
    let path = '';
    try {
      path = await subirFoto(accion.tipo === 'abrir' ? 'fuera' : String(accion.a.id), foto.file);
    } catch (e) {
      setGuardando(false);
      setErrAccion(e instanceof Error ? e.message : 'No se pudo subir la foto.');
      return;
    }
    const { error } = accion.tipo === 'abrir'
      ? await sb.rpc('nuc_aviso_abrir', { p_site_id: accion.m.site_id, p_nota: nota.trim() || null, p_foto: path })
      : accion.tipo === 'apagado'
        ? await sb.rpc('nuc_aviso_apagado', { p_id: accion.a.id, p_nota: nota.trim() || null, p_foto: path })
        : await sb.rpc('nuc_aviso_en_linea', { p_id: accion.a.id, p_respuesta: respuesta, p_foto: path });
    setGuardando(false);
    if (error) {
      // La foto quedó suelta: se borra (es de quien la subió).
      void sb.storage.from(BUCKET_EVIDENCIAS).remove([path]);
      setErrAccion(error.message);
      return;
    }
    setAccion(null);
    setFoto(null);
    await cargar(true);
  };

  const verHistorial = async (m: MaquinaNuc) => {
    setHistorial({ m, eventos: null, avisos: new Map(), err: '' });
    const { data: avs, error } = await sb.from('nuc_avisos')
      .select('id,site_id,foto_cierre,nota_cierre,cerrado_por,cerrado_en,foto_abierto,nota_digital,abierto_por,abierto_en,foto_apagado,nota_apagado,apagado_por,apagado_en')
      .eq('site_id', m.site_id).order('abierto_en', { ascending: false }).limit(10);
    if (error) { setHistorial({ m, eventos: [], avisos: new Map(), err: error.message }); return; }
    const lista = (avs || []) as AvisoHistorial[];
    const avisosH = new Map(lista.map((c) => [c.id, c]));
    const ids = lista.map((x) => x.id);
    if (!ids.length) { setHistorial({ m, eventos: [], avisos: avisosH, err: '' }); return; }
    const { data: evs, error: e2 } = await sb.from('nuc_avisos_eventos').select('*')
      .in('aviso_id', ids).order('en', { ascending: false });
    setHistorial({ m, eventos: (evs || []) as EventoNuc[], avisos: avisosH, err: e2 ? e2.message : '' });
  };

  const persona = (correo: string | null) => nombreDe(nombres, correo);

  /** Qué dice la pastilla de estado: el estado y desde cuándo. */
  const detalleEstado = (a: AvisoNuc | undefined): string => {
    const e = estadoNuc(a);
    if (!a || e === 'en_linea') return ETIQUETA_NUC.en_linea;
    if (e === 'apagado') return `Sitio apagado ${haceCuanto(a.apagado_en || a.actualizado_en, ahora)}`;
    return `Fuera de línea ${haceCuanto(a.abierto_en, ahora)}`;
  };

  const tarjeta = (m: MaquinaNuc) => {
    const a = avisos.get(m.site_id);
    const e = estadoNuc(a);
    const p = pastilla(e);
    // Con el sitio apagado, la foto del apagado; mientras está fuera de línea,
    // la suya; si no la tiene (avisos de antes del 4-nov) o ya está en línea,
    // la del último cierre.
    const f = (e === 'apagado' ? fotoApagado(a) : null)
      || (e !== 'en_linea' ? fotoFuera(a) : null)
      || fotoCierre(cierres.get(m.site_id));
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
              {/* De qué unidad es (Erik, 4-nov-2026): el tablero mezcla Biobox,
                  Ecovallas y Vía Verde. */}
              <span className="tag">{NOMBRE_UNIDAD[m.unidad_negocio] || m.unidad_negocio}</span>
            </div>
            {a && e !== 'en_linea' && a.nota_digital && <div style={{ fontSize: 12, marginTop: 6 }}>
              <span style={{ color: 'var(--muted)' }}>Digital:</span> {a.nota_digital}
            </div>}
            {a && e === 'apagado' && a.nota_apagado && <div style={{ fontSize: 12, marginTop: 4 }}>
              <span style={{ color: 'var(--muted)' }}>Sitio apagado:</span> {a.nota_apagado}
            </div>}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn ghost sm" onClick={() => void verHistorial(m)}><Ic i={History} />Historial</button>
            {f && <button className="btn ghost sm" onClick={() => setViendo({ f, m })}><Ic i={IconoImagen} />Ver imagen</button>}
            {digital && e === 'en_linea' && <button className="btn ghost sm" onClick={() => abrirAccion({ tipo: 'abrir', m })}>
              <Ic i={TriangleAlert} />Marcar fuera de línea
            </button>}
            {/* Tercer botón (Erik, 4-nov-2026): el NUC ya se diagnosticó y no
                regresa porque el sitio está apagado completo. */}
            {digital && a && e === 'fuera_linea' && <button className="btn ghost sm" onClick={() => abrirAccion({ tipo: 'apagado', m, a })}>
              <Ic i={PowerOff} />Sitio apagado
            </button>}
            {digital && a && e !== 'en_linea' && <button className="btn sm" onClick={() => abrirAccion({ tipo: 'en_linea', m, a })}>
              <Ic i={Check} />Ya está en línea
            </button>}
          </div>
        </div>
      </div>
    );
  };

  const enLinea = accion?.tipo === 'en_linea';
  const listo = !!foto && (accion?.tipo !== 'en_linea' || !!respuesta);
  const TITULO_ACCION = { abrir: 'Marcar NUC fuera de línea', apagado: 'Marcar sitio apagado', en_linea: 'Poner el NUC en línea' };

  // La foto es obligatoria en las tres ventanas.
  const bloqueFoto = (
    <>
      <div style={{ fontSize: 13, marginBottom: 6 }}>Foto (obligatoria)</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {foto && <img src={foto.preview} alt="Foto del NUC" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />}
        <label className="btn ghost sm" style={{ cursor: guardando ? 'default' : 'pointer' }}>
          <Ic i={Camera} />{foto ? 'Cambiar foto' : 'Agregar foto'}
          <input type="file" accept="image/*" hidden disabled={guardando} onChange={(e) => { elegirFoto(e.target.files); e.target.value = ''; }} />
        </label>
      </div>
    </>
  );

  return (
    <div>
      <h2 className="page"><Ic i={Router} />Aviso NUC</h2>
      <p className="phint">
        {digital
          ? 'Marca las máquinas Biobox y las pantallas de Ecovallas y Vía Verde con el NUC fuera de línea y ponlas en línea, en los dos casos con foto; la gente de cada unidad recibe el aviso.'
          : 'Máquinas y pantallas con el NUC fuera de línea. Te llega un aviso cuando una se cae y cuando vuelve a estar en línea.'}
      </p>
      <div className="toolbar filtros-pildora">
        {unidades.length > 1 && <select aria-label="Unidad" value={unidad} onChange={(e) => {
          setUnidad(e.target.value); setMaquinas([]); setAvisos(new Map()); setCierres(new Map()); setActualizado(null);
        }}>
          <option value={TODAS}>Unidad: todas</option>
          {unidades.map((u) => <option key={u} value={u}>Unidad: {NOMBRE_UNIDAD[u] || u}</option>)}
        </select>}
        <button className="btn sm ghost" onClick={() => void cargar()} disabled={cargando}>
          <Ic i={RefreshCw} />{cargando ? 'Actualizando…' : 'Actualizar'}
        </button>
        {manager && <button className="btn sm ghost" onClick={() => setDestinatarios(true)}>
          <Ic i={Users} />Quién más recibe
        </button>}
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
            {/* Con varias unidades, de cuál es cada una (Erik, 4-nov-2026). */}
            {lista.length > 1 && conteo[e] > 0 && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{desglose(e)}</div>}
          </button>;
        })}
      </div>

      <div className="toolbar">
        <input className="search" aria-label="Buscar máquina" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por número, clave o dirección" />
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
        {busca.trim() ? `Buscando en las ${maquinas.length} máquinas ${unidad === TODAS ? 'de todas las unidades' : 'de ' + unidad}`
          : filtro === 'abiertos' ? 'Máquinas con aviso abierto'
          : filtro === 'todas' ? 'Todas las máquinas'
          : ETIQUETA_NUC[filtro as EstadoNuc]}
        {' · '}
        <button type="button" className="btn ghost sm" style={{ padding: '2px 8px' }} onClick={() => { setFiltro(filtro === 'todas' ? 'abiertos' : 'todas'); setBusca(''); }}>
          {filtro === 'todas' ? 'Ver solo con aviso' : 'Ver todas'}
        </button>
      </div>

      {!cargando && !err && !maquinas.length && <div className="banner">No hay máquinas {unidad === TODAS ? '' : 'de ' + unidad + ' '}en el inventario.</div>}
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
            <h2 id="nuc-accion-titulo">{TITULO_ACCION[accion.tipo]}</h2>
            <p className="phint">{accion.m.site_id} · {accion.m.nombre !== accion.m.site_id ? accion.m.nombre : accion.m.direccion}</p>
            {accion.tipo === 'apagado' && <p style={{ fontSize: 13, marginTop: 0 }}>
              El NUC ya se revisó y no regresa porque el sitio está apagado completo. Se le avisa a la gente de la unidad.
            </p>}
            {accion.tipo === 'en_linea' ? <>
              <div style={{ fontSize: 13, marginBottom: 6 }}>¿Qué se hizo? (obligatorio)</div>
              <div role="group" aria-label="Qué se hizo" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {respuestasPara(estadoNuc(accion.a)).map((r) => <button key={r} type="button" className={'btn sm' + (respuesta === r ? '' : ' ghost')} aria-pressed={respuesta === r} onClick={() => { setRespuesta(r); setErrAccion(''); }}>{r}</button>)}
              </div>
              {bloqueFoto}
            </> : <>
              <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }} htmlFor="nuc-nota">Nota para el técnico (opcional)</label>
              <textarea id="nuc-nota" rows={3} maxLength={500} value={nota} onChange={(e) => { setNota(e.target.value); setErrAccion(''); }} style={{ width: '100%', fontSize: 16, marginBottom: 12 }} />
              {bloqueFoto}
            </>}
            {errAccion && <div className="err" role="alert" style={{ marginTop: 8 }}>{errAccion}</div>}
            <div className="modal-actions pie-fijo" style={{ marginTop: 12 }}>
              <button className="btn ghost" onClick={() => setAccion(null)} disabled={guardando}>Cancelar</button>
              <button className="btn" onClick={() => void guardarAccion()} disabled={guardando || !listo}>
                {guardando ? 'Guardando…' : enLinea ? 'Poner en línea y avisar' : 'Avisar al técnico'}
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
            <p className="phint">{historial.m.site_id} · {NOMBRE_UNIDAD[historial.m.unidad_negocio] || historial.m.unidad_negocio}</p>
            {/* Días fuera de línea en el rango que se elija (Erik, 4-nov-2026). */}
            <GraficoNuc siteId={historial.m.site_id} />
            <div style={{ fontSize: 13, fontWeight: 600, margin: '4px 0 6px' }}>Últimos 10 avisos</div>
            {historial.err && <div className="err" role="alert">{historial.err}</div>}
            {!historial.eventos && <p>Cargando…</p>}
            {historial.eventos && !historial.eventos.length && !historial.err && <p>Esta máquina no ha tenido avisos de NUC.</p>}
            <div style={{ display: 'grid', gap: 8 }}>
              {historial.eventos?.map((ev) => {
                const av = historial.avisos.get(ev.aviso_id);
                const f = ev.accion === 'en_linea' ? fotoCierre(av)
                  : ev.accion === 'abierto' ? fotoFuera(av)
                  : ev.accion === 'apagado' ? fotoApagado(av) : null;
                return <div key={ev.id} style={{ borderLeft: '3px solid ' + colorTono(TONO_NUC[ev.estado]), paddingLeft: 10 }}>
                  <div style={{ fontSize: 13 }}><b>{ACCION_TXT[ev.accion]}</b> · {persona(ev.por)}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{fechaHoraCdmx(ev.en)}</div>
                  {ev.nota && <div style={{ fontSize: 13 }}>{ev.nota}</div>}
                  {f && <button className="btn ghost sm" style={{ marginTop: 4 }} onClick={() => setViendo({ f, m: historial.m })}>
                    <Ic i={IconoImagen} />Ver imagen
                  </button>}
                </div>;
              })}
            </div>
            <div className="modal-actions pie-fijo" style={{ marginTop: 12 }}><button autoFocus className="btn ghost" onClick={() => setHistorial(null)}>Cerrar</button></div>
          </section>
        </div>, document.body
      )}
      {destinatarios && <DestinatariosNuc nombres={nombres} onCerrar={() => setDestinatarios(false)} />}
      {/* Después del historial: se abre encima de él. */}
      {viendo && createPortal(
        <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) setViendo(null); }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="nuc-imagen-titulo" style={{ maxWidth: 640 }}>
            <CerrarModal onClick={() => setViendo(null)} />
            <h2 id="nuc-imagen-titulo">{viendo.f.titulo}</h2>
            <p className="phint">
              {viendo.m.site_id} · {viendo.f.detalle} · {persona(viendo.f.por)}
              {viendo.f.en ? ' · ' + fechaHoraCdmx(viendo.f.en) : ''}
            </p>
            <a href={urlFoto(viendo.f.path)} target="_blank" rel="noopener noreferrer">
              <img src={urlFoto(viendo.f.path)} alt={'Foto del NUC de ' + viendo.m.site_id} style={{ width: '100%', maxHeight: '65dvh', objectFit: 'contain', borderRadius: 8, background: 'var(--panel2)' }} />
            </a>
            <div className="modal-actions pie-fijo" style={{ marginTop: 12 }}><button autoFocus className="btn ghost" onClick={() => setViendo(null)}>Cerrar</button></div>
          </section>
        </div>, document.body
      )}

    </div>
  );
}

export default AvisoNucView;
