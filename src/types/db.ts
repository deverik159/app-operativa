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
 * QUÉ LLENA LA BASE Y QUÉ NO. Verificado leyendo las funciones el
 * 26-ago-2026; el comentario anterior estaba equivocado y por eso se deja
 * escrito el detalle:
 *
 *   folio                  → set_folio,  BEFORE INSERT
 *   semana, catorcena      → set_derivados, BEFORE INSERT. Solo eso, y solo
 *                            si vienen en null. NO toca la ubicación.
 *   sla_reparacion_inicio  → set_sla, BEFORE INSERT + UPDATE. Se reinicia al
 *                            ENTRAR a 'en_proceso' y también si cambia
 *                            `area_responsable` estando ya en 'en_proceso'.
 *   sla_validacion_inicio  → set_sla, al entrar a 'reparado'.
 *   estatus 'en_proceso'   → inc_auto_en_proceso, BEFORE INSERT.
 *
 * LO QUE MANDA EL FRONTEND, aunque parezca derivado: direccion, municipio,
 * plaza, medio, tipo_mueble y nombre_biobox. Se copian de `inventario` al
 * capturar (NuevaInc) y hay que volver a copiarlos si alguien cambia la
 * clave de sitio o la cara (EditModal). Nada del lado del servidor los
 * recalcula.
 *
 * COLUMNAS MUERTAS: `latitud` y `longitud`. Ningún trigger las escribe y
 * ningún componente las lee — la navegación sale de `inventario`. Solo traen
 * dato en filas migradas del sistema viejo.
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
  /**
   * 'Norte' | 'Sur' | 'Ambas'. Solo se captura en las unidades de
   * UNIDADES_CON_LADO (hoy Vía Verde). NULL en el resto y en todo lo
   * capturado antes de ago-2026. La base tiene un CHECK que solo acepta esos
   * tres valores o NULL — ver incidencias_lado.sql.
   */
  lado: string | null;
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
  /**
   * ── Columnas del flujo de asignación a técnico, retirado en ago-2026 ──
   * Ya nada las escribe. Se conservan con lo que tenían porque son histórico
   * real de quién estuvo asignado a qué. Ver quitar_asignacion_tecnico.sql y
   * la nota al final de components/IncCard.tsx.
   */
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

/**
 * tabla `chat_adjuntos` — fotos y videos cortos del chat.
 *
 * Son TEMPORALES: un proceso diario los borra de Storage cuando la incidencia
 * cierra. La fila sobrevive con `purgado_en` lleno, para poder mostrar
 * "archivo eliminado" en el hilo en vez de un hueco sin explicación.
 * La evidencia que debe perdurar va por 📎 Evidencia, a `evidencias`.
 */
