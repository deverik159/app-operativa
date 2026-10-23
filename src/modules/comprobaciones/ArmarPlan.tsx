// ============================================================
// src/modules/comprobaciones/ArmarPlan.tsx
// Plan de tomas en «Armar el periodo» (23-oct-2026).
//
// POR QUÉ. Las campañas recién cargadas no traen plan: hasta que el
// Supervisor elige uno («al inicio», «inicio y fin», «cada N días»,
// «diario» o «fechas a mano», palabras de Erik) no hay renglones del
// Formato general. La bitácora de Biobox PROPONE un plan («COMPROBACIÓN:
// MENSUAL»); se enseña como sugerido y POR CONFIRMAR, nunca se aplica solo.
// Se aplica con comp_generar_tomas en lotes de 50 campañas (la base corta
// a los 8 s) y se enseña lo que contesta la base, sumado.
// ============================================================

import { createContext, useId, useMemo, useState } from 'react';
import {
  ETIQUETA_PLAN,
  MAX_CADA_N,
  TIPOS_PLAN,
  describirPlan,
  leerPlan,
  type PlanTomas,
  type TipoPlan,
} from '../../lib/comprobaciones';
import {
  generarTomas,
  textoFallaEscrituraComp,
  type PlanEnvio,
  type ResGenerarTomas,
  type VwCampana,
} from '../../lib/comprobacionesApi';
import type { PlanSugerido } from '../../lib/bitacoraComp';
import { llaveContrato } from '../../lib/bitacoraComp';
import type { PropsArmar } from './tiposComp';
import { diaCorto, etiquetaCampana, fmt, trozos } from './ArmarComun';

const LOTE_PLAN = 50;

/**
 * Aviso de PreviaCarga a ArmarPeriodo (revisión de pantallas, 23-oct-2026):
 * mientras una carga terminada enseña SU plan («Siguiente paso: el plan de
 * tomas de lo que acabas de cargar»), ArmarPeriodo esconde su bloque «Plan
 * de tomas del periodo» con las mismas campañas; si no, quedaban dos
 * editores para lo mismo en la pantalla. true al aparecer, false al irse.
 */
export const AvisoPlanDeCarga = createContext<((visible: boolean) => void) | null>(null);

// ------------------------------------------------------------
// Editor del plan
// ------------------------------------------------------------

type BorradorPlan = { tipo: TipoPlan; cadaN: string; fechas: string[]; incluirComprobados: boolean };

const borradorDe = (p: PlanTomas | null | undefined): BorradorPlan => ({
  tipo: p?.tipo ?? 'inicio',
  cadaN: p?.cada_n != null ? String(p.cada_n) : '7',
  fechas: p?.fechas ? [...p.fechas] : [],
  incluirComprobados: !!p?.incluir_comprobados,
});

function planDe(b: BorradorPlan): { plan: PlanTomas | null; error: string | null } {
  const crudo: Record<string, unknown> = { tipo: b.tipo };
  if (b.tipo === 'cada_n') crudo.cada_n = b.cadaN.trim();
  if (b.tipo === 'fechas') crudo.fechas = b.fechas;
  if (b.incluirComprobados) crudo.incluir_comprobados = true;
  const r = leerPlan(crudo);
  return r.plan ? { plan: r.plan, error: null } : { plan: null, error: r.error };
}

