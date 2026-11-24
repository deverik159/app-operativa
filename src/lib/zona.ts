// ============================================================
// src/lib/zona.ts
// Metro y Foránea en Incidencias (Erik, 24-nov-2026).
//
// Metro = Ciudad de México (CM) y Estado de México (EM); Foránea = cualquier
// otra plaza. Solo en Ecovallas y Biobox: Vía Verde es solo CDMX y Biobox
// Perú ya es una unidad aparte, así que todo lo demás es Metro.
//
// La base guarda la zona en `incidencias.zona` (trigger inc_set_zona, con
// `zona_de_clave`). Esto es el MISMO criterio, para las filas que la app
// tiene guardadas de antes y aún no traen la columna.
//
// En `usuario_roles.zona` (validador y técnicos), null = las dos zonas.
// ============================================================

export type Zona = 'metro' | 'foranea';

export const ZONA_LABEL: Record<Zona, string> = {
  metro: 'Metro',
  foranea: 'Foránea',
};

const UNIDADES_CON_ZONA = ['ecovallas', 'biobox'];
const PLAZAS_METRO = ['ciudad de méxico', 'méxico', 'estado de méxico'];

const limpio = (s: string | null | undefined) => (s ?? '').trim();

/** ¿La unidad se separa por zona? Solo Ecovallas y Biobox. */
export function unidadConZona(unidad: string | null | undefined): boolean {
  return UNIDADES_CON_ZONA.includes(limpio(unidad).toLowerCase());
}

/** Espejo de public.zona_de_clave(unidad, clave, plaza). */
export function zonaDeClave(
  unidad: string | null | undefined,
  clave: string | null | undefined,
  plaza?: string | null
): Zona {
  if (!unidadConZona(unidad)) return 'metro';
  const codigo = (limpio(clave).split('_')[1] ?? '').toUpperCase();
  if (codigo) return codigo === 'CM' || codigo === 'EM' ? 'metro' : 'foranea';
  const p = limpio(plaza).toLowerCase();
  if (!p || PLAZAS_METRO.includes(p)) return 'metro';
  return 'foranea';
}

type IncZona = {
  zona?: string | null;
  unidad_negocio?: string | null;
  clave_medio?: string | null;
  plaza?: string | null;
};

/** La zona de una incidencia: la de la base y, si no viene, calculada. */
export function zonaDe(i: IncZona): Zona {
  if (i.zona === 'metro' || i.zona === 'foranea') return i.zona;
  return zonaDeClave(i.unidad_negocio, i.clave_medio, i.plaza);
}

/** ¿Un rol con esta zona (null = las dos) cubre la incidencia? */
export function zonaCubre(zonaRol: string | null | undefined, i: IncZona): boolean {
  return !zonaRol || zonaRol === zonaDe(i);
}
