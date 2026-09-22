// ============================================================
// src/lib/especToma.ts
// Cuántas fotos exige la especificación de toma de la pauta.
//
// `espec_toma` viene del Excel tal cual lo escribe el área de pauta y AÚN
// NO ESTÁ HOMOLOGADO (Erik, 21-sep-2026): el mismo concepto aparece con
// varias redacciones. Por eso esto es una tabla de REGLAS POR PATRÓN, no
// un catálogo exacto — agregar una redacción nueva es agregar una línea.
// La verificación de pauta_espec_toma.sql lista los textos distintos que
// hay cargados, para ir cubriéndolos.
//
// La regla de negocio:
//   · sin especificación (null/vacío)      → 3 fotos (el estándar)
//   · "TOMA CORTA, MEDIA Y LARGA"          → 9 fotos (3 distancias × 3)
//   · "TOMAS DE DÍA Y DE NOCHE"            → 6 fotos (2 momentos × 3)
//   · cualquier otro texto                 → 3 fotos, pero se pinta en
//     ámbar: es una espec sin homologar y el monitorista debe LEERLA.
//
// Se cuenta solo FOTOS: un video suma evidencia pero no sustituye las
// tomas que pide la especificación.
// ============================================================
import { sinAcentos } from './helpers';

export type ReglaToma = {
  /** Fotos mínimas para poder registrar la toma. */
  fotos: number;
  /** Color del recuadro de la especificación en el modal. */
  color: string;
  /** Qué pide, en palabras de la app (la espec cruda se muestra aparte). */
  resumen: string;
};

/** Reglas por patrón, en orden: gana la primera que empata. */
const REGLAS: { patron: RegExp; regla: ReglaToma }[] = [
  {
    // "TOMA CORTA, MEDIA Y LARGA" (con o sin comas/acentos).
    patron: /CORTA.*MEDIA.*LARGA/,
    regla: { fotos: 9, color: '#a78bfa', resumen: '3 distancias × 3 = 9 fotos' },
  },
  {
    // "... TOMAS DE DÍA Y DE NOCHE".
    patron: /DIA.*NOCHE/,
    regla: { fotos: 6, color: '#4f8cff', resumen: 'día y noche = 6 fotos' },
  },
  {
    // "TOMAS SIN OBSTRUCCIÓN" y las comprobaciones estándar.
    patron: /SIN OBSTRUCCION|COMPROBACION/,
    regla: { fotos: 3, color: '#22c55e', resumen: '3 fotos' },
  },
];

const ESTANDAR: ReglaToma = {
  fotos: 3,
  color: 'var(--muted)',
  resumen: 'estándar: 3 fotos',
};

/** Texto no vacío que ninguna regla reconoce: 3 fotos, pero en ámbar. */
const SIN_HOMOLOGAR: ReglaToma = {
  fotos: 3,
  color: '#f59e0b',
  resumen: 'espec sin homologar — léela; mínimo 3 fotos',
};

export function reglaEspecToma(espec: string | null | undefined): ReglaToma {
  const t = sinAcentos(espec).toUpperCase().trim();
  if (!t) return ESTANDAR;
  for (const r of REGLAS) if (r.patron.test(t)) return r.regla;
  return SIN_HOMOLOGAR;
}
