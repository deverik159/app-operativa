// ============================================================
// src/modules/incidencias/IndicadoresAppBioboxView.tsx
// Pestaña «App Biobox» de Indicadores (Erik, 18-nov-2026; ficha
// incidencias, «Indicadores por pestañas»).
//
// Los reportes que los usuarios levantan en la app de Biobox: cuántos
// llegan, por qué motivo, cuántos se atienden solos con las reglas y cuántos
// pasan por la validadora, cuánto tardan (reporte → clasificación →
// reparación → cierre → «Atendido» en el Webadmin), los que llegan sin
// máquina, las máquinas con más reportes y la reincidencia.
//
// La ven los mismos que la bandeja (unidadesBandeja). Solo lee columnas de
// operación: NUNCA la descripción ni los contactos del usuario. Los cálculos
// viven en lib/reportesAppBiobox.ts (con pruebas).
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import { sb } from '../../lib/supabase';
import { fmtHoras } from '../../lib/helpers';
import { EST_LABEL } from '../../lib/constants';
import { fechaHoraCdmx } from '../../lib/fechasCdmx';
import CerrarModal from '../../components/CerrarModal';
import {
  ETIQUETA_ATENCION,
  comoSeAtendio,
  contarPor,
  fechaCoreAIso,
  nombreCortoMaquina,
  porSemanaApp,
  reincidentesApp,
  resumenAppBiobox,
  textoEstatusCore,
  traeMaquina,
  type Conteo,
  type IncTiempos,
  type ReporteIndicador,
} from '../../lib/reportesAppBiobox';

const COLUMNAS =
  'report_id,unidad_negocio,caso_id,motivo,clave_inventario,codigo_maquina,nombre_maquina,' +
  'fecha_reporte_core,primera_vez,decision,decidido_por,decidido_en,record_id,atendido_core_en,' +
  'folio_app,estatus_core,estatus_core_nombre';

/** Un reporte con lo que enseña el detalle (sin descripción ni contactos). */
type Fila = ReporteIndicador & {
  folio_app: string | null;
  estatus_core: number | null;
  estatus_core_nombre: string | null;
};
/** La incidencia ligada: tiempos para los indicadores y folio para el detalle. */
type IncFila = IncTiempos & { folio: string | null; estatus: string };
type Abrir = (titulo: string, filas: Fila[]) => void;
const PAGINA = 1000;
const TOPE = 20000;
const LOTE_INCS = 200;

type Periodo = '30d' | '90d' | 'todo';
const PERIODOS: { valor: Periodo; etiqueta: string }[] = [
  { valor: '30d', etiqueta: '30 días' },
  { valor: '90d', etiqueta: '90 días' },
  { valor: 'todo', etiqueta: 'Todo' },
];
const DIA = 86400000;

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** '2026-11-09' → 'Sem. del 9-nov'. */
const etiquetaLunes = (lunes: string) => {
  const [, m, d] = lunes.split('-').map(Number);
  return `Sem. del ${d}-${MESES[(m || 1) - 1]}`;
};
const pct = (n: number, de: number) => (de ? Math.round((n / de) * 100) : 0);

/** Estilo de botón que no parece botón (como en la pestaña Incidencias). */
const SIN_BOTON: React.CSSProperties = {
  background: 'none', border: 'none', color: 'inherit', font: 'inherit', padding: 0, textAlign: 'left', cursor: 'pointer', width: '100%',
};

