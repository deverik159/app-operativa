// ============================================================
// src/lib/revisionTomas.ts
// Revisión de tomas dentro de «Mis campañas» (fase 3, incremento 3;
// 29-oct-2026). PURA: sin red, sin React, sin base; la prueba
// tests/revisionTomas.test.mjs.
//
// QUÉ HACE. Ordena lo que lee revisionApi.ts para pintarlo:
//   · la parte de campo y la de cámara de cada toma (modo campo, cámaras o
//     mixto; spec §11): la plantilla enviada si la toma espera revisión o ya
//     se comprobó, si no la vigente de la campaña, igual que la base;
//   · en qué bandeja va cada toma (Por revisar, Devueltas, Comprobadas, Por
//     capturar) y el filtro de días;
//   · las fotos de una toma con su número, su nombre y su estado de revisión;
//   · las rutas de Storage de una captura y de una editada (las mismas que
//     valida la base) y los textos de lo que contestan las RPC.
//
// ESPEJO DE LA BASE. Quien decide es la base (comp_comprobar_si_revisada,
// comp_faltan, comp_plantilla_toma de la migración comp_f3_revision). Aquí
// solo se repite la cuenta para enseñar «Falta la Corta de cámaras» sin
// otra consulta. Si cambia una regla allá, cambia aquí y en la prueba.
// ============================================================

import { faltan, type FaltaPos, type PosPlantilla, type TienePos } from './plantillasComp';

export type ModoToma = 'campo' | 'camaras' | 'mixto';
export type EstadoToma = 'pendiente' | 'por_revisar' | 'comprobada' | 'regresada' | 'cancelada';
export type EstadoRevision = 'correcta' | 'editada' | 'rechazada';

/** Lo que la revisión necesita de la campaña (comp_campanas). */
export type CampanaModo = {
  id: number;
  modo_toma: ModoToma;
  /** Mixto: posiciones de la plantilla de testigo que van por cámara. */
  pos_camara: string[];
  /** null = 'unica'. */
  plantilla_codigo: string | null;
};

/** Una toma (comp_tomas) con lo de la revisión. */
export type TomaRev = {
  id: number;
  campana_id: number;
  sitio_id: number;
  fecha: string;
  estado: EstadoToma;
  monitorista_email: string | null;
  tomada_por: string | null;
  enviada_en: string | null;
  /** La plantilla con que se envió (A2); null si no se ha enviado. */
  plantilla_usada: PosPlantilla[] | null;
  regreso_n: number;
  rechazo_motivo: string | null;
  rechazada_por: string | null;
  rechazada_en: string | null;
  comprobada_en: string | null;
  comprobada_por: string | null;
  reabierta_motivo: string | null;
  reabierta_por: string | null;
  reabierta_en: string | null;
};

/** Una foto ligada a una toma, con su revisión en esa toma. */
export type FotoRev = {
  evidencia_id: number;
  toma_id: number;
  cliente_id: string;
  path: string;
  tipo: 'foto' | 'video';
  pos: string;
  momento: 'dia' | 'noche' | null;
  /** Día de la foto (CDMX), el que pone la base. */
  fecha: string;
  origen: 'campo' | 'camara';
  subido_por: string;
  creado_en: string;
  tomada_en_tel: string | null;
  /** La liga ya no cuenta en esta toma (rechazada o devuelta). */
  devuelta: boolean;
  revision: {
    estado: EstadoRevision;
    motivo: string | null;
    editada_path: string | null;
    revisado_por: string;
    revisado_en: string;
  } | null;
  /** En cuántas OTRAS tomas está ligada y vigente (M5: «también en N versiones»). */
  otras_tomas: number;
};

// ------------------------------------------------------------
// Plantilla: la parte de campo y la de cámara
// ------------------------------------------------------------

/** ¿La posición va por cámara en esa campaña? (como comp_plantilla_toma). */
export function vaPorCamara(c: Pick<CampanaModo, 'modo_toma' | 'pos_camara'>, pos: string): boolean {
  return c.modo_toma === 'camaras' || (c.modo_toma === 'mixto' && c.pos_camara.includes(pos));
}

/**
 * La plantilla de testigo de la campaña con su «via», como la arma la base.
 * La capa de mueble (Biobox) siempre es de campo y Biobox siempre es campo,
 * así que aquí basta con la de testigo.
 */
export function conVia(testigo: readonly PosPlantilla[], c: Pick<CampanaModo, 'modo_toma' | 'pos_camara'>): PosPlantilla[] {
  return testigo.map((q) => {
    const { via: _v, ...resto } = q;
    return vaPorCamara(c, q.pos) ? { ...resto, via: 'camara' as const } : resto;
  });
}

/**
 * La plantilla que cuenta para la toma: la enviada si espera revisión o ya
 * se comprobó; si no, la vigente (la misma regla que comp_subir_captura y
 * comp_registrar_tomas).
 */
export function plantillaDeToma(t: Pick<TomaRev, 'estado' | 'plantilla_usada'>, vigente: readonly PosPlantilla[]): PosPlantilla[] {
  if ((t.estado === 'por_revisar' || t.estado === 'comprobada') && t.plantilla_usada) return t.plantilla_usada;
  return [...vigente];
}

