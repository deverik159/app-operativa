// ============================================================
// src/lib/avisoNuc.ts
// Aviso NUC (Erik, 29-oct-2026): Digital detecta a distancia que el NUC de
// una máquina Biobox está fuera de línea, lo repara y lo vuelve a poner en
// línea; el técnico de Op. Bio Box de la unidad se entera de cada paso.
// Desde el 4-nov-2026 también las pantallas digitales de Ecovallas y las
// columnas y pórticos de Vía Verde (ahí se enteran el coordinador, el
// validador, Digital y quien el manager agregue a mano).
// Aquí va lo que no toca la red: quién es quién, el estado de cada máquina,
// el orden del tablero, los textos de tiempo y los días fuera de línea del
// gráfico. La base repite las mismas reglas (nuc_es_digital, nuc_es_tecnico,
// nuc_puede_ver, nuc_avisar_tecnicos; la última versión en la migración
// 20261104195800_aviso_nuc_ecovallas_via_verde): la pantalla solo evita
// ofrecer lo que la base va a rechazar.
// ============================================================
import { UNIDADES_BIOBOX } from './constants';
import { inicioDiaCdmx } from './fechasCdmx';
import { sinAcentos } from './helpers';
import type { Tono } from './tonos';

/** Unidades del tablero, en el orden en que se enseñan. */
export const UNIDADES_AVISO_NUC: readonly string[] = [...UNIDADES_BIOBOX, 'Ecovallas', 'Vía Verde'];

/** Biobox y Biobox Perú: ahí avisa el técnico de Op. Bio Box. */
export const esUnidadBiobox = (u: string | null | undefined): boolean =>
  UNIDADES_BIOBOX.some((b) => sinAcentos(b) === sinAcentos((u || '').trim()));

/** Vía Verde: solo estos muebles (el sitio de pruebas es «Otro»). */
export const MUEBLES_VV_NUC: readonly string[] = ['Columna', 'Pórticos'];

/**
 * ¿Esta cara del inventario entra al tablero? Biobox todas (todas las
 * máquinas tienen NUC); Ecovallas solo las pantallas digitales; Vía Verde
 * solo columnas y pórticos. Igual que nuc_aviso_abrir.
 */
export function entraEnTablero(f: { unidad_negocio: string | null; tipo_medio: string | null; tipo_mueble: string | null }): boolean {
  if (esUnidadBiobox(f.unidad_negocio)) return true;
  const u = sinAcentos((f.unidad_negocio || '').trim());
  if (u === 'ecovallas') return f.tipo_medio === 'Digital';
  if (u === 'via verde') return MUEBLES_VV_NUC.includes(f.tipo_mueble || '');
  return false;
}

/**
 * Estado del NUC de una máquina. Sin aviso abierto = en_linea. «En revisión»
 * se quitó el 30-oct-2026 (Erik): todo lo hace Digital, no hacía falta.
 */
export type EstadoNuc = 'fuera_linea' | 'en_linea';

/** Estado de un evento del historial: los de antes del 30-oct pueden decir en_revision. */
export type EstadoEventoNuc = EstadoNuc | 'en_revision';

/** tabla `nuc_avisos`. */
export interface AvisoNuc {
  id: number;
  site_id: string;
  unidad_negocio: string;
  maquina: string | null;
  estado: EstadoNuc;
  nota_digital: string | null;
  abierto_por: string;
  abierto_en: string;
  /** Quién lo tomó con «Estoy revisándolo» (solo avisos de antes del 30-oct). */
  tomado_por: string | null;
  tomado_en: string | null;
  cerrado_por: string | null;
  cerrado_en: string | null;
  /** Qué hizo Digital para ponerlo en línea (una de RESPUESTAS_DIGITAL). */
  nota_cierre: string | null;
  /** Foto del cierre en el bucket evidencias (nuc/<id>/…); obligatoria desde el 30-oct. */
  foto_cierre: string | null;
  /**
   * Foto de cuando Digital lo marcó fuera de línea (nuc/fuera/…); obligatoria
   * desde el 4-nov-2026 (migración 20261104171200). Los avisos de antes no la tienen.
   */
  foto_abierto: string | null;
  actualizado_en: string;
}

/** tabla `nuc_avisos_eventos`. «tomado» solo queda en el historial viejo. */
export interface EventoNuc {
  id: number;
  aviso_id: number;
  accion: 'abierto' | 'tomado' | 'en_linea';
  estado: EstadoEventoNuc;
  por: string;
  en: string;
  nota: string | null;
}

