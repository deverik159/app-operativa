// ============================================================
// src/lib/idbDatos.ts
// IndexedDB de las COPIAS DE CONSULTA ('gpo-datos'): inventario, catálogos,
// pauta QTM y la última lista de incidencias de cada usuario, para que la
// app funcione sin señal (lib/datosLocales.ts es quien las llena y las lee).
//
// POR QUÉ UNA BASE APARTE (modo sin señal, 24-sep-2026): 'gpo-capturas'
// (lib/idb.ts) guarda la cola de envíos y NUNCA debe subir de versión. Sin
// red, el service worker puede arrancar un build MÁS VIEJO que el último
// que escribió la base; un indexedDB.open('gpo-capturas', 1) contra una base
// v2 da VersionError y esa pestaña deja de ver la cola. Aquí:
//   · se abre SIN número de versión (así nunca hay VersionError: se toma la
//     que haya);
//   · si faltan almacenes (base vieja o de otro build), se reabre con
//     version+1 y se crean; si otra pestaña ganó la subida, se reintenta;
//   · un build viejo con MENOS almacenes abre la versión nueva sin problema.
//
// Mismas reglas que idb.ts: NUNCA bloquea (topes de espera) y NUNCA revienta
// (los fallos son rechazos que quien llama atrapa). Una copia de consulta que
// no se pudo leer es "no hay copia", no un error para el usuario.
// ============================================================

const NOMBRE_BD = 'gpo-datos';

/** Tope para abrir (incluye una posible subida de versión). */
const ESPERA_APERTURA_MS = 4000;
/** Tope por transacción normal. Las escrituras grandes pasan el suyo. */
const ESPERA_TX_MS = 15000;
/** Reaperturas por almacenes faltantes o por carrera de versión. */
const MAX_REAPERTURAS = 4;
/** Tras una apertura colgada, cada cuánto se vuelve a intentar (ver abrir). */
const REARME_COLGADA_MS = 30000;

/**
 * Los almacenes:
 *   meta   → por tabla: cuándo se bajó, para qué unidades, cuántas filas.
 *            Aparte de las filas para decidir si toca refrescar sin cargar
 *            2 MB de inventario.
 *   tablas → por tabla: todas sus filas en UN registro. Reemplazar la copia
 *            es un solo put: o queda la nueva completa o sigue la anterior.
 *   listas → la última lista de incidencias por correo (en minúsculas).
 */
export type AlmacenDatos = 'meta' | 'tablas' | 'listas';

const LLAVES: Record<AlmacenDatos, string> = {
  meta: 'tabla',
  tablas: 'tabla',
  listas: 'email',
};

const ALMACENES = Object.keys(LLAVES) as AlmacenDatos[];

let conexion: Promise<IDBDatabase | null> | null = null;

/** Hay una apertura sin contestar (Safari que nunca responde): ver idb.ts. */
let aperturaColgada = false;
/** Cuándo se dio por colgada; 0 = rearmar en la siguiente operación. */
let colgadaDesde = 0;

// Al volver a primer plano se rearma (app pasmada sin señal, 24-sep-2026):
// el iOS que colgó la apertura al suspender la PWA suele contestar a la
// siguiente, y sin esto la copia quedaba "no disponible" toda la sesión.
try {
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') colgadaDesde = 0;
    });
} catch {
  /* sin documento (pruebas): queda el rearme por tiempo */
}

function faltantes(db: IDBDatabase): AlmacenDatos[] {
  return ALMACENES.filter((a) => !db.objectStoreNames.contains(a));
}

/**
 * Un intento de apertura. Sin `version` toma la que exista (o crea la 1).
 * Si faltan almacenes cierra y vuelve a intentar con version+1; un
 * VersionError (otra pestaña ya subió más) se reintenta sin número.
 */
