// ============================================================
// src/modules/biobox/BioboxView.tsx
// Máquinas por ruta: a dónde ir, cómo llegar, y en qué estado quedó cada una.
//
// Es el hermano de PautaView, pero el trabajo de campo es distinto: allá se
// va a fotografiar una campaña, aquí a revisar una máquina contra un
// checklist. Comparte deliberadamente la forma —selector de ruta, tramos de
// navegación, tarjeta por parada— porque es la misma gente en la calle.
//
// EL ORDEN DE LA LISTA NO ES ALFABÉTICO NI POR SECUENCIA POR DEFAULT: manda
// lo que lleva más tiempo sin revisarse, y las que nunca se han revisado van
// primero. Ordenar por secuencia sirve para recorrer la ruta; ordenar por
// abandono sirve para decidir a qué ruta ir. Se puede cambiar con el selector.
//
// Las rutas se dan de alta importando el KML del mapa de My Maps, desde
// Rutas de Monitoreo. Aquí solo se consumen.
// ============================================================
import { useState, useEffect, useMemo } from 'react';
import { sb } from '../../lib/supabase';
import IrAqui from '../../components/IrAqui';
import { resumenMaquinas, HORAS_ALARMA } from '../../lib/estadoMaquina';
import type { MapaResumen } from '../../lib/estadoMaquina';
import { fmtHoras } from '../../lib/helpers';
import { tramosGoogleMaps } from '../../lib/navegacion';
import { UNIDADES_BIOBOX } from '../../lib/constants';
import RevisionModal from './RevisionModal';
import HistorialModal from './HistorialModal';
import ChecklistConfigModal from './ChecklistConfigModal';
import type { UbicacionRevision } from '../../types/db';

type Props = {
  email: string;
  misDep: string[];
  puedeConfigurar: boolean;
};

type Orden = 'abandono' | 'secuencia' | 'nombre';

/** A partir de aquí se considera que la máquina ya toca revisarse. */
const DIAS_VENCIDO = 30;

const COLOR_ESTADO: Record<string, string> = {
  operando: 'var(--ok)',
  con_falla: '#f59e0b',
  fuera_de_linea: 'var(--bad)',
};

const LABEL_ESTADO: Record<string, string> = {
  operando: 'Operando',
  con_falla: 'Con falla',
  fuera_de_linea: 'Fuera de línea',
};

/** Nombre con el que se agrupa la ruta. Ver la nota de `rutaFoco`. */
function nombreRuta(u: UbicacionRevision): string {
  return u.ruta_nombre || `Ruta ${u.ruta_numero}`;
}

