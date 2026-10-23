// ============================================================
// src/modules/comprobaciones/PlanTomasModal.tsx
// Plan de tomas EN LOTE (Erik, 23-oct-2026): Victor elige «al inicio»,
// «inicio y fin», «cada N días», «diario» o «fechas a mano» para varias
// campañas y la base genera los renglones día × sitio del Formato general
// (comp_generar_tomas). También puede volver a aplicar el plan que ya
// tiene cada una (p_plan null), p. ej. después de recortar la vigencia.
//
// Antes de mandar se enseña la vista previa con resumenPlan (espejo de la
// base, sin armar renglones: 180 campañas × 30 sitios en diario serían 167
// mil objetos en un teléfono):
//   · «hasta N renglones»: la base respeta las tomas editadas a mano;
//   · qué sitios se quedan sin toma y por qué (fuera del periodo, ninguna
//     fecha del plan cae en su vigencia, ya comprobados);
//   · qué campañas se omiten (cerradas o retiradas) y cuáles no tendrían
//     ninguna toma (sin sitios, p. ej. un FULL sin columnas).
// A resumenPlan se le pasan estatus, retirada, medio y unidad de cada
// campaña (pendiente de la integración): sin eso la previa se infla.
// Con UNA campaña también se enseña una muestra de renglones con
// horarioMostrar («24 HORAS» en Biobox y Ecovallas, franjas en Vía Verde).
//
// Se manda en tandas de TANDA campañas: la base corta una sentencia a los
// 8 s y un plan diario de todo Vía Verde no cabe en una sola llamada. Si
// una tanda falla, se dice cuántas quedaron aplicadas.
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import CerrarModal from '../../components/CerrarModal';
import {
  ETIQUETA_PLAN,
  MAX_CADA_N,
  TIPOS_PLAN,
  campanaOmitidaDelPlan,
  compararNatural,
  describirPlan,
  diasEntre,
  generarRenglonesPlan,
  leerPlan,
  resumenPlan,
  type CampanaPlan,
  type SitioPlan,
  type TipoPlan,
} from '../../lib/comprobaciones';
import {
  generarTomas,
  leerSitios,
  textoFallaComp,
  textoFallaEscrituraComp,
  type PeriodoCargado,
  type PlanEnvio,
  type ResGenerarTomas,
  type SitioComp,
  type VwCampana,
} from '../../lib/comprobacionesApi';
import type { ContextoComp } from './tiposComp';
import { cajaLista, celda, fmtDia, fmtN, sinQuiebre, textoLegible, tituloCampana } from './CampanasPiezas';

/** Campañas por llamada a comp_generar_tomas. */
const TANDA = 40;
/** Renglones de muestra con una sola campaña. */
const MUESTRA = 20;

type Props = ContextoComp & {
  periodo: PeriodoCargado;
  elegidas: VwCampana[];
  onCerrar: () => void;
  /** El plan quedó aplicado a TODAS las que se mandaron (el padre limpia la selección). */
  onAplicado?: () => void;
};

type Modo = 'nuevo' | 'guardado';

/** Lo que se le pasa a resumenPlan de una fila de la vista. */
const campanaPlan = (c: VwCampana): CampanaPlan => ({
  inicio: c.inicio,
  fin: c.fin,
  especificacion: c.especificacion,
  estatus: c.estatus,
  retirada: c.retirada,
  medio: c.medio,
  unidad: c.unidad,
});

const sitioPlan = (s: SitioComp): SitioPlan => ({
  sitio_clave: s.sitio_clave,
  inicio: s.inicio,
  fin: s.fin,
  tramos: s.tramos,
  horario_lv: s.horario_lv,
  horario_sd: s.horario_sd,
  observaciones: s.observaciones,
  estado: s.estado,
  fuera_de_carga: s.fuera_de_carga,
});

