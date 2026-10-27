// ============================================================
// src/lib/buscarSitiosComp.ts
// Buscar sitios del inventario para escogerlos uno por uno en el alta manual
// de Comprobaciones (26-oct-2026). PURA: sin red, sin React; la prueba
// tests/buscarSitiosComp.test.mjs.
//
// POR QUÉ. Erik, probando la vista previa (26-oct-2026): «Debería dejar poner
// el sitio uno por uno, me aparece agregar 50, pero no por sitio». Se atoró
// armando una campaña de Vía Verde Columna con 3 columnas sueltas: «Por
// modelo» y «Por ruta» solo agregan el grupo completo. Aquí se busca un
// sitio por lo que el analista tenga a la mano:
//   · la clave completa o la forma corta que entiende claveDeSitio («679»,
//     «POR_0008» en Vía Verde),
//   · el site_id, la dirección o el municipio,
// sin distinguir mayúsculas ni acentos; cada palabra tecleada debe aparecer.
// ORDEN: primero la clave exacta, luego las que empiezan con lo tecleado
// (la clave o un tramo de ella después de «_», o el site_id), luego el resto;
// dentro de cada grupo, compararNatural.
//
// La revisión de una clave suelta (EDO MEX de baja, Columna vs Pórtico) es
// la misma que usa «Pegar lista»: revisarClave sirve a las dos.
//
// Revisión del 26-oct-2026:
//   · Enter solo agrega lo que el analista tecleó completo. claveDeSitio
//     rellena con ceros: «MX_CM_BB_MED_011», camino a la 0114, se volvía
//     MED_0011 y Enter agregaba esa (o, si no existía, una clave fuera del
//     inventario que nadie vio). Ahora, si lo tecleado es el inicio de otra
//     clave del inventario, no es exacta ni se ofrece como suelta.
//   · En Pórtico, un número suelto («8») es un pórtico, no una columna: ya
//     no sale el aviso «es de Columna, no de Pórtico».
//   · EDO MEX de baja en Vía Verde: sitioDeBaja lo usan el índice y la
//     pantalla (grupos de «Por modelo» y «Por ruta»), una sola regla.
// ============================================================

import { claveDeSitio } from './bitacoraComp';
import { compararNatural, type MedioComp, type UnidadComp } from './comprobaciones';
import { FORMA_CLAVE, normTexto } from './importadorComp';

/** Lo que la búsqueda lee de una cara (CaraInventario lo cumple). */
export type SitioBuscable = {
  vendor_face_id: string;
  site_id: string | null;
  direccion: string | null;
  municipio: string | null;
};

/** Mayúsculas, sin acentos y con un solo espacio entre palabras: la misma normTexto del importador. */
export const normBusqueda = normTexto;

/**
 * ¿La cara está de baja para escogerla? En Vía Verde, las de EDO MEX
 * (MX_EM_VV_…): armarAlta las rechaza. Fuera de Vía Verde, MX_EM_ sí entra
 * (Ecovallas y Biobox del Edo. Méx. están activas).
 */
export function sitioDeBaja(clave: string, unidad: UnidadComp): boolean {
  return unidad === 'Vía Verde' && /^MX_EM_/i.test(clave.trim());
}

// ------------------------------------------------------------
// Revisar una clave tecleada o pegada
// ------------------------------------------------------------

export type RevisionClave =
  | { tipo: 'ok'; clave: string }
  | { tipo: 'ilegible' | 'edomex' | 'medio'; clave: null; aviso: string };

/**
 * ¿El texto es una clave que se puede escoger para este medio? Los avisos
 * son los de «Pegar lista» (23-oct-2026), con el texto tal como se tecleó.
 */
export function revisarClave(texto: string, unidad: UnidadComp, medio: MedioComp): RevisionClave {
  const k = claveDeSitio(texto, unidad);
  if (!k.clave) return { tipo: 'ilegible', clave: null, aviso: `«${texto}» no se entiende como clave` };
  if (k.edoMex && unidad === 'Vía Verde') return { tipo: 'edomex', clave: null, aviso: `${texto}: es de EDO MEX (de baja)` };
  if (k.medio && k.medio !== medio) return { tipo: 'medio', clave: null, aviso: `${texto}: es de ${k.medio}, no de ${medio}` };
  return { tipo: 'ok', clave: k.clave };
}

// Fuera de Vía Verde, claveDeSitio acepta cualquier palabra («REFORMA»); al
// buscar, solo se ofrece agregar una clave que no está en el inventario si
// tiene la forma de inventario.vendor_face_id (FORMA_CLAVE del importador),
// para no proponer una calle como clave.

// ------------------------------------------------------------
// Índice y búsqueda
// ------------------------------------------------------------