function BioboxView({ email, misDep, puedeConfigurar }: Props) {
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState('');
  const [ubics, setUbics] = useState<UbicacionRevision[]>([]);

  const [unidad, setUnidad] = useState(UNIDADES_BIOBOX[0] || 'Biobox');
  // Filtro de medio para la LISTA, no para la carga. Se traen los dos.
  const [medio, setMedio] = useState<'todos' | 'Digital' | 'Impreso'>('todos');
  /**
   * Ruta en foco. Es el NOMBRE, no el id.
   *
   * Una ruta del mapa puede estar partida en dos filas de `rutas_monitoreo`
   * —una Digital y una Impreso— porque el trigger de segmento no admite
   * rutas mixtas. Para el monitorista eso es una sola ruta: la que camina.
   */
  const [rutaFoco, setRutaFoco] = useState<string | null>(null);
  const [orden, setOrden] = useState<Orden>('abandono');
  const [busca, setBusca] = useState('');
  const [soloPendientes, setSoloPendientes] = useState(false);

  /**
   * Lo que cada máquina trae abierto. Se pide con UNA sola llamada para toda
   * la lista, no una por máquina: son doscientas y el distintivo tardaría más
   * en aparecer que la lista completa.
   */
  const [estado, setEstado] = useState<MapaResumen>({});

  const [revisando, setRevisando] = useState<UbicacionRevision | null>(null);
  const [historial, setHistorial] = useState<UbicacionRevision | null>(null);
  const [configurando, setConfigurando] = useState(false);

  const cargar = async () => {
    setCargando(true);
    setErr('');
    const { data, error } = await sb
      .from('vw_revision_ubicaciones')
      .select('*')
      .eq('unidad_negocio', unidad);
    if (error) setErr('No se pudieron cargar las máquinas: ' + error.message);
    else setUbics((data as UbicacionRevision[]) || []);
    setCargando(false);

    // Después de pintar la lista, no antes. Si esto tardara o fallara, la
    // lista ya está en pantalla y utilizable: `resumenMaquinas` nunca lanza y
    // devuelve un mapa vacío, así que lo único que se pierde es el adorno.
    const ids = [
      ...new Set(
        ((data as UbicacionRevision[]) || []).map((u) => u.site_id).filter(Boolean)
      ),
    ] as string[];
    setEstado(await resumenMaquinas(ids));
  };

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unidad]);

  // --- Rutas presentes en lo cargado ---
  // Se agrupa por NOMBRE, no por ruta_id: ver la nota de `rutaFoco`.
  const rutas = useMemo(() => {
    const m = new Map<
      string,
      { nombre: string; color: string; total: number; pend: number }
    >();
    ubics.forEach((u) => {
      const nombre = nombreRuta(u);
      const r = m.get(nombre) || {
        nombre,
        color: u.ruta_color,
        total: 0,
        pend: 0,
      };
      r.total++;
      if (u.dias_sin_revision == null || u.dias_sin_revision >= DIAS_VENCIDO)
        r.pend++;
      m.set(nombre, r);
    });
    return [...m.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [ubics]);

  // --- Filtro + orden ---
  const visibles = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const arr = ubics
      .filter((u) => rutaFoco == null || nombreRuta(u) === rutaFoco)
      .filter((u) => medio === 'todos' || u.medio === medio)
      .filter(
        (u) =>
          !soloPendientes ||
          u.dias_sin_revision == null ||
          u.dias_sin_revision >= DIAS_VENCIDO
      )
      .filter(
        (u) =>
          !q ||
          (u.site_legacy_id || '').toLowerCase().includes(q) ||
          (u.direccion || '').toLowerCase().includes(q) ||
          u.site_id.toLowerCase().includes(q)
      );

    const cmp: Record<Orden, (a: UbicacionRevision, b: UbicacionRevision) => number> =
      {
        // Nunca revisadas primero (dias null → +Infinito), luego las más viejas.
        abandono: (a, b) =>
          (b.dias_sin_revision ?? Number.MAX_SAFE_INTEGER) -
          (a.dias_sin_revision ?? Number.MAX_SAFE_INTEGER),
        secuencia: (a, b) =>
          (a.secuencia ?? 9999) - (b.secuencia ?? 9999) ||
          a.site_id.localeCompare(b.site_id),
        // `numeric: true` porque site_legacy_id es un número guardado como
        // texto: sin él el orden sería 1, 10, 100, 116, 2, 46.
        nombre: (a, b) =>
          (a.site_legacy_id || a.site_id).localeCompare(
            b.site_legacy_id || b.site_id,
            undefined,
            { numeric: true }
          ),
      };
    return [...arr].sort(cmp[orden]);
  }, [ubics, rutaFoco, busca, soloPendientes, orden, medio]);

  // --- Indicadores ---
  const kpi = useMemo(() => {
    const base = (
      rutaFoco == null ? ubics : ubics.filter((u) => nombreRuta(u) === rutaFoco)
    ).filter((u) => medio === 'todos' || u.medio === medio);
    return {
      total: base.length,
      nunca: base.filter((u) => u.dias_sin_revision == null).length,
      vencidas: base.filter(
        (u) => u.dias_sin_revision != null && u.dias_sin_revision >= DIAS_VENCIDO
      ).length,
      conAnomalia: base.filter((u) => (u.puntos_anomalia || 0) > 0).length,
      fuera: base.filter((u) => u.estado_maquina === 'fuera_de_linea').length,
      sinCoords: base.filter((u) => !u.navegable).length,
    };
  }, [ubics, rutaFoco, medio]);

  // --- Navegación por tramos ---
  // Google Maps aguanta 9 escalas por URL, así que una ruta de 22 máquinas se
  // parte en tramos encadenados: cada uno arranca donde terminó el anterior.
  //
  // Los tramos RESPETAN los filtros de la lista (si marcaste "solo las que
  // toca revisar", solo esas entran) pero SIEMPRE van en orden de secuencia,
  // no en el de la lista. Son cosas distintas: la lista se ordena por
  // abandono para decidir a dónde ir, y el recorrido se ordena por geografía
  // para no cruzar la ciudad de ida y vuelta.
  const tramos = useMemo(() => {
    if (rutaFoco == null) return [];
    const paradas = visibles
      .filter((u) => u.navegable)
      .slice()
      .sort(
        (a, b) =>
          (a.secuencia ?? 9999) - (b.secuencia ?? 9999) ||
          a.site_id.localeCompare(b.site_id)
      )
      .map((u) => ({
        lat: u.latitud as number,
        lng: u.longitud as number,
        nombre: u.site_legacy_id || u.site_id,
      }));
    return tramosGoogleMaps(paradas);
  }, [visibles, rutaFoco]);

  const tras = (siteId: string) => {
    // Se recarga en vez de parchear en memoria: la vista calcula
    // `dias_sin_revision` y el estado, y duplicar ese cálculo aquí es una
    // fuente segura de discrepancias.
    void siteId;
    cargar();
  };

  return (
    <div>
      <h2 className="page">Máquinas Biobox</h2>
      <p className="phint">
        Revisión de máquinas por ruta. La hoja de vida de cada una se arma con
        lo que se registra en cada visita.
      </p>

      <div className="toolbar">
        <span className="tag">Segmento:</span>
        {/* Sin width:'auto' inline: la clase .toolbar ya lo da en escritorio
            y en celular el inline anulaba el apilado a ancho completo de la
            media query, dejando el select truncado ("Digital e Imp…"). */}
        <select
          value={unidad}
          onChange={(e) => {
            setUnidad(e.target.value);
            setRutaFoco(null);
          }}
        >
          {UNIDADES_BIOBOX.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <select
          value={medio}
          onChange={(e) =>
            setMedio(e.target.value as 'todos' | 'Digital' | 'Impreso')
          }
          title="Las rutas mezclan los dos: esto solo filtra la lista"
        >
          <option value="todos">Digital e Impreso</option>
          <option value="Digital">Solo Digital</option>
          <option value="Impreso">Solo Impreso</option>
        </select>
        <button className="btn sm ghost" onClick={cargar} title="Recargar">
          ↻
        </button>
        {puedeConfigurar && (
          <button className="btn sm ghost" onClick={() => setConfigurando(true)}>
            ⚙️ Checklist
          </button>
        )}
      </div>

      {err && <div className="err">{err}</div>}

      {!cargando && ubics.length === 0 && !err && (
        <div className="banner" style={{ marginTop: 12 }}>
          No hay máquinas asignadas a rutas para {unidad}. Se dan de alta
          desde <b>Rutas de Monitoreo → Importar mapa (KML)</b>, con el
          archivo del mapa de My Maps.
        </div>
      )}

      {ubics.length > 0 && (
        <>
          {/* Indicadores */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))',
              gap: 9,
              margin: '14px 0',
            }}
          >
            {[
              ['Máquinas', kpi.total, 'var(--txt)'],
              ['Nunca revisadas', kpi.nunca, kpi.nunca ? 'var(--bad)' : 'var(--muted)'],
              [
                `+${DIAS_VENCIDO} días`,
                kpi.vencidas,
                kpi.vencidas ? '#f59e0b' : 'var(--muted)',
              ],
              [
                'Con anomalías',
                kpi.conAnomalia,
                kpi.conAnomalia ? '#f97316' : 'var(--muted)',
              ],
              [
                'Fuera de línea',
                kpi.fuera,
                kpi.fuera ? 'var(--bad)' : 'var(--muted)',
              ],
              ['Sin coordenadas', kpi.sinCoords, 'var(--muted)'],
            ].map(([t, n, c]) => (
              <div
                key={t as string}
                style={{
                  background: 'var(--panel2)',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: '10px 12px',
                  minWidth: 0,
                }}
              >
                <div style={{ fontSize: 22, fontWeight: 800, color: c as string }}>
                  {n as number}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {t as string}
                </div>
              </div>
            ))}
          </div>

          {/* Rutas */}
          <div
            style={{
              display: 'flex',
              gap: 7,
              flexWrap: 'wrap',
              marginBottom: 12,
            }}
          >
            <span
              className="tag"
              onClick={() => setRutaFoco(null)}
              style={{
                cursor: 'pointer',
                borderColor: rutaFoco == null ? 'var(--accent)' : 'var(--line)',
                color: rutaFoco == null ? 'var(--accent)' : 'var(--muted)',
              }}
            >
              Todas ({ubics.length})
            </span>
            {rutas.map((r) => (
              <span
                key={r.nombre}
                className="tag"
                onClick={() =>
                  setRutaFoco(rutaFoco === r.nombre ? null : r.nombre)
                }
                style={{
                  cursor: 'pointer',
                  borderColor: rutaFoco === r.nombre ? r.color : 'var(--line)',
                  color: rutaFoco === r.nombre ? r.color : 'var(--muted)',
                }}
                title={`${r.pend} por revisar de ${r.total}`}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: r.color,
                    marginRight: 5,
                  }}
                />
                {r.nombre} ({r.total})
                {r.pend > 0 && (
                  <b style={{ color: '#f59e0b' }}> · {r.pend}↻</b>
                )}
              </span>
            ))}
          </div>

          {/* Navegación de la ruta en foco */}
          {rutaFoco != null && tramos.length > 0 && (
            <div
              style={{
                background: 'var(--panel2)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '10px 12px',
                marginBottom: 12,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 7 }}>
                🧭 Recorrido de la ruta
                {tramos.length > 1 && (
                  <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                    {' '}
                    · {tramos.length} tramos (Google Maps admite 9 escalas por
                    enlace)
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                {tramos.map((t, i) => (
                  <a
                    key={i}
                    className="btn sm ghost"
                    href={t.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Tramo {i + 1} ({t.paradas.length})
                  </a>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                Los tramos van en el orden del mapa, aunque la lista de abajo
                esté ordenada por urgencia. Si filtras, solo entran las que
                queden.
              </div>
            </div>
          )}

          {/* Filtros de la lista */}
          <div className="toolbar">
            {/* className="search" y sin maxWidth: el tope de 280px inline
                impedía que la media query lo apilara a ancho completo y el
                placeholder de 38 caracteres salía cortado a la mitad. */}
            <input
              className="search"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por número, dirección o clave"
            />
            <select
              value={orden}
              onChange={(e) => setOrden(e.target.value as Orden)}
            >
              <option value="abandono">Ordenar: más urgente primero</option>
              <option value="secuencia">Ordenar: secuencia de la ruta</option>
              <option value="nombre">Ordenar: número de máquina</option>
            </select>
            <label
              style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 12 }}
            >
              <input
                type="checkbox"
                checked={soloPendientes}
                onChange={(e) => setSoloPendientes(e.target.checked)}
                style={{ width: 'auto' }}
              />
              Solo las que toca revisar
            </label>
            <span className="tag">{visibles.length} en lista</span>
          </div>

          {/* Lista */}
          <div style={{ display: 'grid', gap: 9, marginTop: 12 }}>
            {visibles.map((u) => {
              const nunca = u.dias_sin_revision == null;
              const vencida = !nunca && (u.dias_sin_revision as number) >= DIAS_VENCIDO;
              return (
                <div
                  key={u.ubicacion_id}
                  style={{
                    background: 'var(--panel2)',
                    border: '1px solid var(--line)',
                    borderLeft: `3px solid ${u.ruta_color}`,
                    borderRadius: 10,
                    padding: '11px 12px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      gap: 10,
                      alignItems: 'flex-start',
                      flexWrap: 'wrap',
                    }}
                  >
                    {/* `flex: 1` (base 0) dejaba que este bloque se encogiera
                        por debajo de su contenido, mientras el grupo de
                        botones —que NO encoge— se quedaba con casi todo el
                        ancho. En el celular la dirección terminaba en una
                        columna de una palabra por renglón.
                        Con una base de 220px, cuando no caben los dos, el
                        contenedor (que tiene flex-wrap) manda los botones al
                        renglón de abajo en vez de estrujar el texto. */}
                    <div style={{ minWidth: 0, flex: '1 1 220px' }}>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>
                        {u.site_legacy_id ? `#${u.site_legacy_id}` : u.site_id}
                        {u.secuencia != null && (
                          <span
                            style={{
                              fontWeight: 400,
                              fontSize: 11,
                              color: 'var(--muted)',
                            }}
                          >
                            {' '}
                            · parada {u.secuencia}
                          </span>
                        )}
                      </div>
                      {/* La clave completa (MX_CM_BB_MED_0122) en su propio
                          renglón: es como se identifica la máquina en
                          inventario e incidencias. */}
                      {u.site_legacy_id && (
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--muted)',
                            marginTop: 1,
                          }}
                        >
                          {u.site_id}
                        </div>
                      )}
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--muted)',
                          marginTop: 2,
                        }}
                      >
                        {u.direccion || '(sin dirección)'}
                        {u.municipio ? ` · ${u.municipio}` : ''}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          gap: 6,
                          flexWrap: 'wrap',
                          marginTop: 7,
                        }}
                      >
                        <span
                          className="tag"
                          style={{ color: u.ruta_color, borderColor: u.ruta_color }}
                        >
                          {nombreRuta(u)}
                        </span>

                        {u.medio && (
                          <span
                            className="tag"
                            title={u.tipo_mueble || ''}
                          >
                            {u.medio}
                            {u.tipo_mueble ? ` · ${u.tipo_mueble}` : ''}
                          </span>
                        )}

                        {nunca ? (
                          <span
                            className="tag"
                            style={{
                              color: 'var(--bad)',
                              borderColor: 'var(--bad)',
                            }}
                          >
                            nunca revisada
                          </span>
                        ) : (
                          <span
                            className="tag"
                            style={{
                              color: vencida ? '#f59e0b' : 'var(--ok)',
                              borderColor: vencida ? '#f59e0b' : 'var(--ok)',
                            }}
                          >
                            hace {u.dias_sin_revision} día
                            {u.dias_sin_revision === 1 ? '' : 's'}
                          </span>
                        )}

                        {u.estado_maquina && (
                          <span
                            className="tag"
                            style={{
                              color: COLOR_ESTADO[u.estado_maquina] || 'var(--muted)',
                              borderColor:
                                COLOR_ESTADO[u.estado_maquina] || 'var(--line)',
                            }}
                          >
                            {LABEL_ESTADO[u.estado_maquina] || u.estado_maquina}
                          </span>
                        )}

                        {(u.puntos_anomalia || 0) > 0 && (
                          <span
                            className="tag"
                            style={{
                              color: '#f97316',
                              borderColor: '#f97316',
                            }}
                          >
                            {u.puntos_anomalia} anomalía
                            {u.puntos_anomalia === 1 ? '' : 's'}
                          </span>
                        )}

                        {/* LO QUE LA MÁQUINA TRAE ABIERTO. Aquí y no solo
                            dentro de Revisar: el operador lo ve ANTES de
                            bajarse del carro, y si va de paso sin revisar,
                            igual se entera. */}
                        {(() => {
                          const e = estado[u.site_id];
                          if (!e) return null;
                          const alarma = (e.horas_peor ?? 0) > HORAS_ALARMA;
                          return (
                            <span
                              className="tag"
                              style={{
                                color: alarma ? '#ef4444' : '#f97316',
                                borderColor: alarma ? '#ef4444' : '#f97316',
                                fontWeight: alarma ? 700 : 400,
                                /* Frase larga en un .tag (que apaga el
                                   quiebre de palabra): sin esto, un nombre
                                   de área largo desbordaba la tarjeta y se
                                   recortaba justo lo que el operador debe
                                   leer antes de bajarse del carro. */
                                maxWidth: '100%',
                                whiteSpace: 'normal',
                                overflowWrap: 'anywhere',
                              }}
                              title={
                                'Abiertas: ' + e.abiertas +
                                (e.areas ? ' · Áreas: ' + e.areas : '') +
                                (e.horas_peor != null
                                  ? ' · La peor lleva ' + fmtHoras(e.horas_peor)
                                  : '')
                              }
                            >
                              {alarma ? '🔴' : '⚠'} {e.abiertas} abierta
                              {e.abiertas === 1 ? '' : 's'}
                              {e.horas_peor != null
                                ? ' · ' + fmtHoras(e.horas_peor)
                                : ''}
                              {/* Las áreas van EN el texto y no solo en el
                                  title: los tooltips no existen en táctil y
                                  el monitorista es usuario de celular. */}
                              {e.areas ? ' · ' + e.areas : ''}
                            </span>
                          );
                        })()}

                        {!u.navegable && (
                          <span className="tag" title="No hay coordenadas en inventario">
                            sin coordenadas
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Sin flexShrink:0: con él, el grupo no podía bajar de
                        su max-content (~291px) y en pantallas de 320px o con
                        fuente grande el botón "✅ Revisar" —la acción
                        principal— se salía y se recortaba sin scroll. El
                        flexWrap ya acomoda los botones en dos renglones. */}
                    <div
                      style={{
                        display: 'flex',
                        gap: 6,
                        minWidth: 0,
                        flexWrap: 'wrap',
                      }}
                    >
                      <IrAqui
                        destino={{
                          lat: u.latitud,
                          lng: u.longitud,
                          nombre: u.site_legacy_id || u.direccion || u.site_id,
                        }}
                      />
                      <button
                        className="btn ghost sm"
                        onClick={() => setHistorial(u)}
                        title="Hoja de vida de esta máquina"
                      >
                        📖 Historial
                      </button>
                      <button className="btn sm" onClick={() => setRevisando(u)}>
                        ✅ Revisar
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {visibles.length === 0 && !cargando && (
              <div className="banner">
                Nada coincide con el filtro.
                {soloPendientes && ' Todas las máquinas están revisadas al día.'}
              </div>
            )}
          </div>
        </>
      )}

      {cargando && (
        <div style={{ padding: '18px 0', fontSize: 13, color: 'var(--muted)' }}>
          Cargando máquinas…
        </div>
      )}

      {revisando && (
        <RevisionModal
          ubic={revisando}
          email={email}
          misDep={misDep}
          onClose={() => setRevisando(null)}
          onGuardada={tras}
        />
      )}

      {historial && (
        <HistorialModal
          siteId={historial.site_id}
          titulo={
            (historial.site_legacy_id ? `#${historial.site_legacy_id} · ` : '') +
            (historial.direccion || historial.site_id)
          }
          onClose={() => setHistorial(null)}
        />
      )}

      {configurando && (
        <ChecklistConfigModal
          unidad={unidad}
          tipo={medio === 'todos' ? 'Impreso' : medio}
          email={email}
          onClose={() => setConfigurando(false)}
        />
      )}
    </div>
  );
}

export default BioboxView;
