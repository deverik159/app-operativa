// ============================================================
// src/modules/comprobaciones/AltaCampanaCopiar.tsx
// Armar · «Copiar del periodo anterior» (REPITE). 23-oct-2026.
//
// POR QUÉ. Muchas campañas de Biobox siguen igual de un mes a otro (mismo
// arte, mismos sitios). En vez de volver a escogerlas, el Supervisor elige
// las del periodo anterior y se copian con repetirCampana: mismos sitios y
// horarios, sin las vigencias por sitio (eran del periodo viejo), con las
// fechas del periodo nuevo y la analista que la llevó como PROPUESTA. Se
// lee lo que la base tiene (no lo que dijo el archivo): sin los sitios
// cancelados ni los que quedaron fuera de carga.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { repetirCampana } from '../../lib/bitacoraComp';
import { llaveComp } from '../../lib/comprobaciones';
import {
  leerCampanas,
  leerPeriodos,
  leerSitios,
  mediosDe,
  textoFallaComp,
  type PeriodoComp,
  type VwCampana,
} from '../../lib/comprobacionesApi';
import type { PropsArmar } from './tiposComp';
import { contratoDeVista, etiquetaCampana, fmt, porMedio, type EntradaMedio } from './ArmarComun';
import { PreviaCarga, TablaContrato } from './ArmarCarga';

