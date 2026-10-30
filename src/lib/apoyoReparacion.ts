// ============================================================
// src/lib/apoyoReparacion.ts
// Técnico que APOYÓ una reparación (Erik, 29-oct-2026).
//
// Solo Op. Bio Box en la unidad Biobox (no Biobox Perú ni otras áreas): al
// tocar «Guardar reparación», RepararModal pregunta «¿Te apoyó algún
// técnico?» (ApoyoModal). Es opcional y se elige uno solo. Se guarda en
// incidencias.apoyo_reparacion_email con la reparación (también sin señal).
//
// La base manda en todo lo demás (migración apoyo_reparacion_op_biobox):
//   · tecnicos_apoyo_op_biobox() entrega la lista; un técnico no puede leer
//     los roles de los otros, por eso es una función y no un select.
//   · inc_valida_apoyo deja la columna en null si el correo ya no es de un
//     técnico de Op. Bio Box (lista vieja del teléfono), si es el mismo que
//     reparó o si la incidencia no es de Op. Bio Box de Biobox. La
//     reparación se guarda igual.
//   · notificar_apoyo_reparacion le avisa al que apoyó.
//
// SIN SEÑAL: la última lista que llegó se guarda en el teléfono (almacén
// `listas`, llave 'apoyo-op-biobox|<correo>') y se usa cuando no hay red.
// ============================================================
import { sb } from './supabase';
import { datosGet, datosPut } from './idbDatos';
import { redOLocal } from './datosLocales';
import { sinAcentos } from './helpers';

/** El área y la unidad en las que se pregunta (nombres exactos del catálogo). */
export const AREA_APOYO = 'Op. Bio Box';
export const UNIDAD_APOYO = 'Biobox';

export type TecnicoApoyo = { email: string; nombre: string };

/** ¿Esta reparación pregunta por el técnico que apoyó? Misma regla que inc_valida_apoyo. */
export function pideApoyo(
  inc: { unidad_negocio?: string | null; assigned_area?: string | null; area_responsable?: string | null }
): boolean {
  const unidad = (inc.unidad_negocio || '').trim().toLowerCase();
  return unidad === UNIDAD_APOYO.toLowerCase() && (inc.assigned_area || inc.area_responsable) === AREA_APOYO;
}

/**
 * La lista para la ventana: sin quien repara, sin repetidos ni correos
 * vacíos, por nombre. No confía en la forma de lo que llega (la copia del
 * teléfono puede ser de otra versión).
 */
export function limpiarTecnicos(filas: unknown, yo: string): TecnicoApoyo[] {
  if (!Array.isArray(filas)) return [];
  const mio = (yo || '').trim().toLowerCase();
  const vistos = new Set<string>();
  const lista: TecnicoApoyo[] = [];
  for (const f of filas) {
    if (!f || typeof f !== 'object') continue;
    const email = String((f as { email?: unknown }).email ?? '').trim().toLowerCase();
    if (!email || email === mio || vistos.has(email)) continue;
    vistos.add(email);
    const nombre = String((f as { nombre?: unknown }).nombre ?? '').trim() || email.split('@')[0];
    lista.push({ email, nombre });
  }
  return lista.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

/**
 * Filtra por nombre o correo, sin acentos ni mayúsculas, con los espacios
 * como comodín ("jo al" encuentra a "Jonathan Álvarez"), como los demás
 * buscadores de la app.
 */
export function filtrarTecnicos(lista: TecnicoApoyo[], texto: string): TecnicoApoyo[] {
  const partes = sinAcentos(texto).trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return lista;
  return lista.filter((t) => {
    const hay = sinAcentos(t.nombre + ' ' + t.email);
    let desde = 0;
    for (const p of partes) {
      const i = hay.indexOf(p, desde);
      if (i < 0) return false;
      desde = i + p.length;
    }
    return true;
  });
}

function llave(email: string): string {
  const k = (email || '').trim().toLowerCase();
  return k ? 'apoyo-op-biobox|' + k : '';
}

async function leerCopia(email: string): Promise<TecnicoApoyo[] | null> {
  const k = llave(email);
  if (!k) return null;
  try {
    const r = await datosGet<{ tecnicos?: unknown }>('listas', k);
    return r && Array.isArray(r.tecnicos) ? limpiarTecnicos(r.tecnicos, '') : null;
  } catch {
    return null;
  }
}

async function guardarCopia(email: string, tecnicos: TecnicoApoyo[]): Promise<void> {
  const k = llave(email);
  if (!k) return;
  try {
    await datosPut('listas', { email: k, guardado: new Date().toISOString(), tecnicos });
  } catch {
    /* sin almacén: la próxima vez se pide a la red */
  }
}

/**
 * Los técnicos de Op. Bio Box de Biobox, sin `email` (quien repara).
 * De la red y, si no se puede, de la copia del teléfono. `null` = no hay
 * ni red ni copia: la ventana lo dice y deja guardar sin apoyo.
 */
export async function cargarTecnicosApoyo(
  email: string
): Promise<{ tecnicos: TecnicoApoyo[]; origen: 'red' | 'local' } | null> {
  const r = await redOLocal<TecnicoApoyo[] | null>(
    (senal) =>
      sb
        .rpc('tecnicos_apoyo_op_biobox')
        .abortSignal(senal)
        .then((x) => ({ data: x.data as TecnicoApoyo[] | null, error: x.error, status: x.status })),
    () => leerCopia(email)
  );
  if (!r.datos) return null;
  const todos = limpiarTecnicos(r.datos, '');
  // Solo se guarda lo que llegó de la red y trae a alguien: un [] de la red
  // (rol cambiado, sesión rara) no debe borrar una copia buena.
  if (r.origen === 'red' && todos.length > 0) void guardarCopia(email, todos);
  return { tecnicos: limpiarTecnicos(todos, email), origen: r.origen };
}
