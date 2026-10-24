// ============================================================
// src/modules/pauta/IncidenciasSitiosPauta.tsx
// Bloque 3 de Indicadores de Pauta (Erik, 14-oct-2026): las incidencias de
// los sitios de la pauta en la catorcena elegida.
//
//   · Abiertas: reportadas, por validar, en reparación y devueltas.
//     "Reparado" ya no cuenta como abierta (14-oct-2026).
//   · Resueltas en la catorcena: reparadas o cerradas entre su inicio y su
//     fin (días de CDMX).
//
// Lee con la RPC incidencias_de_sitios (security definer, como
// estado_maquina): la RLS de `incidencias` le esconde al monitorista lo de
// otras áreas. Aquí no se repara ni se valida nada: eso vive en Incidencias.
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import { sb } from '../../lib/supabase';
import { tope } from '../../lib/envios';
import { EST_LABEL, EST_TONO } from '../../lib/constants';
import { fmtHoras } from '../../lib/helpers';
import { colorTono, fondoTono } from '../../lib/tonos';

type IncSitio = {
  record_id: string;
  folio: string | null;
  clave_sitio: string;
  clave_medio: string | null;
  nombre_incidencia: string | null;
  nivel: string | null;
  estatus: string;
  area: string | null;
  fecha_reporte: string | null;
  horas_en_estatus: number | null;
  repaired_at: string | null;
  cerrada_en: string | null;
  observaciones: string | null;
  es_abierta: boolean;
};

/** Grupos de la barra de filtros. */
const GRUPOS = [
  { k: 'validar', l: 'Por validar', est: ['reportado', 'por_validar'], tono: 'ambar' },
  { k: 'reparando', l: 'En reparación', est: ['en_proceso'], tono: 'rojo' },
  { k: 'devueltas', l: 'Devueltas', est: ['rechazada'], tono: 'gris' },
  { k: 'resueltas', l: 'Resueltas en la catorcena', est: ['reparado', 'cerrada'], tono: 'verde' },
] as const;

type Props = {
  /** Sitios de la pauta que se ven (el monitorista: solo los de sus rutas). */
  sitios: string[];
  anio: number;
  numero: number;
};

export default function IncidenciasSitiosPauta({ sitios, anio, numero }: Props) {
  const [filas, setFilas] = useState<IncSitio[] | null>(null);
  const [err, setErr] = useState('');
  const [grupo, setGrupo] = useState<(typeof GRUPOS)[number]['k'] | null>(null);
  const [intento, setIntento] = useState(0);
  const claveSitios = sitios.join('|');

  useEffect(() => {
    let vivo = true;
    setFilas(null);
    setErr('');
    (async () => {
      // Las fechas de la catorcena acotan las "resueltas".
      const c = await sb
        .from('catorcenas')
        .select('fecha_inicio,fecha_fin')
        .eq('anio', anio)
        .eq('numero', numero)
        .abortSignal(tope(15000))
        .maybeSingle();
      if (!vivo) return;
      if (c.error || !c.data) {
        setErr('No se pudieron leer las fechas de la catorcena' + (c.error ? ': ' + c.error.message : '.'));
        return;
      }
      if (!sitios.length) {
        setFilas([]);
        return;
      }
      const r = await sb
        .rpc('incidencias_de_sitios', {
          p_site_ids: sitios,
          p_desde: (c.data as { fecha_inicio: string }).fecha_inicio,
          p_hasta: (c.data as { fecha_fin: string }).fecha_fin,
        })
        .abortSignal(tope(20000));
      if (!vivo) return;
      if (r.error) {
        setErr('No se pudieron leer las incidencias: ' + r.error.message);
        return;
      }
      setFilas((r.data as IncSitio[]) || []);
    })();
    return () => {
      vivo = false;
    };
    // claveSitios resume `sitios` (un arreglo nuevo en cada render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveSitios, anio, numero, intento]);

  const conteos = useMemo(() => {
    const m: Record<string, number> = {};
    for (const g of GRUPOS) m[g.k] = (filas || []).filter((f) => (g.est as readonly string[]).includes(f.estatus)).length;
    return m;
  }, [filas]);

  const visibles = useMemo(() => {
    if (!filas) return [];
    const g = GRUPOS.find((x) => x.k === grupo);
    return g ? filas.filter((f) => (g.est as readonly string[]).includes(f.estatus)) : filas;
  }, [filas, grupo]);

  return (
    <section className="card" style={{ marginTop: 14 }}>
      {/* h3 con el mismo look del <b> de antes (revisión de accesibilidad, 24-oct-2026). */}
      <h3 style={{ font: 'inherit', fontWeight: 700, fontSize: 15, margin: 0 }}>Incidencias de los sitios</h3>
      <p className="phint" style={{ margin: '4px 0 10px' }}>
        Las abiertas y las que se resolvieron en esta catorcena, en los sitios de la pauta. Se atienden en
        Incidencias.
      </p>
      {err && (
        <div className="err" role="alert">
          {err}{' '}
          <button type="button" className="btn sm ghost" onClick={() => setIntento((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      )}
      {!err && filas == null && (
        <div style={{ fontSize: 13, color: 'var(--muted)' }} role="status">
          <span className="spinner" />
          Buscando incidencias…
        </div>
      )}
      {filas && (
        <>
          <div
            style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}
            role="group"
            aria-label="Filtrar incidencias"
          >
            {GRUPOS.map((g) => (
              <button
                key={g.k}
                type="button"
                className={'rt-chip' + (grupo === g.k ? ' on' : '')}
                aria-pressed={grupo === g.k}
                onClick={() => setGrupo((v) => (v === g.k ? null : g.k))}
                style={{ color: conteos[g.k] ? colorTono(g.tono) : undefined }}
              >
                {g.l} · {conteos[g.k]}
              </button>
            ))}
          </div>
          {visibles.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              {grupo ? 'Nada en este grupo.' : 'Sin incidencias abiertas ni resueltas en esta catorcena.'}
            </div>
          ) : (
            <div style={{ fontSize: 13 }}>
              {visibles.map((f) => (
                <div
                  key={f.record_id}
                  style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 0', borderTop: '1px solid var(--line)' }}
                >
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <div>
                      <b>{f.clave_sitio}</b>
                      {f.folio ? <span style={{ color: 'var(--muted)' }}> · {f.folio}</span> : null}
                    </div>
                    <div style={{ overflowWrap: 'anywhere' }}>
                      {f.nombre_incidencia || '(sin nombre)'}
                      <span style={{ color: 'var(--muted)' }}>
                        {f.area ? ' · ' + f.area : ''}
                        {f.es_abierta && f.horas_en_estatus != null ? ' · ' + fmtHoras(f.horas_en_estatus) : ''}
                      </span>
                    </div>
                    {f.observaciones && (
                      <div style={{ color: 'var(--muted)', fontSize: 12, overflowWrap: 'anywhere' }}>{f.observaciones}</div>
                    )}
                  </div>
                  <span
                    className="pill"
                    style={{
                      background: fondoTono(EST_TONO[f.estatus] ?? 'gris'),
                      color: colorTono(EST_TONO[f.estatus] ?? 'gris'),
                      flexShrink: 0,
                    }}
                  >
                    {EST_LABEL[f.estatus] || f.estatus}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
