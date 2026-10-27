// ============================================================
// src/lib/colaFotos/logica.ts
// Lo PURO del núcleo de colas de fotos (fase 3 de Comprobaciones,
// 26-oct-2026): la vida de un archivo en la cola y cuándo un trabajo ya no
// tiene nada que hacer. Sin IndexedDB, sin Supabase y sin React: lo prueba
// tests/colaFotosLogica.test.mjs.
//
// POR QUÉ (26-oct-2026): la cola de Pauta (lib/tomasPauta.ts y
// lib/tomasPautaLogica.ts) se queda INTACTA; Comprobaciones usa este núcleo
// nuevo (especificación §7). Es la misma máquina que Pauta menos el estado
// 'ligando': aquí ligar es una RPC idempotente por cliente_id
// (comp_subir_foto contesta «ya» si la foto ya entró), así que no hace falta
// preguntar «¿ya entró?» antes de repetir.
//
//   local   → solo en el teléfono;
//   subido  → ya está en Storage; falta ligarlo (o ligarlo a más tomas:
//             «Usar también para…» regresa un 'ligado' a 'subido');
//   ligado  → el servidor contestó por cada toma pedida (fin);
//   quitado → el monitorista lo quitó (fin; si llegó al servidor, la cola
//             lo limpia: ver `limpiar`);
//   perdido → no estaba en el teléfono (no cupo o falló la lectura 3 veces);
//   fallido → el servidor lo rechazó con un error que no es de red. El Blob
//             se CONSERVA (la cámara de la app no deja la foto en el
//             carrete), se reintenta en la vuelta del aviso y bloquea el
//             cierre hasta que suba, se quite o se descarte.
// ============================================================

import { gruposParaCompartir, extensionDe, limpiarNombre, tipoDeArchivo, instanteDe } from '../tomasPautaLogica';
import type { TipoArchivo } from '../tomasPautaLogica';

// Lo de Pauta que ya es genérico se LEE de ahí (sin cambiarlo): nombres,
// extensiones y los grupos de la hoja de compartir.
export { gruposParaCompartir, extensionDe, limpiarNombre, tipoDeArchivo, instanteDe };
export type { TipoArchivo };

export type EstadoArchivoCola = 'local' | 'subido' | 'ligado' | 'quitado' | 'perdido' | 'fallido';

/** Lo que el núcleo necesita de cada archivo (el adaptador le agrega lo suyo). */
export type ArchivoCola = {
  /** Id corto, único dentro del trabajo (llave del Blob: t:<id del trabajo>:<fid>). */
  fid: string;
  /** Orden de captura dentro del trabajo (1, 2, 3…). */
  n: number;
  /** Ruta FIJA en el bucket evidencias (se decide al encolar, nunca en cada intento). */
  path: string;
  /** Nombre único con extensión (hoja de compartir). */
  nombre: string;
  mime: string;
  tipo: TipoArchivo;
  bytes: number;
  /** Hora del teléfono al encolar (solo se muestra; no decide nada). */
  encolado_en: string;
  /** Cámara de la app o galería: solo las de cámara hacen falta en Fotos. */
  origen: 'camara' | 'galeria';
  estado: EstadoArchivoCola;
  /** Lecturas del teléfono que fallaron seguidas (regla de 3, como visitas). */
  lecturasFallidas?: number;
  /**
   * Se quitó después de llegar al servidor: la cola lo limpia (RPC y objeto)
   * antes de cerrar el trabajo. 'objeto' = se descartó: solo se borra el
   * archivo de Storage si nada lo usa (lo que ya entró a una toma se queda).
   */
  limpiar?: boolean | 'objeto';
  /** Ya está en Storage: un 'fallido' con esta marca solo falta ligarlo (no necesita el Blob). */
  arriba?: boolean;
  /** Cuándo quedó ligado (ISO, reloj del teléfono; solo se muestra). */
  ligado_en?: string;
  /**
   * ¿Ya contó en el logro («N fotos arriba»)? false = quedó ligado sin contar
   * (comp: ninguna toma lo aceptó) y cuenta si después se liga a una.
   */
  en_logro?: boolean;
};

