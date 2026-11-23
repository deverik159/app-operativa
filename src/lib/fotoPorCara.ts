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

// ── Elegir la cara de cada foto (Erik, 23-nov-2026) ──
// Caso EV00038–EV00043 (MX_CM_EV_2468): 6 caras y 4 fotos; como no
// coincidían, cada foto se ligó a los 6 folios y todas las tarjetas
// enseñaban la misma. Ahora, con varias caras y un número de fotos distinto,
// quien captura dice a qué cara(s) va cada foto.

/** ¿Hay que elegir a qué cara va cada foto? */
export function pideCaraPorFoto(nCaras: number, nArchivos: number): boolean {
  return nCaras > 1 && nArchivos > 0 && nArchivos !== nCaras;
}

/**
 * Deja la elección alineada con las fotos y las caras: una entrada por foto
 * (las que faltan, vacías) y solo caras que sigan marcadas, en el orden de
 * `caras`.
 */
export function ajustarCarasDeFotos(
  asignacion: readonly (readonly string[])[] | undefined,
  nArchivos: number,
  caras: readonly string[]
): string[][] {
  return Array.from({ length: nArchivos }, (_, k) => {
    const elegidas = new Set(asignacion?.[k] || []);
    return caras.filter((c) => elegidas.has(c));
  });
}

/**
 * Qué falta para poder guardar la partida, o null si está completa: cada
 * foto con al menos una cara y cada cara con al menos una foto (cada folio
 * necesita su evidencia). `nombre` da el nombre legible de una cara.
 */
export function faltaCaraDeFoto(
  asignacion: readonly (readonly string[])[],
  caras: readonly string[],
  nombre: (cara: string) => string = (c) => c
): string | null {
  const sinCara = asignacion.map((a, k) => (a.length ? 0 : k + 1)).filter(Boolean);
  if (sinCara.length)
    return `Elige a qué cara va la foto ${sinCara.join(', ')}: toca la cara debajo de cada foto.`;
  const conFoto = new Set(asignacion.flat());
  const sinFoto = caras.filter((c) => !conFoto.has(c));
  if (sinFoto.length)
    return `${sinFoto.map(nombre).join(', ')} no tiene${sinFoto.length > 1 ? 'n' : ''} foto: asígnale al menos una.`;
  return null;
}

/** Los índices de fila (en el orden de `caras`) a los que va cada foto. */
export function indicesDeFotos(
  asignacion: readonly (readonly string[])[],
  caras: readonly string[]
): number[][] {
  return asignacion.map((a) =>
    a.map((c) => caras.indexOf(c)).filter((i) => i >= 0)
  );
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
