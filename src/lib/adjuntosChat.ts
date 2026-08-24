// ============================================================
// src/lib/adjuntosChat.ts
// Validación y subida de los adjuntos del chat.
//
// Los límites viven aquí y no dentro del componente porque son una REGLA DEL
// SISTEMA, no un detalle de una pantalla: los archivos del chat son
// temporales —se borran al cerrar la incidencia— y su razón de ser es mostrar
// rápido qué está pasando en campo, no documentar formalmente. Para eso está
// el botón 📎 Evidencia, que no caduca.
// ============================================================
import { sb } from './supabase';
import { BUCKET_EVIDENCIAS } from './storage';

/** Foto: 5 MB. Una foto de celular ronda 2-4 MB. */
export const MAX_FOTO_BYTES = 5 * 1024 * 1024;
/** Video: 10 MB y 15 segundos. */
export const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_SEG = 15;

export type TipoAdjunto = 'foto' | 'video';

export type AdjuntoSubido = {
  tipo: TipoAdjunto;
  url: string;
  path: string;
  nombre: string;
  bytes: number;
};

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

/**
 * Mide cuánto dura un video SIN subirlo.
 *
 * El navegador no expone la duración hasta que lee los metadatos, así que hay
 * que cargarlo en un <video> temporal. Vale la pena: rechazar un video de 2
 * minutos ANTES de subirlo le ahorra al técnico esperar una subida larga por
 * datos móviles para luego recibir un error.
 *
 * Si el navegador no puede leerlo, devuelve null y se deja pasar: más vale un
 * archivo de más que bloquear a alguien en campo por un códec raro.
 */
function duracionVideo(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    // Red de seguridad: si el navegador nunca responde, no dejamos el chat
    // colgado esperando para siempre.
    const t = setTimeout(() => {
      URL.revokeObjectURL(url);
      resolve(null);
    }, 8000);
    v.onloadedmetadata = () => {
      clearTimeout(t);
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v.duration) ? v.duration : null);
    };
    v.onerror = () => {
      clearTimeout(t);
      URL.revokeObjectURL(url);
      resolve(null);
    };
    v.src = url;
  });
}

/** Devuelve un mensaje de error, o '' si el archivo es aceptable. */
export async function validarAdjunto(file: File): Promise<string> {
  const esVideo = file.type.startsWith('video');
  const esFoto = file.type.startsWith('image');

  if (!esVideo && !esFoto) return 'Solo se permiten fotos y videos.';

  if (esFoto && file.size > MAX_FOTO_BYTES) {
    return `La foto pesa ${mb(file.size)} MB y el máximo son ${mb(MAX_FOTO_BYTES)} MB.`;
  }

  if (esVideo) {
    if (file.size > MAX_VIDEO_BYTES) {
      return `El video pesa ${mb(file.size)} MB y el máximo son ${mb(MAX_VIDEO_BYTES)} MB. Graba uno más corto.`;
    }
    const seg = await duracionVideo(file);
    if (seg !== null && seg > MAX_VIDEO_SEG + 1) {
      return `El video dura ${Math.round(seg)} s y el máximo son ${MAX_VIDEO_SEG} s. Graba uno más corto.`;
    }
  }

  return '';
}

/**
 * Sube el archivo y devuelve sus datos, o lanza con un mensaje legible.
 *
 * La ruta lleva el prefijo `chat/` a propósito: deja ver de un vistazo, desde
 * el propio Storage, qué archivos son temporales y cuáles son evidencia
 * formal. Si algún día hay que hacer una limpieza manual, la diferencia se ve
 * sin consultar la base.
 */
export async function subirAdjunto(
  file: File,
  recordId: string
): Promise<AdjuntoSubido> {
  const tipo: TipoAdjunto = file.type.startsWith('video') ? 'video' : 'foto';
  const ext = (file.name.split('.').pop() || (tipo === 'video' ? 'mp4' : 'jpg'))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const path = `chat/${recordId}/${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 7)}.${ext}`;

  const { error } = await sb.storage
    .from(BUCKET_EVIDENCIAS)
    .upload(path, file, { upsert: false });
  if (error) throw new Error('No se pudo subir el archivo: ' + error.message);

  const { data } = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path);

  return {
    tipo,
    url: data.publicUrl,
    path,
    nombre: file.name,
    bytes: file.size,
  };
}
