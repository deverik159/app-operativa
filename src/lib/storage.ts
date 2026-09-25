// ============================================================
// src/lib/storage.ts
// Subida de fotos a Supabase Storage.
//
// Extraído de FijacionExternaView para que TODOS los flujos de fotos
// (evidencia de incidencia, reparación, fijación interna) usen el mismo
// código en vez de duplicarlo por módulo.
// ============================================================
import { sb } from './supabase';

/** Único bucket de evidencias del proyecto. */
export const BUCKET_EVIDENCIAS = 'evidencias';

/**
 * Caché de UN AÑO para todo lo que se sube. Es seguro porque ningún archivo
 * se sobreescribe: todas las subidas van con upsert apagado y el nombre
 * lleva Date.now(), así que una URL siempre apunta al mismo contenido. Sin
 * esto, supabase-js deja 1 hora y cada tarjeta volvía a bajar su foto a la
 * hora siguiente — con 300 usuarios, egress tirado (auditoría, 24-sep-2026).
 */
export const CACHE_INMUTABLE = '31536000';

/** Lado mayor de la miniatura: nítida a lo ancho de una tarjeta en celular. */
const LADO_MINI = 640;

/**
 * Ruta de la miniatura de un archivo: misma carpeta, subcarpeta `mini/`,
 * extensión .jpg. `abc/EV1_x_123.jpg` → `abc/mini/EV1_x_123.jpg`.
 */
export function rutaMiniatura(path: string): string {
  const i = path.lastIndexOf('/');
  const dir = i >= 0 ? path.slice(0, i + 1) : '';
  const nombre = (i >= 0 ? path.slice(i + 1) : path).replace(/\.[^.]+$/, '');
  return `${dir}mini/${nombre}.jpg`;
}

/**
 * URL pública de la miniatura a partir de la URL pública del original.
 * Las fotos subidas antes de las miniaturas no la tienen: quien la pinte
 * debe caer al original con onError (ver `alFallarMiniatura`).
 */
export function urlMiniatura(url: string | null | undefined): string {
  if (!url) return '';
  const marca = `/object/public/${BUCKET_EVIDENCIAS}/`;
  const i = url.indexOf(marca);
  if (i < 0) return url;
  const base = url.slice(0, i + marca.length);
  const resto = url.slice(i + marca.length).split('?')[0];
  return base + rutaMiniatura(resto);
}

/**
 * onError de un <img> que pidió la miniatura: cambia al original. Si lo que
 * falló YA era el original, no hace nada (sin ciclo). Se compara contra el
 * src actual y no con una marca en el elemento: una marca sobrevivía cuando
 * React reutilizaba el mismo <img> para otra foto, y la siguiente foto sin
 * miniatura se quedaba rota.
 * La comparación va contra el atributo tal cual y contra la URL resuelta
 * (app pasmada sin señal, 24-sep-2026): `img.src` regresa la URL ya
 * normalizada ('foto 1.jpg' → 'foto%201.jpg', acentos, espacios al final),
 * así que con una URL heredada así nunca coincidía, cada error volvía a
 * asignar el original y, sin señal (falla al instante), el onError giraba
 * sin fin en cada tarjeta.
 */
export function alFallarMiniatura(original: string) {
  return (e: { currentTarget: HTMLImageElement }) => {
    const img = e.currentTarget;
    if (!original || img.getAttribute('src') === original) return;
    let resuelta = original;
    try {
      resuelta = new URL(original, document.baseURI).href;
    } catch {
      /* URL que no se deja resolver: se compara tal cual */
    }
    if (img.src === resuelta || img.src === original) return;
    img.src = original;
  };
}

/**
 * ¿La URL (o ruta) es de un video? Por la extensión: las evidencias y los
 * adjuntos conservan la del archivo original (.mp4, .mov del iPhone…).
 */