/** Suma dos reportes de tandas (números se suman, listas se juntan). */
function sumar(a: ResGenerarTomas | null, b: ResGenerarTomas): ResGenerarTomas {
  if (!a) return { ...b, sin_tomas: [...(b.sin_tomas ?? [])], tomas_app_fuera_de_vigencia: [...(b.tomas_app_fuera_de_vigencia ?? [])] };
  const n = (x: unknown) => (typeof x === 'number' ? x : Number(x) || 0);
  return {
    campanas: n(a.campanas) + n(b.campanas),
    cerradas_omitidas: n(a.cerradas_omitidas) + n(b.cerradas_omitidas),
    tomas_nuevas: n(a.tomas_nuevas) + n(b.tomas_nuevas),
    tomas_borradas: n(a.tomas_borradas) + n(b.tomas_borradas),
    tomas_actualizadas: n(a.tomas_actualizadas) + n(b.tomas_actualizadas),
    tomas_conservadas: n(a.tomas_conservadas) + n(b.tomas_conservadas),
    tomas_canceladas: n(a.tomas_canceladas) + n(b.tomas_canceladas),
    tomas_regresadas: n(a.tomas_regresadas) + n(b.tomas_regresadas),
    omitidas_comprobados: n(a.omitidas_comprobados) + n(b.omitidas_comprobados),
    tomas_app_fuera_de_vigencia: [...(a.tomas_app_fuera_de_vigencia ?? []), ...(b.tomas_app_fuera_de_vigencia ?? [])],
    sin_tomas: [...(a.sin_tomas ?? []), ...(b.sin_tomas ?? [])],
    plan: b.plan ?? a.plan,
  };
}

