// ============================================================
// src/modules/pauta/IndicadoresPauta.tsx
// Pestaña Indicadores de Pauta y Monitoreo (Erik, 14-oct-2026).
//
// Dos bloques sobre la catorcena elegida:
//   1. Avance: caras, tomadas, comprobadas y regresadas; por ruta, por
//      campaña y por monitorista. Se descarga en Excel.
//   2. Comprobaciones agrupadas por campaña y por día en que se TOMÓ. Cada
//      campaña y cada día se descargan en Excel con ligas a las fotos. Solo
//      entran las comprobadas (desde el 22-oct-2026 las comprueba el
//      analista al revisarlas; el PDF se quitó ese día).
//
// El monitorista ve solo sus rutas asignadas; coordinador y manager, todo.
// Ese recorte lo hace PautaView al pasar `filas` (es un filtro de pantalla,
// no un permiso: la RLS de pautas deja leer todo a cualquiera con sesión).
//
// El tercer bloque, las incidencias de los sitios, vive en
// IncidenciasSitiosPauta.tsx.
// ============================================================
import { ChevronDown, ChevronRight, Download, Sheet } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PautaRuta } from '../../types/db';
import { cargarNombres, nombreDe, type MapaNombres } from '../../lib/nombres';
import {
  agruparComprobaciones,
  avancePauta,
  etiquetaDia,
  nombreRuta,
  paraArchivo,
} from '../../lib/indicadoresPauta';
import { colorTono } from '../../lib/tonos';
import {
  bajarArchivo,
  evidenciasDe,
  excelAvance,
  excelComprobaciones,
  type Contexto,
} from './descargasPauta';
import Ic from '../../components/Ic';
import IncidenciasSitiosPauta from './IncidenciasSitiosPauta';

type Props = {
  filas: PautaRuta[];
  /** Ya se leyeron las rutas asignadas (o falló la lectura: el texto). */
  asignaciones: 'cargando' | 'listas' | string;
  anio: number;
  numero: number;
  /** "Cat-16 · 2026" */
  etiquetaCat: string;
  /** Monitorista: solo sus rutas. Si no tiene ninguna, se dice. */
  soloMisRutas: boolean;
};

/** Una tarea de descarga en curso (una a la vez). */
type Tarea = { clave: string; texto: string };

/**
 * Candado del MÓDULO, no del componente: si el usuario sale de Indicadores
 * con un archivo armándose, la descarga sigue; al volver no debe poder
 * lanzar otra en paralelo. Tampoco pasan dos toques seguidos antes de que
 * React pinte.
 */
let descargaEnCurso = false;

