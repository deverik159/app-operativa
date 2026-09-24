// ============================================================
// src/lib/idb.ts
// IndexedDB mínimo, a mano, para lo que tiene que sobrevivir en el
// teléfono: la cola de envíos (lib/envios.ts) y el borrador del alta de
// incidencias (lib/borrador.ts).
//
// POR QUÉ (auditoría primer mes, 24-sep-2026): con mala señal en campo, un
// reporte con sus fotos solo existía en memoria. Cerrar la app —o que iOS
// la recargue al volver de la cámara— lo perdía todo. localStorage no
// sirve: no guarda Blobs y su tope (~5 MB) no alcanza ni para dos fotos.
//
// Reglas:
//   · NUNCA bloquea: cada operación tiene tope de espera. Hay Safari (modo
//     privado, iOS 14) donde indexedDB.open no responde jamás; ahí se
//     contesta "no disponible" y quien llama sigue en memoria.
//   · NUNCA revienta la app: los fallos se regresan como rechazo de la
//     promesa y cada llamador decide (siempre con try/catch).
//   · Sin dependencias: son tres almacenes y cinco operaciones.
// ============================================================

const NOMBRE_BD = 'gpo-capturas';
const VERSION_BD = 1;

/** Tope para abrir la base: más que esto y se da por no disponible. */
const ESPERA_APERTURA_MS = 3000;
/** Tope por transacción normal (metadatos, lecturas). */
const ESPERA_TX_MS = 15000;

/**
 * Los almacenes:
 *   envios     → un registro por envío en cola (solo metadatos y estado).
 *   archivos   → los Blobs (fotos/videos), aparte: el estado de un envío se
 *                reescribe tras cada paso y no debe arrastrar 50 MB cada vez.
 *   borradores → un borrador del alta por correo de usuario.
 */
export type Almacen = 'envios' | 'archivos' | 'borradores';

const LLAVES: Record<Almacen, string> = {
  envios: 'id',
  archivos: 'clave',
  borradores: 'email',
};

let conexion: Promise<IDBDatabase | null> | null = null;

/**
 * Hay una apertura que no contestó a tiempo y sigue pendiente (el Safari
 * cuyo indexedDB.open nunca responde). Mientras siga así, abrir() contesta
 * "no disponible" AL INSTANTE (revisión primer mes, 24-sep-2026): antes cada
 * operación volvía a esperar el tope completo, y un Guardar con buena red
 * tardaba ~6 s de más (guardar el envío + quitarlo al terminar).
 */
let aperturaColgada = false;

/**
 * Abre (una sola vez por pestaña) la base. Resuelve null si no hay
 * IndexedDB, si falla o si no respondió a tiempo. Si falló, se olvida la
 * promesa para reintentar en la siguiente operación (una falla pasajera no
 * condena a la pestaña a trabajar sin cola). Si no respondió a tiempo, no
 * se abre otra mientras esa siga pendiente, y si contesta tarde, esa
 * conexión se adopta.
 */
function abrir(): Promise<IDBDatabase | null> {
  if (conexion) return conexion;
  if (aperturaColgada) return Promise.resolve(null);
  const p = new Promise<IDBDatabase | null>((res) => {
    let listo = false;
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const fin = (db: IDBDatabase | null) => {
      if (listo) {
        // Llegó tarde (ya se había dado por no disponible). Si abrió, la
        // conexión sirve para lo que sigue; si falló, la siguiente
        // operación vuelve a intentar.
        aperturaColgada = false;
        if (db && !conexion) {
          conexion = Promise.resolve(db);
          return;
        }
        // Ya hay otra: se cierra esta para no dejar conexiones colgadas que
        // bloqueen una futura versión.
        try {
          db?.close();
        } catch {
          /* nada que cerrar */
        }
        return;
      }
      listo = true;
      if (reloj !== undefined) clearTimeout(reloj);
      res(db);
    };
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) return fin(null);
      const req = indexedDB.open(NOMBRE_BD, VERSION_BD);
      req.onupgradeneeded = () => {
        const db = req.result;
        (Object.keys(LLAVES) as Almacen[]).forEach((a) => {
          if (!db.objectStoreNames.contains(a))
            db.createObjectStore(a, { keyPath: LLAVES[a] });
        });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Otra pestaña con una versión nueva de la app pide actualizar el
        // esquema: se cede la conexión en vez de bloquearla.
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            /* ya cerrada */
          }
          conexion = null;
        };
        // El navegador puede cerrarla por su cuenta (borrado de datos del
        // sitio, presión de espacio): la siguiente operación reabre.
        db.onclose = () => {
          conexion = null;
        };
        fin(db);
      };
      req.onerror = () => fin(null);
      // onblocked: otra pestaña vieja no suelta la versión anterior. No se
      // hace nada: el tope de abajo contesta "no disponible" y se sigue.
      reloj = setTimeout(() => {
        aperturaColgada = true;
        fin(null);
      }, ESPERA_APERTURA_MS);
    } catch {
      fin(null);
    }
  });
  conexion = p;
  p.then((db) => {
    if (!db && conexion === p) conexion = null;
  });
  return p;
}