/** Fila de `inventario` que hace falta para el tablero. */
export interface FilaInventarioNuc {
  site_id: string | null;
  site_legacy_id: string | null;
  vendor_face_id: string | null;
  unidad_negocio: string | null;
  tipo_medio: string | null;
  tipo_mueble: string | null;
  direccion: string | null;
  municipio: string | null;
}

/** Una máquina del tablero (una por site_id). */
export interface MaquinaNuc {
  site_id: string;
  nombre: string;
  unidad_negocio: string;
  tipo_mueble: string | null;
  direccion: string | null;
  municipio: string | null;
}

export const ESTADOS_NUC: readonly EstadoNuc[] = ['fuera_linea', 'en_linea'];

export const ETIQUETA_NUC: Record<EstadoNuc, string> = {
  fuera_linea: 'Fuera de línea',
  en_linea: 'En línea',
};

/** Colores; en_revision solo para pintar el historial viejo. */
export const TONO_NUC: Record<EstadoEventoNuc, Tono> = {
  fuera_linea: 'rojo',
  en_revision: 'ambar',
  en_linea: 'verde',
};

/**
 * Lo que Digital puede responder al ponerlo en línea: una es obligatoria y
 * no hay nota libre (Erik, 30-oct-2026). La base acepta exactamente estas
 * (nuc_aviso_en_linea, migración 20261030182357).
 */
export const RESPUESTAS_DIGITAL: readonly string[] = [
  'Se reinició el NUC',
  'Se restableció la red',
  'VPN apagada',
];

type Rol = { rol: string; unidad_negocio: string | null; departamento: string | null; medio?: string | null };

const igual = (a: string | null | undefined, b: string) =>
  sinAcentos((a || '').trim()) === sinAcentos(b);

/** Digital: técnico con área Digital de cualquier unidad, o el manager. */
export function esDigitalNuc(roles: Rol[]): boolean {
  return roles.some((r) => r.rol === 'manager' || (r.rol === 'reparacion' && igual(r.departamento, 'digital')));
}

/**
 * Técnico de la máquina (recibe los avisos): técnico de Op. Bio Box de la
 * unidad, coordinador de la unidad sin área o de Op. Bio Box, o el manager.
 * Fila sin unidad = todas.
 */
export function esTecnicoNuc(roles: Rol[], unidad: string): boolean {
  // Ecovallas y Vía Verde no tienen área Op. Bio Box: ahí es recibeNucOtra.
  if (!esUnidadBiobox(unidad)) return roles.some((r) => r.rol === 'manager');
  return roles.some((r) => {
    if (r.rol === 'manager') return true;
    if (r.unidad_negocio && !igual(r.unidad_negocio, unidad)) return false;
    if (r.rol === 'reparacion') return igual(r.departamento, 'op. bio box');
    if (r.rol === 'coordinador') return !r.departamento || igual(r.departamento, 'op. bio box');
    return false;
  });
}

/**
 * Validador de la unidad (Erik, 29-oct-2026): también recibe los avisos y ve
 * el tablero, sin botones. Solo con esa unidad exacta, como la base.
 */
export function esValidadorNuc(roles: Rol[], unidad: string): boolean {
  return roles.some(
    (r) =>
      r.rol === 'validador' &&
      !!r.unidad_negocio &&
      igual(r.unidad_negocio, unidad) &&
      // Fuera de Biobox, solo el de Digital o el de todos los medios: el de
      // Impreso de Ecovallas no (Erik, 4-nov-2026).
      (esUnidadBiobox(unidad) || !r.medio || igual(r.medio, 'digital'))
  );
}

/**
 * Ecovallas y Vía Verde (Erik, 4-nov-2026): recibe los avisos el
 * coordinador de la unidad sin área o de Digital, y Digital (técnico o
 * coordinador) de la unidad o de todas. Como nuc_avisar_tecnicos.
 */
export function recibeNucOtra(roles: Rol[], unidad: string): boolean {
  if (esUnidadBiobox(unidad)) return false;
  return roles.some((r) => {
    const deUnidad = !!r.unidad_negocio && igual(r.unidad_negocio, unidad);
    const digital = igual(r.departamento, 'digital');
    if (r.rol === 'coordinador' && deUnidad && (!r.departamento || digital)) return true;
    return (r.rol === 'reparacion' || r.rol === 'coordinador') && digital && (!r.unidad_negocio || deUnidad);
  });
}

