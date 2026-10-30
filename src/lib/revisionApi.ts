// ============================================================
// src/lib/revisionApi.ts
// Acceso a la base para la revisión de tomas y el modo de comprobación
// (fase 3, incremento 3; 29-oct-2026). Firmas de la migración
// comp_f3_revision (spec §4.5 y §11).
//
// Mismas reglas que comprobacionesApi.ts: nunca lanza; la RLS niega en
// silencio, así que cada escritura devuelve lo que contestó la base y la
// pantalla relee. Las RPC nuevas contestan los errores esperados dentro
// del resultado ({ok:false, codigo}); aquí se vuelven una falla con su
// texto (textoCodigoRevision) y `codigoRev` para decidir sin leer el texto.
//
// Storage: primero se sube el archivo y luego la RPC lo registra; si la RPC
// no lo registra, se borra (sin fila, ev_obj_del_comp deja borrarlo a su
// dueño). storage.remove no acepta abortSignal: se le pone tope con
// Promise.race (lección de la cola de Pauta, 22-oct-2026).
// ============================================================

import { sb } from './supabase';
import { tope } from './envios';
import { BUCKET_EVIDENCIAS, CACHE_INMUTABLE } from './storage';
import { comprimirImagen } from './comprimirImagen';
import { clasificarErrorComp, codigoFallaComp, textoFallaF3, type CodigoFallaComp } from './fallasComp';
import { porTrozos, traerTodo, TOPE_ESCRITURA_COMP_MS } from './comprobacionesApi';
import { leerPosiciones, type TienePos } from './plantillasComp';
import {
  extensionDe,
  rutaCaptura,
  rutaEditada,
  textoCodigoRevision,
  type CampanaModo,
  type EstadoToma,
  type FotoRev,
  type ModoToma,
  type TomaRev,
} from './revisionTomas';

export type FallaRev = {
  ok: false;
  error: string;
  sinRed: boolean;
  codigo?: CodigoFallaComp;
  /** El código que contestó la RPC ('toma_cerrada', 'incompleta'…), si contestó uno. */
  codigoRev?: string;
  /** El resultado completo de la RPC (p. ej. faltan de 'incompleta'). */
  detalle?: Record<string, unknown>;
  /** Captura sin respuesta: con este cliente_id y ruta, el reintento no la duplica. */
  reintento?: { cid: string; path: string };
};
export type ResRev<T> = { ok: true; data: T } | FallaRev;

type RespPg = { data: unknown; error: unknown; status: number };

function fallaPg(error: unknown, status: number | null, escritura: boolean): FallaRev {
  const c = clasificarErrorComp(error, status);
  const codigo = codigoFallaComp(error, status, c.sinRed);
  return { ok: false, error: textoFallaF3({ ...c, codigo }, escritura), sinRed: c.sinRed, codigo };
}

/** Llama una RPC de revisión. {ok:false, codigo} de la base = falla con su texto. */
async function llamar<T>(nombre: string, args: Record<string, unknown>): Promise<ResRev<T>> {
  try {
    const r = (await sb.rpc(nombre, args).abortSignal(tope(TOPE_ESCRITURA_COMP_MS))) as unknown as RespPg;
    if (r.error || r.status === 0) return fallaPg(r.error, r.status, true);
    const d = r.data as Record<string, unknown> | null;
    if (d && typeof d === 'object' && !Array.isArray(d) && d.ok === false) {
      const cod = typeof d.codigo === 'string' ? d.codigo : 'otro';
      return {
        ok: false,
        error: textoCodigoRevision(cod),
        sinRed: false,
        codigo: cod === 'ocupada' ? 'ocupada' : cod === 'sin_permiso' ? 'sin_permiso' : 'otro',
        codigoRev: cod,
        detalle: d,
      };
    }
    return { ok: true, data: (d ?? {}) as T };
  } catch (e) {
    return fallaPg(e, null, true);
  }
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isFinite(x)) : []);
const textos = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const txt = (v: unknown) => (typeof v === 'string' ? v : null);