export type EntradaIndice<T extends SitioBuscable> = {
  cara: T;
  /** vendor_face_id en mayúsculas. */
  clave: string;
  /** '_' + clave: para encontrar «_679» o «_COL_6» como inicio de un tramo. */
  tramos: string;
  siteId: string;
  /** Clave, site_id, dirección y municipio normalizados, en un solo texto. */
  texto: string;
};

/**
 * Prepara las caras una vez (se memoiza en la pantalla: Vía Verde Columna
 * pasa de mil). En Vía Verde se dejan fuera las de EDO MEX, que están de
 * baja; si alguien teclea una, revisarClave lo avisa.
 */
export function indexarSitios<T extends SitioBuscable>(caras: T[], unidad: UnidadComp): EntradaIndice<T>[] {
  const out: EntradaIndice<T>[] = [];
  for (const c of caras) {
    const clave = normBusqueda(c.vendor_face_id);
    if (!clave) continue;
    if (sitioDeBaja(clave, unidad)) continue;
    const siteId = normBusqueda(c.site_id);
    out.push({
      cara: c,
      clave,
      tramos: '_' + clave,
      siteId,
      texto: [clave, siteId, normBusqueda(c.direccion), normBusqueda(c.municipio)].join(' '),
    });
  }
  return out;
}

export type ResultadoBusqueda<T extends SitioBuscable> = {
  /** Hasta `limite` caras, ya ordenadas. */
  sitios: T[];
  /** Cuántas coinciden en total (para «hay N más»). */
  total: number;
  /** La cara cuya clave es exactamente lo tecleado, completo (para agregarla con Enter). */
  exacta: T | null;
  /** Clave completa y válida que NO está en el inventario: se ofrece con su botón (Enter no la agrega). */
  suelta: string | null;
  /** Lo tecleado es una clave, pero de baja o de otro medio. */
  aviso: string | null;
};

export function buscarSitios<T extends SitioBuscable>(
  indice: EntradaIndice<T>[],
  consulta: string,
  op: { unidad: UnidadComp; medio: MedioComp; limite?: number }
): ResultadoBusqueda<T> {
  const nada: ResultadoBusqueda<T> = { sitios: [], total: 0, exacta: null, suelta: null, aviso: null };
  const q = normBusqueda(consulta);
  if (!q) return nada;
  const palabras = q.split(' ');
  const junta = q.replace(/ /g, '');
  // En Pórtico un número suelto es un pórtico («8» → POR_0008); claveDeSitio,
  // sin saber el medio, lo leería como columna y avisaría «es de Columna».
  const vvPortico = op.unidad === 'Vía Verde' && op.medio === 'Pórtico' && /^\d{1,4}$/.test(junta);
  const rev = revisarClave(vvPortico ? 'POR' + junta : consulta.trim(), op.unidad, op.medio);
  const leida = rev.tipo === 'ok' ? rev.clave.toUpperCase() : null;
  // ¿Lo tecleado ya es una clave completa? La forma corta de Vía Verde («679»,
  // «POR8») sí; una clave larga, si es igual a la leída o si, sin contar los
  // ceros que puso claveDeSitio, no es el inicio de otra clave del inventario:
  // «MX_CM_BB_MED_011» camino a la 0114 no es la MED_0011.
  const completa =
    leida != null &&
    (leida === junta ||
      (op.unidad === 'Vía Verde' && !/^M?X_/.test(junta)) ||
      !indice.some((e) => e.clave !== leida && e.clave.startsWith(junta)));
  const claveCorta = completa ? leida : null;

  const hallados: { e: EntradaIndice<T>; rango: number }[] = [];
  let exacta: EntradaIndice<T> | null = null;
  for (const e of indice) {
    const esExacta = e.clave === junta || e.clave === claveCorta;
    if (!esExacta && !(e.siteId && e.siteId === junta) && !palabras.every((p) => e.texto.includes(p))) continue;
    let rango = 2;
    if (esExacta || (e.siteId && e.siteId === junta)) rango = 0;
    else if (e.tramos.includes('_' + junta) || (e.siteId && e.siteId.startsWith(junta))) rango = 1;
    if (esExacta && !exacta) exacta = e;
    hallados.push({ e, rango });
  }
  hallados.sort((a, b) => a.rango - b.rango || compararNatural(a.e.clave, b.e.clave));

  let suelta: string | null = null;
  let aviso: string | null = null;
  if (claveCorta && !exacta && (op.unidad === 'Vía Verde' || FORMA_CLAVE.test(claveCorta))) suelta = claveCorta;
  // «no se entiende» no se avisa: lo tecleado puede ser una calle o un municipio.
  if (rev.tipo === 'edomex' || rev.tipo === 'medio') aviso = rev.aviso;

  const limite = op.limite ?? 50;
  return {
    sitios: hallados.slice(0, limite).map((h) => h.e.cara),
    total: hallados.length,
    exacta: exacta?.cara ?? null,
    suelta,
    aviso,
  };
}
