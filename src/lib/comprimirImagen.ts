// ============================================================
// src/lib/comprimirImagen.ts
// Compresión de fotos ANTES de subirlas.
//
// El iPhone produce fotos de 5–12 MB (48 MP); subirlas tal cual por 4G
// tarda, gasta el plan de datos del personal de campo, y una revisión de
// Biobox con varias anomalías retiene decenas de MB en memoria — en iOS
// Safari eso termina en recarga de pestaña y se pierde lo contestado.
// Para evidencia de campo, 1600px por lado sobra.
//
// La compresión NUNCA revienta el flujo: si el archivo no se puede
// decodificar (formato raro, canvas sin memoria), se regresa el original y
// el límite de tamaño decide si pasa. Así una foto normal jamás se rechaza
// por un fallo del compresor.
// ============================================================

import { COMPRIMIR_VIDEO_DESDE, comprimirVideo, puedeComprimirVideo } from './comprimirVideo';

/** Tope del bucket de Supabase por defecto. Un video más grande ni se intenta. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/**
 * Qué hacer cuando un video pasa del tope (aun recomprimido, o en un
 * teléfono que no puede recomprimir): casi siempre es la cámara grabando en
 * 4K o a 60 fps (30 s en 4K ≈ 85 MB; en 1080p a 30 fps ≈ 30 MB). Lo usan las
 * evidencias y el chat (Erik, 3-nov-2026).
 */
export const CONSEJO_VIDEO_PESADO =
  'Seguramente tu cámara graba en 4K o a 60 fps. Cámbiala a 1080p a 30 fps ' +
  '(iPhone: Ajustes › Cámara › Grabar video; Android: ajustes de la cámara) ' +
  'y vuelve a grabarlo: 30 segundos así pesan unos 30 MB.';

/** Solo aplica a imágenes que NO se pudieron comprimir. */
export const MAX_IMG_BYTES = 20 * 1024 * 1024;

/** Lado mayor tras comprimir. */
const LADO_MAX = 1600;
const CALIDAD_JPEG = 0.8;

/** Por debajo de esto y sin necesidad de reescalar, no vale la pena tocarla. */
const YA_LIGERA = 600 * 1024;

/** " · faltan unos 2 min" / " · faltan unos 40 s" / "" si aún no se sabe. */
export function textoRestante(seg: number | null): string {
  if (seg == null || !isFinite(seg)) return '';
  if (seg >= 90) return ` · faltan unos ${Math.round(seg / 60)} min`;
  return ` · faltan unos ${Math.max(10, Math.round(seg / 10) * 10)} s`;
}

export function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * Reduce una imagen a ≤1600px por lado, JPEG 0.8. Devuelve el File original
 * si ya es ligera, si quedaría más pesada, o si algo falla.
 */
export async function comprimirImagen(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  let url = '';
  try {
    let fuente: ImageBitmap | HTMLImageElement | null = null;
    if (typeof createImageBitmap === 'function') {
      // Puede fallar con formatos que el navegador no decodifica (p. ej.
      // HEIC elegido desde el explorador de archivos): cae al <img>.
      //
      // imageOrientation explícito (25-sep-2026): Safari hasta 16.3 (iPhone
      // 6s/7/SE que se quedaron en iOS 15) medía la foto con la rotación del
      // EXIF pero la PINTABA sin ella, y las verticales se subían de lado.
      // Ese Safari no conoce 'from-image' y lanza TypeError: cae al <img>,
      // que sí aplica el EXIF. En los navegadores nuevos es el valor por
      // omisión y no cambia nada.
      try {
        fuente = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        fuente = null;
      }
    }
    if (!fuente) {
      url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('no decodificable'));
        img.src = url;
      });
      fuente = img;
    }

    const w = 'naturalWidth' in fuente ? fuente.naturalWidth : fuente.width;
    const h = 'naturalHeight' in fuente ? fuente.naturalHeight : fuente.height;
    const esc = Math.min(1, LADO_MAX / Math.max(w, h));
    if (esc === 1 && file.size <= YA_LIGERA) return file;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * esc));
    canvas.height = Math.max(1, Math.round(h * esc));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(fuente, 0, 0, canvas.width, canvas.height);
    if ('close' in fuente) fuente.close();

    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, 'image/jpeg', CALIDAD_JPEG)
    );
    if (!blob || blob.size >= file.size) return file;

    const nombre = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], nombre, {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

/**
 * Comprime imágenes y valida tamaños de una tanda de archivos.
 * Devuelve los que pasan y la lista de motivos de los rechazados,
 * ya redactados para enseñárselos al usuario.
 */
export async function prepararArchivos(
  files: File[],
  op: { onProgreso?: (texto: string) => void } = {}
): Promise<{ listos: File[]; rechazos: string[]; notas: string[] }> {
  const listos: File[] = [];
  const rechazos: string[] = [];
  /** Lo que se hizo con los videos, para enseñarlo (p. ej. "85 MB → 10 MB"). */
  const notas: string[] = [];
  for (const f of files) {
    if (f.type.startsWith('video/')) {
      // Un video pesado se recomprime en el teléfono antes de medirlo contra
      // el tope (3-nov-2026, ver comprimirVideo.ts). Si no se puede, sigue el
      // original y el tope decide, como antes.
      let v = f;
      if (f.size > COMPRIMIR_VIDEO_DESDE && puedeComprimirVideo()) {
        op.onProgreso?.('Comprimiendo video…');
        const t0 = Date.now();
        const r = await comprimirVideo(f, {
          originalCabe: f.size <= MAX_VIDEO_BYTES,
          onProgreso: (p, restante) =>
            op.onProgreso?.(`Comprimiendo video… ${Math.round(p * 100)} %${textoRestante(restante)}`),
        });
        v = r.file;
        console.info(`[video] ${f.name}: ${mb(f.size)} → ${mb(v.size)}`, r.comprimido ? '' : `(original: ${r.motivo})`);
        if (r.comprimido) {
          const seg = (Date.now() - t0) / 1000;
          const tardo = seg >= 90 ? `${Math.round(seg / 60)} min` : `${Math.round(seg)} s`;
          notas.push(`Video comprimido: ${mb(f.size)} → ${mb(v.size)} en ${tardo}${r.sinAudio ? ' (sin audio)' : ''}`);
        }
      }
      if (v.size > MAX_VIDEO_BYTES) {
        rechazos.push(
          `${f.name}: el video pesa ${mb(v.size)} y el máximo es ${mb(MAX_VIDEO_BYTES)}. ${CONSEJO_VIDEO_PESADO}`
        );
        continue;
      }
      listos.push(v);
    } else if (f.type.startsWith('image/')) {
      const c = await comprimirImagen(f);
      if (c.size > MAX_IMG_BYTES) {
        rechazos.push(
          `${f.name}: la imagen pesa ${mb(c.size)} y no se pudo comprimir (máximo ${mb(MAX_IMG_BYTES)}).`
        );
        continue;
      }
      listos.push(c);
    } else {
      listos.push(f);
    }
  }
  return { listos, rechazos, notas };
}