/** Borra objetos de Storage con tope; nunca lanza (lo que quede lo limpia la purga). */
export async function borrarObjetos(paths: string[], ms = 15000): Promise<void> {
  const lista = paths.filter(Boolean);
  if (!lista.length) return;
  try {
    await Promise.race([sb.storage.from(BUCKET_EVIDENCIAS).remove(lista), new Promise((r) => setTimeout(r, ms))]);
  } catch {
    /* se queda suelto: la purga lo limpia */
  }
}

/**
 * Sube un archivo con tope (revisión adversarial, 29-oct-2026): en iPhone o
 * al cambiar de red, upload puede no resolver nunca y dejaría tomado el
 * candado del módulo. El tope crece con el tamaño (mínimo ~20 KB/s). En un
 * reintento con la MISMA ruta, «ya existe» no es error: ya subió antes.
 * null = subió.
 */
async function subirArchivo(path: string, archivo: File, reintento = false): Promise<FallaRev | null> {
  const ms = 30000 + Math.ceil(archivo.size / 20000) * 1000;
  try {
    const r = await Promise.race([
      sb.storage.from(BUCKET_EVIDENCIAS).upload(path, archivo, { upsert: false, cacheControl: CACHE_INMUTABLE }),
      new Promise<'tope'>((res) => setTimeout(() => res('tope'), ms)),
    ]);
    if (r === 'tope')
      return { ok: false, error: 'La subida tardó demasiado (señal lenta). Vuelve a intentarlo.', sinRed: true, codigo: 'sin_red' };
    if (r.error) {
      const e = r.error as { message?: string; statusCode?: string | number };
      if (reintento && (String(e.statusCode) === '409' || /already exists|duplicate/i.test(e.message || ''))) return null;
      return fallaPg(r.error, null, true);
    }
    return null;
  } catch (e) {
    return fallaPg(e, null, true);
  }
}

/** URL pública de un path del bucket de evidencias (nunca se guarda en la base). */
export const urlPublica = (path: string) => sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path).data.publicUrl;

// ------------------------------------------------------------
// Lecturas
// ------------------------------------------------------------

/**
 * Modo de unas campañas (comp_campanas; la vista no cambió, M9). Antes de la
 * migración las columnas no existen: falla con codigo 'falta_migracion' y la
 * pantalla trata todo como campo.
 */
export async function leerModoCampanas(ids: number[]): Promise<ResRev<Map<number, CampanaModo>>> {
  const r = await porTrozos<Record<string, unknown>>(ids, (t, d, h, s) =>
    sb.from('comp_campanas').select('id,modo_toma,pos_camara,plantilla_codigo').in('id', t).order('id').range(d, h).abortSignal(s)
  );
  if (!r.ok) return r;
  const m = new Map<number, CampanaModo>();
  for (const x of r.data) {
    const modo: ModoToma = x.modo_toma === 'camaras' || x.modo_toma === 'mixto' ? x.modo_toma : 'campo';
    m.set(Number(x.id), { id: Number(x.id), modo_toma: modo, pos_camara: textos(x.pos_camara), plantilla_codigo: txt(x.plantilla_codigo) });
  }
  return { ok: true, data: m };
}

const COLS_TOMA =
  'id,campana_id,sitio_id,fecha,estado,monitorista_email,tomada_por,enviada_en,plantilla_usada,regreso_n,rechazo_motivo,' +
  'rechazada_por,rechazada_en,comprobada_en,comprobada_por,reabierta_motivo,reabierta_por,reabierta_en';

