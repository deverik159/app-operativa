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
import RepararModal, { DatosReparacion } from '../incidencias/RepararModal';
import { EST_COLOR, EST_LABEL } from '../../lib/constants';
import { caraIncidencia, areaEfectiva } from '../../lib/helpers';
import type { Incidencia } from '../../types/db';

/**
 * ÁREA de este módulo. Las incidencias que aparecen como órdenes de trabajo
 * deben PERTENECER al área, no solo empatar por clave: en esa misma valla
 * puede haber una incidencia de Mantenimiento y esa no es de esta cuadrilla.
 *
 * ESTE MÓDULO ES EL MOTOR (Erik, 2-sep-2026): Implementaciones,
 * Instalaciones e Iluminación tendrán su módulo gemelo cuando exista su
 * base; se clonará de aquí cambiando esta constante (y la vista/RPC de su
 * fuente). Los cambios se hacen aquí primero, no en cada copia.
 */
const AREA_MODULO = 'Fijación';

// --- Tipos ---
// Columnas de externo.fijacion (diagnóstico del 2-sep-2026) que la tarjeta
// puede usar. TODAS opcionales a propósito: la tarjeta pinta solo lo que la
// vista exponga y venga con dato — si un campo no sale en pantalla teniendo
// valor en la tabla, la vista no lo expone y hay que recrearla.
type Registro = {
  id: string;
  responsable_de_cuadrilla?: string;
  operadores_cuadrilla?: string;
  supervisor?: string;
  clave?: string;
  catorcena?: string;
  producto?: string;
  zona?: string;
  asignacion?: string;
  campana?: string;
  version?: string;
  direccion?: string;
  estado?: string;
  municipio?: string;
  notas_observa?: string;
  notas_motivo_bloqueo?: string;
  blanqueo_limpieza?: string;
  fecha_limite?: string;
  fecha_fijacion_real?: string;
  foto_url?: string;
  evidencia_url?: string;
  latitud?: number | null;
  longitud?: number | null;
  sin_match_inventario?: boolean;
  [key: string]: unknown;
};

/** "CATORCENA 1 - 2026" → "CAT 1 · 2026". Lo que no siga el patrón, tal cual. */
const catorcenaCorta = (c?: string): string => {
  const m = (c || '').match(/CATORCENA\s*(\d+)\s*-\s*(\d+)/i);
  return m ? `CAT ${m[1]} · ${m[2]}` : c || '';
};

