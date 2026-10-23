// ============================================================
// src/modules/comprobaciones/AvanceComprobaciones.tsx
// Avance del periodo (Erik, 23-oct-2026): lo que hoy se teclea a mano en la
// hoja COMPROBACIÓN DIARIA y en el renglón de totales por DISEÑADOR, ahora
// solo. Lo ven el Supervisor (y el manager) y el Coordinador, en lectura.
//
//   · Tarjetas del periodo: campañas, meta, comprobados, hoy, pendientes,
//     vencidas y sin analista (de vw_comp_campanas, que ya trae el esqueleto).
//   · Por analista (vw_comp_avance_analista): la CARGA (campañas, meta,
//     pendientes, vencidas) es de quien lleva la campaña HOY; el CRÉDITO
//     (marcó, hoy) es de quien marcó. Así «pasar lo pendiente» no le suma a B
//     lo que comprobó A (crítica de la fase 2).
//   · Comprobación diaria (vw_comp_diaria + pivotDiaria): una fila por
//     campaña o por analista y una columna por día del periodo; la primera
//     columna se queda fija al deslizar y los fines de semana van sombreados.
//     Lo marcado fuera del periodo (P4 deja fechar 7 días atrás) va en su
//     columna para que el total cuadre con lo comprobado.
//
// Solo LEE: no escribe nada. Se vuelve a leer en silencio cada vez que el
// esqueleto relee las campañas (↻, avisos o una escritura de otra pestaña).
// ============================================================

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { BookOpen, RotateCw } from 'lucide-react';
import Ic from '../../components/Ic';
import {
  CLAVE_SIN_REGISTRO,
  ETIQUETA_SIN_REGISTRO,
  diasEntre,
  hoyCdmx,
  pctAvance,
  pivotDiaria,
} from '../../lib/comprobaciones';
import {
  leerAvanceAnalista,
  leerDiaria,
  textoFallaComp,
  type VwAvanceAnalista,
  type VwDiaria,
} from '../../lib/comprobacionesApi';
import { colorTono } from '../../lib/tonos';
import { vigilarRender } from '../../lib/vigia';
import { Barra, cabezaDia, nf, sinPorComprobar, textoAvance } from './AvanceComun';
import ReglasModal from './ReglasModal';
import type { PropsPestanaComp } from './tiposComp';

type PorTabla = 'campana' | 'analista';

/** Quién va primero en «Por analista»: personas, luego sin registro, al final «Sin analista». */
function rango(a: VwAvanceAnalista): number {
  if (a.analista_email) return 0;
  return a.campanas > 0 ? 2 : 1;
}

