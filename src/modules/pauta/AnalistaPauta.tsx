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
import { Check, ChevronDown, ChevronRight, Download, FolderOpen, RotateCcw, Undo2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PautaRuta } from '../../types/db';
import { sb } from '../../lib/supabase';
import { tope } from '../../lib/envios';
import { pareceSinRed } from '../../lib/enLinea';
import { BUCKET_EVIDENCIAS, CACHE_INMUTABLE, alFallarMiniatura, rutaMiniatura, subirMiniatura, urlMiniatura } from '../../lib/storage';
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
/** Liga pública de un archivo del bucket de evidencias, con el proyecto en el que corre la app. */
const urlPublica = (path: string) => sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path).data.publicUrl;
const TXT_BANDEJA: Record<Bandeja, string> = {
  por_revisar: 'Por revisar',
  comprobadas: 'Comprobadas',
  regresadas: 'Regresadas',
};

/**
 * Una descarga o subida a la vez en toda la pestaña. Por eso cada espera de
 * red lleva tope (11-nov-2026): con la red colgada una sola acción dejaba el
 * candado puesto y ningún botón de ninguna carpeta respondía hasta recargar.
 */
let ocupadoModulo = false;

const TOPE_ESCRITURA_MS = 30000;
const TOPE_SUBIDA_MS = 90000;
const TOPE_BORRADO_MS = 15000;
/** Por foto al bajarla (sola o para el ZIP): margen para 3G. */
const TOPE_FOTO_MS = 60000;

/** Para lo que no se puede abortar (subidas y borrados de Storage). */
function conTope<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let t: number | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = window.setTimeout(() => rej(new Error(msg)), ms);
    }),
  ]).finally(() => window.clearTimeout(t));
}

/**
 * Error de una escritura. Sin red (o al vencer el tope) no se sabe si la
 * base alcanzó a guardarla: se pide revisar antes de repetir.
 */
function fallaEscritura(prefijo: string, error: { message: string }): Error {
  return new Error(
    pareceSinRed(error)
      ? `${prefijo}: la red no respondió y pudo haber quedado hecho. Toca ↻ (arriba) y revisa la toma antes de repetirlo.`
      : `${prefijo}: ${error.message}`
  );
}

