// ============================================================
// src/modules/fijacion-externa/FijacionExternaView.tsx
// Módulo piloto migrado a TypeScript. Lee la tabla externa (vía FDW/vista
// vw_fijacion_externa), muestra registros del grupo, permite marcar fijado
// con fotos, y escribe de vuelta con la RPC marcar_fijacion_externa.
// ============================================================
import { useState, useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import { sb } from '../../lib/supabase';
import { candadoTactil } from '../../lib/mapaTactil';
import { prepararArchivos } from '../../lib/comprimirImagen';

// --- Tipos ---
type Registro = {
  id: string;
  responsable_de_cuadrilla?: string;
  operadores_cuadrilla?: string;
  clave?: string;
  catorcena?: string;
  producto?: string;
  zona?: string;
  campana?: string;
  version?: string;
  direccion?: string;
  estado?: string;
  municipio?: string;
  latitud?: number | null;
  longitud?: number | null;
  sin_match_inventario?: boolean;
  [key: string]: unknown;
};
type RegistroConCoords = Registro & { lat: number; lng: number };
type FotoLocal = { file: File; preview: string };

function FijacionExternaView({
  email,
  verTodo,
}: {
  email: string;
  verTodo: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [regs, setRegs] = useState<Registro[]>([]);
  const [q, setQ] = useState('');
  const [fEstado, setFEstado] = useState('PENDIENTE'); // PENDIENTE | COMPLETO | TODOS
  const [mostrar, setMostrar] = useState(50); // cuántas tarjetas mostrar (paginación)
  const BLOQUE = 50;
  const [fijando, setFijando] = useState<Registro | null>(null);
  const [fotos, setFotos] = useState<FotoLocal[]>([]);
  const [sinFoto, setSinFoto] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [guardando, setGuardando] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapObj = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  /** Con qué lista se encuadró el mapa por última vez (ver efecto del mapa). */
  const ultimoEncuadre = useRef<RegistroConCoords[] | null>(null);
  const BUCKET = 'evidencias';

  const abrirFijado = (r: Registro) => {
    setFijando(r);
    setFotos([]);
    setSinFoto(false);
    setMotivo('');
    setErr('');
  };
  const cerrarFijado = () => {
    // Liberar los previews: sin revoke, una cuadrilla que fija 20 registros
    // con 3-4 fotos de 12MP acumulaba blobs a resolución completa toda la
    // sesión — en un Android de gama baja terminaba en recarga de pestaña.
    setFotos((prev) => {
      prev.forEach((f) => URL.revokeObjectURL(f.preview));
      return [];
    });
    setFijando(null);
    setSinFoto(false);
    setMotivo('');
  };

  const onFotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    // Comprimir al elegir, igual que SubirArchivos: menos memoria retenida
    // en el modal y subidas de ~400 KB en vez de 8 MB por datos móviles.
    const { listos, rechazos } = await prepararArchivos(files);
    if (rechazos.length) alert('No se agregaron:\n\n' + rechazos.join('\n'));
    const nuevas = listos.map((f) => ({
      file: f,
      preview: URL.createObjectURL(f),
    }));
    setFotos((prev) => [...prev, ...nuevas]);
  };
  const quitarFoto = (i: number) =>
    setFotos((prev) =>
      prev.filter((f, idx) => {
        if (idx !== i) return true;
        URL.revokeObjectURL(f.preview);
        return false;
      })
    );

  const cargar = async (estadoSel?: string) => {
    setLoading(true);
    setErr('');
    const est = estadoSel !== undefined ? estadoSel : fEstado;
    let query = sb.from('vw_fijacion_externa').select('*');
    if (est !== 'TODOS') query = query.eq('estado', est);
    if (!verTodo) query = query.ilike('operadores_cuadrilla', email);
    const PAGINA = 1000;
    let todas: Registro[] = [];
    let desde = 0;
    let seguir = true;
    while (seguir) {
      const { data, error } = await query.range(desde, desde + PAGINA - 1);
      if (error) {
        setErr('No se pudieron cargar los registros: ' + error.message);
        setLoading(false);
        return;
      }
      todas = todas.concat((data as Registro[]) || []);
      if (!data || data.length < PAGINA) seguir = false;
      else desde += PAGINA;
      if (desde > 50000) seguir = false;
    }
    setRegs(todas);
    setLoading(false);
  };
  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmarFijado = async () => {
    if (!fijando) return;
    if (!sinFoto && fotos.length === 0) {
      setErr(
        "Sube al menos una foto, o marca 'No pude tomar foto' con un motivo."
      );
      return;
    }
    if (sinFoto && !motivo.trim()) {
      setErr('Escribe el motivo por el que no pudiste tomar la foto.');
      return;
    }
    setGuardando(true);
    setErr('');
    try {
      const urls: string[] = [];
      for (let i = 0; i < fotos.length; i++) {
        const f = fotos[i].file;
        const ext = (f.name.split('.').pop() || 'jpg').toLowerCase();
        const path = `fijacion-externa/${fijando.clave || fijando.id}_${Date.now()}_${i}.${ext}`;
        const { error: upErr } = await sb.storage
          .from(BUCKET)
          .upload(path, f, { upsert: false });
        if (upErr) {
          setErr('Error al subir foto: ' + upErr.message);
          setGuardando(false);
          return;
        }
        const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
        urls.push(pub.publicUrl);
      }
      const fotosJson = JSON.stringify(urls);
      const { error: updErr } = await sb.rpc('marcar_fijacion_externa', {
        p_id: fijando.id,
        p_fotos_json: fotosJson,
        p_foto_tomada: !sinFoto,
        p_motivo: sinFoto ? motivo.trim() : null,
      });
      if (updErr) {
        setErr('No se pudo actualizar el registro: ' + updErr.message);
        setGuardando(false);
        return;
      }
      setGuardando(false);
      cerrarFijado();
      cargar();
    } catch (ex: any) {
      setErr('Error inesperado: ' + (ex.message || ex));
      setGuardando(false);
    }
  };

  const norm = (x: unknown) => (x || '').toString().trim().toLowerCase();
  const filtrados = useMemo(
    () =>
      regs.filter((r) => {
        if (q) {
          const s = (
            (r.clave || '') +
            ' ' +
            (r.direccion || '') +
            ' ' +
            (r.campana || '') +
            ' ' +
            (r.zona || '') +
            ' ' +
            (r.operadores_cuadrilla || '')
          ).toLowerCase();
          if (!s.includes(q.toLowerCase())) return false;
        }
        return true;
      }),
    [regs, q]
  );

  const conCoords = useMemo<RegistroConCoords[]>(
    () =>
      filtrados
        .filter((r) => r.latitud != null && r.longitud != null)
        .map((r) => ({
          ...r,
          lat: Number(r.latitud),
          lng: Number(r.longitud),
        })),
    [filtrados]
  );
  const sinCoords = filtrados.length - conCoords.length;

  // Al cambiar búsqueda o estado, volver a mostrar solo el primer bloque.
  useEffect(() => {
    setMostrar(BLOQUE);
  }, [q, fEstado]);

  /**
   * Número de pin en el mapa por id. Solo lo tienen los registros con
   * coordenadas; sirve para que la tarjeta y el pin compartan número.
   */
  const pinPorId = useMemo(() => {
    const m = new Map<string, number>();
    conCoords.forEach((r, idx) => m.set(r.id, idx + 1));
    return m;
  }, [conCoords]);

  // Las tarjetas que se muestran (paginadas). Se pagina sobre TODOS los
  // filtrados, tengan o no coordenadas: marcar fijado no necesita ubicación,
  // y paginar sobre conCoords hacía desaparecer de la lista los registros
  // cuya clave no cruza con el inventario — la cuadrilla no podía cerrarlos.
  const visibles = filtrados.slice(0, mostrar);
  const hayMas = filtrados.length > mostrar;

  // Mapa
  useEffect(() => {
    if (!mapRef.current) return;
    if (
      mapObj.current &&
      mapObj.current.getContainer() !== mapRef.current
    ) {
      mapObj.current.remove();
      mapObj.current = null;
      layerRef.current = null;
    }
    if (!mapObj.current) {
      // preferCanvas: los puntos ligeros (circleMarker) se pintan en canvas,
      // no como nodos DOM — miles de registros congelaban un teléfono.
      mapObj.current = L.map(mapRef.current, {
        zoomControl: true,
        preferCanvas: true,
      }).setView([19.43, -99.13], 11);
      // En táctil, un dedo desplaza la página y no el mapa (ver mapaTactil).
      candadoTactil(mapObj.current);
      L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        { attribution: '© OpenStreetMap © CARTO', maxZoom: 19 }
      ).addTo(mapObj.current);
    }
    if (layerRef.current) mapObj.current.removeLayer(layerRef.current);
    const grp = L.layerGroup();
    const latlngs: [number, number][] = [];
    // Pin numerado (nodo DOM) SOLO para las tarjetas visibles: con miles de
    // registros, un div por marcador congelaba el mapa en el teléfono. El
    // resto se pinta como punto de canvas, igual de consultable con un tap.
    const idsVisibles = new Set(visibles.map((v) => v.id));
    conCoords.forEach((r, idx) => {
      latlngs.push([r.lat, r.lng]);
      const popup = `<b>${r.clave || ''}</b><br>${r.direccion || '(sin dirección)'}<br>${r.campana || ''}`;
      if (idsVisibles.has(r.id)) {
        const icon = L.divIcon({
          className: '',
          html: `<div class="route-pin">${idx + 1}</div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });
        L.marker([r.lat, r.lng], { icon }).bindPopup(popup).addTo(grp);
      } else {
        L.circleMarker([r.lat, r.lng], {
          radius: 5,
          color: '#ff5a3c',
          weight: 1,
          fillColor: '#ff5a3c',
          fillOpacity: 0.55,
        })
          .bindPopup(popup)
          .addTo(grp);
      }
    });
    grp.addTo(mapObj.current);
    layerRef.current = grp;
    // Encuadrar SOLO cuando cambian los datos (filtro/búsqueda). Este efecto
    // también corre al dar "Ver más" (cambia `visibles` para promover pines),
    // y ahí re-encuadrar le quitaría al usuario su zoom y su posición.
    const debeEncuadrar = ultimoEncuadre.current !== conCoords;
    ultimoEncuadre.current = conCoords;
    const ajustar = () => {
      if (!mapObj.current) return;
      mapObj.current.invalidateSize();
      if (!debeEncuadrar) return;
      if (latlngs.length === 1) mapObj.current.setView(latlngs[0], 15);
      else if (latlngs.length > 1)
        mapObj.current.fitBounds(latlngs, { padding: [40, 40], maxZoom: 15 });
    };
    ajustar();
    setTimeout(ajustar, 250);
  }, [conCoords, visibles, loading]);

  if (loading)
    return (
      <div
        className="loading"
        style={{ textAlign: 'center', color: 'var(--muted)', padding: 60 }}
      >
        Cargando registros…
      </div>
    );

  return (
    <div>
      <h2 className="page">Fijación Externa</h2>
      <p className="phint">
        Registros asignados por el área de fijación (sistema externo).{' '}
        {verTodo ? 'Vista completa.' : 'Mostrando los tuyos.'} Sesión: {email}
      </p>

      {err && <div className="err">{err}</div>}
      {sinCoords > 0 && (
        <div
          className="warnbox"
          style={{
            background: '#2a2214',
            border: '1px solid #4a3a1e',
            color: '#f0dcb0',
            fontSize: 12,
            padding: '9px 12px',
            borderRadius: 10,
            marginBottom: 16,
          }}
        >
          {sinCoords} registro(s) sin ubicación (su clave no cruza con el
          inventario) no aparecen en el mapa.
        </div>
      )}

      <div className="cards">
        <div className="card">
          <div className="n">{filtrados.length}</div>
          <div className="l">
            {fEstado === 'PENDIENTE'
              ? 'Pendientes'
              : fEstado === 'COMPLETO'
                ? 'Completos'
                : 'Registros'}
          </div>
        </div>
        <div className="card">
          <div className="n">{conCoords.length}</div>
          <div className="l">Con ubicación</div>
        </div>
        <div className="card">
          <div className="n">{sinCoords}</div>
          <div className="l">Sin ubicación</div>
        </div>
      </div>

      <div className="toolbar">
        <input
          className="search"
          placeholder="Buscar clave, dirección, campaña, zona…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {/* Sin width:'auto' inline: anulaba el apilado a ancho completo que
            la media query de .toolbar da en celular. */}
        <select
          value={fEstado}
          onChange={(e) => {
            const v = e.target.value;
            setFEstado(v);
            cargar(v);
          }}
        >
          <option value="PENDIENTE">Pendientes</option>
          <option value="COMPLETO">Completos</option>
          <option value="TODOS">Todos</option>
        </select>
      </div>

      <div className="fij-split">
        <div style={{ display: 'grid', gap: 11 }}>
          {filtrados.length === 0 && (
            <div className="empty">
              No hay registros pendientes con los filtros actuales.
            </div>
          )}
          {visibles.map((r) => (
            <div className="inc" key={r.id}>
              <div
                className="inc-top"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 10,
                  alignItems: 'flex-start',
                }}
              >
                <div style={{ display: 'flex', gap: 10 }}>
                  {/* Sin coordenadas no hay pin en el mapa: el badge lo dice
                      con un ✕ en gris en vez de inventar un número. */}
                  {pinPorId.has(r.id) ? (
                    <span className="order-badge">{pinPorId.get(r.id)}</span>
                  ) : (
                    <span
                      className="order-badge"
                      style={{ background: 'var(--line)', color: 'var(--muted)' }}
                      title="Sin ubicación en el mapa"
                    >
                      ✕
                    </span>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div className="folio">{r.clave}</div>
                    <div className="titulo">
                      {r.direccion || '(sin dirección)'}
                    </div>
                    <div className="meta">
                      {r.municipio || r.zona || ''}
                      {r.campana ? ' · ' + r.campana : ''}
                      <br />
                      {r.producto || ''} {r.catorcena ? '· ' + r.catorcena : ''}
                    </div>
                  </div>
                </div>
                <span
                  className="pill"
                  style={{ background: 'var(--muted)', color: '#101' }}
                >
                  {r.estado}
                </span>
              </div>
              <div
                className="chips"
                style={{
                  display: 'flex',
                  gap: 6,
                  flexWrap: 'wrap',
                  marginTop: 9,
                }}
              >
                {r.operadores_cuadrilla && (
                  <span className="tag">👥 {r.operadores_cuadrilla}</span>
                )}
                {r.version && <span className="tag">{r.version}</span>}
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  marginTop: 12,
                  borderTop: '1px solid var(--line)',
                  paddingTop: 11,
                }}
              >
                {r.latitud != null && r.longitud != null && (
                  <a
                    className="btn sm ghost"
                    href={`https://maps.google.com/?q=${r.latitud},${r.longitud}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    📍 Maps
                  </a>
                )}
                {r.estado === 'PENDIENTE' && (
                  <button className="btn sm ok" onClick={() => abrirFijado(r)}>
                    Marcar fijado
                  </button>
                )}
              </div>
            </div>
          ))}
          {hayMas && (
            <div style={{ textAlign: 'center', padding: '8px 0' }}>
              <button
                className="btn ghost sm"
                onClick={() => setMostrar((m) => m + BLOQUE)}
              >
                Ver más ({filtrados.length - mostrar} restantes)
              </button>
            </div>
          )}
          {filtrados.length > 0 && (
            <div
              style={{
                textAlign: 'center',
                fontSize: 12,
                color: 'var(--muted)',
                paddingBottom: 4,
              }}
            >
              Mostrando {visibles.length} de {filtrados.length}
            </div>
          )}
        </div>
        <div
          ref={mapRef}
          className="rutas-map"
          style={{
            height: 400,
            borderRadius: 14,
            border: '1px solid var(--line)',
            position: 'sticky',
            top: 16,
          }}
        ></div>
      </div>

      {/* .overlay/.modal del CSS global. El overlay casero centraba con
          flex y el modal se acotaba a 90vh: cuando las fotos lo hacían más
          alto que la pantalla, el encabezado (con el ✕) se recortaba por
          arriba SIN forma de scrollear hasta él. Además, un tap en el fondo
          cerraba tirando las fotos elegidas — ahora solo cierra si no hay
          nada capturado ni una subida en curso. */}
      {fijando && (
        <div
          className="overlay"
          onClick={(e) => {
            if ((e.target as HTMLElement).className !== 'overlay') return;
            if (guardando) return;
            if (
              (fotos.length > 0 || motivo.trim()) &&
              !confirm('Tienes una captura a medias. ¿Descartarla?')
            )
              return;
            cerrarFijado();
          }}
        >
          <div
            className="modal"
            style={{ maxWidth: 520 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: 8,
              }}
            >
              <div>
                <div
                  className="folio"
                  style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 800 }}
                >
                  {fijando.clave}
                </div>
                <h3 style={{ margin: '3px 0' }}>Marcar como fijado</h3>
              </div>
              <button
                className="btn sm ghost"
                onClick={cerrarFijado}
                disabled={guardando}
              >
                ✕
              </button>
            </div>
            <p className="phint" style={{ marginTop: 0 }}>
              {fijando.direccion || ''}
            </p>

            {err && <div className="err">{err}</div>}

            {!sinFoto && (
              <>
                <label
                  className="btn sm"
                  style={{
                    display: 'inline-block',
                    cursor: 'pointer',
                    marginBottom: 10,
                  }}
                >
                  📷 Agregar foto
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple
                    style={{ display: 'none' }}
                    onChange={onFotos}
                  />
                </label>
                {fotos.length > 0 && (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns:
                        'repeat(auto-fill,minmax(90px,1fr))',
                      gap: 8,
                      marginBottom: 12,
                    }}
                  >
                    {fotos.map((f, i) => (
                      <div key={i} style={{ position: 'relative' }}>
                        <img
                          src={f.preview}
                          style={{
                            width: '100%',
                            height: 90,
                            objectFit: 'cover',
                            borderRadius: 8,
                            border: '1px solid var(--line)',
                          }}
                        />
                        <button
                          onClick={() => quitarFoto(i)}
                          aria-label="Quitar esta foto"
                          style={{
                            position: 'absolute',
                            top: 4,
                            right: 4,
                            background: 'rgba(0,0,0,.75)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '50%',
                            /* 30 y no 22: con 22px en la esquina de una
                               miniatura de 90px, en campo se quitaba la foto
                               equivocada o no se atinaba. */
                            width: 30,
                            height: 30,
                            fontSize: 14,
                            lineHeight: 1,
                            padding: 0,
                            cursor: 'pointer',
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--muted)',
                    marginBottom: 10,
                  }}
                >
                  {fotos.length} foto(s) · puedes agregar varias
                </div>
              </>
            )}

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                marginBottom: 10,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={sinFoto}
                onChange={(e) => {
                  setSinFoto(e.target.checked);
                  setErr('');
                }}
              />
              No pude tomar foto
            </label>
            {sinFoto && (
              <textarea
                placeholder="Motivo por el que no se pudo tomar la foto…"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                style={{ marginBottom: 12, minHeight: 70 }}
              />
            )}

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                justifyContent: 'flex-end',
                borderTop: '1px solid var(--line)',
                paddingTop: 12,
              }}
            >
              <button
                className="btn ghost sm"
                onClick={cerrarFijado}
                disabled={guardando}
              >
                Cancelar
              </button>
              <button
                className="btn ok"
                onClick={confirmarFijado}
                disabled={guardando}
              >
                {guardando && <span className="spinner" />}
                {/* "Subiendo fotos" solo cuando de verdad hay fotos que
                    subir; con "sin foto" marcado solo se guarda el registro. */}
                {guardando
                  ? fotos.length > 0
                    ? 'Subiendo fotos…'
                    : 'Guardando…'
                  : 'Confirmar fijado'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default FijacionExternaView;