function aToma(x: Record<string, unknown>): TomaRev {
  return {
    id: Number(x.id),
    campana_id: Number(x.campana_id),
    sitio_id: Number(x.sitio_id),
    fecha: String(x.fecha),
    estado: (['pendiente', 'por_revisar', 'comprobada', 'regresada', 'cancelada'].includes(String(x.estado))
      ? x.estado
      : 'pendiente') as EstadoToma,
    monitorista_email: txt(x.monitorista_email),
    tomada_por: txt(x.tomada_por),
    enviada_en: txt(x.enviada_en),
    plantilla_usada: Array.isArray(x.plantilla_usada) ? leerPosiciones(x.plantilla_usada) : null,
    regreso_n: num(x.regreso_n),
    rechazo_motivo: txt(x.rechazo_motivo),
    rechazada_por: txt(x.rechazada_por),
    rechazada_en: txt(x.rechazada_en),
    comprobada_en: txt(x.comprobada_en),
    comprobada_por: txt(x.comprobada_por),
    reabierta_motivo: txt(x.reabierta_motivo),
    reabierta_por: txt(x.reabierta_por),
    reabierta_en: txt(x.reabierta_en),
  };
}

/**
 * Las tomas de una campaña que importan para revisar y capturar (todas
 * menos las canceladas), por fecha. La RLS da las de la analista de la
 * campaña, del Supervisor de la unidad y del manager.
 */
export async function leerTomasRevision(campanaId: number): Promise<ResRev<TomaRev[]>> {
  const r = await traerTodo<Record<string, unknown>>((d, h, s) =>
    sb
      .from('comp_tomas')
      .select(COLS_TOMA)
      .eq('campana_id', campanaId)
      .neq('estado', 'cancelada')
      .order('fecha')
      .order('id')
      .range(d, h)
      .abortSignal(s)
  );
  if (!r.ok) return r;
  return { ok: true, data: r.data.map(aToma) };
}

/**
 * Las fotos de unas tomas (al abrir un sitio, no antes: una versión de Vía
 * Verde trae hasta 50 columnas): ligas, fotos, revisiones y en cuántas otras
 * tomas sigue vigente cada foto (M5).
 */
export async function leerFotosTomas(tomaIds: number[]): Promise<ResRev<FotoRev[]>> {
  if (!tomaIds.length) return { ok: true, data: [] };
  const ligas = await porTrozos<Record<string, unknown>>(tomaIds, (t, d, h, s) =>
    sb
      .from('comp_evidencia_tomas')
      .select('evidencia_id,toma_id,regresada_en')
      .in('toma_id', t)
      .order('toma_id')
      .order('evidencia_id')
      .range(d, h)
      .abortSignal(s)
  );
  if (!ligas.ok) return ligas;
  const evIds = [...new Set(ligas.data.map((l) => Number(l.evidencia_id)))];
  const [ev, rev, otras] = await Promise.all([
    porTrozos<Record<string, unknown>>(evIds, (t, d, h, s) =>
      sb
        .from('comp_evidencias')
        .select('id,cliente_id,path,tipo,pos,momento,fecha,origen,subido_por,creado_en,tomada_en_tel')
        .in('id', t)
        .order('id')
        .range(d, h)
        .abortSignal(s)
    ),
    porTrozos<Record<string, unknown>>(tomaIds, (t, d, h, s) =>
      sb
        .from('comp_revision_fotos')
        .select('evidencia_id,toma_id,estado,motivo,editada_path,revisado_por,revisado_en')
        .in('toma_id', t)
        .order('toma_id')
        .order('evidencia_id')
        .range(d, h)
        .abortSignal(s)
    ),
    porTrozos<Record<string, unknown>>(evIds, (t, d, h, s) =>
      sb
        .from('comp_evidencia_tomas')
        .select('evidencia_id,toma_id')
        .in('evidencia_id', t)
        .is('regresada_en', null)
        .order('evidencia_id')
        .order('toma_id')
        .range(d, h)
        .abortSignal(s)
    ),
  ]);
  if (!ev.ok) return ev;
  if (!rev.ok) return rev;
  if (!otras.ok) return otras;
  const porEv = new Map(ev.data.map((e) => [Number(e.id), e]));
  const porRev = new Map(rev.data.map((x) => [`${x.evidencia_id}|${x.toma_id}`, x]));
  const vigentes = new Map<number, number>();
  for (const l of otras.data) vigentes.set(Number(l.evidencia_id), (vigentes.get(Number(l.evidencia_id)) ?? 0) + 1);
  const out: FotoRev[] = [];
  for (const l of ligas.data) {
    const e = porEv.get(Number(l.evidencia_id));
    if (!e) continue;
    const x = porRev.get(`${l.evidencia_id}|${l.toma_id}`);
    const devuelta = l.regresada_en != null;
    out.push({
      evidencia_id: Number(e.id),
      toma_id: Number(l.toma_id),
      cliente_id: String(e.cliente_id),
      path: String(e.path),
      tipo: e.tipo === 'video' ? 'video' : 'foto',
      pos: String(e.pos),
      momento: e.momento === 'dia' || e.momento === 'noche' ? e.momento : null,
      fecha: String(e.fecha),
      origen: e.origen === 'camara' ? 'camara' : 'campo',
      subido_por: String(e.subido_por),
      creado_en: String(e.creado_en),
      tomada_en_tel: txt(e.tomada_en_tel),
      devuelta,
      revision:
        x && (x.estado === 'correcta' || x.estado === 'editada' || x.estado === 'rechazada')
          ? {
              estado: x.estado,
              motivo: txt(x.motivo),
              editada_path: txt(x.editada_path),
              revisado_por: String(x.revisado_por),
              revisado_en: String(x.revisado_en),
            }
          : null,
      otras_tomas: Math.max(0, (vigentes.get(Number(e.id)) ?? 0) - (devuelta ? 0 : 1)),
    });
  }
  return { ok: true, data: out };
}

