// ============================================================
// src/modules/incidencias/IndicadoresTecnicosView.tsx
// Pestaña «Técnicos» de Indicadores (Erik, 18-nov-2026; ficha incidencias,
// «Indicadores por pestañas»).
//
// Por semana o por mes (el mes actual por omisión; Erik, 18-nov-2026, en
// lugar de la catorcena):
//  · Reparaciones por técnico: cuántas reparó, mediana desde que llegó a su
//    área hasta reparada, cuántas le rechazaron y en cuántas apoyó.
//  · Op. Bio Box: el avance de SU ruta (regla de Rutas › Avance de visitas),
//    sus visitas rápidas y revisiones, y las máquinas de su ruta sin visita
//    en más de 14 días.
//
// Quién ve qué (Erik): el manager y los coordinadores ven a todos los
// técnicos de su unidad y área (la lista la recorta actividad_equipo en la
// base); cada técnico ve SOLO lo suyo, sin ranking de compañeros. Cálculos
// en lib/indicadoresTecnicos.ts (con pruebas).
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import { sb } from '../../lib/supabase';
import { fmtHoras } from '../../lib/helpers';
import { cargarNombres, nombreDe, type MapaNombres } from '../../lib/nombres';
import { nombreCortoMaquina } from '../../lib/reportesAppBiobox';
import {
  avancePorTecnico,
  mediana,
  reparacionesPorTecnico,
  tecnicosDe,
  periodosDe,
  type AvanceRuta,
  type Parada,
  type TipoPeriodo,
  type PersonaRoles,
  type VisitaPeriodo,
} from '../../lib/indicadoresTecnicos';
import { trozos } from '../rutas/rutasComun';
import type { Incidencia } from '../../types/db';
import CerrarModal from '../../components/CerrarModal';
import KpiDetalleModal from './KpiDetalleModal';

type FilaRol = { rol: string; unidad_negocio: string | null; departamento?: string | null };
const OP_BIOBOX = 'op. bio box';
const minus = (s: string | null | undefined) => (s || '').trim().toLowerCase();
const DIA = 86400000;
const pct = (n: number, de: number) => (de ? Math.round((n / de) * 100) : 0);

const SIN_BOTON: React.CSSProperties = {
  background: 'none', border: 'none', color: 'inherit', font: 'inherit', padding: 0, textAlign: 'left', cursor: 'pointer', width: '100%',
};

