// ============================================================
// src/modules/comprobaciones/tiposComp.ts
// Contrato entre ComprobacionesView (el esqueleto) y sus pestañas
// (Erik, 23-oct-2026). Cada pestaña es su propio archivo y recibe estas
// props: así se puede llenar una sin tocar el esqueleto ni las demás.
//
// El esqueleto ya resuelve: unidad (solo las de la persona), periodo
// (catorcena en Ecovallas Digital, mes en Biobox y Vía Verde), permisos
// por unidad, la lista de campañas del periodo (vw_comp_campanas, paginada
// y con recarga silenciosa), el equipo de la unidad, el candado de una
// escritura a la vez y el aviso breve de «✓ hecho».
// ============================================================

import type { UnidadComp } from '../../lib/comprobaciones';
import type { MiembroEquipo, PeriodoCargado, PeriodoSel, VwCampana } from '../../lib/comprobacionesApi';

/** Pestañas del módulo. */
export type VistaComp = 'armar' | 'campanas' | 'formato' | 'avance' | 'excel' | 'mis';

export const ETIQUETA_VISTA: Record<VistaComp, string> = {
  armar: 'Armar',
  campanas: 'Campañas',
  formato: 'Formato',
  avance: 'Avance',
  excel: 'Excel',
  mis: 'Mis campañas',
};

/**
 * Qué puede hacer la persona EN LA UNIDAD elegida. Rol y unidad salen de
 * la misma fila de usuario_roles (unidadesComprobaciones). Es solo para
 * enseñar u ocultar botones: la que decide es la base (cada RPC valida).
 */
export type PermisosComp = {
  /** Supervisor de la unidad o manager: arma, asigna, edita, cierra, descarga. */
  gestiona: boolean;
  /** Lee toda la unidad: supervisor, coordinador o manager. */
  leeTodo: boolean;
  /** Coordinador (sin supervisor): Campañas y Avance en solo lectura (P3). */
  soloLectura: boolean;
  /** Tiene fila de analista en la unidad: ve «Mis campañas» y marca lo suyo. */
  esAnalista: boolean;
};

/** Lo que comparten todas las pestañas. */
export type ContextoComp = {
  unidad: UnidadComp;
  /** Correo de la sesión, en minúsculas. */
  email: string;
  permisos: PermisosComp;
  /**
   * comp_equipo de la unidad (analistas asignables y supervisores). Vacío
   * si quien entra no lee toda la unidad (el analista no puede pedirlo).
   */
  equipo: MiembroEquipo[];
  /** Nombre para mostrar de un correo (del equipo; si no, el correo). '' si no hay correo. */
  nombreDe: (email: string | null | undefined) => string;
  /**
   * Vuelve a leer las campañas del periodo SIN desmontar la pestaña ni sus
   * modales (la lista sigue en pantalla con la clase .recargando).
   * `periodos: true` también relee los periodos: úsalo después de la
   * primera carga de un periodo nuevo (así el selector recibe su id).
   */
  recargar: (op?: { periodos?: boolean }) => void;
  /**
   * Candado de UNA escritura a la vez en todo el módulo (como ocupadoModulo
   * de AnalistaPauta). Mientras corre, el esqueleto bloquea el cambio de
   * pestaña, unidad y periodo. Si ya hay otra corriendo, no llama `fn` y
   * devuelve undefined. Los errores de `fn` se dejan pasar: la pestaña los
   * enseña en su .err con textoFallaEscrituraComp.
   */
  correr: <T>(etiqueta: string, fn: () => Promise<T>) => Promise<T | undefined>;
  /** Etiqueta de la escritura en curso («Asignando…»), o null. */
  ocupado: string | null;
  /** Aviso breve de éxito con role="status" («✓ 12 asignadas a Ángel»). */
  avisar: (texto: string) => void;
  /** ≤ 780 px (el armazón móvil): pintar UNA sola versión, tarjetas o tabla. */
  telefono: boolean;
};

/**
 * Props de Campañas, Formato, Avance, Excel y Mis campañas: siempre con un
 * periodo YA armado (id de comp_periodos). Sin periodo armado el esqueleto
 * no las pinta y dice «ármalo en Armar».
 */
export type PropsPestanaComp = ContextoComp & {
  periodo: PeriodoCargado;
  /**
   * vw_comp_campanas del periodo y la unidad, TODAS las que la RLS deja ver
   * (también retiradas y cerradas). Al analista la base ya le da solo las
   * suyas; Victor es Supervisor Y analista, así que «Mis campañas» debe
   * filtrar por analista_email === email.
   */
  campanas: VwCampana[];
  /** Leyendo la lista la primera vez (campanas vacía). */
  cargando: boolean;
  /** Releyendo en silencio (campanas sigue con lo anterior). */
  recargando: boolean;
};

/**
 * Props de Armar: el periodo puede no existir todavía (id null). La
 * primera carga (comp_cargar_campanas) lo crea; después llamar
 * recargar({ periodos: true }).
 */
export type PropsArmar = ContextoComp & {
  periodo: PeriodoSel;
  /** Las ya cargadas en el periodo ([] si id es null). */
  campanas: VwCampana[];
  cargando: boolean;
  recargando: boolean;
};