/**
 * Lo que ya tiene de CÁMARA cada toma (capturas vigentes), sin bajar las
 * fotos: para contar «Por capturar» de toda la campaña. Solo se pide para
 * las tomas candidatas (no comprobadas, de hoy o antes) de campañas con
 * parte de cámara.
 */
export async function leerCapturasTomas(tomaIds: number[]): Promise<ResRev<Map<number, TienePos[]>>> {
  const m = new Map<number, TienePos[]>();
  if (!tomaIds.length) return { ok: true, data: m };
  const ligas = await porTrozos<Record<string, unknown>>(tomaIds, (t, d, h, s) =>
    sb
      .from('comp_evidencia_tomas')
      .select('evidencia_id,toma_id')
      .in('toma_id', t)
      .is('regresada_en', null)
      .order('toma_id')
      .order('evidencia_id')
      .range(d, h)
      .abortSignal(s)
  );
  if (!ligas.ok) return ligas;
  const ev = await porTrozos<Record<string, unknown>>([...new Set(ligas.data.map((l) => Number(l.evidencia_id)))], (t, d, h, s) =>
    sb
      .from('comp_evidencias')
      // Cualquier origen, como comp_faltan: solo se cuentan las posiciones de cámara.
      .select('id,pos,momento')
      .in('id', t)
      .eq('tipo', 'foto')
      .order('id')
      .range(d, h)
      .abortSignal(s)
  );
  if (!ev.ok) return ev;
  const porEv = new Map(ev.data.map((e) => [Number(e.id), e]));
  for (const l of ligas.data) {
    const e = porEv.get(Number(l.evidencia_id));
    if (!e) continue;
    const tid = Number(l.toma_id);
    const lista = m.get(tid) ?? [];
    const momento = e.momento === 'dia' || e.momento === 'noche' ? e.momento : null;
    const x = lista.find((y) => y.pos === e.pos && y.momento === momento);
    if (x) x.n++;
    else lista.push({ pos: String(e.pos), momento, n: 1 });
    m.set(tid, lista);
  }
  return { ok: true, data: m };
}

// ------------------------------------------------------------
// Revisión
// ------------------------------------------------------------

export type ResRevisar = { aplicadas: number; tomas: number[]; comprobadas: number[]; borrar: string[] };

/**
 * comp_revisar_fotos: Correcta, Editada (con su path ya subido) o quitar la
 * marca. enTodas (M5): la misma marca en las otras versiones de esa foto que
 * la persona revisa. Las editadas viejas que ya nadie usa se borran aquí.
 */