function Numero({ n, l, color, onAbrir }: { n: React.ReactNode; l: React.ReactNode; color?: string; onAbrir?: () => void }) {
  const contenido = (
    <>
      <div className="n" style={color ? { color } : undefined}>{n}</div>
      <div className="l">{l}{onAbrir && <span style={{ opacity: 0.8 }}> · ver</span>}</div>
    </>
  );
  if (!onAbrir) return <div className="card">{contenido}</div>;
  return (
    <button type="button" className="card" onClick={onAbrir} style={{ cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left', width: '100%' }}>
      {contenido}
    </button>
  );
}

function Tarjeta({ titulo, children, nota }: { titulo: string; children: React.ReactNode; nota?: string }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="l" style={{ marginBottom: 12 }}>{titulo}</div>
      {children}
      {nota && <div className="phint" style={{ margin: '10px 0 0' }}>{nota}</div>}
    </div>
  );
}

/** Barras horizontales clicables (una por técnico). */
function Barras({ data, color, onAbrir }: {
  data: { clave: string; etiqueta: string; n: number; extra?: string }[]; color: string; onAbrir?: (clave: string) => void;
}) {
  if (!data.length) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>Sin datos en este periodo.</div>;
  const max = Math.max(...data.map((d) => d.n), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {data.map((d) => (
        <button type="button" key={d.clave} onClick={onAbrir && d.n ? () => onAbrir(d.clave) : undefined}
          title={`${d.etiqueta}: ${d.n}`}
          style={{ ...SIN_BOTON, cursor: onAbrir && d.n ? 'pointer' : 'default', display: 'grid', gridTemplateColumns: 'minmax(0, clamp(130px, 40%, 240px)) 1fr auto', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <span style={{ overflowWrap: 'anywhere', lineHeight: 1.25 }}>{d.etiqueta}</span>
          <div style={{ background: 'var(--panel2)', borderRadius: 4, height: 9, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 4, background: color, width: (d.n / max) * 100 + '%' }} />
          </div>
          <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{d.n}{d.extra && <span style={{ color: 'var(--muted)' }}> {d.extra}</span>}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Avance de la ruta por técnico: un medidor por renglón (máquinas visitadas
 * de las de su ruta), contra 100 %.
 */
function Medidores({ data, onAbrir }: {
  data: { clave: string; etiqueta: string; hechos: number; total: number }[]; onAbrir: (clave: string) => void;
}) {
  if (!data.length) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>Ningún técnico de Op. Bio Box tiene ruta asignada.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {data.map((d) => {
        const p = pct(d.hechos, d.total);
        return (
          <button type="button" key={d.clave} onClick={() => onAbrir(d.clave)} title={`${d.etiqueta}: ${d.hechos} de ${d.total}`}
            style={{ ...SIN_BOTON, display: 'grid', gridTemplateColumns: 'minmax(0, clamp(130px, 40%, 240px)) 1fr auto', alignItems: 'center', gap: 10, fontSize: 13 }}>
            <span style={{ overflowWrap: 'anywhere', lineHeight: 1.25 }}>{d.etiqueta}</span>
            <div style={{ background: 'var(--panel2)', borderRadius: 4, height: 9, overflow: 'hidden' }}>
              <div style={{ height: '100%', borderRadius: 4, background: 'var(--serie2)', width: p + '%' }} />
            </div>
            <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{p} % <span style={{ color: 'var(--muted)' }}>({d.hechos} de {d.total})</span></span>
          </button>
        );
      })}
    </div>
  );
}

/** Las máquinas de la ruta de un técnico: visitadas en el periodo o no, y su última visita. */
function DetalleRuta({ titulo, avance, nombreMaq, ultima, visitaPeriodo, quien, enPeriodo, onClose }: {
  titulo: string; enPeriodo: string; avance: AvanceRuta; nombreMaq: (s: string) => string; ultima: ReadonlyMap<string, string>;
  visitaPeriodo: ReadonlyMap<string, VisitaPeriodo>; quien: (e: string) => string; onClose: () => void;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const sinVisitar = avance.sitios.filter((s) => !avance.visitados.includes(s));
  const diasDesde = (s: string) => {
    const t = Date.parse(ultima.get(s) || '');
    return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / DIA);
  };
  const fila = (s: string, hecho: boolean) => {
    const v = visitaPeriodo.get(s);
    const d = diasDesde(s);
    return (
      <div key={s} style={{ fontSize: 13, padding: '7px 9px', background: 'var(--panel2)', borderRadius: 8, overflowWrap: 'anywhere' }}>
        <b>{nombreMaq(s)}</b>
        <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
          {hecho && v
            ? `Visitada el ${new Date(v.visitado_en).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })} por ${quien(v.usuario_email)} (${v.tipo === 'rapida' ? 'visita rápida' : v.tipo === 'revision' ? 'revisión' : 'monitoreo'})`
            : d == null ? 'Nunca se ha visitado' : `Última visita hace ${d} día${d === 1 ? '' : 's'}`}
        </div>
      </div>
    );
  };
  return (
    <div className="overlay" onClick={(e) => { if ((e.target as HTMLElement).className === 'overlay') onClose(); }}>
      <div className="modal" style={{ maxWidth: 640 }} role="dialog" aria-label={titulo}>
        <CerrarModal onClick={onClose} />
        <h2 style={{ margin: '0 0 3px' }}>{titulo}</h2>
        <p className="phint">{avance.visitados.length} de {avance.sitios.length} máquinas de su ruta visitadas {enPeriodo}</p>
        <div className="lista-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sinVisitar.length > 0 && <div className="l" style={{ margin: '4px 0' }}>Sin visita {enPeriodo} ({sinVisitar.length})</div>}
          {sinVisitar.sort((a, b) => (diasDesde(b) ?? 9999) - (diasDesde(a) ?? 9999)).map((s) => fila(s, false))}
          {avance.visitados.length > 0 && <div className="l" style={{ margin: '10px 0 4px' }}>Visitadas ({avance.visitados.length})</div>}
          {avance.visitados.map((s) => fila(s, true))}
        </div>
        <div className="modal-actions pie-fijo">
          <button type="button" className="btn ghost" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}

export default function IndicadoresTecnicosView({ roles, email, recargarSignal }: {
  roles: readonly FilaRol[];
  email: string;
  recargarSignal?: number;
}) {
  const yo = minus(email);
  const esJefe = roles.some((r) => r.rol === 'manager' || r.rol === 'coordinador');
  const [tipo, setTipo] = useState<TipoPeriodo>('mes');
  const [perSel, setPerSel] = useState('');
  const [personas, setPersonas] = useState<PersonaRoles[] | null>(null);
  const [nombres, setNombres] = useState<MapaNombres>({});
  const [incs, setIncs] = useState<Incidencia[] | null>(null);
  const [ruta, setRuta] = useState<{
    rutasDe: Map<string, number[]>; paradas: Parada[]; visitas: VisitaPeriodo[]; ultima: Map<string, string>; maquinas: Map<string, string>;
  } | null>(null);
  const [err, setErr] = useState('');
  const [fUnidad, setFUnidad] = useState('Todas');
  const [fArea, setFArea] = useState('Todas');
  const [detalleInc, setDetalleInc] = useState<{ titulo: string; items: Incidencia[] } | null>(null);
  const [detalleRuta, setDetalleRuta] = useState<string | null>(null);

  // La gente (una vez).
  useEffect(() => {
    let vivo = true;
    void cargarNombres().then((n) => { if (vivo) setNombres(n); });
    void (async () => {
      if (esJefe) {
        // La base recorta: el manager ve a todos; el coordinador, su unidad y área.
        const { data, error } = await sb.rpc('actividad_equipo', { p_dias: 30 });
        if (!vivo) return;
        if (error) { setErr('No se pudo leer la lista de técnicos: ' + error.message); return; }
        setPersonas(((data || []) as PersonaRoles[]).map((p) => ({ email: p.email, nombre: p.nombre, roles: p.roles })));
      } else {
        setPersonas([{
          email: yo, nombre: null,
          roles: roles.filter((r) => r.rol === 'reparacion').map((r) => ({ unidad: r.unidad_negocio, area: r.departamento ?? null, rol: r.rol })),
        }]);
      }
    })();
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recargarSignal]);

  // Las últimas 12 semanas o meses; el actual por omisión.
  const periodos = useMemo(() => periodosDe(tipo), [tipo]);
  const periodo = periodos.find((x) => x.clave === perSel) || periodos[0];
  const desdeIso = periodo.desde.toISOString();
  const hastaIso = periodo.hasta.toISOString();
  const enPeriodo = tipo === 'semana' ? 'en la semana' : 'en el mes';
  const todosTecnicos = useMemo(() => tecnicosDe(personas || []), [personas]);
  const hayOpBiobox = todosTecnicos.some((t) => t.areas.some((a) => minus(a) === OP_BIOBOX));

  // Reparaciones del periodo (la RLS deja ver a cada quien lo suyo).
  useEffect(() => {
    let vivo = true;
    setIncs(null);
    void (async () => {
      const { data, error } = await sb.from('incidencias').select('*')
        .gte('repaired_at', desdeIso).lt('repaired_at', hastaIso).not('repaired_by_email', 'is', null)
        .order('repaired_at', { ascending: false }).range(0, 4999);
      if (!vivo) return;
      if (error) { setErr('No se pudieron leer las reparaciones: ' + error.message); return; }
      setIncs((data || []) as Incidencia[]);
    })();
    return () => { vivo = false; };
  }, [desdeIso, hastaIso, recargarSignal]);

  // Rutas y visitas de Op. Bio Box.
  useEffect(() => {
    setRuta(null);
    if (!hayOpBiobox) return;
    let vivo = true;
    void (async () => {
      try {
        const rt = await sb.from('ruta_tecnicos').select('ruta_id,usuario_email');
        if (rt.error) throw rt.error;
        const rutasDe = new Map<string, number[]>();
        for (const x of (rt.data || []) as { ruta_id: number; usuario_email: string }[]) {
          const e = minus(x.usuario_email);
          rutasDe.set(e, [...(rutasDe.get(e) || []), x.ruta_id]);
        }
        const idsRutas = [...new Set([...rutasDe.values()].flat())];
        const paradas: Parada[] = [];
        for (const t of trozos(idsRutas, 100)) {
          const r = await sb.from('ruta_ubicaciones').select('ruta_id,site_id,estatus_archivo').in('ruta_id', t).range(0, 4999);
          if (r.error) throw r.error;
          paradas.push(...((r.data || []) as Parada[]));
        }
        const sitios = [...new Set(paradas.map((p) => p.site_id))];
        const visitas: VisitaPeriodo[] = [];
        const ultima = new Map<string, string>();
        const maquinas = new Map<string, string>();
        for (const t of trozos(sitios, 150)) {
          const [mv, rv, rm, uv, inv] = await Promise.all([
            sb.from('maquina_visitas').select('site_id,usuario_email,visitado_en').in('site_id', t).gte('visitado_en', desdeIso).lt('visitado_en', hastaIso).range(0, 4999),
            sb.from('revisiones').select('site_id,revisado_por,revisado_en').in('site_id', t).gte('revisado_en', desdeIso).lt('revisado_en', hastaIso).range(0, 4999),
            sb.from('ruta_visitas').select('site_id,usuario_email,visitado_en').in('site_id', t).gte('visitado_en', desdeIso).lt('visitado_en', hastaIso).range(0, 4999),
            sb.from('vw_maquina_ultima_visita').select('site_id,visitado_en').in('site_id', t),
            sb.from('inventario').select('site_id,site_legacy_id').in('site_id', t),
          ]);
          for (const r of [mv, rv, rm, uv, inv]) if (r.error) throw r.error;
          for (const v of (mv.data || []) as { site_id: string; usuario_email: string; visitado_en: string }[]) visitas.push({ ...v, tipo: 'rapida' });
          for (const v of (rv.data || []) as { site_id: string; revisado_por: string; revisado_en: string }[])
            visitas.push({ site_id: v.site_id, usuario_email: v.revisado_por || '', visitado_en: v.revisado_en, tipo: 'revision' });
          for (const v of (rm.data || []) as { site_id: string; usuario_email: string; visitado_en: string }[]) visitas.push({ ...v, tipo: 'monitoreo' });
          for (const u of (uv.data || []) as { site_id: string; visitado_en: string }[]) ultima.set(u.site_id, u.visitado_en);
          for (const m of (inv.data || []) as { site_id: string; site_legacy_id: string | null }[]) if (m.site_legacy_id) maquinas.set(m.site_id, m.site_legacy_id);
        }
        // La última visita también puede ser de este periodo (monitoreo incluido).
        for (const v of visitas) if (!ultima.get(v.site_id) || v.visitado_en > ultima.get(v.site_id)!) ultima.set(v.site_id, v.visitado_en);
        if (vivo) setRuta({ rutasDe, paradas, visitas, ultima, maquinas });
      } catch (e) {
        if (vivo) setErr('No se pudieron leer rutas y visitas: ' + ((e as Error).message || String(e)));
      }
    })();
    return () => { vivo = false; };
  }, [desdeIso, hastaIso, hayOpBiobox, recargarSignal]);

  const unidades = useMemo(() => [...new Set(todosTecnicos.flatMap((t) => t.unidades))].filter((u) => u !== 'Todas').sort(), [todosTecnicos]);
  const areas = useMemo(() => [...new Set(todosTecnicos.flatMap((t) => t.areas))].sort(), [todosTecnicos]);
  const tecnicos = useMemo(
    () => tecnicosDe(personas || [], fUnidad === 'Todas' ? null : fUnidad, fArea === 'Todas' ? null : fArea),
    [personas, fUnidad, fArea]
  );
  const quien = (e: string) => nombreDe(nombres, e);
  const rep = useMemo(() => reparacionesPorTecnico(incs || []), [incs]);
  const avance = useMemo(
    () => (ruta ? avancePorTecnico(ruta.rutasDe, ruta.paradas, ruta.visitas, ruta.ultima) : new Map<string, AvanceRuta>()),
    [ruta]
  );
  const visitaPeriodo = useMemo(() => {
    const m = new Map<string, VisitaPeriodo>();
    for (const v of ruta?.visitas || []) { const a = m.get(v.site_id); if (!a || v.visitado_en > a.visitado_en) m.set(v.site_id, v); }
    return m;
  }, [ruta]);
  const nombreMaq = (s: string) => nombreCortoMaquina(s, ruta?.maquinas.get(s));
  const deOpBiobox = (t: { areas: string[] }) => t.areas.some((a) => minus(a) === OP_BIOBOX);

  if (err) return <div className="err">{err}</div>;
  if (!personas) return <div className="loading">Cargando técnicos…</div>;

  const selector = (
    <div className="toolbar filtros-pildora" style={{ marginBottom: 14 }}>
      {/* Orden de Erik (18-nov-2026): unidad, semana o mes, el periodo y el área. */}
      {esJefe && unidades.length > 1 && (
        <select className={fUnidad !== 'Todas' ? 'on' : undefined} value={fUnidad} onChange={(e) => setFUnidad(e.target.value)} aria-label="Unidad">
          <option value="Todas">Unidad: todas</option>
          {unidades.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      )}
      <div className="segmento" role="group" aria-label="Ver por">
        <button type="button" aria-pressed={tipo === 'semana'} onClick={() => { setTipo('semana'); setPerSel(''); }}>Semana</button>
        <button type="button" aria-pressed={tipo === 'mes'} onClick={() => { setTipo('mes'); setPerSel(''); }}>Mes</button>
      </div>
      <select className="on" value={periodo.clave} onChange={(e) => setPerSel(e.target.value)} aria-label={tipo === 'semana' ? 'Semana' : 'Mes'}>
        {periodos.map((x) => <option key={x.clave} value={x.clave}>{x.etiqueta}</option>)}
      </select>
      {esJefe && areas.length > 1 && (
        <select className={fArea !== 'Todas' ? 'on' : undefined} value={fArea} onChange={(e) => setFArea(e.target.value)} aria-label="Área">
          <option value="Todas">Área: todas</option>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      )}
    </div>
  );

  if (!incs) return <>{selector}<div className="loading">Cargando reparaciones…</div></>;

  const abrirReparadas = (e: string) => {
    const x = rep.get(e);
    if (x) setDetalleInc({ titulo: `Reparadas por ${quien(e)}`, items: x.reparadas as Incidencia[] });
  };
  const detalleModales = (
    <>
      {detalleInc && (
        <KpiDetalleModal titulo={detalleInc.titulo} subtitulo={periodo.etiqueta}
          items={detalleInc.items} corteInicial="incidencia" onClose={() => setDetalleInc(null)} />
      )}
      {detalleRuta && avance.get(detalleRuta) && ruta && (
        <DetalleRuta titulo={`Ruta de ${quien(detalleRuta)}`} avance={avance.get(detalleRuta)!} nombreMaq={nombreMaq}
          ultima={ruta.ultima} visitaPeriodo={visitaPeriodo} quien={quien} enPeriodo={enPeriodo} onClose={() => setDetalleRuta(null)} />
      )}
    </>
  );

  // ── El técnico: solo lo suyo ──
  if (!esJefe) {
    const mio = rep.get(yo);
    const miRuta = avance.get(yo);
    const soyOp = todosTecnicos.some(deOpBiobox);
    return (
      <div>
        <p className="phint">Tus números {enPeriodo === 'en la semana' ? 'de la semana' : 'del mes'}. Solo los ves tú, tu coordinador y el manager.</p>
        {selector}
        <div className="cards">
          <Numero n={mio?.reparadas.length ?? 0} l="Reparaste" onAbrir={mio?.reparadas.length ? () => abrirReparadas(yo) : undefined} />
          <Numero n={mio?.medianaH == null ? '—' : fmtHoras(mio.medianaH)} l="Tiempo de reparación (mediana)" />
          <Numero n={mio?.rechazadas.length ?? 0} l="Te rechazaron" color={mio?.rechazadas.length ? 'var(--warn)' : undefined}
            onAbrir={mio?.rechazadas.length ? () => setDetalleInc({ titulo: 'Reparaciones rechazadas', items: mio.rechazadas as Incidencia[] }) : undefined} />
          <Numero n={mio?.apoyos.length ?? 0} l="Apoyaste" onAbrir={mio?.apoyos.length ? () => setDetalleInc({ titulo: 'Reparaciones en que apoyaste', items: mio.apoyos as Incidencia[] }) : undefined} />
        </div>
        {soyOp && (
          miRuta && miRuta.sitios.length ? (
            <div className="cards">
              <Numero n={`${pct(miRuta.visitados.length, miRuta.sitios.length)} %`} l={`Avance de tu ruta (${miRuta.visitados.length} de ${miRuta.sitios.length})`}
                color="var(--serie2)" onAbrir={() => setDetalleRuta(yo)} />
              <Numero n={miRuta.rapidas} l="Visitas rápidas" />
              <Numero n={miRuta.revisiones} l="Revisiones" />
              <Numero n={miRuta.sinVisita.length} l="Máquinas de tu ruta sin visita +14 días" color={miRuta.sinVisita.length ? 'var(--warn)' : undefined}
                onAbrir={() => setDetalleRuta(yo)} />
            </div>
          ) : (
            <div className="banner">{ruta ? 'No tienes ruta asignada.' : 'Cargando tu ruta…'}</div>
          )
        )}
        <p className="phint">El tiempo de reparación va desde que la incidencia llegó a tu área hasta que la reparaste.</p>
        {detalleModales}
      </div>
    );
  }

  // ── Manager y coordinadores ──
  const filas = tecnicos.map((t) => ({ t, r: rep.get(t.email), a: avance.get(t.email), op: deOpBiobox(t) }));
  const totalRep = filas.reduce((s, f) => s + (f.r?.reparadas.length || 0), 0);
  const todasReparadas = filas.flatMap((f) => f.r?.reparadas || []) as Incidencia[];
  const medTotal = mediana(
    todasReparadas
      .map((i) => (Date.parse(i.repaired_at || '') - Date.parse(i.sla_reparacion_inicio || '')) / 3600000)
      .filter((h) => Number.isFinite(h) && h >= 0)
  );
  const rechazadas = filas.flatMap((f) => f.r?.rechazadas || []) as Incidencia[];
  const conRuta = filas.filter((f) => f.op && f.a && f.a.sitios.length);
  const rutaHechos = conRuta.reduce((s, f) => s + f.a!.visitados.length, 0);
  const rutaTotal = conRuta.reduce((s, f) => s + f.a!.sitios.length, 0);
  const verOp = conRuta.length > 0 || filas.some((f) => f.op);
  const sinActividad = filas.filter((f) => !f.r?.reparadas.length && !f.r?.apoyos.length && !(f.a && (f.a.rapidas || f.a.revisiones))).length;

  return (
    <div>
      <p className="phint">Lo que hizo cada técnico {enPeriodo}. Cada técnico ve solo lo suyo.</p>
      {selector}
      <div className="cards cinco">
        <Numero n={tecnicos.length} l={`Técnicos (${sinActividad} sin actividad)`} />
        <Numero n={totalRep} l="Reparaciones" onAbrir={totalRep ? () => setDetalleInc({ titulo: `Reparaciones ${tipo === 'semana' ? 'de la semana' : 'del mes'}`, items: todasReparadas }) : undefined} />
        <Numero n={medTotal == null ? '—' : fmtHoras(medTotal)} l="Tiempo de reparación (mediana)" />
        <Numero n={rechazadas.length} l="Con reparación rechazada" color={rechazadas.length ? 'var(--warn)' : undefined}
          onAbrir={rechazadas.length ? () => setDetalleInc({ titulo: 'Reparaciones rechazadas', items: rechazadas }) : undefined} />
        {verOp
          ? <Numero n={`${pct(rutaHechos, rutaTotal)} %`} l={`Avance de rutas Op. Bio Box (${rutaHechos} de ${rutaTotal})`} color="var(--serie2)" />
          : <Numero n={filas.reduce((s, f) => s + (f.r?.apoyos.length || 0), 0)} l="Apoyos" />}
      </div>

      <Tarjeta titulo="Reparaciones por técnico" nota="Número de reparaciones y, al lado, su mediana. Toca un técnico para ver lo que reparó; los que no repararon nada están en la tabla de abajo.">
        <Barras
          data={filas
            .map((f) => ({ clave: f.t.email, etiqueta: f.t.nombre, n: f.r?.reparadas.length || 0, extra: f.r?.medianaH != null ? `· ${fmtHoras(f.r.medianaH)}` : undefined }))
            // Los que no repararon nada van en la tabla, no como barras vacías.
            .filter((d) => d.n > 0)
            .sort((a, b) => b.n - a.n || a.etiqueta.localeCompare(b.etiqueta))}
          color="var(--accent2)" onAbrir={abrirReparadas}
        />
      </Tarjeta>

      {verOp && (
        <Tarjeta titulo={`Avance de su ruta ${enPeriodo} (Op. Bio Box)`}
          nota={`Una máquina cuenta como visitada si alguien la visitó ${enPeriodo} (Mis rutas, visita rápida o revisión), como en Rutas › Avance de visitas. Toca un técnico para ver sus máquinas.`}>
          {ruta ? (
            <Medidores
              data={conRuta
                .map((f) => ({ clave: f.t.email, etiqueta: f.t.nombre, hechos: f.a!.visitados.length, total: f.a!.sitios.length }))
                .sort((a, b) => pct(a.hechos, a.total) - pct(b.hechos, b.total))}
              onAbrir={setDetalleRuta}
            />
          ) : <div className="loading">Cargando rutas…</div>}
        </Tarjeta>
      )}

      <Tarjeta titulo="Por técnico">
        <div style={{ overflowX: 'auto' }}>
          {/* La app parte palabras en cualquier letra (overflow-wrap: anywhere);
              aquí los títulos solo se cortan en los espacios y, si no caben,
              la tabla se desplaza de lado. */}
          <table className="tabla" style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', overflowWrap: 'normal', wordBreak: 'normal' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                <th style={{ padding: '6px 8px' }}>Técnico</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Reparó</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Mediana</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Rechazadas</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Apoyó</th>
                {verOp && <>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Visitas rápidas</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Revisiones</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Ruta</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Sin visita +14 d</th>
                </>}
              </tr>
            </thead>
            <tbody>
              {[...filas].sort((a, b) => (b.r?.reparadas.length || 0) - (a.r?.reparadas.length || 0) || a.t.nombre.localeCompare(b.t.nombre)).map((f) => (
                <tr key={f.t.email} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '6px 8px' }}>
                    {f.t.nombre}
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{f.t.areas.join(', ') || '—'}</div>
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    {f.r?.reparadas.length ? <button type="button" className="btn ghost sm" onClick={() => abrirReparadas(f.t.email)}>{f.r.reparadas.length}</button> : 0}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>{f.r?.medianaH == null ? '—' : fmtHoras(f.r.medianaH)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{f.r?.rechazadas.length || 0}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{f.r?.apoyos.length || 0}</td>
                  {verOp && <>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{f.op ? f.a?.rapidas ?? 0 : '—'}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{f.op ? f.a?.revisiones ?? 0 : '—'}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {f.op && f.a?.sitios.length
                        ? <button type="button" className="btn ghost sm" onClick={() => setDetalleRuta(f.t.email)}>{f.a.visitados.length} de {f.a.sitios.length}</button>
                        : f.op ? 'Sin ruta' : '—'}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{f.op && f.a?.sitios.length ? f.a.sinVisita.length : '—'}</td>
                  </>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tarjeta>
      <p className="phint" style={{ marginTop: 10 }}>
        El tiempo de reparación va desde que la incidencia llegó al área del técnico hasta que la reparó (mediana).
      </p>
      {detalleModales}
    </div>
  );
}