export default function AltaCampanaCopiar({ ctx }: { ctx: PropsArmar }) {
  const [periodos, setPeriodos] = useState<PeriodoComp[] | null>(null);
  const [origenId, setOrigenId] = useState<number | null>(null);
  const [lista, setLista] = useState<VwCampana[] | null>(null);
  const [elegidas, setElegidas] = useState<Set<number>>(new Set());
  const [filtro, setFiltro] = useState('');
  const [verRetiradas, setVerRetiradas] = useState(false);
  const [err, setErr] = useState('');
  const [armando, setArmando] = useState(false);
  const [entradas, setEntradas] = useState<EntradaMedio[] | null>(null);
  const [previa, setPrevia] = useState(0);
  const ocupado = ctx.ocupado != null;

  useEffect(() => {
    let vivo = true;
    void leerPeriodos(ctx.unidad).then((r) => {
      if (!vivo) return;
      if (!r.ok) {
        setErr('No se pudieron leer los periodos: ' + textoFallaComp(r));
        return;
      }
      const antes = r.data
        .filter((p) => p.id !== ctx.periodo.id && p.fecha_inicio < ctx.periodo.inicio)
        .sort((a, b) => (a.fecha_inicio < b.fecha_inicio ? 1 : -1));
      setPeriodos(antes);
      setOrigenId(antes[0]?.id ?? null);
    });
    return () => {
      vivo = false;
    };
  }, [ctx.unidad, ctx.periodo.id, ctx.periodo.inicio]);

  useEffect(() => {
    if (origenId == null) return;
    let vivo = true;
    setLista(null);
    setElegidas(new Set());
    void leerCampanas({ periodoId: origenId, unidad: ctx.unidad }).then((r) => {
      if (!vivo) return;
      if (!r.ok) {
        setErr('No se pudieron leer las campañas de ese periodo: ' + textoFallaComp(r));
        return;
      }
      setErr('');
      setLista(r.data);
    });
    return () => {
      vivo = false;
    };
  }, [origenId, ctx.unidad]);

  // Las que ya están en el periodo que se arma (se actualizarían, no se duplican).
  const yaEstan = useMemo(
    () => new Set(ctx.campanas.filter((c) => !c.retirada).map((c) => `${c.medio}|${c.campana_llave}|${c.version_llave}`)),
    [ctx.campanas]
  );
  const llave = (c: VwCampana) => `${c.medio}|${llaveComp(c.campana)}|${llaveComp(c.version)}`;
  const visibles = useMemo(() => {
    const t = llaveComp(filtro);
    return (lista ?? [])
      .filter((c) => verRetiradas || !c.retirada)
      .filter((c) => !t || llaveComp(`${c.campana} ${c.version} ${c.cliente ?? ''}`).includes(t))
      .sort((a, b) => a.campana.localeCompare(b.campana, 'es') || a.version.localeCompare(b.version, 'es'));
  }, [lista, filtro, verRetiradas]);

  const armar = async () => {
    const cams = (lista ?? []).filter((c) => elegidas.has(c.id));
    if (!cams.length) return;
    setErr('');
    setArmando(true);
    const s = await leerSitios({ campanaIds: cams.map((c) => c.id), sinFueraDeCarga: true });
    setArmando(false);
    if (!s.ok) {
      setErr('No se pudieron leer los sitios: ' + textoFallaComp(s));
      return;
    }
    const porCampana = new Map<number, typeof s.data>();
    for (const x of s.data) {
      if (x.estado === 'cancelado') continue;
      const l = porCampana.get(x.campana_id) ?? [];
      l.push(x);
      porCampana.set(x.campana_id, l);
    }
    const copias = cams.map((c) => ({
      medio: c.medio,
      campana: repetirCampana(contratoDeVista(c, porCampana.get(c.id) ?? []), { inicio: ctx.periodo.inicio, fin: ctx.periodo.fin }),
    }));
    setEntradas(porMedio(mediosDe(ctx.unidad), copias));
  };

  if (previa && entradas)
    return (
      <PreviaCarga
        key={previa}
        ctx={ctx}
        entradas={entradas}
        completa={null}
        onVolver={(cargado) => {
          setPrevia(0);
          if (cargado) {
            setEntradas(null);
            setElegidas(new Set());
          }
        }}
      />
    );

  if (entradas)
    return (
      <div>
        <h3 style={{ fontSize: 15, margin: '6px 0 8px' }}>
          Copias para {ctx.periodo.etiqueta}: {fmt(entradas.reduce((a, e) => a + e.campanas.length, 0))} campañas-versión
        </h3>
        <p className="phint">Toman las fechas del periodo nuevo y el arte «REPITE». Ajusta lo que haga falta en Campañas después de cargar.</p>
        {entradas.some((e) => e.campanas.some((c) => !c.sitios.length && !c.es_full)) && (
          <div className="banner">Alguna copia se quedó sin sitios (todos estaban cancelados): la base la rechazará o quedará vacía.</div>
        )}
        <TablaContrato entradas={entradas} mostrarMedio={entradas.length > 1} />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn" disabled={ocupado} onClick={() => setPrevia((n) => n + 1)}>
            Revisar contra la base
          </button>
          <button type="button" className="btn ghost" disabled={ocupado} onClick={() => setEntradas(null)}>
            Volver a elegir
          </button>
        </div>
      </div>
    );

  return (
    <div>
      <p className="phint">Copia campañas que se repiten (mismos sitios y horarios) de un periodo anterior a {ctx.periodo.etiqueta}.</p>
      {err && <div className="err">{err}</div>}
      {periodos == null ? (
        !err && (
          <div className="phint">
            <span className="spinner" />
            Leyendo periodos…
          </div>
        )
      ) : !periodos.length ? (
        <div className="empty">No hay periodos anteriores armados en la app para copiar.</div>
      ) : (
        <>
          <div className="toolbar filtros-pildora" style={{ gap: 8, flexWrap: 'wrap' }}>
            <select
              aria-label="Copiar de"
              value={origenId ?? ''}
              onChange={(e) => setOrigenId(Number(e.target.value))}
              disabled={ocupado || armando}
            >
              {periodos.map((p) => (
                <option key={p.id} value={p.id}>
                  Copiar de {p.etiqueta}
                </option>
              ))}
            </select>
            <input
              type="search"
              placeholder="Buscar campaña o cliente"
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
              aria-label="Buscar campaña"
            />
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--muted)' }}>
              <input type="checkbox" checked={verRetiradas} onChange={(e) => setVerRetiradas(e.target.checked)} />
              Ver retiradas
            </label>
          </div>
          {lista == null ? (
            !err && (
              <div className="phint">
                <span className="spinner" />
                Leyendo campañas…
              </div>
            )
          ) : !visibles.length ? (
            <div className="empty">Ese periodo no tiene campañas{filtro ? ' con ese texto' : ''}.</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '4px 0 6px', fontSize: 12 }}>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setElegidas(new Set([...elegidas, ...visibles.map((c) => c.id)]))}
                >
                  Elegir las {fmt(visibles.length)}
                </button>
                <button type="button" className="btn ghost sm" disabled={!elegidas.size} onClick={() => setElegidas(new Set())}>
                  Ninguna
                </button>
              </div>
              <div className="lista-scroll" style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
                {visibles.map((c) => (
                  <label
                    key={c.id}
                    style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 10px', borderBottom: '1px solid var(--line)', fontSize: 13 }}
                  >
                    <input
                      type="checkbox"
                      checked={elegidas.has(c.id)}
                      onChange={(e) => {
                        const s = new Set(elegidas);
                        if (e.target.checked) s.add(c.id);
                        else s.delete(c.id);
                        setElegidas(s);
                      }}
                    />
                    <span style={{ flex: 1, overflowWrap: 'anywhere' }}>
                      <b>{etiquetaCampana(c)}</b>
                      {c.retirada && <span className="tag" style={{ marginLeft: 6 }}>retirada</span>}
                      {yaEstan.has(llave(c)) && (
                        <span className="tag" style={{ marginLeft: 6 }}>
                          ya está en {ctx.periodo.etiqueta}
                        </span>
                      )}
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>
                        {c.medio} · {c.cliente || 'sin cliente'} · {fmt(c.sitios_activos)} sitios
                        {c.analista_email ? ` · ${ctx.nombreDe(c.analista_email)}` : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <button type="button" className="btn" style={{ marginTop: 12 }} disabled={ocupado || armando || !elegidas.size} onClick={armar}>
                {armando ? 'Leyendo sitios…' : `Copiar ${fmt(elegidas.size)} campaña(s)`}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
