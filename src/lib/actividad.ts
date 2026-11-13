// ============================================================
// src/lib/actividad.ts
// Pestaña Actividad de Usuarios (13-nov-2026, Erik): quién usa la app y
// quién no. Los datos los arma la función `actividad_equipo` de la base
// (migración 20261113180726): el manager ve a todos y el coordinador a la
// gente de su unidad y su área. Aquí solo va la lógica pura (estado,
// orden, tira de días, mensaje de WhatsApp), para poder probarla sin red.
// ============================================================

/** Una fila de usuario_roles: unidad o área null = todas / sin área. */
export type RolActividad = { unidad: string | null; area: string | null; rol: string };

/** Una persona, tal como la devuelve `actividad_equipo`. */
export type FilaActividad = {
  email: string;
  nombre: string | null;
  telefono: string | null;
  roles: RolActividad[] | null;
  tiene_cuenta: boolean;
  entra_con: string | null;
  alta: string | null;
  ultimo_login: string | null;
  ultima_vez: string | null;
  dias_uso: string[] | null;
  push: boolean;
  errores: number;
  maquinas: number;
  reparaciones: number;
  fotos: number;
  chat: number;
  rutas: number;
  comprobaciones: number;
  nuc: number;
};

/**
 * hoy = la usó hoy · reciente = en los últimos 5 días · inactivo = más de
 * 5 días sin usarla · nunca = nunca ha entrado (o ni cuenta tiene).
 */
export type EstadoActividad = 'hoy' | 'reciente' | 'inactivo' | 'nunca';

/** A partir de cuántos días sin usarla se marca en ámbar. */
export const DIAS_INACTIVO = 5;

const ZONA = 'America/Mexico_City';

/** Fecha YYYY-MM-DD en hora de CDMX. */
export function diaCdmx(fecha: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    fecha
  );
}

/** Días de calendario (CDMX) entre dos fechas YYYY-MM-DD. */
function restarDias(a: string, b: string): number {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}

/** Cuántos días de calendario (CDMX) lleva sin usarla; null si nunca. */
export function diasSinUso(ultimaVez: string | null, ahora: Date = new Date()): number | null {
  if (!ultimaVez) return null;
  const t = new Date(ultimaVez);
  if (Number.isNaN(t.getTime())) return null;
  return Math.max(0, restarDias(diaCdmx(ahora), diaCdmx(t)));
}

export function estadoActividad(f: Pick<FilaActividad, 'tiene_cuenta' | 'ultima_vez'>, ahora: Date = new Date()): EstadoActividad {
  const d = f.tiene_cuenta ? diasSinUso(f.ultima_vez, ahora) : null;
  if (d == null) return 'nunca';
  if (d === 0) return 'hoy';
  return d <= DIAS_INACTIVO ? 'reciente' : 'inactivo';
}

export const ESTADO_INFO: Record<EstadoActividad, { titulo: string; tono: 'verde' | 'azul' | 'ambar' | 'rojo' }> = {
  hoy: { titulo: 'La usó hoy', tono: 'verde' },
  reciente: { titulo: `Últimos ${DIAS_INACTIVO} días`, tono: 'azul' },
  inactivo: { titulo: `Sin usarla +${DIAS_INACTIVO} días`, tono: 'ambar' },
  nunca: { titulo: 'Nunca entró', tono: 'rojo' },
};

const PRIORIDAD: Record<EstadoActividad, number> = { nunca: 0, inactivo: 1, reciente: 2, hoy: 3 };

/**
 * Primero quien necesita atención: nunca entró, luego quien lleva más días
 * sin usarla; al final quien la usó hoy. Empates por nombre.
 */
export function ordenarActividad(filas: FilaActividad[], ahora: Date = new Date()): FilaActividad[] {
  return [...filas].sort((a, b) => {
    const ea = estadoActividad(a, ahora);
    const eb = estadoActividad(b, ahora);
    if (ea !== eb) return PRIORIDAD[ea] - PRIORIDAD[eb];
    const da = diasSinUso(a.ultima_vez, ahora) ?? 0;
    const db = diasSinUso(b.ultima_vez, ahora) ?? 0;
    if (da !== db) return db - da;
    return nombreDe(a).localeCompare(nombreDe(b), 'es');
  });
}

export function nombreDe(f: Pick<FilaActividad, 'nombre' | 'email'>): string {
  return (f.nombre || '').trim() || f.email;
}

export function iniciales(f: Pick<FilaActividad, 'nombre' | 'email'>): string {
  const partes = nombreDe(f).split(/[\s.@]+/).filter(Boolean);
  return ((partes[0]?.[0] || '') + (partes[1]?.[0] || '')).toUpperCase() || '?';
}

