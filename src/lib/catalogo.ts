// ============================================================
// src/lib/catalogo.ts
// Colapsa el catálogo de incidencias para poder mostrarlo en una lista.
//
// EL PROBLEMA: `catalogo_incidencias` guarda la MISMA incidencia varias veces,
// una por cada tipo de medio o de mueble al que aplica. Eso está bien para la
// base —así cada combinación tiene su fila— pero al pintarlo en un `select`
// sale "Apagado (Iluminación)" cuatro veces seguidas y nadie sabe cuál elegir.
// De paso, usar `detalle` como `key` de React producía llaves repetidas.
//
// LA UNIDAD REAL ES `detalle` + `area`, no `detalle` solo. Dos entradas con el
// mismo detalle pero distinta área SÍ son cosas distintas —una la atiende
// Iluminación y la otra Op. Bio Box— y las dos tienen que poder elegirse. Por
// eso la llave lleva las dos, y la etiqueta ya muestra el área entre
// paréntesis para distinguirlas.
//
// CUÁL DE LAS COPIAS SE CONSERVA: si se sabe el tipo de mueble de la máquina,
// gana la fila de ese mueble; si no, la primera. Importa porque de esa fila
// salen el área, el impacto, el origen y el tipo con los que nace la
// incidencia.
// ============================================================
import type { CatalogoIncidencia } from '../types/db';

/** Llave de identidad de una entrada del catálogo. */
export function llaveCatalogo(c: {
  detalle: string;
  area?: string | null;
}): string {
  return `${c.detalle}||${c.area || ''}`;
}

/**
 * Una fila por incidencia distinta, ordenada por área y detalle.
 *
 * @param preferirMueble tipo de mueble de la máquina que se está revisando.
 *   Cuando se pasa, entre las copias gana la de ese mueble.
 */
export function catalogoUnico(
  cat: CatalogoIncidencia[],
  preferirMueble?: string | null
): CatalogoIncidencia[] {
  const porLlave = new Map<string, CatalogoIncidencia>();

  cat.forEach((c) => {
    if (!c.detalle) return;
    const k = llaveCatalogo(c);
    const previa = porLlave.get(k);
    if (!previa) {
      porLlave.set(k, c);
      return;
    }
    // Ya había una: solo se reemplaza si ésta es la del mueble de la máquina
    // y la anterior no lo era.
    if (
      preferirMueble &&
      c.tipo_mueble === preferirMueble &&
      previa.tipo_mueble !== preferirMueble
    ) {
      porLlave.set(k, c);
    }
  });

  return [...porLlave.values()].sort(
    (a, b) =>
      (a.area || '').localeCompare(b.area || '') ||
      a.detalle.localeCompare(b.detalle)
  );
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
  const coincidencias = catalogoUnico(cat).filter((c) => c.detalle === detalle);
  return {
    entrada: coincidencias[0] || null,
    ambigua: coincidencias.length > 1,
  };
}