/** ¿Se puede usar IndexedDB en este navegador, ahora? */
export async function idbDisponible(): Promise<boolean> {
  return (await abrir()) !== null;
}

/**
 * Por qué falló una operación. Importa a quien llama: con 'cuota' u 'otro'
 * (p. ej. Safari que no deja clonar un File) vale la pena reintentar con
 * menos datos; con 'no-disponible' o 'tope' no — la base no está o está
 * colgada, y seguir intentando solo retrasaría el guardado.
 */
export type MotivoIdb = 'no-disponible' | 'tope' | 'cuota' | 'otro';

/** Error propio de este módulo, con su motivo. */
export class ErrorIdb extends Error {
  motivo: MotivoIdb;
  constructor(mensaje: string, motivo: MotivoIdb) {
    super(mensaje);
    this.name = 'ErrorIdb';
    this.motivo = motivo;
  }
}

function aErrorIdb(e: unknown, respaldo: string): ErrorIdb {
  const nombre = (e as { name?: string } | null)?.name || '';
  const mensaje = (e as { message?: string } | null)?.message || respaldo;
  const cuota = /quota/i.test(nombre) || /quota/i.test(mensaje);
  return new ErrorIdb(mensaje, cuota ? 'cuota' : 'otro');
}

/**
 * Corre `trabajo` dentro de UNA transacción y resuelve cuando la base
 * confirmó (oncomplete) — no antes: un put "exitoso" puede abortar al final
 * por cuota, y hasta oncomplete no hay garantía de que quedó escrito.
 *
 * Lo que `trabajo` devuelva se entrega al completar (útil para lecturas:
 * el callback guarda los resultados de sus requests en un objeto y se
 * regresa ese objeto).
 *
 * Con tope de espera: si no completa a tiempo se aborta (así lo que el
 * llamador cree que NO quedó guardado, de verdad no queda) y se rechaza.
 */
export async function idbTx<T>(
  almacenes: Almacen[],
  modo: IDBTransactionMode,
  trabajo: (tx: IDBTransaction) => T,
  topeMs = ESPERA_TX_MS
): Promise<T> {
  const db = await abrir();
  if (!db) throw new ErrorIdb('IndexedDB no disponible', 'no-disponible');
  return new Promise<T>((res, rej) => {
    let listo = false;
    let tx: IDBTransaction;
    let salida: T;
    const reloj = setTimeout(() => {
      if (listo) return;
      listo = true;
      try {
        tx.abort();
      } catch {
        /* ya terminó */
      }
      rej(new ErrorIdb('IndexedDB no respondió a tiempo', 'tope'));
    }, topeMs);
    try {
      tx = db.transaction(almacenes, modo);
      tx.oncomplete = () => {
        if (listo) return;
        listo = true;
        clearTimeout(reloj);
        res(salida);
      };
      const falla = () => {
        if (listo) return;
        listo = true;
        clearTimeout(reloj);
        rej(aErrorIdb(tx.error, 'transacción abortada'));
      };
      tx.onerror = falla;
      tx.onabort = falla;
      salida = trabajo(tx);
    } catch (e) {
      // db.transaction truena si la conexión ya se cerró: se olvida para
      // que la siguiente operación reabra.
      conexion = null;
      if (listo) return;
      listo = true;
      clearTimeout(reloj);
      rej(aErrorIdb(e, 'no se pudo abrir la transacción'));
    }
  });
}

/** Lee un registro por llave; undefined si no existe. */
export async function idbGet<T>(almacen: Almacen, llave: string): Promise<T | undefined> {
  const caja: { v?: T } = {};
  await idbTx([almacen], 'readonly', (tx) => {
    const r = tx.objectStore(almacen).get(llave);
    r.onsuccess = () => {
      caja.v = r.result as T | undefined;
    };
  });
  return caja.v;
}

/** Todos los registros de un almacén (los de envíos y borradores son pocos). */
export async function idbGetAll<T>(almacen: Almacen): Promise<T[]> {
  const caja: { v: T[] } = { v: [] };
  await idbTx([almacen], 'readonly', (tx) => {
    const r = tx.objectStore(almacen).getAll();
    r.onsuccess = () => {
      caja.v = (r.result as T[]) || [];
    };
  });
  return caja.v;
}

/** Escribe (o reemplaza) un registro. */
export async function idbPut(almacen: Almacen, valor: unknown, topeMs?: number): Promise<void> {
  await idbTx(
    [almacen],
    'readwrite',
    (tx) => {
      tx.objectStore(almacen).put(valor);
    },
    topeMs
  );
}

