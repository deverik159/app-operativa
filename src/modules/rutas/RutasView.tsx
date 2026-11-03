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
import { ClipboardList, Download, FileSpreadsheet, Map as MapIcon, Pencil, Puzzle, Trash2 } from 'lucide-react';
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
import { subirYLuego } from '../../lib/subirAntes';
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
import Ic from '../../components/Ic';
import {
  admiteCombinada,
  colorSeguro,
  direccionElegida,
  esSegmentoDePauta,
  FILTRO_AMBOS,
  MEDIO_COMBINADA,
  nombreCorto,
  qtmDistinta,
  textoMedio,
  textoFalla,
  textoSobre,
  TODOS_COORDINADORES,
  traerPaginado,
  TOPE_LECTURA_MS,
  TOPE_RPC_MS,
  type ContextoRutas,
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
  // El coordinador de una sola unidad ve SOLO las rutas de la suya; los
  // botones de unidad le ofrecen únicamente sus opciones (Erik, ago-2026).
  const unidadesVisibles = UNIDADES_CON_RUTAS.filter((u) =>
    unidades.includes(u)
  );
  const [loading, setLoading] = useState(true);
  /** Ya terminó la primera carga: las siguientes (cambio de unidad o medio,
   *  después de importar) NO cambian la pantalla por "Cargando rutas…": lo
   *  anterior se queda atenuado hasta que llega lo nuevo, sin parpadeo ni
   *  brinco de la página (5-oct-2026). OJO: esto NO era la causa del menú
   *  flotante en iPhone; ver el comentario de los botones de unidad. */
  const [yaCargo, setYaCargo] = useState(false);
  const recargando = loading && yaCargo;
  const [err, setErr] = useState('');
  const [ubics, setUbics] = useState<Ubic[]>([]);
  const [resumen, setResumen] = useState<Resumen[]>([]);
  const [rutaFoco, setRutaFoco] = useState<number | null>(null); // null = todas
  // Unidad + medio activos. Arranca en la primera unidad del usuario.
  // Vía Verde es TODO Digital (columnas y pórticos): arranca ahí en Digital
  // para no abrir en un medio vacío (rutas, 5-oct-2026).
  const [unidad, setUnidad] = useState(unidadesVisibles[0] || 'Ecovallas');
  const [tipo, setTipo] = useState(unidadesVisibles[0] === 'Vía Verde' ? 'Digital' : 'Impreso');
  // Los roles se actualizan sin recargar (431d4c7): si al usuario le quitan
  // la unidad que tiene abierta, pasa a la primera que sí tiene en vez de
  // quedarse consultando una ajena sin ningún botón marcado. Depende del
  // texto y no del arreglo, que se arma de nuevo en cada render.
  const firmaUnidades = unidadesVisibles.join('|');
  useEffect(() => {
    if (unidadesVisibles.length === 0 || unidadesVisibles.includes(unidad)) return;
    const u = unidadesVisibles[0];
    setUnidad(u);
    setTipo(u === 'Vía Verde' ? 'Digital' : 'Impreso');
    setRutaFoco(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firmaUnidades]);
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
  /** Botón "Ambos" (Biobox): todas las rutas de la unidad, y "+ Nueva
   *  ruta" crea una Combinada (Erik, 19-oct-2026). */
  const verAmbos = tipo === FILTRO_AMBOS;
  /** Medio con el que nace una ruta nueva en este filtro. */
  const tipoNueva = verAmbos ? MEDIO_COMBINADA : tipo;
  /** "Biobox" con Ambos (son todas), "Biobox Digital" con un medio. */
  const segmentoTxt = verAmbos ? unidad : `${unidad} ${tipo}`;

  // ---------------------------------------------------------
  // Rutas por coordinador (Erik, 22-oct-2026)
  // ---------------------------------------------------------
  /** Quién soy y a qué coordinadores puedo ver, por unidad (rutas_contexto).
   *  Hasta que llega no se cargan rutas: un coordinador nunca ve, ni por un
   *  momento, las rutas de otro. */
  const [ctx, setCtx] = useState<{ unidad: string; datos: ContextoRutas } | null>(null);
  const [errCtx, setErrCtx] = useState('');
  const [intentoCtx, setIntentoCtx] = useState(0);
  /** Filtro del manager: correo del coordinador o TODOS_COORDINADORES. */
  const [filtroCoord, setFiltroCoord] = useState(TODOS_COORDINADORES);
  useEffect(() => {
    let vivo = true;
    setErrCtx('');
    void (async () => {
      const { data, error, status } = await sb
        .rpc('rutas_contexto', { p_unidad: unidad })
        .abortSignal(tope(TOPE_LECTURA_MS));
      if (!vivo) return;
      if (error || status === 0 || !data) {
        setErrCtx(
          'No pude saber cuáles rutas son tuyas. ' +
            textoFalla(error?.message || null, status === 0 || pareceSinRed(error, status))
        );
        return;
      }
      const d = data as ContextoRutas;
      setCtx({ unidad, datos: { ...d, coordinadores: d.coordinadores || [] } });
      // Un coordinador del filtro que no existe en esta unidad se quita.
      setFiltroCoord((f) =>
        f && !(d.coordinadores || []).some((c) => c.email === f) ? TODOS_COORDINADORES : f
      );
    })();
    return () => {
      vivo = false;
    };
  }, [unidad, intentoCtx]);
  const ctxListo = ctx != null && ctx.unidad === unidad;
  const esManager = !!(ctxListo && ctx!.datos.es_manager);
  /** De quién son las rutas en pantalla: el coordinador, las suyas; el
   *  manager, las del filtro ('' = de todos). null = aún no se sabe. */
  const duenoVista: string | null = !ctxListo ? null : esManager ? filtroCoord : ctx!.datos.yo;
  /** Con qué dueño se crea o importa: null si el manager está en "Todos"
   *  (tiene que elegir a alguien antes; Erik, 22-oct-2026). */
  const duenoAccion: string | null = duenoVista || null;
  const nombreDe = (email: string | null | undefined): string =>
    (ctxListo && ctx!.datos.coordinadores.find((c) => c.email === email)?.nombre) || '';

  /**
   * En iPhone/iPad, cambiar de unidad o medio ARRANCA ARRIBA, como cambiar de módulo
   * (84cfe3f). En el iPhone (iOS 27, app instalada), pasar de una unidad con
   * muchas rutas a una con pocas (Ecovallas → Vía Verde) con la página
   * desplazada dejaba el menú inferior y la barra de arriba colocados como si
   * el scroll fuera 0: el menú a media pantalla sobre el mapa y la barra
   * fuera de la vista. El desfase medía lo mismo que el scroll (Erik,
   * 5-oct-2026). Primero se sube y, ya arriba (dos cuadros después, para que
   * iOS aplique el scroll antes del cambio de alto), cambia el contenido.
   * Lo mismo cuando LLEGAN los datos de otra unidad (ver cargar): si mientras
   * decía "Actualizando…" se bajó la página, se vuelve a subir antes de que
   * el documento se encoja. El remedio vive en lib/subirAntes.ts (también lo
   * usan Pauta y Fijación).
   */
  /** Cada toque de unidad/medio tiene su ficha: si llega otro antes de que
   *  se aplique el anterior (diferido dos cuadros), manda el más nuevo. */
  const fichaSegmento = useRef(0);
  /** Unidad y medio tocados que aún no se aplican (para el siguiente toque). */
  const segmentoPendiente = useRef<{ u: string; t: string } | null>(null);
  const cambiarSegmento = (u: string, t: string) => {
    const f = ++fichaSegmento.current;
    segmentoPendiente.current = { u, t };
    subirYLuego(() => {
      if (f !== fichaSegmento.current) return;
      segmentoPendiente.current = null;
      setUnidad(u);
      setTipo(t);
      setRutaFoco(null);
    });
  };

  /**
   * Carga del segmento. Paginada: PostgREST corta en silencio en 1000 filas
   * y una unidad grande ya se acerca (bug del lector, 5-oct-2026). Cada
   * página lleva tope. Una respuesta vieja (el usuario ya cambió de unidad)
   * se descarta con la ficha.
   */
  const fichaCarga = useRef(0);
  /** De qué unidad|medio son las rutas que están en pantalla. */
  const segmentoEnPantalla = useRef('');
  const cargar = async () => {
    // Sin saber de quién son, no se carga nada (ver ctx).
    if (duenoVista == null) return;
    const ficha = ++fichaCarga.current;
    const dueno = duenoVista;
    const segmento = unidad + '|' + tipo + '|' + dueno;
    setLoading(true);
    setErr('');
    // "Ambos" = sin filtro de medio: Impreso, Digital y Combinadas juntas.
    const ambos = tipo === FILTRO_AMBOS;
    const [u, r] = await Promise.all([
      traerPaginado<Ubic>((desde, hasta, senal) => {
        let c = sb.from('vw_rutas_con_coords').select('*').eq('ruta_unidad', unidad);
        if (!ambos) c = c.eq('ruta_tipo', tipo);
        // Cada coordinador, solo sus rutas (Erik, 22-oct-2026).
        if (dueno) c = c.eq('ruta_coordinador', dueno);
        return c.order('ubicacion_id').range(desde, hasta).abortSignal(senal);
      }),
      traerPaginado<Resumen>((desde, hasta, senal) => {
        let c = sb.from('vw_rutas_resumen').select('*').eq('unidad_negocio', unidad);
        if (!ambos) c = c.eq('tipo_medio', tipo);
        if (dueno) c = c.eq('coordinador_email', dueno);
        // Con Ambos, agrupadas por medio (Combinada, Digital, Impreso).
        if (ambos) c = c.order('tipo_medio');
        return c.order('numero').order('id').range(desde, hasta).abortSignal(senal);
      }),
    ]);
    if (ficha !== fichaCarga.current) return;
    setYaCargo(true);
    // Datos de OTRA unidad o medio: el alto cambia mucho; se aplican con la
    // página arriba (ver subirYLuego). Del mismo segmento, de inmediato.
    const aplicar = (fn: () => void) => {
      if (segmentoEnPantalla.current === segmento) fn();
      else
        subirYLuego(() => {
          if (ficha === fichaCarga.current) fn();
        });
    };
    if (u.error || r.error) {
      setErr(
        u.error
          ? 'No se pudieron cargar las ubicaciones: ' + textoFalla(u.error, u.sinRed)
          : 'No se pudo cargar el resumen: ' + textoFalla(r.error, r.sinRed)
      );
      // Lo que quedó en pantalla es de OTRA unidad o medio: no se deja
      // debajo del selector nuevo como si fuera de éste.
      aplicar(() => {
        if (segmentoEnPantalla.current !== segmento) {
          setUbics([]);
          setResumen([]);
          segmentoEnPantalla.current = segmento;
        }
        setLoading(false);
      });
      return;
    }
    aplicar(() => {
      setUbics(u.filas);
      setResumen(r.filas);
      segmentoEnPantalla.current = segmento;
      setLoading(false);
    });
  };
  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unidad, tipo, duenoVista]);

  // Abrir modal para crear una ruta nueva (segmento = el activo)
  const nuevaRuta = () => {
    // El manager en "Todos" tiene que elegir de quién es (el botón ya lo dice).
    if (!duenoAccion) return;
    setErr('');
    numeroTocado.current = false;
    const ficha = ++fichaNueva.current;
    // Sugerencia inmediata con lo que ya está en pantalla (siguiente libre
    // del segmento) y luego la de la base, que ve también rutas que esta
    // pantalla no cargó. El número sigue siendo editable.
    // Con "Ambos" en pantalla hay rutas de los tres medios: el número es
    // por medio (UNIQUE numero+unidad+medio), así que solo cuentan las del
    // medio con que nace la nueva.
    // Del 900 en adelante son las foráneas de Pauta (EDOMEX 901, PLAZA 902;
    // 19-oct-2026): no cuentan para el número siguiente.
    const sugerido =
      resumen
        .filter((r) => r.tipo_medio === tipoNueva && Number(r.numero) < 900)
        .reduce((m, r) => Math.max(m, Number(r.numero) || 0), 0) + 1;
    setEditando({
      numero: sugerido,
      nombre: '',
      color: '#ff5a3c',
      unidad_negocio: unidad,
      tipo_medio: tipoNueva,
      activa: true,
      coordinador_email: duenoAccion,
      coordinador_nombre: nombreDe(duenoAccion),
    });
    void (async () => {
      // Numeración por coordinador (22-oct-2026).
      const { data, error } = await sb
        .rpc('siguiente_numero_ruta', { p_unidad: unidad, p_tipo: tipoNueva, p_coordinador: duenoAccion })
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
  // Eliminar la ruta completa (Erik, 22-oct-2026). Primero la base cuenta
  // lo que se va (paradas, monitoristas asignados, visitas, revisiones) y
  // se confirma con esos números; luego se borra en una sola llamada.
  const [eliminando, setEliminando] = useState(false);
  const eliminarRuta = async () => {
    if (!editando?.id || eliminando) return;
    const id = editando.id;
    setEliminando(true);
    setErr('');
    try {
      if (!(await haySesionReal())) {
        setErr('Tu sesión se está reconectando. Espera unos segundos y vuelve a intentarlo.');
        return;
      }
      type RespEliminar = {
        ok?: boolean;
        numero?: number;
        nombre?: string | null;
        paradas?: number;
        monitoristas?: number;
        visitas?: number;
        revisiones?: number;
      };
      const cuenta = await sb
        .rpc('eliminar_ruta', { p_ruta_id: id, p_solo_contar: true })
        .abortSignal(tope(TOPE_LECTURA_MS));
      if (cuenta.error || cuenta.status === 0) {
        setErr(
          'No se pudo eliminar: ' +
            textoFalla(cuenta.error?.message || null, cuenta.status === 0 || pareceSinRed(cuenta.error, cuenta.status))
        );
        return;
      }
      const c = (cuenta.data || {}) as RespEliminar;
      const partes = [
        `${c.paradas ?? 0} ${c.paradas === 1 ? 'parada' : 'paradas'}`,
        c.monitoristas ? `${c.monitoristas} ${c.monitoristas === 1 ? 'monitorista asignado (le llega aviso)' : 'monitoristas asignados (les llega aviso)'}` : '',
        c.visitas ? `${c.visitas} visitas marcadas (se conservan, sin ruta)` : '',
        c.revisiones ? `${c.revisiones} revisiones de máquinas (se conservan, sin ruta)` : '',
      ].filter(Boolean);
      if (
        !confirm(
          `¿Eliminar la Ruta ${c.numero ?? editando.numero}${c.nombre ? ' · ' + c.nombre : ''}?\n\n` +
            `Se va con: ${partes.join(', ')}.\n\nNo se puede deshacer. Si solo quieres dejar de usarla, ` +
            'mejor desmarca «Ruta activa».'
        )
      )
        return;
      const r = await sb
        .rpc('eliminar_ruta', { p_ruta_id: id, p_solo_contar: false })
        .abortSignal(tope(TOPE_RPC_MS));
      if (r.error || r.status === 0) {
        setErr(
          'No se eliminó: ' +
            textoFalla(r.error?.message || null, r.status === 0 || pareceSinRed(r.error, r.status))
        );
        return;
      }
      const hecho = (r.data || {}) as RespEliminar;
      setEditando(null);
      if (detalleRuta?.id === id) setDetalleRuta(null);
      if (rutaFoco === id) setRutaFoco(null);
      setResultadoImport(
        `Ruta ${hecho.numero ?? ''}${hecho.nombre ? ' · ' + hecho.nombre : ''} eliminada ` +
          `(${hecho.paradas ?? 0} paradas${hecho.monitoristas ? `, ${hecho.monitoristas} monitoristas avisados` : ''}).`
      );
      cargar();
    } finally {
      setEliminando(false);
    }
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
        tipo_medio: editando.tipo_medio || tipoNueva,
        activa: editando.activa ?? true,
      };
      // .select('id'): la RLS niega en silencio; sin fila de regreso, no se guardó.
      // Al crear va el dueño (el del filtro); al editar no se toca.
      const resp = editando.id
        ? await sb
            .from('rutas_monitoreo')
            .update(payload)
            .eq('id', editando.id)
            .select('id')
            .abortSignal(tope(TOPE_LECTURA_MS))
        : await sb
            .from('rutas_monitoreo')
            .insert({ ...payload, coordinador_email: editando.coordinador_email || duenoAccion })
            .select('id')
            .abortSignal(tope(TOPE_LECTURA_MS));
      const { data, error, status } = resp;
      if (error || status === 0) {
        // Detectar violación de unicidad del número de ruta y mostrar mensaje claro
        const msg = (error?.message || '').toLowerCase();
        if (msg.includes('duplicate') || msg.includes('unique') || error?.code === '23505') {
          setErr('Ya tienes una ruta con ese número en esta unidad y medio: elige otro.');
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
          coordinador_email: editando.coordinador_email || duenoAccion,
          coordinador_nombre: editando.coordinador_nombre || nombreDe(duenoAccion),
        };
        if (esSegmentoDePauta(payload.unidad_negocio, payload.tipo_medio)) {
          setResultadoImport(
            `Ruta ${payload.numero} creada. En Ecovallas Impreso las paradas salen de la pauta: ` +
              've a Pauta y Monitoreo → Sincronizar rutas.'
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
    // Mientras llegan las rutas de otra unidad o medio no se redibuja con las
    // viejas: el mapa se vuelve a dibujar una sola vez, con lo nuevo (antes
    // se dibujaba dos veces, y la primera justo al cerrarse el selector).
    if (!mapRef.current || loading) return;
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
      // Sin animación: el salto de zoom animado era más trabajo de pantalla
      // justo cuando iOS reacomoda la vista (bug del menú, 5-oct-2026).
      if (todosLatLng.length === 1)
        mapObj.current.setView(todosLatLng[0], 14, { animate: false });
      else if (todosLatLng.length > 1)
        mapObj.current.fitBounds(todosLatLng, {
          padding: [40, 40],
          maxZoom: 15,
          animate: false,
        });
    };
    ajustar();
    setTimeout(ajustar, 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [porRuta, loading]);

  // Pestaña del detalle de ruta (rutas, 5-oct-2026).
  const [pestanaDetalle, setPestanaDetalle] = useState<'paradas' | 'avance' | 'monitoristas' | 'tecnicos'>('paradas');
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
          coordinador={duenoAccion}
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
          coordinador={duenoAccion}
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
          coordinador={duenoAccion}
          coordinadorNombre={nombreDe(duenoAccion)}
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
    const segPauta = esSegmentoDePauta(editando.unidad_negocio || unidad, editando.tipo_medio || tipoNueva);
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
                  Sugerido: el siguiente número libre de {editando.unidad_negocio}{' '}
                  {editando.tipo_medio === MEDIO_COMBINADA ? 'en rutas combinadas' : editando.tipo_medio}. Puedes
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
              <b>{textoMedio(editando.tipo_medio || tipoNueva)}</b>
              {esNueva && ' (del filtro actual)'}
              {/* De quién es: solo le sirve al manager, que ve las de todos. */}
              {esManager && (editando.coordinador_nombre || editando.coordinador_email) && (
                <div style={{ marginTop: 4 }}>
                  Coordinador: <b>{editando.coordinador_nombre || editando.coordinador_email}</b>
                </div>
              )}
              {esNueva && editando.tipo_medio === MEDIO_COMBINADA && (
                <div style={{ marginTop: 4 }}>
                  Ruta combinada: acepta máquinas Impreso y Digital de {editando.unidad_negocio}.
                </div>
              )}
              {esNueva && segPauta && (
                <div style={{ marginTop: 4 }}>
                  En Ecovallas Impreso las paradas salen de la pauta: después de crearla, llénala desde Pauta y
                  Monitoreo → <Ic i={MapIcon} />Sincronizar rutas.
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
            {/* Eliminar va a la izquierda, lejos de Guardar (Erik, 22-oct-2026). */}
            {!esNueva && (
              <button
                type="button"
                className="btn sm warn"
                style={{ marginRight: 'auto' }}
                onClick={eliminarRuta}
                disabled={guardando || eliminando}
              >
                <Ic i={Trash2} />
                {eliminando ? 'Revisando…' : 'Eliminar ruta'}
              </button>
            )}
            <button
              className="btn ghost sm"
              onClick={() => setEditando(null)}
              disabled={guardando || eliminando}
            >
              Cancelar
            </button>
            <button className="btn ok" onClick={guardarRuta} disabled={guardando || eliminando}>
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
            {detalle.unidad_negocio} · {textoMedio(detalle.tipo_medio)} · {ubicsDetalle.length} paradas · orden de visita por
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
            {/* Técnico de Op. Bio Box de la ruta (Erik, 30-oct-2026): aparte
                de los monitoristas, sin darle ese rol. Solo Biobox. */}
            {puedeGestionar && detalle.unidad_negocio.startsWith('Biobox') && (
              <button
                type="button"
                role="tab"
                aria-selected={pestanaDetalle === 'tecnicos'}
                className={'rt-tab' + (pestanaDetalle === 'tecnicos' ? ' on' : '')}
                onClick={() => setPestanaDetalle('tecnicos')}
              >
                Técnico Op. Bio Box
              </button>
            )}
          </div>

          {pestanaDetalle === 'avance' && puedeGestionar && <AvanceVisitas ruta={detalle} paradas={ubicsDetalle} />}
          {pestanaDetalle === 'monitoristas' && puedeGestionar && <AsignarMonitoristas ruta={detalle} />}
          {pestanaDetalle === 'tecnicos' && puedeGestionar && detalle.unidad_negocio.startsWith('Biobox') && (
            <AsignarMonitoristas key={'tec-' + detalle.id} ruta={detalle} modo="tecnico" />
          )}

          {pestanaDetalle === 'paradas' && (
            <>
              {puedeGestionar && !segPauta && (
                <div style={{ marginBottom: 10 }}>
                  <button type="button" className="btn sm" onClick={() => abrirArmado(detalle)}>
                    <Ic i={Puzzle} />Armar / editar paradas
                  </button>
                </div>
              )}
              {segPauta && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
                  En Ecovallas Impreso las paradas y su orden salen de la pauta (Pauta y Monitoreo → <Ic i={MapIcon} />
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
                      <Ic i={MapIcon} />
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
        <h2 className="page">Rutas de Operación</h2>
        <div className="empty">
          Tus unidades de negocio no tienen rutas (solo Ecovallas, Biobox y Vía Verde).
        </div>
      </div>
    );

  return (
    <>
      {loading && !yaCargo ? (
        errCtx ? (
          <div>
            <h2 className="page">Rutas de Operación</h2>
            <div className="err">
              {errCtx}{' '}
              <button type="button" className="btn sm ghost" onClick={() => setIntentoCtx((n) => n + 1)}>
                Reintentar
              </button>
            </div>
          </div>
        ) : (
          <div className="loading" style={{ textAlign: 'center', color: 'var(--muted)', padding: 60 }}>
            Cargando rutas…
          </div>
        )
      ) : (
        <div>
          <h2 className="page">
            Rutas de Operación
            {recargando && (
              <span
                role="status"
                style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 10 }}
              >
                <span className="spinner" />
                Actualizando…
              </span>
            )}
          </h2>
          <p className="phint">
            Ubicaciones agrupadas por ruta geográfica. Cada ruta con su color, área y el orden de sus paradas.
          </p>

          <div className="toolbar">
            <span className="tag">Unidad de negocio:</span>
            {/* Botones y NO <select> (Erik, 5-oct-2026). En el iPhone (iOS 27,
                app instalada), al elegir en la rueda o menú de un <select> iOS
                abre una "sesión de captura" y, al cerrarla con la página
                cambiando de alto (rutas nuevas + mapa), deja corrida el área
                visible: el menú inferior quedaba encima del mapa y la barra de
                arriba desaparecía. Es un error de iOS 26/27 documentado por
                Apple y WebKit, sin arreglo de su lado; un botón no abre esa
                sesión, así que no hay nada que iOS deje desacomodado. Son 3
                unidades y 2 medios: caben. */}
            <div className="rt-chips rt-segmento" role="group" aria-label="Unidad de negocio">
              {unidadesVisibles.map((u) => (
                <button
                  key={u}
                  type="button"
                  className={'rt-chip' + (u === unidad ? ' on' : '')}
                  aria-pressed={u === unidad}
                  onClick={() => {
                    const ahora = segmentoPendiente.current ?? { u: unidad, t: tipo };
                    if (u === ahora.u) return;
                    // Vía Verde no tiene Impreso: columnas y pórticos son Digital.
                    // "Ambos" solo existe donde hay combinadas (Biobox).
                    cambiarSegmento(
                      u,
                      u === 'Vía Verde'
                        ? 'Digital'
                        : ahora.t === FILTRO_AMBOS && !admiteCombinada(u)
                          ? 'Impreso'
                          : ahora.t
                    );
                  }}
                >
                  {u === unidad ? '✓ ' : ''}
                  {u}
                </button>
              ))}
            </div>
            <div className="rt-chips rt-segmento" role="group" aria-label="Medio">
              {/* (rutas, 5-oct-2026, QA) Vía Verde no tiene Impreso: ni se ofrece.
                  (19-oct-2026) Biobox suma "Ambos": todas sus rutas y las combinadas. */}
              {(unidad === 'Vía Verde'
                ? ['Digital']
                : admiteCombinada(unidad)
                  ? ['Impreso', 'Digital', FILTRO_AMBOS]
                  : ['Impreso', 'Digital']
              ).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={'rt-chip' + (t === tipo ? ' on' : '')}
                  aria-pressed={t === tipo}
                  onClick={() => {
                    const ahora = segmentoPendiente.current ?? { u: unidad, t: tipo };
                    if (t === ahora.t) return;
                    cambiarSegmento(ahora.u, t);
                  }}
                >
                  {t === tipo ? '✓ ' : ''}
                  {t}
                </button>
              ))}
            </div>
            {/* (Erik, 22-oct-2026) Cada coordinador ve solo sus rutas; el
                manager elige de quién (o todos). Botones, no <select>: ver
                arriba lo de iOS. */}
            {esManager && (
              <div className="rt-chips rt-segmento" role="group" aria-label="Coordinador">
                {[{ email: TODOS_COORDINADORES, nombre: 'Todos' }, ...ctx!.datos.coordinadores].map((c) => (
                  <button
                    key={c.email || 'todos'}
                    type="button"
                    className={'rt-chip' + (c.email === filtroCoord ? ' on' : '')}
                    aria-pressed={c.email === filtroCoord}
                    title={c.email ? c.nombre : 'Las rutas de todos los coordinadores'}
                    onClick={() => {
                      if (c.email === filtroCoord) return;
                      setRutaFoco(null);
                      subirYLuego(() => setFiltroCoord(c.email));
                    }}
                  >
                    {c.email === filtroCoord ? '✓ ' : ''}
                    {c.email ? nombreCorto(c.nombre) : 'Todos'}
                  </button>
                ))}
              </div>
            )}
            {puedeGestionar && duenoAccion && (
              <button className="btn sm" onClick={nuevaRuta}>
                + Nueva ruta
              </button>
            )}
            {puedeGestionar && esManager && !duenoAccion && (
              <span className="tag">Elige un coordinador para crear o importar rutas</span>
            )}
            {/* Los importadores son POR UNIDAD, no un menú fijo: los tres
                botones juntos confundían — dos son exclusivos de Biobox (el
                Excel de operación y el mapa KML) y el genérico es el Excel de
                rutas de las demás unidades (Erik, 22-sep-2026). Cada unidad ve
                solo sus caminos, con etiqueta de qué archivo espera. */}
            {puedeGestionar && duenoAccion && unidad !== 'Biobox' && (
              <label
                className="btn sm ghost"
                style={{ display: 'inline-block', cursor: 'pointer' }}
                title={`Excel con columnas: Clave Nueva, Ruta, Secuencia, Estatus, VALLAS, Dirección. Importa a ${unidad} ${tipo}.`}
              >
                {importando ? 'Leyendo archivo…' : `Importar rutas de ${unidad} (Excel)`}
                <input
                  type="file"
                  accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                  style={{ display: 'none' }}
                  onChange={onArchivoImport}
                  disabled={importando}
                />
              </label>
            )}
            {puedeGestionar && duenoAccion && unidad === 'Biobox' && (
              <button
                className="btn sm"
                onClick={() => setExcelRutasAbierto(true)}
                title="Una fila por máquina: clave y responsable. Empata por clave exacta — el camino recomendado."
              >
                <Ic i={FileSpreadsheet} />Rutas Biobox: Excel de operación
              </button>
            )}
            {puedeGestionar && duenoAccion && unidad === 'Biobox' && (
              <button
                className="btn sm ghost"
                onClick={() => setKmlAbierto(true)}
                title="Las capas del mapa de My Maps se convierten en rutas. Empata por nombre de máquina, menos preciso que el Excel."
              >
                <Ic i={MapIcon} />Rutas Biobox: mapa (KML)
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
                  <b><Ic i={MapIcon} />Sincronizar rutas</b> en Pauta y Monitoreo (no se arman a mano). El <Ic i={Download} />Excel de rutas
                  sigue disponible y <b>reemplaza</b> tus rutas de Ecovallas Impreso con las del archivo (menos EDOMEX y
                  PLAZA); antes de importar te enseña qué se borra y las direcciones que no coinciden con QTM.
                </>
              ) : (
                <>
                  {verAmbos ? (
                    <>
                      Aquí ves todas las rutas de {unidad} (Impreso, Digital y combinadas). <b>+ Nueva ruta</b> crea
                      una <b>combinada</b>: la armas con máquinas Impreso y Digital del inventario, en la lista o
                      en el mapa, y se ordenan por cercanía.{' '}
                    </>
                  ) : (
                    <>
                      <b>+ Nueva ruta</b> la arma desde el inventario de {unidad} {tipo}: eliges los sitios en la
                      lista o en el mapa y se ordenan por cercanía.{' '}
                    </>
                  )}
                  {unidad === 'Biobox' ? (
                    <>
                      También por archivo: <Ic i={FileSpreadsheet} /><b>Excel de operación</b> (clave + responsable, el recomendado) o{' '}
                      <Ic i={MapIcon} /><b>mapa KML</b> (empata por nombre, menos preciso).
                    </>
                  ) : (
                    <>
                      También por archivo: <Ic i={Download} /><b>Excel de rutas</b> con columnas Clave Nueva, Ruta, Secuencia,
                      Estatus, VALLAS y Dirección. <b>Reemplaza</b> tus rutas de {unidad} {tipo} con las del archivo: antes
                      de importar te enseña qué se borra y eliges qué dirección se queda.
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

          {/* Con error no se dice "aún no hay rutas": no se pudieron leer. */}
          {resumen.length === 0 && !recargando && !err && (
            <div className="empty">
              Aún no hay rutas de {segmentoTxt}.{' '}
              {puedeGestionar
                ? dePauta
                  ? 'Créalas desde Pauta y Monitoreo → Sincronizar rutas, o impórtalas con el Excel de rutas.'
                  : 'Créalas con «+ Nueva ruta» (se arman desde el inventario) o impórtalas desde un archivo.'
                : 'Pídele a tu coordinador que las cree.'}
            </div>
          )}

          {resumen.length > 0 && (
            <>
              <div className={'cards' + (recargando ? ' recargando' : '')}>
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

              <div className={'fij-split' + (recargando ? ' recargando' : '')}>
                {/* Leyenda de rutas */}
                <div style={{ display: 'grid', gap: 9 }}>
                  <div
                    className={'nav-item' + (rutaFoco == null ? ' active' : '')}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setRutaFoco(null)}
                  >
                    <span><Ic i={MapIcon} /></span>
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
                              {/* Con "Ambos" conviven los tres medios (y números
                                  repetidos entre ellos): el medio va primero. */}
                              {verAmbos ? `${r.tipo_medio} · ` : ''}
                              {/* Manager viendo a todos: de quién es cada una. */}
                              {esManager && !filtroCoord ? `${nombreCorto(r.coordinador_nombre)} · ` : ''}
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
                          {/* Con el segmento de la propia ruta y no con el
                              elegido: al tocar otra unidad, las tarjetas de
                              la anterior siguen en pantalla hasta que llega
                              lo nuevo, y si ganaban este botón crecían todas a
                              la vez (miles de px de alto de golpe, justo
                              antes de encogerse; 5-oct-2026). */}
                          {puedeGestionar && !esSegmentoDePauta(r.unidad_negocio, r.tipo_medio) && (
                            <button
                              className="btn ghost sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                abrirArmado(r);
                              }}
                              aria-label={`Armar o editar las paradas de la Ruta ${r.numero}`}
                            >
                              <Ic i={Puzzle} />Paradas
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
                            <Ic i={ClipboardList} className="solo" />
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
                              <Ic i={Pencil} className="solo" />
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
