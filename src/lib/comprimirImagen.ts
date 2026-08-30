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

/** Tope del bucket de Supabase por defecto. Un video más grande ni se intenta. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/** Solo aplica a imágenes que NO se pudieron comprimir. */
export const MAX_IMG_BYTES = 20 * 1024 * 1024;

/** Lado mayor tras comprimir. */
const LADO_MAX = 1600;
const CALIDAD_JPEG = 0.8;

/** Por debajo de esto y sin necesidad de reescalar, no vale la pena tocarla. */
const YA_LIGERA = 600 * 1024;

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
      try {
        fuente = await createImageBitmap(file);
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
  files: File[]
): Promise<{ listos: File[]; rechazos: string[] }> {
  const listos: File[] = [];
  const rechazos: string[] = [];
  for (const f of files) {
    if (f.type.startsWith('video/')) {
      if (f.size > MAX_VIDEO_BYTES) {
        rechazos.push(
          `${f.name}: el video pesa ${mb(f.size)} y el máximo es ${mb(MAX_VIDEO_BYTES)}. Graba un clip más corto.`
        );
        continue;
      }
      listos.push(f);
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
  return { listos, rechazos };
}
