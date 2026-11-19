// ============================================================
// src/lib/indicadoresTecnicos.ts
// Cálculos de la pestaña «Técnicos» de Indicadores (Erik, 18-nov-2026; ficha
// incidencias, «Indicadores por pestañas»). Sin imports: se prueba sola.
//
//  · Reparaciones por técnico: lo que reparó (repaired_by_email), su tiempo
//    de reparación (desde que llegó al área, sla_reparacion_inicio, hasta
//    repaired_at; MEDIANA), las rechazadas y en cuántas apoyó.
//  · Rutas de Op. Bio Box: el avance de SU ruta en la catorcena con la misma
//    regla de Rutas › Avance de visitas (una parada vigente cuenta como
//    visitada si alguien la visitó en el periodo: Mis rutas, visita rápida o
//    revisión), sus propias visitas rápidas y revisiones, y las máquinas de
//    su ruta sin visita en más de 14 días.
// ============================================================

/** Una persona como la devuelve actividad_equipo (solo lo que se usa). */
export type PersonaRoles = {
  email: string;
  nombre: string | null;
  roles: { unidad: string | null; area: string | null; rol: string }[] | null;
};

export type Tecnico = { email: string; nombre: string; unidades: string[]; areas: string[] };

const minus = (s: string | null | undefined) => (s || '').trim().toLowerCase();

/**
 * Los técnicos (rol reparacion) de la lista, con sus unidades y áreas. Con
 * `unidad` o `area`, solo los que tienen una fila de reparación que empate
 * (una fila sin unidad = todas las unidades).
 */