export interface ChatAdjunto {
  id: number;
  record_id: string;
  mensaje_id: number;
  tipo: 'foto' | 'video';
  url: string;
  path: string;
  nombre: string | null;
  bytes: number | null;
  subido_por: string;
  creado_en: string;
  /** Con fecha = el archivo ya no existe en Storage. */
  purgado_en: string | null;
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

/**
 * tabla `tecnicos` — padrón de campo por área.
 *
 * Ya no se usa para asignar (ese flujo se quitó en ago-2026), pero sigue
 * viva: de aquí salen los nombres del ranking "Quién repara más" en los
 * indicadores. Ver lib/nombres.ts.
 */
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
  /**
   * Opcional a propósito: no está confirmado que la tabla tenga esta columna
   * hoy. Por eso las consultas del catálogo usan `select('*')` — pedirla por
   * nombre daría error 400 de PostgREST si no existe, y el modal se quedaría
   * en blanco. Con `*` viene si está y no estorba si no.
   *
   * Cuando existe, es el criterio con MÁS peso para desempatar entre copias
   * de la misma incidencia: es el que decide el área. Ver lib/catalogo.ts.
   */
  tipo_medio?: string | null;
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

// --- Módulo de revisiones / hoja de vida (Biobox) ---

/** Cómo quedó un punto del checklist. */
export type ValorRespuesta = 'ok' | 'anomalia' | 'na';

/** Estado general de la máquina al cerrar la revisión. */
export type EstadoMaquina = 'operando' | 'con_falla' | 'fuera_de_linea';

/** tabla `checklist_plantillas`. */
export interface ChecklistPlantilla {
  id: number;
  nombre: string;
  unidad_negocio: string;
  tipo_medio: string | null;
  descripcion: string | null;
  activa: boolean;
  creada_por: string | null;
  creada_en: string | null;
}

/** tabla `checklist_puntos`. */
export interface ChecklistPunto {
  id: number;
  plantilla_id: number;
  orden: number;
  grupo: string | null;
  texto: string;
  ayuda: string | null;
  /** Empata con catalogo_incidencias.detalle. NULL = el revisor elige. */
  incidencia_sugerida: string | null;
  exige_foto_anomalia: boolean;
  critico: boolean;
  activo: boolean;
}

/** tabla `revisiones`. */
export interface Revision {
  id: number;
  plantilla_id: number | null;
  site_id: string;
  vendor_face_id: string | null;
  unidad_negocio: string | null;
  nombre_maquina: string | null;
  direccion: string | null;
  ruta_id: number | null;
  revisado_por: string | null;
  revisado_en: string | null;
  lat: number | null;
  lng: number | null;
  estado_maquina: EstadoMaquina | string | null;
  observaciones: string | null;
  puntos_ok: number;
  puntos_anomalia: number;
  puntos_na: number;
  creado_en: string | null;
}

/** tabla `revision_respuestas`. */
export interface RevisionRespuesta {
  id: number;
  revision_id: number;
  punto_id: number | null;
  /** Copia del texto del punto al momento de contestar. Ver el SQL. */
  punto_texto: string;
  grupo: string | null;
  orden: number | null;
  valor: ValorRespuesta;
  nota: string | null;
  incidencia_record_id: string | null;
}

/** tabla `revision_evidencias`. */
export interface RevisionEvidencia {
  id: number;
  revision_id: number;
  respuesta_id: number | null;
  tipo: string | null;
  url: string;
  path: string | null;
  referencia: string | null;
  subido_por: string | null;
  creado_en: string | null;
}

/**
 * Fila de `vw_revision_ubicaciones`: una máquina de una ruta, con
 * coordenadas y el resumen de su última revisión.
 */
export interface UbicacionRevision {
  ubicacion_id: number;
  ruta_id: number;
  ruta_numero: number;
  ruta_nombre: string | null;
  ruta_color: string;
  unidad_negocio: string;
  /**
   * Tipo de medio del SEGMENTO de la ruta. No confundir con `medio`.
   * Biobox mezcla Digital e Impreso en un mismo recorrido geográfico, y por
   * el trigger `ruta_ubic_valida_segmento` esa ruta queda partida en dos
   * filas con el mismo nombre. Para agrupar, se usa el nombre.
   */
  tipo_medio: string;
  ruta_activa: boolean;
  site_id: string;
  secuencia: number | null;

  vendor_face_id: string | null;
  site_legacy_id: string | null;
  direccion: string | null;
  municipio: string | null;
  estado: string | null;
  tipo_mueble: string | null;
  /**
   * Tipo de medio de la MÁQUINA, de inventario. Éste es el que decide qué
   * checklist se usa y qué se escribe en la incidencia.
   */
  medio: string | null;
  latitud: number | null;
  longitud: number | null;
  navegable: boolean;

  revision_id: number | null;
  ultima_revision: string | null;
  ultimo_revisor: string | null;
  estado_maquina: string | null;
  puntos_anomalia: number | null;
  /** NULL = nunca se ha revisado. */
  dias_sin_revision: number | null;
}
