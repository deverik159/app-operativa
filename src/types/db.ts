// ============================================================
// src/types/db.ts
// Tipos TypeScript del esquema de Supabase.
//
// VERIFICADO contra la base (diagnostico_incidencias.sql, ago-2026).
// No son suposiciones: las columnas y sus nulabilidades salen de
// information_schema. Si la base cambia, este archivo se actualiza aquí y
// TypeScript marca todos los usos rotos.
//
// REGLA: la base es COMPARTIDA con el HTML viejo. Estos tipos la describen,
// no la definen.
// ============================================================

// --- Enums de Postgres ---

/** ENUM app_role. OJO: el rol de admin se llama 'manager'. */
export type AppRole =
  | 'reportante'
  | 'validador'
  | 'reparacion'
  | 'manager'
  | 'viewer'
  | 'coordinador'
  | 'fijador';

/** ENUM estatus_incidencia. */
export type EstatusInc =
  | 'reportado'
  | 'por_validar'
  | 'rechazada'
  | 'en_proceso'
  | 'reparado'
  | 'cerrada'
  | 'no_reparado';

export type Nivel = 'Alto' | 'Medio' | 'Bajo';

/** Etapa de una evidencia: al reportar, o al reparar. */
export type EtapaEvidencia = 'reporte' | 'reparacion';

export type TipoEvidencia = 'foto' | 'video';

/** Estatus del archivo de rutas (se guardan tal cual, HANDOFF §4.2). */
export type EstatusArchivo = 'ACTIVA' | 'INHABILITADA' | 'RETIRADA';

/** Estado en la tabla externa de Mario (HANDOFF §4.1). */
export type EstadoFijacionExterna = 'PENDIENTE' | 'COMPLETO' | 'RESUELTO';

// --- incidencias ---

/**
 * tabla `incidencias`. PK = `record_id` (text, no uuid: se genera con
 * crypto.randomUUID().slice(0,8)).
 *
 * Varias columnas las llena la base por trigger, NO el frontend:
 *   folio (set_folio), catorcena/semana/plaza/latitud/longitud (set_derivados),
 *   sla_reparacion_inicio / sla_validacion_inicio (set_sla),
 *   estatus en_proceso automático (inc_auto_en_proceso).
 */
export interface Incidencia {
  record_id: string;
  /** Lo asigna el trigger set_folio. Nunca mandarlo desde el frontend. */
  folio: string | null;

  // Ubicación / valla
  clave_sitio: string | null;
  /** vendor_face_id de la cara afectada. */
  clave_medio: string | null;
  direccion: string | null;
  municipio: string | null;
  /** Estado/plaza. Lo deriva el trigger set_derivados. */
  plaza: string | null;
  tipo_medio: string | null;
  medio: string | null;
  tipo_mueble: string | null;
  nombre_biobox: string | null;
  unidad_negocio: string | null;
  latitud: number | null;
  longitud: number | null;

  // Periodo (derivados por trigger)
  semana: string | null;
  catorcena: number | null;

  // Reporte
  fecha_reporte: string | null;
  hora_reporte: string | null;
  area_reportante: string | null;
  nombre_incidencia: string | null;
  observaciones: string | null;
  campania: string | null;
  nivel: Nivel | string | null;
  origen: string | null;
  tipo: string | null;
  captured_by: string | null;

  // Flujo
  estatus: EstatusInc;
  estatus_inicial: string | null;
  estatus_final: string | null;
  area_responsable: string | null;

  // Validación
  validator_approved: boolean | null;
  validator_email: string | null;
  validator_at: string | null;

  // Asignación de área / técnico
  assigned_to: string | null;
  assigned_area: string | null;
  asignado_tecnico: string | null;
  asignado_tecnico_email: string | null;
  asignado_por: string | null;
  asignado_en: string | null;

  // Reparación
  fecha_reparacion: string | null;
  repaired_by_email: string | null;
  repaired_at: string | null;
  diagnostico: string | null;
  detalle_reparacion: string | null;
  causa_raiz: string | null;
  solucion: string | null;
  motivo_rechazo_reparacion: string | null;

  // Reasignación (NOT NULL, default false)
  reasignacion_pendiente: boolean;

  // Prevalidación — flujo de auto-ruteo fuera del horario del validador
  // (ambas NOT NULL, default false)
  requiere_prevalidacion: boolean;
  prevalidada: boolean;