export const parteCampo = (p: readonly PosPlantilla[]) => p.filter((q) => q.via !== 'camara');
export const parteCamara = (p: readonly PosPlantilla[]) => p.filter((q) => q.via === 'camara');

/** Lo que una toma ya tiene: fotos vigentes de un origen, o de los dos ('todas'). */
export function tieneDe(fotos: readonly FotoRev[], origen: 'campo' | 'camara' | 'todas', soloBuenas = false): TienePos[] {
  const m = new Map<string, TienePos>();
  for (const f of fotos) {
    if (f.devuelta || f.tipo !== 'foto' || (origen !== 'todas' && f.origen !== origen)) continue;
    if (soloBuenas && !(f.revision && (f.revision.estado === 'correcta' || f.revision.estado === 'editada'))) continue;
    const k = `${f.pos}|${f.momento ?? ''}`;
    const x = m.get(k);
    if (x) x.n++;
    else m.set(k, { pos: f.pos, momento: f.momento, n: 1 });
  }
  return [...m.values()];
}

/**
 * Lo que le falta a la parte de cámara. Como comp_faltan, cuenta las fotos
 * vigentes de CUALQUIER origen: si la campaña pasó a mixto con una Corta de
 * campo ya subida, esa Corta cubre la posición (revisión adversarial,
 * 29-oct-2026: la app y la base deben decir lo mismo).
 */
export function faltaCamara(plantilla: readonly PosPlantilla[], fotos: readonly FotoRev[]): FaltaPos[] {
  return faltan(parteCamara(plantilla), tieneDe(fotos, 'todas'));
}

// ------------------------------------------------------------
// Estado de una toma para la pantalla
// ------------------------------------------------------------

export type ResumenToma = {
  /** Fotos de campo vigentes. */
  campo: number;
  /** De esas, sin revisión correcta o editada. */
  sinRevisar: number;
  /** Capturas vigentes. */
  camara: number;
  /** Posiciones de cámara que faltan. */
  faltaCamara: FaltaPos[];
  /** Fotos devueltas (rechazadas o de una toma devuelta), para el rastro. */
  devueltas: number;
};

export function resumenToma(plantilla: readonly PosPlantilla[], fotos: readonly FotoRev[]): ResumenToma {
  let campo = 0,
    sinRevisar = 0,
    camara = 0,
    devueltas = 0;
  for (const f of fotos) {
    if (f.devuelta) {
      devueltas++;
      continue;
    }
    if (f.origen === 'camara') {
      camara++;
      continue;
    }
    campo++;
    if (!f.revision || (f.revision.estado !== 'correcta' && f.revision.estado !== 'editada')) sinRevisar++;
  }
  return { campo, sinRevisar, camara, faltaCamara: faltaCamara(plantilla, fotos), devueltas };
}

export type Bandeja = 'por_revisar' | 'devueltas' | 'comprobadas' | 'por_capturar';

/**
 * Bandejas de una toma (puede ir en dos: una por revisar a la que le falta
 * la cámara sale también en Por capturar). Por capturar: solo campañas con
 * parte de cámara, tomas no comprobadas ni canceladas de hoy o antes.
 */
export function bandejasDe(
  t: Pick<TomaRev, 'estado' | 'fecha'>,
  r: { tieneCamara: boolean; faltaCamara: number },
  hoy: string
): Bandeja[] {
  const out: Bandeja[] = [];
  if (t.estado === 'por_revisar') out.push('por_revisar');
  if (t.estado === 'regresada') out.push('devueltas');
  if (t.estado === 'comprobada') out.push('comprobadas');
  if (r.tieneCamara && r.faltaCamara > 0 && (t.estado === 'pendiente' || t.estado === 'por_revisar' || t.estado === 'regresada') && t.fecha <= hoy)
    out.push('por_capturar');
  return out;
}

export type FiltroDia = 'hoy' | 'ayer' | '7' | 'todo';