/** Borra un registro por llave (no falla si no existía). */
export async function idbDelete(almacen: Almacen, llave: string): Promise<void> {
  await idbTx([almacen], 'readwrite', (tx) => {
    tx.objectStore(almacen).delete(llave);
  });
}

/**
 * Rango de todas las llaves que empiezan con `prefijo`. Las llaves de
 * archivos llevan el dueño al frente ('e:<envío>:<n>', 'b:<sesión>:<n>'),
 * así se borran todos los de un dueño de un jalón.
 */
export function rangoPrefijo(prefijo: string): IDBKeyRange {
  return IDBKeyRange.bound(prefijo, prefijo + '￿');
}

/** Borra todos los registros cuya llave empieza con `prefijo`. */
export async function idbDeletePrefijo(almacen: Almacen, prefijo: string): Promise<void> {
  await idbTx([almacen], 'readwrite', (tx) => {
    tx.objectStore(almacen).delete(rangoPrefijo(prefijo));
  });
}

// ------------------------------------------------------------
// Archivos (Blobs)
// ------------------------------------------------------------

/**
 * Registro de un archivo en el almacén `archivos`. Se guarda como Blob y,
 * si el navegador no deja clonar ese Blob (Safari viejo tronaba con File
 * de un <input>), como ArrayBuffer. Nombre, tipo y fecha van aparte porque
 * al rehidratar hay que volver a armar un File.
 */
export type RegistroArchivo = {
  clave: string;
  blob?: Blob;
  buf?: ArrayBuffer;
  nombre: string;
  tipo: string;
  lastModified: number;
  bytes: number;
};

/** Hasta este tamaño se intenta el respaldo en ArrayBuffer (lo carga a RAM). */
const MAX_BUF_BYTES = 15 * 1024 * 1024;

/** Tope de espera de una escritura de archivo: un video tarda en copiarse. */
export function topeEscrituraArchivo(bytes: number): number {
  // 10 s base + ~1 s por cada 5 MB: generoso, solo evita colgarse.
  return 10000 + Math.ceil(bytes / (5 * 1024 * 1024)) * 1000;
}

/** Arma el registro de un File (primer intento: como Blob). */
export function registroDeArchivo(clave: string, f: File): RegistroArchivo {
  return {
    clave,
    blob: f,
    nombre: f.name,
    tipo: f.type,
    lastModified: f.lastModified || Date.now(),
    bytes: f.size,
  };
}

/**
 * Segundo intento para un archivo que no se dejó guardar como Blob: lo
 * mismo pero con sus bytes. null si es demasiado grande para cargarlo a
 * memoria (un video): ese se queda sin copia en el teléfono.
 */
export async function registroEnBytes(clave: string, f: File): Promise<RegistroArchivo | null> {
  if (f.size > MAX_BUF_BYTES) return null;
  try {
    const buf = await f.arrayBuffer();
    return {
      clave,
      buf,
      nombre: f.name,
      tipo: f.type,
      lastModified: f.lastModified || Date.now(),
      bytes: f.size,
    };
  } catch {
    return null;
  }
}

/**
 * Guarda UN archivo en su propia transacción: si no cabe, falla solo ese y
 * no los demás. Intenta como Blob y luego como bytes. true = quedó guardado.
 */
export async function guardarArchivo(clave: string, f: File): Promise<boolean> {
  try {
    await idbPut('archivos', registroDeArchivo(clave, f), topeEscrituraArchivo(f.size));
    return true;
  } catch (e) {
    // Sin espacio no hay segundo intento que valga (los bytes pesan igual),
    // y con la base ausente o colgada, tampoco.
    if (e instanceof ErrorIdb && e.motivo !== 'otro') return false;
    const r = await registroEnBytes(clave, f);
    if (!r) return false;
    try {
      await idbPut('archivos', r, topeEscrituraArchivo(f.size));
      return true;
    } catch {
      return false;
    }
  }
}

/** Vuelve a armar el File de un registro guardado. */
export function archivoDeRegistro(r: RegistroArchivo): File | null {
  const partes: BlobPart[] = r.blob ? [r.blob] : r.buf ? [r.buf] : [];
  if (!partes.length) return null;
  try {
    return new File(partes, r.nombre || 'archivo', {
      type: r.tipo || r.blob?.type || '',
      lastModified: r.lastModified || Date.now(),
    });
  } catch {
    return null;
  }
}

/** Lee un archivo guardado y lo regresa como File; null si no está. */
export async function leerArchivo(clave: string): Promise<File | null> {
  try {
    const r = await idbGet<RegistroArchivo>('archivos', clave);
    return r ? archivoDeRegistro(r) : null;
  } catch {
    return null;
  }
}
