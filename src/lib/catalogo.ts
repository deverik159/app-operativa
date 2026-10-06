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
import { ELEMENTOS_SIN_CARA, UNIDADES_BIOBOX } from './constants';
import type { ElementoSinCara } from './constants';
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
  /** true = Biobox: árbol de Digital + catálogo de las demás áreas. */
  biobox?: boolean;
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
 * Catálogo para caras DIGITALES: la lista sale del árbol de Digital
 * (`arbol_digital.incidencia`), no de `catalogo_incidencias`.
 *
 * El árbol es el catálogo que SRD mantiene para el medio digital, y es el
 * mismo con el que el técnico clasifica al reparar (RepararModal filtra por
 * `arbol_digital.incidencia == incidencias.nombre_incidencia`). Capturar
 * desde él garantiza que TODO reporte digital llegue al técnico con su
 * clasificación guiada, en vez de caer a "Sin clasificar" cuando el nombre
 * del catálogo tradicional no empata con el árbol (Erik, 10-sep-2026).
 *
 * Toda captura del árbol nace con área Digital — el árbol ES de Digital.
 * El nivel/origen/tipo se heredan de la fila Digital de catalogo_incidencias
 * cuando el mismo nombre existe ahí (restringida al mueble primero); si no
 * existe, van vacíos y el `detalle` conserva EXACTO el texto del árbol, que
 * es lo que amarra la reparación guiada.
 *
 * NO unir con catalogo_incidencias. Se intentó (sep-2026: árbol + catálogo
 * del mueble, todas las áreas, acotado por unidad) y se revirtió: el árbol
 * SÍ abarca todo lo capturable en el medio digital — SRD lo mantiene justo
 * para eso — y la unión solo metía ruido de otras áreas (MKT,
 * Implementaciones, Comprobaciones…) (Erik, 23-sep-2026). La única
 * excepción es Biobox, donde la máquina es un solo mueble para las dos
 * caras: ver catalogoBiobox (Erik, 27-sep-2026).
 */