/**
 * Unidades cuyo tablero puede abrir: Digital, manager y Consulta ven todas;
 * el técnico, el coordinador y el validador, las de sus filas; quien el
 * manager agregó a mano (`extras`), esas. Lista vacía = no ve el módulo.
 */
export function unidadesAvisoNuc(roles: Rol[], extras: readonly string[] = []): string[] {
  if (esDigitalNuc(roles) || roles.some((r) => r.rol === 'viewer')) return [...UNIDADES_AVISO_NUC];
  return UNIDADES_AVISO_NUC.filter(
    (u) =>
      esTecnicoNuc(roles, u) ||
      esValidadorNuc(roles, u) ||
      extras.some((x) => igual(x, u)) ||
      roles.some((r) => r.rol === 'coordinador' && (!r.unidad_negocio || igual(r.unidad_negocio, u)))
  );
}

/** Cuántas máquinas de cada unidad hay en cada estado (para el desglose). */
export function contarPorUnidad(
  maquinas: Pick<MaquinaNuc, 'site_id' | 'unidad_negocio'>[],
  avisos: Map<string, Pick<AvisoNuc, 'estado'>>
): Record<EstadoNuc, Record<string, number>> {
  const n: Record<EstadoNuc, Record<string, number>> = { fuera_linea: {}, en_linea: {} };
  for (const m of maquinas) {
    const e = estadoNuc(avisos.get(m.site_id));
    n[e][m.unidad_negocio] = (n[e][m.unidad_negocio] || 0) + 1;
  }
  return n;
}