export function tecnicosDe(personas: readonly PersonaRoles[], unidad?: string | null, area?: string | null): Tecnico[] {
  const out: Tecnico[] = [];
  for (const p of personas) {
    const filas = (p.roles || []).filter((r) => r.rol === 'reparacion');
    const empatan = filas.filter(
      (r) => (!unidad || !r.unidad || minus(r.unidad) === minus(unidad)) && (!area || minus(r.area) === minus(area))
    );
    if (!empatan.length) continue;
    out.push({
      email: minus(p.email),
      nombre: (p.nombre || '').trim() || p.email,
      unidades: [...new Set(filas.map((r) => r.unidad || 'Todas'))],
      areas: [...new Set(filas.map((r) => r.area).filter((a): a is string => !!a))],
    });
  }
  return out.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

export function mediana(nums: readonly number[]): number | null {
  const v = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Lo que se usa de una incidencia reparada. */
export type IncReparada = {
  record_id: string;
  repaired_by_email?: string | null;
  apoyo_reparacion_email?: string | null;
  repaired_at?: string | null;
  sla_reparacion_inicio?: string | null;
  rechazos_reparacion?: number | null;
};

export type Reparaciones<T> = {
  reparadas: T[];
  apoyos: T[];
  /** Incidencias suyas con al menos un rechazo de la reparación. */
  rechazadas: T[];
  /** Mediana en horas de llegó al área → reparada. */
  medianaH: number | null;
};

/** Reparaciones por técnico (llave: correo en minúsculas). */
export function reparacionesPorTecnico<T extends IncReparada>(incs: readonly T[]): Map<string, Reparaciones<T>> {
  const m = new Map<string, Reparaciones<T> & { tiempos: number[] }>();
  const de = (e: string) => {
    let x = m.get(e);
    if (!x) {
      x = { reparadas: [], apoyos: [], rechazadas: [], medianaH: null, tiempos: [] };
      m.set(e, x);
    }
    return x;
  };
  for (const i of incs) {
    const quien = minus(i.repaired_by_email);
    if (quien) {
      const x = de(quien);
      x.reparadas.push(i);
      if ((i.rechazos_reparacion || 0) > 0) x.rechazadas.push(i);
      const a = Date.parse(i.sla_reparacion_inicio || '');
      const b = Date.parse(i.repaired_at || '');
      if (!Number.isNaN(a) && !Number.isNaN(b) && b >= a) x.tiempos.push((b - a) / 3600000);
    }
    const apoyo = minus(i.apoyo_reparacion_email);
    if (apoyo && apoyo !== quien) de(apoyo).apoyos.push(i);
  }
  const out = new Map<string, Reparaciones<T>>();
  for (const [e, x] of m) out.set(e, { reparadas: x.reparadas, apoyos: x.apoyos, rechazadas: x.rechazadas, medianaH: mediana(x.tiempos) });
  return out;
}

export type Parada = { ruta_id: number; site_id: string; estatus_archivo: string | null };
export type VisitaPeriodo = { site_id: string; usuario_email: string; visitado_en: string; tipo: 'monitoreo' | 'rapida' | 'revision' };

export type AvanceRuta = {
  /** Máquinas (paradas vigentes) de sus rutas. */
  sitios: string[];
  /** De esas, las que alguien visitó en el periodo. */
  visitados: string[];
  /** Sus propias visitas rápidas y revisiones en el periodo (en cualquier máquina). */
  rapidas: number;
  revisiones: number;
  /** Máquinas de sus rutas cuya última visita (de quien sea) fue hace más de `dias` días, o nunca. */
  sinVisita: string[];
};

/**
 * Avance de ruta por técnico de Op. Bio Box. `rutasDe`: correo → ids de sus
 * rutas (ruta_tecnicos). `ultimaVisita`: site_id → ISO de la última visita
 * de cualquier fecha (vw_maquina_ultima_visita), para «sin visita».
 */
export function avancePorTecnico(
  rutasDe: ReadonlyMap<string, readonly number[]>,
  paradas: readonly Parada[],
  visitas: readonly VisitaPeriodo[],
  ultimaVisita: ReadonlyMap<string, string>,
  ahora: number = Date.now(),
  dias = 14
): Map<string, AvanceRuta> {
  const vigentes = paradas.filter((p) => (p.estatus_archivo || '').toUpperCase() !== 'RETIRADA');
  const visitadosPeriodo = new Set(visitas.map((v) => v.site_id));
  const limite = ahora - dias * 86400000;
  const out = new Map<string, AvanceRuta>();
  for (const [email, rutas] of rutasDe) {
    const ids = new Set(rutas);
    const sitios = [...new Set(vigentes.filter((p) => ids.has(p.ruta_id)).map((p) => p.site_id))];
    const mias = visitas.filter((v) => minus(v.usuario_email) === minus(email));
    out.set(minus(email), {
      sitios,
      visitados: sitios.filter((s) => visitadosPeriodo.has(s)),
      rapidas: mias.filter((v) => v.tipo === 'rapida').length,
      revisiones: mias.filter((v) => v.tipo === 'revision').length,
      sinVisita: sitios.filter((s) => {
        const t = Date.parse(ultimaVisita.get(s) || '');
        return Number.isNaN(t) || t < limite;
      }),
    });
  }
  return out;
}

// ── Periodo (Erik, 18-nov-2026: «semanas o mes» en lugar de catorcena) ──

export type TipoPeriodo = 'semana' | 'mes';
export type Periodo = {
  clave: string;
  etiqueta: string;
  /** Inicio (incluido) y fin (excluido), en hora local. */
  desde: Date;
  hasta: Date;
};

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * Las últimas `cuantos` semanas (lunes a domingo) o meses, la actual primero.
 * La actual va completa aunque no haya terminado.
 */
export function periodosDe(tipo: TipoPeriodo, ahora: Date = new Date(), cuantos = 12): Periodo[] {
  const out: Periodo[] = [];
  if (tipo === 'mes') {
    for (let k = 0; k < cuantos; k++) {
      const desde = new Date(ahora.getFullYear(), ahora.getMonth() - k, 1);
      const hasta = new Date(desde.getFullYear(), desde.getMonth() + 1, 1);
      const nombre = MESES[desde.getMonth()];
      out.push({
        clave: `m-${desde.getFullYear()}-${desde.getMonth() + 1}`,
        etiqueta: `${nombre[0].toUpperCase()}${nombre.slice(1)} ${desde.getFullYear()}${k === 0 ? ' (este mes)' : ''}`,
        desde, hasta,
      });
    }
    return out;
  }
  const hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const lunes = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - ((hoy.getDay() + 6) % 7));
  for (let k = 0; k < cuantos; k++) {
    const desde = new Date(lunes.getFullYear(), lunes.getMonth(), lunes.getDate() - 7 * k);
    const hasta = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate() + 7);
    const dom = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate() - 1);
    const ini = desde.getMonth() === dom.getMonth() ? `${desde.getDate()}` : `${desde.getDate()} ${MES_CORTO[desde.getMonth()]}`;
    out.push({
      clave: `s-${desde.getFullYear()}-${desde.getMonth() + 1}-${desde.getDate()}`,
      etiqueta: `Semana del ${ini} al ${dom.getDate()} ${MES_CORTO[dom.getMonth()]}${k === 0 ? ' (esta semana)' : ''}`,
      desde, hasta,
    });
  }
  return out;
}
