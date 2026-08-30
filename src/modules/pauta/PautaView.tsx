// ============================================================
// src/modules/pauta/PautaView.tsx
// Recorrido del monitorista: qué campaña va en cada cara de la ruta, cómo va
// el avance y cómo llegar.
//
// Vive aparte de RutasView a propósito. RutasView es ADMINISTRACIÓN de rutas
// (crear, editar, importar el trazo); esto es TRABAJO DE CAMPO sobre una
// catorcena concreta. Son audiencias y momentos distintos, y mezclarlos
// convertiría una vista ya larga en una pantalla imposible de usar en celular.
//
// La agrupación es por SITIO, con sus caras dentro: se navega al poste una
// vez, y ahí se necesita saber qué anuncio va en cada cara. Dos de cada tres
// sitios tienen más de una campaña.
// ============================================================
import { useState, useEffect, useMemo, useCallback } from 'react';
import { sb } from '../../lib/supabase';
import IrAqui from '../../components/IrAqui';
import { tramosGoogleMaps } from '../../lib/navegacion';
import ImportarPautaModal from './ImportarPautaModal';
import RegistrarTomaModal from './RegistrarTomaModal';
import type { PautaRuta } from '../../types/db';

/** Tope de filas: el límite duro de Supabase es 1000 por consulta. */
const PAGINA = 1000;

/** Colores del estado de avance. */
const COLOR_AVANCE: Record<string, string> = {
  PENDIENTE: 'var(--muted)',
  TOMADA: 'var(--warn)',
  COMPROBADA: 'var(--ok)',
};

/** Un sitio con todas sus caras de esta catorcena. */
type Sitio = {
  site_id: string;
  direccion: string | null;
  ruta_clave: string | null;
  ruta_numero: number | null;
  secuencia: number | null;
  lat: number | null;
  lng: number | null;
  navegable: boolean;
  caras: PautaRuta[];
  campanas: string[];
};

type Props = {
  /** coordinador/manager: puede importar la pauta. */
  puedeImportar: boolean;
  /** Correo del usuario, para firmar la evidencia que sube. */
  email: string;
};

