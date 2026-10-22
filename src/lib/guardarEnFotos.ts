// ============================================================
// src/lib/guardarEnFotos.ts
// "Guardar en Fotos": abre la hoja de compartir del teléfono con las fotos y
// videos de una toma (fase 1 de comprobaciones, Erik, 22-oct-2026).
//
// POR QUÉ: lo que se toma con la cámara DESDE la app (<input capture>) no
// llega al carrete del iPhone — lo decide WebKit, no la app. Una página web
// tampoco puede escribir directo en Fotos. Lo único posible es la hoja de
// compartir (Web Share nivel 2), donde el usuario toca "Guardar N imágenes".
//
// Reglas de la plataforma que este módulo respeta (mapeo del 22-oct-2026):
//   · share() necesita el gesto del usuario y lo GASTA al empezar: se llama
//     dentro del clic, sin ningún await antes (los File ya deben estar en
//     memoria; nunca leer IndexedDB ni bajar una URL dentro del clic).
//   · Solo `{ files }`: con `text` o `title` iOS puede ignorar los archivos.
//   · canShare() no valida tipos ni tamaños (WebKit y Chrome): solo dice si
//     la función existe.
//   · iOS deduce el tipo por la EXTENSIÓN del nombre, y la cámara llama a
//     todas las fotos "image.jpg": se renombran únicas (si no, una pisa a
//     otra en la carpeta temporal de la hoja).
//   · Chrome en Android: máximo 10 archivos y 50 MiB por share, sin .mov ni
//     HEIC; por eso se reparte en grupos (lib/tomasPautaLogica).
//   · La promesa no dice qué eligió el usuario: la app nunca sabe si se
//     guardó. Se dice "se abrió", nunca "se guardó".
// ============================================================

/** Lo que pasó al tocar el botón, en palabras de la pantalla. */
export type ResultadoCompartir =
  /** Se abrió la hoja y el usuario eligió algo (no sabemos qué). */
  | 'abierta'
  /** Cerró la hoja sin elegir (o falló la lectura de archivos: no se distingue). */
  | 'cancelada'
  /** Sin gesto vigente o el navegador no aceptó esos archivos: tocar de nuevo. */
  | 'reintentar'
  /** Ya había una hoja abierta. */
  | 'ocupada'
  /** Este navegador no comparte archivos. */
  | 'no-disponible'
  | 'error';

type NavegadorConShare = Navigator & {
  share?: (d: ShareData) => Promise<void>;
  canShare?: (d: ShareData) => boolean;
};

/**
 * ¿Este navegador puede abrir la hoja de compartir con archivos? Se decide
 * por capacidad, no por plataforma: en una computadora suele dar false y el
 * botón no se muestra.
 */
export function puedeGuardarEnFotos(): boolean {
  try {
    const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as NavegadorConShare | undefined;
    if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
    if (typeof File === 'undefined') return false;
    return nav.canShare({ files: [new File([''], 'prueba.jpg', { type: 'image/jpeg' })] });
  } catch {
    return false;
  }
}

/** ¿Chrome de Android? (límite de 10 archivos y 50 MiB por share). */
export function esAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
}

/** Clasifica el rechazo de share() (ver la tabla del mapeo del 22-oct-2026). */
export function clasificarErrorCompartir(err: unknown): ResultadoCompartir {
  const nombre = (err as { name?: string } | null)?.name || '';
  if (nombre === 'AbortError') return 'cancelada';
  if (nombre === 'NotAllowedError') return 'reintentar';
  if (nombre === 'InvalidStateError') return 'ocupada';
  return 'error';
}

/**
 * Abre la hoja con estos archivos. LLAMAR DIRECTO DESDE EL CLIC, sin await
 * antes: la primera línea con efecto es share(). Los nombres ya deben ser
 * únicos y con extensión (ver nombreParaCompartir en lib/tomasPautaLogica).
 */
export function guardarEnFotos(files: File[]): Promise<ResultadoCompartir> {
  const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as NavegadorConShare | undefined;
  if (!files.length || !nav || typeof nav.share !== 'function') return Promise.resolve('no-disponible');
  let p: Promise<void>;
  try {
    p = nav.share({ files });
  } catch (err) {
    return Promise.resolve(clasificarErrorCompartir(err));
  }
  return p.then(
    () => 'abierta' as const,
    (err: unknown) => clasificarErrorCompartir(err)
  );
}