  // SLA (los pone el trigger set_sla)
  sla_reparacion_inicio: string | null;
  sla_validacion_inicio: string | null;

  creado_en: string | null;
}

/** Campos que el frontend SÍ manda al insertar una incidencia nueva. */
export type IncidenciaNueva = Partial<Incidencia> &
  Pick<Incidencia, 'record_id' | 'estatus'>;

// --- Tablas de apoyo de Incidencias ---

/** tabla `mensajes` — el chat de cada incidencia (realtime). */
export interface Mensaje {
  id: number;
  record_id: string;
  autor_email: string | null;
  autor_nombre: string | null;
  texto: string;
  creado_en: string;
}

/** tabla `notificaciones` — alimenta la campana y el globito de chat. */
export interface Notificacion {
  id: number;
  /** 'chat' | 'incidencia' | 'reasignacion' | 'tecnico' | 'ruta' | 'mantenimiento' */
  evento: string;
  record_id: string | null;
  mensaje: string;
  unidad_negocio: string | null;
  leida: boolean;
  creado_en: string;
}

/** tabla `reasignaciones` — solicitudes de cambio de área responsable. */
export interface Reasignacion {
  reassign_id: string;
  record_id: string;
  folio: string | null;
  unidad_negocio: string | null;
  area_origen: string | null;
  area_destino: string;
  motivo: string | null;
  evidencia: string | null;
  solicitado_por: string | null;
  fecha_solicitud: string | null;
  estado: 'Solicitada' | 'Aprobada' | 'Rechazada';
  resuelta_por: string | null;
  fecha_resolucion: string | null;
  comentario: string | null;
}

/** tabla `evidencias` — fotos/videos de incidencias. */
export interface Evidencia {
  id: number;
  record_id: string | null;
  etapa: EtapaEvidencia;
  tipo: TipoEvidencia | null;
  url: string;
  path: string | null;
  subido_por: string | null;
  creado_en: string | null;
  /** Texto libre: "esquina superior", "cara norte"… */
  referencia: string | null;
}

/** tabla `tecnicos` — catálogo por área para AsignarTecnicoModal. */
export interface Tecnico {
  id: number;
  nombre: string;
  area: string | null;
  email: string | null;
  activo: boolean | null;
}

/** tabla `catalogo_incidencias` — qué fallas se pueden reportar por unidad. */
export interface CatalogoIncidencia {
  detalle: string;
  area: string | null;
  /** Se mapea a incidencias.nivel. Viene con espacios: usar .trim(). */
  impacto: string | null;
  origen: string | null;
  tipo: string | null;
  tipo_mueble: string | null;
  unidad_negocio?: string | null;
}

/** tabla `causas_raiz` — causas por tipo de incidencia (áreas no-Digital). */
export interface CausaRaiz {
  incidencia: string;
  causa: string;
  activo?: boolean | null;
}

/** tabla `arbol_digital` — pares causa→solución guiados, solo área Digital. */
export interface ArbolDigital {
  causa_raiz: string | null;
  solucion: string | null;
  incidencia?: string | null;
}

/** tabla `sla_areas` — horas de SLA por área responsable. */
export interface SlaArea {
  area: string | null;
  area_codigo: string | null;
  sla_horas: string | number | null;
}

// --- Usuarios / roles ---

/** tabla `usuarios`. */
export interface Usuario {
  id: string;
  email: string;
  nombre: string | null;
  telefono: string | null;
}

/**
 * tabla `usuario_roles`. Un usuario puede tener VARIAS filas.
 * unidad_negocio / departamento / medio acotan el alcance del rol y las
 * políticas RLS los usan; el frontend debe respetarlos para no ofrecer
 * acciones que la base va a rechazar.
 */
export interface UsuarioRol {
  id: number;
  usuario_email: string;
  rol: AppRole;
  unidad_negocio: string | null;
  departamento: string | null;
  medio: string | null;
}

// --- Inventario / cuadrillas ---

/**
 * tabla `inventario`. `vendor_face_id` = la cara; `site_id` = la ubicación.
 */
export interface InventarioItem {
  vendor_face_id: string;
  site_id: string | null;
  site_legacy_id: string | null;
  cara: string | null;
  categoria: string | null;
  unidad_negocio: string | null;
  tipo_medio: string | null;
  tipo_mueble: string | null;
  latitud: number | null;
  longitud: number | null;
  direccion: string | null;
  municipio: string | null;
  estado: string | null;
}