function PautaView({ puedeImportar, email }: Props) {
  const [filas, setFilas] = useState<PautaRuta[]>([]);
  const [catorcenas, setCatorcenas] = useState<number[]>([]);
  const [catSel, setCatSel] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [importar, setImportar] = useState(false);
  /** Cara cuya toma se está registrando (abre el modal con cámara). */
  const [tomaDe, setTomaDe] = useState<PautaRuta | null>(null);

  // Filtros
  const [fRuta, setFRuta] = useState('Todas');
  const [fCampanas, setFCampanas] = useState<string[]>([]);
  const [fAvance, setFAvance] = useState('Todos');
  const [q, setQ] = useState('');

  /** Catorcenas disponibles. Se abre en la más reciente. */
  const cargarCatorcenas = useCallback(async () => {
    const { data, error } = await sb
      .from('pautas')
      .select('catorcena')
      .order('catorcena', { ascending: false });
    if (error) {
      setErr('catorcenas: ' + error.message);
      setLoading(false);
      return;
    }
    const cats = [
      ...new Set(((data as { catorcena: number }[]) || []).map((r) => r.catorcena)),
    ];
    setCatorcenas(cats);
    setCatSel((prev) => prev ?? cats[0] ?? null);
    if (cats.length === 0) setLoading(false);
  }, []);

  const cargar = useCallback(async (cat: number) => {
    setLoading(true);
    setErr('');
    // Paginado: una catorcena pasa de 1000 filas y Supabase corta ahí.
    let todas: PautaRuta[] = [];
    let desde = 0;
    for (;;) {
      const { data, error } = await sb
        .from('vw_pauta_ruta')
        .select('*')
        .eq('catorcena', cat)
        .order('ruta_numero', { ascending: true, nullsFirst: false })
        .order('secuencia', { ascending: true })
        .range(desde, desde + PAGINA - 1);
      if (error) {
        setErr('pauta: ' + error.message);
        setLoading(false);
        return;
      }
      const lote = (data as PautaRuta[]) || [];
      todas = todas.concat(lote);
      if (lote.length < PAGINA) break;
      desde += PAGINA;
      if (desde > 20000) break; // salvavidas
    }
    setFilas(todas);
    setLoading(false);
  }, []);

  useEffect(() => {
    cargarCatorcenas();
  }, [cargarCatorcenas]);

  useEffect(() => {
    if (catSel != null) cargar(catSel);
  }, [catSel, cargar]);

  // --- Catálogos derivados de los datos ---
  const rutas = useMemo(() => {
    const s = new Set(filas.map((f) => f.ruta_clave).filter(Boolean) as string[]);
    // Numéricas primero y en orden; las foráneas (PLAZA, EDOMEX) al final.
    return [...s].sort((a, b) => {
      const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
      if (na && nb) return Number(a) - Number(b);
      if (na) return -1;
      if (nb) return 1;
      return a.localeCompare(b);
    });
  }, [filas]);

  /** Campañas de la ruta seleccionada, con su conteo de caras. */
  const campanasRuta = useMemo(() => {
    const base =
      fRuta === 'Todas' ? filas : filas.filter((f) => f.ruta_clave === fRuta);
    const m = new Map<string, number>();
    base.forEach((f) => {
      if (f.campana) m.set(f.campana, (m.get(f.campana) || 0) + 1);
    });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [filas, fRuta]);

  // Cambiar de ruta invalida la selección de campañas: las de la ruta
  // anterior no existen aquí y dejarían la lista vacía sin explicación.
  useEffect(() => {
    setFCampanas([]);
  }, [fRuta]);

  const toggleCampana = (c: string) =>
    setFCampanas((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    );

  // --- Filtrado ---
  const visibles = useMemo(
    () =>
      filas.filter((f) => {
        if (fRuta !== 'Todas' && f.ruta_clave !== fRuta) return false;
        if (fCampanas.length && !fCampanas.includes(f.campana || ''))
          return false;
        if (fAvance !== 'Todos' && f.avance !== fAvance) return false;
        if (q) {
          const s =
            `${f.site_id} ${f.vendor_face_id} ${f.direccion} ${f.campana} ${f.version}`.toLowerCase();
          if (!s.includes(q.toLowerCase())) return false;
        }
        return true;
      }),
    [filas, fRuta, fCampanas, fAvance, q]
  );

  /** Agrupa las caras visibles por sitio, conservando el orden de recorrido. */
  const sitios = useMemo(() => {
    const m = new Map<string, Sitio>();
    visibles.forEach((f) => {
      let s = m.get(f.site_id);
      if (!s) {
        s = {
          site_id: f.site_id,
          direccion: f.direccion,
          ruta_clave: f.ruta_clave,
          ruta_numero: f.ruta_numero,
          secuencia: f.secuencia,
          lat: f.latitud,
          lng: f.longitud,
          navegable: f.navegable,
          caras: [],
          campanas: [],
        };
        m.set(f.site_id, s);
      }
      s.caras.push(f);
      if (f.campana && !s.campanas.includes(f.campana)) s.campanas.push(f.campana);
    });
    return [...m.values()].sort(
      (a, b) =>
        (a.ruta_numero ?? 9999) - (b.ruta_numero ?? 9999) ||
        (a.secuencia ?? 9999) - (b.secuencia ?? 9999) ||
        a.site_id.localeCompare(b.site_id)
    );
  }, [visibles]);

  /** Tramos de Google Maps para el recorrido filtrado. */
  const tramos = useMemo(
    () =>
      tramosGoogleMaps(
        sitios
          .filter((s) => s.navegable)
          .map((s) => ({
            lat: Number(s.lat),
            lng: Number(s.lng),
            nombre: s.site_id,
          }))
      ),
    [sitios]
  );

  const stats = useMemo(() => {
    const t = { total: visibles.length, pend: 0, tom: 0, comp: 0, sinCoord: 0 };
    visibles.forEach((f) => {
      if (f.avance === 'PENDIENTE') t.pend++;
      else if (f.avance === 'TOMADA') t.tom++;
      else t.comp++;
      if (!f.navegable) t.sinCoord++;
    });
    return t;
  }, [visibles]);

  // --- Acciones de campo ---
  /**
   * Registra la comprobación (entrega del trabajo). No lleva fotos: la
   * evidencia se capturó en la toma.
   */
  const comprobar = async (fila: PautaRuta) => {
    const { error } = await sb.rpc('registrar_comprobacion', {
      p_catorcena: fila.catorcena,
      p_vendor_face_id: fila.vendor_face_id,
    });
    if (error) {
      alert('No se pudo registrar: ' + error.message);
      return;
    }
    const ahora = new Date().toISOString();
    setFilas((prev) =>
      prev.map((f) =>
        f.vendor_face_id === fila.vendor_face_id
          ? { ...f, fecha_comprobacion: ahora, avance: 'COMPROBADA' }
          : f
      )
    );
  };

  /**
   * La toma quedó registrada en el modal. Se refleja en memoria para que el
   * avance se vea al instante, sin recargar toda la catorcena.
   */
  const tomaRegistrada = (vendorFaceId: string) => {
    const ahora = new Date().toISOString();
    setFilas((prev) =>
      prev.map((f) => {
        if (f.vendor_face_id !== vendorFaceId) return f;
        // La RPC no pisa una toma anterior: aquí se respeta igual.
        return {
          ...f,
          fecha_toma: f.fecha_toma || ahora,
          toma_por: f.toma_por || email,
          fotos: f.fotos + 1,
          avance: f.fecha_comprobacion ? 'COMPROBADA' : 'TOMADA',
        };
      })
    );
  };

  /**
   * `fecha_fijacion` es columna `date` y llega como "2026-08-04".
   * `new Date('2026-08-04')` es medianoche UTC: en México (UTC-6) el
   * toLocaleDateString la pintaba como "03 ago" — un día antes, siempre.
   * Las fechas-solas se anclan a mediodía LOCAL para que ningún huso las
   * mueva de día; los timestamptz (traen hora) siguen igual.
   */
  const fmt = (d: string | null) => {
    if (!d) return '';
    const soloFecha = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    const fecha = soloFecha
      ? new Date(+soloFecha[1], +soloFecha[2] - 1, +soloFecha[3], 12)
      : new Date(d);
    return fecha.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  };

  // --- Render ---
  if (loading) return <div className="loading">Cargando pauta…</div>;

  if (catorcenas.length === 0)
    return (
      <>
        <h2 className="page">Pauta y monitoreo</h2>
        <p className="phint">Campañas por ruta y avance de campo.</p>
        {err && <div className="err">{err}</div>}
        <div className="empty">
          Todavía no hay ninguna catorcena cargada.
          {puedeImportar ? (
            <div style={{ marginTop: 14 }}>
              <button className="btn" onClick={() => setImportar(true)}>
                📥 Importar pauta
              </button>
            </div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              Pide a un coordinador que importe el archivo de la catorcena.
            </div>
          )}
        </div>
        {importar && (
          <ImportarPautaModal
            onClose={() => setImportar(false)}
            onImportado={() => {
              cargarCatorcenas();
              if (catSel != null) cargar(catSel);
            }}
          />
        )}
      </>
    );

  return (
    <>
      <h2 className="page">Pauta y monitoreo</h2>
      <p className="phint">
        Qué campaña va en cada cara, cómo va el avance y cómo llegar.
      </p>
      {err && <div className="err">{err}</div>}

      <div className="toolbar">
        <select
          value={catSel ?? ''}
          onChange={(e) => setCatSel(Number(e.target.value))}
        >
          {catorcenas.map((c) => (
            <option key={c} value={c}>
              Catorcena {c}
            </option>
          ))}
        </select>
        <select value={fRuta} onChange={(e) => setFRuta(e.target.value)}>
          <option value="Todas">Ruta: todas</option>
          {rutas.map((r) => (
            <option key={r} value={r}>
              {/^\d+$/.test(r) ? `Ruta ${r}` : r}
            </option>
          ))}
        </select>
        <select value={fAvance} onChange={(e) => setFAvance(e.target.value)}>
          <option value="Todos">Avance: todos</option>
          <option value="PENDIENTE">Pendientes</option>
          <option value="TOMADA">Tomadas</option>
          <option value="COMPROBADA">Comprobadas</option>
        </select>
        <input
          className="search"
          placeholder="Buscar sitio, cara, campaña…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {puedeImportar && (
          <button className="btn ghost sm" onClick={() => setImportar(true)}>
            📥 Importar
          </button>
        )}
      </div>

      {/* Campañas de la ruta: el filtro principal del monitorista. */}
      {campanasRuta.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
            Campañas en {fRuta === 'Todas' ? 'la catorcena' : `la ruta ${fRuta}`}{' '}
            ({campanasRuta.length}) — toca para filtrar
          </div>
          <div className="chips">
            {/* "Toca para filtrar" es LA interacción de esta vista: son
                botones con altura táctil real, no pills de 24px que en un
                teléfono se fallaban con el dedo. */}
            {campanasRuta.map(([c, n]) => {
              const on = fCampanas.includes(c);
              return (
                <button
                  type="button"
                  key={c}
                  onClick={() => toggleCampana(c)}
                  className="pill"
                  style={{
                    cursor: 'pointer',
                    border: 'none',
                    font: 'inherit',
                    fontSize: 12,
                    fontWeight: 700,
                    padding: '8px 12px',
                    minHeight: 36,
                    background: on ? 'var(--accent)' : '#252b35',
                    color: on ? '#151515' : 'var(--muted)',
                    whiteSpace: 'normal',
                    textAlign: 'left',
                  }}
                >
                  {c} · {n}
                </button>
              );
            })}
            {fCampanas.length > 0 && (
              <button
                type="button"
                onClick={() => setFCampanas([])}
                className="pill"
                style={{
                  cursor: 'pointer',
                  font: 'inherit',
                  fontSize: 12,
                  fontWeight: 700,
                  padding: '8px 12px',
                  minHeight: 36,
                  background: 'transparent',
                  color: 'var(--muted)',
                  border: '1px solid var(--line)',
                }}
              >
                ✕ limpiar
              </button>
            )}
          </div>
        </div>
      )}

      <div className="cards">
        <div className="card">
          <div className="n">{sitios.length}</div>
          <div className="l">Sitios</div>
        </div>
        <div className="card">
          <div className="n">{stats.total}</div>
          <div className="l">Caras</div>
        </div>
        <div className="card">
          <div className="n" style={{ color: COLOR_AVANCE.TOMADA }}>
            {stats.pend}
          </div>
          <div className="l">Pendientes</div>
        </div>
        <div className="card">
          <div className="n" style={{ color: COLOR_AVANCE.COMPROBADA }}>
            {stats.comp}
          </div>
          <div className="l">Comprobadas</div>
        </div>
      </div>

      {/* Navegación del recorrido filtrado, por tramos de 10 paradas. */}
      {tramos.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: 14,
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {tramos.length === 1
              ? 'Navegar el recorrido:'
              : `Navegar por tramos (${tramos.length}):`}
          </span>
          {tramos.map((t) => (
            <a
              key={t.desde}
              className="btn sm"
              href={t.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: 'none' }}
            >
              🗺️{' '}
              {tramos.length === 1
                ? 'Abrir en Google Maps'
                : `Paradas ${t.desde}–${t.hasta}`}
            </a>
          ))}
          {stats.sinCoord > 0 && (
            <span
              className="pill"
              style={{ background: '#f59e0b22', color: '#f59e0b' }}
              title="Sin coordenadas en inventario: no se puede navegar"
            >
              ⚠ {stats.sinCoord} sin ubicación
            </span>
          )}
        </div>
      )}

      {sitios.length === 0 ? (
        <div className="empty">Sin resultados con estos filtros.</div>
      ) : (
        <div className="inc-list">
          {sitios.map((s) => (
            <div key={s.site_id} className="inc">
              <div className="inc-top">
                <div>
                  <div className="folio">
                    {s.ruta_clave
                      ? /^\d+$/.test(s.ruta_clave)
                        ? `Ruta ${s.ruta_clave}`
                        : s.ruta_clave
                      : 'Sin ruta'}
                    {s.secuencia != null ? ` · secuencia ${s.secuencia}` : ''}
                  </div>
                  <div className="titulo">{s.site_id}</div>
                  <div className="meta">{s.direccion || '(sin dirección)'}</div>
                </div>
                <IrAqui
                  destino={{ lat: s.lat, lng: s.lng, nombre: s.site_id }}
                />
              </div>

              {!s.navegable && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--warn)',
                    marginTop: 6,
                  }}
                >
                  ⚠ Sin coordenadas en inventario — guíate por la dirección.
                </div>
              )}

              {/* Las caras: es lo que el monitorista necesita AL LLEGAR. */}
              <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                {s.caras.map((f) => (
                  <div
                    key={f.id}
                    style={{
                      background: 'var(--panel2)',
                      border: '1px solid var(--line)',
                      borderRadius: 9,
                      padding: '9px 11px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                          Cara {f.cara || '—'} · {f.campana || '(sin campaña)'}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--muted)',
                            marginTop: 2,
                            lineHeight: 1.5,
                          }}
                        >
                          {f.version && <>Arte: {f.version}<br /></>}
                          {f.campana_anterior && (
                            <>Antes: {f.campana_anterior}<br /></>
                          )}
                          {f.medio}
                          {f.fecha_fijacion && ` · fija ${fmt(f.fecha_fijacion)}`}
                        </div>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          gap: 5,
                          flexWrap: 'wrap',
                          alignItems: 'flex-start',
                        }}
                      >
                        {f.estatus && (
                          <span
                            className="pill"
                            style={{
                              background:
                                f.estatus === 'NUEVO'
                                  ? '#4f8cff22'
                                  : '#98a1af22',
                              color:
                                f.estatus === 'NUEVO' ? '#4f8cff' : 'var(--muted)',
                            }}
                          >
                            {f.estatus}
                          </span>
                        )}
                        <span
                          className="pill"
                          style={{
                            background: COLOR_AVANCE[f.avance] + '22',
                            color: COLOR_AVANCE[f.avance],
                          }}
                        >
                          {f.avance === 'PENDIENTE'
                            ? 'Pendiente'
                            : f.avance === 'TOMADA'
                              ? `Tomada ${fmt(f.fecha_toma)}`
                              : `Comprobada ${fmt(f.fecha_comprobacion)}`}
                        </span>
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        gap: 6,
                        flexWrap: 'wrap',
                        marginTop: 8,
                      }}
                    >
                      {/* Mismo patrón que Incidencias: la acción abre un
                          modal con cámara y galería, no guarda a ciegas. */}
                      <button
                        className={f.fecha_toma ? 'btn ghost sm' : 'btn sm'}
                        onClick={() => setTomaDe(f)}
                      >
                        📷{' '}
                        {f.fecha_toma
                          ? `Evidencia${f.fotos ? ` (${f.fotos})` : ''}`
                          : 'Registrar toma'}
                      </button>
                      {f.fecha_toma && !f.fecha_comprobacion && (
                        <button
                          className="btn ok sm"
                          onClick={() => comprobar(f)}
                        >
                          ✓ Comprobar
                        </button>
                      )}
                      {f.fecha_comprobacion && f.comprobacion_por && (
                        <span
                          style={{ fontSize: 11, color: 'var(--muted)' }}
                        >
                          Entregó {f.comprobacion_por.split('@')[0]}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {tomaDe && (
        <RegistrarTomaModal
          fila={tomaDe}
          email={email}
          onClose={() => setTomaDe(null)}
          onRegistrada={tomaRegistrada}
        />
      )}

      {importar && (
        <ImportarPautaModal
          onClose={() => setImportar(false)}
          onImportado={() => {
            cargarCatorcenas();
            if (catSel != null) cargar(catSel);
          }}
        />
      )}
    </>
  );
}

export default PautaView;