export function esUrlVideo(url: string | null | undefined): boolean {
  return /\.(mp4|mov|m4v|3gp|3g2|webm|mkv|avi|qt|ogv)(?:[?#]|$)/i.test(url || '');
}

/** Dibuja una imagen o un cuadro de video a ≤640px y lo entrega en JPEG. */
async function aMiniaturaJpeg(
  fuente: CanvasImageSource,
  w: number,
  h: number
): Promise<Blob | null> {
  if (!w || !h) return null;
  const esc = Math.min(1, LADO_MINI / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * esc));
  canvas.height = Math.max(1, Math.round(h * esc));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(fuente, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob | null>((res) =>
    canvas.toBlob(res, 'image/jpeg', 0.72)
  );
}

/** Espera un evento del elemento, o rechaza por error o tope. */
function esperarEvento(el: HTMLMediaElement, evento: string, topeMs: number): Promise<void> {
  return new Promise((res, rej) => {
    const listo = () => {
      limpiar();
      res();
    };
    const fallo = () => {
      limpiar();
      rej(new Error('video no decodificable'));
    };
    const reloj = setTimeout(() => {
      limpiar();
      rej(new Error('tope'));
    }, topeMs);
    function limpiar() {
      clearTimeout(reloj);
      el.removeEventListener(evento, listo);
      el.removeEventListener('error', fallo);
    }
    el.addEventListener(evento, listo, { once: true });
    el.addEventListener('error', fallo, { once: true });
  });
}

/**
 * Un cuadro del video como imagen (25-sep-2026): sin él, la tarjeta de una
 * incidencia reportada solo con video salía sin nada — parecía que no se
 * había adjuntado nada — y en el chat el video era un recuadro negro.
 * Se toma a medio segundo y no en el 0: el primer cuadro del celular suele
 * salir negro o desenfocado. Safari de iPhone a veces no decodifica sin
 * reproducir: se intenta un play silenciado y se pausa.
 */
async function cuadroDeVideo(file: Blob): Promise<Blob | null> {
  let url = '';
  const v = document.createElement('video');
  try {
    url = URL.createObjectURL(file);
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    v.preload = 'auto';
    v.src = url;
    v.load();
    await esperarEvento(v, 'loadedmetadata', 5000);
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const t = dur > 0 ? Math.min(0.5, dur / 2) : 0;
    if (t > 0) {
      v.currentTime = t;
      await esperarEvento(v, 'seeked', 4000).catch(() => {});
    }
    if (v.readyState < 2) {
      try {
        await v.play();
        v.pause();
      } catch {
        /* sin permiso de reproducir: se intenta con lo que haya */
      }
      if (v.readyState < 2) await esperarEvento(v, 'loadeddata', 3000);
    }
    return await aMiniaturaJpeg(v, v.videoWidth, v.videoHeight);
  } catch {
    return null;
  } finally {
    try {
      v.removeAttribute('src');
      v.load();
    } catch {
      /* ya liberado */
    }
    if (url) URL.revokeObjectURL(url);
  }
}

/** Genera la miniatura JPEG de una imagen o de un video, o null si no se pudo. */
async function generarMiniatura(file: File | Blob): Promise<Blob | null> {
  if (file.type.startsWith('video/')) return cuadroDeVideo(file);
  if (!file.type.startsWith('image/')) return null;
  let url = '';
  try {
    url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('no decodificable'));
      img.src = url;
    });
    return await aMiniaturaJpeg(img, img.naturalWidth, img.naturalHeight);
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

/** Tope de espera de la miniatura: con mala señal no retrasa el guardado. */
const ESPERA_MAX_MINI_MS = 8000;

/**
 * Sube la miniatura de una FOTO o un VIDEO ya subido en `path` (de un video,
 * un cuadro suyo: misma ruta mini/…jpg). Es de mejor esfuerzo: si falla, no
 * se avisa ni se reintenta — la foto cae sola al original y el video a su
 * recuadro "🎬 Video". Nunca debe bloquear ni tumbar el guardado de la
 * evidencia: se espera como máximo ESPERA_MAX_MINI_MS y el flujo sigue (la
 * subida, si va lenta, termina sola en segundo plano).
 */
export async function subirMiniatura(path: string, file: File | Blob): Promise<void> {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return;
  const trabajo = (async () => {
    try {
      const blob = await generarMiniatura(file);
      if (!blob) return;
      await sb.storage.from(BUCKET_EVIDENCIAS).upload(rutaMiniatura(path), blob, {
        upsert: false,
        contentType: 'image/jpeg',
        cacheControl: CACHE_INMUTABLE,
      });
    } catch {
      /* mejor esfuerzo: sin miniatura se usa el original */
    }
  })();
  await Promise.race([
    trabajo,
    new Promise<void>((res) => setTimeout(res, ESPERA_MAX_MINI_MS)),
  ]);
}

/** Foto seleccionada en el navegador, aún no subida. */
export type FotoLocal = {
  file: File;
  /** objectURL para la miniatura. Liberar con revocarPreviews(). */
  preview: string;
};

/** Convierte los File de un <input type="file"> en FotoLocal[]. */
export function aFotosLocales(files: FileList | File[] | null): FotoLocal[] {
  return Array.from(files || []).map((f) => ({
    file: f,
    preview: URL.createObjectURL(f),
  }));
}

/** Libera los objectURL para no fugar memoria al cerrar un modal. */
export function revocarPreviews(fotos: FotoLocal[]): void {
  fotos.forEach((f) => {
    try {
      URL.revokeObjectURL(f.preview);
    } catch {
      /* el navegador ya lo liberó */
    }
  });
}

/** Error de subida con el índice de la foto que falló, para mensajes claros. */
export class ErrorSubida extends Error {
  indice: number;
  constructor(mensaje: string, indice: number) {
    super(mensaje);
    this.name = 'ErrorSubida';
    this.indice = indice;
  }
}

/**
 * Sube fotos al bucket de evidencias y devuelve sus URLs públicas.
 *
 * @param fotos    fotos locales a subir
 * @param carpeta  subcarpeta dentro del bucket (ej. 'incidencias', 'fijacion-externa')
 * @param clave    identificador del registro, va en el nombre del archivo
 * @param onAvance callback opcional de progreso (subidas, total) para la UI
 *
 * @throws {ErrorSubida} si alguna foto falla; las anteriores YA quedaron subidas
 *   (huérfanas en Storage). Es aceptable: no rompe datos, solo deja basura.
 */
export async function subirFotos(
  fotos: FotoLocal[],
  carpeta: string,
  clave: string,
  onAvance?: (subidas: number, total: number) => void
): Promise<string[]> {
  const urls: string[] = [];
  // Un solo timestamp por lote: agrupa las fotos de la misma acción.
  const sello = Date.now();
  // Nombre seguro: Storage rechaza varios caracteres en las rutas.
  const claveSegura = String(clave || 'sin-clave').replace(/[^a-zA-Z0-9_-]/g, '_');

  for (let i = 0; i < fotos.length; i++) {
    const f = fotos[i].file;
    const ext = (f.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${carpeta}/${claveSegura}_${sello}_${i}.${ext}`;

    const { error } = await sb.storage
      .from(BUCKET_EVIDENCIAS)
      .upload(path, f, { upsert: false, cacheControl: CACHE_INMUTABLE });
    if (error) throw new ErrorSubida(error.message, i);

    const { data: pub } = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path);
    urls.push(pub.publicUrl);
    onAvance?.(i + 1, fotos.length);
  }
  return urls;
}
