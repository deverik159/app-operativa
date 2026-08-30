// ============================================================
// src/lib/catalogo.ts
// Elige del catálogo la entrada que le corresponde a UNA máquina concreta.
//
// ══ LO QUE SE COMPROBÓ CONTRA LA BASE (26-ago-2026) ══
//
// `catalogo_incidencias` NO tiene columna `tipo_medio`. No hace falta: el
// medio ya viene dentro de `tipo_mueble`, y esa columna sí distingue.
//
//   "Adicional dañado"  → Ecovallas Digital = Digital
//                       → Ecovallas Fijas   = Mantenimiento
//   "Faldón dañado"     → Ecovallas Digital = Digital
//                       → Ecovallas Fijas   = Instalaciones
//                       → Columnas Verdes   = Verde Vertical
//
// Son 526 filas, 184 incidencias distintas, ninguna sin mueble y ninguna sin
// área. El catálogo está bien: lo que fallaba era cómo lo leíamos.
//
// ══ EL ERROR QUE ESTO CORRIGE ══
//
// `NuevaInc` colapsaba por `detalle` con un `Set` y conservaba LA PRIMERA fila
// que devolviera Postgres. Como cada incidencia existe repetida —una por
// mueble— el área con la que nacía el reporte dependía del orden del
// planificador. Por eso se capturó "Adicional dañado" en una cara IMPRESA y
// salió dirigida a Digital, cuando el catálogo dice Mantenimiento.
//
// ══ Y POR QUÉ NO BASTA CON "PREFERIR" ══
//
// El primer intento fue puntuar las copias y quedarse con la mejor. No
// alcanza, porque la llave de identidad es `detalle` + `area`: las dos copias
// de "Adicional dañado" tienen áreas distintas, así que las dos sobreviven al
// colapso y el desplegable las muestra igual. El capturista seguía teniendo
// que adivinar.
//
// LO CORRECTO ES RESTRINGIR, NO PREFERIR: si se sabe el mueble de la cara, el
// catálogo se recorta a las filas de ese mueble ANTES de colapsar. Dentro de
// un mueble cada incidencia aparece una sola vez, así que la lista queda
// limpia y el área ya viene decidida.
//
// Cuando no se puede restringir —mueble desconocido, o caras de muebles
// distintos en la misma partida— NO se adivina: se devuelve todo y se avisa.
// `restringido` es lo que la pantalla usa para saber si tiene que advertir.
// ============================================================
import type { CatalogoIncidencia } from '../types/db';

/** Llave de identidad de una entrada. Dos áreas = dos cosas distintas. */
export function llaveCatalogo(c: {
  detalle: string;
  area?: string | null;
}): string {
  return `${c.detalle}||${c.area || ''}`;
}