/** Baja una foto con tope; el tope también corta la lectura del cuerpo. */
async function bajarFoto(url: string, nombre: string): Promise<{ bytes: Uint8Array; tipo: string }> {
  try {
    const resp = await fetch(url, { signal: tope(TOPE_FOTO_MS) });
    if (!resp.ok) throw new Error(`No se pudo bajar ${nombre} (${resp.status}).`);
    return { bytes: new Uint8Array(await resp.arrayBuffer()), tipo: resp.headers.get('content-type') || '' };
  } catch (e) {
    if (pareceSinRed(e)) throw new Error(`No se pudo bajar ${nombre}: la red no respondió.`);
    throw e;
  }
}

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
            {/* h3 (bajo el h2 de Comprobaciones) con el mismo look del <b> de
                antes (revisión de accesibilidad, 24-oct-2026). */}
            <h3 style={{ font: 'inherit', fontWeight: 700, fontSize: 13, margin: '0 0 6px', overflowWrap: 'anywhere' }}>
              <Ic i={FolderOpen} />
              {g.campana}
              <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                {' '}
                · {g.total} {g.total === 1 ? 'cara' : 'caras'}
              </span>
            </h3>
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
  /** La lectura de fotos falló: en vez de girar para siempre (o de pintar
   *  las caras como si no tuvieran fotos) se ofrece Reintentar (11-nov-2026). */
  const [falloCarga, setFalloCarga] = useState(false);
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
        .order('creado_en')
        .abortSignal(tope(20000));
      if (error) {
        if (vivo.current) {
          setErr('No se pudieron leer las fotos: ' + error.message);
          setFalloCarga(true);
          setCargando(false);
        }
        return;
      }
      evid.push(...((data as typeof evid) || []));
    }
    const rev = new Map<number, { estado: FotoRevision['estado']; editada_url: string | null; editada_path: string | null }>();
    for (let i = 0; i < evid.length; i += 150) {
      const { data, error } = await sb
        .from('pauta_revision_fotos')
        .select('evidencia_id,estado,editada_url,editada_path')
        .in(
          'evidencia_id',
          evid.slice(i, i + 150).map((e) => e.id)
        )
        .abortSignal(tope(20000));
      if (error) {
        if (vivo.current) {
          setErr('No se pudieron leer las revisiones: ' + error.message);
          setFalloCarga(true);
          setCargando(false);
        }
        return;
      }
      for (const r of (data as { evidencia_id: number; estado: string; editada_url: string | null; editada_path: string | null }[]) ||
        [])
        if (r.estado === 'correcta' || r.estado === 'editada')
          // La liga se arma desde la ruta con el proyecto en el que corre la
          // app (24-oct-2026); las filas viejas traen editada_url de respaldo.
          rev.set(r.evidencia_id, {
            estado: r.estado,
            editada_path: r.editada_path,
            editada_url: r.editada_path ? urlPublica(r.editada_path) : r.editada_url,
          });
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
        editada_path: rev.get(e.id)?.editada_path ?? null,
      }))
    );
    if (vivo.current) {
      setFotos(lista);
      setFalloCarga(false);
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
    }).abortSignal(tope(TOPE_ESCRITURA_MS));
    if (error) throw fallaEscritura('No se guardó', error);
    // Desde el 24-oct-2026 la RPC devuelve la ruta (path) y url va en null;
    // una base vieja todavía manda url.
    const res = data as { comprobada: boolean; url: string | null; path?: string | null } | null;
    const nuevaRuta = estado === 'editada' ? res?.path ?? path ?? null : null;
    const nuevaUrl = nuevaRuta ? urlPublica(nuevaRuta) : estado === 'editada' ? res?.url ?? null : null;
    if (vivo.current)
      setFotos((prev) =>
        prev.map((x) =>
          x.evidencia_id === f.evidencia_id ? { ...x, estado, editada_url: nuevaUrl, editada_path: nuevaRuta } : x
        )
      );
    // Editadas huérfanas (pendiente técnico, 24-oct-2026): al reemplazar una
    // editada por otra, o al regresarla a «correcta», el archivo anterior se
    // borra de Storage. Solo puede quien lo subió o el manager (ev_obj_del);
    // si no se puede, se queda y no se interrumpe la revisión.
    if (f.editada_path && f.editada_path !== nuevaRuta) {
      try {
        await conTope(
          sb.storage.from(BUCKET_EVIDENCIAS).remove([f.editada_path, rutaMiniatura(f.editada_path)]),
          TOPE_BORRADO_MS,
          'sin respuesta'
        );
      } catch {
        /* se queda el archivo */
      }
    }
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
      const { error: up } = await conTope(
        sb.storage.from(BUCKET_EVIDENCIAS).upload(path, archivo, { upsert: false, cacheControl: CACHE_INMUTABLE }),
        TOPE_SUBIDA_MS,
        'No se pudo subir la editada: la red no respondió. Vuelve a intentarlo.'
      );
      if (up) throw new Error('No se pudo subir la editada: ' + up.message);
      await subirMiniatura(path, archivo);
      try {
        tras(await marcar(f, 'editada', path), f.vendor_face_id);
      } catch (e) {
        // Sin registro, el archivo quedaría huérfano en Storage. Si la red no
        // respondió, la marca pudo quedar y entonces el archivo NO se borra.
        if (!/la red no respondió/.test((e as Error).message)) {
          try {
            await conTope(sb.storage.from(BUCKET_EVIDENCIAS).remove([path, rutaMiniatura(path)]), TOPE_BORRADO_MS, 'sin respuesta');
          } catch {
            /* se queda el archivo */
          }
        }
        throw e;
      }
    });

  const rechazar = (cara: string, idsFotos: number[], motivo: string) =>
    correr('c' + cara, async () => {
      const { error } = await sb
        .rpc('rechazar_fotos_pauta', { p_evidencia_ids: idsFotos, p_motivo: motivo })
        .abortSignal(tope(TOPE_ESCRITURA_MS));
      if (error) throw fallaEscritura('No se rechazó', error);
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
      }).abortSignal(tope(TOPE_ESCRITURA_MS));
      if (error) throw fallaEscritura('No se regresó', error);
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
      }).abortSignal(tope(TOPE_ESCRITURA_MS));
      if (error) throw fallaEscritura('No se comprobó', error);
      tras(true, cara);
    });

  /**
   * Deshacer una comprobación sin regresar la toma (Erik, 25-oct-2026): las
   * fotos y sus revisiones se quedan y la toma vuelve a «Por revisar».
   */
  const reabrirToma = (cara: string, motivo: string) =>
    correr('c' + cara, async () => {
      const { error } = await sb.rpc('reabrir_toma', {
        p_catorcena: numero,
        p_vendor_face_id: cara,
        p_motivo: motivo,
        p_anio: anio,
      }).abortSignal(tope(TOPE_ESCRITURA_MS));
      if (error) throw fallaEscritura('No se reabrió', error);
      if (vivo.current) setAviso(`${cara}: la toma se reabrió y está en Por revisar.`);
      onCambio();
    });

  const bajarUna = (f: FotoRevision) =>
    correr('d' + f.evidencia_id, async () => {
      const { bytes, tipo } = await bajarFoto(urlVigente(f), nombreFoto(f));
      bajarArchivo(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: tipo }), nombreFoto(f));
    });

  /**
   * El ZIP se arma foto por foto (11-nov-2026). Antes se juntaban todas las
   * fotos, luego el ZIP entero y luego su Blob: tres copias de la carpeta en
   * memoria, que en iPhone podían tumbar la pestaña. Ahora cada foto pasa
   * directo al ZIP (sin comprimir: ya viene comprimida) y cada ~32 MB los
   * pedazos se juntan en un Blob, así que se suelta cada foto al terminarla.
   */
  const bajarZip = () =>
    correr('zip', async () => {
      const { Zip, ZipPassThrough } = await import('fflate');
      const lista = rutasZip(campana, version, fotos);
      const blobs: Blob[] = [];
      let pedazos: Uint8Array[] = [];
      let enPedazos = 0;
      const juntar = () => {
        if (!pedazos.length) return;
        blobs.push(new Blob(pedazos as Uint8Array<ArrayBuffer>[]));
        pedazos = [];
        enPedazos = 0;
      };
      let fallo: Error | null = null;
      let listo = false;
      const z = new Zip((e, d, final) => {
        if (e) {
          fallo = e;
          return;
        }
        pedazos.push(d);
        enPedazos += d.length;
        if (enPedazos > 32 * 1024 * 1024) juntar();
        if (final) listo = true;
      });
      try {
        let i = 0;
        for (const { ruta, foto } of lista) {
          i++;
          if (vivo.current) setAviso(`Bajando fotos ${i} de ${lista.length}…`);
          const { bytes } = await bajarFoto(urlVigente(foto), nombreFoto(foto));
          const archivo = new ZipPassThrough(ruta);
          z.add(archivo);
          archivo.push(bytes, true);
          if (fallo) throw fallo;
        }
        z.end();
      } catch (e) {
        z.terminate();
        throw e;
      }
      if (fallo) throw fallo;
      // Sin compresión fflate escribe en el momento: al terminar end() ya llegó el final.
      if (!listo) throw new Error('No se pudo armar el ZIP.');
      juntar();
      bajarArchivo(
        new Blob(blobs, { type: 'application/zip' }),
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
      {err && (
        <div className="err" role="alert">
          {err}
        </div>
      )}
      {aviso && (
        <div role="status" className="phint">
          {trabajando && <span className="spinner" />}
          {aviso}
        </div>
      )}
      {cargando ? (
        <div className="loading" role="status">
          Leyendo las fotos…
        </div>
      ) : falloCarga ? (
        <button
          type="button"
          className="btn"
          onClick={() => {
            setFalloCarga(false);
            setCargando(true);
            cargar();
          }}
        >
          <Ic i={RotateCcw} />
          Reintentar
        </button>
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
            onReabrir={(motivo) => reabrirToma(c.vendor_face_id, motivo)}
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
  onReabrir,
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
  onReabrir: (motivo: string) => void;
}) {
  /** Fotos marcadas para rechazar. */
  const [sel, setSel] = useState<Set<number>>(new Set());
  /** Qué motivo se está escribiendo: rechazar las elegidas, regresar toda la toma o reabrirla. */
  const [pidiendo, setPidiendo] = useState<'fotos' | 'toma' | 'reabrir' | null>(null);
  const [motivo, setMotivo] = useState('');
  // Hay un campo de motivo por cara: id único para ligarlo a su etiqueta.
  const idMotivo = useId();
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
    else if (pidiendo === 'reabrir') onReabrir(m);
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
        <div style={{ fontSize: 12, color: colorTono('rojo'), marginTop: 4 }}>
          <span aria-hidden="true">⛔</span> Regresada: “{cara.rechazo_motivo}”
        </div>
      )}
      {/* Rastro de la reapertura mientras la toma siga sin volver a
          comprobarse (25-oct-2026). */}
      {cara.reabierta_motivo && cara.fecha_toma && !cara.fecha_comprobacion && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          <span aria-hidden="true">↺</span> Reabierta por {nombreDe(nombres, cara.reabierta_por || '')}
          {cara.reabierta_en && ` ${fechaHoraCdmx(cara.reabierta_en)}`}: “{cara.reabierta_motivo}”
        </div>
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
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }} aria-busy={enCurso}>
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
            {bandeja === 'comprobadas' && (
              // Deshacer la comprobación sin tirar las fotos (Erik,
              // 25-oct-2026): la toma vuelve a Por revisar.
              <button type="button" className="btn ghost sm" disabled={ocupado} onClick={() => setPidiendo('reabrir')}>
                <Ic i={RotateCcw} />
                Reabrir
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
              <label htmlFor={idMotivo}>
                {pidiendo === 'fotos'
                  ? `Motivo del rechazo de ${sel.size} ${sel.size === 1 ? 'foto' : 'fotos'}`
                  : pidiendo === 'reabrir'
                    ? 'Motivo para reabrir la toma (las fotos y sus revisiones se quedan; al marcar o editar cualquier foto se vuelve a comprobar, y puedes seguir editando después)'
                    : 'Motivo para regresar toda la toma'}
              </label>
              <textarea
                id={idMotivo}
                rows={2}
                // El campo aparece al tocar «Rechazar» o «Regresar»: el foco
                // se va con él (revisión de accesibilidad, 24-oct-2026).
                autoFocus
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder={
                  pidiendo === 'reabrir'
                    ? 'Ej. se comprobó por error; el cliente pide otra toma…'
                    : 'Ej. la foto salió movida; falta la toma larga…'
                }
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
                <button
                  type="button"
                  className={pidiendo === 'reabrir' ? 'btn sm' : 'btn hi sm'}
                  disabled={ocupado || !motivo.trim()}
                  onClick={confirmar}
                >
                  {pidiendo === 'fotos'
                    ? 'Rechazar y avisar al monitorista'
                    : pidiendo === 'reabrir'
                      ? 'Reabrir (vuelve a Por revisar)'
                      : 'Regresar y avisar al monitorista'}
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
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label={`${nombreFoto(f)} (abre en otra pestaña)`}
        style={{ display: 'block', background: 'var(--panel)' }}
      >
        {/* Miniatura (12-nov-2026); las fotos de antes no la tienen y caen
            solas al original. La liga sigue abriendo el original. */}
        <img
          src={urlMiniatura(url)}
          onError={alFallarMiniatura(url)}
          alt={nombreFoto(f)}
          loading="lazy"
          style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }}
        />
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
              <input
                type="checkbox"
                checked={elegida}
                onChange={onElegir}
                disabled={ocupado}
                aria-label={`Rechazar ${nombreFoto(f)}`}
              />
              Rechazar
            </label>
          )}
        </div>
        {f.estado === 'editada' && (
          <a href={f.url} target="_blank" rel="noreferrer" aria-label="Ver original (abre en otra pestaña)" style={{ fontSize: 11 }}>
            Ver original
          </a>
        )}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn ghost sm"
            disabled={ocupado}
            onClick={onBajar}
            aria-label={`Descargar ${nombreFoto(f)}`}
            title="Descargar con su nombre"
          >
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
