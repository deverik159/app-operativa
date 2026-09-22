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
// La regla de negocio, HOMOLOGADA contra los textos reales de la pauta
// (Erik, 22-sep-2026):
//   · Pide tomas por DISTANCIA ("TOMA CORTA, MEDIA Y LARGA", "TOMA CORTA
//     Y MEDIA", con comas de más o el typo "CORA")        → 9 fotos
//   · Todo lo demás — comprobaciones del primer viernes (con o sin
//     "tomas de día y de noche"), "TOMAS SIN OBSTRUCCIÓN",
//     sin especificación                                   → 3 fotos
//   · Texto que ninguna regla reconoce                     → 3 fotos en
//     ámbar: el monitorista debe LEERLA.
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
    // Tomas por distancia = 9. Cubre las variantes reales del archivo:
    // "TOMA CORTA, MEDIA Y LARGA", "TOMA, CORTA, MEDIA Y LARGA" (comas de
    // más), "TOMA CORTA Y MEDIA", y el typo "TOMA CORA MEDIA Y LARGA".
    // Va PRIMERO: "…CORTA…, SIN OBSTRUCCIÓN" también es 9.
    patron: /CORTA|CORA\s+MEDIA/,
    regla: { fotos: 9, color: '#a78bfa', resumen: 'tomas por distancia: 9 fotos' },
  },
  {
    // Comprobaciones del primer viernes (con o sin día/noche) y
    // "TOMAS SIN OBSTRUCCIÓN": 3 fotos.
    patron: /SIN OBSTRUCCION|COMPROBACION|DIA.*NOCHE/,
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
