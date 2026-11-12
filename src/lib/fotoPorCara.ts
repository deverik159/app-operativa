// ============================================================
// src/lib/fotoPorCara.ts
// Una foto por cara (Erik, 12-nov-2026).
//
// Una partida con varias caras genera un folio por cara. Antes cada foto se
// ligaba a TODOS esos folios: con 6 caras y 6 fotos, cada folio tenía las 6
// y su tarjeta enseñaba la misma (caso EV00001–EV00006, MX_CM_EV_3318).
// Regla: si la partida trae tantos archivos como caras, el primero va a la
// primera cara, el segundo a la segunda… en el orden en que se marcaron. Si
// no coinciden, cada archivo va a todas las caras, como siempre.
// ============================================================

/** ¿Esta partida reparte un archivo por cara? */
export function unaFotoPorCara(nCaras: number, nArchivos: number): boolean {
  return nCaras > 1 && nArchivos === nCaras;
}

/**
 * A qué filas (record_id) va un archivo del envío: las de `para` que sigan
 * en el grupo (una fila puede haberse omitido por duplicada) o, sin `para`
 * (envíos de antes o fotos para todas las caras), todas las del grupo.
 */
export function filasDelArchivo(
  g: { filas: { record_id: string }[] },
  a: { para?: string[] }
): string[] {
  const ids = g.filas.map((f) => f.record_id);
  if (!a.para) return ids;
  const vivos = new Set(ids);
  return a.para.filter((id) => vivos.has(id));
}
