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
      .upload(path, f, { upsert: false });
    if (error) throw new ErrorSubida(error.message, i);

    const { data: pub } = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path);
    urls.push(pub.publicUrl);
    onAvance?.(i + 1, fotos.length);
  }
  return urls;
}
