// ============================================================
// src/modules/comprobaciones/ArmarCarga.tsx
// Previa y carga de campañas en «Armar el periodo» (23-oct-2026). La usan
// las cuatro fuentes: bitácora, Pauta VV, alta manual y «copiar».
//
// POR QUÉ así:
//   1. Antes de mandar nada se compara con lo YA cargado
//      (revisarContraCargadas): una «ampliación» de la bitácora en otro
//      archivo no debe dar de baja los sitios del primero. Si hay
//      cambios, el Supervisor elige automático / agregar / reemplazar.
//   2. La previa es la base misma: comp_cargar_campanas con
//      p_solo_revisar = true hace todo y lo deshace, y devuelve las cifras
//      reales (nuevas, actualizadas, retiradas, posibles duplicados, sin
//      inventario, fuera del periodo…). Se enseñan TODAS.
//   3. Al confirmar se vuelve a leer lo cargado; si cambió desde la previa
//      (otra pestaña u otra persona) no se carga y se pide revisar de nuevo.
//   4. Vía Verde va en una llamada por medio (Columna y Pórtico). Si la
//      primera falla, la segunda no se manda.
//   5. Después de cargar se ofrece el plan de tomas (los sugeridos por la
//      bitácora van «por confirmar»).
// Todo pasa por ctx.correr: una escritura a la vez en el módulo.
// ============================================================

import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { HORARIO_24H, esMedio24h, type MedioComp } from '../../lib/comprobaciones';
import {
  llaveContrato,
  revisarContraCargadas,
  type CambioContraCargada,
  type CampanaCargada,
  type CampanaContrato,
  type ModoCarga,
  type PlanSugerido,
} from '../../lib/bitacoraComp';
import {
  cargarCampanas,
  leerCampanasCargadas,
  textoFallaComp,
  textoFallaEscrituraComp,
  type ReporteCarga,
} from '../../lib/comprobacionesApi';
import { describirPlan } from '../../lib/comprobaciones';
import type { PropsArmar } from './tiposComp';
import { aTexto, etiquetaCampana, fmt, sitiosDe, vigenciaTexto, type EntradaMedio } from './ArmarComun';
import { AvisoPlanDeCarga, PlanesDeTomas, gruposDePlan, type GrupoPlan } from './ArmarPlan';

// ------------------------------------------------------------
// Piezas de presentación
// ------------------------------------------------------------

/** Lista larga plegada («+N más» sin ocupar la pantalla). */
export function ListaPlegable({
  titulo,
  items,
  tono,
  abierta,
}: {
  titulo: ReactNode;
  items: string[];
  tono?: 'warn' | 'bad';
  abierta?: boolean;
}) {
  if (!items.length) return null;
  const color = tono === 'bad' ? 'var(--bad)' : tono === 'warn' ? 'var(--warn)' : 'var(--txt)';
  return (
    <details open={abierta} style={{ marginTop: 6, fontSize: 13 }}>
      <summary style={{ cursor: 'pointer', color }}>{titulo}</summary>
      <div
        className="lista-scroll"
        style={{
          maxHeight: 200,
          overflowY: 'auto',
          fontSize: 12,
          color: 'var(--muted)',
          overflowWrap: 'anywhere',
          padding: '4px 0 0 14px',
          lineHeight: 1.6,
        }}
      >
        {items.map((t, i) => (
          <div key={i}>{t}</div>
        ))}
      </div>
    </details>
  );
}

/** Caja gris de «lo que se detectó» (mismo estilo que ImportarPautaModal). */
export function Caja({ titulo, children }: { titulo?: ReactNode; children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--panel2)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '11px 12px',
        marginBottom: 14,
        fontSize: 13,
        lineHeight: 1.7,
      }}
    >
      {titulo && <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>{titulo}</div>}
      {children}
    </div>
  );
}

const B = ({ children }: { children: ReactNode }) => <b style={{ color: 'var(--txt)' }}>{children}</b>;

