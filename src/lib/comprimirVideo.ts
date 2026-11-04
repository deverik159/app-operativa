// ============================================================
// src/lib/comprimirVideo.ts
// Recomprime videos pesados EN EL TELÉFONO antes de subirlos (Erik,
// 3-nov-2026, en prueba local).
//
// Por qué: un video de 30 s grabado en 4K pesa ~85 MB y el tope por archivo
// del plan gratuito de Supabase es 50 MB, así que se rechazaba. Recomprimido
// a 720p (lado mayor 1280 px) y ~2.5 Mbps, esos 30 s quedan en ~10 MB: sube
// rápido por datos móviles y gasta poco almacenamiento y transferencia.
//
// Cómo: WebCodecs (decodifica y vuelve a codificar con el hardware del
// teléfono) con Mediabunny, que lee el MOV/MP4 del teléfono y escribe el MP4.
// Mediabunny se carga solo cuando hace falta (import dinámico): no pesa en
// la app de quien nunca sube un video grande.
//
// Nunca revienta el flujo: si el navegador no puede, si algo falla o si el
// resultado no es menor, se regresa el original y el tope de tamaño decide.
// WebCodecs solo existe en páginas seguras (https o localhost): por eso la
// prueba en teléfono va con `npm run dev` (https://IP:5173), no dev:http.
// ============================================================

import { guardarArchivo, idbDelete, leerArchivo } from './idb';

/** Por debajo de esto no vale la pena: el video sube como está. */
export const COMPRIMIR_VIDEO_DESDE = 20 * 1024 * 1024;

/** Lado mayor del video recomprimido (720p). */
const LADO_MAX = 1280;
/** Bitrate del video recomprimido: ~19 MB por minuto, sobra para evidencia. */
const BITRATE = 2_500_000;
/**
 * Tope de cuadros por segundo: muchos Android graban a 60 y codificar la
 * mitad de cuadros casi duplica la velocidad; para evidencia 30 se ve igual.
 * (Prueba del 4-nov-2026: 40 s de video tardaron ~3 min en un Android.)
 */
const FPS_MAX = 30;
/** Más grande que esto no se intenta: tardaría demasiado en el teléfono. */
const MAX_ENTRADA = 600 * 1024 * 1024;

export type ResultadoVideo = {
  file: File;
  /** true si `file` es el recomprimido; false si es el original. */
  comprimido: boolean;
  /** Por qué se quedó el original (para el registro de la prueba). */
  motivo?: string;
  /** El recomprimido no trae audio (el navegador no pudo copiarlo ni recodificarlo). */
  sinAudio?: boolean;
};

// ------------------------------------------------------------
// Si el teléfono se queda sin memoria a media compresión, el navegador cierra
// la pestaña y la RECARGA: no hay error que atrapar, solo se pierde todo
// (Android y iPhone, prueba del 3-nov-2026). Por eso se deja una "migaja" en
// el teléfono ANTES de empezar y se va actualizando; si la página arranca y
// la migaja sigue ahí, la compresión se interrumpió. Con eso:
//   - se le dice al usuario qué pasó (y a nosotros en qué paso y %);
//   - ese mismo video ya no se intenta comprimir (no entra en un ciclo de
//     recargas) y, tras dos interrupciones, este teléfono deja de intentarlo.
// ------------------------------------------------------------
const CLAVE_EN_CURSO = 'gv_video_compresion_en_curso';
const CLAVE_FALLOS = 'gv_video_compresion_fallos';
/** Interrupciones que se toleran antes de dejar de comprimir en este teléfono. */
const MAX_FALLOS = 2;

type Migaja = {
  nombre: string;
  bytes: number;
  inicio: number;
  paso: string;
  avance: number;
  pagina: string;
  /** El original quedó guardado en el teléfono (se puede recuperar). */
  respaldo?: boolean;
  /** Memoria del teléfono en GB que informa el navegador (Chrome), y núcleos. */
  memoriaGb?: number;
  nucleos?: number;
};
/** Llave del original en IndexedDB mientras se comprime. */
const CLAVE_RESPALDO = 'v:comprimiendo';
/** Distingue esta carga de la página de la anterior (la que se recargó). */
const PAGINA = Math.random().toString(36).slice(2);

// Solo en desarrollo, para las pruebas en teléfono: abrir la app con
// ?reiniciar-video borra las interrupciones guardadas y vuelve a intentar.
// Se quita de la dirección al usarse: si la página se recarga a media
// compresión, no debe volver a borrar la migaja que dice dónde se cortó.
if (import.meta.env.DEV && typeof location !== 'undefined' && location.search.includes('reiniciar-video')) {
  try {
    localStorage.removeItem('gv_video_compresion_en_curso');
    localStorage.removeItem('gv_video_compresion_fallos');
    const u = new URL(location.href);
    u.searchParams.delete('reiniciar-video');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  } catch {
    /* sin almacenamiento */
  }
}
type Fallo = Migaja & { detectado: number };

