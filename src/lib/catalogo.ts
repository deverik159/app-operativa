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
import { sinAcentos } from './helpers';

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
  /** true = la lista salió del árbol de Digital, no de catalogo_incidencias. */
  desdeArbol?: boolean;
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
 * Catálogo para caras DIGITALES: el árbol de Digital MÁS las entradas
 * Digital de `catalogo_incidencias`.
 *
 * El árbol es el catálogo que SRD mantiene para el medio digital, y es el
 * mismo con el que el técnico clasifica al reparar (RepararModal filtra por
 * `arbol_digital.incidencia == incidencias.nombre_incidencia`). Capturar
 * desde él garantiza que el reporte llegue al técnico con su clasificación
 * guiada (Erik, 10-sep-2026).
 *
 * PERO el árbol no cubre todo lo capturable. Una máquina digital también
 * sufre fallas que NO son del área Digital: en Biobox el Teltonika (TI),
 * el sensor de mano (Op. Bio Box)… viven solo en catalogo_incidencias y
 * el árbol las tapaba (Erik, 23-sep-2026 — sus altas nuevas de TI no
 * aparecían). Por eso la lista es la UNIÓN:
 *
 *   1. Los nombres del árbol (su texto exacto es la llave de la reparación
 *      guiada), con nivel/origen/tipo heredados de la fila Digital del
 *      catálogo cuando el mismo nombre existe ahí.
 *   2. MÁS el catálogo normal del mueble — TODAS las áreas, restringido al
 *      mueble y la unidad como siempre (`cat` ya llega acotado a la unidad:
 *      NuevaInc lo pide con .ilike('unidad_negocio', un)) — quitando los
 *      nombres que el árbol ya trae, para no duplicar.
 *
 * Si un nombre existe en el árbol Y en el catálogo con otra área, gana el
 * árbol (la reparación guiada manda). Lo capturado de los extras se repara
 * sin guía, igual que antes de existir el árbol.
 *
 * Y EL ÁRBOL TAMBIÉN SE ACOTA A LA UNIDAD (Erik, 23-sep-2026): el árbol es
 * global y sin columna de unidad, así que "Falla en el proceso de
 * reciclaje" (Biobox) salía en Ecovallas. Quién decide es el catálogo: un
 * nombre del árbol se ofrece si el catálogo de ESTA unidad lo conoce (en
 * cualquier área), o si no está en el catálogo de NINGUNA unidad — esos
 * son nombres que SRD mantiene solo en el árbol y no hay forma de
 * atribuirlos, mejor ofrecerlos que perder la captura guiada. Se calla
 * únicamente el nombre que otra unidad reclama y esta no.
 */
export function catalogoDesdeArbol(
  nombresArbol: string[],
  cat: CatalogoIncidencia[],
  muebles: (string | null | undefined)[],
  /** El catálogo de TODAS las unidades; sin él no se acota el árbol. */
  catTodas?: CatalogoIncidencia[]
): OpcionesCatalogo {
  const r = catalogoParaMuebles(cat, muebles);
  const esDigital = (c: CatalogoIncidencia) =>
    (c.area || '').trim().toLowerCase() === 'digital';
  // Para heredar datos a los nombres del árbol: primero la fila Digital del
  // mueble; si no, la Digital de cualquier mueble de la unidad.
  const delMueble = r.opciones.filter(esDigital);
  const deTodo = cat.filter(esDigital);

  const claveNombre = (d: string) => sinAcentos(d).trim().toLowerCase();
  const enUnidad = new Set(
    cat.filter((c) => c.detalle).map((c) => claveNombre(c.detalle))
  );
  const enAlguna = new Set(
    (catTodas || cat).filter((c) => c.detalle).map((c) => claveNombre(c.detalle))
  );

  const nombres = [
    ...new Set(nombresArbol.map((n) => (n || '').trim()).filter(Boolean)),
  ].filter((n) => {
    const k = claveNombre(n);
    return enUnidad.has(k) || !enAlguna.has(k);
  });

  const delArbol = nombres.map((nombre) => {
    const fila =
      delMueble.find((c) => igual(c.detalle, nombre)) ||
      deTodo.find((c) => igual(c.detalle, nombre));
    // El detalle SIEMPRE es el del árbol, aunque el catálogo lo escriba con
    // otra mayúscula o acento: es la llave de la reparación guiada.
    return fila
      ? { ...fila, detalle: nombre }
      : ({
          detalle: nombre,
          area: 'Digital',
          impacto: null,
          origen: null,
          tipo: null,
          tipo_mueble: null,
        } as CatalogoIncidencia);
  });

  // El catálogo del mueble completo (todas las áreas), menos los nombres
  // que el árbol ya trae. Comparación sin acentos ni mayúsculas ("Lámpara"
  // vs "lampara"). r.opciones ya viene colapsado y restringido al mueble,
  // con su respaldo de siempre si el mueble no está en el catálogo.
  const yaEsta = new Set(delArbol.map((c) => claveNombre(c.detalle)));
  const extras = r.opciones.filter(
    (c) => c.detalle && !yaEsta.has(claveNombre(c.detalle))
  );

  const lista = [...delArbol, ...extras].sort(
    (a, b) =>
      a.detalle.localeCompare(b.detalle) ||
      (a.area || '').localeCompare(b.area || '')
  );

  // restringido/sinCatalogo se heredan de la parte del catálogo: si el
  // mueble no existe ahí, la pantalla debe seguir avisándolo.
  return {
    opciones: lista,
    restringido: r.restringido,
    sinCatalogo: r.sinCatalogo,
    desdeArbol: true,
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
  // sinAcentos en las dos puntas: el catálogo dice "Lámpara" y en el teclado
  // del celular se escribe "lampara" — sin normalizar, no se encontraba.
  const palabras = sinAcentos(texto).trim().split(/\s+/).filter(Boolean);
  if (!palabras.length) return cat;
  return cat.filter((c) => {
    const heno = sinAcentos(`${c.detalle} ${c.area || ''}`);
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