/** tabla `cuadrillas`. */
export interface Cuadrilla {
  id: number;
  nombre: string;
  unidad_negocio: string | null;
  creada_por: string | null;
  activa: boolean | null;
  creada_en: string | null;
  actualizada_en: string | null;
}

/** tabla `fijacion_evidencias` (fijación INTERNA — pendiente 9.2). */
export interface FijacionEvidencia {
  id: number;
  selected_face_id: number;
  vendor_face_id: string | null;
  tipo: TipoEvidencia | null;
  url: string;
  path: string | null;
  subido_por: string | null;
  creado_en: string | null;
}

// --- Módulo Rutas de Monitoreo ---

/** tabla `rutas_monitoreo`. UNIQUE(numero, unidad_negocio, tipo_medio). */
export interface RutaMonitoreo {
  id: number;
  numero: number;
  nombre: string | null;
  color: string;
  unidad_negocio: string;
  tipo_medio: string;
  descripcion: string | null;
  activa: boolean;
  creada_en: string | null;
}

/** tabla `ruta_ubicaciones`. UNIQUE(site_id) → una ubicación en una sola ruta. */
export interface RutaUbicacion {
  id: number;
  ruta_id: number;
  site_id: string;
  secuencia: number | null;
  estatus_archivo: EstatusArchivo | null;
  vallas_archivo: number | null;
  direccion_archivo: string | null;
  agregada_en: string | null;
}

// --- Permisos ---

/** Capacidades del usuario, derivadas de sus roles. */
export interface CanInc {
  crear?: boolean;
  validar?: boolean;
  reparar?: boolean;
  reasignar?: boolean;
  aprobarReasign?: boolean;
  asignarTecnico?: boolean;
  /** Dirigir la incidencia al área que de verdad la va a reparar. */
  asignarArea?: boolean;
}

/** Horas de SLA por área en minúsculas. Ej: { mantenimiento: 48 }. */
export type SlaMap = Record<string, number>;

/** Totales del Dashboard. */
export interface StatsInc {
  total: number;
  porValidar: number;
  enProceso: number;
  cerradas: number;
  noRep: number;
  efect: number;
}

// --- Pauta por catorcena (campañas y avance de monitoreo) ---

/** Avance de una cara en la catorcena. Lo calcula la vista. */
export type AvancePauta = 'PENDIENTE' | 'TOMADA' | 'COMPROBADA';

/**
 * Fila de `vw_pauta_ruta`: pauta del archivo + avance registrado en la app
 * + coordenadas del inventario, ya resueltas.
 */
export interface PautaRuta {
  id: number;
  catorcena: number;
  etiqueta: string | null;

  site_id: string;
  vendor_face_id: string;
  cara: string | null;
  direccion: string | null;
  estado: string | null;
  medio: string | null;

  /** Valor tal cual del archivo: '1'..'8', 'PLAZA', 'EDOMEX'. */
  ruta_clave: string | null;
  /** Solo cuando ruta_clave es numérica. Las foráneas van en null. */
  ruta_numero: number | null;
  secuencia: number | null;

  campana: string | null;
  version: string | null;
  campana_anterior: string | null;
  /** NUEVO = hay que fijar. REPITE = el arte se queda. */
  estatus: string | null;
  corte: string | null;
  contract_number: string | null;
  orden_fijacion: string | null;
  fecha_fijacion: string | null;

  // Avance real (lo escribe la app; sobrevive a reimportar).
  fecha_toma: string | null;
  toma_por: string | null;
  fecha_comprobacion: string | null;
  comprobacion_por: string | null;
  // Referencia histórica del archivo.
  fecha_toma_archivo: string | null;
  fecha_comprobacion_archivo: string | null;

  avance: AvancePauta;
  /** Cuántos archivos de evidencia lleva esta cara en esta catorcena. */
  fotos: number;

  latitud: number | null;
  longitud: number | null;
  /** Ya calculado por la vista: si es false, no hay a dónde navegar. */
  navegable: boolean;

  ruta_monitoreo_id: number | null;
}

/** Fila de `vw_pauta_resumen`: totales por ruta y campaña. */
export interface PautaResumen {
  catorcena: number;
  ruta_clave: string | null;
  campana: string | null;
  caras: number;
  sitios: number;
  nuevas: number;
  repiten: number;
  pendientes: number;
  tomadas: number;
  comprobadas: number;
  sin_coordenadas: number;
}