/** Un día del gráfico: cuánto estuvo fuera de línea y cuántas veces se cayó. */
export interface DiaNuc {
  /** 'YYYY-MM-DD' en CDMX. */
  dia: string;
  /** Minutos fuera de línea ese día (0 a 1440). */
  minutos: number;
  /** Avisos abiertos ese día (cada «Marcar fuera de línea» cuenta uno). */
  caidas: number;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/** El día siguiente de 'YYYY-MM-DD' (calendario, sin zona). */
export function diaSiguiente(dia: string): string {
  return new Date(Date.parse(dia + 'T00:00:00Z') + DIA_MS).toISOString().slice(0, 10);
}

/**
 * Día por día, de `desde` a `hasta` (inclusive, días de CDMX): minutos fuera
 * de línea y veces que se cayó. Un aviso abierto cuenta hasta `ahora`. Los
 * avisos de una máquina no se enciman (solo hay uno abierto a la vez), así
 * que los minutos se suman. Rango inválido o al revés = lista vacía; tope de
 * 400 días para no colgar el teléfono.
 */
export function diasFueraDeLinea(
  avisos: Pick<AvisoNuc, 'abierto_en' | 'cerrado_en'>[],
  desde: string,
  hasta: string,
  ahora: number = Date.now()
): DiaNuc[] {
  const tramos = avisos
    .map((a) => ({ ini: Date.parse(a.abierto_en), fin: a.cerrado_en ? Date.parse(a.cerrado_en) : ahora }))
    .filter((t) => !Number.isNaN(t.ini) && !Number.isNaN(t.fin) && t.fin >= t.ini);
  const salida: DiaNuc[] = [];
  let dia = desde;
  const primero = inicioDiaCdmx(dia);
  if (primero === null || inicioDiaCdmx(hasta) === null || hasta < desde) return salida;
  let ini: number = primero;
  while (dia <= hasta && salida.length < 400) {
    const sig = diaSiguiente(dia);
    const fin: number = inicioDiaCdmx(sig) ?? ini + DIA_MS;
    let ms = 0;
    let caidas = 0;
    for (const t of tramos) {
      ms += Math.max(0, Math.min(t.fin, fin) - Math.max(t.ini, ini));
      if (t.ini >= ini && t.ini < fin) caidas++;
    }
    salida.push({ dia, minutos: Math.min(1440, Math.round(ms / 60000)), caidas });
    dia = sig;
    ini = fin;
  }
  return salida;
}

/** '3 h 20 min', '45 min', '24 h'. Para el gráfico y su tabla. */
export function duracionTexto(minutos: number): string {
  if (minutos <= 0) return '0 min';
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Una máquina por site_id. El nombre y el mueble salen de la cara digital si
 * la hay (como nuc_aviso_abrir), si no de la primera.
 */
export function maquinasDeInventario(filas: FilaInventarioNuc[]): MaquinaNuc[] {
  const porSitio = new Map<string, FilaInventarioNuc>();
  for (const f of filas) {
    if (!f.site_id || !entraEnTablero(f)) continue;
    const previa = porSitio.get(f.site_id);
    if (!previa || (previa.tipo_medio !== 'Digital' && f.tipo_medio === 'Digital')) porSitio.set(f.site_id, f);
  }
  return [...porSitio.values()].map((f) => ({
    site_id: f.site_id as string,
    nombre: f.site_legacy_id || (f.site_id as string),
    unidad_negocio: f.unidad_negocio || '',
    tipo_mueble: f.tipo_mueble,
    direccion: f.direccion,
    municipio: f.municipio,
  }));
}

/** Estado del NUC: con aviso abierto, fuera de línea; si no hay, en línea. */
export function estadoNuc(aviso: { estado: string } | null | undefined): EstadoNuc {
  return aviso && aviso.estado !== 'en_linea' ? 'fuera_linea' : 'en_linea';
}

/** Cuántas máquinas hay en cada estado. */
export function contarEstados(
  maquinas: Pick<MaquinaNuc, 'site_id'>[],
  avisos: Map<string, Pick<AvisoNuc, 'estado'>>
): Record<EstadoNuc, number> {
  const n: Record<EstadoNuc, number> = { fuera_linea: 0, en_linea: 0 };
  for (const m of maquinas) n[estadoNuc(avisos.get(m.site_id))]++;
  return n;
}

const PESO: Record<EstadoNuc, number> = { fuera_linea: 0, en_linea: 1 };

/**
 * Orden del tablero: primero las fuera de línea (la más vieja arriba: es la
 * que más lleva esperando) y al final las en línea por clave del mueble, que
 * es lo que el tablero enseña arriba.
 */
export function ordenarTablero<M extends Pick<MaquinaNuc, 'site_id'>>(
  maquinas: M[],
  avisos: Map<string, Pick<AvisoNuc, 'estado' | 'actualizado_en'>>
): M[] {
  return maquinas.slice().sort((a, b) => {
    const aa = avisos.get(a.site_id);
    const ab = avisos.get(b.site_id);
    const d = PESO[estadoNuc(aa)] - PESO[estadoNuc(ab)];
    if (d) return d;
    if (aa && ab && aa.estado !== 'en_linea') {
      const t = Date.parse(aa.actualizado_en) - Date.parse(ab.actualizado_en);
      if (t) return t;
    }
    return a.site_id.localeCompare(b.site_id, undefined, { numeric: true });
  });
}

/** 'hace 5 min', 'hace 2 h 15 min', 'hace 3 días'. Para leerse rápido. */
export function haceCuanto(iso: string | null | undefined, ahora: number = Date.now()): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const min = Math.max(0, Math.floor((ahora - ms) / 60000));
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
  const dias = Math.floor(h / 24);
  return `hace ${dias} día${dias === 1 ? '' : 's'}`;
}

/**
 * Número del menú: cuántas máquinas siguen fuera de línea. A quien recibe los
 * avisos de una unidad (técnico, validador, coordinador o Digital de
 * Ecovallas y Vía Verde, o agregado a mano), las de esa unidad; a Digital,
 * todas (las tiene que atender). Cada aviso cuenta una vez aunque la persona
 * sea varias cosas.
 */
export function pendientesNuc(
  avisos: { estado: string; unidad_negocio: string }[],
  roles: Rol[],
  extras: readonly string[] = []
): number {
  const digital = esDigitalNuc(roles);
  return avisos.filter(
    (a) =>
      a.estado !== 'en_linea' &&
      (digital ||
        esTecnicoNuc(roles, a.unidad_negocio) ||
        esValidadorNuc(roles, a.unidad_negocio) ||
        recibeNucOtra(roles, a.unidad_negocio) ||
        extras.some((x) => igual(x, a.unidad_negocio)))
  ).length;
}

/** Busca por nombre visible, clave o dirección, sin acentos. */
export function coincideMaquina(m: MaquinaNuc, q: string): boolean {
  const t = sinAcentos(q.trim());
  return !t || sinAcentos([m.nombre, m.site_id, m.direccion, m.municipio].join(' ')).includes(t);
}
