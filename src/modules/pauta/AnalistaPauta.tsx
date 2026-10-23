// ============================================================
// src/modules/pauta/AnalistaPauta.tsx
// Pestaña Analista de Pauta y Monitoreo (Erik, 20 y 22-oct-2026).
//
// Cada toma que registra el monitorista le llega aquí al analista, en
// carpetas campaña → versión de la catorcena elegida. Cada foto se llama
// <vendor_face_id>_<n>. Por foto, el analista:
//   · la marca Correcta, o sube la Editada (la descarga, la edita y la sube);
//   · o la rechaza con motivo (junto con otras de la misma cara): esas dejan
//     de contar y la toma vuelve al monitorista para subir las que faltan.
// También puede regresar toda la toma. Cuando ninguna foto de la toma queda
// sin revisar, la cara queda COMPROBADA sola: la revisión del analista ES la
// comprobación (el coordinador ya no comprueba). Todo lo hace la base con
// revisar_foto_pauta, rechazar_fotos_pauta y rechazar_toma.
//
// Bandejas: Por revisar (tomadas sin comprobar), Comprobadas (se pueden
// rechazar después) y Regresadas (esperan al monitorista, con su motivo).
// Las fotos de una carpeta se leen al abrirla; cada carpeta se baja en ZIP.
// ============================================================
import { Check, ChevronDown, ChevronRight, Download, FolderOpen, Undo2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PautaRuta } from '../../types/db';
import { sb } from '../../lib/supabase';
import { BUCKET_EVIDENCIAS, CACHE_INMUTABLE } from '../../lib/storage';
import { fechaHoraCdmx } from '../../lib/fechasCdmx';
import { cargarNombres, nombreDe, type MapaNombres } from '../../lib/nombres';
import { nombreRuta, paraArchivo } from '../../lib/indicadoresPauta';
import {
  carpetasAnalista,
  nombreFoto,
  numerar,
  resumenFotos,
  rutasZip,
  urlVigente,
  type Bandeja,
  type FotoRevision,
} from '../../lib/analistaPauta';
import { colorTono, fondoTono } from '../../lib/tonos';
import { bajarArchivo } from './descargasPauta';
import Ic from '../../components/Ic';

type Props = {
  /** Filas de la catorcena (vw_pauta_ruta), ya recortadas por PautaView. */
  filas: PautaRuta[];
  anio: number;
  numero: number;
  /** "Cat-16 · 2026" */
  etiquetaCat: string;
  /** Algo cambió en la base (comprobada, rechazada): PautaView recarga. */
  onCambio: () => void;
  /**
   * Solo ver (23-oct-2026): el Supervisor de Comprobaciones ve las tomas de
   * todos, pero revisar, rechazar, regresar y comprobar siguen siendo del
   * analista y del manager (las RPC lo exigen). Se ocultan esos botones;
   * bajar fotos y el ZIP se quedan.
   */
  soloVer?: boolean;
};

const CARPETA_EDITADAS = 'pauta-analista';
const TXT_BANDEJA: Record<Bandeja, string> = {
  por_revisar: 'Por revisar',
  comprobadas: 'Comprobadas',
  regresadas: 'Regresadas',
};

/** Una descarga o subida a la vez en toda la pestaña. */
let ocupadoModulo = false;