export function catalogoDesdeArbol(
  nombresArbol: string[],
  cat: CatalogoIncidencia[],
  muebles: (string | null | undefined)[]
): OpcionesCatalogo {
  const { opciones } = catalogoParaMuebles(cat, muebles);
  const esDigital = (c: CatalogoIncidencia) =>
    (c.area || '').trim().toLowerCase() === 'digital';
  const delMueble = opciones.filter(esDigital);
  const deTodo = cat.filter(esDigital);

  const nombres = [
    ...new Set(nombresArbol.map((n) => (n || '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));

  const lista = nombres.map((nombre) => {
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

  return { opciones: lista, restringido: true, sinCatalogo: [], desdeArbol: true };
}

/** ¿La unidad es de máquinas Biobox (México o Perú)? */
export function esUnidadBiobox(un?: string | null): boolean {
  const u = (un || '').trim().toLowerCase();
  return !!u && UNIDADES_BIOBOX.some((x) => x.toLowerCase() === u);
}

/** Llave de NOMBRE: sin acentos, mayúsculas ni espacios de sobra. */
function llaveNombre(d?: string | null): string {
  return sinAcentos(d).trim().replace(/\s+/g, ' ');
}

/**
 * Catálogo de Biobox: el árbol de Digital MÁS el catálogo de la máquina sin
 * sus filas de Digital (Erik, 27-sep-2026).
 *
 * En Biobox la máquina es UN solo mueble con cara digital e impresa, y una
 * falla le puede pegar a cualquiera de las dos. Por eso la lista es la misma
 * sin importar qué cara se marque — antes cambiaba al marcar la digital
 * (solo árbol) o la impresa (solo catálogo). Es la excepción consciente a
 * la regla de catalogoDesdeArbol: fuera de Biobox, la cara digital sigue
 * siendo solo árbol.
 *
 * Reglas, para que cada falla salga UNA vez:
 *   1. El catálogo se acota al mueble de la máquina, como siempre.
 *   2. Sus filas de Digital NO salen: el árbol las sustituye. Solo prestan
 *      su nivel/origen/tipo al nombre del árbol que empata.
 *   3. Si un nombre del árbol está en el catálogo de la máquina con OTRA
 *      área y no con Digital (sin importar acentos ni mayúsculas), sale una
 *      sola vez y tal como lo tiene el catálogo — su área y su texto: el
 *      catálogo decide a quién le toca, y es el mismo `detalle` con el que
 *      la revisión de Biobox la levanta, así la regla de duplicados
 *      (nombre exacto) las empata.
 *   4. Lo demás del catálogo (Op. Bio Box, TI…) sale tal cual, una vez por
 *      incidencia+área.
 *
 * Si el árbol no cargó, se devuelve el catálogo completo del mueble (con
 * Digital): peor lista que ninguna lista.
 */
export function catalogoBiobox(
  nombresArbol: string[],
  cat: CatalogoIncidencia[],
  muebles: (string | null | undefined)[]
): OpcionesCatalogo {
  const r = catalogoParaMuebles(cat, muebles);
  const nombres = [
    ...new Set(nombresArbol.map((n) => (n || '').trim()).filter(Boolean)),
  ];
  if (!nombres.length) return r;

  const esDigital = (c: CatalogoIncidencia) =>
    (c.area || '').trim().toLowerCase() === 'digital';
  const digitales = r.opciones.filter(esDigital);
  const digitalesUnidad = cat.filter(esDigital);
  const otras = r.opciones.filter((c) => !esDigital(c));

  const otrasPorNombre = new Map<string, CatalogoIncidencia[]>();
  otras.forEach((c) => {
    const k = llaveNombre(c.detalle);
    otrasPorNombre.set(k, [...(otrasPorNombre.get(k) || []), c]);
  });

  const lista: CatalogoIncidencia[] = [];
  nombres.forEach((nombre) => {
    const k = llaveNombre(nombre);
    const digital = digitales.find((c) => llaveNombre(c.detalle) === k);
    // Regla 3: la fila del catálogo sale abajo, con las demás.
    if (!digital && otrasPorNombre.has(k)) return;
    const fila =
      digital || digitalesUnidad.find((c) => llaveNombre(c.detalle) === k);
    lista.push(
      fila
        ? { ...fila, detalle: nombre }
        : ({
            detalle: nombre,
            area: 'Digital',
            impacto: null,
            origen: null,
            tipo: null,
            tipo_mueble: null,
          } as CatalogoIncidencia)
    );
  });
  lista.push(...otras);

  lista.sort(
    (a, b) =>
      a.detalle.localeCompare(b.detalle, 'es') ||
      (a.area || '').localeCompare(b.area || '', 'es')
  );
  // Sin catálogo cargado (sin señal y sin copia) no se acusa al mueble: la
  // pantalla ya dice que falta la copia, y la lista es el árbol.
  return {
    ...r,
    sinCatalogo: cat.length ? r.sinCatalogo : [],
    opciones: lista,
    biobox: true,
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

/**
 * ¿La incidencia es de una parte de la estructura y no de una cara? Por el
 * texto del catálogo, sin acentos ni mayúsculas: lo que diga "Adicional"
 * (p. ej. "Adicional dañado") es del Adicional, y lo que diga "Puerta"
 * ("Puertas / copetes abiertos") es de la Puerta (Erik, 6-oct-2026).
 */
export function elementoDeIncidencia(detalle?: string | null): ElementoSinCara | null {
  const d = sinAcentos(detalle);
  if (/\badicional/.test(d)) return 'Adicional';
  if (/\bpuerta/.test(d)) return 'Puerta';
  return null;
}

/**
 * Al reclasificar (corrección del validador, reasignación aprobada) el
 * `lado` sigue a la incidencia si entra o sale del Adicional o la Puerta:
 * sin esto quedaría "Adicional" como cara afectada de una falla de pantalla,
 * o una del adicional con Norte/Sur. Al salir queda null: la cara afectada
 * de una falla de cara no se puede adivinar. `undefined` = no cambia.
 */
export function ladoAlReclasificar(
  ladoActual: string | null | undefined,
  detalleNuevo: string | null | undefined
): ElementoSinCara | null | undefined {
  const antes = (ELEMENTOS_SIN_CARA as readonly string[]).includes(ladoActual || '')
    ? ladoActual
    : null;
  const nuevo = elementoDeIncidencia(detalleNuevo);
  return nuevo === antes ? undefined : nuevo;
}

/**
 * Medio y mueble de una incidencia del Adicional o de la Puerta en un sitio
 * de VARIAS caras, donde la fila no lleva cara de la cual copiarlos. Se
 * toman de las caras con que se armó el catálogo (las marcadas, o todas)
 * que son del mueble de la entrada elegida: en los 75 sitios mixtos de
 * Ecovallas la digital es "Ecovallas Digital" y la impresa "Ecovallas
 * Fijas", así que el mueble separa el "Adicional dañado" de Digital del de
 * Mantenimiento — y de él salen el folio (EVD/EV) y la regla de duplicados.
 * Si no hay un único valor, null: mejor vacío que inventado.
 */
export function ubicacionSinCara(
  mueble: string | null | undefined,
  base: { tipo_medio?: string | null; tipo_mueble?: string | null }[]
): { medio: string | null; tipo_mueble: string | null } {
  const delMueble = mueble ? base.filter((c) => igual(c.tipo_mueble, mueble)) : [];
  const fuente = delMueble.length ? delMueble : base;
  const unico = (xs: (string | null | undefined)[]) => {
    const u = [...new Set(xs.filter((x): x is string => !!x))];
    return u.length === 1 ? u[0] : null;
  };
  return {
    medio: unico(fuente.map((c) => c.tipo_medio)),
    tipo_mueble: unico(fuente.map((c) => c.tipo_mueble)),
  };
}