/** Color del estado de la orden de fijación (PENDIENTE/COMPLETO/RESUELTO). */
const ESTADO_FIJ: Record<string, { bg: string; fg: string }> = {
  PENDIENTE: { bg: '#f59e0b22', fg: '#f59e0b' },
  COMPLETO: { bg: '#22c55e22', fg: '#22c55e' },
  RESUELTO: { bg: '#4f8cff22', fg: '#4f8cff' },
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
  // El toggle "No pude tomar foto" se retiró (retro de la presentación,
  // sep-2026): la evidencia SIEMPRE es obligatoria — mínimo un archivo,
  // foto o video. Sin escape, porque el escape se volvía el camino fácil.
  const [guardando, setGuardando] = useState(false);
  // Incidencias abiertas ligadas a las claves de esta lista: la cuadrilla
  // las ve como órdenes de trabajo junto a la pauta y puede repararlas
  // desde aquí (el flujo sigue igual: validación, reasignación, etc.).
  const [incs, setIncs] = useState<Incidencia[]>([]);
  const [reparando, setReparando] = useState<Incidencia | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapObj = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  /** Con qué lista se encuadró el mapa por última vez (ver efecto del mapa). */
  const ultimoEncuadre = useRef<RegistroConCoords[] | null>(null);
  const BUCKET = 'evidencias';

  const abrirFijado = (r: Registro) => {
    setFijando(r);
    setFotos([]);
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
  /**
   * Incidencias vivas que se pueden trabajar desde aquí. Se traen TODAS las
   * en_proceso/reparado y el cruce con la lista se hace en el cliente por
   * clave: mandar miles de claves en un .in() no cabe en la URL, y el
   * volumen de incidencias abiertas es chico. La RLS ya recorta lo que este
   * usuario no puede ver.
   */
  const cargarIncs = async () => {
    const { data } = await sb
      .from('incidencias')
      .select('*')
      .in('estatus', ['en_proceso', 'reparado']);
    // Solo las del ÁREA de este módulo. Contra el área EFECTIVA (la
    // asignada manda sobre la del catálogo): una incidencia redirigida A
    // Fijación sí es de esta cuadrilla, y una redirigida FUERA ya no.
    setIncs(
      ((data as Incidencia[]) || []).filter(
        (i) =>
          areaEfectiva(i).trim().toLowerCase() ===
          AREA_MODULO.trim().toLowerCase()
      )
    );
  };

  useEffect(() => {
    cargar();
    cargarIncs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Igual que guardarReparacion en IncidenciasView: la cuadrilla repara
   * desde aquí y el flujo sigue su curso normal (el validador la ve como
   * 'reparado' en Incidencias, puede aprobarla o rechazarla, etc.).
   */
  const guardarReparacion = async (
    inc: Incidencia,
    { diagnostico, detalle, causa, solucion }: DatosReparacion
  ) => {
    const patch: Partial<Incidencia> = {
      estatus: 'reparado',
      diagnostico: diagnostico || null,
      detalle_reparacion: detalle || null,
      causa_raiz: causa || null,
      solucion: solucion || null,
      repaired_by_email: email,
      repaired_at: new Date().toISOString(),
    };
    const { data, error } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id)
      .select('record_id');
    if (error) {
      alert('No se pudo guardar la reparación: ' + error.message);
      return;
    }
    // La RLS no lanza error cuando el update no te toca: afecta 0 filas y
    // regresa "éxito". Sin esto, se pintaba como reparada sin estarlo.
    if (!data || data.length === 0) {
      alert(
        'No se guardó: esta incidencia no pertenece a tu área, ' +
          'o tu rol no permite repararla.'
      );
      return;
    }
    setIncs((prev) =>
      prev.map((x) =>
        x.record_id === inc.record_id ? { ...x, ...patch } : x
      )
    );
    setReparando(null);
  };

  const confirmarFijado = async () => {
    if (!fijando) return;
    if (fotos.length === 0) {
      setErr('Adjunta al menos una foto o un video de la fijación.');
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
      // p_foto_tomada siempre true y p_motivo null: la evidencia ya es
      // obligatoria sin excepción. Los parámetros se conservan porque la
      // RPC (y la base de Mario) los siguen esperando.
      const { error: updErr } = await sb.rpc('marcar_fijacion_externa', {
        p_id: fijando.id,
        p_fotos_json: fotosJson,
        p_foto_tomada: true,
        p_motivo: null,
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

  /**
   * SITIO de una clave de cara. La clave de Mario viene a nivel CARA
   * (MX_CM_EV_MGV_4-5_2993) y la incidencia pudo capturarse en OTRA cara
   * del mismo sitio (MX_CM_EV_EVA_04_2993, sitio MX_CM_EV_2993): el empate
   * exacto nunca cruzaría. El sitio son los 3 primeros segmentos + el
   * último (el número); los de en medio son el mueble y la posición.
   * Una clave de 4 segmentos ya ES el sitio y se regresa tal cual.
   */
  const sitioDeClave = (clave: string): string => {
    const p = clave.trim().split('_');
    if (p.length >= 6) return [...p.slice(0, 3), p[p.length - 1]].join('_');
    return clave.trim();
  };

  /** Incidencias indexadas por cara exacta y por sitio. */
  const { incsPorCara, incsPorSitio } = useMemo(() => {
    const porCara = new Map<string, Incidencia[]>();
    const porSitio = new Map<string, Incidencia[]>();
    incs.forEach((i) => {
      if (i.clave_medio) {
        const arr = porCara.get(i.clave_medio) || [];
        arr.push(i);
        porCara.set(i.clave_medio, arr);
      }
      if (i.clave_sitio) {
        const arr = porSitio.get(i.clave_sitio) || [];
        arr.push(i);
        porSitio.set(i.clave_sitio, arr);
      }
    });
    return { incsPorCara: porCara, incsPorSitio: porSitio };
  }, [incs]);

  /**
   * La lista como ÓRDENES DE TRABAJO de la cuadrilla: cada parada de pauta
   * y, LIGADAS pero SIN encimarse, las incidencias vivas de esa ubicación —
   * tarjeta aparte con el mismo número de ubicación en otro color.
   *
   * Dos pases para que cada incidencia salga UNA vez y junto a su mejor
   * registro: primero los empates EXACTOS por cara (si la fijación es de la
   * misma cara reportada, ahí pertenece), y luego los del mismo SITIO (la
   * incidencia es de otra cara de esa ubicación — el caso EV00009, que por
   * empate exacto no aparecía).
   */
  const ordenes = useMemo(() => {
    const usadas = new Set<string>();
    const porRegistro = new Map<string, Incidencia[]>();
    visibles.forEach((r) => {
      const clave = String(r.clave || '').trim();
      porRegistro.set(
        r.id,
        (incsPorCara.get(clave) || []).filter((i) => {
          if (usadas.has(i.record_id)) return false;
          usadas.add(i.record_id);
          return true;
        })
      );
    });
    visibles.forEach((r) => {
      const sitio = sitioDeClave(String(r.clave || ''));
      const delSitio = (incsPorSitio.get(sitio) || []).filter((i) => {
        if (usadas.has(i.record_id)) return false;
        usadas.add(i.record_id);
        return true;
      });
      if (delSitio.length) porRegistro.get(r.id)?.push(...delSitio);
    });
    return visibles.map((r) => ({
      reg: r,
      incidencias: porRegistro.get(r.id) || [],
    }));
  }, [visibles, incsPorCara, incsPorSitio]);

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
      // OSM estándar y no CARTO dark: CARTO empezó a exigir API key y sus
      // mosaicos salen tapizados de "API KEY REQUIRED" (visto sep-2026).
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 19,
      }).addTo(mapObj.current);
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
          {ordenes.map(({ reg: r, incidencias: incsDe }) => (
            <div key={r.id} style={{ display: 'grid', gap: 11 }}>
            <div className="inc">
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
                    {/* Sin municipio: ya viene dentro de la dirección de
                        arriba. El renglón es para la campaña y su versión. */}
                    <div className="meta">
                      {r.campana || ''}
                      {r.version
                        ? (r.campana ? ' · ' : '') + r.version
                        : ''}
                    </div>
                  </div>
                </div>
                <span
                  className="pill"
                  style={{
                    background:
                      ESTADO_FIJ[r.estado || '']?.bg || 'var(--panel2)',
                    color: ESTADO_FIJ[r.estado || '']?.fg || 'var(--muted)',
                    flexShrink: 0,
                  }}
                >
                  {r.estado}
                </span>
              </div>

              {/* Lo operativo como etiquetas cortas: producto, zona, corte,
                  catorcena compactada y quiénes van. Cada una solo si viene
                  con dato — la tabla de Mario trae varios campos a medias. */}
              <div
                className="chips"
                style={{
                  display: 'flex',
                  gap: 6,
                  flexWrap: 'wrap',
                  marginTop: 9,
                }}
              >
                {/* Sin producto: ya está implícito en la clave (EVA =
                    Ecovalla, MGV = Megavalla…). */}
                {r.zona && <span className="tag">Zona {r.zona}</span>}
                {r.asignacion && <span className="tag">{r.asignacion}</span>}
                {r.catorcena && (
                  <span className="tag">{catorcenaCorta(r.catorcena)}</span>
                )}
                {r.blanqueo_limpieza && (
                  <span className="tag">🧽 {r.blanqueo_limpieza}</span>
                )}
                {r.supervisor && (
                  <span className="tag">🧭 {r.supervisor}</span>
                )}
                {(r.responsable_de_cuadrilla || r.operadores_cuadrilla) && (
                  <span className="tag">
                    👥 {r.responsable_de_cuadrilla || r.operadores_cuadrilla}
                  </span>
                )}
              </div>

              {/* La fecha límite es lo más accionable de la orden: resaltada,
                  no enterrada en el meta. */}
              {r.fecha_limite && (
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--warn)',
                    fontWeight: 700,
                    marginTop: 8,
                  }}
                >
                  ⏳ Límite: {r.fecha_limite}
                </div>
              )}
              {r.notas_observa && <div className="obs">“{r.notas_observa}”</div>}
              {r.notas_motivo_bloqueo && (
                <div
                  style={{
                    fontSize: 12,
                    color: '#ffb4b4',
                    marginTop: 6,
                  }}
                >
                  🚫 Bloqueo: {r.notas_motivo_bloqueo}
                </div>
              )}
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
                {/* Orden ya trabajada: acceso a su evidencia y cuándo se
                    fijó, en lugar del botón de fijar. */}
                {(r.evidencia_url || r.foto_url) && (
                  <a
                    className="btn sm ghost"
                    href={r.evidencia_url || r.foto_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    📎 Evidencia
                  </a>
                )}
                {r.fecha_fijacion_real && (
                  <span
                    className="tag"
                    style={{ alignSelf: 'center' }}
                    title="Fecha real de fijación"
                  >
                    ✓ Fijado: {r.fecha_fijacion_real}
                  </span>
                )}
              </div>
            </div>

            {/* Incidencias de ESTA clave: ligadas a la parada pero en su
                propia tarjeta (no encimadas en la pauta). Mismo número de
                ubicación, en morado, para distinguir orden de incidencia de
                orden de pauta de un vistazo. */}
            {incsDe.map((inc) => (
              <div
                className="inc"
                key={inc.record_id}
                style={{ borderColor: 'var(--purple)' }}
              >
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
                    <span
                      className="order-badge"
                      style={{ background: 'var(--purple)' }}
                      title="Incidencia en esta ubicación"
                    >
                      {pinPorId.get(r.id) ?? '✕'}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="folio">
                        {inc.folio}{' '}
                        <span style={{ color: 'var(--purple)' }}>
                          · ⚠ INCIDENCIA
                        </span>
                      </div>
                      <div className="titulo">{inc.nombre_incidencia}</div>
                      <div className="meta">
                        {inc.medio ? inc.medio + ' · ' : ''}
                        {inc.clave_sitio}
                        {inc.lado || inc.clave_medio
                          ? ' · cara ' + caraIncidencia(inc)
                          : ''}
                        {inc.nivel ? ' · Nivel ' + inc.nivel : ''}
                      </div>
                      {inc.observaciones && (
                        <div className="obs">“{inc.observaciones}”</div>
                      )}
                      {inc.motivo_rechazo_reparacion &&
                        inc.estatus === 'en_proceso' &&
                        (inc.rechazos_reparacion || 0) > 0 && (
                          <div
                            style={{
                              fontSize: 12,
                              color: '#ffb4b4',
                              marginTop: 4,
                            }}
                          >
                            ↩ Reparación rechazada: “
                            {inc.motivo_rechazo_reparacion}”
                          </div>
                        )}
                    </div>
                  </div>
                  <span
                    className="pill"
                    style={{
                      background: (EST_COLOR[inc.estatus] || '#555') + '22',
                      color: EST_COLOR[inc.estatus] || '#aaa',
                      flexShrink: 0,
                    }}
                  >
                    {EST_LABEL[inc.estatus] || inc.estatus}
                  </span>
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
                  {inc.estatus === 'en_proceso' && (
                    <button
                      className="btn warn sm"
                      onClick={() => setReparando(inc)}
                    >
                      🔧 Registrar reparación
                    </button>
                  )}
                  {inc.estatus === 'reparado' && (
                    <span className="tag">
                      ✓ Reparada · esperando validación
                    </span>
                  )}
                </div>
              </div>
            ))}
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
              fotos.length > 0 &&
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

            {
              <>
                {/* Sin `capture`: forzaba la cámara y no dejaba elegir un
                    video ya grabado de la galería. El selector del teléfono
                    ya ofrece cámara o galería. */}
                <label
                  className="btn sm"
                  style={{
                    display: 'inline-block',
                    cursor: 'pointer',
                    marginBottom: 10,
                  }}
                >
                  📷 Agregar foto o video
                  <input
                    type="file"
                    accept="image/*,video/*"
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
                        {f.file.type.startsWith('video/') ? (
                          <video
                            src={f.preview}
                            muted
                            playsInline
                            style={{
                              width: '100%',
                              height: 90,
                              objectFit: 'cover',
                              borderRadius: 8,
                              border: '1px solid var(--line)',
                              background: '#000',
                            }}
                          />
                        ) : (
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
                        )}
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
                  {fotos.length} archivo(s) · mínimo uno, foto o video ·
                  puedes agregar varios
                </div>
              </>
            }

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
                {guardando ? 'Subiendo evidencia…' : 'Confirmar fijado'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* El MISMO modal de reparación que usa el módulo de incidencias: la
          cuadrilla captura diagnóstico/detalle/evidencia aquí y el flujo
          sigue idéntico (el validador aprueba o rechaza desde Incidencias). */}
      {reparando && (
        <RepararModal
          inc={reparando}
          email={email}
          onClose={() => setReparando(null)}
          onSave={(d) => guardarReparacion(reparando, d)}
        />
      )}
    </div>
  );
}

export default FijacionExternaView;