/** Horario que se enseña de una campaña: «24 HORAS» en Biobox y Ecovallas; en Vía Verde el de L-V. */
function horarioDe(medio: MedioComp, c: CampanaContrato): string {
  if (esMedio24h(medio)) return HORARIO_24H;
  const hs = [...new Set(c.sitios.map((s) => (s.horario_lv || '').trim()).filter(Boolean))];
  if (!hs.length) return '—';
  return hs.length === 1 ? hs[0] : `${hs[0]} (+${hs.length - 1})`;
}

/** Tabla de lo que se va a cargar (una fila por campaña-versión). Pensada para PC. */
export function TablaContrato({
  entradas,
  sugeridos,
  mostrarMedio,
}: {
  entradas: EntradaMedio[];
  sugeridos?: Record<string, PlanSugerido> | null;
  mostrarMedio?: boolean;
}) {
  const filas = entradas.flatMap((e) => e.campanas.map((c) => ({ medio: e.medio, c })));
  if (!filas.length) return null;
  const th: React.CSSProperties = {
    position: 'sticky',
    top: 0,
    background: 'var(--panel)',
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: '1px solid var(--line)',
    fontSize: 11,
    color: 'var(--muted)',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = { padding: '5px 8px', borderBottom: '1px solid var(--line)', verticalAlign: 'top' };
  return (
    <div
      style={{ maxHeight: 380, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10, marginBottom: 14 }}
    >
      <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
        <thead>
          <tr>
            {mostrarMedio && <th style={th}>Medio</th>}
            <th style={th}>Campaña</th>
            <th style={th}>Versión</th>
            <th style={th}>Cliente</th>
            <th style={{ ...th, textAlign: 'right' }}>Sitios</th>
            <th style={th}>Vigencia</th>
            <th style={th}>Horario</th>
            {sugeridos && <th style={th}>Plan sugerido</th>}
          </tr>
        </thead>
        <tbody>
          {filas.map(({ medio, c }, i) => {
            const s = sugeridos?.[llaveContrato(c)];
            return (
              <tr key={i}>
                {mostrarMedio && <td style={td}>{medio}</td>}
                <td style={{ ...td, overflowWrap: 'anywhere', minWidth: 160 }}>
                  {c.campana}
                  {c.es_full && (
                    <span className="tag" style={{ marginLeft: 6 }}>
                      FULL
                    </span>
                  )}
                </td>
                <td style={td}>{c.version || '—'}</td>
                <td style={{ ...td, overflowWrap: 'anywhere' }}>{c.cliente || '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{fmt(c.sitios.length)}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{vigenciaTexto(c.inicio, c.fin)}</td>
                <td style={td}>{horarioDe(medio, c)}</td>
                {sugeridos && <td style={td}>{s ? `${describirPlan(s.plan)} (${s.comprobacion})` : '—'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Lo que contestó comp_cargar_campanas (previa o carga real). */
export function ReporteVista({ r, previa, mostrarMedio }: { r: ReporteCarga; previa: boolean; mostrarMedio: boolean }) {
  const n = (x: unknown) => (Array.isArray(x) ? x.length : 0);
  const lista = (x: unknown) => (Array.isArray(x) ? x.map(aTexto) : []);
  const retiradas = (r.campanas_retiradas ?? []).map(
    (c) =>
      `${etiquetaCampana(c)}${c.borrada ? ' (se borra: nadie la trabajó)' : ''}${c.reemplazada_por ? ` → la reemplaza la #${c.reemplazada_por}` : ''}`
  );
  const dups = (r.posibles_duplicados ?? []).map((d) => `${etiquetaCampana(d)} · de ${d.fuente}`);
  const adoptadas = (r.campanas_adoptadas ?? []).map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    return `${String(o.campana ?? '')}: del plano sin versión → «${String(o.version ?? '')}»`;
  });
  const tomas =
    r.tomas_nuevas + r.tomas_borradas + r.tomas_actualizadas + r.tomas_canceladas + r.tomas_regresadas > 0 ||
    r.campanas_replanificadas > 0;
  return (
    <Caja titulo={`${mostrarMedio ? r.medio + ' · ' : ''}${previa ? 'Lo que haría la carga (previa de la base)' : 'Lo que hizo la base'}`}>
      <div style={{ color: 'var(--muted)' }}>
        <B>{fmt(r.campanas_recibidas)}</B> campañas-versión · <B>{fmt(r.sitios_recibidos)}</B> sitios recibidos
        {r.completa && ' · cuenta como la foto completa del periodo'}
        <br />
        Campañas: <B>{fmt(r.campanas_nuevas)}</B> nuevas · <B>{fmt(r.campanas_actualizadas)}</B> actualizadas
        {r.campanas_duplicadas > 0 && <> · {fmt(r.campanas_duplicadas)} venían repetidas y se juntaron</>}
        {r.analista_de_la_app_conservada > 0 && <> · {fmt(r.analista_de_la_app_conservada)} conservan la analista puesta en la app</>}
        <br />
        Sitios: <B>{fmt(r.sitios_nuevos)}</B> nuevos · <B>{fmt(r.sitios_actualizados)}</B> actualizados ·{' '}
        <B>{fmt(r.sitios_baja)}</B> de baja
        {r.sitios_fuera_de_carga > 0 && <> · {fmt(r.sitios_fuera_de_carga)} ya trabajados quedan «fuera de carga» (no se borran)</>}
        {tomas && (
          <>
            <br />
            Tomas de las {fmt(r.campanas_replanificadas)} campaña(s) que ya tenían plan: <B>{fmt(r.tomas_nuevas)}</B> nuevas ·{' '}
            {fmt(r.tomas_actualizadas)} actualizadas · {fmt(r.tomas_borradas)} quitadas
            {r.tomas_canceladas + r.tomas_regresadas > 0 && (
              <>
                {' '}
                · {fmt(r.tomas_canceladas)} canceladas · {fmt(r.tomas_regresadas)} regresadas
              </>
            )}
          </>
        )}
        {!previa && r.sin_analista > 0 && (
          <>
            <br />
            {fmt(r.sin_analista)} campaña(s) abiertas quedan sin analista: asígnalas en Campañas.
          </>
        )}
      </div>
      <ListaPlegable
        tono="warn"
        abierta={retiradas.length <= 5}
        titulo={`${fmt(retiradas.length)} campaña(s) ${previa ? 'se retirarían' : 'se retiraron'}: ya no vienen en la foto completa${r.campanas_borradas ? ` (${fmt(r.campanas_borradas)} se ${previa ? 'borrarían' : 'borraron'})` : ''}`}
        items={retiradas}
      />
      <ListaPlegable
        tono="warn"
        abierta={dups.length <= 5}
        titulo={`${fmt(dups.length)} posible(s) duplicado(s): la misma campaña sigue abierta con otra versión. Si sobra, retírala en Campañas.`}
        items={dups}
      />
      <ListaPlegable titulo={`${fmt(adoptadas.length)} campaña(s) del plano toman la versión de Pauta VV`} items={adoptadas} />
      <ListaPlegable
        tono="warn"
        titulo={`${fmt(n(r.cerradas_sin_tocar))} campaña(s) cerradas no se tocan`}
        items={lista(r.cerradas_sin_tocar)}
      />
      <ListaPlegable
        tono="warn"
        titulo={`${fmt(n(r.sin_inventario))} clave(s) no están en el inventario (entran, pero revisa la clave)`}
        items={lista(r.sin_inventario)}
      />
      <ListaPlegable
        tono="warn"
        titulo={`${fmt(n(r.sitios_fuera_del_periodo))} sitio(s) no tocan el periodo: no entran`}
        items={lista(r.sitios_fuera_del_periodo)}
      />
      <ListaPlegable
        titulo={`${fmt(n(r.sitios_repetidos))} sitio(s) venían en varios renglones y se juntaron`}
        items={(r.sitios_repetidos ?? []).map((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          return `${aTexto(x)}${typeof o.renglones === 'number' ? ` × ${o.renglones}` : ''}`;
        })}
      />
      <ListaPlegable titulo={`${fmt(n(r.edo_mex_omitidas))} de EDO MEX omitidas (de baja)`} items={lista(r.edo_mex_omitidas)} />
      <ListaPlegable titulo={`${fmt(n(r.inactivas_omitidas))} columnas inactivas omitidas`} items={lista(r.inactivas_omitidas)} />
      <ListaPlegable titulo={`${fmt(n(r.otro_medio_omitidas))} de otro medio omitidas`} items={lista(r.otro_medio_omitidas)} />
      <ListaPlegable
        tono="warn"
        titulo={`${fmt(n(r.tomas_app_fuera_de_vigencia))} toma(s) editadas a mano quedan fuera de la vigencia (no se tocan)`}
        items={lista(r.tomas_app_fuera_de_vigencia).map((x) => `Toma #${x}`)}
      />
      <ListaPlegable
        tono="warn"
        titulo={`${fmt(n(r.analistas_no_reconocidos))} analista(s) propuestas no tienen rol de analista en la unidad (no se asignan)`}
        items={lista(r.analistas_no_reconocidos)}
      />
    </Caja>
  );
}

// ------------------------------------------------------------
// Previa y carga
// ------------------------------------------------------------

type Revision = {
  medio: MedioComp;
  /** Lo que se mandaría (ya pasado por revisarContraCargadas). */
  campanas: CampanaContrato[];
  avisos: string[];
  cambios: CambioContraCargada[];
  reporte: ReporteCarga | null;
  error: string;
};

type Resultado = { medio: MedioComp; reporte: ReporteCarga | null; error: string };

type Fase = 'revisando' | 'previa' | 'confirmar' | 'cargando' | 'hecho';

const firma = (cs: CampanaContrato[]) =>
  cs
    .map((c) => `${llaveContrato(c)}:${c.sitios.length}`)
    .sort()
    .join('|');

const ETIQUETA_MODO: Record<ModoCarga, string> = {
  auto: 'Automático',
  agregar: 'Agregar sitios',
  reemplazar: 'Reemplazar sitios',
};

async function cargadasDe(periodoId: number | null, medio: MedioComp): Promise<{ ok: true; data: CampanaCargada[] } | { ok: false; error: string }> {
  if (periodoId == null) return { ok: true, data: [] };
  const r = await leerCampanasCargadas(periodoId, medio);
  return r.ok ? r : { ok: false, error: 'No se pudo leer lo ya cargado: ' + textoFallaComp(r) };
}

export function PreviaCarga({
  ctx,
  entradas,
  completa,
  planesSugeridos,
  onVolver,
}: {
  ctx: PropsArmar;
  entradas: EntradaMedio[];
  /** null = la base lo deduce (bitácora, alta); true = foto completa de Pauta VV. */
  completa: boolean | null;
  planesSugeridos?: Record<string, PlanSugerido> | null;
  /**
   * Regresar a la fuente: `cargado` false = volver a corregir antes de
   * cargar; true = ya se cargó («Terminar»), la fuente puede limpiarse.
   */
  onVolver: (cargado: boolean) => void;
}) {
  const [modo, setModo] = useState<ModoCarga>('auto');
  const [fase, setFase] = useState<Fase>('revisando');
  const [revs, setRevs] = useState<Revision[]>([]);
  const [err, setErr] = useState('');
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const [grupos, setGrupos] = useState<GrupoPlan[]>([]);
  const enCurso = useRef(false);
  const modoRef = useRef(modo);
  modoRef.current = modo;
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);
  const varios = entradas.length > 1;

  // Con la carga hecha y su plan a la vista, ArmarPeriodo esconde el suyo
  // (ver AvisoPlanDeCarga).
  const avisoPlan = useContext(AvisoPlanDeCarga);
  const planVisible = fase === 'hecho' && grupos.length > 0;
  useEffect(() => {
    if (!planVisible || !avisoPlan) return;
    avisoPlan(true);
    return () => avisoPlan(false);
  }, [planVisible, avisoPlan]);

  const revisar = async (m: ModoCarga) => {
    if (enCurso.current) return;
    enCurso.current = true;
    setFase('revisando');
    setErr('');
    const periodoId = ctx.periodo.id;
    const out = await ctx.correr('Revisando contra la base…', async () => {
      const lista: Revision[] = [];
      for (const e of entradas) {
        const c = await cargadasDe(periodoId, e.medio);
        if (!c.ok) {
          lista.push({ medio: e.medio, campanas: e.campanas, avisos: [], cambios: [], reporte: null, error: c.error });
          continue;
        }
        const rv = revisarContraCargadas(e.campanas, c.data, e.medio, m);
        const p = await cargarCampanas({
          unidad: ctx.unidad,
          medio: e.medio,
          periodo: ctx.periodo,
          campanas: rv.campanas,
          soloRevisar: true,
          completa,
        });
        lista.push({
          medio: e.medio,
          campanas: rv.campanas,
          avisos: rv.avisos,
          cambios: rv.cambios,
          reporte: p.ok ? p.data : null,
          error: p.ok ? '' : 'La base no aceptó la previa: ' + textoFallaComp(p),
        });
      }
      return lista;
    });
    enCurso.current = false;
    if (!vivo.current) return;
    if (!out) {
      setErr('Hay otra operación en curso. Espera a que termine y pulsa «Revisar de nuevo».');
      setFase('previa');
      return;
    }
    // Si el modo cambió mientras se revisaba, se revisa otra vez con el nuevo.
    if (modoRef.current !== m) {
      void revisar(modoRef.current);
      return;
    }
    setRevs(out);
    setFase('previa');
  };

  useEffect(() => {
    void revisar(modo);
    // Solo al cambiar el modo (las entradas no cambian: la fuente monta otra previa).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modo]);

  /**
   * Carga los medios de la previa. Con `solo`, únicamente esos (reintentar
   * el que faltó sin volver a leer el archivo; revisión 2, uso-8): lo que ya
   * se cargó antes se conserva en el resultado.
   */
  const cargar = async (solo?: Set<MedioComp>) => {
    setErr('');
    setFase('cargando');
    const periodoId = ctx.periodo.id;
    const previos = solo ? resultados.filter((x) => x.reporte && !solo.has(x.medio)) : [];
    const out = await ctx.correr('Cargando campañas…', async () => {
      const res: Resultado[] = [];
      for (const rv of revs) {
        if (solo && !solo.has(rv.medio)) continue;
        const e = entradas.find((x) => x.medio === rv.medio)!;
        // Lo cargado no debe haber cambiado desde la previa.
        const c = await cargadasDe(periodoId, rv.medio);
        if (!c.ok) {
          res.push({ medio: rv.medio, reporte: null, error: c.error });
          break;
        }
        const otra = revisarContraCargadas(e.campanas, c.data, rv.medio, modo);
        if (firma(otra.campanas) !== firma(rv.campanas)) {
          res.push({
            medio: rv.medio,
            reporte: null,
            error: 'Lo cargado cambió desde la previa (otra pestaña u otra persona). No se cargó; pulsa «Revisar de nuevo».',
          });
          break;
        }
        const r = await cargarCampanas({
          unidad: ctx.unidad,
          medio: rv.medio,
          periodo: ctx.periodo,
          campanas: rv.campanas,
          soloRevisar: false,
          completa,
        });
        if (!r.ok) {
          res.push({ medio: rv.medio, reporte: null, error: textoFallaEscrituraComp(r) });
          break;
        }
        res.push({ medio: rv.medio, reporte: r.data, error: '' });
      }
      return res;
    });
    if (!vivo.current) return;
    if (!out) {
      setErr('Hay otra operación en curso. Espera a que termine y vuelve a intentar.');
      setFase(previos.length ? 'hecho' : 'previa');
      return;
    }
    // Los medios que no se intentaron (un error antes cortó el lote) cuentan
    // como pendientes: se dicen y se pueden reintentar.
    const intentados = new Set(out.map((x) => x.medio));
    const sinIntentar: Resultado[] = revs
      .filter((rv) => (!solo || solo.has(rv.medio)) && !intentados.has(rv.medio))
      .map((rv) => ({ medio: rv.medio, reporte: null, error: '' }));
    const buenos = out.filter((x) => x.reporte);
    setResultados([...previos, ...out, ...sinIntentar]);
    if (buenos.length) {
      // periodos: true → si el periodo era nuevo, el selector recibe su id.
      ctx.recargar({ periodos: true });
      const nuevas = buenos.reduce((a, x) => a + x.reporte!.campanas_nuevas, 0);
      const act = buenos.reduce((a, x) => a + x.reporte!.campanas_actualizadas, 0);
      ctx.avisar(`✓ Cargadas: ${fmt(nuevas)} nuevas · ${fmt(act)} actualizadas`);
      const ids = buenos.flatMap((x) =>
        x.reporte!.campanas.filter((c) => c.id != null && c.estatus === 'abierta').map((c) => ({ id: c.id!, campana: c.campana, version: c.version }))
      );
      // Foto de los grupos AHORA: si se recalcularan con la lista nueva, el
      // grupo desaparecería al aplicar el plan y con él su resultado. En un
      // reintento se AGREGAN (los de antes pueden tener su plan a medias).
      const nuevos = gruposDePlan(ids, planesSugeridos, ctx.campanas);
      if (solo) {
        const n = Date.now();
        setGrupos((g) => [...g, ...nuevos.map((x) => ({ ...x, clave: `r${n}|${x.clave}` }))]);
      } else setGrupos(nuevos);
    }
    setFase(out.some((x) => x.error) && !buenos.length && !previos.length ? 'previa' : 'hecho');
    if (out.some((x) => x.error)) setErr(out.filter((x) => x.error).map((x) => `${varios ? x.medio + ': ' : ''}${x.error}`).join(' '));
  };

  const totalCampanas = revs.reduce((a, r) => a + r.campanas.length, 0);
  const totalSitios = revs.reduce((a, r) => a + sitiosDe(r.campanas), 0);
  const conError = revs.some((r) => r.error || !r.reporte);
  const hayCambios = revs.some((r) => r.cambios.length > 0);
  const avisosRevision = revs.flatMap((r) => r.avisos.map((a) => (varios ? `${r.medio}: ${a}` : a)));
  const ocupado = ctx.ocupado != null;
  const mostrarMedio = entradas.length > 1;

  if (fase === 'hecho') {
    const cargados = resultados.filter((x) => x.reporte).map((x) => x.medio);
    const faltan = revs.map((r) => r.medio).filter((m) => !cargados.includes(m));
    return (
      <div>
        {err && <div className="err">{err}</div>}
        {faltan.length ? (
          // Antes decía «Listo: … quedó cargado» aunque faltara un medio.
          <div className="banner">
            <b>
              Se cargó {cargados.join(' y ')}; {faltan.join(' y ')} no.
            </b>{' '}
            Reintenta lo que faltó sin volver a leer el archivo.
            <div style={{ marginTop: 8 }}>
              <button type="button" className="btn sm" disabled={ocupado} onClick={() => void cargar(new Set(faltan))}>
                Reintentar {faltan.join(' y ')}
              </button>
            </div>
          </div>
        ) : (
          <div className="ok-msg">
            <b>Listo: {ctx.periodo.etiqueta} quedó cargado.</b> Lo que contestó la base, abajo.
          </div>
        )}
        {resultados
          .filter((x) => x.reporte)
          .map((x) => (
            <ReporteVista key={x.medio} r={x.reporte!} previa={false} mostrarMedio={mostrarMedio} />
          ))}
        <PlanesDeTomas ctx={ctx} grupos={grupos} titulo="Siguiente paso: el plan de tomas de lo que acabas de cargar" />
        <div style={{ marginTop: 14 }}>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              // Con un medio sin cargar, «Terminar» borraba los archivos que
              // hacen falta para reintentarlo: se pregunta.
              if (
                faltan.length &&
                !window.confirm(`${faltan.join(' y ')} no se cargó. Si terminas, para cargarlo hay que volver a subir el archivo. ¿Terminar?`)
              )
                return;
              onVolver(true);
            }}
            disabled={ocupado}
          >
            Terminar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ fontSize: 15, margin: '6px 0 8px' }}>Previa contra la base · {ctx.periodo.etiqueta}</h3>
      {err && <div className="err">{err}</div>}
      {fase === 'revisando' && (
        <div className="phint">
          <span className="spinner" />
          Revisando contra lo ya cargado y pidiendo la previa a la base…
        </div>
      )}
      {hayCambios && (
        <Caja titulo="Estas campañas ya estaban cargadas con otros sitios">
          <div style={{ color: 'var(--muted)', marginBottom: 8 }}>
            <b>Automático</b>: si vienen de OTRO archivo u hoja de la bitácora se suman (ampliación); si es el mismo archivo,
            Pauta VV o el alta, la lista nueva manda. Lo ya comprobado nunca se borra: queda «fuera de carga».
          </div>
          <div className="rt-chips rt-segmento" role="group" aria-label="Cómo cargar los sitios">
            {(['auto', 'agregar', 'reemplazar'] as ModoCarga[]).map((m) => (
              <button
                key={m}
                type="button"
                className={'rt-chip' + (modo === m ? ' on' : '')}
                aria-pressed={modo === m}
                disabled={ocupado}
                onClick={() => setModo(m)}
              >
                {ETIQUETA_MODO[m]}
              </button>
            ))}
          </div>
          <ListaPlegable
            abierta
            titulo={`${fmt(revs.reduce((a, r) => a + r.cambios.length, 0))} campaña(s) con sitios que esta carga no trae`}
            items={revs.flatMap((r) =>
              r.cambios.map(
                (c) =>
                  `${etiquetaCampana(c)} (antes de «${c.origen_anterior ?? '—'}»): ${c.modo === 'agregar' ? 'se conservan' : 'se dan de baja'} ${fmt(c.sitios_que_no_vienen.length)} sitio(s)`
              )
            )}
          />
        </Caja>
      )}
      {avisosRevision.length > 0 && (
        <div className="banner">
          {avisosRevision.slice(0, 4).map((a, i) => (
            <div key={i}>{a}</div>
          ))}
          {avisosRevision.length > 4 && <ListaPlegable titulo={`+${avisosRevision.length - 4} más`} items={avisosRevision.slice(4)} />}
        </div>
      )}
      {revs.map((r) =>
        r.error ? (
          <div key={r.medio} className="err">
            {mostrarMedio ? `${r.medio}: ` : ''}
            {r.error}
          </div>
        ) : r.reporte ? (
          <ReporteVista key={r.medio} r={r.reporte} previa mostrarMedio={mostrarMedio} />
        ) : null
      )}

      {fase === 'confirmar' && (
        <div className="banner" role="alert" style={{ fontSize: 13 }}>
          ¿Cargar <b>{fmt(totalCampanas)}</b> campañas-versión y <b>{fmt(totalSitios)}</b> sitios en <b>{ctx.periodo.etiqueta}</b>
          {mostrarMedio ? ` (${revs.map((r) => r.medio).join(' y ')}, una carga por medio)` : ''}? Lo hecho en la app
          (analista, marcas, cancelados, cerradas, editados) se conserva.
          <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={() => void cargar()} disabled={ocupado}>
              Sí, cargar
            </button>
            <button type="button" className="btn ghost" onClick={() => setFase('previa')} disabled={ocupado}>
              Todavía no
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
        {fase !== 'confirmar' && (
          <button
            type="button"
            className="btn"
            disabled={ocupado || fase !== 'previa' || conError || !revs.length || totalCampanas === 0}
            onClick={() => setFase('confirmar')}
          >
            {fase === 'cargando' ? 'Cargando…' : `Cargar ${fmt(totalCampanas)} campañas · ${fmt(totalSitios)} sitios`}
          </button>
        )}
        <button type="button" className="btn ghost" disabled={ocupado} onClick={() => void revisar(modo)}>
          Revisar de nuevo
        </button>
        <button type="button" className="btn ghost" disabled={ocupado} onClick={() => onVolver(false)}>
          Volver
        </button>
      </div>
    </div>
  );
}