/** Lo que el núcleo necesita de cada trabajo. */
export type TrabajoCola<A extends ArchivoCola = ArchivoCola> = {
  v: number;
  /** Qué cola lo creó ('comp'): una base nunca procesa trabajos de otra. */
  tipo: string;
  /** UUID propio: llave en IndexedDB, de los Blobs y del descarte. */
  id: string;
  /** Para encontrar el trabajo activo (comp: la visita correo|unidad|sitio|día). */
  clave: string;
  /** Solo la sesión de este correo lo procesa y lo ve. */
  email: string;
  archivos: A[];
  ultimoError: string | null;
  /** El último intento dio un error que no se arregla solo (pide atención). */
  conError: boolean;
  /** El último error que ya se avisó (para no repetirlo en cada vuelta). */
  avisado?: string | null;
  /**
   * El error vigente lo puso una ligada que pidió atención (captura cerrada,
   * falta la migración): se borra en cuanto otra ligada sale bien.
   */
  errorDeLigar?: boolean;
  /**
   * El error vigente lo puso el REGISTRO (no se pudo leer el estado, una
   * respuesta que no se entiende…): se borra en cuanto un registro sale bien
   * (26-oct-2026; la visita sigue viva mientras quede otra toma abierta).
   */
  errorDeRegistro?: boolean;
  creado_en: string;
  actualizado_en: string;
};

type ConArchivos<A extends ArchivoCola = ArchivoCola> = { archivos: readonly A[] };

/** Estados en los que el archivo ya no necesita nada de la cola ('fallido' sí: se reintenta). */
export function esFinal(e: EstadoArchivoCola): boolean {
  return e === 'ligado' || e === 'quitado' || e === 'perdido';
}

/** Lo que falta mandar, en orden: primero las fotos (en orden de captura) y al final los videos. */
export function porMandar<A extends ArchivoCola>(t: ConArchivos<A>): A[] {
  return t.archivos
    .filter((a) => !esFinal(a.estado))
    .slice()
    .sort((a, b) => (a.tipo === b.tipo ? a.n - b.n : a.tipo === 'foto' ? -1 : 1));
}

/** Archivos quitados que aún dejan algo en el servidor por limpiar. */
export function porLimpiar<A extends ArchivoCola>(t: ConArchivos<A>): A[] {
  return t.archivos.filter((a) => a.estado === 'quitado' && !!a.limpiar);
}

/**
 * ¿Ya no queda nada de los ARCHIVOS? (todos en estado final y sin limpieza
 * pendiente). Lo demás que detiene el cierre (un registro por hacer, una
 * visita abierta) lo decide el adaptador.
 */
export function listoParaCerrar(t: ConArchivos): boolean {
  return t.archivos.every((a) => esFinal(a.estado) && !a.limpiar);
}

/**
 * Ya no hay nada del monitorista, solo limpiar en el servidor lo que quitó
 * (p. ej. tras Descartar sin señal): la cola lo termina sola y no pide
 * atención ni se pinta.
 */
export function soloLimpieza(t: ConArchivos): boolean {
  return t.archivos.length > 0 && t.archivos.every((a) => a.estado === 'quitado');
}

/** Archivos que el servidor rechazó y siguen en el teléfono. */
export function fallidos(t: ConArchivos): number {
  return t.archivos.filter((a) => a.estado === 'fallido').length;
}

/** Archivos (fotos y videos) que siguen en el teléfono sin terminar: la píldora «⬆ N». */
export function porSubir(t: ConArchivos): number {
  return t.archivos.filter((a) => !esFinal(a.estado)).length;
}

/** Fotos y videos que no estaban en el teléfono (no subieron: hay que repetirlos). */
export function perdidas(t: ConArchivos): number {
  return t.archivos.filter((a) => a.estado === 'perdido').length;
}

/**
 * El aviso de lo que ya no estaba en el teléfono ('' = nada). Mismo texto
 * que la cola de Pauta.
 */
export function textoPerdidas(t: ConArchivos): string {
  const lista = t.archivos.filter((a) => a.estado === 'perdido');
  if (!lista.length) return '';
  const fotos = lista.filter((a) => a.tipo === 'foto').length;
  const videos = lista.length - fotos;
  if (lista.length === 1)
    return fotos
      ? 'Una foto ya no estaba en el teléfono y no se subió: vuelve a tomarla.'
      : 'Un video ya no estaba en el teléfono y no se subió: vuelve a grabarlo.';
  const que =
    fotos && videos
      ? `${fotos === 1 ? 'Una foto' : `${fotos} fotos`} y ${videos === 1 ? 'un video' : `${videos} videos`}`
      : fotos
        ? `${fotos} fotos`
        : `${videos} videos`;
  return `${que} ya no estaban en el teléfono y no se subieron: vuelve a ${videos && !fotos ? 'grabarlos' : fotos && !videos ? 'tomarlas' : 'tomarlos'}.`;
}

/** Termina en punto (para juntar textos). */
export function conPunto(s: string): string {
  const x = (s || '').trim();
  return /[.!?…]$/.test(x) ? x : x + '.';
}
