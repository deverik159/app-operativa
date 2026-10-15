// ============================================================
// src/lib/equipos.ts
// Historial de equipos de Digital (Erik, 15-oct-2026).
//
// Cuando un técnico de Digital repara cambiando un equipo con número de
// serie, el cambio se guarda en `incidencias.cambio_equipo` (jsonb), junto
// con la reparación. Aquí vive lo que no depende de la pantalla: validar lo
// capturado y armar, con todos los cambios, la historia de cada pantalla y
// de cada equipo. Lo usan RepararModal (captura) y EquiposView (consulta).
//
// UNA SOLA FECHA por cambio: ese día sale un equipo y entra el otro. Cuánto
// duró un equipo se calcula con el cambio anterior del mismo tipo en la
// misma pantalla (cuando entró) y este (cuando salió).
// ============================================================

/** Un equipo en un cambio: lo que sale o lo que entra. */
export type EquipoCambio = {
  serie: string;
  inventario: string;
  obs: string;
};

/** Lo que se guarda en `incidencias.cambio_equipo`. */
export type CambioEquipo = {
  /** Tipo de equipo (NUC, Equipo de red…), copiado de arbol_digital.equipo. */
  tipo: string;
  /** 'AAAA-MM-DD': el día del cambio. */
  fecha: string;
  sale: EquipoCambio;
  entra: EquipoCambio;
};

/** Un cambio con la incidencia de donde salió (para la consulta). */
export type RegistroEquipo = {
  record_id: string;
  folio: string | null;
  unidad_negocio: string | null;
  clave_sitio: string | null;
  clave_medio: string | null;
  nombre_biobox: string | null;
  direccion: string | null;
  repaired_by_email: string | null;
  estatus: string;
  cambio: CambioEquipo;
};

/** Un cambio dentro de la historia de su pantalla, con lo que se calcula. */
export type CambioEnHistoria = RegistroEquipo & {
  /** Desde cuándo estaba el equipo que salió (el cambio anterior), si se sabe. */
  saleDesde: string | null;
  /** Días que duró el equipo que salió, si se sabe desde cuándo estaba. */
  diasQueDuro: number | null;
};

/** La historia de una pantalla: sus cambios y el equipo vigente por tipo. */
export type HistoriaPantalla = {
  /** La cara (o el sitio si no hay cara): de qué pantalla es la historia. */
  clave: string;
  clave_sitio: string | null;
  nombre: string | null;
  direccion: string | null;
  unidad_negocio: string | null;
  /** Del más reciente al más viejo. */
  cambios: CambioEnHistoria[];
  /** Tipo → el equipo que entró en el último cambio (el que está hoy). */
  vigentes: { tipo: string; serie: string; inventario: string; desde: string }[];
};

const vacio = (): EquipoCambio => ({ serie: '', inventario: '', obs: '' });

/** Un cambio en blanco para el tipo y la fecha dados. */
export function cambioVacio(tipo: string, fecha: string): CambioEquipo {
  return { tipo, fecha, sale: vacio(), entra: vacio() };
}

/** Lo capturado, limpio: sin espacios de sobra y la serie en mayúsculas. */
export function limpiarCambio(c: CambioEquipo): CambioEquipo {
  const eq = (e: EquipoCambio): EquipoCambio => ({
    serie: e.serie.trim().toUpperCase(),
    inventario: e.inventario.trim().toUpperCase(),
    obs: e.obs.trim(),
  });
  return { tipo: c.tipo.trim(), fecha: c.fecha, sale: eq(c.sale), entra: eq(c.entra) };
}

/**
 * Por qué no se puede guardar este cambio, o null si está completo. El No.
 * de serie de los dos equipos es obligatorio (Erik, 15-oct-2026); el
 * inventario y la observación, no.
 */
export function faltaEnCambio(c: CambioEquipo, hoy: string): string | null {
  const l = limpiarCambio(c);
  if (!l.sale.serie) return 'Escribe el No. de serie del equipo que sale.';
  if (!l.entra.serie) return 'Escribe el No. de serie del equipo que entra.';
  if (l.sale.serie === l.entra.serie)
    return 'El equipo que sale y el que entra tienen el mismo No. de serie.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(l.fecha)) return 'Elige la fecha del cambio.';
  if (l.fecha > hoy) return 'La fecha del cambio no puede ser futura.';
  return null;
}