export default function AnalistaPauta({ filas, anio, numero, etiquetaCat, onCambio, soloVer }: Props) {
  const [bandeja, setBandeja] = useState<Bandeja>('por_revisar');
  const [abierta, setAbierta] = useState<string | null>(null);
  const [nombres, setNombres] = useState<MapaNombres>({});

  useEffect(() => {
    let vivo = true;
    cargarNombres().then((m) => vivo && setNombres(m));
    return () => {
      vivo = false;
    };
  }, []);

  const grupos = useMemo(
    () => ({
      por_revisar: carpetasAnalista(filas, 'por_revisar'),
      comprobadas: carpetasAnalista(filas, 'comprobadas'),
      regresadas: carpetasAnalista(filas, 'regresadas'),
    }),
    [filas]
  );
  const total = (b: Bandeja) => grupos[b].reduce((n, g) => n + g.total, 0);
  const visibles = grupos[bandeja];

  // Cambiar de catorcena o de bandeja cierra la carpeta abierta.
  useEffect(() => setAbierta(null), [anio, numero, bandeja]);

  return (
    <>
      <div className="toolbar">
        <div className="rt-chips rt-segmento" role="group" aria-label="Bandeja">
          {(['por_revisar', 'comprobadas', 'regresadas'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={'rt-chip' + (bandeja === k ? ' on' : '')}
              aria-pressed={bandeja === k}
              onClick={() => setBandeja(k)}
            >
              {TXT_BANDEJA[k]} ({total(k)})
            </button>
          ))}
        </div>
      </div>
      {visibles.length === 0 ? (
        <div className="empty">
          {bandeja === 'por_revisar'
            ? `No hay tomas por revisar en la ${etiquetaCat}. Te llega un aviso cuando un monitorista registra una.`
            : bandeja === 'comprobadas'
              ? `Todavía no hay tomas comprobadas en la ${etiquetaCat}.`
              : 'No hay tomas regresadas esperando al monitorista.'}
        </div>
      ) : (
        visibles.map((g) => (
          <section key={g.campana} className="card" style={{ marginBottom: 10 }}>
            {/* 13 px como los títulos de las listas (.rt-fila-tit): a tamaño
                de cuerpo se veía grande junto al resto (Erik, 23-oct-2026). */}
            <b style={{ display: 'block', marginBottom: 6, overflowWrap: 'anywhere', fontSize: 13 }}>
              <Ic i={FolderOpen} />
              {g.campana}
              <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                {' '}
                · {g.total} {g.total === 1 ? 'cara' : 'caras'}
              </span>
            </b>
            {g.versiones.map((v) => {
              const clave = `${g.campana}\u0000${v.version}`;
              const abiertaEsta = abierta === clave;
              return (
                <div key={clave} style={{ border: '1px solid var(--line)', borderRadius: 10, marginBottom: 8 }}>
                  <button
                    type="button"
                    aria-expanded={abiertaEsta}
                    onClick={() => setAbierta(abiertaEsta ? null : clave)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '10px 12px',
                      background: 'none',
                      border: 'none',
                      color: 'var(--txt)',
                      font: 'inherit',
                      fontSize: 13,
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <Ic i={abiertaEsta ? ChevronDown : ChevronRight} />
                    <span style={{ flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' }}>{v.version}</span>
                    <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {v.caras.length} {v.caras.length === 1 ? 'cara' : 'caras'}
                    </span>
                  </button>
                  {abiertaEsta && (
                    <Carpeta
                      campana={g.campana}
                      version={v.version}
                      caras={v.caras}
                      bandeja={bandeja}
                      anio={anio}
                      numero={numero}
                      nombres={nombres}
                      onCambio={onCambio}
                      soloVer={soloVer}
                    />
                  )}
                </div>
              );
            })}
          </section>
        ))
      )}
    </>
  );
}

/** Una carpeta campaña/versión abierta: sus caras con sus fotos. */
function Carpeta({
  campana,
  version,
  caras,
  bandeja,
  anio,
  numero,
  nombres,
  onCambio,
  soloVer,
}: {
  campana: string;
  version: string;
  caras: PautaRuta[];
  bandeja: Bandeja;
  anio: number;
  numero: number;
  nombres: MapaNombres;
  onCambio: () => void;
  soloVer?: boolean;
}) {
  const [fotos, setFotos] = useState<FotoRevision[]>([]);
  const [cargando, setCargando] = useState(bandeja !== 'regresadas');
  const [err, setErr] = useState('');
  const [aviso, setAviso] = useState('');
  /** Qué se está haciendo (id de foto, cara o 'zip'): una cosa a la vez. */
  const [trabajando, setTrabajando] = useState<string | null>(null);
  // Se prende al montar: con StrictMode (desarrollo) el desmontaje de prueba
  // lo dejaba en false y la pantalla no salía de "procesando".
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const ids = useMemo(() => caras.map((c) => c.vendor_face_id), [caras]);
  const firma = ids.join('|');

  /** Fotos vigentes (no videos) de estas caras con su revisión. */
  const cargar = useCallback(async () => {
    if (bandeja === 'regresadas') return;
    setErr('');
    const evid: { id: number; vendor_face_id: string; url: string; tipo: string | null; creado_en: string }[] = [];
    for (let i = 0; i < ids.length; i += 80) {
      const { data, error } = await sb
        .from('pauta_evidencias')
        .select('id,vendor_face_id,url,tipo,creado_en')
        .eq('anio', anio)
        .eq('catorcena', numero)
        .in('vendor_face_id', ids.slice(i, i + 80))
        .is('regresada_en', null)
        // Solo fotos (los videos no se revisan); `neq` sola dejaría fuera tipo null.
        .or('tipo.is.null,tipo.neq.video')
        .order('creado_en');
      if (error) {
        if (vivo.current) setErr('No se pudieron leer las fotos: ' + error.message);
        return;
      }
      evid.push(...((data as typeof evid) || []));
    }
    const rev = new Map<number, { estado: FotoRevision['estado']; editada_url: string | null }>();
    for (let i = 0; i < evid.length; i += 150) {
      const { data, error } = await sb
        .from('pauta_revision_fotos')
        .select('evidencia_id,estado,editada_url')
        .in(
          'evidencia_id',
          evid.slice(i, i + 150).map((e) => e.id)
        );
      if (error) {
        if (vivo.current) setErr('No se pudieron leer las revisiones: ' + error.message);
        return;
      }
      for (const r of (data as { evidencia_id: number; estado: string; editada_url: string | null }[]) || [])
        if (r.estado === 'correcta' || r.estado === 'editada')
          rev.set(r.evidencia_id, { estado: r.estado, editada_url: r.editada_url });
    }
    const lista = numerar(
      evid.map((e) => ({
        evidencia_id: e.id,
        vendor_face_id: e.vendor_face_id,
        url: e.url,
        tipo: e.tipo,
        creado_en: e.creado_en,
        estado: rev.get(e.id)?.estado ?? ('pendiente' as const),
        editada_url: rev.get(e.id)?.editada_url ?? null,
      }))
    );
    if (vivo.current) {
      setFotos(lista);
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anio, numero, firma, bandeja]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  /** Corre una tarea con el candado de la pestaña; los errores se muestran. */
  const correr = async (clave: string, fn: () => Promise<void>) => {
    if (ocupadoModulo) {
      setErr('Espera a que termine lo que se está haciendo.');
      return;
    }
    ocupadoModulo = true;
    setErr('');
    setAviso('');
    setTrabajando(clave);
    try {
      await fn();
    } catch (e) {
      if (vivo.current) setErr((e as Error).message || 'No se pudo completar.');
    } finally {
      ocupadoModulo = false;
      if (vivo.current) setTrabajando(null);
    }
  };

  /** Marca una foto en la base y en pantalla. true = la toma quedó comprobada. */
  const marcar = async (f: FotoRevision, estado: 'correcta' | 'editada', path?: string): Promise<boolean> => {
    const { data, error } = await sb.rpc('revisar_foto_pauta', {
      p_evidencia_id: f.evidencia_id,
      p_estado: estado,
      p_path: path ?? null,
    });
    if (error) throw new Error('No se guardó: ' + error.message);
    const res = data as { comprobada: boolean; url: string | null } | null;
    if (vivo.current)
      setFotos((prev) =>
        prev.map((x) =>
          x.evidencia_id === f.evidencia_id
            ? { ...x, estado, editada_url: estado === 'editada' ? res?.url ?? null : null }
            : x
        )
      );
    return !!res?.comprobada;
  };

  const tras = (comprobada: boolean, cara: string) => {
    if (!comprobada) return;
    if (vivo.current) setAviso(`${cara}: toma comprobada.`);
    onCambio();
  };

  const correcta = (f: FotoRevision) => correr('f' + f.evidencia_id, async () => tras(await marcar(f, 'correcta'), f.vendor_face_id));

  const todasCorrectas = (cara: string) =>
    correr('c' + cara, async () => {
      let ok = false;
      for (const f of fotos.filter((x) => x.vendor_face_id === cara && x.estado === 'pendiente'))
        ok = (await marcar(f, 'correcta')) || ok;
      tras(ok, cara);
    });

  const subirEditada = (f: FotoRevision, archivo: File) =>
    correr('f' + f.evidencia_id, async () => {
      const ext = (archivo.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${CARPETA_EDITADAS}/${anio}-${numero}/${f.vendor_face_id}_${f.n}_editada_${Date.now()}.${ext}`.replace(
        /[^\w.\-/]/g,
        '_'
      );
      const { error: up } = await sb.storage
        .from(BUCKET_EVIDENCIAS)
        .upload(path, archivo, { upsert: false, cacheControl: CACHE_INMUTABLE });
      if (up) throw new Error('No se pudo subir la editada: ' + up.message);
      try {
        tras(await marcar(f, 'editada', path), f.vendor_face_id);
      } catch (e) {
        // Sin registro, el archivo quedaría huérfano en Storage.
        await sb.storage.from(BUCKET_EVIDENCIAS).remove([path]);
        throw e;
      }
    });

  const rechazar = (cara: string, idsFotos: number[], motivo: string) =>
    correr('c' + cara, async () => {
      const { error } = await sb.rpc('rechazar_fotos_pauta', { p_evidencia_ids: idsFotos, p_motivo: motivo });
      if (error) throw new Error('No se rechazó: ' + error.message);
      if (vivo.current) setAviso(`${cara}: se rechazaron ${idsFotos.length} y la toma regresó al monitorista.`);
      onCambio();
    });

  const regresarToma = (cara: string, motivo: string) =>
    correr('c' + cara, async () => {
      const { error } = await sb.rpc('rechazar_toma', {
        p_catorcena: numero,
        p_vendor_face_id: cara,
        p_motivo: motivo,
        p_anio: anio,
      });
      if (error) throw new Error('No se regresó: ' + error.message);
      if (vivo.current) setAviso(`${cara}: la toma completa regresó al monitorista.`);
      onCambio();
    });

  /** Respaldo: la toma no tiene nada pendiente pero no se comprobó sola. */
  const comprobarToma = (cara: string) =>
    correr('c' + cara, async () => {
      const { error } = await sb.rpc('registrar_comprobacion', {
        p_catorcena: numero,
        p_vendor_face_id: cara,
        p_anio: anio,
      });
      if (error) throw new Error('No se comprobó: ' + error.message);
      tras(true, cara);
    });

  const bajarUna = (f: FotoRevision) =>
    correr('d' + f.evidencia_id, async () => {
      const resp = await fetch(urlVigente(f));
      if (!resp.ok) throw new Error('No se pudo bajar la foto (' + resp.status + ').');
      bajarArchivo(await resp.blob(), nombreFoto(f));
    });

  const bajarZip = () =>
    correr('zip', async () => {
      const { zip } = await import('fflate');
      const lista = rutasZip(campana, version, fotos);
      const archivos: Record<string, [Uint8Array, { level: 0 }]> = {};
      let i = 0;
      for (const { ruta, foto } of lista) {
        i++;
        if (vivo.current) setAviso(`Bajando fotos ${i} de ${lista.length}…`);
        const resp = await fetch(urlVigente(foto));
        if (!resp.ok) throw new Error(`No se pudo bajar ${nombreFoto(foto)} (${resp.status}).`);
        // Las fotos ya vienen comprimidas: se guardan tal cual (nivel 0).
        archivos[ruta] = [new Uint8Array(await resp.arrayBuffer()), { level: 0 }];
      }
      if (vivo.current) setAviso('Armando el ZIP…');
      const bytes = await new Promise<Uint8Array>((ok, mal) => zip(archivos, (e, d) => (e ? mal(e) : ok(d))));
      bajarArchivo(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
        `${paraArchivo(campana)}_${paraArchivo(version)}_${anio}-${numero}.zip`
      );
      if (vivo.current) setAviso('');
    });

  const ocupado = !!trabajando;

  return (
    <div style={{ padding: '0 12px 12px' }}>
      {bandeja !== 'regresadas' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <button type="button" className="btn ghost sm" onClick={bajarZip} disabled={ocupado || fotos.length === 0}>
            {trabajando === 'zip' && <span className="spinner" />}
            <Ic i={Download} />
            Bajar ZIP de esta carpeta
          </button>
        </div>
      )}
      {err && <div className="err">{err}</div>}
      {aviso && (
        <div role="status" className="phint">
          {trabajando && <span className="spinner" />}
          {aviso}
        </div>
      )}
      {cargando ? (
        <div className="loading">Leyendo las fotos…</div>
      ) : (
        caras.map((c) => (
          <BloqueCara
            key={c.vendor_face_id}
            cara={c}
            fotos={fotos.filter((f) => f.vendor_face_id === c.vendor_face_id)}
            bandeja={bandeja}
            nombres={nombres}
            ocupado={ocupado}
            trabajando={trabajando}
            soloVer={soloVer}
            onCorrecta={correcta}
            onTodasCorrectas={() => todasCorrectas(c.vendor_face_id)}
            onEditada={subirEditada}
            onBajar={bajarUna}
            onRechazar={(idsFotos, motivo) => rechazar(c.vendor_face_id, idsFotos, motivo)}
            onRegresar={(motivo) => regresarToma(c.vendor_face_id, motivo)}
            onComprobar={() => comprobarToma(c.vendor_face_id)}
          />
        ))
      )}
    </div>
  );
}

const TONO_ESTADO = { pendiente: 'ambar', correcta: 'verde', editada: 'azul' } as const;
const TXT_ESTADO = { pendiente: 'Por revisar', correcta: 'Correcta', editada: 'Editada' };

/** Una cara con sus fotos y lo que el analista puede hacer con ella. */
function BloqueCara({
  cara,
  fotos,
  bandeja,
  nombres,
  ocupado,
  trabajando,
  soloVer,
  onCorrecta,
  onTodasCorrectas,
  onEditada,
  onBajar,
  onRechazar,
  onRegresar,
  onComprobar,
}: {
  cara: PautaRuta;
  fotos: FotoRevision[];
  bandeja: Bandeja;
  nombres: MapaNombres;
  ocupado: boolean;
  trabajando: string | null;
  soloVer?: boolean;
  onCorrecta: (f: FotoRevision) => void;
  onTodasCorrectas: () => void;
  onEditada: (f: FotoRevision, a: File) => void;
  onBajar: (f: FotoRevision) => void;
  onRechazar: (ids: number[], motivo: string) => void;
  onRegresar: (motivo: string) => void;
  onComprobar: () => void;
}) {
  /** Fotos marcadas para rechazar. */
  const [sel, setSel] = useState<Set<number>>(new Set());
  /** Qué motivo se está escribiendo: rechazar las elegidas o regresar toda la toma. */
  const [pidiendo, setPidiendo] = useState<'fotos' | 'toma' | null>(null);
  const [motivo, setMotivo] = useState('');
  const r = resumenFotos(fotos);
  const puedeActuar = bandeja !== 'regresadas';
  const enCurso = trabajando === 'c' + cara.vendor_face_id;

  const alternar = (id: number) =>
    setSel((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });

  const confirmar = () => {
    const m = motivo.trim();
    if (!m) return;
    if (pidiendo === 'fotos') onRechazar([...sel], m);
    else onRegresar(m);
    setPidiendo(null);
    setMotivo('');
    setSel(new Set());
  };

  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ overflowWrap: 'anywhere', fontSize: 13 }}>{cara.vendor_face_id}</b>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {cara.site_id} · {nombreRuta(cara.ruta_clave)}
          {cara.fecha_toma && ` · tomó ${nombreDe(nombres, cara.toma_por || '')} ${fechaHoraCdmx(cara.fecha_toma)}`}
          {cara.fecha_comprobacion &&
            ` · comprobó ${nombreDe(nombres, cara.comprobacion_por || '')} ${fechaHoraCdmx(cara.fecha_comprobacion)}`}
        </span>
      </div>
      {cara.rechazo_motivo && !cara.fecha_toma && (
        <div style={{ fontSize: 12, color: colorTono('rojo'), marginTop: 4 }}>⛔ Regresada: “{cara.rechazo_motivo}”</div>
      )}

      {puedeActuar && (
        <>
          {fotos.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Sin fotos vigentes.</div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: 10,
                marginTop: 8,
              }}
            >
              {fotos.map((f) => (
                <TarjetaFoto
                  key={f.evidencia_id}
                  f={f}
                  elegida={sel.has(f.evidencia_id)}
                  ocupado={ocupado}
                  trabajando={trabajando}
                  soloVer={soloVer}
                  onElegir={() => alternar(f.evidencia_id)}
                  onCorrecta={() => onCorrecta(f)}
                  onBajar={() => onBajar(f)}
                  onEditada={(a) => onEditada(f, a)}
                />
              ))}
            </div>
          )}

          {!soloVer && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
            {enCurso && <span className="spinner" />}
            {r.pendientes > 0 && (
              <button type="button" className="btn ghost sm" disabled={ocupado} onClick={onTodasCorrectas}>
                <Ic i={Check} />
                Las {r.pendientes} por revisar: correctas
              </button>
            )}
            {bandeja === 'por_revisar' && r.total > 0 && r.pendientes === 0 && (
              <button type="button" className="btn ok sm" disabled={ocupado} onClick={onComprobar}>
                <Ic i={Check} />
                Comprobar toma
              </button>
            )}
            {sel.size > 0 && (
              <button type="button" className="btn hi sm" disabled={ocupado} onClick={() => setPidiendo('fotos')}>
                <Ic i={X} />
                Rechazar {sel.size} {sel.size === 1 ? 'foto' : 'fotos'}
              </button>
            )}
            <button type="button" className="btn ghost sm" disabled={ocupado} onClick={() => setPidiendo('toma')}>
              <Ic i={Undo2} />
              Regresar toda la toma
            </button>
          </div>
          )}

          {pidiendo && !soloVer && (
            <div className="field" style={{ marginTop: 8 }}>
              <label>
                {pidiendo === 'fotos'
                  ? `Motivo del rechazo de ${sel.size} ${sel.size === 1 ? 'foto' : 'fotos'}`
                  : 'Motivo para regresar toda la toma'}
              </label>
              <textarea
                rows={2}
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ej. la foto salió movida; falta la toma larga…"
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    setPidiendo(null);
                    setMotivo('');
                  }}
                >
                  Cancelar
                </button>
                <button type="button" className="btn hi sm" disabled={ocupado || !motivo.trim()} onClick={confirmar}>
                  {pidiendo === 'fotos' ? 'Rechazar y avisar al monitorista' : 'Regresar y avisar al monitorista'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TarjetaFoto({
  f,
  elegida,
  ocupado,
  trabajando,
  soloVer,
  onElegir,
  onCorrecta,
  onBajar,
  onEditada,
}: {
  f: FotoRevision;
  elegida: boolean;
  ocupado: boolean;
  trabajando: string | null;
  soloVer?: boolean;
  onElegir: () => void;
  onCorrecta: () => void;
  onBajar: () => void;
  onEditada: (a: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const url = urlVigente(f);
  const tono = TONO_ESTADO[f.estado];
  return (
    <div
      style={{
        border: '1px solid ' + (elegida ? colorTono('rojo') : 'var(--line)'),
        borderRadius: 9,
        overflow: 'hidden',
        background: 'var(--panel2)',
      }}
    >
      <a href={url} target="_blank" rel="noreferrer" style={{ display: 'block', background: 'var(--panel)' }}>
        <img src={url} alt={nombreFoto(f)} loading="lazy" style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }} />
      </a>
      <div style={{ padding: '7px 8px', display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, overflowWrap: 'anywhere' }}>{nombreFoto(f)}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="pill" style={{ background: fondoTono(tono), color: colorTono(tono) }}>
            {TXT_ESTADO[f.estado]}
          </span>
          {!soloVer && (
            // Sin partir la palabra: en la tarjeta de 150 px salía «Rec / haz / ar» (Erik, 23-oct-2026).
            <label
              style={{
                fontSize: 11,
                display: 'inline-flex',
                gap: 4,
                alignItems: 'center',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              <input type="checkbox" checked={elegida} onChange={onElegir} disabled={ocupado} />
              Rechazar
            </label>
          )}
        </div>
        {f.estado === 'editada' && (
          <a href={f.url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
            Ver original
          </a>
        )}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          <button type="button" className="btn ghost sm" disabled={ocupado} onClick={onBajar} title="Descargar con su nombre">
            {trabajando === 'd' + f.evidencia_id && <span className="spinner" />}
            <Ic i={Download} />
          </button>
          {f.estado !== 'correcta' && !soloVer && (
            <button type="button" className="btn ghost sm" disabled={ocupado} onClick={onCorrecta}>
              {trabajando === 'f' + f.evidencia_id && <span className="spinner" />}
              <Ic i={Check} />
              Correcta
            </button>
          )}
          {!soloVer && (
          <button
            type="button"
            className="btn ghost sm"
            disabled={ocupado}
            onClick={() => input.current?.click()}
            title="Subir la foto editada"
          >
            <Ic i={Upload} />
            {f.estado === 'editada' ? 'Otra editada' : 'Editada'}
          </button>
          )}
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const a = e.target.files?.[0];
              e.target.value = '';
              if (a) onEditada(a);
            }}
          />
        </div>
      </div>
    </div>
  );
}
