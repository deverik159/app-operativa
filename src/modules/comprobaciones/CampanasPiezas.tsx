// ============================================================
// src/modules/comprobaciones/CampanasPiezas.tsx
// Piezas chicas de la pestaña Campañas (= «Asignación de clientes») que
// comparten la lista, la tabla, las tarjetas del teléfono y las ventanas de
// lote (23-oct-2026). Viven aparte para que CampanasSupervisor no crezca
// sin fin y para que las ventanas (Acciones, Pasar pendiente, Plan de
// tomas) pinten igual los mismos datos.
// Solo variables de tema (--panel, --line, --st-*): sale bien en claro y
// oscuro sin CSS nuevo.
// ============================================================
import type { CSSProperties } from 'react';
import { hoyCdmx } from '../../lib/comprobaciones';
import type { MiembroEquipo, TomasReaplicadas, VwCampana } from '../../lib/comprobacionesApi';
import { colorTono, fondoTono, type Tono } from '../../lib/tonos';
import { Barra as BarraComun, PildoraLimite, sinPorComprobar } from './AvanceComun';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Número con separador de miles, como en el Excel de hoy («1,437»). */
export const fmtN = (n: number | null | undefined) => (Number.isFinite(n as number) ? (n as number) : 0).toLocaleString('es-MX');

/**
 * 'YYYY-MM-DD' → «3 ago». Una marca de tiempo (cerrada_en) se pasa antes
 * al día de CDMX con hoyCdmx, no al de la zona del teléfono.
 */
export function fmtDia(x: string | null | undefined): string {
  if (!x) return '—';
  const d = x.length > 10 ? hoyCdmx(new Date(x)) || x.slice(0, 10) : x.slice(0, 10);
  const m = Number(d.slice(5, 7));
  const dia = Number(d.slice(8, 10));
  if (!m || !dia) return x;
  return `${dia} ${MESES[m - 1]}`;
}

/** «ESSITY AGOSTO · V5» (sin el punto si la versión viene vacía). */
export const tituloCampana = (c: Pick<VwCampana, 'campana' | 'version'>) =>
  c.version ? `${c.campana} · ${c.version}` : c.campana;

/** De dónde salió la fecha límite (la vista lo dice): la puso Victor, la regla o el fin. */
export const FUENTE_LIMITE: Record<string, string> = { app: 'puesta a mano', regla: 'por regla', fin: 'fin de la campaña' };

/**
 * Píldora de la fecha límite. Desde la revisión de pantallas (23-oct-2026)
 * es la MISMA de Mis campañas y del detalle (limiteDe de AvanceComun): antes
 * Campañas decía «en 3 días» y Mis campañas «Vence en 3 días».
 */
export function PillLimite({ c }: { c: VwCampana }) {
  return (
    <PildoraLimite
      c={c}
      title={c.fecha_limite_fuente ? `Fecha límite ${FUENTE_LIMITE[c.fecha_limite_fuente] ?? ''}` : undefined}
    />
  );
}

/** Estatus de la fila: Retirada gana a todo (ya no cuenta), luego Cerrada, Completa y Abierta. */
export function estatusDe(c: VwCampana): { t: string; tono: Tono } {
  if (c.retirada) return { t: 'Retirada', tono: 'gris' };
  if (c.estatus === 'cerrada') return { t: 'Cerrada', tono: 'verde' };
  if (c.completa) return { t: 'Completa', tono: 'verde' };
  // Sin nada que marcar: solo le falta que el Supervisor la cierre (23-oct-2026).
  if (sinPorComprobar(c)) return { t: 'Para cerrar', tono: 'ambar' };
  return { t: 'Abierta', tono: 'azul' };
}

export function PillEstatus({ c }: { c: VwCampana }) {
  const e = estatusDe(c);
  return (
    <span className="pill" style={{ background: fondoTono(e.tono), color: colorTono(e.tono) }}>
      {e.t}
    </span>
  );
}

/**
 * Barra de avance: una sola en todo el módulo (la de AvanceComun), para que
 * Campañas y Mis campañas se vean igual (revisión de pantallas, 23-oct-2026).
 */