/** ¿Es un cambio con la forma esperada? (lo que viene de la base es jsonb). */
export function esCambioEquipo(x: unknown): x is CambioEquipo {
  if (!x || typeof x !== 'object') return false;
  const c = x as Record<string, unknown>;
  const eq = (e: unknown) =>
    !!e && typeof e === 'object' && typeof (e as Record<string, unknown>).serie === 'string';
  return typeof c.tipo === 'string' && typeof c.fecha === 'string' && eq(c.sale) && eq(c.entra);
}

const DIA_MS = 24 * 3600 * 1000;
const diasEntre = (a: string, b: string) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DIA_MS);

/**
 * La historia de cada pantalla. Dentro de cada una y para cada tipo de
 * equipo, los cambios en orden de fecha: el equipo que sale en un cambio
 * estaba desde el cambio anterior del mismo tipo. Las pantallas van de la
 * que tuvo el cambio más reciente a la más vieja.
 */
export function historiaPorPantalla(registros: RegistroEquipo[]): HistoriaPantalla[] {
  const porPantalla = new Map<string, RegistroEquipo[]>();
  for (const r of registros) {
    const clave = r.clave_medio || r.clave_sitio || '(sin pantalla)';
    const l = porPantalla.get(clave);
    if (l) l.push(r);
    else porPantalla.set(clave, [r]);
  }
  const out: HistoriaPantalla[] = [];
  porPantalla.forEach((lista, clave) => {
    const asc = [...lista].sort(
      (a, b) => a.cambio.fecha.localeCompare(b.cambio.fecha) || (a.folio || '').localeCompare(b.folio || '')
    );
    const ultimoPorTipo = new Map<string, RegistroEquipo>();
    const cambios: CambioEnHistoria[] = asc.map((r) => {
      const previo = ultimoPorTipo.get(r.cambio.tipo);
      ultimoPorTipo.set(r.cambio.tipo, r);
      const saleDesde = previo ? previo.cambio.fecha : null;
      return {
        ...r,
        saleDesde,
        diasQueDuro: saleDesde ? diasEntre(saleDesde, r.cambio.fecha) : null,
      };
    });
    const una = lista[0];
    out.push({
      clave,
      clave_sitio: una.clave_sitio,
      nombre: lista.find((x) => x.nombre_biobox)?.nombre_biobox ?? null,
      direccion: lista.find((x) => x.direccion)?.direccion ?? null,
      unidad_negocio: una.unidad_negocio,
      cambios: cambios.reverse(),
      vigentes: [...ultimoPorTipo.values()]
        .map((r) => ({
          tipo: r.cambio.tipo,
          serie: r.cambio.entra.serie,
          inventario: r.cambio.entra.inventario,
          desde: r.cambio.fecha,
        }))
        .sort((a, b) => a.tipo.localeCompare(b.tipo, 'es')),
    });
  });
  return out.sort((a, b) =>
    (b.cambios[0]?.cambio.fecha || '').localeCompare(a.cambios[0]?.cambio.fecha || '')
  );
}

/** Sin acentos y en minúsculas, para buscar. */
const normal = (s: string | null | undefined) =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * ¿El registro coincide con lo buscado? Por No. de serie o inventario (del
 * que sale o del que entra), pantalla, sitio, nombre o folio. Cada palabra
 * por separado, como los demás buscadores de la app.
 */
export function coincideBusqueda(r: RegistroEquipo, q: string): boolean {
  const palabras = normal(q).trim().split(/\s+/).filter(Boolean);
  if (!palabras.length) return true;
  const c = r.cambio;
  const texto = normal(
    [
      c.sale.serie, c.sale.inventario, c.entra.serie, c.entra.inventario, c.tipo,
      r.clave_medio, r.clave_sitio, r.nombre_biobox, r.folio,
    ].join(' ')
  );
  return palabras.every((p) => texto.includes(p));
}