function intentarAbrir(n: number, fin: (db: IDBDatabase | null) => void, version?: number): void {
  if (n > MAX_REAPERTURAS) return fin(null);
  let req: IDBOpenDBRequest;
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB) return fin(null);
    req = version === undefined ? indexedDB.open(NOMBRE_BD) : indexedDB.open(NOMBRE_BD, version);
  } catch {
    return fin(null);
  }
  req.onupgradeneeded = () => {
    try {
      const db = req.result;
      faltantes(db).forEach((a) => db.createObjectStore(a, { keyPath: LLAVES[a] }));
    } catch {
      /* si truena, onerror/onsuccess deciden */
    }
  };
  req.onsuccess = () => {
    const db = req.result;
    if (faltantes(db).length) {
      // Base creada por otro build (o a medias): se sube una versión y se
      // crean los que falten. Cerrar antes, o la subida se bloquea sola.
      const v = db.version;
      try {
        db.close();
      } catch {
        /* ya cerrada */
      }
      return intentarAbrir(n + 1, fin, v + 1);
    }
    // Otra pestaña necesita subir la versión: se cede la conexión.
    db.onversionchange = () => {
      try {
        db.close();
      } catch {
        /* ya cerrada */
      }
      conexion = null;
    };
    db.onclose = () => {
      conexion = null;
    };
    fin(db);
  };
  req.onerror = (ev) => {
    if (req.error?.name === 'VersionError') {
      // Carrera: otra pestaña subió la versión entre nuestro open y el
      // suyo. Se vuelve a abrir sin número (toma la nueva).
      try {
        ev.preventDefault();
      } catch {
        /* nada */
      }
      return intentarAbrir(n + 1, fin);
    }
    fin(null);
  };
  // onblocked: una pestaña de este mismo build soltará la conexión por
  // onversionchange; si no, el tope de abrir() contesta "no disponible".
}

/**
 * Abre una sola vez por pestaña. null = no hay IndexedDB, falló o tardó.
 * Colgada, contesta null al instante, pero solo REARME_COLGADA_MS (o hasta
 * volver a primer plano): luego una operación vuelve a probar con una
 * apertura nueva (la vieja, si contesta tarde, se adopta o se cierra).
 */
function abrir(): Promise<IDBDatabase | null> {
  if (conexion) return conexion;
  if (aperturaColgada) {
    const edad = Date.now() - colgadaDesde;
    if (edad >= 0 && edad < REARME_COLGADA_MS) return Promise.resolve(null);
    aperturaColgada = false;
  }
  const p = new Promise<IDBDatabase | null>((res) => {
    let listo = false;
    const fin = (db: IDBDatabase | null) => {
      if (listo) {
        // Contestó después del tope: se adopta si no hay otra.
        aperturaColgada = false;
        if (db && !conexion) {
          conexion = Promise.resolve(db);
          return;
        }
        try {
          db?.close();
        } catch {
          /* nada que cerrar */
        }
        return;
      }
      listo = true;
      clearTimeout(reloj);
      res(db);
    };
    const reloj = setTimeout(() => {
      if (listo) return;
      listo = true;
      aperturaColgada = true;
      colgadaDesde = Date.now();
      res(null);
    }, ESPERA_APERTURA_MS);
    intentarAbrir(0, fin);
  });
  conexion = p;
  p.then((db) => {
    if (!db && conexion === p) conexion = null;
  });
  return p;
}

/** ¿Se puede usar la base de copias ahora? */
export async function datosDisponible(): Promise<boolean> {
  return (await abrir()) !== null;
}

/** Por qué falló una operación (mismo criterio que ErrorIdb de idb.ts). */
export type MotivoDatos = 'no-disponible' | 'tope' | 'cuota' | 'otro';

export class ErrorDatos extends Error {
  motivo: MotivoDatos;
  constructor(mensaje: string, motivo: MotivoDatos) {
    super(mensaje);
    this.name = 'ErrorDatos';
    this.motivo = motivo;
  }
}

