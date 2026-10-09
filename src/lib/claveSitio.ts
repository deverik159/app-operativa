// ============================================================
// src/lib/claveSitio.ts
// Cómo se NOMBRA un sitio en indicadores (Erik, 8-oct-2026).
//
// La clave completa es País_Plaza_Unidad_…: MX_CM_EV_3244. El país se
// repite en todas, la plaza (CM/EM) ya tiene su propia tarjeta y la unidad
// se sabe por el contexto, así que se quitan:
//   Ecovallas impreso  MX_CM_EV_3244      → EV_3244
//   Ecovallas pantalla (con nombre)       → Avenida Insurgentes Sur 1761
//   Biobox             (con nombre)       → ESCOBEDO 500
//                      (sin nombre)       → MED_0056
//   Vía Verde columna  MX_CM_VV_COL_551   → COL 551   (como en la Bitácora VV)
//   Vía Verde pórtico  MX_CM_VV_POR_0078  → POR 0078 · San Ángel Norte
// Lo que no siga ese patrón se devuelve tal cual: nunca se inventa una clave.
// ============================================================

/**
 * Nombre de los 4 pórticos, el mismo que usa la Bitácora VV (tabla
 * vv_espacios, sitio + nombre). Son fijos, como su sentido en
 * PORTICOS_LADO_FIJO (constants.ts); si se agrega uno, va en los dos.
 */
const NOMBRE_PORTICO: Record<string, string> = {
  '0008': 'San Antonio Norte',
  '0015': 'San Antonio Sur',
  '0078': 'San Ángel Norte',
  '0092': 'San Ángel Sur',
};

/** La clave sin país, plaza ni unidad (en Vía Verde, como en la Bitácora). */
export function claveSitioCorta(clave: string | null | undefined): string {
  const c = (clave || '').trim();
  const p = c.split('_');
  if (p.length < 4 || p[0].toUpperCase() !== 'MX') return c;
  const unidad = p[2].toUpperCase();
  if (unidad === 'VV') {
    const corta = p.slice(3).join(' ');
    const nombre = p[3].toUpperCase() === 'POR' ? NOMBRE_PORTICO[p[4] || ''] : undefined;
    return nombre ? `${corta} · ${nombre}` : corta;
  }
  if (unidad === 'BB') return p.slice(3).join('_');
  return p.slice(2).join('_');
}

/**
 * El nombre con que se reconoce el sitio: el de la máquina o la pantalla si
 * lo tiene (nombre_biobox), y si no, la clave corta. En Vía Verde manda la
 * clave corta (COL/POR), que es como se conocen ahí.
 */
export function nombreSitio(
  clave: string | null | undefined,
  nombre: string | null | undefined
): string {
  const corta = claveSitioCorta(clave);
  const n = (nombre || '').trim();
  if (!n || /^MX_[A-Z]{2}_VV_/i.test((clave || '').trim())) return corta;
  return n;
}

/** "México" en la columna plaza es el Estado de México: se dice completo. */
export function nombrePlaza(plaza: string | null | undefined): string | null {
  const p = (plaza || '').trim();
  if (!p) return null;
  return p.toLowerCase() === 'méxico' ? 'Estado de México' : p;
}