/** Compara texto sin importar mayúsculas ni espacios de sobra. */
function igual(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function ordenar(xs: CatalogoIncidencia[]): CatalogoIncidencia[] {
  return [...xs].sort(
    (a, b) =>
      (a.area || '').localeCompare(b.area || '') ||
      a.detalle.localeCompare(b.detalle)
  );
}

/** Colapsa por detalle+area conservando la primera de cada llave. */
function colapsar(xs: CatalogoIncidencia[]): CatalogoIncidencia[] {
  const m = new Map<string, CatalogoIncidencia>();
  xs.forEach((c) => {
    if (!c.detalle) return;
    const k = llaveCatalogo(c);
    if (!m.has(k)) m.set(k, c);
  });
  return ordenar([...m.values()]);
}

export type OpcionesCatalogo = {
  /** Lo que se le muestra a quien captura. */
  opciones: CatalogoIncidencia[];
  /** true = se pudo acotar al mueble y el área ya viene decidida. */
  restringido: boolean;
  /**
   * Muebles que se pidieron y no tienen NI UNA fila en el catálogo.
   *
   * Hoy `inventario` tiene el mueble "Otro" y el catálogo no lo conoce; del
   * otro lado, el catálogo tiene "Columnas Verdes" y el inventario no lo usa
   * (ahí dice "Columna"). En los dos casos la restricción no puede aplicarse
   * y quien captura tiene que elegir el área a ojo — que es justo lo que se
   * quería evitar. Se devuelve para poder decirlo en pantalla en vez de
   * dejar que se note por el resultado.
   */
  sinCatalogo: string[];
};

/**
 * Las opciones que le tocan a una máquina.
 *
 * @param muebles los `tipo_mueble` de las caras marcadas. Normalmente uno.
 *   Si vienen varios se restringe a la unión: cada incidencia puede aparecer
 *   una vez por mueble cuando su área cambia entre ellos, y eso es correcto —
 *   son trabajos distintos y conviene que se vean los dos.
 */
export function catalogoParaMuebles(
  cat: CatalogoIncidencia[],
  muebles: (string | null | undefined)[]
): OpcionesCatalogo {
  const pedidos = [...new Set(muebles.filter(Boolean) as string[])];
  if (!pedidos.length) {
    return { opciones: colapsar(cat), restringido: false, sinCatalogo: [] };
  }

  const sinCatalogo = pedidos.filter(
    (m) => !cat.some((c) => igual(c.tipo_mueble, m))
  );
  const filas = cat.filter((c) => pedidos.some((m) => igual(c.tipo_mueble, m)));

  // Si NINGUNO de los muebles existe en el catálogo, recortar dejaría la
  // lista vacía y no se podría capturar nada. Se devuelve todo y se avisa:
  // una lista completa con una advertencia es mejor que una lista vacía sin
  // explicación.
  if (!filas.length) {
    return { opciones: colapsar(cat), restringido: false, sinCatalogo };
  }

  return {
    opciones: colapsar(filas),
    // Solo cuenta como restringido si TODOS los muebles pedidos aportaron.
    // Si uno se quedó fuera, la lista está incompleta para ese y hay que
    // decirlo.
    restringido: sinCatalogo.length === 0,
    sinCatalogo,
  };
}

/**
 * Una fila por incidencia distinta, sin acotar por máquina.
 * Se conserva para `buscarEnCatalogo` y para cuando no hay mueble.
 */
export function catalogoUnico(
  cat: CatalogoIncidencia[]
): CatalogoIncidencia[] {
  return colapsar(cat);
}

/**
 * Filtra por texto libre para el buscador de los modales.
 *
 * Busca en el detalle Y en el área: con 184 incidencias, quien captura muchas
 * veces recuerda el área antes que la redacción exacta ("algo de faldón").
 * Cada palabra tiene que aparecer en alguna de las dos, no la frase completa:
 * así "faldón pintura" encuentra lo que se espera sin importar el orden.
 */
export function filtrarCatalogo(
  cat: CatalogoIncidencia[],
  texto: string
): CatalogoIncidencia[] {
  const palabras = texto.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!palabras.length) return cat;
  return cat.filter((c) => {
    const heno = `${c.detalle} ${c.area || ''}`.toLowerCase();
    return palabras.every((p) => heno.includes(p));
  });
}

/**
 * Busca la entrada que corresponde a un `detalle` guardado.
 *
 * `checklist_puntos.incidencia_sugerida` guarda solo el `detalle`, así que si
 * ese detalle existe en dos áreas la referencia es ambigua. Aquí se resuelve
 * de forma determinista —la primera por orden de área— y se avisa, en vez de
 * dejar que `Array.find` decida según cómo vino ordenada la consulta.
 */
export function buscarEnCatalogo(
  cat: CatalogoIncidencia[],
  detalle: string
): { entrada: CatalogoIncidencia | null; ambigua: boolean } {
  if (!detalle) return { entrada: null, ambigua: false };
  const coincidencias = colapsar(cat).filter((c) => c.detalle === detalle);
  return {
    entrada: coincidencias[0] || null,
    ambigua: coincidencias.length > 1,
  };
}