export default function PlanTomasModal(props: Props) {
  const { periodo, elegidas, correr, ocupado, onCerrar, avisar, recargar } = props;
  const trabajando = !!ocupado;

  // ---- El plan que se arma --------------------------------------------------
  const conPlan = elegidas.filter((c) => !!c.plan_tomas);
  const [modo, setModo] = useState<Modo>('nuevo');
  // Si todas traen el mismo plan, se parte de él (editar en lote sin teclear de nuevo).
  const planComun = useMemo(() => {
    const textos = new Set(elegidas.map((c) => JSON.stringify(leerPlan(c.plan_tomas).plan)));
    return textos.size === 1 ? leerPlan(elegidas[0]?.plan_tomas).plan : null;
  }, [elegidas]);
  const [tipo, setTipo] = useState<TipoPlan>(planComun?.tipo ?? 'inicio');
  const [cadaN, setCadaN] = useState(planComun?.cada_n ? String(planComun.cada_n) : '7');
  const [fechas, setFechas] = useState<Set<string>>(() => new Set(planComun?.fechas ?? []));
  const [incluirComprobados, setIncluirComprobados] = useState(!!planComun?.incluir_comprobados);

  const planCrudo = useMemo(() => {
    const p: Record<string, unknown> = { tipo };
    if (tipo === 'cada_n') p.cada_n = cadaN.trim() === '' ? null : cadaN.trim();
    if (tipo === 'fechas') p.fechas = [...fechas].sort();
    if (incluirComprobados) p.incluir_comprobados = true;
    return p;
  }, [tipo, cadaN, fechas, incluirComprobados]);
  const lectura = useMemo(() => leerPlan(planCrudo), [planCrudo]);

  const diasPeriodo = useMemo(() => diasEntre(periodo.inicio, periodo.fin), [periodo.inicio, periodo.fin]);

  // ---- Sitios de las elegidas (para la previa) -----------------------------
  const [sitios, setSitios] = useState<Map<number, SitioPlan[]> | null>(null);
  const [errSitios, setErrSitios] = useState('');
  const [intento, setIntento] = useState(0);
  const idsClave = elegidas.map((c) => c.id).join(',');
  useEffect(() => {
    let vivo = true;
    setSitios(null);
    setErrSitios('');
    const ids = idsClave ? idsClave.split(',').map(Number) : [];
    if (!ids.length) {
      setSitios(new Map());
      return;
    }
    leerSitios({ campanaIds: ids }).then((r) => {
      if (!vivo) return;
      if (!r.ok) {
        setErrSitios('No se pudieron leer los sitios para la vista previa: ' + textoFallaComp(r));
        return;
      }
      const m = new Map<number, SitioPlan[]>();
      for (const s of r.data) {
        const l = m.get(s.campana_id);
        if (l) l.push(sitioPlan(s));
        else m.set(s.campana_id, [sitioPlan(s)]);
      }
      setSitios(m);
    });
    return () => {
      vivo = false;
    };
  }, [idsClave, intento]);

  // ---- Vista previa ---------------------------------------------------------
  const per = useMemo(() => ({ inicio: periodo.inicio, fin: periodo.fin }), [periodo.inicio, periodo.fin]);
  const previa = useMemo(() => {
    if (!sitios) return null;
    const out = {
      renglones: 0,
      campanasConTomas: 0,
      omitidas: [] as { c: VwCampana; motivo: string }[],
      sinTomas: [] as { c: VwCampana; motivo: string }[],
      sinPlan: [] as VwCampana[],
      sitiosSinVentana: [] as string[],
      sitiosSinFechas: [] as string[],
      sitiosComprobados: 0,
      sitiosExcluidos: 0,
      tomasActuales: 0,
      tomasEditadas: 0,
      error: null as string | null,
    };
    if (modo === 'nuevo' && lectura.error) {
      out.error = lectura.error;
      return out;
    }
    for (const c of elegidas) {
      // Primero si la base la salta (cerrada o retirada): resumenPlan
      // devuelve antes el error de un plan vacío y la contaría «sin plan».
      const cp = campanaPlan(c);
      const om = campanaOmitidaDelPlan(cp);
      if (om) {
        out.omitidas.push({ c, motivo: om === 'cerrada' ? 'cerrada' : 'retirada' });
        continue;
      }
      const plan = modo === 'nuevo' ? lectura.plan : c.plan_tomas;
      const r = resumenPlan(plan, cp, sitios.get(c.id) ?? [], per);
      out.tomasActuales += c.tomas_total;
      out.tomasEditadas += c.tomas_editadas;
      if (r.error) {
        // Solo pasa en «el que ya tiene»: la campaña no tiene plan o el guardado no sirve.
        out.sinPlan.push(c);
        continue;
      }
      out.renglones += r.renglones;
      out.sitiosComprobados += r.sitiosComprobados.length;
      out.sitiosExcluidos += r.sitiosExcluidos;
      for (const k of r.sitiosSinVentana) out.sitiosSinVentana.push(`${k} (${tituloCampana(c)})`);
      for (const k of r.sitiosSinFechas) out.sitiosSinFechas.push(`${k} (${tituloCampana(c)})`);
      if (r.renglones > 0) out.campanasConTomas++;
      else {
        const n = (sitios.get(c.id) ?? []).length;
        out.sinTomas.push({
          c,
          motivo: !n
            ? c.es_full
              ? 'FULL sin columnas todavía'
              : 'no tiene sitios'
            : r.sitiosComprobados.length && !r.sitiosSinVentana.length && !r.sitiosSinFechas.length
              ? 'todos sus sitios ya están comprobados'
              : 'ninguna fecha del plan cae en la vigencia de sus sitios',
        });
      }
    }
    out.sitiosSinVentana.sort(compararNatural);
    out.sitiosSinFechas.sort(compararNatural);
    return out;
  }, [sitios, modo, lectura, elegidas, per]);

  const muestra = useMemo(() => {
    if (!sitios || elegidas.length !== 1) return [];
    const c = elegidas[0];
    const plan = modo === 'nuevo' ? lectura.plan : c.plan_tomas;
    if (!plan) return [];
    return generarRenglonesPlan(plan, campanaPlan(c), sitios.get(c.id) ?? [], per).slice(0, MUESTRA);
  }, [sitios, elegidas, modo, lectura, per]);

  // Solo van a la base las abiertas y no retiradas: a las demás no les cambia nada.
  const aMandar = useMemo(() => {
    const omit = new Set(previa?.omitidas.map((o) => o.c.id) ?? []);
    return elegidas.filter((c) => !omit.has(c.id)).map((c) => c.id);
  }, [elegidas, previa]);

  const [err, setErr] = useState('');
  const [resultado, setResultado] = useState<ResGenerarTomas | null>(null);
  // Si una tanda falla a medias, aquí quedan las campañas que faltan y el
  // plan con que se mandó, para «Reintentar las que faltan» (revisión de
  // pantallas, 23-oct-2026): antes solo quedaba «Listo».
  const [faltan, setFaltan] = useState<number[]>([]);
  const [pedidas, setPedidas] = useState(0);
  const planMandado = useRef<PlanEnvio | null>(null);

  const puede =
    !!previa &&
    !previa.error &&
    aMandar.length > 0 &&
    !(modo === 'guardado' && previa.sinPlan.length > 0) &&
    !errSitios;

  async function generar(reintento = false) {
    if (!reintento && !previa) return;
    setErr('');
    const plan: PlanEnvio | null = reintento
      ? planMandado.current
      : modo === 'nuevo'
        ? (lectura.plan as PlanEnvio)
        : null;
    const lista = reintento ? faltan : aMandar;
    if (!lista.length) return;
    if (!reintento) {
      planMandado.current = plan;
      setPedidas(aMandar.length);
    }
    // Lo que ya se aplicó (las tandas anteriores a una falla también cuentan;
    // en un reintento se suma a lo de antes).
    const acc: { total: ResGenerarTomas | null; hechas: number } = { total: reintento ? resultado : null, hechas: 0 };
    const r = await correr('Generando tomas…', async () => {
      for (let i = 0; i < lista.length; i += TANDA) {
        const tanda = lista.slice(i, i + TANDA);
        const x = await generarTomas(tanda, plan);
        if (!x.ok) return { ok: false as const, error: x.error, sinRed: x.sinRed };
        acc.total = sumar(acc.total, x.data);
        acc.hechas += tanda.length;
      }
      return { ok: true as const };
    });
    if (!r) {
      setErr('Hay otra acción guardando. Espera a que termine.');
      return;
    }
    // Lo que sí se aplicó ya está en la base: se relee pase lo que pase.
    recargar();
    if (!r.ok) {
      setFaltan(lista.slice(acc.hechas));
      setErr(textoFallaEscrituraComp(r));
      if (acc.total) setResultado(acc.total);
      return;
    }
    setFaltan([]);
    if (acc.total) {
      setResultado(acc.total);
      avisar(`✓ Plan aplicado a ${fmtN(acc.total.campanas)} campañas · ${fmtN(acc.total.tomas_nuevas)} tomas nuevas`);
      props.onAplicado?.();
    }
  }

  const cerrar = () => {
    if (!trabajando) onCerrar();
  };

  const toggleFecha = (d: string) =>
    setFechas((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });

  const res = resultado;
  const lineas = (xs: unknown[]) => xs.map((x) => (typeof x === 'string' ? x : String(x)));

  return (
    <div className="overlay rt-overlay-full" onClick={cerrar}>
      <div
        className="modal rt-armado"
        role="dialog"
        aria-modal="true"
        aria-labelledby="comp-plan-tit"
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'relative', maxWidth: 760 }}
      >
        <CerrarModal onClick={cerrar} disabled={trabajando} />
        <h2 id="comp-plan-tit" style={{ marginTop: 0 }}>
          Plan de tomas · {fmtN(elegidas.length)} campaña{elegidas.length === 1 ? '' : 's'}
        </h2>
        <p className="phint">
          {periodo.etiqueta}: del {fmtDia(periodo.inicio)} al {fmtDia(periodo.fin)}. Las tomas caen dentro de la vigencia de cada sitio, con su horario
          del día. Las que se editaron a mano no se pisan.
        </p>

        {res ? (
          <>
            <div className={faltan.length ? 'banner' : 'ok-msg'} role="status">
              <b>
                {faltan.length
                  ? `Se aplicó a ${fmtN(pedidas - faltan.length)} de ${fmtN(pedidas)} campañas; faltan ${fmtN(faltan.length)}.`
                  : `✓ Plan aplicado a ${fmtN(res.campanas)} campaña${res.campanas === 1 ? '' : 's'}.`}
              </b>
              <div style={{ marginTop: 6, lineHeight: 1.6 }}>
                {fmtN(res.tomas_nuevas)} tomas nuevas · {fmtN(res.tomas_borradas)} borradas · {fmtN(res.tomas_actualizadas)} actualizadas ·{' '}
                {fmtN(res.tomas_conservadas)} se quedaron igual
                {res.tomas_canceladas ? ` · ${fmtN(res.tomas_canceladas)} quitadas` : ''}
                {res.tomas_regresadas ? ` · ${fmtN(res.tomas_regresadas)} regresadas` : ''}
                {res.cerradas_omitidas ? ` · ${fmtN(res.cerradas_omitidas)} cerradas sin tocar` : ''}
                {res.omitidas_comprobados ? ` · ${fmtN(res.omitidas_comprobados)} sitios ya comprobados sin tomas nuevas` : ''}
              </div>
            </div>
            {(res.tomas_app_fuera_de_vigencia ?? []).length > 0 && (
              <div className="banner">
                {fmtN(res.tomas_app_fuera_de_vigencia.length)} toma{res.tomas_app_fuera_de_vigencia.length === 1 ? '' : 's'} hecha
                {res.tomas_app_fuera_de_vigencia.length === 1 ? '' : 's'} a mano quedaron fuera de la vigencia del sitio: revísalas en Formato.
              </div>
            )}
            {(res.sin_tomas ?? []).length > 0 && (
              <div className="banner">
                Sin ninguna toma: {lineas(res.sin_tomas).slice(0, 12).join(', ')}
                {res.sin_tomas.length > 12 ? ` y ${fmtN(res.sin_tomas.length - 12)} más` : ''}.
              </div>
            )}
            {err && <div className="err">{err}</div>}
            <div className="modal-actions pie-fijo">
              <button type="button" className={faltan.length ? 'btn ghost' : 'btn'} onClick={cerrar} disabled={trabajando}>
                {faltan.length ? 'Cerrar' : 'Listo'}
              </button>
              {faltan.length > 0 && (
                <button type="button" className="btn" onClick={() => generar(true)} disabled={trabajando}>
                  {trabajando && <span className="spinner" />}
                  Reintentar las que faltan ({fmtN(faltan.length)})
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            {conPlan.length > 0 && (
              <div className="rt-chips rt-segmento" role="group" aria-label="Qué plan">
                {(
                  [
                    ['nuevo', 'Elegir un plan'],
                    ['guardado', `El que ya tiene cada una (${fmtN(conPlan.length)})`],
                  ] as const
                ).map(([v, t]) => (
                  <button
                    key={v}
                    type="button"
                    className={'rt-chip' + (modo === v ? ' on' : '')}
                    aria-pressed={modo === v}
                    disabled={trabajando}
                    onClick={() => setModo(v)}
                  >
                    {modo === v ? '✓ ' : ''}
                    {t}
                  </button>
                ))}
              </div>
            )}

            {modo === 'nuevo' && (
              <div style={{ marginTop: 12 }}>
                <div className="field">
                  <label>Cuándo se toma</label>
                  <div className="rt-chips rt-segmento" role="group" aria-label="Tipo de plan">
                    {TIPOS_PLAN.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={'rt-chip' + (tipo === t ? ' on' : '')}
                        aria-pressed={tipo === t}
                        disabled={trabajando}
                        onClick={() => setTipo(t)}
                      >
                        {tipo === t ? '✓ ' : ''}
                        {ETIQUETA_PLAN[t]}
                      </button>
                    ))}
                  </div>
                </div>
                {tipo === 'cada_n' && (
                  <div className="field" style={{ maxWidth: 220 }}>
                    <label htmlFor="comp-plan-n">Cada cuántos días (1 a {MAX_CADA_N})</label>
                    <input
                      id="comp-plan-n"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_CADA_N}
                      step={1}
                      value={cadaN}
                      disabled={trabajando}
                      onChange={(e) => setCadaN(e.target.value)}
                    />
                    <div className="phint" style={{ marginTop: 6 }}>
                      Se cuenta desde el primer día de cada sitio.
                    </div>
                  </div>
                )}
                {tipo === 'fechas' && (
                  <div className="field">
                    <label>
                      Días del periodo ({fmtN(fechas.size)} elegido{fechas.size === 1 ? '' : 's'})
                    </label>
                    <div className="rt-chips" role="group" aria-label="Días del plan">
                      {diasPeriodo.map((d) => {
                        const on = fechas.has(d);
                        return (
                          <button
                            key={d}
                            type="button"
                            className={'rt-chip' + (on ? ' on' : '')}
                            aria-pressed={on}
                            disabled={trabajando}
                            onClick={() => toggleFecha(d)}
                            style={{ minWidth: 64 }}
                          >
                            {on ? '✓ ' : ''}
                            {fmtDia(d)}
                          </button>
                        );
                      })}
                    </div>
                    <div className="phint">Un sitio solo recibe los días que caen en su vigencia.</div>
                  </div>
                )}
                <label className="rt-check" style={{ minHeight: 32 }}>
                  <input
                    type="checkbox"
                    checked={incluirComprobados}
                    disabled={trabajando}
                    onChange={(e) => setIncluirComprobados(e.target.checked)}
                  />
                  <span>También pedir toma de los sitios que ya están comprobados</span>
                </label>
              </div>
            )}

            {modo === 'guardado' && (
              <div className="lista-scroll" style={{ ...cajaLista, marginTop: 12 }}>
                {elegidas.map((c) => (
                  <div key={c.id}>
                    <b>{tituloCampana(c)}</b>: {describirPlan(c.plan_tomas)}
                  </div>
                ))}
              </div>
            )}

            {/* Vista previa */}
            <div className="rt-seccion" style={{ marginTop: 14 }}>
              <div className="rt-seccion-tit">Vista previa</div>
              {errSitios ? (
                <>
                  <div className="err">{errSitios}</div>
                  <button type="button" className="btn ghost sm" onClick={() => setIntento((n) => n + 1)}>
                    Volver a leer
                  </button>
                </>
              ) : !previa ? (
                <div className="phint">
                  <span className="spinner" />
                  Leyendo los sitios…
                </div>
              ) : previa.error ? (
                <div className="err">{previa.error}</div>
              ) : (
                <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                  <div>
                    <b>Hasta {fmtN(previa.renglones)} renglones</b> en {fmtN(previa.campanasConTomas)} campaña
                    {previa.campanasConTomas === 1 ? '' : 's'}.
                    {previa.tomasActuales > 0 &&
                      ` Hoy tienen ${fmtN(previa.tomasActuales)}; las del plan anterior que ya no salgan se borran si siguen pendientes.`}
                    {previa.tomasEditadas > 0 && ` ${fmtN(previa.tomasEditadas)} editadas a mano se respetan.`}
                  </div>
                  {previa.sinPlan.length > 0 && (
                    <div className="err" style={{ marginTop: 8 }}>
                      {fmtN(previa.sinPlan.length)} campaña{previa.sinPlan.length === 1 ? '' : 's'} todavía no tiene
                      {previa.sinPlan.length === 1 ? '' : 'n'} plan: {previa.sinPlan.slice(0, 8).map(tituloCampana).join(', ')}
                      {previa.sinPlan.length > 8 ? '…' : ''}. Elige un plan para todas o quítalas de la selección.
                    </div>
                  )}
                  {previa.omitidas.length > 0 && (
                    <div style={{ color: 'var(--muted)' }}>
                      Se omiten {fmtN(previa.omitidas.length)}:{' '}
                      {previa.omitidas
                        .slice(0, 8)
                        .map((o) => `${tituloCampana(o.c)} (${o.motivo})`)
                        .join(', ')}
                      {previa.omitidas.length > 8 ? ` y ${fmtN(previa.omitidas.length - 8)} más` : ''}. No reciben tomas.
                    </div>
                  )}
                  {previa.sinTomas.length > 0 && (
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ cursor: 'pointer', fontWeight: 700, color: 'var(--warn)', minHeight: 32 }}>
                        {fmtN(previa.sinTomas.length)} campaña{previa.sinTomas.length === 1 ? '' : 's'} se quedaría
                        {previa.sinTomas.length === 1 ? '' : 'n'} sin ninguna toma
                      </summary>
                      <div className="lista-scroll" style={cajaLista}>
                        {previa.sinTomas.map((o) => (
                          <div key={o.c.id}>
                            {tituloCampana(o.c)}: {o.motivo}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {previa.sitiosSinVentana.length + previa.sitiosSinFechas.length > 0 && (
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ cursor: 'pointer', fontWeight: 700, minHeight: 32 }}>
                        {fmtN(previa.sitiosSinVentana.length + previa.sitiosSinFechas.length)} sitios sin toma
                      </summary>
                      <div className="lista-scroll" style={cajaLista}>
                        {previa.sitiosSinVentana.length > 0 && (
                          <>
                            <div style={{ fontWeight: 700 }}>Su vigencia no toca el periodo ({fmtN(previa.sitiosSinVentana.length)})</div>
                            {previa.sitiosSinVentana.slice(0, 200).map((s) => (
                              <div key={'v' + s}>{s}</div>
                            ))}
                          </>
                        )}
                        {previa.sitiosSinFechas.length > 0 && (
                          <>
                            <div style={{ fontWeight: 700, marginTop: 6 }}>
                              Ninguna fecha del plan cae en su vigencia ({fmtN(previa.sitiosSinFechas.length)})
                            </div>
                            {previa.sitiosSinFechas.slice(0, 200).map((s) => (
                              <div key={'f' + s}>{s}</div>
                            ))}
                          </>
                        )}
                        {previa.sitiosSinVentana.length + previa.sitiosSinFechas.length > 400 && <div>…</div>}
                      </div>
                    </details>
                  )}
                  {(previa.sitiosComprobados > 0 || previa.sitiosExcluidos > 0) && (
                    <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                      {previa.sitiosComprobados > 0 &&
                        `${fmtN(previa.sitiosComprobados)} sitios ya comprobados no reciben tomas nuevas${
                          modo === 'nuevo' ? ' (marca la casilla de arriba si sí las necesitan)' : ''
                        }. `}
                      {previa.sitiosExcluidos > 0 && `${fmtN(previa.sitiosExcluidos)} cancelados o fuera de la carga no llevan tomas.`}
                    </div>
                  )}
                </div>
              )}
              {muestra.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13, minHeight: 32 }}>
                    Muestra de renglones ({fmtN(muestra.length)})
                  </summary>
                  <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 10, marginTop: 6 }}>
                    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12, minWidth: 520 }}>
                      <thead>
                        <tr>
                          {['Día', 'Sitio', 'Horario', 'Observaciones'].map((t) => (
                            <th key={t} style={{ ...celda, ...sinQuiebre, textAlign: 'left', background: 'var(--panel2)', color: 'var(--muted)' }}>
                              {t}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {muestra.map((r) => (
                          <tr key={r.sitio_clave + r.fecha}>
                            <td style={{ ...celda, ...sinQuiebre }}>{fmtDia(r.fecha)}</td>
                            <td style={{ ...celda, ...sinQuiebre }}>{r.sitio_clave}</td>
                            <td style={{ ...celda, ...textoLegible }}>{r.horarioMostrar || '—'}</td>
                            <td style={{ ...celda, ...textoLegible }}>{r.observacionesExcel || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>

            {err && (
              <div className="err" role="alert">
                {err}
              </div>
            )}

            <div className="rt-pie">
              <button type="button" className="btn ghost" onClick={cerrar} disabled={trabajando}>
                Cancelar
              </button>
              <button type="button" className="btn" disabled={!puede || trabajando} onClick={() => generar()}>
                {trabajando && <span className="spinner" />}
                {trabajando
                  ? ocupado
                  : `Generar tomas en ${fmtN(aMandar.length)} campaña${aMandar.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