export async function revisarFotos(
  tomaId: number,
  evidenciaIds: number[],
  estado: 'correcta' | 'editada' | 'quitar',
  op: { editadaPath?: string | null; enTodas?: boolean } = {}
): Promise<ResRev<ResRevisar>> {
  const r = await llamar<Record<string, unknown>>('comp_revisar_fotos', {
    p_toma_id: tomaId,
    p_evidencia_ids: evidenciaIds,
    p_estado: estado,
    p_editada_path: op.editadaPath ?? null,
    p_en_todas: op.enTodas ?? true,
  });
  if (!r.ok) return r;
  const data = { aplicadas: num(r.data.aplicadas), tomas: nums(r.data.tomas), comprobadas: nums(r.data.comprobadas), borrar: textos(r.data.borrar) };
  void borrarObjetos(data.borrar);
  return { ok: true, data };
}

/** Sube la editada de UNA foto y la registra; si la base no la acepta, se borra el archivo. */
export async function subirEditada(args: {
  unidad: string;
  tomaId: number;
  evidenciaId: number;
  archivo: File;
  hoy: string;
  enTodas?: boolean;
}): Promise<ResRev<ResRevisar>> {
  let archivo = args.archivo;
  try {
    archivo = await comprimirImagen(args.archivo);
  } catch {
    /* sube la original */
  }
  const path = rutaEditada(args.unidad, args.evidenciaId, args.hoy, Date.now(), extensionDe(archivo.name));
  const up = await subirArchivo(path, archivo);
  if (up) return up;
  const r = await revisarFotos(args.tomaId, [args.evidenciaId], 'editada', { editadaPath: path, enTodas: args.enTodas });
  // Sin red no se sabe si quedó: el archivo se deja (si quedó, se usa; si no, lo limpia la purga).
  if (!r.ok && !r.sinRed) void borrarObjetos([path]);
  return r;
}

export async function rechazarFotos(tomaId: number, evidenciaIds: number[], motivo: string): Promise<ResRev<{ rechazadas: number }>> {
  const r = await llamar<Record<string, unknown>>('comp_rechazar_fotos', { p_toma_id: tomaId, p_evidencia_ids: evidenciaIds, p_motivo: motivo });
  if (!r.ok) return r;
  void borrarObjetos(textos(r.data.borrar));
  return { ok: true, data: { rechazadas: num(r.data.rechazadas) } };
}

export async function regresarToma(tomaId: number, motivo: string): Promise<ResRev<{ fotos: number }>> {
  const r = await llamar<Record<string, unknown>>('comp_regresar_toma', { p_toma_id: tomaId, p_motivo: motivo });
  if (!r.ok) return r;
  return { ok: true, data: { fotos: num(r.data.fotos) } };
}

export async function reabrirToma(tomaId: number, motivo: string): Promise<ResRev<true>> {
  const r = await llamar<Record<string, unknown>>('comp_reabrir_toma', { p_toma_id: tomaId, p_motivo: motivo });
  return r.ok ? { ok: true, data: true } : r;
}

/** comp_comprobar_toma (respaldo). 'incompleta' trae en detalle.faltan y detalle.sin_revisar. */
export async function comprobarToma(tomaId: number): Promise<ResRev<true>> {
  const r = await llamar<Record<string, unknown>>('comp_comprobar_toma', { p_toma_id: tomaId });
  return r.ok ? { ok: true, data: true } : r;
}

// ------------------------------------------------------------
// Modo y capturas de cámara
// ------------------------------------------------------------

export type ResPonerModo = {
  cambiadas: number;
  sin_cambio: number;
  cerradas_omitidas: number;
  enviadas_conservan: number;
  mixto_sin_camara: number;
  con_fotos: number;
};

/**
 * comp_poner_modo (Supervisor o manager). posCamara solo en mixto; null =
 * deja las que tenía (o la Corta, si entra a mixto). Biobox solo campo: la
 * base lo rechaza (CP002).
 */
