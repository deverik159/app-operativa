// ============================================================
// src/lib/portapapeles.ts
// Pegar una imagen del portapapeles (Erik, 18-nov-2026): lo que se recorta
// con Win + Shift + S (o se copia de otra página) entra como foto, igual que
// si se hubiera elegido con 📎. Lo usa el chat de Incidencias; la bandeja de
// Reportes App Biobox tiene su propia versión desde el 10-nov-2026.
//
// Dos caminos:
//  · Ctrl+V: el evento `paste` trae el archivo. Funciona en cualquier
//    navegador y no pide permiso.
//  · Botón «Pegar imagen»: lee el portapapeles con navigator.clipboard.read().
//    Solo se ofrece en computadora (mouse): en el celular el recorte se guarda
//    en la galería y se elige con 📎, y la lectura del portapapeles depende del
//    sistema (iOS pide permiso cada vez; algunos Android no la tienen).
// ============================================================

/** Nombre del archivo pegado: «recorte-HHMMSS.<ext>». */
export function nombreRecorte(tipo: string, ahora: Date = new Date()): string {
  const ext = ((tipo.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png').replace('jpeg', 'jpg');
  const dd = (n: number) => String(n).padStart(2, '0');
  return `recorte-${dd(ahora.getHours())}${dd(ahora.getMinutes())}${dd(ahora.getSeconds())}.${ext}`;
}

/** Un Blob de imagen como File con nombre de recorte (los pegados no traen uno útil). */
export function archivoDeRecorte(b: Blob, ahora?: Date): File {
  return new File([b], nombreRecorte(b.type || 'image/png', ahora), { type: b.type || 'image/png' });
}

/**
 * La imagen que trae un evento de pegar, o null si lo pegado no es imagen
 * (texto: se deja pasar el pegado normal).
 */
export function imagenDePegado(datos: Pick<DataTransfer, 'items'> | null | undefined): File | null {
  const items = Array.from(datos?.items || []);
  const item = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  const b = item?.getAsFile();
  return b ? archivoDeRecorte(b) : null;
}

/** ¿Se ofrece el botón «Pegar imagen»? Solo en computadora y si el navegador lee imágenes. */
export function puedePegarConBoton(
  nav: { clipboard?: { read?: unknown } } | undefined = typeof navigator === 'undefined' ? undefined : navigator,
  conMouse: boolean = typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
): boolean {
  return conMouse && typeof nav?.clipboard?.read === 'function';
}

export type LecturaPortapapeles = { file: File } | { aviso: string };

/** Lee una imagen del portapapeles (botón). Nunca lanza: o trae el archivo o un aviso para el usuario. */
export async function leerImagenDelPortapapeles(): Promise<LecturaPortapapeles> {
  if (!navigator.clipboard?.read) return { aviso: 'Este navegador no deja leer el portapapeles con el botón: usa Ctrl+V en la caja del mensaje.' };
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const tipo = it.types.find((t) => t.startsWith('image/'));
      if (tipo) return { file: archivoDeRecorte(await it.getType(tipo)) };
    }
    return { aviso: 'No hay una imagen copiada. Recórtala con Win + Shift + S y vuelve a tocar «Pegar imagen».' };
  } catch {
    return { aviso: 'El navegador no dejó leer el portapapeles: usa Ctrl+V en la caja del mensaje.' };
  }
}
