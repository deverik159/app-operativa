// ============================================================
// src/modules/rutas/RutasView.tsx
// Fase 2: mapa coloreado por ruta + área sombreada (convex hull) + leyenda.
// Lee vw_rutas_con_coords y vw_rutas_resumen.
//
// (rutas, 5-oct-2026) Automatización del módulo:
//   · "+ Nueva ruta" sugiere el número y, al guardar, abre el ARMADO desde
//     el inventario (ArmarRutaModal). En Ecovallas Impreso no: ahí manda la
//     pauta (Pauta → Sincronizar rutas).
//   · El Excel genérico pasa por una vista previa que compara la dirección
//     de QTM con la del archivo y deja elegir cuál se queda.
//   · El mapa dibuja la línea del recorrido y el número de parada.
//   · El detalle muestra la dirección ELEGIDA, asigna monitoristas y enseña
//     el avance de visitas por catorcena.
// ============================================================
import { useState, useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import { cargarXlsx } from '../../lib/xlsxDiferido';
import { esErrorDeChunk } from '../../lib/cargaDiferida';
import { sb } from '../../lib/supabase';
import { escHtml } from '../../lib/helpers';
import { colorTono, fondoTono, type Tono } from '../../lib/tonos';
import { candadoTactil } from '../../lib/mapaTactil';
import { tope } from '../../lib/envios';
import { pareceSinRed } from '../../lib/enLinea';
import { haySesionReal } from '../../lib/datosLocales';
import { vigilarRender } from '../../lib/vigia';
import IrAqui from '../../components/IrAqui';
import ImportarKmlModal from './ImportarKmlModal';
import ImportarRutasExcelModal from './ImportarRutasExcelModal';
import ImportarRutasArchivoModal, { leerFilasArchivo, type FilaArchivo } from './ImportarRutasArchivoModal';
import ArmarRutaModal from './ArmarRutaModal';
import AsignarMonitoristas from './AsignarMonitoristas';
import AvanceVisitas from './AvanceVisitas';
import { tramosGoogleMaps, esNavegable } from '../../lib/navegacion';
import { convexHull } from '../../lib/convexHull';
import type { Pt } from '../../lib/convexHull';
import {
  colorSeguro,
  direccionElegida,
  esSegmentoDePauta,
  qtmDistinta,
  textoFalla,
  textoSobre,
  traerPaginado,
  TOPE_LECTURA_MS,
  type Resumen,
  type Ubic,
} from './rutasComun';

/**
 * Con más puntos que esto, la vista de "todas las rutas" se queda con los
 * círculos de siempre: 400 números y líneas cruzadas no se leen y en un
 * iPhone viejo el mapa se arrastra. Con una ruta enfocada siempre se
 * dibujan el recorrido y los números (rutas, 5-oct-2026).
 */
const MAX_PUNTOS_CON_RECORRIDO = 200;

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
  vigilarRender('RutasView');
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
  // Vía Verde es TODO Digital (columnas y pórticos): arranca ahí en Digital
  // para no abrir en un medio vacío (rutas, 5-oct-2026).
  const [unidad, setUnidad] = useState(unidadesVisibles[0] || 'Ecovallas');
  const [tipo, setTipo] = useState(unidadesVisibles[0] === 'Vía Verde' ? 'Digital' : 'Impreso');
  // Gestión de rutas (crear/editar)
  const [editando, setEditando] = useState<Partial<Resumen> | null>(null);
  const [guardando, setGuardando] = useState(false);
  /** El coordinador ya tecleó el número: la sugerencia que llegue tarde no lo pisa. */
  const numeroTocado = useRef(false);
  /** Cada apertura de "+ Nueva ruta" tiene su ficha: una sugerencia de una
   *  apertura anterior no cae en la siguiente. */
  const fichaNueva = useRef(0);
  // Importación de archivo
  const [importando, setImportando] = useState(false);
  const [resultadoImport, setResultadoImport] = useState<string>('');
  // Importación desde el KML de My Maps (rutas por capa). Es un modal aparte
  // porque necesita vista previa: el empate con inventario no es exacto.
  const [kmlAbierto, setKmlAbierto] = useState(false);
  // Importación desde el Excel de operación (clave + responsable). Para
  // Biobox éste es el camino bueno: identifica por clave, no por nombre.
  const [excelRutasAbierto, setExcelRutasAbierto] = useState(false);
  // Excel genérico ya leído, esperando su vista previa (rutas, 5-oct-2026).
  const [archivoLeido, setArchivoLeido] = useState<{
    nombre: string;
    filas: FilaArchivo[];
    descartadas: number;
  } | null>(null);
  // Armado de paradas (rutas, 5-oct-2026).
  const [armando, setArmando] = useState<{ ruta: Resumen; esNueva: boolean } | null>(null);
  // Detalle de ruta (modal con listado de ubicaciones)
  const [detalleRuta, setDetalleRuta] = useState<Resumen | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapObj = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  /** Ecovallas Impreso: las paradas salen de la pauta, no se arman aquí. */
  const dePauta = esSegmentoDePauta(unidad, tipo);

  /**
   * Carga del segmento. Paginada: PostgREST corta en silencio en 1000 filas
   * y una unidad grande ya se acerca (bug del lector, 5-oct-2026). Cada
   * página lleva tope. Una respuesta vieja (el usuario ya cambió de unidad)
   * se descarta con la ficha.
   */
  const fichaCarga = useRef(0);
  const cargar = async () => {
    const ficha = ++fichaCarga.current;
    setLoading(true);
    setErr('');
    const [u, r] = await Promise.all([
      traerPaginado<Ubic>((desde, hasta, senal) =>
        sb
          .from('vw_rutas_con_coords')
          .select('*')
          .eq('ruta_unidad', unidad)
          .eq('ruta_tipo', tipo)
          .order('ubicacion_id')
          .range(desde, hasta)
          .abortSignal(senal)
      ),
      traerPaginado<Resumen>((desde, hasta, senal) =>
        sb
          .from('vw_rutas_resumen')
          .select('*')
          .eq('unidad_negocio', unidad)
          .eq('tipo_medio', tipo)
          .order('numero')
          .order('id')
          .range(desde, hasta)
          .abortSignal(senal)
      ),
    ]);
    if (ficha !== fichaCarga.current) return;
    if (u.error) {
      setErr('No se pudieron cargar las ubicaciones: ' + textoFalla(u.error, u.sinRed));
      setLoading(false);
      return;
    }
    if (r.error) {
      setErr('No se pudo cargar el resumen: ' + textoFalla(r.error, r.sinRed));
      setLoading(false);
      return;
    }
    setUbics(u.filas);
    setResumen(r.filas);
    setLoading(false);
  };
  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unidad, tipo]);

  // Abrir modal para crear una ruta nueva (segmento = el activo)
  const nuevaRuta = () => {
    setErr('');
    numeroTocado.current = false;
    const ficha = ++fichaNueva.current;
    // Sugerencia inmediata con lo que ya está en pantalla (siguiente libre
    // del segmento) y luego la de la base, que ve también rutas que esta
    // pantalla no cargó. El número sigue siendo editable.
    const sugerido = resumen.reduce((m, r) => Math.max(m, Number(r.numero) || 0), 0) + 1;
    setEditando({
      numero: sugerido,
      nombre: '',
      color: '#ff5a3c',
      unidad_negocio: unidad,
      tipo_medio: tipo,
      activa: true,
    });
    void (async () => {
      const { data, error } = await sb
        .rpc('siguiente_numero_ruta', { p_unidad: unidad, p_tipo: tipo })
        .abortSignal(tope(TOPE_LECTURA_MS));
      const n = Number(data);
      if (error || !Number.isInteger(n) || n <= 0) return; // se queda la sugerencia local
      if (ficha !== fichaNueva.current || numeroTocado.current) return;
      setEditando((prev) => (prev && !prev.id ? { ...prev, numero: n } : prev));
    })();
  };
  // Abrir modal para editar una ruta existente
  const editarRuta = (r: Resumen) => {
    setErr('');
    fichaNueva.current++;
    setEditando({ ...r });
  };
  // Guardar (insert si es nueva, update si existe)
  const guardarRuta = async () => {
    if (!editando || guardando) return;
    if (editando.numero == null || String(editando.numero).trim() === '') {
      setErr('El número de ruta es obligatorio.');
      return;
    }
    if (!Number.isInteger(Number(editando.numero)) || Number(editando.numero) <= 0) {
      setErr('El número de ruta debe ser un entero mayor que cero.');
      return;
    }
    // El color va dentro del HTML del mapa: solo #rrggbb (rutas, 5-oct-2026).
    if (!/^#[0-9a-fA-F]{6}$/.test((editando.color || '').trim())) {
      setErr('El color debe ser como #ff5a3c (elígelo con el cuadro de color).');
      return;
    }
    setGuardando(true);
    setErr('');
    try {
      if (!(await haySesionReal())) {
        setErr('Tu sesión se está reconectando. Espera unos segundos y vuelve a tocar Guardar.');
        return;
      }
      const payload = {
        numero: Number(editando.numero),
        nombre: editando.nombre?.trim() || null,
        color: (editando.color || '#ff5a3c').trim(),
        unidad_negocio: editando.unidad_negocio || unidad,
        tipo_medio: editando.tipo_medio || tipo,
        activa: editando.activa ?? true,
      };
      // .select('id'): la RLS niega en silencio; sin fila de regreso, no se guardó.
      const resp = editando.id
        ? await sb
            .from('rutas_monitoreo')
            .update(payload)
            .eq('id', editando.id)
            .select('id')
            .abortSignal(tope(TOPE_LECTURA_MS))
        : await sb
            .from('rutas_monitoreo')
            .insert(payload)
            .select('id')
            .abortSignal(tope(TOPE_LECTURA_MS));
      const { data, error, status } = resp;
      if (error || status === 0) {
        // Detectar violación de unicidad del número de ruta y mostrar mensaje claro
        const msg = (error?.message || '').toLowerCase();
        if (msg.includes('duplicate') || msg.includes('unique') || error?.code === '23505') {
          setErr('Número de ruta duplicado, elige otro.');
        } else if (status === 0 || pareceSinRed(error, status)) {
          setErr('Sin señal o la red tardó demasiado: no se guardó. Vuelve a intentar.');
        } else {
          setErr('No se pudo guardar: ' + (error?.message || ''));
        }
        return;
      }
      const filas = (data as { id: number }[] | null) || [];
      if (filas.length === 0) {
        setErr('La base no aceptó el cambio (¿sin permiso de coordinador?).');
        return;
      }
      const eraNueva = !editando.id;
      setEditando(null);
      cargar();
      if (eraNueva) {
        const creada: Resumen = {
          id: filas[0].id,
          numero: payload.numero,
          nombre: payload.nombre,
          color: payload.color,
          unidad_negocio: payload.unidad_negocio,
          tipo_medio: payload.tipo_medio,
          activa: payload.activa,
          total_ubicaciones: 0,
          retiradas: 0,
          inhabilitadas: 0,
        };
        if (esSegmentoDePauta(payload.unidad_negocio, payload.tipo_medio)) {
          setResultadoImport(
            `Ruta ${payload.numero} creada. En Ecovallas Impreso las paradas salen de la pauta: ` +
              've a Pauta y Monitoreo → 🗺️ Sincronizar rutas.'
          );
        } else {
          setArmando({ ruta: creada, esNueva: true });
        }
      }
    } finally {
      setGuardando(false);
    }
  };

  // Leer el archivo Excel de rutas y abrir su VISTA PREVIA (rutas,
  // 5-oct-2026): antes se mandaba directo a importar_rutas, sin ver qué
  // dirección iba a quedar.
  const onArchivoImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportando(true);
    setResultadoImport('');
    setErr('');
    try {
      const buf = await file.arrayBuffer();
      const XLSX = await cargarXlsx();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
        defval: null,
      });
      // Columnas del archivo: Clave Nueva, Ruta, Secuencia, Dirección, Estatus, VALLAS
      const { filas, descartadas } = leerFilasArchivo(rows);
      if (filas.length === 0) {
        setErr(
          'No se encontraron filas válidas. Revisa que el archivo tenga las columnas: Clave Nueva, Ruta (número), Secuencia, Estatus, VALLAS y Dirección.'
        );
        return;
      }
      setArchivoLeido({ nombre: file.name, filas, descartadas });
    } catch (ex: any) {
      // Si lo que no llegó fue la librería (sin señal, o un despliegue nuevo
      // borró su chunk), el archivo está bien: decirlo, y en español
      // (revisión primer mes, 24-sep-2026).
      setErr(
        esErrorDeChunk(ex)
          ? 'No se pudo descargar el lector de Excel. Revisa tu señal e inténtalo de nuevo (si sigue fallando, recarga la app).'
          : 'No se pudo leer el archivo: ' + (ex.message || ex)
      );
    } finally {
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
        pts: (Pt & { u: Ubic })[];
      }
    >();
    for (const x of visibles) {
      if (!m.has(x.ruta_id))
        m.set(x.ruta_id, {
          color: colorSeguro(x.ruta_color),
          numero: x.ruta_numero,
          nombre: x.ruta_nombre,
          pts: [],
        });
      m.get(x.ruta_id)!.pts.push({ lat: x.lat, lng: x.lng, u: x });
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
      // OSM estándar y no CARTO dark: CARTO empezó a exigir API key y sus
      // mosaicos salen tapizados de "API KEY REQUIRED" (visto sep-2026).
      // El mapa queda claro sobre la interfaz oscura, pero se lee — que es
      // lo que un mapa con marca de agua ya no hacía.
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 19,
      }).addTo(mapObj.current);
    }
    if (layerRef.current) mapObj.current.removeLayer(layerRef.current);
    const grp = L.layerGroup();
    const todosLatLng: [number, number][] = [];
    // Recorrido (línea + número de parada) en la ruta enfocada, y en todas
    // si no son demasiados puntos (rutas, 5-oct-2026).
    let totalPts = 0;
    porRuta.forEach((r) => (totalPts += r.pts.length));
    const conRecorrido = rutaFoco != null || totalPts <= MAX_PUNTOS_CON_RECORRIDO;

    porRuta.forEach((ruta) => {
      // área sombreada (convex hull) si hay 3+ puntos
      if (ruta.pts.length >= 3) {
        const hull = convexHull(ruta.pts);
        const poly = hull.map((p) => [p.lat, p.lng]) as [number, number][];
        L.polygon(poly, {
          color: ruta.color,
          weight: 2,
          fillColor: ruta.color,
          fillOpacity: conRecorrido ? 0.08 : 0.15,
        }).addTo(grp);
      }
      // En orden de visita (sin secuencia, al final).
      const orden = ruta.pts
        .slice()
        .sort((a, b) => (a.u.secuencia ?? 99999) - (b.u.secuencia ?? 99999));
      if (conRecorrido) {
        const linea = orden
          .filter((p) => (p.u.estatus_archivo || '').toUpperCase() !== 'RETIRADA')
          .map((p) => [p.lat, p.lng] as [number, number]);
        if (linea.length > 1)
          L.polyline(linea, { color: ruta.color, weight: 3, opacity: 0.8 }).addTo(grp);
      }
      orden.forEach((p) => {
        todosLatLng.push([p.lat, p.lng]);
        const u = p.u;
        const otraQtm = qtmDistinta(u);
        // Todo va escapado: el nombre de la ruta y el estatus llegan de un
        // KML o Excel ajeno, y bindPopup inserta el string como HTML.
        const popup =
          `<b>Ruta ${escHtml(ruta.numero)}${ruta.nombre ? ' · ' + escHtml(ruta.nombre) : ''}</b>` +
          `${u.secuencia != null ? ` · parada ${escHtml(u.secuencia)}` : ''}<br>` +
          `${escHtml(u.site_id)}<br>${escHtml(direccionElegida(u))}<br>` +
          (otraQtm ? `<small style="opacity:.7">QTM: ${escHtml(otraQtm)}</small><br>` : '') +
          `<small>Caras: ${escHtml(u.caras_reales ?? '?')} en inventario` +
          `${u.vallas_archivo != null && u.vallas_archivo !== u.caras_reales ? ` (archivo: ${escHtml(u.vallas_archivo)})` : ''}` +
          `${u.estatus_archivo ? ` · ${escHtml(u.estatus_archivo)}` : ''}</small>`;
        if (conRecorrido) {
          const retirada = (u.estatus_archivo || '').toUpperCase() === 'RETIRADA';
          L.marker([p.lat, p.lng], {
            icon: L.divIcon({
              className: '',
              html:
                `<div class="rt-pin${retirada ? ' retirada' : ''}" ` +
                `style="background:${colorSeguro(ruta.color)};color:${textoSobre(ruta.color)}">` +
                `${u.secuencia != null ? escHtml(u.secuencia) : '·'}</div>`,
              iconSize: [26, 26],
              iconAnchor: [13, 13],
            }),
          })
            .bindPopup(popup)
            .addTo(grp);
        } else {
          L.circleMarker([p.lat, p.lng], {
            radius: 7,
            color: '#151515',
            weight: 1,
            fillColor: ruta.color,
            fillOpacity: 0.95,
          })
            .bindPopup(popup)
            .addTo(grp);
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [porRuta, loading]);

  // Pestaña del detalle de ruta (rutas, 5-oct-2026).
  const [pestanaDetalle, setPestanaDetalle] = useState<'paradas' | 'avance' | 'monitoristas'>('paradas');
  const abrirDetalle = (r: Resumen) => {
    setPestanaDetalle('paradas');
    setDetalleRuta(r);
  };
  const abrirArmado = (r: Resumen) => setArmando({ ruta: r, esNueva: false });

  // TODOS los modales viven fuera del contenido que cambia con `loading`,
  // en una posición FIJA del árbol (rutas, 5-oct-2026). Antes iban dentro de
  // cada rama (el div de "Cargando…" y el de la vista) en posiciones
  // distintas, así que React los desmontaba y volvía a montar al recargar:
  // el modal que llama a cargar() perdía su pantalla de resultado (con los
  // avisos de omitidas y sobrantes) y reaparecía pidiendo archivo. Ahora
  // se dibujan siempre en el mismo lugar y sobreviven a la recarga.
  const modales = (
    <>
      {/* Orden = apilado (mismo z-index): el detalle va DEBAJO del armado
          que se abre desde él. */}
      {editando && modalEditar()}
      {detalleRuta && modalDetalle(detalleRuta)}
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
          unidad={unidad}
          onClose={() => setExcelRutasAbierto(false)}
          onImportado={(resumen) => {
            setResultadoImport('Importación desde el Excel: ' + resumen);
            cargar();
          }}
        />
      )}
      {archivoLeido && (
        <ImportarRutasArchivoModal
          unidad={unidad}
          tipo={tipo}
          ubicsSegmento={ubics}
          nombreArchivo={archivoLeido.nombre}
          filas={archivoLeido.filas}
          descartadas={archivoLeido.descartadas}
          resumen={resumen}
          onClose={() => setArchivoLeido(null)}
          onImportado={(texto) => {
            setResultadoImport('Importación lista: ' + texto);
            cargar();
          }}
        />
      )}
      {armando && (
        <ArmarRutaModal
          key={armando.ruta.id}
          ruta={armando.ruta}
          esNueva={armando.esNueva}
          ubicsSegmento={ubics}
          onClose={() => setArmando(null)}
          onGuardado={(texto) => {
            setResultadoImport(texto);
            cargar();
          }}
        />
      )}
    </>
  );

  // .overlay/.modal del CSS global, no un overlay a mano: el casero
  // centraba con flex SIN scroll — con el teclado abierto en un
  // teléfono, el botón Guardar quedaba cortado e inalcanzable — y al
  // no llevar la clase .overlay tampoco se ocultaba el menú inferior.
  function modalEditar() {
    if (!editando) return null;
    const esNueva = !editando.id;
    const segPauta = esSegmentoDePauta(editando.unidad_negocio || unidad, editando.tipo_medio || tipo);
    return (
      <div
        className="overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget && !guardando) setEditando(null);
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
              {esNueva ? 'Nueva ruta' : 'Editar ruta'}
            </h3>
            <button
              className="btn sm ghost"
              onClick={() => setEditando(null)}
              disabled={guardando}
              aria-label="Cerrar"
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
                inputMode="numeric"
                value={editando.numero ?? ''}
                onChange={(e) => {
                  numeroTocado.current = true;
                  setEditando({
                    ...editando,
                    numero: e.target.value === '' ? undefined : Number(e.target.value),
                  });
                }}
                placeholder="1, 2, 3…"
              />
              {esNueva && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  Sugerido: el siguiente número libre de {editando.unidad_negocio} {editando.tipo_medio}. Puedes
                  cambiarlo.
                </div>
              )}
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
                  value={colorSeguro(editando.color)}
                  onChange={(e) =>
                    setEditando({ ...editando, color: e.target.value })
                  }
                  /* 44 de alto: mínimo táctil (38 quedaba corto). */
                  style={{ width: 56, height: 44, padding: 2 }}
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
              {esNueva && ' (del filtro actual)'}
              {esNueva && segPauta && (
                <div style={{ marginTop: 4 }}>
                  En Ecovallas Impreso las paradas salen de la pauta: después de crearla, llénala desde Pauta y
                  Monitoreo → 🗺️ Sincronizar rutas.
                </div>
              )}
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
              flexWrap: 'wrap',
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
              {guardando ? 'Guardando…' : esNueva && !segPauta ? 'Guardar y elegir paradas' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Mismo cambio que el modal de edición: .overlay scrollea completo,
  // así una ruta de 40 paradas se recorre con el scroll de la página
  // en vez de una lista interna encajonada en 85vh (que en iPhone,
  // con la barra de Safari visible, se pasaba del alto real).
  function modalDetalle(detalle: Resumen) {
    const segPauta = esSegmentoDePauta(detalle.unidad_negocio, detalle.tipo_medio);
    return (
      <div
        className="overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) setDetalleRuta(null);
        }}
      >
        <div
          className="modal"
          style={{ maxWidth: 680 }}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <span className="rt-color" style={{ background: colorSeguro(detalle.color) }}></span>
              <h3 style={{ margin: 0 }}>
                Ruta {detalle.numero}
                {detalle.nombre ? ` · ${detalle.nombre}` : ''}
              </h3>
            </div>
            <button
              className="btn sm ghost"
              onClick={() => setDetalleRuta(null)}
              aria-label="Cerrar"
            >
              ✕
            </button>
          </div>
          <p className="phint" style={{ marginTop: 0, marginBottom: 10 }}>
            {detalle.unidad_negocio} · {detalle.tipo_medio} · {ubicsDetalle.length} paradas · orden de visita por
            secuencia
          </p>

          <div className="rt-tabs" role="tablist" style={{ marginBottom: 10 }}>
            <button
              type="button"
              role="tab"
              aria-selected={pestanaDetalle === 'paradas'}
              className={'rt-tab' + (pestanaDetalle === 'paradas' ? ' on' : '')}
              onClick={() => setPestanaDetalle('paradas')}
            >
              Paradas
            </button>
            {/* (rutas, 5-oct-2026, revisión) Solo coordinador/manager: la
                regla de lectura de ruta_visitas le deja a cualquier otro
                solo SUS visitas y vería "0 de N" aunque la ruta esté hecha. */}
            {puedeGestionar && (
              <button
                type="button"
                role="tab"
                aria-selected={pestanaDetalle === 'avance'}
                className={'rt-tab' + (pestanaDetalle === 'avance' ? ' on' : '')}
                onClick={() => setPestanaDetalle('avance')}
              >
                Avance de visitas
              </button>
            )}
            {puedeGestionar && (
              <button
                type="button"
                role="tab"
                aria-selected={pestanaDetalle === 'monitoristas'}
                className={'rt-tab' + (pestanaDetalle === 'monitoristas' ? ' on' : '')}
                onClick={() => setPestanaDetalle('monitoristas')}
              >
                Monitoristas
              </button>
            )}
          </div>

          {pestanaDetalle === 'avance' && puedeGestionar && <AvanceVisitas ruta={detalle} paradas={ubicsDetalle} />}
          {pestanaDetalle === 'monitoristas' && puedeGestionar && <AsignarMonitoristas ruta={detalle} />}

          {pestanaDetalle === 'paradas' && (
            <>
              {puedeGestionar && !segPauta && (
                <div style={{ marginBottom: 10 }}>
                  <button type="button" className="btn sm" onClick={() => abrirArmado(detalle)}>
                    🧩 Armar / editar paradas
                  </button>
                </div>
              )}
              {segPauta && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
                  En Ecovallas Impreso las paradas y su orden salen de la pauta (Pauta y Monitoreo → 🗺️
                  Sincronizar rutas).
                </div>
              )}

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
                      style={{ background: fondoTono('ambar'), color: colorTono('ambar') }}
                      title="Estas ubicaciones no tienen coordenadas en el inventario"
                    >
                      ⚠ {sinCoordsDetalle} sin coordenadas
                    </span>
                  )}
                </div>
              )}

              {ubicsDetalle.length === 0 && (
                <div className="empty" style={{ padding: 20 }}>
                  Esta ruta todavía no tiene paradas.
                </div>
              )}

              {/* Sin overflowY:'auto': era residuo del 85vh que se quitó y,
                  sin maxHeight, nunca scrollea en vertical pero SÍ convierte
                  la caja en contenedor de scroll horizontal (overflow-x
                  computa a auto): cualquier hijo pasado un pixel generaba
                  arrastre lateral dentro del modal en vez de fluir. */}
              <div style={{ display: 'grid', gap: 6 }}>
                {ubicsDetalle.map((u) => {
                  const est = (u.estatus_archivo || '').toUpperCase();
                  const esRetirada = est === 'RETIRADA';
                  const esInhab = est === 'INHABILITADA';
                  // Tono y no hex: se pinta con su pareja legible en el tema
                  // claro (tema claro/oscuro, 24-sep-2026).
                  const tonoEst: Tono = esRetirada
                    ? 'rojo'
                    : esInhab
                      ? 'ambar'
                      : 'verde';
                  // La dirección ELEGIDA al importar (QTM o archivo); si se
                  // eligió la del archivo y QTM dice otra cosa, la de QTM va
                  // en gris debajo (rutas, 5-oct-2026).
                  const dir = direccionElegida(u);
                  const otraQtm = qtmDistinta(u);
                  return (
                    // flexWrap + base de 160px en el texto: sin ellos, la
                    // pill "Inhabilitada" + el botón Ir (fijos) exprimían la
                    // dirección a ~78px y cada fila medía el triple de alto.
                    <div
                      key={u.ubicacion_id}
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'flex-start',
                        gap: 10,
                        padding: '8px 10px',
                        borderRadius: 9,
                        background: 'var(--panel2)',
                        border: '1px solid var(--line)',
                        opacity: esRetirada ? 0.6 : 1,
                      }}
                    >
                      <span className="rt-num-neutro">{u.secuencia ?? '—'}</span>
                      <div style={{ flex: '1 1 160px', minWidth: 0 }}>
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
                          {dir || '(sin dirección)'}
                        </div>
                        {otraQtm && (
                          <div className="rt-dir-qtm">QTM: {otraQtm}</div>
                        )}
                      </div>
                      {est && est !== 'ACTIVA' && (
                        <span
                          className="pill"
                          style={{
                            background: fondoTono(tonoEst),
                            color: colorTono(tonoEst),
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
            </>
          )}
        </div>
      </div>
    );
  }

  // Un coordinador sin ninguna unidad con rutas (p. ej. Verde Vertical):
  // antes caía en 'Ecovallas' con el selector vacío y "+ Nueva ruta"
  // creaba rutas en una unidad que no es suya (bug del lector, 5-oct-2026).
  if (unidadesVisibles.length === 0)
    return (
      <div>
        <h2 className="page">Rutas de Monitoreo</h2>
        <div className="empty">
          Tus unidades de negocio no tienen rutas de monitoreo (solo Ecovallas, Biobox y Vía Verde).
        </div>
      </div>
    );

  return (
    <>
      {loading ? (
        <div className="loading" style={{ textAlign: 'center', color: 'var(--muted)', padding: 60 }}>
          Cargando rutas…
        </div>
      ) : (
        <div>
          <h2 className="page">Rutas de Monitoreo</h2>
          <p className="phint">
            Ubicaciones agrupadas por ruta geográfica. Cada ruta con su color, área y el orden de sus paradas.
          </p>

          <div className="toolbar">
            <span className="tag">Unidad de negocio:</span>
            {/* Sin width:'auto' inline: la clase .toolbar ya lo da en escritorio
                y el inline anulaba el apilado a ancho completo en celular. */}
            <select
              value={unidad}
              onChange={(e) => {
                setUnidad(e.target.value);
                // Vía Verde no tiene Impreso: columnas y pórticos son Digital.
                if (e.target.value === 'Vía Verde') setTipo('Digital');
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
              value={tipo}
              onChange={(e) => {
                setTipo(e.target.value);
                setRutaFoco(null);
              }}
            >
              {/* (rutas, 5-oct-2026, QA) Vía Verde no tiene Impreso: ni se ofrece. */}
              {unidad !== 'Vía Verde' && <option value="Impreso">Impreso</option>}
              <option value="Digital">Digital</option>
            </select>
            {puedeGestionar && (
              <button className="btn sm" onClick={nuevaRuta}>
                + Nueva ruta
              </button>
            )}
            {/* Los importadores son POR UNIDAD, no un menú fijo: los tres
                botones juntos confundían — dos son exclusivos de Biobox (el
                Excel de operación y el mapa KML) y el genérico es el Excel de
                rutas de las demás unidades (Erik, 22-sep-2026). Cada unidad ve
                solo sus caminos, con etiqueta de qué archivo espera. */}
            {puedeGestionar && unidad !== 'Biobox' && (
              <label
                className="btn sm ghost"
                style={{ display: 'inline-block', cursor: 'pointer' }}
                title={`Excel con columnas: Clave Nueva, Ruta, Secuencia, Estatus, VALLAS, Dirección. Importa a ${unidad} ${tipo}.`}
              >
                {importando ? 'Leyendo archivo…' : `📥 Importar rutas de ${unidad} (Excel)`}
                <input
                  type="file"
                  accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                  style={{ display: 'none' }}
                  onChange={onArchivoImport}
                  disabled={importando}
                />
              </label>
            )}
            {puedeGestionar && unidad === 'Biobox' && (
              <button
                className="btn sm"
                onClick={() => setExcelRutasAbierto(true)}
                title="Una fila por máquina: clave y responsable. Empata por clave exacta — el camino recomendado."
              >
                🧾 Rutas Biobox: Excel de operación
              </button>
            )}
            {puedeGestionar && unidad === 'Biobox' && (
              <button
                className="btn sm ghost"
                onClick={() => setKmlAbierto(true)}
                title="Las capas del mapa de My Maps se convierten en rutas. Empata por nombre de máquina, menos preciso que el Excel."
              >
                🗺️ Rutas Biobox: mapa (KML)
              </button>
            )}
          </div>

          {/* La ayuda de los importadores VISIBLE (los title no existen en
              táctil): qué archivo espera cada botón de esta unidad. */}
          {puedeGestionar && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                margin: '-6px 0 14px',
                lineHeight: 1.5,
              }}
            >
              {dePauta ? (
                <>
                  En <b>Ecovallas Impreso</b> manda la pauta: las paradas y su orden salen de{' '}
                  <b>🗺️ Sincronizar rutas</b> en Pauta y Monitoreo (no se arman a mano). El 📥 Excel de rutas
                  sigue disponible; antes de importar te enseña las direcciones que no coinciden con QTM.
                </>
              ) : (
                <>
                  <b>+ Nueva ruta</b> la arma desde el inventario de {unidad} {tipo}: eliges los sitios en la
                  lista o en el mapa y se ordenan por cercanía.{' '}
                  {unidad === 'Biobox' ? (
                    <>
                      También por archivo: 🧾 <b>Excel de operación</b> (clave + responsable, el recomendado) o
                      🗺️ <b>mapa KML</b> (empata por nombre, menos preciso).
                    </>
                  ) : (
                    <>
                      También por archivo: 📥 <b>Excel de rutas</b> con columnas Clave Nueva, Ruta, Secuencia,
                      Estatus, VALLAS y Dirección (antes de importar eliges qué dirección se queda).
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {resultadoImport && (
            // Los colores eran una copia en línea de los de .banner: sin ellos,
            // la clase pone los del tema activo (tema claro/oscuro, 24-sep-2026).
            <div
              className="banner"
              style={{
                fontSize: 13,
                padding: '10px 12px',
                borderRadius: 10,
                marginBottom: 14,
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
              }}
            >
              <span style={{ flex: 1 }}>{resultadoImport}</span>
              <button
                type="button"
                className="btn-icono"
                style={{ minWidth: 32, minHeight: 32 }}
                onClick={() => setResultadoImport('')}
                aria-label="Cerrar aviso"
              >
                ✕
              </button>
            </div>
          )}

          {err && !editando && <div className="err">{err}</div>}

          {resumen.length === 0 && (
            <div className="empty">
              Aún no hay rutas de {unidad} {tipo}.{' '}
              {puedeGestionar
                ? dePauta
                  ? 'Créalas desde Pauta y Monitoreo → 🗺️ Sincronizar rutas, o impórtalas con el Excel de rutas.'
                  : 'Créalas con «+ Nueva ruta» (se arman desde el inventario) o impórtalas desde un archivo.'
                : 'Pídele a tu coordinador que las cree.'}
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
                        borderLeft: `5px solid ${colorSeguro(r.color)}`,
                        opacity: rutaFoco == null || rutaFoco === r.id ? 1 : 0.5,
                      }}
                      onClick={() => setRutaFoco(rutaFoco === r.id ? null : r.id)}
                    >
                      {/* flexWrap + minWidth:0: sin ellos, en un teléfono el
                          texto de la ruta quedaba exprimido en ~170px partido en
                          varios renglones y los botones 📋 ✏️ pegados sin
                          separación (mistap garantizado). */}
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 8,
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            minWidth: 0,
                            flex: '1 1 180px',
                          }}
                        >
                          <span className="rt-color" style={{ background: colorSeguro(r.color) }}></span>
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
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            flexShrink: 0,
                            flexWrap: 'wrap',
                          }}
                        >
                          {!r.activa && <span className="tag">inactiva</span>}
                          {puedeGestionar && !dePauta && (
                            <button
                              className="btn ghost sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                abrirArmado(r);
                              }}
                              aria-label={`Armar o editar las paradas de la Ruta ${r.numero}`}
                            >
                              🧩 Paradas
                            </button>
                          )}
                          <button
                            className="btn ghost sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              abrirDetalle(r);
                            }}
                            title="Ver ubicaciones, avance y monitoristas"
                            aria-label={`Ver detalle de la Ruta ${r.numero}`}
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
                              aria-label={`Editar nombre y color de la Ruta ${r.numero}`}
                            >
                              ✏️
                            </button>
                          )}
                        </div>
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
        </div>
      )}
      {modales}
    </>
  );
}

export default RutasView;