function aErrorDatos(e: unknown, respaldo: string): ErrorDatos {
  const nombre = (e as { name?: string } | null)?.name || '';
  const mensaje = (e as { message?: string } | null)?.message || respaldo;
  const cuota = /quota/i.test(nombre) || /quota/i.test(mensaje);
  return new ErrorDatos(mensaje, cuota ? 'cuota' : 'otro');
}

/**
 * Corre `trabajo` en UNA transacción y resuelve al confirmarse (oncomplete):
 * un put puede abortar al final por cuota, y hasta ahí no hay garantía. Con
 * tope: si no completa a tiempo se aborta (lo que no se confirmó no queda).
 * Una transacción abortada no deja NADA: la copia anterior sigue intacta.
 * Al vencer el tope se suelta además la conexión (app pasmada sin señal,
 * 24-sep-2026): tras suspender la PWA, WebKit puede dejar una conexión
 * muerta en la que nada completa, y cada operación esperaba el tope entero
 * mientras viviera la pestaña. close() deja terminar lo que ya corre en
 * ella; la siguiente operación abre una nueva.
 */
export async function datosTx<T>(
  almacenes: AlmacenDatos[],
  modo: IDBTransactionMode,
  trabajo: (tx: IDBTransaction) => T,
  topeMs = ESPERA_TX_MS
): Promise<T> {
  const deConexion = abrir();
  const db = await deConexion;
  if (!db) throw new ErrorDatos('IndexedDB no disponible', 'no-disponible');
  /** Olvida esta conexión, si sigue siendo la de todos (una más nueva no se toca). */
  const olvidar = () => {
    if (conexion === deConexion) conexion = null;
  };
  return new Promise<T>((res, rej) => {
    let listo = false;
    let tx: IDBTransaction | undefined;
    let salida: T;
    const reloj = setTimeout(() => {
      if (listo) return;
      listo = true;
      try {
        tx?.abort();
      } catch {
        /* ya terminó */
      }
      olvidar();
      try {
        db.close();
      } catch {
        /* ya cerrada */
      }
      rej(new ErrorDatos('IndexedDB no respondió a tiempo', 'tope'));
    }, topeMs);
    try {
      const t = db.transaction(almacenes, modo);
      tx = t;
      t.oncomplete = () => {
        if (listo) return;
        listo = true;
        clearTimeout(reloj);
        res(salida);
      };
      const falla = () => {
        if (listo) return;
        listo = true;
        clearTimeout(reloj);
        rej(aErrorDatos(t.error, 'transacción abortada'));
      };
      t.onerror = falla;
      t.onabort = falla;
      salida = trabajo(t);
    } catch (e) {
      // La conexión ya estaba cerrada: la siguiente operación reabre.
      olvidar();
      if (listo) return;
      listo = true;
      clearTimeout(reloj);
      rej(aErrorDatos(e, 'no se pudo abrir la transacción'));
    }
  });
}

/** Lee un registro por llave; undefined si no existe. */
export async function datosGet<T>(almacen: AlmacenDatos, llave: string): Promise<T | undefined> {
  const caja: { v?: T } = {};
  await datosTx([almacen], 'readonly', (tx) => {
    const r = tx.objectStore(almacen).get(llave);
    r.onsuccess = () => {
      caja.v = r.result as T | undefined;
    };
  });
  return caja.v;
}

/** Escribe (o reemplaza) un registro. */
export async function datosPut(almacen: AlmacenDatos, valor: unknown, topeMs?: number): Promise<void> {
  await datosTx(
    [almacen],
    'readwrite',
    (tx) => {
      tx.objectStore(almacen).put(valor);
    },
    topeMs
  );
}

/** Borra un registro por llave (no falla si no existía). */
export async function datosDelete(almacen: AlmacenDatos, llave: string): Promise<void> {
  await datosTx([almacen], 'readwrite', (tx) => {
    tx.objectStore(almacen).delete(llave);
  });
}
