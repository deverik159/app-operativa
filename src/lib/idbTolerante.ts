// ============================================================
// src/lib/idbTolerante.ts
// Una base de IndexedDB PROPIA con apertura tolerante, para colas nuevas
// (la primera: lib/tomasPauta.ts, fase 1 de comprobaciones, 22-oct-2026).
//
// Es la apertura de lib/visitas.ts copiada SIN cambios de comportamiento y
// con el nombre y los almacenes como parámetros. visitas.ts, idb.ts e
// idbDatos.ts conservan sus copias (no se tocan en esta fase); si un día se
// unifican, este es el molde. Reglas que trae (ver la cabecera de idb.ts):
//   · Sin número de versión: nunca hay VersionError entre builds. Si falta
//     un almacén, se reabre con versión+1 y se crea solo lo que falta.
//   · Nunca bloquea: la apertura y cada transacción tienen tope. Una
//     apertura colgada contesta null al instante por 30 s y se rearma al
//     volver a primer plano (iOS que congeló la PWA).
//   · Nunca revienta: los fallos son rechazos con ErrorIdb y su motivo
//     ('no-disponible' | 'tope' | 'cuota' | 'otro'); quien llama decide.
//   · Una transacción resuelve en oncomplete, no antes: un put puede
//     abortar después por cuota.
// NUNCA usar con 'gpo-capturas' (no sube de versión; ver idb.ts).
// ============================================================
import { ErrorIdb } from './idb';

const ESPERA_APERTURA_MS = 3000;
const ESPERA_TX_MS = 15000;
const MAX_REAPERTURAS = 3;
const REARME_COLGADA_MS = 30000;

export type BaseTolerante<A extends string> = {
  /** Una transacción con tope; resuelve al completar (oncomplete), no antes. */
  tx<T>(almacenes: A[], modo: IDBTransactionMode, trabajo: (t: IDBTransaction) => T, topeMs?: number): Promise<T>;
};

function mensaje(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err ?? 'error desconocido');
}

/**
 * Crea el acceso a una base propia. `llaves` = almacén → keyPath. La base se
 * abre la primera vez que se usa (una conexión por pestaña).
 */
export function crearBaseTolerante<A extends string>(nombre: string, llaves: Record<A, string>): BaseTolerante<A> {
  const almacenes = Object.keys(llaves) as A[];
  let conexion: Promise<IDBDatabase | null> | null = null;
  let aperturaColgada = false;
  let colgadaDesde = 0;

  try {
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') colgadaDesde = 0;
      });
  } catch {
    /* sin documento (pruebas) */
  }

  const faltantes = (db: IDBDatabase): A[] => almacenes.filter((a) => !db.objectStoreNames.contains(a));

  function abrir(): Promise<IDBDatabase | null> {
    if (conexion) return conexion;
    if (aperturaColgada) {
      const edad = Date.now() - colgadaDesde;
      if (edad >= 0 && edad < REARME_COLGADA_MS) return Promise.resolve(null);
      aperturaColgada = false;
    }
    const p = new Promise<IDBDatabase | null>((res) => {
      let listo = false;
      let reloj: ReturnType<typeof setTimeout> | undefined;
      const fin = (db: IDBDatabase | null) => {
        if (listo) {
          // Llegó tarde: si abrió y no hay otra, se adopta; si no, se cierra.
          aperturaColgada = false;
          if (db && !conexion) {
            conexion = Promise.resolve(db);
            return;
          }
          try {
            db?.close();
          } catch {
            /* nada */
          }
          return;
        }
        listo = true;
        if (reloj !== undefined) clearTimeout(reloj);
        res(db);
      };
      const intentar = (version: number | undefined, vuelta: number): void => {
        let req: IDBOpenDBRequest;
        try {
          req = version === undefined ? indexedDB.open(nombre) : indexedDB.open(nombre, version);
        } catch {
          return fin(null);
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          faltantes(db).forEach((a) => db.createObjectStore(a, { keyPath: llaves[a] }));
        };
        req.onsuccess = () => {
          const db = req.result;
          if (faltantes(db).length && vuelta < MAX_REAPERTURAS) {
            const v = db.version;
            try {
              db.close();
            } catch {
              /* nada */
            }
            return intentar(v + 1, vuelta + 1);
          }
          db.onversionchange = () => {
            try {
              db.close();
            } catch {
              /* nada */
            }
            conexion = null;
          };
          db.onclose = () => {
            conexion = null;
          };
          fin(db);
        };
        req.onerror = (ev) => {
          if (req.error?.name === 'VersionError' && vuelta < MAX_REAPERTURAS) {
            ev.preventDefault?.();
            return intentar(undefined, vuelta + 1);
          }
          fin(null);
        };
      };
      try {
        if (typeof indexedDB === 'undefined' || !indexedDB) return fin(null);
        reloj = setTimeout(() => {
          aperturaColgada = true;
          colgadaDesde = Date.now();
          fin(null);
        }, ESPERA_APERTURA_MS);
        intentar(undefined, 0);
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

  async function tx<T>(
    almacenesTx: A[],
    modo: IDBTransactionMode,
    trabajo: (t: IDBTransaction) => T,
    topeMs = ESPERA_TX_MS
  ): Promise<T> {
    const deConexion = abrir();
    const db = await deConexion;
    if (!db) throw new ErrorIdb('IndexedDB no disponible', 'no-disponible');
    const olvidar = () => {
      if (conexion === deConexion) conexion = null;
    };
    return new Promise<T>((res, rej) => {
      let listo = false;
      let t: IDBTransaction;
      let salida: T;
      const reloj = setTimeout(() => {
        if (listo) return;
        listo = true;
        try {
          t.abort();
        } catch {
          /* ya terminó */
        }
        olvidar();
        try {
          db.close();
        } catch {
          /* nada */
        }
        rej(new ErrorIdb('IndexedDB no respondió a tiempo', 'tope'));
      }, topeMs);
      try {
        t = db.transaction(almacenesTx, modo);
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
          const e = t.error;
          const cuota = /quota/i.test(e?.name || '') || /quota/i.test(e?.message || '');
          rej(new ErrorIdb(e?.message || 'transacción abortada', cuota ? 'cuota' : 'otro'));
        };
        t.onerror = falla;
        t.onabort = falla;
        salida = trabajo(t);
      } catch (e) {
        olvidar();
        if (listo) return;
        listo = true;
        clearTimeout(reloj);
        rej(new ErrorIdb(mensaje(e), 'otro'));
      }
    });
  }

  return { tx };
}