/**
 * Los últimos `n` días (el más viejo primero, hoy al final): true si ese
 * día la usó. `dias` son fechas YYYY-MM-DD (CDMX) de `actividad_dias`.
 */
export function tiraDias(dias: string[] | null, n: number, ahora: Date = new Date()): boolean[] {
  const usados = new Set(dias || []);
  const hoy = diaCdmx(ahora);
  const base = Date.parse(hoy + 'T00:00:00Z');
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base - (n - 1 - i) * 86400000).toISOString().slice(0, 10);
    return usados.has(d);
  });
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «9:10», «17:38» en hora de CDMX (sin cero a la izquierda en la hora). */
function horaCdmx(t: Date): string {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: ZONA, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t);
  const h = Number(p.find((x) => x.type === 'hour')?.value || 0);
  return `${h}:${p.find((x) => x.type === 'minute')?.value || '00'}`;
}

/** «5-nov» en hora de CDMX. */
export function fechaCorta(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const [, m, d] = diaCdmx(t).split('-');
  return `${Number(d)}-${MESES[Number(m) - 1]}`;
}

/** «Hoy 11:38», «Ayer 9:10», «Hace 8 días (5-nov)», «Nunca entró». */
export function textoUltimaVez(f: Pick<FilaActividad, 'tiene_cuenta' | 'ultima_vez'>, ahora: Date = new Date()): string {
  if (!f.tiene_cuenta) return 'Sin cuenta creada';
  const d = diasSinUso(f.ultima_vez, ahora);
  if (d == null || !f.ultima_vez) return 'Nunca entró';
  const t = new Date(f.ultima_vez);
  if (d === 0) return `Hoy ${horaCdmx(t)}`;
  if (d === 1) return `Ayer ${horaCdmx(t)}`;
  return `Hace ${d} días (${fechaCorta(f.ultima_vez)})`;
}

/** Lo que hizo en los últimos 30 días, por módulo, sin los ceros. */
export function actividadPorModulo(f: FilaActividad): { modulo: string; n: number }[] {
  return [
    { modulo: 'Visitas a máquinas', n: f.maquinas },
    { modulo: 'Reparaciones', n: f.reparaciones },
    { modulo: 'Fotos de incidencias', n: f.fotos },
    { modulo: 'Mensajes en chat', n: f.chat },
    { modulo: 'Visitas de ruta', n: f.rutas },
    { modulo: 'Comprobaciones', n: f.comprobaciones },
    { modulo: 'Aviso NUC', n: f.nuc },
  ]
    .filter((m) => m.n > 0)
    .sort((a, b) => b.n - a.n);
}

/** Áreas de sus roles, sin repetir ni vacías. */
export function areasDe(f: Pick<FilaActividad, 'roles'>): string[] {
  return [...new Set((f.roles || []).map((r) => (r.area || '').trim()).filter(Boolean))];
}

/**
 * «Biobox · Op. Bio Box · Técnico»; `etiqueta` traduce el rol interno
 * (ROLE_LABEL, que vive en constants y aquí no se importa para poder probar
 * este archivo solo).
 */
export function textoRol(r: RolActividad, etiqueta: (rol: string) => string = (x) => x): string {
  return [r.unidad || 'Todas las unidades', r.area || 'Sin área', etiqueta(r.rol)].join(' · ');
}

/**
 * Teléfono para wa.me: solo dígitos, con lada de México (52) si viene a
 * 10 dígitos. null si no parece un celular.
 */
export function telefonoWhatsapp(tel: string | null): string | null {
  const d = (tel || '').replace(/\D/g, '');
  if (d.length === 10) return '52' + d;
  if ((d.length === 12 && d.startsWith('52')) || (d.length === 13 && d.startsWith('521'))) return d;
  return null;
}

/** Recordatorio para mandar por WhatsApp (lo envía quien lo abre). */
export function mensajeRecordatorio(f: Pick<FilaActividad, 'nombre' | 'email' | 'tiene_cuenta' | 'ultima_vez'>, origen: string): string {
  const nombre = (f.nombre || '').trim().split(/\s+/)[0];
  const saludo = `Hola${nombre ? ' ' + nombre : ''}`;
  const nunca = !f.tiene_cuenta || !f.ultima_vez;
  return [
    nunca
      ? `${saludo}, ya tienes acceso a la Central de Operaciones de GPO VALLAS y todavía no has entrado.`
      : `${saludo}, te recuerdo usar la Central de Operaciones de GPO VALLAS para registrar tu trabajo.`,
    '',
    `Entra aquí: ${origen}`,
    `Toca «Continuar con Google» y elige tu correo ${f.email}.`,
  ].join('\n');
}