export default function IndicadoresPauta({ filas, asignaciones, anio, numero, etiquetaCat, soloMisRutas }: Props) {
  const [nombres, setNombres] = useState<MapaNombres>({});
  useEffect(() => {
    let vivo = true;
    cargarNombres().then((m) => vivo && setNombres(m));
    return () => {
      vivo = false;
    };
  }, []);

  const avance = useMemo(() => avancePauta(filas), [filas]);
  const grupos = useMemo(() => agruparComprobaciones(filas), [filas]);
  const sitios = useMemo(() => [...new Set(filas.map((f) => f.site_id))].sort(), [filas]);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [verDetalle, setVerDetalle] = useState<'campana' | 'monitorista' | null>(null);
  const [tarea, setTarea] = useState<Tarea | null>(null);
  const [err, setErr] = useState('');

  const ctx: Contexto = { catorcena: etiquetaCat, anio, numero, nombres };
  const sufijo = `${paraArchivo(etiquetaCat)}`;

  // Se vuelve a prender al montar: en desarrollo (StrictMode) React monta,
  // desmonta y monta de nuevo, y sin esto quedaba en false para siempre y
  // los botones se quedaban "procesando" (20-oct-2026).
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);
  const correr = async (clave: string, texto: string, fn: () => Promise<void>) => {
    if (descargaEnCurso) {
      setErr('Ya se está preparando otro archivo. Espera a que termine.');
      return;
    }
    descargaEnCurso = true;
    setErr('');
    setTarea({ clave, texto });
    try {
      await fn();
    } catch (e) {
      if (vivo.current) setErr((e as Error).message || 'No se pudo generar el archivo.');
    } finally {
      descargaEnCurso = false;
      if (vivo.current) setTarea(null);
    }
  };

  const bajarAvance = () =>
    correr('avance', 'Preparando el Excel…', async () => {
      const blob = await excelAvance(avance, filas, ctx);
      bajarArchivo(blob, `Avance_${sufijo}.xlsx`);
    });

  const bajarComprobacion = (clave: string, titulo: string, nombreArchivo: string, fs: PautaRuta[]) =>
    correr(clave, 'Leyendo las fotos…', async () => {
      const evid = await evidenciasDe(anio, numero, fs.map((f) => f.vendor_face_id));
      const blob = await excelComprobaciones(titulo, fs, evid, ctx);
      bajarArchivo(blob, `${nombreArchivo}.xlsx`);
    });

  if (soloMisRutas && asignaciones === 'cargando')
    return (
      <div className="loading" role="status">
        Leyendo tus rutas…
      </div>
    );
  if (soloMisRutas && asignaciones !== 'listas' && asignaciones !== 'cargando')
    return (
      <div className="err" role="alert">
        No se pudieron leer tus rutas asignadas: {asignaciones}
      </div>
    );
  if (soloMisRutas && filas.length === 0)
    return (
      <div className="empty">
        No tienes rutas asignadas en esta catorcena. Pide al coordinador que te asigne una en Pauta.
      </div>
    );

  const t = avance.total;
  const ocupado = !!tarea;

  /**
   * Botón Excel de un grupo. `nombre` es el nombre accesible: los botones
   * dicen «Excel» todos igual y el lector no sabría de cuál campaña o día
   * es (revisión de accesibilidad, 24-oct-2026).
   */
  const botones = (clave: string, titulo: string, archivo: string, fs: PautaRuta[], nombre?: string) => (
    <button
      type="button"
      className="btn ghost sm"
      disabled={ocupado}
      aria-label={nombre ?? `Excel de ${titulo}`}
      onClick={(e) => {
        e.stopPropagation();
        bajarComprobacion(clave, titulo, archivo, fs);
      }}
      title="Excel con una liga a cada foto"
      style={{ flexShrink: 0 }}
    >
      {tarea?.clave === clave && <span className="spinner" />}
      <Ic i={Sheet} />
      Excel
    </button>
  );

  return (
    <>
      {soloMisRutas && (
        <p className="phint" style={{ marginTop: 0 }}>
          Ves solo tus rutas asignadas.
        </p>
      )}
      {err && (
        <div className="err" role="alert">
          {err}
        </div>
      )}
      {tarea && (
        <div role="status" className="phint" style={{ marginTop: 0 }}>
          <span className="spinner" />
          {tarea.texto}
        </div>
      )}

      {/* 1. Avance de la catorcena */}
      <section className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {/* h3 con el mismo look del <b> de antes (revisión de accesibilidad, 24-oct-2026). */}
          <h3 style={{ flex: '1 1 auto', font: 'inherit', fontWeight: 700, fontSize: 15, margin: 0 }}>
            Avance de la {etiquetaCat}
          </h3>
          <button type="button" className="btn ghost sm" onClick={bajarAvance} disabled={ocupado}>
            {tarea?.clave === 'avance' && <span className="spinner" />}
            <Ic i={Download} />
            Descargar avance
          </button>
        </div>
        <div className="cards" style={{ marginBottom: 10 }}>
          {[
            { l: 'Caras', n: t.caras },
            { l: 'Pendientes', n: t.pendientes, c: 'var(--warn)', sub: t.regresadas ? `${t.regresadas} ${t.regresadas === 1 ? 'regresada' : 'regresadas'}` : '' },
            { l: 'Tomadas', n: t.tomadas, c: colorTono('azul'), sub: 'por revisar' },
            { l: 'Comprobadas', n: t.comprobadas, c: colorTono('verde'), sub: `${t.pct}%` },
          ].map((x) => (
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

        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Comprobado por ruta</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(70px,auto) minmax(0,1fr) auto', gap: '6px 10px', alignItems: 'center', fontSize: 13 }}>
          {avance.porRuta.map((r) => (
            <FilaBarra key={r.ruta || '-'} etiqueta={nombreRuta(r.ruta)} pct={r.pct} detalle={`${r.comprobadas}/${r.caras}`} />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }} role="group" aria-label="Detalle">
          {(['campana', 'monitorista'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={'rt-chip' + (verDetalle === k ? ' on' : '')}
              aria-pressed={verDetalle === k}
              onClick={() => setVerDetalle((v) => (v === k ? null : k))}
            >
              {k === 'campana' ? 'Por campaña' : 'Por monitorista'}
            </button>
          ))}
        </div>
        {verDetalle === 'campana' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(60px,30%) auto', gap: '6px 10px', alignItems: 'center', fontSize: 13, marginTop: 10 }}>
            {avance.porCampana.map((c) => (
              <FilaBarra key={c.campana} etiqueta={c.campana} pct={c.pct} detalle={`${c.comprobadas}/${c.caras}`} />
            ))}
          </div>
        )}
        {verDetalle === 'monitorista' && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            {avance.porMonitorista.length === 0 ? (
              <div style={{ color: 'var(--muted)' }}>Todavía nadie registra tomas en esta catorcena.</div>
            ) : (
              avance.porMonitorista.map((m) => (
                <div key={m.correo} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ flex: '1 1 auto', minWidth: 0 }}>{nombreDe(nombres, m.correo)}</span>
                  <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {m.tomas} tomas · {m.comprobadas} comprobadas · {m.sitios} sitios
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      {/* 2. Comprobaciones agrupadas */}
      <section className="card">
        <h3 style={{ font: 'inherit', fontWeight: 700, fontSize: 15, margin: 0 }}>Comprobaciones</h3>
        <p className="phint" style={{ margin: '4px 0 10px' }}>
          Por campaña y por día en que se tomó. Solo lo que el analista ya comprobó al revisar las fotos.
          Descarga en Excel con una liga a cada foto (la editada, si el analista la cambió).
        </p>
        {grupos.length === 0 && (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Todavía no hay tomas comprobadas en esta catorcena.</div>
        )}
        {grupos.map((g) => {
          const abiertaEsta = abierta === g.campana;
          const todas = g.dias.flatMap((d) => d.filas);
          const evidencias = todas.reduce((n, f) => n + (f.fotos || 0), 0);
          return (
            <div key={g.campana} style={{ border: '1px solid var(--line)', borderRadius: 10, marginBottom: 8 }}>
              {/* La cabecera es un botón de verdad (como en AnalistaPauta) y el
                  Excel queda FUERA de él, como hermano: antes era un div
                  role="button" que contenía al Excel y su onKeyDown se comía
                  Enter y Espacio del Excel interior, así que con teclado el
                  Excel abría o cerraba la carpeta en vez de descargar
                  (revisión de accesibilidad, 24-oct-2026). */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 12, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  aria-expanded={abiertaEsta}
                  onClick={() => setAbierta(abiertaEsta ? null : g.campana)}
                  style={{
                    flex: '1 1 160px',
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 12px',
                    background: 'none',
                    border: 'none',
                    color: 'var(--txt)',
                    font: 'inherit',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <Ic i={abiertaEsta ? ChevronDown : ChevronRight} />
                  <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <b>{g.campana}</b>
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {' '}
                      · {g.total} {g.total === 1 ? 'cara' : 'caras'} · {g.dias.length} {g.dias.length === 1 ? 'día' : 'días'} · {evidencias} {evidencias === 1 ? 'evidencia' : 'evidencias'}
                    </span>
                  </span>
                </button>
                {botones('c|' + g.campana, g.campana, `Comprobacion_${paraArchivo(g.campana)}_${sufijo}`, todas)}
              </div>
              {abiertaEsta &&
                g.dias.map((d) => (
                  <div
                    key={d.dia}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 8px 34px', borderTop: '1px solid var(--line)', flexWrap: 'wrap', fontSize: 13 }}
                  >
                    <span style={{ flex: '1 1 160px', minWidth: 0 }}>
                      {etiquetaDia(d.dia)}
                      <span style={{ color: 'var(--muted)' }}>
                        {' '}
                        · {d.filas.length} {d.filas.length === 1 ? 'cara' : 'caras'} ·{' '}
                        {[...new Set(d.filas.map((f) => nombreRuta(f.ruta_clave)))].join(', ')}
                      </span>
                    </span>
                    {botones(
                      `d|${g.campana}|${d.dia}`,
                      g.campana,
                      `Comprobacion_${paraArchivo(g.campana)}_${d.dia || 'sin-fecha'}_${sufijo}`,
                      d.filas,
                      `Excel de ${g.campana}, ${etiquetaDia(d.dia)}`
                    )}
                  </div>
                ))}
            </div>
          );
        })}
      </section>

      {/* 3. Incidencias de los sitios */}
      <IncidenciasSitiosPauta sitios={sitios} anio={anio} numero={numero} />
    </>
  );
}

function FilaBarra({ etiqueta, pct, detalle }: { etiqueta: string; pct: number; detalle: string }) {
  return (
    <>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{etiqueta}</span>
      <div style={{ height: 8, background: 'var(--panel2)', borderRadius: 4, overflow: 'hidden' }} aria-hidden="true">
        <div style={{ width: `${pct}%`, height: 8, background: colorTono('verde') }} />
      </div>
      <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap', fontSize: 12 }}>
        {pct}% · {detalle}
      </span>
    </>
  );
}