export async function ponerModo(campanaIds: number[], modo: ModoToma, posCamara: string[] | null): Promise<ResRev<ResPonerModo>> {
  const r = await llamar<Record<string, unknown>>('comp_poner_modo', { p_campana_ids: campanaIds, p_modo: modo, p_pos_camara: posCamara });
  if (!r.ok) return r;
  const d = r.data;
  return {
    ok: true,
    data: {
      cambiadas: num(d.cambiadas),
      sin_cambio: num(d.sin_cambio),
      cerradas_omitidas: num(d.cerradas_omitidas),
      enviadas_conservan: num(d.enviadas_conservan),
      mixto_sin_camara: num(d.mixto_sin_camara),
      con_fotos: num(d.con_fotos),
    },
  };
}

export type ResCaptura = {
  ya: boolean;
  evidencia_id: number | null;
  ligadas: number[];
  cerradas: number[];
  futuras: number[];
  ajenas: number[];
  no_camara: number[];
  fuera_periodo: number[];
  duplicadas: number[];
  comprobadas: number[];
};

function newCliente(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Sube una captura de cámara (desde la computadora) y la liga a unas tomas
 * del mismo sitio (comp_subir_captura). Se comprime como las fotos de campo
 * (1600 px). Si la base no la liga a ninguna toma, el archivo se borra.
 */
export async function subirCaptura(args: {
  unidad: string;
  sitioClave: string;
  tomaIds: number[];
  pos: string;
  momento: 'dia' | 'noche' | null;
  dia: string;
  archivo: File;
  /** El intento anterior que quedó sin respuesta: se reusan su cliente_id y su ruta. */
  reintento?: { cid: string; path: string } | null;
}): Promise<ResRev<ResCaptura>> {
  let archivo = args.archivo;
  try {
    archivo = await comprimirImagen(args.archivo);
  } catch {
    /* sube la original */
  }
  const cid = args.reintento?.cid ?? newCliente();
  const path = args.reintento?.path ?? rutaCaptura(args.unidad, args.sitioClave, args.dia, cid, extensionDe(archivo.name));
  const up = await subirArchivo(path, archivo, !!args.reintento);
  if (up) return up.sinRed ? { ...up, reintento: { cid, path } } : up;
  const r = await llamar<Record<string, unknown>>('comp_subir_captura', {
    p_cliente_id: cid,
    p_path: path,
    p_toma_ids: args.tomaIds,
    p_pos: args.pos,
    p_momento: args.momento,
    p_dia: args.dia,
  });
  if (!r.ok) {
    if (!r.sinRed) void borrarObjetos([path]);
    // Sin respuesta pudo quedar registrada: el reintento reusa cliente_id y ruta (la base contesta «ya»).
    return r.sinRed ? { ...r, reintento: { cid, path } } : r;
  }
  const d = r.data;
  const data: ResCaptura = {
    ya: d.ya === true,
    evidencia_id: d.evidencia_id == null ? null : num(d.evidencia_id),
    ligadas: nums(d.ligadas),
    cerradas: nums(d.cerradas),
    futuras: nums(d.futuras),
    ajenas: nums(d.ajenas),
    no_camara: nums(d.no_camara),
    fuera_periodo: nums(d.fuera_periodo),
    duplicadas: nums(d.duplicadas),
    comprobadas: nums(d.comprobadas),
  };
  if (data.evidencia_id == null) void borrarObjetos([path]);
  return { ok: true, data };
}

/** comp_quitar_captura: de una toma o entera; si se borra, también el archivo. */
export async function quitarCaptura(clienteId: string, tomaId: number | null): Promise<ResRev<{ borrada: boolean; quedan: number }>> {
  const r = await llamar<Record<string, unknown>>('comp_quitar_captura', { p_cliente_id: clienteId, p_toma_id: tomaId });
  if (!r.ok) return r;
  const path = txt(r.data.path);
  if (r.data.borrada === true && path) void borrarObjetos([path]);
  return { ok: true, data: { borrada: r.data.borrada === true, quedan: num(r.data.quedan) } };
}