/** Suma días a una fecha ISO (AAAA-MM-DD), sin zona. */
export function sumarDias(d: string, n: number): string {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** ¿La toma de ese día entra en el filtro? (7 = de hace 6 días a hoy). */
export function enFiltroDia(fecha: string, f: FiltroDia, hoy: string): boolean {
  if (f === 'todo') return true;
  if (f === 'hoy') return fecha === hoy;
  if (f === 'ayer') return fecha === sumarDias(hoy, -1);
  return fecha >= sumarDias(hoy, -6) && fecha <= hoy;
}

// ------------------------------------------------------------
// Fotos: orden, número y nombre
// ------------------------------------------------------------

/**
 * Las fotos de una toma en el orden de su plantilla (posición por posición;
 * lo que la plantilla no pide al final), luego por id. Numera desde 1 SOLO
 * las vigentes, que son las que van a la carpeta; las devueltas van al final
 * sin número.
 */
export function ordenarFotos<T extends Pick<FotoRev, 'evidencia_id' | 'pos' | 'devuelta'>>(
  fotos: readonly T[],
  plantilla: readonly PosPlantilla[]
): (T & { n: number | null })[] {
  const lugar = (pos: string) => {
    const i = plantilla.findIndex((q) => q.pos === pos);
    return i < 0 ? plantilla.length : i;
  };
  const vig = fotos.filter((f) => !f.devuelta).sort((a, b) => lugar(a.pos) - lugar(b.pos) || a.evidencia_id - b.evidencia_id);
  const dev = fotos.filter((f) => f.devuelta).sort((a, b) => a.evidencia_id - b.evidencia_id);
  return [...vig.map((f, i) => ({ ...f, n: i + 1 })), ...dev.map((f) => ({ ...f, n: null }))];
}

/** «COL_551_2910_2»: el sitio, el día de la toma (DDMM) y el número (decisión de Erik, 20-oct-2026). */
export function nombreFoto(sitioClave: string, fecha: string, n: number | null): string {
  const ddmm = fecha.slice(8, 10) + fecha.slice(5, 7);
  return `${sitioClave}_${ddmm}${n ? '_' + n : ''}`.replace(/[^\w.-]/g, '_');
}

/** La ruta que se ve: la editada si la hay, si no la original. */
export function pathVigente(f: Pick<FotoRev, 'path' | 'revision'>): string {
  return f.revision?.estado === 'editada' && f.revision.editada_path ? f.revision.editada_path : f.path;
}

// ------------------------------------------------------------
// Rutas de Storage (las valida la base, parte por parte)
// ------------------------------------------------------------

const SLUG: Record<string, string> = { Ecovallas: 'ecovallas', Biobox: 'biobox', 'Vía Verde': 'via-verde' };

export const slugUnidad = (u: string): string | null => SLUG[u] ?? null;

/** Extensión limpia de un archivo (2 a 5 letras o números); 'jpg' si no sirve. */
export function extensionDe(nombre: string): string {
  const e = (nombre.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return e.length >= 2 && e.length <= 5 && e !== nombre.toLowerCase() ? e : 'jpg';
}

/**
 * comp/<slug>/<AAAA-MM>/<sitio_clave>/<AAAAMMDD>_<cliente_id>.<ext>, con el
 * día de la captura (comp_subir_captura).
 */
export function rutaCaptura(unidad: string, sitioClave: string, dia: string, clienteId: string, ext: string): string {
  const slug = slugUnidad(unidad);
  if (!slug) throw new Error('Unidad sin carpeta: ' + unidad);
  return `comp/${slug}/${dia.slice(0, 7)}/${sitioClave}/${dia.replace(/-/g, '')}_${clienteId}.${ext}`;
}

/** comp-analista/<slug>/<AAAA-MM>/<evidencia_id>_editada_<ms>.<ext> (comp_revisar_fotos). */
export function rutaEditada(unidad: string, evidenciaId: number, hoy: string, ms: number, ext: string): string {
  const slug = slugUnidad(unidad);
  if (!slug) throw new Error('Unidad sin carpeta: ' + unidad);
  return `comp-analista/${slug}/${hoy.slice(0, 7)}/${evidenciaId}_editada_${ms}.${ext}`;
}

/**
 * Días que se pueden elegir para una captura: del más reciente al más
 * viejo, de la ventana [desde, hasta] recortada a hoy (nunca a futuro) y
 * siempre con el día de la toma (como comp_subir_captura).
 */
export function diasCaptura(hoy: string, desde: string, hasta: string, diaToma: string): string[] {
  const ini = desde < diaToma ? desde : diaToma;
  let fin = hasta > diaToma ? hasta : diaToma;
  if (fin > hoy) fin = hoy;
  const out: string[] = [];
  for (let d = fin; d >= ini && out.length < 400; d = sumarDias(d, -1)) out.push(d);
  return out;
}

// ------------------------------------------------------------
// Textos de lo que contestan las RPC de revisión
// ------------------------------------------------------------

const TEXTO_CODIGO: Record<string, string> = {
  ocupada: 'Otra persona está guardando en estas tomas. Espera unos segundos y vuelve a intentar.',
  sin_permiso: 'No puedes revisar esta toma: o no es de tus campañas, o tú subiste fotos de campo en ella.',
  toma_cerrada: 'Esta toma cambió de estado (la comprobaron, la devolvieron o ya no espera revisión). Recarga para verla.',
  incompleta: 'Todavía le falta algo para comprobarla.',
  por_camara: 'Esta toma es de cámaras: no tiene fotos de campo que devolver.',
  comprobada: 'La toma ya está comprobada: reábrela antes de quitar una captura.',
  captura_cerrada: 'La captura todavía no está abierta para tu cuenta. Pídele a Erik que te agregue.',
  sin_objeto: 'El archivo no terminó de subir. Vuelve a intentarlo.',
};

export function textoCodigoRevision(codigo: string | null | undefined): string {
  return (codigo && TEXTO_CODIGO[codigo]) || 'No se pudo completar. Recarga y vuelve a intentar.';
}