export default function AvanceComprobaciones(props: PropsPestanaComp) {
  vigilarRender('AvanceComprobaciones');
  const { periodo, campanas, unidad, nombreDe, permisos, telefono, cargando } = props;

  // ---- Lecturas propias (avance por analista y comprobación diaria) -------
  const [avance, setAvance] = useState<VwAvanceAnalista[]>([]);
  const [diaria, setDiaria] = useState<VwDiaria[]>([]);
  const [leidoDe, setLeidoDe] = useState<string | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [err, setErr] = useState('');
  const [intento, setIntento] = useState(0);
  const pide = useRef(0);
  const llave = `${unidad}|${periodo.id}`;

  useEffect(() => {
    // Mientras el esqueleto lee la lista por primera vez no hay nada que cruzar.
    if (cargando) return;
    const n = ++pide.current;
    setLeyendo(true);
    Promise.all([
      leerAvanceAnalista({ periodoId: periodo.id, unidad }),
      leerDiaria({ periodoId: periodo.id, unidad }),
    ]).then(([a, d]) => {
      if (n !== pide.current) return;
      setLeyendo(false);
      if (!a.ok || !d.ok) {
        // Si ya había datos se quedan (mejor viejos que vacíos) y se avisa.
        const malo = !a.ok ? a : !d.ok ? d : null;
        setErr('No se pudo leer el avance: ' + (malo ? textoFallaComp(malo) : ''));
        return;
      }
      setErr('');
      setAvance(a.data);
      setDiaria(d.data);
      setLeidoDe(llave);
    });
    // `campanas` cambia de referencia en cada recarga del esqueleto: así el
    // avance se relee junto con la lista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llave, campanas, cargando, intento]);

  const listo = leidoDe === llave;
  const hoy = hoyCdmx();

  // ---- Tarjetas del periodo (de la lista del esqueleto) -------------------
  const t = useMemo(() => {
    let vivas = 0;
    let abiertas = 0;
    let meta = 0;
    let comprobados = 0;
    let hoyN = 0;
    let pendientes = 0;
    let vencidas = 0;
    let sinAnalista = 0;
    for (const c of campanas) {
      // Una sola regla con Campañas (revisión de pantallas, 23-oct-2026): las
      // retiradas NO suman. Su meta es solo lo ya comprobado (100 %) y
      // empujaba el % del periodo hacia arriba.
      if (c.retirada) continue;
      meta += c.meta || 0;
      comprobados += c.comprobados || 0;
      hoyN += c.comprobados_hoy || 0;
      vivas++;
      if (c.estatus !== 'abierta') continue;
      abiertas++;
      pendientes += c.pendientes || 0;
      if (!c.completa && !sinPorComprobar(c) && c.dias_restantes != null && c.dias_restantes < 0) vencidas++;
      if (!c.analista_email) sinAnalista++;
    }
    return { vivas, abiertas, meta, comprobados, hoy: hoyN, pendientes, vencidas, sinAnalista, pct: pctAvance(comprobados, meta) };
  }, [campanas]);

  // ---- Por analista --------------------------------------------------------
  const porAnalista = useMemo(
    () =>
      [...avance]
        .filter((a) => a.campanas > 0 || a.comprobados > 0)
        .sort(
          (a, b) =>
            rango(a) - rango(b) ||
            b.abiertas - a.abiertas ||
            b.meta - a.meta ||
            (a.analista_email || '').localeCompare(b.analista_email || '')
        ),
    [avance]
  );

  // ---- Tabla diaria ----------------------------------------------------------
  const [por, setPor] = useState<PorTabla>('campana');
  const [filtroAnalista, setFiltroAnalista] = useState('');
  const dias = useMemo(() => diasEntre(periodo.inicio, periodo.fin), [periodo.inicio, periodo.fin]);
  const porId = useMemo(() => new Map(campanas.map((c) => [String(c.id), c])), [campanas]);

  const analistasDeLista = useMemo(() => {
    const s = new Set<string>();
    for (const c of campanas) if (c.analista_email) s.add(c.analista_email.toLowerCase());
    return [...s].sort((a, b) => nombreDe(a).localeCompare(nombreDe(b)));
  }, [campanas, nombreDe]);

  const filasTabla = useMemo(() => {
    const base =
      por === 'campana' && filtroAnalista
        ? diaria.filter((d) =>
            filtroAnalista === '-' ? !d.analista_email : (d.analista_email || '').toLowerCase() === filtroAnalista
          )
        : diaria;
    return pivotDiaria(base, dias, por);
  }, [diaria, dias, por, filtroAnalista]);

  const hayFuera = filasTabla.some((r) => r.fuera > 0);
  const totDia = useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of dias) m[d] = 0;
    for (const r of filasTabla) for (const d of dias) m[d] += r.porDia[d] || 0;
    return m;
  }, [filasTabla, dias]);
  const totTotal = filasTabla.reduce((s, r) => s + r.total, 0);
  const totFuera = filasTabla.reduce((s, r) => s + r.fuera, 0);

  const etiquetaFila = (clave: string): { tit: string; sub: string } => {
    if (por === 'analista') return { tit: clave === CLAVE_SIN_REGISTRO ? ETIQUETA_SIN_REGISTRO : nombreDe(clave), sub: '' };
    const c = porId.get(clave);
    if (!c) return { tit: `Campaña ${clave}`, sub: '' };
    return {
      tit: c.version ? `${c.campana} · ${c.version}` : c.campana,
      sub: c.analista_email ? nombreDe(c.analista_email) : 'Sin analista',
    };
  };

  const [verReglas, setVerReglas] = useState(false);

  // ---- Render ----------------------------------------------------------------
  if (cargando && !campanas.length)
    return (
      <div className="phint">
        <span className="spinner" />
        Leyendo el avance…
      </div>
    );

  const anchoPrimera = telefono ? 132 : 230;
  const celda: CSSProperties = {
    padding: '6px 6px',
    borderBottom: '1px solid var(--line)',
    textAlign: 'center',
    minWidth: 30,
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  };
  const primera: CSSProperties = {
    position: 'sticky',
    left: 0,
    zIndex: 1,
    background: 'var(--panel)',
    textAlign: 'left',
    minWidth: anchoPrimera,
    maxWidth: anchoPrimera,
    padding: '6px 8px',
    borderBottom: '1px solid var(--line)',
    borderRight: '1px solid var(--line)',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
  };
  const cabeza: CSSProperties = { position: 'sticky', top: 0, zIndex: 2, background: 'var(--panel)' };

  const tarjetas = [
    { l: 'Campañas', n: nf(t.vivas), sub: `${nf(t.abiertas)} abiertas` },
    { l: 'Meta (sitios)', n: nf(t.meta) },
    { l: 'Comprobados', n: nf(t.comprobados), c: colorTono('verde'), sub: t.pct == null ? '' : `${t.pct} %` },
    { l: 'Hoy', n: nf(t.hoy), c: colorTono('azul') },
    { l: 'Pendientes', n: nf(t.pendientes), c: 'var(--warn)' },
    { l: 'Vencidas', n: nf(t.vencidas), c: t.vencidas ? colorTono('rojo') : undefined },
    { l: 'Sin analista', n: nf(t.sinAnalista), c: t.sinAnalista ? 'var(--warn)' : undefined },
  ];

  return (
    <div className={leyendo && listo ? 'recargando' : undefined} style={{ transition: 'opacity .15s' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ flex: '1 1 auto', fontSize: 13, color: 'var(--muted)' }}>
          {permisos.soloLectura ? 'Solo para consultar. ' : ''}
          Se calcula solo con lo que marcan las analistas.
        </span>
        <button type="button" className="btn ghost sm" onClick={() => setVerReglas(true)}>
          <Ic i={BookOpen} />
          Reglas
        </button>
      </div>

      {err && (
        <div className="err">
          {err}{' '}
          <button type="button" className="btn ghost sm" onClick={() => setIntento((n) => n + 1)}>
            <Ic i={RotateCw} />
            Reintentar
          </button>
        </div>
      )}

      <div className="cards">
        {tarjetas.map((x) => (
          <div key={x.l} className="card">
            <div className="n" style={{ color: x.c }}>
              {x.n}
            </div>
            <div className="l">
              {x.l}
              {x.sub ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {x.sub}</span> : null}
            </div>
          </div>
        ))}
      </div>

      {/* Por analista */}
      <section className="card" style={{ marginBottom: 14 }}>
        <b style={{ fontSize: 15 }}>Por analista</b>
        <p className="phint" style={{ margin: '4px 0 10px' }}>
          La barra es el avance de las campañas que lleva hoy. «Marcó» cuenta lo que esa persona comprobó, aunque la campaña
          ya la lleve otra.
        </p>
        {!listo ? (
          <div className="phint" style={{ margin: 0 }}>
            <span className="spinner" />
            Leyendo…
          </div>
        ) : porAnalista.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Todavía no hay campañas en este periodo.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 10 }}>
            {porAnalista.map((a, i) => {
              const nombre = a.analista_email
                ? nombreDe(a.analista_email)
                : a.campanas > 0
                  ? 'Sin analista'
                  : ETIQUETA_SIN_REGISTRO;
              const pct = pctAvance(a.comprobados_en_sus_campanas, a.meta);
              const sinAnal = !a.analista_email && a.campanas > 0;
              return (
                <div
                  key={(a.analista_email ?? '-') + i}
                  style={{
                    border: '1px solid ' + (sinAnal ? 'var(--st-ambar-borde)' : 'var(--line)'),
                    borderRadius: 12,
                    padding: '10px 12px',
                    background: 'var(--panel2)',
                    minWidth: 0,
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
                    <b style={{ flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere', color: sinAnal ? 'var(--warn)' : undefined }}>
                      {nombre}
                    </b>
                    <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {a.meta ? textoAvance(a.comprobados_en_sus_campanas, a.meta, pct) : 'sin carga'}
                    </span>
                  </div>
                  <Barra pct={pct} />
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
                    {nf(a.campanas)} {a.campanas === 1 ? 'campaña' : 'campañas'} ({nf(a.abiertas)} abiertas) · {nf(a.pendientes)}{' '}
                    pendientes
                    {a.analista_email || a.comprobados ? (
                      <>
                        {' '}
                        · marcó {nf(a.comprobados)} · hoy <b style={{ color: 'var(--txt)' }}>{nf(a.hoy)}</b>
                      </>
                    ) : null}
                    {a.vencidas ? (
                      <span style={{ color: colorTono('rojo'), fontWeight: 600 }}>
                        {' '}
                        · {nf(a.vencidas)} {a.vencidas === 1 ? 'vencida' : 'vencidas'}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Comprobación diaria */}
      <section className="card">
        <b style={{ fontSize: 15 }}>Comprobación diaria</b>
        <p className="phint" style={{ margin: '4px 0 10px' }}>
          Sitios marcados como comprobados cada día del periodo (el día que eligió la analista al marcar).
          {telefono ? ' Desliza la tabla de lado.' : ''}
        </p>
        <div className="toolbar" style={{ alignItems: 'center' }}>
          <div className="rt-chips rt-segmento" role="group" aria-label="Agrupar la tabla">
            {(['campana', 'analista'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={'rt-chip' + (por === k ? ' on' : '')}
                aria-pressed={por === k}
                onClick={() => setPor(k)}
              >
                {k === 'campana' ? 'Por campaña' : 'Por analista'}
              </button>
            ))}
          </div>
          {por === 'campana' && analistasDeLista.length > 0 && (
            <select
              aria-label="Analista"
              value={filtroAnalista}
              className={filtroAnalista ? 'on' : undefined}
              onChange={(e) => setFiltroAnalista(e.target.value)}
            >
              <option value="">Todas las analistas</option>
              <option value="-">Sin analista</option>
              {analistasDeLista.map((e) => (
                <option key={e} value={e}>
                  {nombreDe(e)}
                </option>
              ))}
            </select>
          )}
        </div>

        {!listo ? (
          <div className="phint" style={{ margin: 0 }}>
            <span className="spinner" />
            Leyendo…
          </div>
        ) : filasTabla.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            {filtroAnalista ? 'Nadie ha marcado sitios en estas campañas.' : 'Todavía nadie marca sitios comprobados en este periodo.'}
          </div>
        ) : (
          <>
            <div
              role="region"
              aria-label="Tabla de comprobación diaria"
              tabIndex={0}
              style={{
                overflow: 'auto',
                maxHeight: telefono ? '60vh' : '70vh',
                border: '1px solid var(--line)',
                borderRadius: 10,
                WebkitOverflowScrolling: 'touch',
                overscrollBehavior: 'contain',
              }}
            >
              <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12, width: 'max-content', minWidth: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ ...primera, ...cabeza, zIndex: 3, fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>
                      {por === 'campana' ? 'Campaña' : 'Analista'}
                    </th>
                    {dias.map((d) => {
                      const c = cabezaDia(d);
                      const esHoy = d === hoy;
                      return (
                        <th
                          key={d}
                          scope="col"
                          style={{
                            ...celda,
                            ...cabeza,
                            background: c.finde ? 'var(--panel2)' : 'var(--panel)',
                            color: esHoy ? 'var(--txt)' : 'var(--muted)',
                            fontWeight: esHoy ? 800 : 600,
                            boxShadow: esHoy ? 'inset 0 -2px 0 var(--accent)' : undefined,
                            lineHeight: 1.2,
                          }}
                        >
                          <div style={{ fontSize: 10 }}>{c.sem}</div>
                          <div>{c.num}</div>
                        </th>
                      );
                    })}
                    <th style={{ ...celda, ...cabeza, fontWeight: 800 }}>Total</th>
                    {hayFuera && (
                      <th style={{ ...celda, ...cabeza, color: 'var(--warn)', whiteSpace: 'normal', minWidth: 64 }}>Fuera del periodo</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filasTabla.map((r) => {
                    const e = etiquetaFila(r.clave);
                    return (
                      <tr key={r.clave || '(sin)'}>
                        <th scope="row" style={{ ...primera, fontWeight: 600 }}>
                          <div>{e.tit}</div>
                          {e.sub && <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>{e.sub}</div>}
                        </th>
                        {dias.map((d) => {
                          const n = r.porDia[d] || 0;
                          return (
                            <td
                              key={d}
                              style={{
                                ...celda,
                                background: cabezaDia(d).finde ? 'var(--panel2)' : undefined,
                                color: n ? 'var(--txt)' : 'var(--muted)',
                              }}
                            >
                              {n ? nf(n) : ''}
                            </td>
                          );
                        })}
                        <td style={{ ...celda, fontWeight: 800 }}>{nf(r.total)}</td>
                        {hayFuera && <td style={{ ...celda, color: r.fuera ? 'var(--warn)' : 'var(--muted)' }}>{r.fuera ? nf(r.fuera) : ''}</td>}
                      </tr>
                    );
                  })}
                  <tr>
                    <th scope="row" style={{ ...primera, fontWeight: 800, background: 'var(--panel2)' }}>
                      Total
                    </th>
                    {dias.map((d) => (
                      <td key={d} style={{ ...celda, fontWeight: 800, background: 'var(--panel2)' }}>
                        {nf(totDia[d])}
                      </td>
                    ))}
                    <td style={{ ...celda, fontWeight: 800, background: 'var(--panel2)' }}>{nf(totTotal)}</td>
                    {hayFuera && <td style={{ ...celda, fontWeight: 800, background: 'var(--panel2)' }}>{nf(totFuera)}</td>}
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
              {por === 'campana'
                ? `Solo salen las campañas que ya tienen sitios marcados (${nf(filasTabla.length)}). `
                : 'Por analista cuenta a quien marcó, no a quien lleva la campaña hoy. '}
              Sábado y domingo van sombreados.
              {hayFuera ? ' «Fuera del periodo» son marcas con un día antes o después del periodo.' : ''}
              {permisos.gestiona ? ' El Excel con esta hoja sale en la pestaña Excel.' : ''}
            </div>
          </>
        )}
      </section>

      {verReglas && <ReglasModal {...props} editable={permisos.gestiona} onCerrar={() => setVerReglas(false)} />}
    </div>
  );
}
