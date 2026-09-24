// ============================================================
// src/modules/incidencias/NuevaInc.tsx
// Alta de un REPORTE de sitio: se elige el sitio una sola vez y se agregan
// N incidencias, cada una aplicada a las caras que correspondan.
//
// Cada par (incidencia × cara) se convierte en una fila de `incidencias`.
//
// La evidencia va POR PARTIDA, no por reporte: cada falla lleva sus propias
// fotos y se ligan solo a las caras de esa falla. Así, en un sitio con varias
// incidencias, se sabe qué foto corresponde a qué cara.
//
// BORRADOR (auditoría primer mes, 24-sep-2026): mientras se captura, el
// formulario se guarda en el teléfono con sus fotos (lib/borrador.ts). Si
// iOS recarga la app al volver de la cámara, o se cierra sin querer, al
// abrir otro reporte se ofrece recuperarlo.
//
// SIN SEÑAL (modo sin señal, 24-sep-2026): todo lo que el alta consulta
// (inventario, catálogo, árbol Digital, catorcenas, nombres y pauta QTM)
// sale de la red con tope corto y, si no hay señal o falla, de la copia que
// lib/datosLocales.ts guarda en el teléfono. El buscador enseña lo local al
// instante y suma lo de la red si llega. Guardar ya iba a la cola.
// ============================================================
import { useState, useEffect, useMemo, useRef } from 'react';
import { sb } from '../../lib/supabase';
import {
  arbolDigitalLocal,
  buscarSitiosLocal,
  carasDeSitioLocal,
  catalogoLocal,
  catorcenasLocal,
  fechaCopia,
  haySenal,
  motivoSinRed,
  nombresPantallaLocal,
  pautasLocal,
  redOLocal,
  sitioLocal,
  sitiosCercaLocal,
  type SitioLocal,
} from '../../lib/datosLocales';
import {
  cargarArchivosBorrador,
  cerrarBorrador,
  claveDeArchivo,
  guardarBorrador,
  leerBorrador,
  nuevaSesionBorrador,
  quitarBorrador,
  type Borrador,
} from '../../lib/borrador';
import { emailActivo, hayEnvioDeBorrador } from '../../lib/envios';
import { idbDisponible, idbGet } from '../../lib/idb';
import {
  UNIDADES,
  NIVEL_COLOR,
  LADOS,
  UNIDADES_CON_LADO,
  VIAS_REPORTE,
} from '../../lib/constants';
import { caraLabel, distKm, ladoFijoDePortico } from '../../lib/helpers';
import { explicarErrorGps } from '../../lib/plataforma';
import {
  catalogoParaMuebles,
  catalogoDesdeArbol,
  llaveCatalogo,
  filtrarCatalogo,
} from '../../lib/catalogo';
import SubirArchivos from '../../components/SubirArchivos';
import type {
  CatalogoIncidencia,
  IncidenciaNueva,
  InventarioItem,
} from '../../types/db';

/** Preset opcional (la bitácora abre el alta con el sitio ya elegido). */
export type PresetNueva = { un?: string; siteId?: string };

/** Sitio elegido (agregado del inventario por site_id). */
type Sitio = {
  site_id: string;
  direccion?: string | null;
  estado?: string | null;
  municipio?: string | null;
};

/** Opción del buscador "cerca de mí", con su distancia calculada. */
type SitioCercano = {
  site_id: string;
  direccion: string | null;
  dist: number;
};

/**
 * Una partida del reporte: una incidencia del catálogo × N caras, CON SUS
 * PROPIAS FOTOS. Las fotos viajan con la partida para que la evidencia quede
 * ligada solo a las caras que muestra, y no a todas las del sitio.
 */
type Linea = {
  id: number;
  cat: CatalogoIncidencia;
  caras: string[];
  /** Campaña única (texto libre): unidades sin pauta QTM o sitios sin pauta. */
  campania: string;
  /**
   * Campaña POR CARA (Ecovallas con pauta QTM): cada cara puede estar en una
   * campaña distinta, y cada fila del reporte guarda la suya. null = se usa
   * `campania` para todas, como antes.
   */
  campPorCara: Record<string, string> | null;
  obs: string;
  files: File[];
};

/** Catorcena del calendario (la actual y sus vecinas). */
type CatVentana = {
  numero: number;
  fecha_inicio: string;
  fecha_fin: string;
  cat_texto: string | null;
};

/** Línea de pauta de QTM para una cara, dentro de la ventana. */
type PautaQtm = {
  vendor_face_id: string;
  campaign: string | null;
  fecha_inicio: string | null;
  fecha_fin: string | null;
};

/**
 * Lo que se entrega al padre: un grupo por partida, con las filas que va a
 * insertar y los archivos que le corresponden. El padre sube cada grupo por
 * separado, así cada foto se liga únicamente a las caras de su partida.
 */
export type GrupoReporte = {
  filas: Partial<IncidenciaNueva>[];
  files: File[];
  /** Caras en formato legible, para nombrar el archivo y la referencia. */
  carasLabel: string;
  /**
   * Borrador del formulario del que salió el reporte (auditoría primer
   * mes, 24-sep-2026). La cola lo anota en el envío, reusa sus archivos y
   * lo cierra cuando el envío queda completo o se descarta; mientras tanto
   * no se ofrece —recuperarlo duplicaría el reporte—. Ciclo de vida
   * completo en lib/borrador.ts (revisión primer mes, 24-sep-2026).
   */
  borrador?: { email: string; sesion: string };
};

/** Una partida tal como va al borrador: sus fotos por clave, no como File. */
type LineaBorrador = Omit<Linea, 'files'> & { archivos: string[] };

/**
 * Lo necesario para rehacer el formulario desde el borrador. Lleva las
 * caras y los nombres de pantalla del sitio, no solo su clave: el caso a
 * proteger es justo el de sin señal, y sin ellos la recuperación
 * dependería de volver a consultar el inventario.
 */
type DatosBorrador = {
  un: string;
  site: Sitio | null;
  caras: InventarioItem[];
  nombresPantalla: Record<string, string>;
  contactoCorreo: string;
  contactoTelefono: string;
  viaReporte: string;
  lado: string;
  nombreBiobox: string;
  lineas: LineaBorrador[];
  /** La partida que estaba en el editor (sin agregar todavía, o editándose). */
  editor: {
    catSel: CatalogoIncidencia | null;
    selCaras: string[];
    campania: string;
    campPorCara: Record<string, string>;
    campLibrePorCara: Record<string, boolean>;
    obs: string;
    archivos: string[];
    editandoId: number | null;
  };
};

/** Tope para leer la sesión: sin red y con token vencido, auth-js reintenta largo. */
const ESPERA_SESION_MS = 3000;

/** "de hoy a las 14:05" / "de ayer a las 09:12" / "del 22 sep. a las 18:40". */
function cuandoBorrador(ms: number): string {
  const d = new Date(ms);
  const hora = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const hoy = new Date();
  if (d.toDateString() === hoy.toDateString()) return `de hoy a las ${hora}`;
  const ayer = new Date(hoy);
  ayer.setDate(hoy.getDate() - 1);
  if (d.toDateString() === ayer.toDateString()) return `de ayer a las ${hora}`;
  return `del ${d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })} a las ${hora}`;
}

/** Radio de búsqueda geográfica en grados (~6 km). */
const DELTA_GRADOS = 0.06;

/** Lo que se dice cuando no hay de dónde sacar el inventario (modo sin señal, 24-sep-2026). */
const SIN_COPIA_INVENTARIO =
  'Este teléfono todavía no tiene copia del inventario. Abre la app una vez con señal.';

/**
 * Lo mismo, pero diciendo por qué no llegó la red (revisión sin señal,
 * 24-sep-2026): con 3G lenta no es "sin señal", y lo que sirve es reintentar.
 */
function sinCopiaInventario(): string {
  return motivoSinRed() === 'Sin señal'
    ? 'Sin señal, y este teléfono todavía no tiene copia del inventario. Abre la app una vez con señal.'
    : 'La red tardó demasiado, y este teléfono todavía no tiene copia del inventario.';
}

