// ============================================================
// src/lib/constants.ts
// Constantes compartidas: etiquetas, colores, catálogos.
// Traducidas del HTML original (las const globales de arriba del script).
// ============================================================

export const EST_LABEL: Record<string, string> = {
  reportado: 'Reportado',
  por_validar: 'Por validar',
  rechazada: 'Rechazada',
  en_proceso: 'En proceso',
  reparado: 'Reparado',
  cerrada: 'Cerrada',
  no_reparado: 'No reparado',
};

export const EST_COLOR: Record<string, string> = {
  reportado: '#4f8cff',
  por_validar: '#4f8cff',
  rechazada: '#ef4444',
  en_proceso: '#f59e0b',
  reparado: '#a78bfa',
  cerrada: '#22c55e',
  no_reparado: '#6b7280',
};

export const NIVEL_COLOR: Record<string, string> = {
  Alto: '#ef4444',
  Medio: '#f59e0b',
  Bajo: '#3b82f6',
};

export const ROLE_LABEL: Record<string, string> = {
  reportante: 'Reportante',
  validador: 'Validador',
  reparacion: 'Técnico',
  coordinador: 'Coordinador',
  manager: 'Admin',
  viewer: 'Viewer',
};

export const ROLE_ICON: Record<string, string> = {
  reportante: '📝',
  validador: '✅',
  reparacion: '🔧',
  coordinador: '🧭',
  manager: '🛡️',
  viewer: '👁️',
};

export const ROLE_PRIORITY = [
  'manager',
  'coordinador',
  'validador',
  'reparacion',
  'reportante',
  'viewer',
];

export const UNIDADES = [
  'Ecovallas',
  'Vía Verde',
  'Biobox',
  'Biobox Perú',
  'Verde Vertical',
];

export const AREAS_RESP = [
  'Mantenimiento',
  'Fijación',
  'Implementaciones',
  'Digital',
  'Iluminación',
  'Instalaciones',
  'TI',
];

export const AREAS_ASIGNABLES = ['Mantenimiento', 'Fijación', 'Implementaciones'];
export const DEPARTAMENTOS_REPORTE = ['Monitoreo', 'Operaciones', 'SRD', 'PPD'];
export const TIPOS = [
  'Vandalismo',
  'Imponderable',
  'Desviaciones de Procedimiento',
  'Incumplimiento de Tiempo',
];

export const SLA_VALIDADOR_HORAS = 24;

// ============================================================
// Auto-ruteo fuera del horario del validador
// ============================================================

/**
 * Áreas que SALTAN la validación inicial: la incidencia entra directo a
 * 'en_proceso' con requiere_prevalidacion=true, y el área la prevalida al
 * recibirla. Solo aplica fuera del horario del validador.
 */
export const AREAS_AUTORUTEO = ['Digital'];

/** Horario del validador (America/Mexico_City): Lun–Vie 9:30–18:30. */
export const VAL_DIAS = [1, 2, 3, 4, 5];
export const VAL_DESDE = 9 * 60 + 30;
export const VAL_HASTA = 18 * 60 + 30;

/** Estados de la bitácora de Bioboxes (los usa BitacoraView, aún sin migrar). */
export const UNIDADES_BIOBOX = ['Biobox', 'Biobox Perú'];

/** Nombre presentable de la etapa de una evidencia. */
export const ETAPA_LABEL: Record<string, string> = {
  reporte: 'Reporte',
  reparacion: 'Reparación',
};