function EditorPlan({
  valor,
  onCambio,
  min,
  max,
  disabled,
}: {
  valor: BorradorPlan;
  onCambio: (b: BorradorPlan) => void;
  min: string;
  max: string;
  disabled: boolean;
}) {
  const [dia, setDia] = useState('');
  // Etiquetas ligadas a su campo (revisión 2, uso-10): VoiceOver leía
  // «campo de número» sin nombre. useId: hay un editor por grupo de plan.
  const uid = useId();
  return (
    <div>
      <div className="rt-chips rt-segmento" role="group" aria-label="Plan de tomas" style={{ flexWrap: 'wrap' }}>
        {TIPOS_PLAN.map((t) => (
          <button
            key={t}
            type="button"
            className={'rt-chip' + (valor.tipo === t ? ' on' : '')}
            aria-pressed={valor.tipo === t}
            disabled={disabled}
            onClick={() => onCambio({ ...valor, tipo: t })}
          >
            {ETIQUETA_PLAN[t]}
          </button>
        ))}
      </div>
      {valor.tipo === 'cada_n' && (
        <div className="field" style={{ marginTop: 10, maxWidth: 220 }}>
          <label htmlFor={uid + '-n'}>Cada cuántos días</label>
          <input
            id={uid + '-n'}
            type="number"
            min={1}
            max={MAX_CADA_N}
            inputMode="numeric"
            value={valor.cadaN}
            disabled={disabled}
            onChange={(e) => onCambio({ ...valor, cadaN: e.target.value })}
          />
        </div>
      )}
      {valor.tipo === 'fechas' && (
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor={uid + '-f'}>Fechas de toma (dentro del periodo)</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              id={uid + '-f'}
              type="date"
              min={min}
              max={max}
              value={dia}
              disabled={disabled}
              onChange={(e) => setDia(e.target.value)}
              style={{ maxWidth: 180 }}
            />
            <button
              type="button"
              className="btn ghost sm"
              disabled={disabled || !dia}
              onClick={() => {
                if (dia && !valor.fechas.includes(dia)) onCambio({ ...valor, fechas: [...valor.fechas, dia].sort() });
                setDia('');
              }}
            >
              Agregar fecha
            </button>
          </div>
          {valor.fechas.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {valor.fechas.map((f) => (
                <button
                  key={f}
                  type="button"
                  className="tag"
                  disabled={disabled}
                  title="Quitar esta fecha"
                  onClick={() => onCambio({ ...valor, fechas: valor.fechas.filter((x) => x !== f) })}
                  style={{ border: '1px solid var(--line)', cursor: 'pointer' }}
                >
                  {diaCorto(f)} ✕
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 10 }}>
        <input
          type="checkbox"
          checked={valor.incluirComprobados}
          disabled={disabled}
          onChange={(e) => onCambio({ ...valor, incluirComprobados: e.target.checked })}
        />
        También pedir toma de los sitios que ya están comprobados
      </label>
    </div>
  );
}

// ------------------------------------------------------------
// Un grupo de campañas con un plan
// ------------------------------------------------------------

export type GrupoPlan = {
  clave: string;
  titulo: string;
  /** Texto de la bitácora y cómo se leyó (plan sugerido). */
  nota?: string | null;
  porConfirmar?: boolean;
  campanas: { id: number; etiqueta: string }[];
  planInicial: PlanTomas | null;
};

type ResSumado = ResGenerarTomas & { lotes: number };

function sumar(a: ResSumado | null, b: ResGenerarTomas): ResSumado {
  if (!a) return { ...b, lotes: 1 };
  return {
    campanas: a.campanas + b.campanas,
    cerradas_omitidas: a.cerradas_omitidas + b.cerradas_omitidas,
    tomas_nuevas: a.tomas_nuevas + b.tomas_nuevas,
    tomas_borradas: a.tomas_borradas + b.tomas_borradas,
    tomas_actualizadas: a.tomas_actualizadas + b.tomas_actualizadas,
    tomas_conservadas: a.tomas_conservadas + b.tomas_conservadas,
    tomas_canceladas: a.tomas_canceladas + b.tomas_canceladas,
    tomas_regresadas: a.tomas_regresadas + b.tomas_regresadas,
    omitidas_comprobados: a.omitidas_comprobados + b.omitidas_comprobados,
    tomas_app_fuera_de_vigencia: [...a.tomas_app_fuera_de_vigencia, ...(b.tomas_app_fuera_de_vigencia ?? [])],
    sin_tomas: [...a.sin_tomas, ...(b.sin_tomas ?? [])],
    plan: b.plan,
    lotes: a.lotes + 1,
  };
}

export function AplicarPlanGrupo({ ctx, grupo, onAplicado }: { ctx: PropsArmar; grupo: GrupoPlan; onAplicado?: () => void }) {
  const [borrador, setBorrador] = useState<BorradorPlan>(() => borradorDe(grupo.planInicial));
  const [err, setErr] = useState('');
  const [res, setRes] = useState<ResSumado | null>(null);
  const [avance, setAvance] = useState('');
  // Un plan sugerido por la bitácora pide un segundo toque antes de
  // aplicarse a todo el grupo (revisión de pantallas, 23-oct-2026).
  const [confirmado, setConfirmado] = useState(false);
  // Ya aplicado sin error: el grupo se queda con su resultado y deja de
  // ofrecer «Aplicar» hasta que se pida cambiar el plan (así no se reaplica
  // por error desde otro bloque de la misma pantalla).
  const [aplicadoOk, setAplicadoOk] = useState(false);
  const { plan, error } = planDe(borrador);
  const ocupado = ctx.ocupado != null;
  const nombres = useMemo(() => new Map(grupo.campanas.map((c) => [c.id, c.etiqueta])), [grupo.campanas]);

  const aplicar = async () => {
    if (!plan || !grupo.campanas.length) return;
    setErr('');
    setRes(null);
    const envio: PlanEnvio = { tipo: plan.tipo, cada_n: plan.cada_n ?? null, fechas: plan.fechas ?? null };
    if (plan.incluir_comprobados) envio.incluir_comprobados = true;
    const lotes = trozos(
      grupo.campanas.map((c) => c.id),
      LOTE_PLAN
    );
    const r = await ctx.correr('Generando tomas…', async () => {
      let acum: ResSumado | null = null;
      for (let i = 0; i < lotes.length; i++) {
        if (lotes.length > 1) setAvance(`Lote ${i + 1} de ${lotes.length}…`);
        const x = await generarTomas(lotes[i], envio);
        if (!x.ok) return { acum, error: textoFallaEscrituraComp(x), lote: i };
        acum = sumar(acum, x.data);
      }
      return { acum, error: '', lote: lotes.length };
    });
    setAvance('');
    if (!r) {
      setErr('Hay otra operación en curso. Espera a que termine y vuelve a intentar.');
      return;
    }
    if (r.acum) setRes(r.acum);
    if (r.error) {
      setErr(
        (r.lote > 0 ? `Se aplicó a las primeras ${Math.min(r.lote * LOTE_PLAN, grupo.campanas.length)} campañas y luego falló: ` : '') +
          r.error
      );
    } else if (r.acum) {
      setAplicadoOk(true);
      ctx.avisar(`✓ Plan aplicado: ${fmt(r.acum.tomas_nuevas)} tomas nuevas`);
    }
    // Se relee SIEMPRE (revisión de pantallas, 23-oct-2026): si el primer
    // lote se cortó sin respuesta, pudo haberse aplicado igual.
    ctx.recargar();
    if (r.acum) onAplicado?.();
  };

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 6 }}>
        <b style={{ fontSize: 14 }}>{grupo.titulo}</b>
        {grupo.porConfirmar && (
          <span className="tag" style={{ color: 'var(--warn)' }}>
            sugerido · por confirmar
          </span>
        )}
      </div>
      {grupo.nota && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>{grupo.nota}</div>}
      <details style={{ marginBottom: 10, fontSize: 12 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>
          {fmt(grupo.campanas.length)} campaña(s)
        </summary>
        <div className="lista-scroll" style={{ maxHeight: 180, overflowY: 'auto', marginTop: 4, overflowWrap: 'anywhere' }}>
          {grupo.campanas.map((c) => (
            <div key={c.id}>{c.etiqueta}</div>
          ))}
        </div>
      </details>
      <EditorPlan
        valor={borrador}
        onCambio={(v) => {
          setBorrador(v);
          setConfirmado(false);
        }}
        min={ctx.periodo.inicio}
        max={ctx.periodo.fin}
        disabled={ocupado || aplicadoOk}
      />
      {grupo.porConfirmar && !aplicadoOk && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={confirmado}
            disabled={ocupado}
            onChange={(e) => setConfirmado(e.target.checked)}
            style={{ width: 20, height: 20, margin: 0 }}
          />
          Confirmo el plan: lo revisé contra la bitácora
        </label>
      )}
      {error && <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 8 }}>{error}</div>}
      {err && (
        <div className="err" style={{ marginTop: 10 }}>
          {err}
        </div>
      )}
      {res && (
        <div className="ok-msg" style={{ marginTop: 10, lineHeight: 1.6 }}>
          <b>{describirPlan(res.plan)}</b> en {fmt(res.campanas)} campaña(s): {fmt(res.tomas_nuevas)} tomas nuevas ·{' '}
          {fmt(res.tomas_actualizadas)} actualizadas · {fmt(res.tomas_borradas)} quitadas · {fmt(res.tomas_conservadas)} se
          conservan
          {res.tomas_canceladas + res.tomas_regresadas > 0 && (
            <>
              {' '}
              · {fmt(res.tomas_canceladas)} canceladas · {fmt(res.tomas_regresadas)} regresadas
            </>
          )}
          {res.cerradas_omitidas > 0 && (
            <>
              <br />
              {fmt(res.cerradas_omitidas)} campaña(s) cerradas no se tocaron.
            </>
          )}
          {res.omitidas_comprobados > 0 && (
            <>
              <br />
              {fmt(res.omitidas_comprobados)} sitio(s) ya comprobados no reciben tomas nuevas.
            </>
          )}
          {res.tomas_app_fuera_de_vigencia.length > 0 && (
            <>
              <br />
              <span style={{ color: 'var(--warn)' }}>
                ⚠ {fmt(res.tomas_app_fuera_de_vigencia.length)} toma(s) editadas a mano quedan fuera de la vigencia del sitio
                (no se tocaron): revísalas en Formato.
              </span>
            </>
          )}
          {res.sin_tomas.length > 0 && (
            <>
              <br />
              <span style={{ color: 'var(--warn)' }}>
                ⚠ {fmt(res.sin_tomas.length)} campaña(s) se quedaron sin ninguna toma con este plan:{' '}
                {res.sin_tomas
                  .slice(0, 6)
                  // La base manda el nombre («CAMPAÑA / V2»); un id suelto
                  // (forma vieja) se traduce con el grupo (23-oct-2026).
                  .map((x: string | number) => (typeof x === 'number' ? nombres.get(x) ?? `#${x}` : x))
                  .join(', ')}
                {res.sin_tomas.length > 6 ? '…' : ''}
              </span>
            </>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        {aplicadoOk ? (
          <button
            type="button"
            className="btn ghost sm"
            disabled={ocupado}
            onClick={() => {
              setAplicadoOk(false);
              setRes(null);
              setConfirmado(false);
            }}
          >
            Cambiar el plan de este grupo
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={ocupado || !plan || !grupo.campanas.length || (!!grupo.porConfirmar && !confirmado)}
            onClick={aplicar}
          >
            {ctx.ocupado === 'Generando tomas…' ? 'Generando…' : `Aplicar «${plan ? describirPlan(plan) : ETIQUETA_PLAN[borrador.tipo]}» a ${fmt(grupo.campanas.length)}`}
          </button>
        )}
        {avance && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{avance}</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Grupos: los planes sugeridos y las campañas sin plan
// ------------------------------------------------------------

/**
 * Arma los grupos para un conjunto de campañas (ids de la base): las que
 * tienen plan sugerido por la bitácora se juntan por plan (por confirmar);
 * las demás van en un grupo «sin plan sugerido». `vista` (vw_comp_campanas)
 * dice cuáles ya tienen plan, para no ofrecer volver a aplicarlo.
 */
export function gruposDePlan(
  campanas: { id: number; campana: string; version: string }[],
  sugeridos: Record<string, PlanSugerido> | null | undefined,
  vista: VwCampana[]
): GrupoPlan[] {
  const conPlan = new Set(vista.filter((v) => v.plan_tomas != null).map((v) => v.id));
  const grupos = new Map<string, GrupoPlan>();
  const resto: GrupoPlan = { clave: 'resto', titulo: 'Sin plan sugerido', campanas: [], planInicial: null };
  for (const c of campanas) {
    if (conPlan.has(c.id)) continue;
    const s = sugeridos?.[llaveContrato(c)];
    const item = { id: c.id, etiqueta: etiquetaCampana(c) };
    if (!s) {
      resto.campanas.push(item);
      continue;
    }
    const k = JSON.stringify(s.plan);
    let g = grupos.get(k);
    if (!g) {
      g = {
        clave: k,
        titulo: `Sugerido: ${describirPlan(s.plan)}`,
        nota: '',
        porConfirmar: s.porConfirmar,
        campanas: [],
        planInicial: s.plan,
      };
      grupos.set(k, g);
    }
    const lectura = `La bitácora dice «${s.comprobacion}» → ${s.lectura}`;
    if (!g.nota!.includes(lectura)) g.nota = g.nota ? `${g.nota} · ${lectura}` : lectura;
    g.campanas.push(item);
  }
  const out = [...grupos.values()];
  if (resto.campanas.length) {
    if (out.length) resto.titulo = 'Las demás (sin plan sugerido)';
    out.push(resto);
  }
  return out;
}

/** Bloque de planes para un conjunto de grupos. */
export function PlanesDeTomas({ ctx, grupos, titulo }: { ctx: PropsArmar; grupos: GrupoPlan[]; titulo: string }) {
  if (!grupos.length) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <h3 style={{ fontSize: 15, margin: '0 0 4px' }}>{titulo}</h3>
      <p className="phint" style={{ marginBottom: 12 }}>
        El plan arma los renglones día × sitio del Formato general dentro de la vigencia de cada sitio. Lo editado a mano no
        se pisa.
      </p>
      {grupos.map((g) => (
        <AplicarPlanGrupo key={g.clave} ctx={ctx} grupo={g} />
      ))}
    </div>
  );
}
