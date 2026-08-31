// ============================================================
// src/modules/rutas/RutasView.tsx
// Fase 2: mapa coloreado por ruta + área sombreada (convex hull) + leyenda.
// Lee vw_rutas_con_coords y vw_rutas_resumen.
// ============================================================
import { useState, useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import * as XLSX from 'xlsx';
import { sb } from '../../lib/supabase';
import { candadoTactil } from '../../lib/mapaTactil';
import IrAqui from '../../components/IrAqui';
import ImportarKmlModal from './ImportarKmlModal';
import ImportarRutasExcelModal from './ImportarRutasExcelModal';
import { tramosGoogleMaps, esNavegable } from '../../lib/navegacion';
import { convexHull } from '../../lib/convexHull';
import type { Pt } from '../../lib/convexHull';

type Ubic = {
  ubicacion_id: number;
  ruta_id: number;
  ruta_numero: number;
  ruta_nombre: string | null;
  ruta_color: string;
  ruta_unidad: string;
  ruta_tipo: string;
  ruta_activa: boolean;
  site_id: string;
  secuencia: number | null;
  estatus_archivo: string | null;
  vallas_archivo: number | null;
  direccion_archivo: string | null;
  caras_reales: number | null;
  latitud: number | null;
  longitud: number | null;
  municipio: string | null;
  sin_match_inventario: boolean;
};
type Resumen = {
  id: number;
  numero: number;
  nombre: string | null;
  color: string;
  unidad_negocio: string;
  tipo_medio: string;
  activa: boolean;
  total_ubicaciones: number;
  retiradas: number;
  inhabilitadas: number;
};

/** Unidades que tienen rutas. Se intersecta con las del usuario. */
const UNIDADES_CON_RUTAS = ['Ecovallas', 'Biobox', 'Vía Verde'];

function RutasView({
  puedeGestionar,
  unidades,
}: {
  puedeGestionar: boolean;
  /** Unidades del usuario (App): acota qué rutas puede ver y tocar. */
  unidades: string[];
}) {
  // El coordinador de una sola unidad ve SOLO las rutas de la suya; el
  // selector le ofrece únicamente sus opciones (Erik, ago-2026).
  const unidadesVisibles = UNIDADES_CON_RUTAS.filter((u) =>
    unidades.includes(u)
  );
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [ubics, setUbics] = useState<Ubic[]>([]);
  const [resumen, setResumen] = useState<Resumen[]>([]);
  const [rutaFoco, setRutaFoco] = useState<number | null>(null); // null = todas
  // Unidad + medio activos. Arranca en la primera unidad del usuario.
  const [unidad, setUnidad] = useState(unidadesVisibles[0] || 'Ecovallas');
  const [tipo, setTipo] = useState('Impreso');
  // Gestión de rutas (crear/editar)
  const [editando, setEditando] = useState<Partial<Resumen> | null>(null);
  const [guardando, setGuardando] = useState(false);
  // Importación de archivo
  const [importando, setImportando] = useState(false);
  const [resultadoImport, setResultadoImport] = useState<string>('');
  // Importación desde el KML de My Maps (rutas por capa). Es un modal aparte
  // porque necesita vista previa: el empate con inventario no es exacto.
  const [kmlAbierto, setKmlAbierto] = useState(false);
  // Importación desde el Excel de operación (clave + responsable). Para
  // Biobox éste es el camino bueno: identifica por clave, no por nombre.
  const [excelRutasAbierto, setExcelRutasAbierto] = useState(false);
  // Detalle de ruta (modal con listado de ubicaciones)
  const [detalleRuta, setDetalleRuta] = useState<Resumen | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapObj = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  const cargar = async () => {
    setLoading(true);
    setErr('');
    const [u, r] = await Promise.all([
      sb
        .from('vw_rutas_con_coords')
        .select('*')
        .eq('ruta_unidad', unidad)
        .eq('ruta_tipo', tipo),
      sb
        .from('vw_rutas_resumen')
        .select('*')
        .eq('unidad_negocio', unidad)
        .eq('tipo_medio', tipo),
    ]);
    if (u.error) {
      setErr('No se pudieron cargar las ubicaciones: ' + u.error.message);
      setLoading(false);
      return;
    }
    if (r.error) {
      setErr('No se pudo cargar el resumen: ' + r.error.message);
      setLoading(false);
      return;
    }
    setUbics((u.data as Ubic[]) || []);
    setResumen((r.data as Resumen[]) || []);
    setLoading(false);
  };
  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unidad, tipo]);

  // Abrir modal para crear una ruta nueva (segmento = el activo)
  const nuevaRuta = () => {
    setErr('');
    setEditando({
      numero: undefined,
      nombre: '',
      color: '#ff5a3c',
      unidad_negocio: unidad,
      tipo_medio: tipo,
      activa: true,
    });
  };
  // Abrir modal para editar una ruta existente
  const editarRuta = (r: Resumen) => {
    setErr('');
    setEditando({ ...r });
  };
  // Guardar (insert si es nueva, update si existe)
  const guardarRuta = async () => {
    if (!editando) return;
    if (editando.numero == null || String(editando.numero).trim() === '') {
      setErr('El número de ruta es obligatorio.');
      return;
    }
    setGuardando(true);
    setErr('');
    const payload = {
      numero: Number(editando.numero),
      nombre: editando.nombre?.trim() || null,
      color: editando.color || '#ff5a3c',
      unidad_negocio: editando.unidad_negocio || unidad,
      tipo_medio: editando.tipo_medio || tipo,
      activa: editando.activa ?? true,
    };
    let error;
    if (editando.id) {
      ({ error } = await sb
        .from('rutas_monitoreo')
        .update(payload)
        .eq('id', editando.id));
    } else {
      ({ error } = await sb.from('rutas_monitoreo').insert(payload));
    }
    setGuardando(false);
    if (error) {
      // Detectar violación de unicidad del número de ruta y mostrar mensaje claro
      const msg = (error.message || '').toLowerCase();
      if (
        msg.includes('duplicate') ||
        msg.includes('unique') ||
        error.code === '23505'
      ) {
        setErr('Número de ruta duplicado, elige otro.');
      } else {
        setErr('No se pudo guardar: ' + error.message);
      }
      return;
    }
    setEditando(null);
    cargar();
  };

  // Importar el archivo Excel de rutas
  const onArchivoImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportando(true);
    setResultadoImport('');
    setErr('');
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
        defval: null,
      });

      // Mapear columnas del archivo a lo que espera la función.
      // Columnas del archivo: Clave Nueva, Ruta, Secuencia, Dirección, Estatus, VALLAS
      const filas = rows
        .map((r) => ({
          site_id: String(r['Clave Nueva'] ?? '').trim(),
          ruta: Number(r['Ruta']),
          secuencia: r['Secuencia'] != null ? Number(r['Secuencia']) : null,
          estatus: String(r['Estatus'] ?? '').trim().toUpperCase(),
          vallas: r['VALLAS'] != null ? Number(r['VALLAS']) : null,
          direccion: String(r['Dirección'] ?? '').trim(),
        }))
        // descartar filas sin site_id o sin ruta válida
        .filter((f) => f.site_id && !isNaN(f.ruta));

      if (filas.length === 0) {
        setErr(
          'No se encontraron filas válidas. Revisa que el archivo tenga las columnas: Clave Nueva, Ruta, Secuencia, Estatus, VALLAS.'
        );
        setImportando(false);
        return;
      }

      // Llamar a la función de importación (segmento actual)
      const { data, error } = await sb.rpc('importar_rutas', {
        p_unidad: unidad,
        p_tipo: tipo,
        p_filas: filas,
      });
      if (error) {
        setErr('Error al importar: ' + error.message);
        setImportando(false);
        return;
      }
      const res = data as {
        rutas_creadas: number;
        ubicaciones_procesadas: number;
        omitidas: number;
      };
      setResultadoImport(
        `Importación lista: ${res.ubicaciones_procesadas} ubicaciones procesadas, ${res.rutas_creadas} rutas creadas` +
          (res.omitidas > 0
            ? `, ${res.omitidas} omitidas (no coincidían con ${unidad}/${tipo} o no existen en inventario).`
            : '.')
      );
      setImportando(false);
      cargar();
    } catch (ex: any) {
      setErr('No se pudo leer el archivo: ' + (ex.message || ex));
      setImportando(false);
    }
  };

  // ubicaciones con coordenadas, filtradas por ruta en foco (o todas)
  const visibles = useMemo(
    () =>
      ubics
        .filter((x) => x.latitud != null && x.longitud != null)
        .filter((x) => rutaFoco == null || x.ruta_id === rutaFoco)
        .map((x) => ({
          ...x,
          lat: Number(x.latitud),
          lng: Number(x.longitud),
        })),
    [ubics, rutaFoco]
  );

  // Ubicaciones de la ruta en detalle (TODAS, ordenadas por secuencia)
  const ubicsDetalle = useMemo(() => {
    if (!detalleRuta) return [];
    return ubics
      .filter((x) => x.ruta_id === detalleRuta.id)
      .sort((a, b) => (a.secuencia ?? 9999) - (b.secuencia ?? 9999));
  }, [ubics, detalleRuta]);

  /**
   * Paradas navegables de la ruta abierta, ya partidas en tramos.
   * Se excluyen las RETIRADAS (ya no están físicamente) y las que no tienen
   * coordenadas, que se cuentan aparte para avisar en pantalla.
   */
  const { tramosDetalle, sinCoordsDetalle } = useMemo(() => {
    const activas = ubicsDetalle.filter(
      (u) => (u.estatus_archivo || '').toUpperCase() !== 'RETIRADA'
    );
    const navegables = activas.filter((u) =>
      esNavegable({ lat: u.latitud, lng: u.longitud })
    );
    return {
      tramosDetalle: tramosGoogleMaps(
        navegables.map((u) => ({
          lat: Number(u.latitud),
          lng: Number(u.longitud),
          nombre: u.site_id,
        }))
      ),
      sinCoordsDetalle: activas.length - navegables.length,
    };
  }, [ubicsDetalle]);

  // agrupar por ruta (para dibujar cada polígono y sus puntos)
  const porRuta = useMemo(() => {
    const m = new Map<
      number,
      {
        color: string;
        numero: number;
        nombre: string | null;
        pts: (Pt & {
          vfid: string;
          dir: string | null;
          seq: number | null;
          estatus: string | null;
          carasArch: number | null;
          carasReal: number | null;
        })[];
      }
    >();
    for (const x of visibles) {
      if (!m.has(x.ruta_id))
        m.set(x.ruta_id, {
          color: x.ruta_color,
          numero: x.ruta_numero,
          nombre: x.ruta_nombre,
          pts: [],
        });
      m.get(x.ruta_id)!.pts.push({
        lat: x.lat,
        lng: x.lng,
        vfid: x.site_id,
        dir: x.direccion_archivo,
        seq: x.secuencia,
        estatus: x.estatus_archivo,
        carasArch: x.vallas_archivo,
        carasReal: x.caras_reales,
      });
    }
    return m;
  }, [visibles]);

  // Mapa
  useEffect(() => {
    if (!mapRef.current) return;
    if (mapObj.current && mapObj.current.getContainer() !== mapRef.current) {
      mapObj.current.remove();
      mapObj.current = null;
      layerRef.current = null;
    }
    if (!mapObj.current) {
      mapObj.current = L.map(mapRef.current, { zoomControl: true }).setView(
        [19.43, -99.13],
        11
      );
      // En táctil, un dedo desplaza la página y no el mapa (ver mapaTactil).
      candadoTactil(mapObj.current);
      L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        { attribution: '© OpenStreetMap © CARTO', maxZoom: 19 }
      ).addTo(mapObj.current);
    }
    if (layerRef.current) mapObj.current.removeLayer(layerRef.current);
    const grp = L.layerGroup();
    const todosLatLng: [number, number][] = [];

    porRuta.forEach((ruta) => {
      // área sombreada (convex hull) si hay 3+ puntos
      if (ruta.pts.length >= 3) {
        const hull = convexHull(ruta.pts);
        const poly = hull.map((p) => [p.lat, p.lng]) as [number, number][];
        L.polygon(poly, {
          color: ruta.color,
          weight: 2,
          fillColor: ruta.color,
          fillOpacity: 0.15,
        }).addTo(grp);
      }
      // puntos de la ruta, con su color
      ruta.pts.forEach((p) => {
        todosLatLng.push([p.lat, p.lng]);
        L.circleMarker([p.lat, p.lng], {
          radius: 7,
          color: '#151515',
          weight: 1,
          fillColor: ruta.color,
          fillOpacity: 0.95,
        })
          .bindPopup(
            `<b>Ruta ${ruta.numero}${ruta.nombre ? ' · ' + ruta.nombre : ''}</b>` +
              `${p.seq != null ? ` · secuencia ${p.seq}` : ''}<br>` +
              `${p.vfid}<br>${p.dir || ''}<br>` +
              `<small>Caras: ${p.carasReal ?? '?'} en inventario` +
              `${p.carasArch != null && p.carasArch !== p.carasReal ? ` (archivo: ${p.carasArch})` : ''}` +
              `${p.estatus ? ` · ${p.estatus}` : ''}</small>`
          )
          .addTo(grp);
      });
    });

    grp.addTo(mapObj.current);
    layerRef.current = grp;
    const ajustar = () => {
      if (!mapObj.current) return;
      mapObj.current.invalidateSize();
      if (todosLatLng.length === 1)
        mapObj.current.setView(todosLatLng[0], 14);
      else if (todosLatLng.length > 1)
        mapObj.current.fitBounds(todosLatLng, {
          padding: [40, 40],
          maxZoom: 15,
        });
    };
    ajustar();
    setTimeout(ajustar, 250);
  }, [porRuta, loading]);

  // El modal de KML se dibuja ANTES de esta salida temprana, y por eso vive
  // en las dos ramas. Si solo estuviera abajo, al terminar de importar
  // pasaría esto: el modal llama a cargar(), `loading` se pone en true, este
  // return desmonta el modal, se pierde su pantalla de resultado —con los
  // avisos de omitidas y sobrantes— y al volver reaparece pidiendo archivo,
  // como si no hubiera pasado nada. Invita a importar dos veces.
  const modalKml = (
    <>
      {kmlAbierto && (
        <ImportarKmlModal
          unidad={unidad}
          onClose={() => setKmlAbierto(false)}
          onImportado={(resumen) => {
            setResultadoImport('Importación desde el mapa: ' + resumen);
            cargar();
          }}
        />
      )}
      {excelRutasAbierto && (
        <ImportarRutasExcelModal
          onClose={() => setExcelRutasAbierto(false)}
          onImportado={(resumen) => {
            setResultadoImport('Importación desde el Excel: ' + resumen);
            cargar();
          }}
        />
      )}
    </>
  );

  if (loading)
    return (
      <div className="loading" style={{ textAlign: 'center', color: 'var(--muted)', padding: 60 }}>
        Cargando rutas…
        {modalKml}
      </div>
    );

  return (
    <div>
      <h2 className="page">Rutas de Monitoreo</h2>
      <p className="phint">
        Ubicaciones agrupadas por ruta geográfica. Cada ruta con su color y área.
      </p>

      <div className="toolbar">
        <span className="tag">Unidad de negocio:</span>
        <select
          style={{ width: 'auto' }}
          value={unidad}
          onChange={(e) => {
            setUnidad(e.target.value);
            setRutaFoco(null);
          }}
        >
          {unidadesVisibles.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <select
          style={{ width: 'auto' }}
          value={tipo}
          onChange={(e) => {
            setTipo(e.target.value);
            setRutaFoco(null);
          }}
        >
          <option value="Impreso">Impreso</option>
          <option value="Digital">Digital</option>
        </select>
        {puedeGestionar && (
          <button className="btn sm" onClick={nuevaRuta}>
            + Nueva ruta
          </button>
        )}
        {puedeGestionar && (
          <label
            className="btn sm ghost"
            style={{ display: 'inline-block', cursor: 'pointer' }}
          >
            {importando ? 'Importando…' : '📥 Importar archivo'}
            <input
              type="file"
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              style={{ display: 'none' }}
              onChange={onArchivoImport}
              disabled={importando}
            />
          </label>
        )}
        {puedeGestionar && (
          <button
            className="btn sm"
            onClick={() => setExcelRutasAbierto(true)}
            title="Una fila por máquina: clave y responsable. Empata por clave exacta."
          >
            🧾 Importar rutas (Excel)
          </button>
        )}
        {puedeGestionar && (
          <button
            className="btn sm ghost"
            onClick={() => setKmlAbierto(true)}
            title="Las capas del mapa de My Maps se convierten en rutas. Empata por nombre, menos preciso que el Excel."
          >
            🗺️ Importar mapa (KML)
          </button>
        )}
      </div>

      {modalKml}

      {resultadoImport && (
        <div
          className="banner"
          style={{
            background: '#1a2436',
            border: '1px solid #26344d',
            color: '#bcd0f0',
            fontSize: 13,
            padding: '10px 12px',
            borderRadius: 10,
            marginBottom: 14,
          }}
        >
          {resultadoImport}
        </div>
      )}

      {err && <div className="err">{err}</div>}

      {resumen.length === 0 && (
        <div className="empty">
          Aún no hay rutas. Créalas (próxima fase) o impórtalas cuando tengas el
          archivo de monitoreo.
        </div>
      )}

      {resumen.length > 0 && (
        <>
          <div className="cards">
            <div className="card">
              <div className="n">{resumen.length}</div>
              <div className="l">Rutas</div>
            </div>
            <div className="card">
              <div className="n">
                {resumen.reduce((a, r) => a + Number(r.total_ubicaciones), 0)}
              </div>
              <div className="l">Ubicaciones</div>
            </div>
            <div className="card">
              <div className="n">
                {resumen.reduce((a, r) => a + Number(r.retiradas), 0)}
              </div>
              <div className="l">Retiradas</div>
            </div>
          </div>

          <div className="fij-split">
            {/* Leyenda de rutas */}
            <div style={{ display: 'grid', gap: 9 }}>
              <div
                className={'nav-item' + (rutaFoco == null ? ' active' : '')}
                style={{ cursor: 'pointer' }}
                onClick={() => setRutaFoco(null)}
              >
                <span>🗺️</span>
                <span>Ver todas las rutas</span>
              </div>
              {resumen.map((r) => (
                <div
                  key={r.id}
                  className="inc"
                  style={{
                    cursor: 'pointer',
                    borderLeft: `5px solid ${r.color}`,
                    opacity: rutaFoco == null || rutaFoco === r.id ? 1 : 0.5,
                  }}
                  onClick={() => setRutaFoco(rutaFoco === r.id ? null : r.id)}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 4,
                          background: r.color,
                          display: 'inline-block',
                        }}
                      ></span>
                      <div>
                        <div className="titulo" style={{ margin: 0 }}>
                          Ruta {r.numero}
                          {r.nombre ? ` · ${r.nombre}` : ''}
                        </div>
                        <div className="meta">
                          {r.total_ubicaciones} ubicaciones
                          {Number(r.inhabilitadas) > 0
                            ? ` · ${r.inhabilitadas} inhabilitadas`
                            : ''}
                          {Number(r.retiradas) > 0
                            ? ` · ${r.retiradas} retiradas`
                            : ''}
                        </div>
                      </div>
                    </div>
                    {!r.activa && <span className="tag">inactiva</span>}
                    <button
                      className="btn ghost sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDetalleRuta(r);
                      }}
                      title="Ver ubicaciones"
                    >
                      📋
                    </button>
                    {puedeGestionar && (
                      <button
                        className="btn ghost sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          editarRuta(r);
                        }}
                      >
                        ✏️
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div
              ref={mapRef}
              className="rutas-map"
              style={{
                height: 460,
                borderRadius: 14,
                border: '1px solid var(--line)',
                position: 'sticky',
                top: 16,
              }}
            ></div>
          </div>
        </>
      )}

      {/* .overlay/.modal del CSS global, no un overlay a mano: el casero
          centraba con flex SIN scroll — con el teclado abierto en un
          teléfono, el botón Guardar quedaba cortado e inalcanzable — y al
          no llevar la clase .overlay tampoco se ocultaba el menú inferior. */}
      {editando && (
        <div
          className="overlay"
          onClick={(e) => {
            if (
              (e.target as HTMLElement).className === 'overlay' &&
              !guardando
            )
              setEditando(null);
          }}
        >
          <div
            className="modal"
            style={{ maxWidth: 440 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 14,
              }}
            >
              <h3 style={{ margin: 0 }}>
                {editando.id ? 'Editar ruta' : 'Nueva ruta'}
              </h3>
              <button
                className="btn sm ghost"
                onClick={() => setEditando(null)}
                disabled={guardando}
              >
                ✕
              </button>
            </div>

            {err && <div className="err">{err}</div>}

            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <label
                  style={{
                    fontSize: 12,
                    color: 'var(--muted)',
                    display: 'block',
                    marginBottom: 4,
                  }}
                >
                  Número de ruta *
                </label>
                <input
                  type="number"
                  value={editando.numero ?? ''}
                  onChange={(e) =>
                    setEditando({
                      ...editando,
                      numero: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                  placeholder="1, 2, 3…"
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 12,
                    color: 'var(--muted)',
                    display: 'block',
                    marginBottom: 4,
                  }}
                >
                  Nombre (opcional)
                </label>
                <input
                  value={editando.nombre ?? ''}
                  onChange={(e) =>
                    setEditando({ ...editando, nombre: e.target.value })
                  }
                  placeholder="Ej. Polanco"
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 12,
                    color: 'var(--muted)',
                    display: 'block',
                    marginBottom: 4,
                  }}
                >
                  Color
                </label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="color"
                    value={editando.color ?? '#ff5a3c'}
                    onChange={(e) =>
                      setEditando({ ...editando, color: e.target.value })
                    }
                    style={{ width: 50, height: 38, padding: 2 }}
                  />
                  <input
                    value={editando.color ?? '#ff5a3c'}
                    onChange={(e) =>
                      setEditando({ ...editando, color: e.target.value })
                    }
                    style={{ flex: 1 }}
                  />
                </div>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  background: 'var(--panel2)',
                  borderRadius: 8,
                  padding: '8px 10px',
                }}
              >
                Unidad: <b>{editando.unidad_negocio}</b> ·{' '}
                <b>{editando.tipo_medio}</b>
                {!editando.id && ' (del filtro actual)'}
              </div>
              {editando.id && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={editando.activa ?? true}
                    onChange={(e) =>
                      setEditando({ ...editando, activa: e.target.checked })
                    }
                  />
                  Ruta activa
                </label>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
                marginTop: 16,
                borderTop: '1px solid var(--line)',
                paddingTop: 14,
              }}
            >
              <button
                className="btn ghost sm"
                onClick={() => setEditando(null)}
                disabled={guardando}
              >
                Cancelar
              </button>
              <button className="btn ok" onClick={guardarRuta} disabled={guardando}>
                {guardando ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mismo cambio que el modal de edición: .overlay scrollea completo,
          así una ruta de 40 paradas se recorre con el scroll de la página
          en vez de una lista interna encajonada en 85vh (que en iPhone,
          con la barra de Safari visible, se pasaba del alto real). */}
      {detalleRuta && (
        <div
          className="overlay"
          onClick={(e) => {
            if ((e.target as HTMLElement).className === 'overlay')
              setDetalleRuta(null);
          }}
        >
          <div
            className="modal"
            style={{ maxWidth: 620 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    background: detalleRuta.color,
                    display: 'inline-block',
                  }}
                ></span>
                <h3 style={{ margin: 0 }}>
                  Ruta {detalleRuta.numero}
                  {detalleRuta.nombre ? ` · ${detalleRuta.nombre}` : ''}
                </h3>
              </div>
              <button
                className="btn sm ghost"
                onClick={() => setDetalleRuta(null)}
              >
                ✕
              </button>
            </div>
            <p className="phint" style={{ marginTop: 0 }}>
              {ubicsDetalle.length} ubicaciones · orden de visita por secuencia
            </p>

            {/* Navegación de la ruta completa. Google Maps solo admite 9
                paradas intermedias por enlace, así que una ruta larga se
                ofrece por tramos encadenados: cada uno arranca donde terminó
                el anterior. */}
            {tramosDetalle.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  marginBottom: 10,
                  paddingBottom: 10,
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {tramosDetalle.length === 1
                    ? 'Navegar la ruta:'
                    : `Navegar por tramos (${tramosDetalle.length}):`}
                </span>
                {tramosDetalle.map((t) => (
                  <a
                    key={t.desde}
                    className="btn sm"
                    href={t.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ textDecoration: 'none' }}
                  >
                    🗺️{' '}
                    {tramosDetalle.length === 1
                      ? 'Abrir en Google Maps'
                      : `Paradas ${t.desde}–${t.hasta}`}
                  </a>
                ))}
                {sinCoordsDetalle > 0 && (
                  <span
                    className="pill"
                    style={{ background: '#f59e0b22', color: '#f59e0b' }}
                    title="Estas ubicaciones no tienen coordenadas en el inventario"
                  >
                    ⚠ {sinCoordsDetalle} sin coordenadas
                  </span>
                )}
              </div>
            )}

            <div style={{ overflowY: 'auto', display: 'grid', gap: 6 }}>
              {ubicsDetalle.map((u) => {
                const est = (u.estatus_archivo || '').toUpperCase();
                const esRetirada = est === 'RETIRADA';
                const esInhab = est === 'INHABILITADA';
                const colorEst = esRetirada
                  ? '#ef4444'
                  : esInhab
                    ? '#f59e0b'
                    : '#22c55e';
                return (
                  <div
                    key={u.ubicacion_id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      padding: '8px 10px',
                      borderRadius: 9,
                      background: 'var(--panel2)',
                      border: '1px solid var(--line)',
                      opacity: esRetirada ? 0.6 : 1,
                    }}
                  >
                    <span
                      style={{
                        minWidth: 26,
                        height: 26,
                        borderRadius: '50%',
                        background: 'var(--panel)',
                        border: '1px solid var(--line)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {u.secuencia ?? '—'}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: 13,
                          textDecoration: esRetirada ? 'line-through' : 'none',
                        }}
                      >
                        {u.site_id}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--muted)',
                          lineHeight: 1.4,
                        }}
                      >
                        {u.direccion_archivo || '(sin dirección)'}
                      </div>
                    </div>
                    {est && est !== 'ACTIVA' && (
                      <span
                        className="pill"
                        style={{
                          background: colorEst + '22',
                          color: colorEst,
                          flexShrink: 0,
                        }}
                      >
                        {esRetirada ? 'Retirada' : 'Inhabilitada'}
                      </span>
                    )}
                    {/* Una valla retirada ya no existe: no se navega a ella. */}
                    {!esRetirada && (
                      <IrAqui
                        destino={{
                          lat: u.latitud,
                          lng: u.longitud,
                          nombre: u.site_id,
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default RutasView;