export const Barra = BarraComun;

/** «12/17 · 71 %» (o «sin meta»). */
export const textoAvance = (c: Pick<VwCampana, 'comprobados' | 'meta' | 'pct'>) =>
  `${fmtN(c.comprobados)}/${fmtN(c.meta)} · ${c.pct == null ? 'sin meta' : `${c.pct} %`}`;

/**
 * Opciones del selector de analista: los asignables de comp_equipo (rol
 * analista en la unidad) y, si la campaña ya trae a alguien que no está
 * (perdió el rol), esa persona marcada, para no enseñar un select vacío.
 */
export function opcionesAnalista(
  equipo: MiembroEquipo[],
  actual: string | null | undefined,
  nombreDe: (e: string | null | undefined) => string
): { email: string; nombre: string }[] {
  const out = equipo.filter((m) => m.asignable).map((m) => ({ email: m.email, nombre: m.nombre || m.email }));
  const a = (actual || '').trim().toLowerCase();
  if (a && !out.some((o) => o.email === a)) out.push({ email: a, nombre: `${nombreDe(a)} (sin rol de analista)` });
  return out;
}

/**
 * Lo que dicen de las tomas los reportes que vuelven a aplicar el plan
 * (editar la vigencia, retirar, regresar). Vacío si no se movió nada.
 */
export function textoTomas(r: TomasReaplicadas | null | undefined): string {
  if (!r) return '';
  const partes: string[] = [];
  const n = (x: unknown) => (typeof x === 'number' ? x : Number(x) || 0);
  if (n(r.tomas_nuevas)) partes.push(`${fmtN(n(r.tomas_nuevas))} tomas nuevas`);
  if (n(r.tomas_borradas)) partes.push(`${fmtN(n(r.tomas_borradas))} borradas`);
  if (n(r.tomas_actualizadas)) partes.push(`${fmtN(n(r.tomas_actualizadas))} actualizadas`);
  if (n(r.tomas_canceladas)) partes.push(`${fmtN(n(r.tomas_canceladas))} quitadas`);
  if (n(r.tomas_regresadas)) partes.push(`${fmtN(n(r.tomas_regresadas))} regresadas`);
  const fuera = Array.isArray(r.tomas_app_fuera_de_vigencia) ? r.tomas_app_fuera_de_vigencia.length : 0;
  if (fuera) partes.push(`${fmtN(fuera)} hechas a mano quedaron fuera de la vigencia`);
  return partes.join(' · ');
}

/** Casilla con área táctil de 44 px (la casilla del navegador es diminuta en iPhone). */
export function Casilla({
  checked,
  onChange,
  etiqueta,
  disabled,
  indeterminada,
}: {
  checked: boolean;
  onChange: () => void;
  etiqueta: string;
  disabled?: boolean;
  indeterminada?: boolean;
}) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 44,
        minHeight: 44,
        margin: '-10px -8px',
        cursor: disabled ? 'default' : 'pointer',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        aria-label={etiqueta}
        checked={checked}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = !!indeterminada && !checked;
        }}
        onChange={onChange}
        // La regla global de input pone width:100% y padding: aquí no.
        style={{ width: 20, height: 20, margin: 0, padding: 0, accentColor: 'var(--accent)', cursor: 'inherit' }}
      />
    </label>
  );
}

/** Estilos de celda de la tabla (los de TablaIncidencias). */
export const celda: CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--line)', verticalAlign: 'top' };
export const sinQuiebre: CSSProperties = { whiteSpace: 'nowrap', overflowWrap: 'normal', wordBreak: 'normal' };
export const textoLegible: CSSProperties = {
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  wordBreak: 'normal',
  lineHeight: 1.35,
};

/** Lista con desplazamiento propio en PC (en el teléfono .lista-scroll lo libera). */
export const cajaLista: CSSProperties = {
  maxHeight: 260,
  overflowY: 'auto',
  border: '1px solid var(--line)',
  borderRadius: 10,
  padding: '6px 10px',
  background: 'var(--panel2)',
  fontSize: 12,
  lineHeight: 1.5,
};