function Barras<T>({ data, color, ancha = false, vacio = 'Sin datos.', onAbrir }: {
  data: Conteo<T>[]; color: string; ancha?: boolean; vacio?: string;
  /** Toca un renglón y se abren los reportes que lo forman. */
  onAbrir?: (f: Conteo<T>) => void;
}) {
  if (!data.length) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>{vacio}</div>;
  const max = Math.max(...data.map((d) => d.n), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {data.map((f) => (
        <button
          type="button"
          key={f.etiqueta}
          onClick={onAbrir ? () => onAbrir(f) : undefined}
          title={onAbrir ? `Ver los ${f.n} de ${f.etiqueta}` : `${f.etiqueta}: ${f.n}`}
          style={{
            ...SIN_BOTON,
            cursor: onAbrir ? 'pointer' : 'default',
            display: 'grid',
            gridTemplateColumns: ancha ? 'minmax(0, clamp(150px, 58%, 320px)) 1fr auto' : 'minmax(0, clamp(110px, 40%, 190px)) 1fr auto',
            alignItems: 'center',
            gap: 10,
            fontSize: 13,
          }}
        >
          <span style={ancha ? { overflowWrap: 'anywhere', lineHeight: 1.25 } : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {f.etiqueta}
          </span>
          <div style={{ background: 'var(--panel2)', borderRadius: 4, height: 9, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 4, background: color, width: (f.n / max) * 100 + '%' }} />
          </div>
          <span style={{ textAlign: 'right' }}>{f.n}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Columnas por semana (tendencia en el tiempo): una sola serie, el número
 * encima de cada columna y la semana abajo. Escala desde cero.
 */
function Columnas<T>({ data, color, onAbrir }: { data: Conteo<T>[]; color: string; onAbrir?: (f: Conteo<T>) => void }) {
  if (!data.length) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>Sin datos.</div>;
  const max = Math.max(...data.map((d) => d.n), 1);
  return (
    <div role="img" aria-label={`Reportes por semana: ${data.map((d) => `${d.etiqueta} ${d.n}`).join(', ')}`}
      style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 170, paddingTop: 4 }}>
      {data.map((d) => (
        <button type="button" key={d.etiqueta} title={`${d.etiqueta}: ${d.n} reportes`}
          onClick={onAbrir ? () => onAbrir(d) : undefined}
          style={{ ...SIN_BOTON, cursor: onAbrir ? 'pointer' : 'default', flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 12, marginBottom: 3 }}>{d.n}</span>
          <div style={{ width: '70%', maxWidth: 34, height: `${(d.n / max) * 118}px`, minHeight: d.n ? 2 : 0, background: color, borderRadius: '4px 4px 0 0' }} />
          {/* Día arriba y mes abajo: en una línea («28-sep») se tocaban en el celular. */}
          <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5, lineHeight: 1.15, textAlign: 'center' }}>
            {d.etiqueta.replace(/^Sem\. del /, '').split('-').map((x, i) => <span key={i} style={{ display: 'block' }}>{x}</span>)}
          </span>
        </button>
      ))}
    </div>
  );
}

type Parte = { etiqueta: string; n: number; color: string; filas: Fila[] };

/**
 * Un todo partido en pocas partes (≤ 6): una barra con cada parte en su
 * color y la leyenda con nombre, número y %. Entre partes, 2 px del fondo
 * para que no se confundan.
 */
function BarraPartida({ partes, onAbrir }: { partes: Parte[]; onAbrir?: Abrir }) {
  const total = partes.reduce((a, p) => a + p.n, 0);
  if (!total) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>Sin datos.</div>;
  const visibles = partes.filter((p) => p.n > 0);
  return (
    <div>
      {/* Sin texto encima: la leyenda trae número y %, y el blanco sobre
          ámbar o gris no se leía en el tema oscuro. */}
      <div role="img" aria-label={partes.map((p) => `${p.etiqueta}: ${p.n}`).join(', ')}
        style={{ display: 'flex', gap: 2, height: 16, borderRadius: 5, overflow: 'hidden' }}>
        {visibles.map((p) => (
          <button type="button" key={p.etiqueta} title={`${p.etiqueta}: ${p.n} (${Math.round((p.n / total) * 100)} %)`}
            onClick={onAbrir ? () => onAbrir(p.etiqueta, p.filas) : undefined}
            style={{ ...SIN_BOTON, cursor: onAbrir ? 'pointer' : 'default', flex: `${p.n} 0 0`, width: 'auto', background: p.color, minWidth: 3 }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12, fontSize: 13 }}>
        {partes.map((p) => (
          <button type="button" key={p.etiqueta} onClick={onAbrir && p.n ? () => onAbrir(p.etiqueta, p.filas) : undefined}
            title={onAbrir && p.n ? `Ver los ${p.n}` : undefined}
            style={{ ...SIN_BOTON, cursor: onAbrir && p.n ? 'pointer' : 'default', display: 'grid', gridTemplateColumns: '12px 1fr auto', gap: 8, alignItems: 'center' }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: p.color }} />
            <span>{p.etiqueta}</span>
            <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
              <b style={{ color: 'var(--txt)' }}>{p.n}</b> · {Math.round((p.n / total) * 100)} %
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

type Apilada = { etiqueta: string; con: number; sin: number; filas: Fila[] };

/**
 * Barras horizontales apiladas: por motivo, cuántos traen máquina y cuántos
 * no. El acento va en «sin máquina» (es la historia); «con máquina» en gris.
 */
function BarrasApiladas({ data, onAbrir }: { data: Apilada[]; onAbrir?: Abrir }) {
  if (!data.length) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>Sin datos.</div>;
  const max = Math.max(...data.map((d) => d.con + d.sin), 1);
  return (
    <div>
      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--purple)' }} />Sin máquina
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--muted)', opacity: 0.55 }} />Con máquina
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.map((d) => (
          <button type="button" key={d.etiqueta} title={`${d.etiqueta}: ${d.sin} sin máquina, ${d.con} con máquina`}
            onClick={onAbrir ? () => onAbrir(d.etiqueta, d.filas) : undefined}
            style={{ ...SIN_BOTON, cursor: onAbrir ? 'pointer' : 'default', display: 'grid', gridTemplateColumns: 'minmax(0, clamp(150px, 42%, 300px)) 1fr auto', alignItems: 'center', gap: 10, fontSize: 13 }}>
            <span style={{ overflowWrap: 'anywhere', lineHeight: 1.25 }}>{d.etiqueta}</span>
            <div style={{ display: 'flex', gap: 2, height: 9 }}>
              {d.sin > 0 && <div style={{ width: `${(d.sin / max) * 100}%`, background: 'var(--purple)', borderRadius: 4 }} />}
              {d.con > 0 && <div style={{ width: `${(d.con / max) * 100}%`, background: 'var(--muted)', opacity: 0.55, borderRadius: 4 }} />}
            </div>
            <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {d.con + d.sin}
              {d.sin > 0 && d.con > 0 && <span style={{ color: 'var(--muted)' }}> ({d.sin} sin)</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Tarjeta({ titulo, children, nota }: { titulo: string; children: React.ReactNode; nota?: string }) {
  return (
    <div className="card">
      <div className="l" style={{ marginBottom: 12 }}>{titulo}</div>
      {children}
      {nota && <div className="phint" style={{ margin: '10px 0 0' }}>{nota}</div>}
    </div>
  );
}

/**
 * Un número de arriba. Los de conteo se abren («· ver»); los de tiempo no:
 * detrás de una mediana no hay un conjunto que enseñar (igual que en la
 * pestaña Incidencias).
 */
function Numero({ n, l, color, onAbrir }: { n: React.ReactNode; l: React.ReactNode; color?: string; onAbrir?: () => void }) {
  const contenido = (
    <>
      <div className="n" style={color ? { color } : undefined}>{n}</div>
      <div className="l">{l}{onAbrir && <span style={{ opacity: 0.8 }}> · ver</span>}</div>
    </>
  );
  if (!onAbrir) return <div className="card">{contenido}</div>;
  return (
    <button type="button" className="card" onClick={onAbrir}
      style={{ cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left', width: '100%' }}>
      {contenido}
    </button>
  );
}

const TOPE_GRUPOS = 60;
const TOPE_REPORTES = 40;

/**
 * El detrás de un número o una barra: los MISMOS reportes que se contaron,
 * agrupados por máquina o por motivo (como el detalle de la pestaña
 * Incidencias, que agrupa por sitio o por incidencia). Sin descripción ni
 * contactos del usuario.
 */
function DetalleApp({ titulo, filas, incs, onClose }: {
  titulo: string; filas: Fila[]; incs: ReadonlyMap<string, IncFila>; onClose: () => void;
}) {
  // De una sola máquina (p. ej. su barra del top), abre por motivo: «Por
  // máquina (1)» no dice nada y obligaba a un clic de más.
  const [corte, setCorte] = useState<'maquina' | 'motivo'>(() =>
    new Set(filas.map((r) => r.clave_inventario || '')).size === 1 ? 'motivo' : 'maquina'
  );
  const [abiertoElegido, setAbierto] = useState('');
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const llaveMaquina = (r: Fila) => (traeMaquina(r) ? nombreCortoMaquina(r.clave_inventario, r.nombre_maquina) : 'Sin máquina');
  const llaveMotivo = (r: Fila) => r.motivo || 'Otro (texto libre)';
  const grupos = useMemo(
    () => contarPor(filas, corte === 'maquina' ? llaveMaquina : llaveMotivo),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filas, corte]
  );
  const nMaq = useMemo(() => new Set(filas.map(llaveMaquina)).size, [filas]);
  const nMot = useMemo(() => new Set(filas.map(llaveMotivo)).size, [filas]);
  // Un solo grupo: ya desplegado.
  const abierto = grupos.length === 1 ? grupos[0].etiqueta : abiertoElegido;
  const fechaDe = (r: Fila) => {
    const iso = fechaCoreAIso(r.fecha_reporte_core);
    return iso ? fechaHoraCdmx(iso) : r.fecha_reporte_core || '—';
  };
  return (
    <div className="overlay" onClick={(e) => { if ((e.target as HTMLElement).className === 'overlay') onClose(); }}>
      <div className="modal" style={{ maxWidth: 760 }} role="dialog" aria-label={titulo}>
        <CerrarModal onClick={onClose} />
        <h2 style={{ margin: '0 0 3px' }}>{titulo}</h2>
        <p className="phint">{filas.length} reporte{filas.length === 1 ? '' : 's'} de la app Biobox · sin datos del usuario</p>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          {nMaq > 1 && (
            <button type="button" className={'btn sm ' + (corte === 'maquina' ? '' : 'ghost')} onClick={() => { setCorte('maquina'); setAbierto(''); }}>
              Por máquina ({nMaq})
            </button>
          )}
          <button type="button" className={'btn sm ' + (corte === 'motivo' ? '' : 'ghost')} onClick={() => { setCorte('motivo'); setAbierto(''); }}>
            Por motivo ({nMot})
          </button>
        </div>
        {!filas.length ? (
          <div className="empty">No hay reportes detrás de este número.</div>
        ) : (
          <div className="lista-scroll" style={{ border: '1px solid var(--line)', borderRadius: 10 }}>
            {grupos.slice(0, TOPE_GRUPOS).map((g) => {
              const esta = abierto === g.etiqueta;
              const lista = esta
                ? [...g.filas].sort((a, b) => (fechaCoreAIso(b.fecha_reporte_core) || '').localeCompare(fechaCoreAIso(a.fecha_reporte_core) || ''))
                : [];
              return (
                <div key={g.etiqueta} style={{ borderBottom: '1px solid var(--line)' }}>
                  <button type="button" onClick={() => setAbierto(esta ? '' : g.etiqueta)}
                    style={{ ...SIN_BOTON, display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center', padding: '11px 13px' }}>
                    <span style={{ fontWeight: 600, fontSize: 14, overflowWrap: 'anywhere' }}>{esta ? '▾ ' : '▸ '}{g.etiqueta}</span>
                    <span className="tag">{g.n}</span>
                  </button>
                  {esta && (
                    <div style={{ padding: '0 13px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {lista.slice(0, TOPE_REPORTES).map((r) => {
                        const inc = r.record_id ? incs.get(r.record_id) : undefined;
                        return (
                          <div key={r.report_id} style={{ fontSize: 13, padding: '7px 9px', background: 'var(--panel2)', borderRadius: 8, overflowWrap: 'anywhere' }}>
                            <b>App {r.folio_app || r.report_id}</b>
                            <span style={{ color: 'var(--muted)' }}> · {fechaDe(r)}</span>
                            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                              {corte === 'maquina' ? llaveMotivo(r) : llaveMaquina(r)}
                              {' · '}{ETIQUETA_ATENCION[comoSeAtendio(r)]}
                              {inc?.folio ? ` · ${inc.folio} (${EST_LABEL[inc.estatus] || inc.estatus})` : ''}
                              {' · Biobox: '}{textoEstatusCore(r)}
                            </div>
                          </div>
                        );
                      })}
                      {lista.length > TOPE_REPORTES && (
                        <div className="phint" style={{ margin: 0 }}>Y {lista.length - TOPE_REPORTES} más: búscalos en Reportes App Biobox.</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {grupos.length > TOPE_GRUPOS && (
              <div className="phint" style={{ margin: 0, padding: '9px 13px' }}>Y {grupos.length - TOPE_GRUPOS} grupos más.</div>
            )}
          </div>
        )}
        <div className="modal-actions pie-fijo">
          <button type="button" className="btn ghost" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}

/** Dos tarjetas por renglón; la que queda sola va a lo ancho (como KpiView). */
function Rejilla({ tarjetas }: { tarjetas: React.ReactElement[] }) {
  const pares: React.ReactElement[][] = [];
  for (let i = 0; i < tarjetas.length; i += 2) pares.push(tarjetas.slice(i, i + 2));
  return (
    <>
      {pares.map((par, i) => (
        <div key={String(par[0].key)} className={par.length === 2 ? 'row2' : undefined} style={{ gap: 16, marginTop: i ? 16 : 0 }}>
          {par}
        </div>
      ))}
    </>
  );
}

export default function IndicadoresAppBioboxView({ unidades, recargarSignal }: {
  /** Unidades cuya bandeja ve (unidadesBandeja). */
  unidades: readonly string[];
  recargarSignal?: number;
}) {
  const [reportes, setReportes] = useState<Fila[] | null>(null);
  const [incs, setIncs] = useState<Map<string, IncFila>>(new Map());
  // Lo que se está viendo en el detalle (18-nov-2026: como en Incidencias).
  const [detalle, setDetalle] = useState<{ titulo: string; filas: Fila[] } | null>(null);
  const abrir: Abrir = (titulo, filas) => setDetalle({ titulo, filas });
  const [err, setErr] = useState('');
  const [periodo, setPeriodo] = useState<Periodo>('90d');
  const claveUnidades = unidades.join('|');

  useEffect(() => {
    let vivo = true;
    setErr('');
    void (async () => {
      try {
        const lista = claveUnidades ? claveUnidades.split('|') : [];
        if (!lista.length) { if (vivo) setReportes([]); return; }
        const todos: Fila[] = [];
        for (let desde = 0; desde < TOPE; desde += PAGINA) {
          const { data, error } = await sb.from('biobox_app_reportes').select(COLUMNAS).in('unidad_negocio', lista)
            .order('report_id', { ascending: false }).range(desde, desde + PAGINA - 1);
          if (error) throw error;
          todos.push(...((data || []) as unknown as Fila[]));
          if (!data || data.length < PAGINA) break;
        }
        // Tiempos de las incidencias ligadas. Con la RLS, cada quien ve las
        // suyas: un técnico de TI mide solo las de TI.
        const ids = [...new Set(todos.map((r) => r.record_id).filter(Boolean))] as string[];
        const m = new Map<string, IncFila>();
        for (let i = 0; i < ids.length; i += LOTE_INCS) {
          const { data, error } = await sb.from('incidencias').select('record_id,folio,estatus,repaired_at,cerrada_en')
            .in('record_id', ids.slice(i, i + LOTE_INCS));
          if (error) throw error;
          for (const x of (data || []) as IncFila[]) m.set(x.record_id, x);
        }
        if (!vivo) return;
        setReportes(todos);
        setIncs(m);
      } catch (e) {
        if (vivo) setErr('No se pudieron cargar los reportes de la app: ' + ((e as Error).message || String(e)));
      }
    })();
    return () => { vivo = false; };
  }, [claveUnidades, recargarSignal]);

  const enPeriodo = useMemo(() => {
    if (!reportes) return [];
    if (periodo === 'todo') return reportes;
    const desde = Date.now() - (periodo === '30d' ? 30 : 90) * DIA;
    return reportes.filter((r) => {
      const iso = fechaCoreAIso(r.fecha_reporte_core);
      return iso ? Date.parse(iso) >= desde : false;
    });
  }, [reportes, periodo]);

  const res = useMemo(() => resumenAppBiobox(enPeriodo, incs), [enPeriodo, incs]);
  const semanas = useMemo(
    () => porSemanaApp(enPeriodo).map((s) => ({ ...s, etiqueta: etiquetaLunes(s.etiqueta) })).slice(-14),
    [enPeriodo]
  );
  // Por motivo, con y sin máquina (una sola gráfica apilada).
  const motivos = useMemo(
    () =>
      contarPor(enPeriodo, (r) => r.motivo || 'Otro (texto libre)').map((g) => {
        const sin = g.filas.filter((r) => !traeMaquina(r)).length;
        return { etiqueta: g.etiqueta, sin, con: g.n - sin, filas: g.filas };
      }),
    [enPeriodo]
  );
  // Cómo se atendió lo que LLEGÓ a la bandeja (lo atendido antes en el
  // Webadmin va aparte, en su número).
  const atencion = useMemo((): Parte[] => {
    const c = { solos: [] as Fila[], validadora: [] as Fila[], pendientes: [] as Fila[], descartados: [] as Fila[] };
    for (const r of enPeriodo) {
      const x = comoSeAtendio(r);
      if (x === 'directo' || x === 'ligado_regla') c.solos.push(r);
      else if (x === 'clasificado' || x === 'ligado_validadora') c.validadora.push(r);
      else if (x === 'por_clasificar') c.pendientes.push(r);
      else if (x === 'descartado') c.descartados.push(r);
    }
    const parte = (etiqueta: string, filas: Fila[], color: string): Parte => ({ etiqueta, n: filas.length, color, filas });
    return [
      parte('Solos, con las reglas (directo o ligado)', c.solos, 'var(--serie2)'),
      parte('La validadora (clasificado o ligado)', c.validadora, 'var(--accent2)'),
      parte('Por clasificar', c.pendientes, 'var(--warn)'),
      parte('Descartados', c.descartados, 'var(--muted)'),
    ];
  }, [enPeriodo]);
  const maquinas = useMemo(
    () =>
      contarPor(enPeriodo.filter(traeMaquina), (r) => nombreCortoMaquina(r.clave_inventario, r.nombre_maquina)).slice(0, 10),
    [enPeriodo]
  );
  const reincidentes = useMemo(() => reincidentesApp(enPeriodo, 30).slice(0, 10), [enPeriodo]);

  if (err) return <div className="err">{err}</div>;
  if (!reportes) return <div className="loading">Cargando los reportes de la app Biobox…</div>;

  const h = (x: { h: number | null; n: number }) => (x.h == null ? '—' : fmtHoras(x.h));

  return (
    <div>
      <p className="phint">
        Reportes que levantan los usuarios en la app Biobox ({unidades.join(', ')}). Sin datos personales del usuario.
      </p>
      <div className="toolbar" style={{ marginBottom: 6, alignItems: 'center' }}>
        <div className="segmento" role="group" aria-label="Periodo">
          {PERIODOS.map((p) => (
            <button key={p.valor} type="button" aria-pressed={periodo === p.valor} onClick={() => setPeriodo(p.valor)}>
              {p.etiqueta}
            </button>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
        {res.total.toLocaleString('es-MX')} {res.total === 1 ? 'reporte' : 'reportes'} por la fecha en que reportó el usuario
        {periodo === 'todo' ? ', en todo el historial cargado.' : `, últimos ${periodo === '30d' ? 30 : 90} días.`}
      </div>

      <div className="cards cinco">
        <Numero n={res.total} l="Reportes" onAbrir={() => abrir('Reportes del periodo', enPeriodo)} />
        {/* Sobre lo que llegó a la bandeja: lo que el Webadmin ya había
            atendido (los Atendidos viejos) no pasó por las reglas. */}
        <Numero n={`${pct(res.automaticos, res.enBandeja)} %`} l={`Se atendieron solos (${res.automaticos} de ${res.enBandeja})`} color="var(--ok)"
          onAbrir={() => abrir('Se atendieron solos', atencion[0].filas)} />
        <Numero n={`${pct(res.porValidadora, res.enBandeja)} %`} l={`Pasaron por la validadora (${res.porValidadora} de ${res.enBandeja})`}
          onAbrir={() => abrir('Pasaron por la validadora', atencion[1].filas)} />
        <Numero n={res.porClasificar} l="Por clasificar" color={res.porClasificar ? 'var(--warn)' : undefined}
          onAbrir={() => abrir('Por clasificar', atencion[2].filas)} />
        <Numero n={`${pct(res.sinMaquina, res.total)} %`} l={`Sin máquina (${res.sinMaquina})`}
          onAbrir={() => abrir('Sin máquina', enPeriodo.filter((r) => !traeMaquina(r)))} />
      </div>
      <div className="cards cinco">
        <Numero n={h(res.aClasificar)} l={`Llegó a la bandeja → clasificación (${res.aClasificar.n})`} />
        <Numero n={h(res.aReparar)} l={`Reporte → reparación (${res.aReparar.n})`} />
        <Numero n={h(res.aCierre)} l={`Reporte → cierre (${res.aCierre.n})`} />
        <Numero n={h(res.cierreAAtendido)} l={`Cierre → Atendido en Webadmin (${res.cierreAAtendido.n})`} />
        <Numero n={res.atendidosAntes} l="Atendidos en el Webadmin antes de pasar aquí"
          onAbrir={() => abrir('Atendidos en el Webadmin antes de pasar aquí', enPeriodo.filter((r) => comoSeAtendio(r) === 'atendido_webadmin'))} />
      </div>
      <p className="phint" style={{ marginTop: -8 }}>
        Los tiempos son medianas desde la hora en que reportó el usuario (la clasificación, desde que llegó a la bandeja); entre paréntesis, cuántos se midieron.
      </p>

      {/* Orden de Erik (18-nov-2026): máquinas, reincidencia, semana, motivo y
          cómo se atendieron. Las dos primeras lado a lado; las demás a lo ancho. */}
      <Rejilla
        tarjetas={[
          <Tarjeta key="maquinas" titulo="Máquinas con más reportes (top 10)">
            <Barras data={maquinas} color="var(--accent2)" ancha onAbrir={(f) => abrir(f.etiqueta, f.filas)} />
          </Tarjeta>,
          <Tarjeta key="rein" titulo="Reincidencia: misma máquina y motivo en menos de 30 días" nota="Sin contar descartados ni reportes sin máquina.">
            <Barras data={reincidentes} color="var(--accent2)" ancha vacio="Sin reincidencias en el periodo."
              onAbrir={(f) => abrir(`Reincidencia: ${f.etiqueta}`, f.filas)} />
          </Tarjeta>,
        ]}
      />
      <div style={{ marginTop: 16 }}>
        <Tarjeta titulo="Reportes por semana">
          <Columnas data={semanas} color="var(--accent2)" onAbrir={(f) => abrir(f.etiqueta, f.filas)} />
        </Tarjeta>
      </div>
      <div style={{ marginTop: 16 }}>
        <Tarjeta titulo="Por motivo, con y sin máquina" nota="La app de Biobox solo pide la máquina en las fallas de máquina.">
          <BarrasApiladas data={motivos} onAbrir={abrir} />
        </Tarjeta>
      </div>
      <div style={{ marginTop: 16 }}>
        <Tarjeta titulo={`Cómo se atendieron los ${res.enBandeja} que llegaron a la bandeja`}
          nota={res.atendidosAntes ? `Aparte, ${res.atendidosAntes} ya los había atendido el Webadmin antes de pasar aquí.` : undefined}>
          <BarraPartida partes={atencion} onAbrir={abrir} />
        </Tarjeta>
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 14 }}>
        Toca cualquier número o barra para ver los reportes que hay detrás.
      </div>
      {detalle && (
        <DetalleApp titulo={detalle.titulo} filas={detalle.filas} incs={incs} onClose={() => setDetalle(null)} />
      )}
    </div>
  );
}