function leer<T>(clave: string): T | null {
  try {
    const v = localStorage.getItem(clave);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function escribir(clave: string, valor: unknown): void {
  try {
    if (valor == null) localStorage.removeItem(clave);
    else localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    /* sin almacenamiento: se sigue sin la protección */
  }
}

/** La interrumpida que se encontró al arrancar esta carga de la página. */
let interrumpidaAlArrancar: Fallo | null = null;

/** Pasa una migaja que quedó de una compresión interrumpida a la lista de fallos. */
function recogerInterrumpida(): Fallo | null {
  const m = leer<Migaja>(CLAVE_EN_CURSO);
  // Una migaja de ESTA carga es una compresión que sigue en marcha.
  if (!m || m.pagina === PAGINA) return null;
  escribir(CLAVE_EN_CURSO, null);
  const fallo: Fallo = { ...m, detectado: Date.now() };
  const fallos = leer<Fallo[]>(CLAVE_FALLOS) || [];
  escribir(CLAVE_FALLOS, [...fallos, fallo].slice(-10));
  interrumpidaAlArrancar = fallo;
  return fallo;
}

/**
 * Si la compresión anterior se interrumpió (la página se recargó), el aviso
 * para enseñarlo; null si no. El mismo durante toda esta carga de la página.
 */
export function compresionInterrumpida(): string | null {
  recogerInterrumpida();
  const f = interrumpidaAlArrancar;
  if (!f) return null;
  const mb = (f.bytes / 1024 / 1024).toFixed(1);
  const equipo = f.memoriaGb ? `, teléfono de ${f.memoriaGb} GB` : '';
  return (
    `El teléfono recargó la página mientras comprimía «${f.nombre}» (${mb} MB, ` +
    `${f.paso}, ${Math.round(f.avance * 100)} %${equipo}). ` +
    (f.respaldo
      ? 'Toca «Recuperar el video» para adjuntarlo sin comprimir.'
      : 'Si lo vuelves a elegir, se subirá sin comprimir.')
  );
}

/** ¿Quedó guardado el video de la compresión interrumpida? */
export function hayVideoParaRecuperar(): boolean {
  recogerInterrumpida();
  return !!interrumpidaAlArrancar?.respaldo;
}

/**
 * El original de la compresión interrumpida, para adjuntarlo sin comprimir
 * (ese mismo archivo ya no se vuelve a comprimir). Lo borra del teléfono.
 */
export async function recuperarVideoInterrumpido(): Promise<File | null> {
  const f = await leerArchivo(CLAVE_RESPALDO);
  await idbDelete('archivos', CLAVE_RESPALDO).catch(() => {});
  if (interrumpidaAlArrancar) interrumpidaAlArrancar.respaldo = false;
  return f;
}

const mismoArchivo = (f: File, m: { nombre: string; bytes: number }) =>
  m.nombre === f.name && m.bytes === f.size;

/** ¿Este navegador puede recomprimir video? */
export function puedeComprimirVideo(): boolean {
  if (
    typeof window === 'undefined' ||
    window.isSecureContext !== true ||
    !('VideoEncoder' in window) ||
    !('VideoDecoder' in window)
  ) {
    return false;
  }
  recogerInterrumpida();
  return (leer<Fallo[]>(CLAVE_FALLOS) || []).length < MAX_FALLOS;
}

/** Par más cercano: H.264 exige medidas pares. */
const par = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Recomprime `file` a MP4 H.264 de 720p. `onProgreso` recibe de 0 a 1.
 * `originalCabe` = el original ya cabe en el tope: si el recomprimido
 * perdiera el audio, se prefiere el original.
 */
export async function comprimirVideo(
  file: File,
  op: {
    /** p de 0 a 1; restanteSeg = cuánto falta estimado (null mientras no se sabe). */
    onProgreso?: (p: number, restanteSeg: number | null) => void;
    originalCabe?: boolean;
  } = {}
): Promise<ResultadoVideo> {
  const original = (motivo: string): ResultadoVideo => ({ file, comprimido: false, motivo });
  if (!file.type.startsWith('video/')) return original('no es video');
  if (!puedeComprimirVideo()) return original('el navegador no tiene WebCodecs');
  if (file.size > MAX_ENTRADA) return original('demasiado grande para recomprimir aquí');
  if ((leer<Fallo[]>(CLAVE_FALLOS) || []).some((f) => mismoArchivo(file, f))) {
    return original('este video ya recargó la página una vez');
  }

  const migaja: Migaja = {
    nombre: file.name,
    bytes: file.size,
    inicio: Date.now(),
    paso: 'cargando',
    avance: 0,
    pagina: PAGINA,
    memoriaGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    nucleos: navigator.hardwareConcurrency,
  };
  const marcar = (paso: string, avance: number) => {
    migaja.paso = paso;
    migaja.avance = avance;
    escribir(CLAVE_EN_CURSO, migaja);
  };
  // Respaldo del original ANTES de empezar: si la página se recarga, el
  // video no se pierde (prueba en Android, 4-nov-2026).
  marcar('guardando una copia', 0);
  migaja.respaldo = await guardarArchivo(CLAVE_RESPALDO, file).catch(() => false);
  marcar('cargando', 0);

  let input: { dispose(): void } | null = null;
  try {
    const mb = await import('mediabunny');
    marcar('abriendo el archivo', 0);
    const entrada = new mb.Input({
      formats: mb.ALL_FORMATS,
      // Lectura por pedazos (slice + arrayBuffer) y no con blob.stream(): en
      // Android la página se recargó LEYENDO un video de 96 MB de la cámara
      // (prueba del 4-nov-2026), y la propia librería documenta fallas de
      // stream() con archivos grandes en WebKit. Más lento, más estable.
      source: new mb.BlobSource(file, { useStreamReader: false, maxCacheSize: 4 * 1024 * 1024 }),
    });
    input = entrada;
    marcar('leyendo la pista de video', 0);
    const pista = await entrada.getPrimaryVideoTrack();
    if (!pista) return original('sin pista de video');

    // Cuadros por segundo del original (de sus primeros paquetes).
    const fps = await pista
      .computePacketStats(90)
      .then((st) => st.averagePacketRate)
      .catch(() => null);
    const frameRate = fps && fps > FPS_MAX + 2 ? FPS_MAX : undefined;

    const w = pista.displayWidth;
    const h = pista.displayHeight;
    const escala = Math.min(1, LADO_MAX / Math.max(w, h));
    const ancho = par(w * escala);
    const alto = par(h * escala);
    marcar(`revisando el códec (${w}x${h})`, 0);
    if (!(await mb.canEncodeVideo('avc', { width: ancho, height: alto, bitrate: BITRATE }))) {
      return original('el teléfono no codifica H.264');
    }

    marcar(`preparando la conversión (${w}x${h})`, 0);
    const salida = new mb.Output({
      // in-memory: el índice va al principio y el video se puede ver mientras
      // se descarga, sin bajarlo completo.
      format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new mb.BufferTarget(),
    });
    const conversion = await mb.Conversion.init({
      input: entrada,
      output: salida,
      tracks: 'primary',
      video: {
        width: ancho,
        height: alto,
        fit: 'contain',
        codec: 'avc',
        bitrate: BITRATE,
        forceTranscode: true,
        ...(frameRate ? { frameRate } : {}),
      },
      // AAC: el del iPhone y casi todos los Android se copia tal cual.
      audio: { codec: 'aac' },
    });
    if (!conversion.isValid) return original('conversión no válida');
    if (conversion.discardedTracks.some((d) => d.track.isVideoTrack())) {
      return original('se perdería el video');
    }
    const sinAudio = conversion.discardedTracks.some((d) => !d.track.isVideoTrack());
    if (sinAudio && op.originalCabe) return original('se perdería el audio');

    const cps = fps ? ` ${Math.round(fps)}→${frameRate ?? Math.round(fps)} cps` : '';
    marcar(`convirtiendo ${w}x${h} a ${ancho}x${alto}${cps}`, 0);
    let ultimo = 0;
    const t0 = Date.now();
    conversion.onProgress = (p) => {
      // Lo que falta, al ritmo que lleva este teléfono (tras un arranque).
      const seg = (Date.now() - t0) / 1000;
      op.onProgreso?.(p, p >= 0.03 && seg >= 2 ? (seg / p) * (1 - p) : null);
      // La migaja cada ~5 %: suficiente para saber dónde se cortó sin
      // escribir en el almacenamiento en cada cuadro.
      if (p - ultimo >= 0.05 || p === 1) {
        ultimo = p;
        marcar(migaja.paso, p);
      }
    };
    await conversion.execute();

    const buffer = salida.target.buffer;
    if (!buffer) return original('sin resultado');
    // Si apenas baja, no vale la pena perder calidad.
    if (buffer.byteLength >= file.size * 0.9) return original('no quedó más ligero');

    const nombre = file.name.replace(/\.[^.]+$/, '') + '.mp4';
    return {
      file: new File([buffer], nombre, { type: 'video/mp4', lastModified: file.lastModified }),
      comprimido: true,
      sinAudio,
    };
  } catch (e) {
    console.warn('[comprimirVideo] se sube el original:', e);
    return original('error al recomprimir');
  } finally {
    // Terminó (bien o con error atrapado): no fue una recarga.
    escribir(CLAVE_EN_CURSO, null);
    if (migaja.respaldo) await idbDelete('archivos', CLAVE_RESPALDO).catch(() => {});
    try {
      input?.dispose();
    } catch {
      /* ya liberado */
    }
  }
}