/** "24/09 14:05" para el aviso de la copia del teléfono. */
function fechaCorta(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Props = {
  onClose: () => void;
  /** El padre inserta las filas de cada grupo y sube sus archivos. */
  onSave: (grupos: GrupoReporte[]) => Promise<void>;
  preset?: PresetNueva | null;
  /**
   * Unidades que este usuario puede reportar (de sus filas de rol; null =
   * todas). El selector solo ofrece estas: quien reporta únicamente en
   * Ecovallas no tiene por qué capturar en Biobox (Erik, ago-2026).
   */
  unidades?: string[];
  /**
   * true = quien captura pertenece al área MKT, que reporta EN NOMBRE de
   * terceros: el alta pide correo (obligatorio) y teléfono del solicitante,
   * y las observaciones cargan el detalle de lo que el usuario reporta.
   * Mismo flujo de siempre, solo con esos campos extra (Erik, 22-sep-2026).
   */
  esMKT?: boolean;
};

function NuevaInc({ onClose, onSave, preset, unidades, esMKT = false }: Props) {
  const misUnidades = unidades && unidades.length ? unidades : UNIDADES;
  const [un, setUn] = useState(preset?.un || misUnidades[0]);
  /** Contacto del solicitante (solo MKT). Del REPORTE: baja a todas las filas. */
  const [contactoCorreo, setContactoCorreo] = useState('');
  const [contactoTelefono, setContactoTelefono] = useState('');
  const [viaReporte, setViaReporte] = useState('');
  const [siteQuery, setSiteQuery] = useState('');
  const [siteOpts, setSiteOpts] = useState<Sitio[]>([]);
  const [site, setSite] = useState<Sitio | null>(null);
  const [caras, setCaras] = useState<InventarioItem[]>([]);
  const [selCaras, setSelCaras] = useState<string[]>([]);
  /** El catálogo TAL CUAL viene de la base, con todas sus copias. */
  const [catCrudo, setCatCrudo] = useState<CatalogoIncidencia[]>([]);
  /** Incidencias del árbol de Digital: el catálogo de las caras digitales. */
  const [arbolNombres, setArbolNombres] = useState<string[]>([]);
  const [catSel, setCatSel] = useState<CatalogoIncidencia | null>(null);
  const [catBusca, setCatBusca] = useState('');
  /** Lado de la cara. Solo aplica en las unidades de UNIDADES_CON_LADO. */
  const [lado, setLado] = useState('');
  const [campania, setCampania] = useState('');
  /** Campaña elegida por cara marcada (Ecovallas con pauta QTM). */
  const [campPorCara, setCampPorCara] = useState<Record<string, string>>({});
  /** Caras donde eligió "Otra…" y escribe la campaña a mano. */
  const [campLibrePorCara, setCampLibrePorCara] = useState<
    Record<string, boolean>
  >({});
  /**
   * Campañas pautadas por CARA (no por sitio), desde qtm_pautas — lo que QTM
   * sincroniza, no la tabla `pautas` del Excel. Solo Ecovallas por ahora.
   */
  const [ventanaCats, setVentanaCats] = useState<CatVentana[]>([]);
  const [pautasCaras, setPautasCaras] = useState<PautaQtm[]>([]);
  const [obs, setObs] = useState('');
  const [nombreBiobox, setNombreBiobox] = useState('');
  // Fotos de la partida que se está editando ahora. Al agregarla al reporte
  // se guardan dentro de la línea y este arreglo se vacía para la siguiente.
  const [filesLinea, setFilesLinea] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingSites, setLoadingSites] = useState(false);
  const [nearOpts, setNearOpts] = useState<SitioCercano[]>([]);
  const [geoBusy, setGeoBusy] = useState(false);
  // ── Sin señal (modo sin señal, 24-sep-2026) ──
  /**
   * Sitio cuyas caras se están cargando. Mientras tanto el buscador no
   * vuelve a abrir la lista con la clave recién elegida (con resultados
   * locales al instante, la lista reaparecía encima durante la carga).
   */
  const [sitioEnCarga, setSitioEnCarga] = useState<string | null>(null);
  /** La búsqueda de clave terminó sin nada: '' = no aplica. */
  const [sinResultados, setSinResultados] = useState<'' | 'vacio' | 'sinCopia'>('');
  /** Qué lecturas salieron de la copia del teléfono (para el aviso 📴). */
  const [deCopia, setDeCopia] = useState<Record<string, boolean>>({});
  const marcarOrigen = (que: string, origen: 'red' | 'local') =>
    setDeCopia((p) =>
      !!p[que] === (origen === 'local') ? p : { ...p, [que]: origen === 'local' }
    );
  /**
   * Las lecturas que salieron de la copia, como TEXTO ('arbol,catalogo').
   * Los efectos dependen de esto y NUNCA del objeto `deCopia` (app pasmada
   * sin señal, 24-sep-2026): React puede volver a aplicar los marcarOrigen
   * pendientes en cada render (rebase de la cola cuando conviven updates
   * del toque —SyncLane— con los del cuerpo de un efecto —DefaultLane—), y
   * cada vez el updater arma un objeto NUEVO con el mismo contenido. Un
   * efecto con `deCopia` en sus dependencias corría en cada render.
   */
  const lecturasDeCopia = Object.keys(deCopia)
    .filter((k) => deCopia[k])
    .sort()
    .join(',');
  const usandoCopia = lecturasDeCopia !== '';
  /** Fecha de la copia del inventario: undefined = aún no se lee, null = no hay. */
  const [fechaInv, setFechaInv] = useState<string | null | undefined>(undefined);
  const fechaInvRef = useRef(fechaInv);
  fechaInvRef.current = fechaInv;
  /** Suben para volver a pedir el catálogo / el árbol cuando regresa la señal. */
  const [reintentoCat, setReintentoCat] = useState(0);
  const [reintentoArbol, setReintentoArbol] = useState(0);
  /**
   * El catálogo / el árbol se están pidiendo. Sin copia la red se espera
   * hasta ~20 s: el sondeo de 15 s no debe volver a pedirlos encima, porque
   * cada vuelta descartaba la anterior y nunca llegaba ninguna (revisión sin
   * señal, 24-sep-2026).
   */
  const [catEnVuelo, setCatEnVuelo] = useState(false);
  const [arbolEnVuelo, setArbolEnVuelo] = useState(false);
  /** Sube con "Reintentar" del buscador de clave. */
  const [reintentoSitios, setReintentoSitios] = useState(0);
  const [lineas, setLineas] = useState<Linea[]>([]);
  // id de la partida que se está editando. null = se está capturando una nueva.
  // La partida NO se saca de la lista mientras se edita: si el usuario cierra
  // el modal a media edición, no pierde lo que ya había capturado.
  const [editandoId, setEditandoId] = useState<number | null>(null);

  // ── Borrador en el teléfono (auditoría primer mes, 24-sep-2026) ──
  /** Correo con el que se guarda el borrador ('' = no se guarda nada). */
  const [emailBorrador, setEmailBorrador] = useState('');
  /** ¿El teléfono deja guardar? Sin IndexedDB no se promete nada. */
  const [idbOk, setIdbOk] = useState(false);
  /** Ya se revisó si había borrador que ofrecer: antes no se autoguarda. */
  const [revisado, setRevisado] = useState(false);
  /**
   * Borrador de OTRA apertura esperando Recuperar / Descartar. Mientras
   * espera no se autoguarda: el borrador es uno por usuario y se pisaría.
   */
  const [oferta, setOferta] = useState<Borrador<DatosBorrador> | null>(null);
  const [cargandoOferta, setCargandoOferta] = useState(false);
  /** Restauración pendiente: se aplica cuando la unidad ya se asentó. */
  const [restaurando, setRestaurando] = useState<{
    datos: DatosBorrador;
    archivos: Map<string, File>;
  } | null>(null);
  /** Aviso tras recuperar (fotos que no se habían podido guardar). */
  const [avisoRecuperado, setAvisoRecuperado] = useState('');
  /** Archivos de ESTE formulario que no cupieron en el teléfono. */
  const [noGuardados, setNoGuardados] = useState(0);
  /** Esta apertura del formulario (al recuperar, se adopta la del borrador). */
  const sesionRef = useRef(nuevaSesionBorrador());
  /** ¿Esta sesión ya escribió un borrador? (para borrarlo si se vacía). */
  const escribioRef = useRef(false);
  /** Hay cambios esperando el debounce. */
  const pendienteRef = useRef(false);
  const montadoRef = useRef(true);
  /** Escribe el borrador YA con el estado del último render. */
  const guardarAhoraRef = useRef<() => void>(() => {});
  /**
   * Consecutivo de pickSite: cada elección invalida las anteriores que
   * sigan en vuelo, y recuperar un borrador invalida la del preset. Sin
   * esto, la respuesta tardía de un sitio viejo pisaba el vigente.
   */
  const pickSeqRef = useRef(0);

  const esBiobox = un.toLowerCase().startsWith('biobox');

  /**
   * Nombres "amigables" de las pantallas del sitio elegido, POR CARA
   * (tabla nombres_pantallas — como el nombre de máquina de los Biobox,
   * pero para las megapantallas de Ecovallas). Vacío si el sitio no tiene.
   */
  const [nombresPantalla, setNombresPantalla] = useState<
    Record<string, string>
  >({});

  /**
   * Invalida la elección de sitio que siga en vuelo (y la del preset): su
   * respuesta tardía ya no debe poner el sitio. Mismo consecutivo de
   * siempre; además suelta el "cargando" (modo sin señal, 24-sep-2026).
   */
  const soltarSitioEnVuelo = () => {
    pickSeqRef.current++;
    setSitioEnCarga(null);
  };

  /** Carga las caras del sitio y precarga lo que se deriva de ellas. */
  const pickSite = async (o: Sitio) => {
    const seq = ++pickSeqRef.current;
    setSiteQuery(o.site_id);
    setSiteOpts([]);
    setSitioEnCarga(o.site_id);
    // Red con tope y, sin señal o si falla, la copia del teléfono (modo sin
    // señal, 24-sep-2026). Antes, sin red, esto tardaba ≥7 s y dejaba el
    // sitio con "0 medios" y Guardar deshabilitado: un callejón sin salida.
    let filas: InventarioItem[] = [];
    let origen: 'red' | 'local' = 'local';
    try {
      const r = await redOLocal<InventarioItem[]>(
        (senal) =>
          sb
            .from('inventario')
            // Las 13 columnas de InventarioItem, las mismas que da la copia:
            // así la fila es igual venga de donde venga.
            .select(
              'vendor_face_id,site_id,site_legacy_id,cara,categoria,unidad_negocio,tipo_medio,tipo_mueble,latitud,longitud,direccion,municipio,estado'
            )
            .eq('site_id', o.site_id)
            .retry(false)
            .abortSignal(senal),
        () => carasDeSitioLocal(o.site_id)
      );
      filas = r.datos;
      origen = r.origen;
    } catch {
      /* redOLocal no lanza; por si acaso, se sigue sin caras */
    }
    if (seq !== pickSeqRef.current) return; // ya se eligió otro (o se recuperó un borrador)
    setSitioEnCarga(null);
    // Las listas del buscador ya no están a la vista: el aviso 📴 sigue a
    // lo que se ve ahora (las caras).
    setDeCopia((p) => ({ ...p, sitios: false, cerca: false, caras: origen === 'local' }));
    const first = filas[0] || ({} as InventarioItem);
    setSite({
      ...o,
      // Si la precarga no trajo dirección (sin red ni copia del sitio), la
      // de sus caras sirve: en un sitio es la misma.
      direccion: o.direccion || first.direccion || null,
      estado: first.estado || null,
      municipio: first.municipio || null,
    });
    setCaras(filas);
    // Si el sitio tiene una sola cara, se preselecciona: no hay nada que elegir.
    setSelCaras(filas.length === 1 ? [filas[0].vendor_face_id] : []);
    setNearOpts([]);
    const lg = filas.map((c) => c.site_legacy_id).find(Boolean);
    setNombreBiobox(lg || '');

    // Nombres de pantalla de estas caras. Si la tabla no existe o no hay
    // nombres, el mapa queda vacío y todo se ve como antes.
    setNombresPantalla({});
    if (filas.length) {
      const ids = filas.map((c) => c.vendor_face_id);
      type Nombre = { vendor_face_id: string; nombre: string };
      let noms: Nombre[] = [];
      try {
        const r = await redOLocal<Nombre[]>(
          (senal) =>
            sb
              .from('nombres_pantallas')
              .select('vendor_face_id,nombre')
              .in('vendor_face_id', ids)
              .retry(false)
              .abortSignal(senal),
          async () =>
            Object.entries(await nombresPantallaLocal(ids)).map(([vendor_face_id, nombre]) => ({
              vendor_face_id,
              nombre,
            }))
        );
        noms = r.datos;
        marcarOrigen('nombres', r.origen);
      } catch {
        /* sin nombres: todo se ve como antes */
      }
      if (seq !== pickSeqRef.current) return;
      const m: Record<string, string> = {};
      noms.forEach((n) => {
        m[n.vendor_face_id] = n.nombre;
      });
      setNombresPantalla(m);
    }
  };

  const buscarCerca = () => {
    if (!navigator.geolocation) {
      alert('Tu dispositivo no permite geolocalización.');
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const d = DELTA_GRADOS;
        // Se acota con un cuadro en la query (barato para Postgres) y luego
        // se ordena por distancia real en el cliente. Sin señal o si la red
        // falla, el mismo cuadro sobre la copia del teléfono (modo sin señal,
        // 24-sep-2026); antes salía "Error consultando inventario: Load
        // failed" tras ≥7 s.
        type Cerca = {
          site_id: string | null;
          direccion: string | null;
          latitud: number | string | null;
          longitud: number | string | null;
        };
        let filas: Cerca[] = [];
        let origen: 'red' | 'local' = 'local';
        // Con copia del inventario, "nada cerca" en ella es creíble: tope
        // corto. Sin copia, redOLocal espera más a la red (revisión sin
        // señal, 24-sep-2026).
        const hayCopiaInv = !!(await fechaCopia('inventario').catch(() => null));
        try {
          const r = await redOLocal<Cerca[]>(
            (senal) =>
              sb
                .from('inventario')
                .select('site_id,direccion,latitud,longitud')
                .eq('unidad_negocio', un)
                .gte('latitud', lat - d)
                .lte('latitud', lat + d)
                .gte('longitud', lon - d)
                .lte('longitud', lon + d)
                .limit(600)
                .retry(false)
                .abortSignal(senal),
            () => sitiosCercaLocal(un, lat, lon, d),
            hayCopiaInv ? { topeSinCopiaMs: 0 } : undefined
          );
          filas = r.datos;
          origen = r.origen;
        } catch {
          /* redOLocal no lanza; por si acaso, sin sitios */
        }
        const sinCopia =
          origen === 'local' &&
          filas.length === 0 &&
          !(await fechaCopia('inventario').catch(() => null));
        setGeoBusy(false);
        marcarOrigen('cerca', origen);
        const seen = new Set<string>();
        const opts: SitioCercano[] = [];
        filas.forEach((r) => {
          if (r.site_id && !seen.has(r.site_id) && r.latitud && r.longitud) {
            seen.add(r.site_id);
            opts.push({
              site_id: r.site_id,
              direccion: r.direccion,
              dist: distKm(lat, lon, +r.latitud, +r.longitud),
            });
          }
        });
        opts.sort((a, b) => a.dist - b.dist);
        soltarSitioEnVuelo();
        setSite(null);
        setSiteQuery('');
        setSiteOpts([]);
        setNearOpts(opts.slice(0, 15));
        if (opts.length === 0)
          alert(
            sinCopia
              ? sinCopiaInventario()
              : 'No hay sitios de esta unidad en ~6 km de tu ubicación.'
          );
      },
      (err) => {
        setGeoBusy(false);
        // El mensaje crudo del navegador ("User denied Geolocation") no dice
        // qué hacer. explicarErrorGps distingue origen inseguro, bloqueo del
        // navegador (con los pasos para desbloquear según la plataforma),
        // falta de señal y timeout.
        alert(
          explicarErrorGps(err) +
            '\n\nMientras tanto puedes buscar el sitio por su clave.'
        );
      },
      // maximumAge 60 s (modo sin señal, 24-sep-2026): una posición de hace
      // un minuto sirve para un radio de 6 km, y sin datos móviles la
      // primera posición nueva suele pasar de los 10 s del tope.
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  };

  // Cambiar de unidad invalida el sitio: las claves no se cruzan entre unidades.
  // También la elección en vuelo: su respuesta sería de la unidad anterior.
  useEffect(() => {
    soltarSitioEnVuelo();
    setSite(null);
    setSiteQuery('');
    setSiteOpts([]);
    setCaras([]);
    setSelCaras([]);
    setNombreBiobox('');
  }, [un]);

  // Buscador de clave de sitio, con debounce de 250 ms.
  //
  // Modo sin señal (24-sep-2026): primero la copia del teléfono, que se
  // enseña al instante; si hay señal, también la red (tope corto, sin los
  // reintentos de postgrest-js) y se unen sin repetidos. "Buscando…" ya no
  // se queda pegado: antes, al elegir sitio o borrar la clave, la limpieza
  // cancelaba la búsqueda antes de apagarlo.
  //
  // Lo que ya está a la vista NO se mueve (revisión sin señal, 24-sep-2026):
  // antes lo de la red iba primero y reordenaba la lista justo cuando el
  // usuario iba a tocar, y el toque caía en otro sitio. Ahora lo local se
  // queda en su lugar y lo nuevo de la red se agrega al final.
  useEffect(() => {
    setSinResultados('');
    const q = siteQuery.trim();
    if (site || sitioEnCarga) {
      // ya hay sitio elegido (o cargándose)
      setLoadingSites(false);
      return;
    }
    if (q.length < 1) {
      setSiteOpts([]);
      setLoadingSites(false);
      return;
    }
    let active = true;
    setLoadingSites(true);
    const t = setTimeout(async () => {
      try {
        const locales = await buscarSitiosLocal(un, q, 12).catch(() => [] as SitioLocal[]);
        if (!active) return; // el usuario ya escribió otra cosa
        // Aunque venga vacío: la lista de la búsqueda ANTERIOR no debe
        // quedarse tocable mientras contesta la red, y así se ve "Buscando…"
        // (revisión sin señal, 24-sep-2026).
        setSiteOpts(locales);
        // Con copia del inventario, que la clave no esté en ella es creíble:
        // tope corto. Sin copia, redOLocal espera más a la red.
        const hayCopiaInv = !!(await fechaCopia('inventario').catch(() => null));
        if (!active) return;
        // Espacios como comodín, igual que en EditModal: "eva 03" encuentra
        // MX_EM_EV_EVA_03_0009 sin conocer los guiones bajos del formato.
        const patron = '%' + q.replace(/\s+/g, '%') + '%';
        const r = await redOLocal<SitioLocal[]>(
          (senal) =>
            sb
              .from('inventario')
              .select('site_id,direccion')
              .eq('unidad_negocio', un)
              .ilike('site_id', patron)
              .limit(80)
              .retry(false)
              .abortSignal(senal),
          async () => locales,
          hayCopiaInv ? { topeSinCopiaMs: 0 } : undefined
        );
        if (!active) return;
        const seen = new Set<string>();
        const opts: Sitio[] = [];
        const agregar = (x: { site_id: string | null; direccion: string | null }) => {
          if (x.site_id && !seen.has(x.site_id)) {
            seen.add(x.site_id);
            opts.push({ site_id: x.site_id, direccion: x.direccion });
          }
        };
        // Primero lo que ya se ve, en el mismo orden; lo de la red, al final.
        locales.forEach(agregar);
        if (r.origen === 'red') (r.datos || []).forEach(agregar);
        const sinCopia =
          r.origen === 'local' &&
          opts.length === 0 &&
          !(await fechaCopia('inventario').catch(() => null));
        if (!active) return;
        setSiteOpts(opts.slice(0, 12));
        marcarOrigen('sitios', r.origen);
        if (opts.length === 0) setSinResultados(sinCopia ? 'sinCopia' : 'vacio');
      } finally {
        if (active) setLoadingSites(false);
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [siteQuery, un, site, sitioEnCarga, reintentoSitios]);

  // Cambiar de unidad reinicia la incidencia elegida y el lado. Va aparte de
  // la consulta del catálogo (modo sin señal, 24-sep-2026): volver a pedirlo
  // al regresar la señal no debe borrar lo que ya se eligió.
  useEffect(() => {
    setCatSel(null);
    setCatBusca('');
    setLado('');
  }, [un]);

  // Catálogo de incidencias por unidad (ilike: la unidad puede venir con
  // mayúsculas distintas entre tablas).
  useEffect(() => {
    let active = true;
    setCatEnVuelo(true);
    (async () => {
      // ANTES: aquí se colapsaba por `detalle` con un Set y se conservaba LA
      // PRIMERA fila que devolviera Postgres. Como el catálogo repite la
      // misma incidencia con distinta área según el medio, el área con la que
      // nacía el reporte dependía del orden de la consulta — "Arte con
      // grafiti" podía salir a Digital estando en una cara impresa.
      //
      // Ahora se guarda el catálogo COMPLETO y el colapso se hace abajo, ya
      // sabiendo qué caras se marcaron. `select('*')` porque `tipo_medio`
      // puede o no existir en la tabla y pedirla por nombre daría 400.
      //
      // Sin señal o si la red falla, el de la copia del teléfono para ESTA
      // unidad (modo sin señal, 24-sep-2026): antes un cambio de unidad sin
      // red dejaba el catálogo en "0 de 0".
      const r = await redOLocal<CatalogoIncidencia[]>(
        (senal) =>
          sb
            .from('catalogo_incidencias')
            .select('*')
            .ilike('unidad_negocio', un)
            .limit(1000)
            .retry(false)
            .abortSignal(senal),
        () => catalogoLocal(un)
      ).catch(() => ({ datos: [] as CatalogoIncidencia[], origen: 'local' as const }));
      if (!active) return;
      setCatEnVuelo(false);
      setCatCrudo(r.datos);
      marcarOrigen('catalogo', r.origen);
    })();
    return () => {
      active = false;
    };
  }, [un, reintentoCat]);

  // El árbol de Digital es el catálogo de las caras DIGITALES: lo que se
  // capture de aquí es exactamente lo que el técnico clasifica al reparar.
  // No tiene unidad: es uno solo para todos los medios digitales, así que se
  // pide una sola vez al abrir y no en cada cambio de unidad (modo sin
  // señal, 24-sep-2026; antes se volvía a bajar y, sin red, se perdía).
  useEffect(() => {
    let active = true;
    setArbolEnVuelo(true);
    (async () => {
      const r = await redOLocal<{ incidencia: string | null }[]>(
        (senal) =>
          sb.from('arbol_digital').select('incidencia').limit(2000).retry(false).abortSignal(senal),
        async () => (await arbolDigitalLocal()).map((a) => ({ incidencia: a.incidencia }))
      ).catch(() => ({ datos: [] as { incidencia: string | null }[], origen: 'local' as const }));
      if (!active) return;
      setArbolEnVuelo(false);
      setArbolNombres(r.datos.map((x) => x.incidencia).filter(Boolean) as string[]);
      marcarOrigen('arbol', r.origen);
    })();
    return () => {
      active = false;
    };
  }, [reintentoArbol]);

  // Si el alta abrió sin señal y sin copia, el catálogo o el árbol quedan
  // vacíos: se vuelven a pedir al regresar la señal y, mientras sigan así,
  // cada 15 s con señal (al volver la red, auth-js tarda hasta ~60 s en dar
  // sesión y el primer intento puede caer a la copia). Solo si lo vacío salió
  // de la copia: un vacío real de la red no se sondea (modo sin señal,
  // 24-sep-2026). Ni mientras siga en camino el pedido anterior (revisión
  // sin señal, 24-sep-2026).
  const faltaCat = catCrudo.length === 0 && !!deCopia.catalogo && !catEnVuelo;
  const faltaArbol = arbolNombres.length === 0 && !!deCopia.arbol && !arbolEnVuelo;
  useEffect(() => {
    if (!faltaCat && !faltaArbol) return;
    const otraVez = () => {
      if (!haySenal()) return;
      if (faltaCat) setReintentoCat((n) => n + 1);
      if (faltaArbol) setReintentoArbol((n) => n + 1);
    };
    window.addEventListener('online', otraVez);
    const t = window.setInterval(otraVez, 15000);
    return () => {
      window.removeEventListener('online', otraVez);
      window.clearInterval(t);
    };
  }, [faltaCat, faltaArbol]);

  // Ventana de catorcenas para la campaña pautada: la ANTERIOR, la actual y
  // la SIGUIENTE. En el cambio de campaña la foto de campo puede ser de la
  // saliente o de la entrante; el reportante decide cuál (Erik, 10-sep-2026).
  // Solo Ecovallas por ahora.
  useEffect(() => {
    if (un !== 'Ecovallas') {
      setVentanaCats([]);
      marcarOrigen('catorcenas', 'red'); // no aplica: no cuenta para el aviso 📴
      return;
    }
    let active = true;
    (async () => {
      // Cada catorcena dura 14 días: pedir desde hace 14 días trae a la
      // anterior (su fin cae dentro de ese rango), la actual y la que sigue.
      const desde = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      // Sin señal, la misma ventana sobre el calendario del teléfono (modo
      // sin señal, 24-sep-2026).
      const r = await redOLocal<CatVentana[]>(
        (senal) =>
          sb
            .from('catorcenas')
            .select('numero,fecha_inicio,fecha_fin,cat_texto')
            .gte('fecha_fin', desde)
            .order('numero')
            .limit(3)
            .retry(false)
            .abortSignal(senal),
        async () =>
          (await catorcenasLocal())
            .filter((c) => c.fecha_fin >= desde)
            .sort((a, b) => a.numero - b.numero)
            .slice(0, 3)
      ).catch(() => ({ datos: [] as CatVentana[], origen: 'local' as const }));
      if (!active) return;
      setVentanaCats(r.datos);
      marcarOrigen('catorcenas', r.origen);
    })();
    return () => {
      active = false;
    };
  }, [un]);

  // Pauta de QTM para las caras del sitio elegido, acotada a la ventana.
  // Por CARA, no por sitio: en un mismo sitio cada cara puede traer campaña
  // distinta. Si la RLS no deja leer qtm_pautas, la lista queda vacía y el
  // campo Campaña se comporta como siempre (texto libre).
  useEffect(() => {
    if (un !== 'Ecovallas' || caras.length === 0 || ventanaCats.length === 0) {
      setPautasCaras([]);
      marcarOrigen('pautas', 'red'); // no aplica: no cuenta para el aviso 📴
      return;
    }
    let active = true;
    (async () => {
      const inicio = ventanaCats[0].fecha_inicio;
      const fin = ventanaCats[ventanaCats.length - 1].fecha_fin;
      const ids = caras.map((c) => c.vendor_face_id);
      // Sin señal o si la red falla, la pauta de la copia del teléfono (modo
      // sin señal, 24-sep-2026); sin pauta se cae al texto libre, como antes.
      const r = await redOLocal<PautaQtm[]>(
        (senal) =>
          sb
            .from('qtm_pautas')
            .select('vendor_face_id,campaign,fecha_inicio,fecha_fin')
            .in('vendor_face_id', ids)
            // Traslape de rangos: empieza antes de que acabe la ventana y
            // termina después de que empiece.
            .lte('fecha_inicio', fin)
            .gte('fecha_fin', inicio)
            .retry(false)
            .abortSignal(senal),
        () => pautasLocal(ids, inicio, fin)
      ).catch(() => ({ datos: [] as PautaQtm[], origen: 'local' as const }));
      if (!active) return;
      setPautasCaras(r.datos || []);
      marcarOrigen('pautas', r.origen);
    })();
    return () => {
      active = false;
    };
  }, [un, caras, ventanaCats]);

  /**
   * ¿La campaña se maneja POR CARA? Solo Ecovallas con pauta QTM legible.
   * Sin pauta (o sin permiso de lectura) se cae al campo único de siempre.
   */
  const usaCampPorCara = un === 'Ecovallas' && pautasCaras.length > 0;

  /**
   * Opciones de campaña de CADA cara, etiquetadas con su catorcena. Una
   * misma incidencia puede pegarle a caras con campañas distintas: por eso
   * el desplegable es por cara, no por partida (Erik, 11-sep-2026).
   */
  const opcionesPorCara = useMemo(() => {
    const porCara = new Map<string, Map<string, Set<string>>>();
    pautasCaras.forEach((p) => {
      const nombre = (p.campaign || '').trim();
      if (!nombre) return;
      const camps =
        porCara.get(p.vendor_face_id) || new Map<string, Set<string>>();
      const cats = camps.get(nombre) || new Set<string>();
      ventanaCats.forEach((c) => {
        if (
          (p.fecha_inicio || '') <= c.fecha_fin &&
          (p.fecha_fin || '') >= c.fecha_inicio
        )
          cats.add(c.cat_texto || `Cat-${c.numero}`);
      });
      camps.set(nombre, cats);
      porCara.set(p.vendor_face_id, camps);
    });
    const m = new Map<string, { nombre: string; cats: string }[]>();
    porCara.forEach((camps, vf) =>
      m.set(
        vf,
        [...camps.entries()]
          .map(([nombre, cats]) => ({ nombre, cats: [...cats].join(' / ') }))
          .sort((a, b) => a.nombre.localeCompare(b.nombre))
      )
    );
    return m;
  }, [pautasCaras, ventanaCats]);

  /**
   * La campaña VIGENTE HOY de cada cara. Si es exactamente una, se asigna
   * sola: el dato sale de QTM, no de la memoria del reportante. Con varias
   * vigentes (rotación digital) o ninguna, no se adivina: el reportante
   * elige del desplegable.
   */
  const autoPorCara = useMemo(() => {
    // Fecha LOCAL del dispositivo, no UTC: capturando de noche en México,
    // toISOString ya va en el día siguiente y en el cambio de catorcena
    // asignaría la campaña entrante a una foto de la saliente.
    const d = new Date();
    const hoy = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const vigentes = new Map<string, Set<string>>();
    pautasCaras.forEach((p) => {
      const nombre = (p.campaign || '').trim();
      if (!nombre) return;
      if ((p.fecha_inicio || '') <= hoy && (p.fecha_fin || '') >= hoy) {
        const s = vigentes.get(p.vendor_face_id) || new Set<string>();
        s.add(nombre);
        vigentes.set(p.vendor_face_id, s);
      }
    });
    const m = new Map<string, string>();
    vigentes.forEach((s, vf) => {
      if (s.size === 1) m.set(vf, [...s][0]);
    });
    return m;
  }, [pautasCaras]);

  // Prellenado: al marcar una cara sin decisión previa, entra su campaña
  // vigente. Nunca pisa lo que el usuario ya eligió (ni un "Sin campaña"
  // explícito, que queda guardado como '').
  useEffect(() => {
    if (!usaCampPorCara) return;
    setCampPorCara((prev) => {
      let cambio = false;
      const next = { ...prev };
      selCaras.forEach((vf) => {
        if (next[vf] !== undefined) return;
        const auto = autoPorCara.get(vf);
        if (auto) {
          next[vf] = auto;
          cambio = true;
        }
      });
      return cambio ? next : prev;
    });
  }, [usaCampPorCara, selCaras, autoPorCara]);

  // Precarga del sitio si el alta vino desde la bitácora.
  useEffect(() => {
    if (!preset?.siteId) return;
    (async () => {
      // El consecutivo se toma ANTES de esta primera consulta (revisión
      // primer mes, 24-sep-2026): si mientras responde se recupera un
      // borrador o se elige otro sitio a mano, la precarga ya no aplica. Sin
      // esto, el pickSite tardío sacaba un consecutivo nuevo, pasaba sus
      // guardias y ponía el sitio del preset debajo de las partidas
      // recuperadas de otro sitio.
      const seq = pickSeqRef.current;
      const siteId = preset.siteId as string;
      // Ya se enseña "cargando" desde aquí; quien invalide la precarga lo
      // suelta (soltarSitioEnVuelo) o lo reemplaza (pickSite).
      setSitioEnCarga(siteId);
      // La dirección sale primero de la copia del teléfono, al instante
      // (modo sin señal, 24-sep-2026). Ya no se consulta aparte a la red:
      // era la dirección de UNA cara del sitio (`.limit(1)`), la misma que
      // pickSite toma de las caras si aquí no hay; con señal fantasma eran
      // otros 4 s de espera antes de pedir las caras.
      const fila = await sitioLocal(siteId).catch(() => null);
      if (seq !== pickSeqRef.current) return;
      await pickSite({ site_id: siteId, direccion: fila?.direccion || '' });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ¿Hay un reporte sin terminar de otra apertura? Se OFRECE, nunca se
  // aplica solo: si el alta vino con preset (Pauta/bitácora) y el borrador
  // es de otro sitio, aplicarlo sin preguntar cambiaría el sitio que el
  // usuario acaba de elegir. El correo sale de la sesión; si auth-js no la
  // da a tiempo (sin red y con el token vencido reintenta largo), del que
  // registró el armazón. Sin correo no hay borrador.
  useEffect(() => {
    let activo = true;
    (async () => {
      const deSesion = sb.auth
        .getSession()
        .then(({ data }) => (data.session?.user?.email || '').trim().toLowerCase())
        .catch(() => '');
      const tarde = new Promise<string>((res) => setTimeout(() => res(''), ESPERA_SESION_MS));
      const em = (await Promise.race([deSesion, tarde])) || emailActivo();
      const ok = em ? await idbDisponible() : false;
      let b: Borrador<DatosBorrador> | null = null;
      if (ok) {
        b = await leerBorrador<DatosBorrador>(em);
        if (b && b.sesion === sesionRef.current) b = null;
        // Si ese borrador ya va en la cola de envíos (la app se cerró a
        // medio Guardar), ofrecerlo duplicaría el reporte: no se ofrece.
        // Tampoco se borra (revisión primer mes, 24-sep-2026): el envío usa
        // sus archivos, y puede ser la única copia de alguno. Lo cierra la
        // cola cuando el envío termina o se descarta (lib/borrador.ts).
        if (b && (await hayEnvioDeBorrador(b.sesion))) b = null;
      }
      if (!activo) return;
      setEmailBorrador(em);
      setIdbOk(ok);
      setOferta(b);
      setRevisado(true);
    })();
    return () => {
      activo = false;
    };
  }, []);

  // Fecha de la copia del inventario para el aviso 📴: se lee cuando algo
  // sale de la copia del teléfono, y otra vez en cada lectura nueva (la
  // sincronización pudo bajarla mientras el alta seguía abierta) (modo sin
  // señal, 24-sep-2026).
  useEffect(() => {
    if (!usandoCopia) return;
    let vivo = true;
    fechaCopia('inventario')
      .catch(() => null)
      .then((f) => {
        // Si la fecha no cambió, no se pide otro render (app pasmada sin
        // señal, 24-sep-2026): con la copia ya en memoria esta promesa se
        // cumple en microtareas, y un setState con el mismo valor también
        // agenda un render si el componente tiene updates pendientes.
        if (vivo && f !== fechaInvRef.current) setFechaInv(f);
      });
    return () => {
      vivo = false;
    };
    // `caras`: cada sitio cargado es una lectura nueva (se asigna tal cual,
    // así que su identidad no cambia al re-aplicar la cola).
  }, [usandoCopia, lecturasDeCopia, caras]);

  const limpiarSitio = () => {
    setSite(null);
    setSiteQuery('');
    setCaras([]);
    setSelCaras([]);
    setNombresPantalla({});
  };
  const toggleCara = (vf: string) =>
    setSelCaras((s) => (s.includes(vf) ? s.filter((x) => x !== vf) : [...s, vf]));
  const todas = () =>
    setSelCaras(
      selCaras.length === caras.length ? [] : caras.map((c) => c.vendor_face_id)
    );

  /** Deja el editor en blanco para capturar la siguiente falla del sitio. */
  const limpiarEditor = () => {
    setCatSel(null);
    setSelCaras(caras.length === 1 ? [caras[0].vendor_face_id] : []);
    setCampania('');
    setCampPorCara({});
    setCampLibrePorCara({});
    setObs('');
    setFilesLinea([]);
    setEditandoId(null);
  };

  /** Guarda la partida en edición: la agrega, o reemplaza la que se editaba. */
  const guardarPartida = () => {
    if (!catSel) {
      alert('Elige la incidencia del catálogo.');
      return;
    }
    if (selCaras.length === 0) {
      alert('Marca al menos una cara para esta incidencia.');
      return;
    }
    if (filesLinea.length === 0) {
      alert('Adjunta al menos una foto o video de esta incidencia.');
      return;
    }
    const datos = {
      cat: catSel,
      caras: [...selCaras],
      campania,
      // Foto del momento: solo las caras de ESTA partida, ya recortadas.
      campPorCara: usaCampPorCara
        ? Object.fromEntries(
            selCaras.map((vf) => [vf, (campPorCara[vf] || '').trim()])
          )
        : null,
      obs,
      files: filesLinea,
    };
    if (editandoId != null) {
      // Se reemplaza EN SU POSICIÓN: el orden del reporte no debe cambiar
      // solo porque se corrigió un dato.
      setLineas((prev) =>
        prev.map((l) => (l.id === editandoId ? { ...l, ...datos } : l))
      );
    } else {
      setLineas((prev) => [...prev, { id: Date.now() + Math.random(), ...datos }]);
    }
    limpiarEditor();
  };

  /** Carga una partida ya agregada de vuelta al editor para corregirla. */
  const editarLinea = (l: Linea) => {
    setCatSel(l.cat);
    setSelCaras([...l.caras]);
    setCampania(l.campania);
    setCampPorCara(l.campPorCara ? { ...l.campPorCara } : {});
    setCampLibrePorCara({});
    setObs(l.obs);
    setFilesLinea([...l.files]);
    setEditandoId(l.id);
  };

  const quitarLinea = (id: number) => {
    setLineas(lineas.filter((l) => l.id !== id));
    // Si se borró justo la que se estaba editando, el editor queda huérfano.
    if (editandoId === id) limpiarEditor();
  };

  /** Deja el formulario como estaba en el borrador (ver el efecto de restauración). */
  const aplicarBorrador = (d: DatosBorrador, archivos: Map<string, File>) => {
    const deClaves = (ks: string[] | undefined) =>
      (ks || []).map((k) => archivos.get(k)).filter((f): f is File => !!f);
    // Un pickSite en vuelo (el del preset) pisaría el sitio recuperado.
    soltarSitioEnVuelo();
    setSiteOpts([]);
    setNearOpts([]);
    setSiteQuery(d.site?.site_id || '');
    setSite(d.site);
    setCaras(d.caras || []);
    setNombresPantalla(d.nombresPantalla || {});
    setNombreBiobox(d.nombreBiobox || '');
    setContactoCorreo(d.contactoCorreo || '');
    setContactoTelefono(d.contactoTelefono || '');
    setViaReporte(d.viaReporte || '');
    setLado(d.lado || '');
    const ls: Linea[] = (d.lineas || []).map(({ archivos: ks, ...l }) => ({
      ...l,
      files: deClaves(ks),
    }));
    setLineas(ls);
    const ed = d.editor;
    setCatSel(ed?.catSel || null);
    setCatBusca('');
    setSelCaras(ed?.selCaras || []);
    setCampania(ed?.campania || '');
    setCampPorCara(ed?.campPorCara || {});
    setCampLibrePorCara(ed?.campLibrePorCara || {});
    setObs(ed?.obs || '');
    setFilesLinea(deClaves(ed?.archivos));
    setEditandoId(
      ed?.editandoId != null && ls.some((l) => l.id === ed.editandoId) ? ed.editandoId : null
    );
  };

  /** "Recuperar": carga las fotos del teléfono y arranca la restauración. */
  const recuperarBorrador = async () => {
    const ofrecido = oferta;
    if (!ofrecido || !emailBorrador) return;
    if (
      hayCaptura &&
      !confirm(
        'Lo que llevas capturado en este formulario se reemplazará por el reporte sin terminar. ¿Continuar?'
      )
    )
      return;
    setCargandoOferta(true);
    // Se vuelve a leer al tocar (revisión primer mes, 24-sep-2026): entre que
    // se ofreció y ahora, la cola pudo terminar un envío de ese borrador y
    // cerrarlo, u otra pestaña recuperarlo y mandarlo. Recuperar lo ya
    // enviado duplica el reporte. Si sigue, se usa lo más nuevo. Si la
    // lectura falla, se recupera lo ofrecido, como antes: darlo por borrado
    // dejaría que el autoguardado de este formulario borrara sus fotos.
    let b: Borrador<DatosBorrador> | null = ofrecido;
    try {
      b = (await idbGet<Borrador<DatosBorrador>>('borradores', emailBorrador)) ?? null;
    } catch {
      /* se sigue con lo ofrecido */
    }
    const sigue = !!b && b.sesion === ofrecido.sesion && !(await hayEnvioDeBorrador(b.sesion));
    if (!montadoRef.current) return;
    if (!b || !sigue) {
      setCargandoOferta(false);
      setOferta(null);
      alert('Ese reporte sin terminar ya no está en el teléfono: se envió o se descartó.');
      return;
    }
    const archivos = await cargarArchivosBorrador(b);
    if (!montadoRef.current) return;
    setCargandoOferta(false);
    if (escribioRef.current && sesionRef.current !== b.sesion)
      quitarBorrador(emailBorrador, sesionRef.current);
    // Se ADOPTA la sesión del borrador: seguir capturando lo actualiza a él
    // y sus fotos no se vuelven a copiar.
    sesionRef.current = b.sesion;
    escribioRef.current = true;
    const perdidos = (b.noGuardados || 0) + Math.max(0, (b.archivos?.length || 0) - archivos.size);
    setAvisoRecuperado(
      perdidos > 0
        ? `Se recuperó el reporte, pero ${perdidos} archivo${perdidos === 1 ? '' : 's'} no ` +
            'se habían podido guardar en el teléfono: vuelve a adjuntarlos en su incidencia.'
        : ''
    );
    setOferta(null);
    setUn(b.datos.un);
    setRestaurando({ datos: b.datos, archivos });
  };

  /** "Descartar" el borrador ofrecido: se borra con sus fotos. */
  const descartarOferta = () => {
    const b = oferta;
    if (!b || !emailBorrador) return;
    if (!confirm('¿Descartar el reporte sin terminar? Se borra de este teléfono con sus fotos.'))
      return;
    cerrarBorrador(emailBorrador, b.sesion);
    setOferta(null);
  };

  /**
   * El catálogo ya colapsado para ESTAS caras.
   *
   * El medio sale de las caras marcadas; si todavía no hay ninguna marcada,
   * del sitio (todas las caras de un sitio suelen compartir medio). Cuando el
   * sitio mezcla impreso y digital y hay caras de los dos marcadas, se deja
   * sin preferencia de medio a propósito: no hay una respuesta correcta, y
   * elegir una al azar sería peor que mostrar las dos entradas del catálogo
   * y dejar que quien captura escoja. Por eso la etiqueta trae el área.
   */
  /**
   * Las opciones que le tocan a las caras marcadas.
   *
   * El mueble sale de las caras marcadas; si todavía no hay ninguna, de todas
   * las del sitio. Se RESTRINGE, no se prefiere: dentro de un mueble cada
   * incidencia existe una sola vez, así que el área ya viene decidida y no
   * hay nada que adivinar. Ver lib/catalogo.ts.
   */
  const cat = useMemo(() => {
    const marcadas = caras.filter((c) => selCaras.includes(c.vendor_face_id));
    const base = marcadas.length ? marcadas : caras;
    // Caras DIGITALES reportan contra el árbol de Digital, no contra
    // catalogo_incidencias: así el nombre capturado siempre existe en el
    // árbol y la reparación sale guiada, nunca "Sin clasificar". Aplica a
    // cualquier unidad — en las mixtas (Ecovallas, Biobox) lo decide el
    // tipo_medio de las caras marcadas (Erik, 10-sep-2026). Si el árbol no
    // cargó, se cae al catálogo tradicional: peor lista que ninguna lista.
    const esDigital =
      base.length > 0 &&
      base.every((c) => (c.tipo_medio || '').trim().toLowerCase() === 'digital');
    if (esDigital && arbolNombres.length > 0) {
      return catalogoDesdeArbol(
        arbolNombres,
        catCrudo,
        base.map((c) => c.tipo_mueble)
      );
    }
    return catalogoParaMuebles(
      catCrudo,
      base.map((c) => c.tipo_mueble)
    );
  }, [catCrudo, arbolNombres, caras, selCaras]);

  const catOpts = cat.opciones;

  /** Lo que se ve en el desplegable tras aplicar el buscador. */
  const catVisibles = useMemo(() => {
    const base = filtrarCatalogo(catOpts, catBusca);
    // La opción elegida nunca desaparece de la lista: si el buscador la
    // filtrara, el <select> mostraría otra como seleccionada y se guardaría
    // una incidencia distinta de la que se está viendo.
    if (catSel && !base.some((o) => llaveCatalogo(o) === llaveCatalogo(catSel)))
      return [catSel, ...base];
    return base;
  }, [catOpts, catBusca, catSel]);

  /** ¿La partida mezcla muebles? Entonces una misma falla puede ir a dos áreas. */
  const mezclaMuebles = useMemo(() => {
    const marcadas = caras.filter((c) => selCaras.includes(c.vendor_face_id));
    const base = marcadas.length ? marcadas : caras;
    return new Set(base.map((c) => c.tipo_mueble).filter(Boolean)).size > 1;
  }, [caras, selCaras]);

  /** ¿Esta unidad tiene dos caras por estructura? */
  const pideLado = UNIDADES_CON_LADO.includes(un);

  /**
   * Pórticos de Vía Verde: orientación única por sitio, la "cara afectada"
   * no se elige — se prellena y queda fija.
   */
  const ladoFijo = ladoFijoDePortico(un, site?.site_id ?? null);
  useEffect(() => {
    if (ladoFijo) {
      setLado(ladoFijo);
    } else {
      // Al salir de un pórtico, un lado "Norte a Sur"/"Sur a Norte" no es
      // opción del selector normal: se limpia para que no viaje escondido.
      setLado((l) => ((LADOS as readonly string[]).includes(l) ? l : ''));
    }
  }, [ladoFijo]);

  // Recuperación del borrador, POR FASES. Los efectos de arriba reinician
  // el formulario al cambiar la unidad (sitio, caras, catálogo, lado): si
  // se restaurara todo de golpe junto con la unidad, lo pisarían. Por eso
  // "Recuperar" primero cambia la unidad y este efecto —declarado DESPUÉS
  // de todos esos, así corre después de ellos en el mismo ciclo— aplica el
  // resto cuando la unidad ya es la del borrador. El sitio no se vuelve a
  // consultar (las caras vienen en el borrador): recuperar funciona sin red.
  useEffect(() => {
    if (!restaurando || restaurando.datos.un !== un) return;
    aplicarBorrador(restaurando.datos, restaurando.archivos);
    setRestaurando(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurando, un]);

  const totalRows = lineas.reduce((s, l) => s + l.caras.length, 0);
  const unaCara = caras.length === 1;
  // Con una sola cara no se usan partidas: la incidencia elegida es el reporte.
  const nGuardar = unaCara ? (catSel ? 1 : 0) : totalRows;
  // Con una sola cara la evidencia se valida aquí; con varias, cada partida
  // ya la exigió al agregarse.
  const faltaEvidencia = unaCara && filesLinea.length === 0;

  const guardar = async () => {
    if (!site) {
      alert('Elige una clave de sitio.');
      return;
    }
    let partidas: Omit<Linea, 'id'>[] = lineas;
    if (unaCara) {
      if (!catSel) {
        alert('Elige la incidencia.');
        return;
      }
      if (filesLinea.length === 0) {
        alert('Adjunta al menos una evidencia (foto o video) para reportar.');
        return;
      }
      partidas = [
        {
          cat: catSel,
          caras: [caras[0].vendor_face_id],
          campania,
          campPorCara: usaCampPorCara
            ? {
                [caras[0].vendor_face_id]: (
                  campPorCara[caras[0].vendor_face_id] || ''
                ).trim(),
              }
            : null,
          obs,
          files: filesLinea,
        },
      ];
    } else if (lineas.length === 0) {
      alert('Agrega al menos una incidencia al reporte.');
      return;
    } else if (editandoId != null) {
      // Guardar con una edición a medias descartaría silenciosamente los
      // cambios que el usuario ya escribió en el editor.
      alert(
        'Tienes una incidencia abierta en edición.\n\n' +
          'Guarda los cambios o cancela la edición antes de guardar el reporte.'
      );
      return;
    } else if (lineas.some((l) => l.files.length === 0)) {
      // Solo pasa tras recuperar un borrador cuyas fotos no cupieron en el
      // teléfono: cada partida exige su evidencia al agregarse, y aquí no
      // debe colarse una sin ella.
      alert(
        'Hay incidencias en el reporte que se quedaron sin foto al recuperarlo.\n\n' +
          'Edítalas con ✏️ y vuelve a adjuntar su evidencia.'
      );
      return;
    }

    // Cinturón (revisión primer mes, 24-sep-2026): toda partida tiene que
    // ser de caras del sitio elegido. Si una respuesta tardía llegara a
    // cambiar el sitio debajo de partidas ya capturadas, cada fila saldría
    // con el sitio de uno y la cara de otro, y nada más lo detendría.
    const carasDelSitio = new Set(caras.map((c) => c.vendor_face_id));
    if (partidas.some((l) => l.caras.some((vf) => !carasDelSitio.has(vf)))) {
      alert('Las incidencias no corresponden al sitio elegido; revisa el sitio.');
      return;
    }

    // El lado va con el REPORTE completo, no con cada partida: se captura una
    // vez arriba y baja a todas las filas. Si estuviera por partida habría que
    // repetirlo en cada falla del mismo sitio, que es la forma más rápida de
    // que alguien lo deje mal en la tercera.
    if (pideLado && !lado) {
      alert('En ' + un + ' hay que indicar la cara afectada: Norte, Sur o Ambas.');
      return;
    }

    // MKT reporta en nombre de un tercero: sin su correo no hay a quién
    // regresarle respuesta. El teléfono sí es opcional.
    if (esMKT && !contactoCorreo.trim()) {
      alert('Agrega el correo de quien pidió el reporte.');
      return;
    }
    if (esMKT && !viaReporte) {
      alert('Indica por qué vía llegó la solicitud (WhatsApp, Instagram, Facebook o Correo).');
      return;
    }

    setBusy(true);
    // De qué borrador sale: la cola lo anota y lo cierra al terminar el
    // envío (ver GrupoReporte.borrador).
    const origen = emailBorrador
      ? { email: emailBorrador, sesion: sesionRef.current }
      : undefined;
    // Un grupo por partida. Dentro de cada grupo, producto partida × cara →
    // una fila de incidencias por cara, todas compartiendo las mismas fotos.
    const grupos: GrupoReporte[] = partidas.map((l) => ({
      files: l.files,
      borrador: origen,
      carasLabel: l.caras.map(caraLabel).join(', '),
      filas: l.caras.map((vf) => {
        const c =
          caras.find((x) => x.vendor_face_id === vf) || ({} as InventarioItem);
        return {
          unidad_negocio: un,
          clave_sitio: site.site_id,
          direccion: site.direccion,
          municipio: site.municipio || null,
          plaza: site.estado || null,
          clave_medio: vf,
          medio: c.tipo_medio || null,
          tipo_mueble: c.tipo_mueble || null,
          // "Nombre amigable del medio": el de máquina en Biobox, el de
          // pantalla en Ecovallas (nombres_pantallas, por cara). La columna
          // conserva su nombre histórico y toda la tubería ya la enseña.
          nombre_biobox: esBiobox
            ? nombreBiobox || null
            : nombresPantalla[vf] || null,
          nombre_incidencia: l.cat.detalle,
          area_responsable: l.cat.area,
          // impacto del catálogo viene con espacios de sobra.
          nivel: (l.cat.impacto || '').trim(),
          origen: l.cat.origen,
          tipo: l.cat.tipo,
          // Con pauta QTM cada fila lleva la campaña de SU cara; sin ella,
          // la única de la partida, como antes.
          campania: l.campPorCara
            ? l.campPorCara[vf] || null
            : l.campania || null,
          observaciones: l.obs || null,
          lado: pideLado ? lado : null,
          // Contacto del solicitante: solo lo captura MKT; fuera de ese
          // flujo va null (las columnas viven en incidencias_contacto_mkt.sql).
          contacto_correo: esMKT ? contactoCorreo.trim() || null : null,
          contacto_telefono: esMKT ? contactoTelefono.trim() || null : null,
          via_reporte: esMKT ? viaReporte || null : null,
        };
      }),
    }));
    await onSave(grupos);
    setBusy(false);
  };

  /** ¿Hay captura que se perdería al cerrar? */
  const hayCaptura =
    lineas.length > 0 || filesLinea.length > 0 || !!catSel || !!obs.trim();

  /**
   * Escribe el borrador con el estado de ESTE render. Vive en una ref para
   * que el debounce, el cierre y el desmontaje usen siempre lo más nuevo.
   * Un formulario vacío no se guarda; si esta apertura ya había guardado
   * algo y se vació (se quitaron todas las partidas), se borra.
   */
  guardarAhoraRef.current = () => {
    pendienteRef.current = false;
    const email = emailBorrador;
    if (!email || !idbOk) return;
    const sesion = sesionRef.current;
    if (!hayCaptura) {
      if (escribioRef.current) {
        escribioRef.current = false;
        quitarBorrador(email, sesion);
      }
      return;
    }
    const clave = (f: File) => claveDeArchivo(sesion, f);
    const datos: DatosBorrador = {
      un,
      site,
      caras,
      nombresPantalla,
      contactoCorreo,
      contactoTelefono,
      viaReporte,
      lado,
      nombreBiobox,
      lineas: lineas.map(({ files, ...l }) => ({ ...l, archivos: files.map(clave) })),
      editor: {
        catSel,
        selCaras,
        campania,
        campPorCara,
        campLibrePorCara,
        obs,
        archivos: filesLinea.map(clave),
        editandoId,
      },
    };
    // La partida del editor cuenta si tiene algo y no es una ya agregada.
    const enEditor = editandoId == null && (!!catSel || filesLinea.length > 0);
    escribioRef.current = true;
    guardarBorrador({
      email,
      sesion,
      datos,
      archivos: [...lineas.flatMap((l) => l.files), ...filesLinea],
      resumen: {
        sitio: site?.site_id || null,
        partidas: lineas.length + (enEditor ? 1 : 0),
      },
    }).then((r) => {
      if (montadoRef.current && r.guardado) setNoGuardados(r.noGuardados);
    });
  };

  // Autoguardado con debounce de ~1 s. En pausa mientras: no se sabe aún
  // si hay borrador que ofrecer, hay uno esperando respuesta (se pisaría),
  // se está restaurando, o se está guardando el reporte.
  useEffect(() => {
    if (!emailBorrador || !idbOk || !revisado || oferta || restaurando || busy) return;
    pendienteRef.current = true;
    const t = window.setTimeout(() => guardarAhoraRef.current(), 1000);
    return () => window.clearTimeout(t);
  }, [
    emailBorrador,
    idbOk,
    revisado,
    oferta,
    restaurando,
    busy,
    un,
    site,
    caras,
    nombresPantalla,
    contactoCorreo,
    contactoTelefono,
    viaReporte,
    lado,
    nombreBiobox,
    lineas,
    catSel,
    selCaras,
    campania,
    campPorCara,
    campLibrePorCara,
    obs,
    filesLinea,
    editandoId,
  ]);

  // Al desmontar, lo que quedaba en el debounce se escribe ya (si el
  // reporte se acaba de entregar a la cola, la sesión está sellada o
  // cerrada y no escribe nada).
  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
      if (pendienteRef.current) guardarAhoraRef.current();
    };
  }, []);

  // Igual cuando la página se va sin desmontar el formulario (revisión
  // primer mes, 24-sep-2026): iOS congela o mata la PWA en segundo plano, y
  // un Atrás que sale de la app no pasa por el cierre del modal. Sin esto,
  // lo capturado en el último segundo —o la foto recién adjuntada— se
  // perdía.
  useEffect(() => {
    const vaciar = () => {
      if (pendienteRef.current) guardarAhoraRef.current();
    };
    const alOcultar = () => {
      if (document.visibilityState === 'hidden') vaciar();
    };
    window.addEventListener('pagehide', vaciar);
    document.addEventListener('visibilitychange', alOcultar);
    return () => {
      window.removeEventListener('pagehide', vaciar);
      document.removeEventListener('visibilitychange', alOcultar);
    };
  }, []);

  /**
   * Cierre con seguro. En celular el overlay deja franjas de unos 8px a los
   * lados del modal: un roce ahí tiraba un reporte con N partidas y fotos
   * tomadas en campo, sin preguntar. Y mientras guarda, no se cierra.
   *
   * Con borrador (auditoría primer mes, 24-sep-2026) cerrar con partidas o
   * fotos NO lo borra —ese es justo el caso a proteger— y el mensaje lo
   * dice. Cerrar un formulario vacío sí borra el de esta apertura.
   */
  const cerrarSeguro = () => {
    if (busy) return;
    // ¿Lo capturado queda a salvo? Solo con correo, teléfono que deje
    // guardar y sin otro borrador esperando respuesta.
    const aSalvo = !!emailBorrador && idbOk && revisado && !oferta;
    if (hayCaptura) {
      if (
        !confirm(
          aSalvo
            ? 'Tienes un reporte a medio capturar. ¿Cerrarlo?\n\n' +
                'Queda guardado en este teléfono: al abrir un reporte nuevo podrás ' +
                'recuperarlo o descartarlo.'
            : 'Tienes un reporte a medio capturar. ¿Descartarlo?'
        )
      )
        return;
      // Lo que estaba en el debounce se escribe ya.
      if (aSalvo) guardarAhoraRef.current();
    } else if (emailBorrador && escribioRef.current) {
      escribioRef.current = false;
      pendienteRef.current = false;
      quitarBorrador(emailBorrador, sesionRef.current);
    }
    onClose();
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') cerrarSeguro();
      }}
    >
      <div className="modal">
        {/* Borrador de otra apertura (auditoría primer mes, 24-sep-2026).
            Arriba de todo: es lo primero que hay que decidir. */}
        {oferta && (
          <div className="banner" style={{ marginBottom: 12 }} role="status">
            📝 Tienes un reporte sin terminar {cuandoBorrador(oferta.guardado_en)} (
            {oferta.resumen?.sitio || 'sin sitio'}, {oferta.resumen?.partidas || 0} partida
            {(oferta.resumen?.partidas || 0) === 1 ? '' : 's'})
            {oferta.noGuardados > 0 && (
              <>
                {' '}
                · {oferta.noGuardados}{' '}
                {oferta.noGuardados === 1
                  ? 'archivo no se pudo guardar'
                  : 'archivos no se pudieron guardar'}{' '}
                en el teléfono
              </>
            )}
            {!misUnidades.includes(oferta.datos.un) && (
              <div style={{ marginTop: 6 }}>
                Es de {oferta.datos.un}: recupéralo desde el módulo de Incidencias.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button
                type="button"
                className="btn sm"
                onClick={recuperarBorrador}
                disabled={cargandoOferta || !misUnidades.includes(oferta.datos.un)}
              >
                {cargandoOferta && <span className="spinner" />} Recuperar
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={descartarOferta}
                disabled={cargandoOferta}
              >
                Descartar
              </button>
            </div>
            {hayCaptura && (
              <div style={{ marginTop: 6, color: 'var(--warn)' }}>
                Mientras no elijas, lo que captures ahora no se guarda en el teléfono.
              </div>
            )}
          </div>
        )}
        {avisoRecuperado && (
          <div
            className="banner"
            style={{ marginBottom: 12, color: 'var(--warn)' }}
            onClick={() => setAvisoRecuperado('')}
            role="alert"
          >
            {avisoRecuperado} <span style={{ opacity: 0.7 }}>(toca para cerrar)</span>
          </div>
        )}
        <h2 style={{ margin: '0 0 3px' }}>Reporte de incidencias del sitio</h2>
        <p className="phint">
          Elige el sitio una vez y agrega todas las fallas: cada una a las caras
          que apliquen.
        </p>
        {/* Aviso discreto de que algo salió de la copia del teléfono (modo
            sin señal, 24-sep-2026): quien captura sabe con qué fecha trabaja. */}
        {usandoCopia && (
          <div
            style={{ fontSize: 12, color: 'var(--muted)', margin: '-4px 0 10px' }}
            role="status"
          >
            📴{' '}
            {fechaInv === null
              ? SIN_COPIA_INVENTARIO
              : fechaInv
                ? `Usando la copia del teléfono (inventario del ${fechaCorta(fechaInv)})`
                : 'Usando la copia del teléfono'}
          </div>
        )}

        <div className="field">
          <label>Unidad de negocio</label>
          <select
            value={un}
            onChange={(e) => setUn(e.target.value)}
            disabled={lineas.length > 0}
          >
            {misUnidades.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>

        <div className="field" style={{ position: 'relative' }}>
          <label>Clave de sitio</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              value={siteQuery}
              onChange={(e) => {
                // Escribir otra clave invalida la elección que siga cargando.
                soltarSitioEnVuelo();
                setSite(null);
                setNearOpts([]);
                setSiteQuery(e.target.value);
              }}
              placeholder="Escribe para buscar (ej. eva 03)…"
              disabled={lineas.length > 0}
              style={{ flex: '1 1 160px', minWidth: 0, width: 'auto' }}
            />
            {site && lineas.length === 0 && (
              <button
                className="btn ghost sm"
                type="button"
                onClick={limpiarSitio}
              >
                ✕
              </button>
            )}
          </div>
          {lineas.length === 0 && !site && (
            <button
              className="btn ghost sm"
              type="button"
              style={{ marginTop: 8 }}
              onClick={buscarCerca}
              disabled={geoBusy}
            >
              {geoBusy ? '📍 Ubicando…' : '📍 Sitios cerca de mí'}
            </button>
          )}
          {/* Con resultados de la copia ya a la vista no se dice "Buscando…"
              aunque la red siga en camino (tope de unos segundos). */}
          {loadingSites && !site && !sitioEnCarga && siteOpts.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Buscando…
            </div>
          )}
          {!loadingSites && !site && !sitioEnCarga && !!sinResultados && !!siteQuery.trim() && (
            <div
              style={{
                fontSize: 12,
                color: sinResultados === 'sinCopia' ? 'var(--warn)' : 'var(--muted)',
                marginTop: 4,
              }}
            >
              {sinResultados === 'sinCopia' ? (
                // Por qué no llegó la red, y cómo volver a pedirla (revisión
                // sin señal, 24-sep-2026).
                <>
                  {sinCopiaInventario()}{' '}
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setReintentoSitios((n) => n + 1)}
                  >
                    Reintentar
                  </button>
                </>
              ) : (
                'Sin resultados'
              )}
            </div>
          )}
          {sitioEnCarga && !site && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              <span className="spinner" /> Cargando los medios del sitio…
            </div>
          )}
          {siteOpts.length > 0 && !site && (
            <div
              style={{
                position: 'absolute',
                zIndex: 5,
                left: 0,
                right: 0,
                background: 'var(--panel2)',
                border: '1px solid var(--line)',
                borderRadius: 9,
                marginTop: 4,
                maxHeight: 220,
                overflow: 'auto',
              }}
            >
              {siteOpts.map((o) => (
                <div
                  key={o.site_id}
                  onClick={() => pickSite(o)}
                  style={{
                    padding: '9px 11px',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--line)',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{o.site_id}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {o.direccion}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {nearOpts.length > 0 && !site && (
          <div className="field">
            <label>📍 Sitios cerca de ti ({nearOpts.length})</label>
            <div style={{ display: 'grid', gap: 6, maxHeight: 220, overflow: 'auto' }}>
              {nearOpts.map((o) => (
                <div
                  key={o.site_id}
                  onClick={() => pickSite(o)}
                  style={{
                    background: 'var(--panel2)',
                    border: '1px solid var(--line)',
                    borderRadius: 9,
                    padding: '9px 11px',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                >
                  {/* minWidth:0: sin él, una dirección larga no deja encoger
                      al bloque y estruja la píldora de distancia. */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {o.site_id}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {o.direccion}
                    </div>
                  </div>
                  <span
                    className="pill"
                    style={{
                      background: '#4f8cff22',
                      color: '#4f8cff',
                      alignSelf: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {o.dist < 1
                      ? Math.round(o.dist * 1000) + ' m'
                      : o.dist.toFixed(1) + ' km'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {site && (
          <div className="banner" style={{ marginBottom: 12 }}>
            📍 {site.direccion || '(sin dirección)'}
            <br />
            Municipio: {site.municipio || '—'} · Plaza: {site.estado || '—'} ·{' '}
            {caras.length} medio{caras.length === 1 ? '' : 's'} en este sitio
            {/* Sin red y sin el sitio en la copia (modo sin señal,
                24-sep-2026): se dice por qué no hay medios y se deja
                reintentar, en vez del callejón de "0 medios". */}
            {caras.length === 0 && deCopia.caras && (
              <div style={{ marginTop: 6, color: 'var(--warn)' }}>
                No se pudieron cargar los medios:{' '}
                {motivoSinRed() === 'Sin señal' ? 'no hay señal' : 'la red tardó demasiado'} y
                este teléfono no tiene este sitio en su copia.{' '}
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => pickSite(site)}
                  disabled={!!sitioEnCarga}
                >
                  {sitioEnCarga ? 'Cargando…' : 'Reintentar'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* El lado (Norte/Sur/Ambas) ya NO se pregunta aquí arriba: se
            pregunta abajo con la etiqueta "Cara afectada", que es como lo
            nombra quien captura (Erik, sep-2026). Sigue siendo UN dato por
            reporte —baja a todas las filas—, solo cambió de lugar. */}

        {site && esBiobox && (
          <div className="field">
            <label>Nombre del Biobox (del inventario)</label>
            <input
              value={nombreBiobox || '(sin nombre en inventario)'}
              readOnly
              style={{ opacity: 0.75, cursor: 'default' }}
            />
          </div>
        )}

        {/* MKT reporta en nombre de terceros: el contacto es del REPORTE
            (baja a todas las filas), por eso vive aquí arriba y no dentro
            del editor de partidas. */}
        {site && esMKT && (
          <>
            <div className="field">
              <label>
                Vía de reporte <span style={{ color: 'var(--accent)' }}>*</span>
              </label>
              <select value={viaReporte} onChange={(e) => setViaReporte(e.target.value)}>
                <option value="">— ¿por dónde llegó la solicitud? —</option>
                {VIAS_REPORTE.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </div>
            <div className="row2">
              <div className="field">
                <label>
                  Correo de quien pidió el reporte{' '}
                  <span style={{ color: 'var(--accent)' }}>*</span>
                </label>
                <input
                  type="email"
                  value={contactoCorreo}
                  onChange={(e) => setContactoCorreo(e.target.value)}
                  placeholder="persona@cliente.com"
                />
              </div>
              <div className="field">
                <label>Teléfono (opcional)</label>
                <input
                  type="tel"
                  value={contactoTelefono}
                  onChange={(e) => setContactoTelefono(e.target.value)}
                  placeholder="55 0000 0000"
                />
              </div>
            </div>
          </>
        )}

        {lineas.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <label>
              Incidencias en el reporte ({lineas.length} · {totalRows} caras en
              total)
            </label>
            <div style={{ display: 'grid', gap: 7 }}>
              {lineas.map((l) => (
                <div
                  key={l.id}
                  style={{
                    background: 'var(--panel2)',
                    // La que se está editando se resalta: si no, no se sabe a
                    // cuál corresponde lo que hay abajo en el editor.
                    border:
                      '1px solid ' +
                      (editandoId === l.id ? 'var(--accent)' : 'var(--line)'),
                    borderRadius: 9,
                    padding: '9px 11px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                >
                  {/* minWidth:0 para que el detalle largo encoja en vez de
                      empujar los botones ✏️ 🗑 fuera de la tarjeta. */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {l.cat.detalle}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--muted)',
                        marginTop: 2,
                      }}
                    >
                      → {l.cat.area} · Nivel {(l.cat.impacto || '').trim()} ·
                      caras: {l.caras.map(caraLabel).join(', ')}
                      <br />
                      <span style={{ color: 'var(--ok)' }}>
                        📎 {l.files.length} archivo
                        {l.files.length > 1 ? 's' : ''} para{' '}
                        {l.caras.length > 1 ? 'estas caras' : 'esta cara'}
                      </span>
                      {editandoId === l.id && (
                        <>
                          {' · '}
                          <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
                            editando abajo
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn ghost sm"
                      title="Editar esta incidencia"
                      onClick={() => editarLinea(l)}
                    >
                      ✏️
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      title="Quitar del reporte"
                      onClick={() => quitarLinea(l.id)}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {site && (
          <div
            style={{
              border: '1px dashed var(--line)',
              borderRadius: 12,
              padding: '12px 12px 4px',
              marginBottom: 14,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>
              {editandoId != null
                ? '✏️ Editando una incidencia del reporte'
                : '➕ Agregar una incidencia'}
            </div>

            <div className="field">
              <label>
                Incidencia ({cat.desdeArbol ? 'catálogo Digital' : 'catálogo'} ·{' '}
                {catVisibles.length} de {catOpts.length})
              </label>
              <input
                placeholder="Buscar por incidencia o por área…"
                value={catBusca}
                onChange={(e) => setCatBusca(e.target.value)}
                style={{ marginBottom: 8 }}
              />
              <select
                value={catSel ? llaveCatalogo(catSel) : ''}
                onChange={(e) =>
                  setCatSel(
                    catOpts.find((o) => llaveCatalogo(o) === e.target.value) ||
                      null
                  )
                }
              >
                <option value="">— Selecciona —</option>
                {catVisibles.map((o) => (
                  <option key={llaveCatalogo(o)} value={llaveCatalogo(o)}>
                    {o.detalle}
                    {o.area ? ` (${o.area})` : ''}
                  </option>
                ))}
              </select>
              {catBusca && catVisibles.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}>
                  Nada coincide con “{catBusca}”.
                </div>
              )}
              {catCrudo.length === 0 && deCopia.catalogo && (
                <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}>
                  {/* Sin señal o red lenta, y con Reintentar: el sondeo de
                      15 s sigue, pero no hay por qué esperarlo (revisión sin
                      señal, 24-sep-2026). */}
                  {haySenal()
                    ? `La red tardó demasiado, y este teléfono no tiene copia del catálogo de ${un}.`
                    : `📴 Sin señal, y este teléfono no tiene copia del catálogo de ${un}. Abre la app una vez con señal.`}{' '}
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setReintentoCat((n) => n + 1)}
                    disabled={catEnVuelo}
                  >
                    {catEnVuelo ? 'Cargando…' : 'Reintentar'}
                  </button>
                </div>
              )}
              {cat.sinCatalogo.length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}>
                  ⚠️ El catálogo no tiene entradas para el mueble{' '}
                  <b>{cat.sinCatalogo.join(', ')}</b>, así que abajo salen
                  TODAS las incidencias y el área no viene decidida. Revisa el
                  área que trae la opción entre paréntesis antes de guardar.
                </div>
              )}
              {cat.desdeArbol && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                  Cara digital: estas incidencias vienen del árbol de Digital,
                  el mismo con el que el técnico clasifica la reparación.
                </div>
              )}
              {mezclaMuebles && cat.restringido && !cat.desdeArbol && (
                <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}>
                  ⚠️ Marcaste caras de muebles distintos. Una misma falla puede
                  tocarle a áreas diferentes según el mueble — por eso hay
                  opciones repetidas con distinta área entre paréntesis. Si es
                  el caso, conviene capturarlas como dos partidas.
                </div>
              )}
            </div>

            {catSel && (
              <div className="chips" style={{ marginBottom: 12 }}>
                <span className="tag">
                  Área: <b>{catSel.area || '—'}</b>
                </span>
                <span
                  className="pill"
                  style={{
                    background:
                      (NIVEL_COLOR[(catSel.impacto || '').trim()] || '#555') + '22',
                    color: NIVEL_COLOR[(catSel.impacto || '').trim()] || '#aaa',
                  }}
                >
                  Nivel {(catSel.impacto || '').trim() || '—'}
                </span>
                {/* Origen y tipo (Imponderable…) se derivan y guardan igual,
                    pero ya no se enseñan junto al nivel (Erik, 30-ago-2026). */}
              </div>
            )}

            {caras.length > 1 && (
              <div className="field">
                <label>
                  Medios afectados ({selCaras.length}/{caras.length}){' '}
                  <button
                    type="button"
                    className="btn ghost sm"
                    style={{ marginLeft: 8 }}
                    onClick={todas}
                  >
                    {selCaras.length === caras.length ? 'Ninguna' : 'Todas'}
                  </button>
                </label>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))',
                    gap: 6,
                    /* 260 y no 150: en 360px el grid queda en 2 columnas y
                       un sitio de 8 caras necesita 4 filas (~180px); con 150
                       la cara buscada quedaba oculta tras un scroll interno
                       anidado dentro del scroll del modal. */
                    maxHeight: 260,
                    overflow: 'auto',
                  }}
                >
                  {caras.map((c) => (
                    <label
                      key={c.vendor_face_id}
                      style={{
                        display: 'flex',
                        gap: 7,
                        alignItems: 'center',
                        background: 'var(--panel)',
                        border:
                          '1px solid ' +
                          (selCaras.includes(c.vendor_face_id)
                            ? 'var(--accent)'
                            : 'var(--line)'),
                        borderRadius: 8,
                        padding: '6px 8px',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={selCaras.includes(c.vendor_face_id)}
                        onChange={() => toggleCara(c.vendor_face_id)}
                      />
                      <span>
                        <b>{caraLabel(c.vendor_face_id)}</b> ·{' '}
                        {c.categoria || c.tipo_medio}
                        {nombresPantalla[c.vendor_face_id]
                          ? ` · ${nombresPantalla[c.vendor_face_id]}`
                          : ''}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* En las unidades con lado, la "cara afectada" que entiende el
                que captura es Norte/Sur/Ambas — la cara física del
                inventario es la columna ("COL") y no dice nada. El selector
                escribe `lado` (un dato por reporte, baja a todas las filas)
                y la cara física se asigna sola. */}
            {pideLado && caras.length > 0 && (
              <div className="field">
                <label>Cara afectada</label>
                {ladoFijo ? (
                  <>
                    <div
                      className="tag"
                      style={{ display: 'inline-block', padding: '6px 10px' }}
                    >
                      {ladoFijo}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                      Pórtico con orientación fija: no se elige.
                    </div>
                  </>
                ) : (
                  <>
                    <select value={lado} onChange={(e) => setLado(e.target.value)}>
                      <option value="">— Selecciona —</option>
                      {LADOS.map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                      En {un} la estructura tiene dos caras. Sin esto el técnico
                      llega sin saber a cuál va.
                    </div>
                  </>
                )}
              </div>
            )}
            {caras.length === 1 && !pideLado && (
              <div className="field">
                <label>Cara afectada</label>
                <div
                  className="tag"
                  style={{ display: 'inline-block', padding: '6px 10px' }}
                >
                  {caraLabel(caras[0].vendor_face_id)} ·{' '}
                  {caras[0].categoria || caras[0].tipo_medio}
                  {nombresPantalla[caras[0].vendor_face_id]
                    ? ` · ${nombresPantalla[caras[0].vendor_face_id]}`
                    : ''}
                </div>
              </div>
            )}

            <div className="row2">
              <div className="field">
                {usaCampPorCara ? (
                  <>
                    <label>Campaña por cara</label>
                    {selCaras.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                        Marca las caras afectadas y aquí aparece la campaña
                        pautada de cada una.
                      </div>
                    ) : (
                      selCaras.map((vf) => {
                        const ops = opcionesPorCara.get(vf) || [];
                        const val = campPorCara[vf] ?? '';
                        const enOps = ops.some((o) => o.nombre === val);
                        // Una campaña escrita a mano (o de una partida vieja
                        // ya no pautada) se enseña como "Otra…" con su texto.
                        const escribiendo =
                          !!campLibrePorCara[vf] || (!!val && !enOps);
                        return (
                          <div
                            key={vf}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              flexWrap: 'wrap',
                              marginBottom: 6,
                            }}
                          >
                            <span className="tag" style={{ flexShrink: 0 }}>
                              {caraLabel(vf)}
                            </span>
                            <select
                              style={{ flex: 1, minWidth: 150, width: 'auto' }}
                              value={
                                escribiendo ? '__otra__' : enOps ? val : ''
                              }
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === '__otra__') {
                                  setCampLibrePorCara((p) => ({
                                    ...p,
                                    [vf]: true,
                                  }));
                                } else {
                                  setCampPorCara((p) => ({ ...p, [vf]: v }));
                                  setCampLibrePorCara((p) => ({
                                    ...p,
                                    [vf]: false,
                                  }));
                                }
                              }}
                            >
                              <option value="">— Sin campaña —</option>
                              {ops.map((o) => (
                                <option key={o.nombre} value={o.nombre}>
                                  {o.nombre}
                                  {o.cats ? ` · ${o.cats}` : ''}
                                </option>
                              ))}
                              <option value="__otra__">Otra…</option>
                            </select>
                            {escribiendo && (
                              <input
                                value={val}
                                onChange={(e) =>
                                  setCampPorCara((p) => ({
                                    ...p,
                                    [vf]: e.target.value,
                                  }))
                                }
                                placeholder="Escribe la campaña…"
                                style={{ flex: '1 1 100%' }}
                              />
                            )}
                          </div>
                        );
                      })
                    )}
                    <div
                      style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}
                    >
                      Precargada con la pauta vigente de QTM de cada cara.
                      Cámbiala si lo que ves en campo es otra.
                    </div>
                  </>
                ) : (
                  <>
                    <label>Campaña</label>
                    <input
                      value={campania}
                      onChange={(e) => setCampania(e.target.value)}
                    />
                  </>
                )}
              </div>
              <div className="field">
                <label>Observaciones</label>
                <input
                  value={obs}
                  onChange={(e) => setObs(e.target.value)}
                  placeholder={
                    esMKT ? 'El detalle de lo que el usuario reporta…' : undefined
                  }
                />
                {esMKT && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    Escribe aquí, con sus palabras, lo que el usuario está
                    reportando: es lo que verán el validador y el técnico.
                  </div>
                )}
              </div>
            </div>

            <div className="field">
              <label>
                Evidencia de ESTA incidencia (foto/video) —{' '}
                <span style={{ color: 'var(--accent)' }}>obligatoria</span>
              </label>
              <SubirArchivos
                archivos={filesLinea}
                onFiles={(nuevos) => setFilesLinea((f) => [...f, ...nuevos])}
                onQuitar={(i) =>
                  setFilesLinea((f) => f.filter((_, idx) => idx !== i))
                }
              />
              <div
                style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}
              >
                {filesLinea.length > 0 ? (
                  <>
                    {filesLinea.length} archivo(s) ·{' '}
                    {selCaras.length > 0 ? (
                      <span style={{ color: 'var(--ok)' }}>
                        se ligarán a {selCaras.map(caraLabel).join(', ')}
                      </span>
                    ) : (
                      'marca las caras afectadas'
                    )}
                  </>
                ) : (
                  'Estas fotos quedan ligadas solo a las caras que marques arriba.'
                )}
              </div>
            </div>

            {caras.length > 1 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <button
                  type="button"
                  className={editandoId != null ? 'btn sm' : 'btn ghost sm'}
                  onClick={guardarPartida}
                >
                  {editandoId != null
                    ? '💾 Guardar cambios'
                    : '➕ Agregar esta incidencia al reporte'}
                </button>
                {editandoId != null && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={limpiarEditor}
                  >
                    Cancelar edición
                  </button>
                )}
              </div>
            )}
            {caras.length === 1 && (
              <div
                style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}
              >
                Se agregará automáticamente al guardar.
              </div>
            )}
          </div>
        )}

        {noGuardados > 0 && (
          <div style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 8 }}>
            ⚠️ {noGuardados}{' '}
            {noGuardados === 1 ? 'archivo no cupo' : 'archivos no cupieron'} en el
            teléfono: si la app se cierra antes de guardar, habría que volver a
            adjuntar{noGuardados === 1 ? 'lo' : 'los'}.
          </div>
        )}
        <div className="modal-actions">
          {/* Mismo seguro que el fondo: Cancelar junto a Guardar en un
              teléfono se toca por error, y tira las fotos de campo. */}
          <button className="btn ghost" onClick={cerrarSeguro}>
            Cancelar
          </button>
          <button
            className="btn"
            onClick={guardar}
            disabled={busy || nGuardar === 0 || faltaEvidencia}
          >
            {busy && <span className="spinner" />}
            {busy ? 'Guardando…' : `Guardar reporte (${nGuardar})`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default NuevaInc;
