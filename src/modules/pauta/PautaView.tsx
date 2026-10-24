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
import {
  Camera,
  CloudUpload,
  Download,
  Map as MapIcon,
  Plus,
  Search,
  User,
} from 'lucide-react';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { sb } from '../../lib/supabase';
import IrAqui from '../../components/IrAqui';
import { tramosGoogleMaps } from '../../lib/navegacion';
import { crearReporte } from '../../lib/crearReporte';
import { EST_LABEL, EST_TONO } from '../../lib/constants';
import { NARANJA } from '../../lib/helpers';
import { colorTono, fondoTono } from '../../lib/tonos';
import {
  resumenMaquinas,
  detalleMaquina,
  HORAS_ALARMA,
} from '../../lib/estadoMaquina';
import type { MapaResumen, IncidenciaAbierta } from '../../lib/estadoMaquina';
import ImportarPautaModal from './ImportarPautaModal';
import RegistrarTomaModal, { type InfoRegistro } from './RegistrarTomaModal';
import { olvidarRegistrada, resumenTomas, suscribirTomas, tomasRegistradasEnSesion } from '../../lib/tomasPauta';
import { llaveCara, type ResumenCara } from '../../lib/tomasPautaLogica';
import NuevaInc from '../incidencias/NuevaInc';
import type { GrupoReporte } from '../incidencias/NuevaInc';
import type { PautaRuta } from '../../types/db';
import { vigilarRender } from '../../lib/vigia';
import { tope } from '../../lib/envios';
import { subirYLuego, subirYRegresar } from '../../lib/subirAntes';
import { claveCatorcena, etiquetaCatorcena, leerClaveCatorcena } from '../../lib/catorcena';
import IndicadoresPauta from './IndicadoresPauta';
import AnalistaPauta from './AnalistaPauta';
import CerrarModal from '../../components/CerrarModal';
import { useFocoModal } from '../../lib/useFocoModal';
import Ic from '../../components/Ic';

/**
 * La pauta es de Ecovallas Impreso (decisión de sep-2026): los reportes
 * que nacen aquí se capturan en esa unidad, sin selector.
 */
const UNIDAD_PAUTA = 'Ecovallas';

/** Tope de filas: el límite duro de Supabase es 1000 por consulta. */
const PAGINA = 1000;
/** Sitios que la Lista dibuja por tanda. */
const SITIOS_POR_PAGINA = 100;

/**
 * Colores del estado de avance, con su tinte (tema claro/oscuro,
 * 24-sep-2026). Antes eran var(--muted)/var(--warn)/var(--ok) y la pastilla
 * les concatenaba '22': `var(--warn)22` es CSS inválido y la pastilla nunca
 * tuvo tinte. Ahora texto y tinte salen del mismo tono, legibles en los dos
 * temas; Pendiente conserva el texto --muted (el gris de estatus es más
 * oscuro y en el tema oscuro se leería peor).
 */
const COLOR_AVANCE: Record<string, { color: string; background: string }> = {
  PENDIENTE: { color: 'var(--muted)', background: fondoTono('gris') },
  TOMADA: { color: colorTono('ambar'), background: fondoTono('ambar') },
  COMPROBADA: { color: colorTono('verde'), background: fondoTono('verde') },
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
  /** Departamentos del usuario: area_reportante del reporte que levante. */
  misDep: string[];
  /**
   * Cambia cuando una notificación de pauta trae al usuario aquí (toma
   * regresada, toma por comprobar, ruta asignada): recarga la catorcena
   * para que vea el estado FRESCO — sin esto, una lista ya abierta seguía
   * enseñando la toma como registrada aunque se la acabaran de regresar.
   */
  recargarSignal?: number;
  /**
   * Analista (o manager): ve todas las rutas como el coordinador
   * (20-oct-2026). Su pestaña de revisión vive en Comprobaciones desde el
   * 23-oct-2026 (modo 'analista').
   */
  revisaAnalista?: boolean;
  /** Pestaña que pide un aviso ('indicadores'); `n` cambia en cada aviso. */
  vistaPedida?: { vista: VistaPauta; n: number } | null;
  /**
   * 'analista' (Erik, 23-oct-2026): la pestaña donde el analista revisa,
   * rechaza y regresa las tomas del monitorista se mudó a Comprobaciones
   * («Tomas de Pauta»). Comprobaciones monta PautaView en este modo: solo esa
   * vista, sin Lista ni Indicadores ni el título del módulo, con la misma
   * carga de la catorcena. En 'completo' (Pauta y Monitoreo) ya no sale.
   */
  modo?: 'completo' | 'analista';
  /** Solo ver las tomas, sin revisar (Supervisor sin fila de analista). */
  soloVer?: boolean;
  /**
   * Analista sin otro rol de Pauta (Erik, 24-oct-2026: «es solo de
   * revisión»): no registra ni termina tomas ni sube fotos; solo ve la
   * evidencia que ya existe. La base lo exige igual (registrar_toma).
   */
  soloRevisa?: boolean;
  /**
   * Quien ve «Tomas de Pauta» en Comprobaciones: en modo 'completo' se le
   * dice dónde quedó la revisión y este botón lo lleva ahí (revisión 3,
   * 23-oct-2026: el aviso «Toma por revisar» todavía dice «pestaña
   * Analista», que ya no existe aquí).
   */
  onIrATomas?: () => void;
};

type VistaPauta = 'lista' | 'indicadores' | 'analista';

function PautaView({
  puedeImportar,
  email,
  misDep,
  recargarSignal,
  revisaAnalista,
  vistaPedida,
  modo = 'completo',
  soloVer,
  soloRevisa,
  onIrATomas,
}: Props) {
  vigilarRender('PautaView');
  const [filas, setFilas] = useState<PautaRuta[]>([]);
  /**
   * Catorcenas con pauta cargada, la más reciente primero. Desde el
   * 14-oct-2026 son número + AÑO: `catSel` es la llave "2026-16" (ver
   * lib/catorcena.ts), así la Cat-1 de 2027 no se junta con la de 2026.
   */
  const [catorcenas, setCatorcenas] = useState<{ anio: number; numero: number }[]>([]);
  const [catSel, setCatSel] = useState<string | null>(null);
  const catSelLeida = leerClaveCatorcena(catSel);
  /**
   * Lista de caras o Indicadores (avance y comprobaciones; 14-oct-2026). La
   * vista Analista (20-oct-2026) solo existe en modo 'analista', desde
   * Comprobaciones (23-oct-2026).
   */
  const [vista, setVista] = useState<VistaPauta>(modo === 'analista' ? 'analista' : 'lista');
  useEffect(() => {
    if (!vistaPedida || modo === 'analista') return;
    if (vistaPedida.vista === 'analista') return;
    setVista(vistaPedida.vista);
    // Solo cuando llega un aviso nuevo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vistaPedida?.n]);
  /** Coordinador, manager y analista ven todas las rutas; el monitorista, las suyas. */
  const veTodo = puedeImportar || !!revisaAnalista;
  const [loading, setLoading] = useState(true);
  /** Ya terminó la primera carga: cambiar de catorcena ya NO cambia la
   *  pantalla por "Cargando pauta…". Desmontaba el selector con la rueda de
   *  iPhone abierta y el menú inferior quedaba a media pantalla (Erik,
   *  5-oct-2026). Lo anterior queda atenuado hasta que llega lo nuevo. */
  const [yaCargo, setYaCargo] = useState(false);
  useEffect(() => {
    if (!loading) setYaCargo(true);
  }, [loading]);
  const recargando = loading && yaCargo;
  const [err, setErr] = useState('');
  const [importar, setImportar] = useState(false);
  /**
   * Guías de ruta (tramos de Google Maps) APAGADAS por omisión: en el día a
   * día el monitorista ya se sabe el recorrido y los botones solo empujaban
   * la lista hacia abajo. Se prenden cuando va alguien nuevo a la ruta
   * (Erik, ago-2026). La elección se recuerda POR DISPOSITIVO en
   * localStorage — no es configuración compartida: cada teléfono decide.
   */
  const [verGuias, setVerGuias] = useState(() => {
    try {
      return localStorage.getItem('pauta_ver_guias') === '1';
    } catch {
      return false;
    }
  });
  const toggleGuias = () =>
    setVerGuias((v) => {
      try {
        localStorage.setItem('pauta_ver_guias', v ? '0' : '1');
      } catch {
        // Modo privado o storage bloqueado: el toggle vive solo esta sesión.
      }
      return !v;
    });
  /** Cara cuya toma se está registrando (abre el modal con cámara). */
  const [tomaDe, setTomaDe] = useState<PautaRuta | null>(null);

  /**
   * Sitio recién tomado al que se le ofrece levantar incidencia: al
   * registrar la toma se pregunta —de forma sutil, un mini diálogo, no un
   * confirm()— si algo del sitio amerita reporte.
   */
  const [ofrecerIncEn, setOfrecerIncEn] = useState<string | null>(null);
  /** El registro de esa toma quedó en la cola (se registra al subir las fotos). */
  const [ofrecerEnCola, setOfrecerEnCola] = useState(false);

  /**
   * La cola de tomas del teléfono (fase 1 de comprobaciones, 22-oct-2026):
   * por cara, lo que sigue sin subir y si ya se pidió el registro. Encima de
   * lo que dice el servidor, para que una toma a medio subir no se vea
   * "Pendiente" (e invite a repetirla).
   */
  const [cola, setCola] = useState<Map<string, ResumenCara & { enviando: boolean }>>(() => new Map());
  /**
   * Caras que la cola registró en esta pestaña → cuándo (ms del teléfono),
   * hasta que una carga de la lista que empezó después las traiga.
   */
  const [regSesion, setRegSesion] = useState<Map<string, number>>(() => new Map());
  /**
   * Cuándo EMPEZÓ la última carga de la lista que se aplicó (ms del
   * teléfono): lo registrado o ligado antes de ese momento ya viene en `filas`.
   */
  const [cargadaDesde, setCargadaDesde] = useState(0);
  /**
   * Cuándo LLEGÓ esa carga: lo que la cola mandó después seguro no viene en
   * `filas` (lo de en medio puede venir o no; no se suma para no contar de más).
   */
  const [cargadaHasta, setCargadaHasta] = useState(0);
  const firmaColaRef = useRef('');
  useEffect(() => {
    if (!email) return;
    let vivo = true;
    let t: number | undefined;
    const leer = async () => {
      try {
        const m = await resumenTomas(email);
        const reg = new Map(
          tomasRegistradasEnSesion(email).map((r) => [llaveCara(r.anio, r.catorcena, r.vfid), r.en] as const)
        );
        if (!vivo) return;
        // Regla anti-congelamiento (24-sep-2026): sin cambios, no se re-renderiza.
        const firma = JSON.stringify([[...m.entries()], [...reg]]);
        if (firma === firmaColaRef.current) return;
        firmaColaRef.current = firma;
        setCola(m);
        setRegSesion(reg);
      } catch {
        /* sin cola: la lista sigue con lo del servidor */
      }
    };
    void leer();
    const quitar = suscribirTomas(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => void leer(), 300);
    });
    return () => {
      vivo = false;
      quitar();
      window.clearTimeout(t);
    };
  }, [email]);
  // Una carga que empezó DESPUÉS del registro ya trae la cara como quedó en el
  // servidor, venga con fecha_toma o regresada: la marca de sesión se suelta.
  // Antes se esperaba la fecha_toma y, si el analista la regresaba antes de
  // esa carga, la fila decía «Tomada · actualizando…» para siempre
  // (verificación, 22-oct-2026).
  useEffect(() => {
    if (!email || !regSesion.size || !cargadaDesde) return;
    const ya = [...regSesion.entries()].filter(([, en]) => en < cargadaDesde).map(([k]) => k);
    if (!ya.length) return;
    ya.forEach((k) => {
      // llaveCara = año-catorcena-cara (la cara puede traer guiones).
      const [anio, catorcena, ...cara] = k.split('-');
      olvidarRegistrada(email, Number(anio), Number(catorcena), cara.join('-'));
    });
    setRegSesion((prev) => {
      const s = new Map(prev);
      ya.forEach((k) => s.delete(k));
      return s;
    });
  }, [email, filas, regSesion, cargadaDesde]);
  /** Sitio con NuevaInc abierto (el modal nace con este sitio ligado). */
  const [nuevaEn, setNuevaEn] = useState<string | null>(null);

  /**
   * Incidencias ABIERTAS por sitio (misma fuente que el distintivo de
   * Biobox: la RPC security definer, que ve todas las áreas). Aquí el
   * monitorista NO repara — es pura visualización: saber que el sitio
   * donde está parado ya tiene algo reportado.
   */
  const [abiertas, setAbiertas] = useState<MapaResumen>({});

  /**
   * Detalle de las abiertas de UN sitio (modal). Lo mínimo para que el
   * monitorista decida si su reporte ya existe: nombre, área y estatus —
   * nada más, para no mezclarlo con el trabajo de reparación.
   */
  const [verIncDe, setVerIncDe] = useState<string | null>(null);
  const [incsDelSitio, setIncsDelSitio] = useState<IncidenciaAbierta[] | null>(
    null
  );
  const abrirIncidenciasDe = async (siteId: string) => {
    setVerIncDe(siteId);
    setIncsDelSitio(null); // muestra "cargando" mientras llega
    const { filas } = await detalleMaquina(siteId);
    setIncsDelSitio(filas);
  };
  const cargarAbiertas = useCallback(async (siteIds: string[]) => {
    if (!siteIds.length) return;
    const m = await resumenMaquinas(siteIds);
    // merge y no replace: las recargas parciales (tras crear un reporte)
    // no deben borrar los distintivos del resto de la ruta.
    setAbiertas((prev) => ({ ...prev, ...m }));
  }, []);
  /**
   * En modo 'analista' (Tomas de Pauta) no se pinta la Lista: ni sus
   * distintivos de incidencias, ni las asignaciones de ruta, ni las rutas de
   * Impreso. Sin esto, cada revisión (recarga silenciosa) volvía a pedir
   * resumenMaquinas de los ~600 sitios (revisión 3, 23-oct-2026).
   */
  const conLista = modo === 'completo';
  useEffect(() => {
    if (!conLista) return;
    const ids = [...new Set(filas.map((f) => f.site_id))];
    setAbiertas({});
    cargarAbiertas(ids);
  }, [filas, cargarAbiertas, conLista]);

  // Filtros
  const [fRuta, setFRuta] = useState('Todas');
  const [fCampanas, setFCampanas] = useState<string[]>([]);
  const [fAvance, setFAvance] = useState('Todos');
  const [q, setQ] = useState('');

  // --- Asignación de rutas (coordinador → monitorista) ---
  /** Todas las asignaciones vigentes: ruta_id → correos. */
  const [asignaciones, setAsignaciones] = useState<
    { id: number; ruta_id: number; usuario_email: string }[]
  >([]);
  /** Personas asignables (RPC, solo la ve coordinador/manager). */
  const [asignables, setAsignables] = useState<
    { email: string; nombre: string }[]
  >([]);
  const [asignando, setAsignando] = useState(false);

  /** Para Indicadores: el monitorista no ve "sin rutas" mientras cargan. */
  const [estadoAsig, setEstadoAsig] = useState<'cargando' | 'listas' | string>('cargando');
  const cargarAsignaciones = useCallback(async () => {
    const { data, error } = await sb
      .from('ruta_asignaciones')
      .select('id,ruta_id,usuario_email');
    if (error) {
      // Se conserva lo que había; la pestaña Indicadores dice por qué.
      setEstadoAsig((prev) => (prev === 'listas' ? prev : error.message));
      return;
    }
    setEstadoAsig('listas');
    setAsignaciones(
      (data as { id: number; ruta_id: number; usuario_email: string }[]) || []
    );
  }, []);

  useEffect(() => {
    if (conLista) cargarAsignaciones();
  }, [cargarAsignaciones, conLista]);

  /**
   * Ids de las rutas de monitoreo de Ecovallas IMPRESO (19-oct-2026). La
   * vista une la ruta por sitio sin mirar su unidad ni su medio: un sitio
   * mixto que vive en una ruta de Digital (p. ej. "Pantallas") hacía que
   * al elegir EDOMEX y asignar se asignara esa ruta de Digital. Pauta solo
   * asigna y cuenta rutas de Impreso. null = no se pudo leer (no se filtra).
   */
  const [rutasImpreso, setRutasImpreso] = useState<Set<number> | null>(null);
  useEffect(() => {
    if (!conLista) return;
    let vivo = true;
    sb.from('rutas_monitoreo')
      .select('id')
      .eq('unidad_negocio', 'Ecovallas')
      .eq('tipo_medio', 'Impreso')
      .then(({ data, error }) => {
        if (!vivo || error) return;
        setRutasImpreso(new Set(((data as { id: number }[]) || []).map((r) => r.id)));
      });
    return () => {
      vivo = false;
    };
  }, [conLista]);
  const esRutaImpreso = useCallback(
    (id: number | null | undefined) => id != null && (!rutasImpreso || rutasImpreso.has(id)),
    [rutasImpreso]
  );

  /**
   * ruta_clave → ruta_monitoreo_id (para asignar) según la catorcena: la
   * ruta de Impreso que más sitios de esa clave tiene. Una clave sin ruta
   * de Impreso no se puede asignar. EDOMEX y PLAZA tienen la suya desde
   * que "Sincronizar rutas" las crea (Rutas 901 y 902, 19-oct-2026).
   */
  const rutaIdDeClave = useMemo(() => {
    const votos = new Map<string, Map<number, number>>();
    filas.forEach((f) => {
      if (!f.ruta_clave || !esRutaImpreso(f.ruta_monitoreo_id)) return;
      const v = votos.get(f.ruta_clave) || new Map<number, number>();
      v.set(f.ruta_monitoreo_id!, (v.get(f.ruta_monitoreo_id!) || 0) + 1);
      votos.set(f.ruta_clave, v);
    });
    const m = new Map<string, number>();
    votos.forEach((v, clave) => m.set(clave, [...v.entries()].sort((a, b) => b[1] - a[1])[0][0]));
    return m;
  }, [filas, esRutaImpreso]);

  /** Ruta elegida en el filtro, si se puede asignar (número: dependencia
   *  estable para el efecto de abajo). */
  const rutaAsignarId =
    puedeImportar && fRuta !== 'Todas' ? rutaIdDeClave.get(fRuta) ?? null : null;

  // «＋ Asignar a…» ofrece SOLO a los monitoristas que tienen la unidad de
  // la ruta (Erik, rutas, 5-oct-2026): usuarios_asignables_ruta, lo mismo
  // que acepta el trigger de ruta_asignaciones. Antes salían todos los
  // monitoristas y el elegido sin Ecovallas terminaba en un alert. Si la
  // base aún no tiene la función (migración sin correr), la lista de antes.
  useEffect(() => {
    if (rutaAsignarId == null) return;
    let activo = true;
    (async () => {
      let r = await sb
        .rpc('usuarios_asignables_ruta', { p_ruta_id: rutaAsignarId })
        .abortSignal(tope(15000));
      if (!activo) return;
      if (
        r.error &&
        (r.error.code === 'PGRST202' ||
          r.error.code === '42883' ||
          /could not find the function/i.test(r.error.message || ''))
      ) {
        r = await sb.rpc('usuarios_asignables').abortSignal(tope(15000));
        if (!activo) return;
      }
      if (r.error) return; // se queda la lista que había
      setAsignables((r.data as { email: string; nombre: string }[] | null) || []);
    })();
    return () => {
      activo = false;
    };
  }, [rutaAsignarId]);

  /** Claves de ruta asignadas a MÍ, presentes en esta catorcena. */
  const misRutas = useMemo(() => {
    const misIds = new Set(
      asignaciones
        .filter((a) => a.usuario_email.toLowerCase() === email.toLowerCase())
        .map((a) => a.ruta_id)
    );
    const claves = new Set<string>();
    rutaIdDeClave.forEach((id, clave) => {
      if (misIds.has(id)) claves.add(clave);
    });
    return claves;
  }, [asignaciones, rutaIdDeClave, email]);

  /**
   * Lo que ve el monitorista: SOLO sus rutas asignadas, en la Lista y en
   * Indicadores (Erik, 14 y 19-oct-2026). Coordinador, manager y analista
   * ven todo. Es filtro de pantalla: la RLS de pautas deja leer todo con sesión.
   */
  const filasMias = useMemo(
    () => (veTodo ? filas : filas.filter((f) => !!f.ruta_clave && misRutas.has(f.ruta_clave))),
    [veTodo, filas, misRutas]
  );

  /**
   * Al abrir Pauta, la ruta asignada se pre-filtra SOLA — una vez. Si el
   * usuario cambia el filtro después, se respeta: esto es un arranque
   * cómodo, no una jaula.
   */
  const [prefiltrada, setPrefiltrada] = useState(false);
  useEffect(() => {
    if (prefiltrada || !filas.length || !asignaciones.length) return;
    const primera = [...misRutas][0];
    // Es el mismo cambio grande de alto que elegir una ruta (toda la
    // catorcena → una ruta): con la página arriba (lib/subirAntes.ts). Sin
    // clave y con updater, para no pisar una ruta elegida a mano mientras.
    if (primera && fRuta === 'Todas')
      subirYLuego(() => setFRuta((prev) => (prev === 'Todas' ? primera : prev)));
    setPrefiltrada(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [misRutas, filas, asignaciones]);

  /**
   * Las rutas del archivo de pauta pueblan el módulo de Rutas: la RPC
   * arma las filas de esta catorcena y las pasa por importar_rutas (el
   * pipeline del Excel de rutas de siempre). Sin esto, un sitio cuya ruta
   * no existe en rutas_monitoreo no se puede asignar a un monitorista.
   */
  const [sincronizando, setSincronizando] = useState(false);
  const sincronizarRutas = async () => {
    if (catSel == null || !catSelLeida) return;
    if (
      !confirm(
        `Se crearán/actualizarán las rutas de monitoreo con los sitios y ` +
          `secuencias de la ${etiquetaCatorcena(catSelLeida.numero, catSelLeida.anio)}, ` +
          `incluidas EDOMEX y PLAZA. ¿Continuar?`
      )
    )
      return;
    setSincronizando(true);
    const { data, error } = await sb.rpc('sincronizar_rutas_desde_pauta', {
      p_catorcena: catSelLeida.numero,
      p_anio: catSelLeida.anio,
    });
    setSincronizando(false);
    if (error) {
      alert('No se pudo sincronizar: ' + error.message);
      return;
    }
    const r = data as {
      rutas_creadas: number;
      ubicaciones_procesadas: number;
      omitidas: number;
      sitios_en_pauta: number;
      foraneos_omitidos: number;
    };
    alert(
      `Rutas sincronizadas: ${r.ubicaciones_procesadas} ubicaciones ` +
        `procesadas, ${r.rutas_creadas} rutas creadas` +
        (r.omitidas > 0
          ? `, ${r.omitidas} omitidas (no están en inventario de Ecovallas/Impreso)`
          : '') +
        (r.foraneos_omitidos > 0
          ? `, ${r.foraneos_omitidos} sitios sin ruta reconocible fuera`
          : '') +
        '.'
    );
    // Recargar: ahora los sitios traen su ruta_monitoreo_id y ya se puede
    // asignar la ruta a un monitorista.
    cargar(catSel);
  };

  const asignarRuta = async (rutaId: number, correo: string) => {
    if (!correo) return;
    setAsignando(true);
    const { error } = await sb.from('ruta_asignaciones').insert({
      ruta_id: rutaId,
      usuario_email: correo.toLowerCase(),
      asignado_por: email,
    });
    setAsignando(false);
    if (error) {
      // 23505 = ya estaba asignada: no es un error para el coordinador.
      if (!error.message.toLowerCase().includes('duplicate'))
        alert('No se pudo asignar: ' + error.message);
      return;
    }
    cargarAsignaciones();
  };

  const quitarAsignacion = async (a: { id: number; usuario_email: string }) => {
    if (!confirm(`¿Quitar la ruta a ${a.usuario_email.split('@')[0]}?`)) return;
    const { error } = await sb
      .from('ruta_asignaciones')
      .delete()
      .eq('id', a.id);
    if (error) {
      alert('No se pudo quitar: ' + error.message);
      return;
    }
    cargarAsignaciones();
  };

  /**
   * Catorcenas disponibles. Se abre en la más reciente.
   *
   * Una consulta POR CATORCENA, cada una pidiendo solo la siguiente más
   * vieja (año, número) que la anterior (14-oct-2026). Antes se leía la
   * columna de TODAS las filas de pautas: Supabase corta en 1000 y una
   * catorcena trae ~1,200, así que una segunda catorcena podía no salir en
   * el selector. Así cada viaje trae una fila y usa el índice (anio,
   * catorcena).
   */
  const catsEnCurso = useRef(false);
  const cargarCatorcenas = useCallback(async () => {
    // Ya va una lectura: ↻ (o el doble efecto de StrictMode) no lanza otra
    // encima (revisión 3, 23-oct-2026).
    if (catsEnCurso.current) return;
    catsEnCurso.current = true;
    try {
      await leerCatorcenasPauta();
    } finally {
      catsEnCurso.current = false;
    }
  }, []);
  /**
   * El cuerpo de cargarCatorcenas: solo usa setState (estables).
   *
   * Un solo viaje con pauta_catorcenas_con_pauta() (24-oct-2026): distinct
   * (anio, catorcena) sobre el índice, security invoker. Si la base todavía
   * no tiene la función (la app se publica antes que la migración) se cae
   * al bucle de antes, una consulta por catorcena.
   */
  async function leerCatorcenasPauta() {
    const { data, error } = await sb.rpc('pauta_catorcenas_con_pauta');
    if (!error) {
      const cats = ((data as { anio: number; catorcena: number }[] | null) ?? []).map((r) => ({
        anio: Number(r.anio),
        numero: Number(r.catorcena),
      }));
      aplicarCatorcenas(cats);
      return;
    }
    await leerCatorcenasUnaPorUna();
  }
  function aplicarCatorcenas(cats: { anio: number; numero: number }[]) {
    setCatorcenas(cats);
    const primera = cats[0] ? claveCatorcena(cats[0].anio, cats[0].numero) : null;
    setCatSel((prev) => prev ?? primera);
    if (cats.length === 0) setLoading(false);
  }
  /** Respaldo: una consulta por catorcena (14-oct-2026), hasta 120. */
  async function leerCatorcenasUnaPorUna() {
    const cats: { anio: number; numero: number }[] = [];
    for (let i = 0; i < 120; i++) {
      const ult = cats[cats.length - 1];
      let q = sb
        .from('pautas')
        .select('anio,catorcena')
        .order('anio', { ascending: false })
        .order('catorcena', { ascending: false })
        .limit(1);
      if (ult)
        q = q.or(`anio.lt.${ult.anio},and(anio.eq.${ult.anio},catorcena.lt.${ult.numero})`);
      const { data, error } = await q;
      if (error) {
        setErr('catorcenas: ' + error.message);
        // Lo que ya llegó (la más reciente primero) sí sirve: una falla a
        // media lista no deja el selector vacío.
        if (cats.length === 0) {
          setLoading(false);
          return;
        }
        break;
      }
      const r = (data as { anio: number; catorcena: number }[] | null)?.[0];
      if (!r) break;
      cats.push({ anio: Number(r.anio), numero: Number(r.catorcena) });
    }
    aplicarCatorcenas(cats);
  }

  /** Número de carga: la respuesta de una carga superada se descarta. */
  const cargaSeq = useRef(0);
  /** Catorcena de las filas que están en pantalla. */
  const catEnPantalla = useRef<string | null>(null);
  /**
   * Datos de OTRA catorcena: la lista cambia mucho de alto y se aplica con
   * la página arriba (lib/subirAntes.ts: en iPhone, un cambio grande de alto
   * con la página desplazada dejaba el menú inferior a media pantalla,
   * 5-oct-2026). De la misma catorcena (recargas), de inmediato. Solo usa
   * refs y el helper, así que la copia que guarda `cargar` (useCallback sin
   * dependencias) siempre sirve.
   */
  const aplicarDeCatorcena = (cat: string, miCarga: number, fn: () => void) => {
    if (catEnPantalla.current === cat) fn();
    else
      subirYLuego(() => {
        if (miCarga === cargaSeq.current) fn();
      });
  };
  /** Cuenta los cambios locales de filas (tomas) para detectar respuestas viejas. */
  const cambiosLocales = useRef(0);
  const setFilasLocal: typeof setFilas = (v) => {
    cambiosLocales.current++;
    setFilas(v);
  };

  /**
   * `silenciosa` = recarga pedida desde afuera (aviso nuevo): NO pone la
   * pantalla en "Cargando…". Ese return temprano desmontaba el modal de la
   * toma con sus fotos en memoria cada vez que llegaba cualquier aviso
   * (mismo bug que Incidencias, auditoría 24-sep-2026). Y si falla la red,
   * se conserva lo que ya estaba en pantalla.
   */
  const cargar = useCallback(async (cat: string, silenciosa = false) => {
    const miCarga = ++cargaSeq.current;
    /** Lo de la cola anterior a este momento ya viene en esta lectura. */
    const inicio = Date.now();
    // `cat` es la llave "2026-16": la catorcena es número + año.
    const leida = leerClaveCatorcena(cat);
    if (!leida) return;
    const marca = cambiosLocales.current;
    if (!silenciosa) setLoading(true);
    setErr('');
    // Paginado: una catorcena pasa de 1000 filas y Supabase corta ahí.
    let todas: PautaRuta[] = [];
    let desde = 0;
    for (;;) {
      const { data, error } = await sb
        .from('vw_pauta_ruta')
        .select('*')
        .eq('anio', leida.anio)
        .eq('catorcena', leida.numero)
        .order('ruta_numero', { ascending: true, nullsFirst: false })
        .order('secuencia', { ascending: true })
        .range(desde, desde + PAGINA - 1);
      if (miCarga !== cargaSeq.current) return; // otra carga más nueva manda
      if (error) {
        setErr('pauta: ' + error.message);
        // Lo que quedó en pantalla es de OTRA catorcena: no se deja debajo
        // del selector nuevo como si fuera de ésta.
        aplicarDeCatorcena(cat, miCarga, () => {
          if (catEnPantalla.current !== cat) {
            setFilas([]);
            catEnPantalla.current = cat;
          }
          setLoading(false);
        });
        return;
      }
      const lote = (data as PautaRuta[]) || [];
      todas = todas.concat(lote);
      if (lote.length < PAGINA) break;
      desde += PAGINA;
      if (desde > 20000) break; // salvavidas
    }
    const llego = Date.now();
    // Recarga silenciosa y el monitorista registró/comprobó/regresó una toma
    // mientras viajaba: esta respuesta se tomó ANTES de su cambio y lo
    // "revertiría" en pantalla. Se descarta y se pide otra de inmediato,
    // que ya trae su cambio (y lo remoto que motivó la recarga).
    if (silenciosa && cambiosLocales.current !== marca) {
      // `cargar` es estable (useCallback sin dependencias): la referencia
      // dentro de su propio cuerpo apunta a la misma función.
      setTimeout(() => void cargar(cat, true), 0);
      return;
    }
    aplicarDeCatorcena(cat, miCarga, () => {
      setFilas(todas);
      catEnPantalla.current = cat;
      setCargadaDesde(inicio);
      setCargadaHasta(llego);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    cargarCatorcenas();
  }, [cargarCatorcenas]);

  useEffect(() => {
    if (catSel != null) cargar(catSel);
  }, [catSel, cargar]);

  // Recarga pedida desde afuera (notificación de pauta abierta).
  // Si la primera lectura de catorcenas falló (sin señal), ↻ la vuelve a
  // pedir: antes se quedaba en «no hay ninguna catorcena» hasta salir y
  // volver (revisión 3, 23-oct-2026). Al montar ya va la de arriba en curso
  // y cargarCatorcenas no lanza otra.
  useEffect(() => {
    if (!recargarSignal) return;
    if (catSel != null) {
      cargar(catSel, true);
      if (conLista) cargarAsignaciones();
    } else reintentarCatorcenas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recargarSignal]);
  const reintentarCatorcenas = () => {
    if (catsEnCurso.current) return;
    setErr('');
    void cargarCatorcenas();
  };

  // --- Catálogos derivados de los datos ---
  const rutas = useMemo(() => {
    const s = new Set(filasMias.map((f) => f.ruta_clave).filter(Boolean) as string[]);
    // Numéricas primero y en orden; las foráneas (PLAZA, EDOMEX) al final.
    return [...s].sort((a, b) => {
      const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
      if (na && nb) return Number(a) - Number(b);
      if (na) return -1;
      if (nb) return 1;
      return a.localeCompare(b);
    });
  }, [filasMias]);

  /**
   * Campañas de la ruta seleccionada, con su conteo de caras ÚNICAS: la
   * vista trae un renglón por versión de la pauta (20-oct-2026).
   */
  const campanasRuta = useMemo(() => {
    const base =
      fRuta === 'Todas' ? filasMias : filasMias.filter((f) => f.ruta_clave === fRuta);
    const m = new Map<string, Set<string>>();
    base.forEach((f) => {
      if (!f.campana) return;
      let s = m.get(f.campana);
      if (!s) m.set(f.campana, (s = new Set()));
      s.add(f.vendor_face_id);
    });
    return [...m.entries()]
      .map(([c, s]) => [c, s.size] as [string, number])
      .sort((a, b) => b[1] - a[1]);
  }, [filasMias, fRuta]);

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
  // En dos pasos a propósito: `base` aplica todo MENOS el avance, y las
  // tarjetas (Pendientes/Tomadas/Comprobadas) cuentan sobre `base` — así
  // al filtrar por Pendientes, la tarjeta de Comprobadas no se pone en
  // cero y sigue siendo un botón con sentido.
  const base = useMemo(
    () =>
      filasMias.filter((f) => {
        if (fRuta !== 'Todas' && f.ruta_clave !== fRuta) return false;
        if (fCampanas.length && !fCampanas.includes(f.campana || ''))
          return false;
        if (q) {
          const s =
            `${f.site_id} ${f.vendor_face_id} ${f.direccion} ${f.campana} ${f.version}`.toLowerCase();
          if (!s.includes(q.toLowerCase())) return false;
        }
        return true;
      }),
    [filasMias, fRuta, fCampanas, q]
  );
  /** Filtro de la tarjeta Incidencias: solo sitios con abiertas. */
  const [fConInc, setFConInc] = useState(false);
  const visibles = useMemo(() => {
    let v = fAvance === 'Todos' ? base : base.filter((f) => f.avance === fAvance);
    if (fConInc)
      v = v.filter((f) => (abiertas[f.site_id]?.abiertas ?? 0) > 0);
    return v;
  }, [base, fAvance, fConInc, abiertas]);

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

  // Conteos sobre `base` (sin los filtros de tarjeta): son las CIFRAS de
  // las tarjetas-botón. sinCoord sí es de lo visible, que es lo navegable.
  // Se cuentan caras ÚNICAS, igual que Indicadores (Erik, 20-oct-2026): una
  // cara con dos versiones de la pauta viene en dos renglones, pero la
  // toma es una sola.
  const stats = useMemo(() => {
    const t = {
      total: 0,
      pend: 0,
      tom: 0,
      comp: 0,
      sinCoord: 0,
      inc: 0,
    };
    const sitiosVistos = new Set<string>();
    const carasVistas = new Set<string>();
    base.forEach((f) => {
      if (!carasVistas.has(f.vendor_face_id)) {
        carasVistas.add(f.vendor_face_id);
        t.total++;
        if (f.avance === 'PENDIENTE') t.pend++;
        else if (f.avance === 'TOMADA') t.tom++;
        else t.comp++;
      }
      // Incidencias abiertas: se suman UNA vez por sitio, no por cara.
      if (!sitiosVistos.has(f.site_id)) {
        sitiosVistos.add(f.site_id);
        t.inc += abiertas[f.site_id]?.abiertas ?? 0;
      }
    });
    const sinCoordVistas = new Set<string>();
    visibles.forEach((f) => {
      if (!f.navegable) sinCoordVistas.add(f.vendor_face_id);
    });
    t.sinCoord = sinCoordVistas.size;
    return t;
  }, [base, visibles, abiertas]);

  // La lista dibuja de 100 en 100 sitios: con "Ruta: Todas" son ~600 sitios
  // y en iPhone dibujarlos de golpe se siente (20-oct-2026). Los datos y las
  // cifras siguen siendo de toda la catorcena; solo se pagina lo que se pinta.
  const [limiteSitios, setLimiteSitios] = useState(SITIOS_POR_PAGINA);
  useEffect(() => {
    setLimiteSitios(SITIOS_POR_PAGINA);
  }, [catSel, fRuta, fCampanas, q, fAvance, fConInc]);

  /** Tarjeta-botón: toca para filtrar por ese avance; tocar de nuevo, quita. */
  const toggleAvance = (v: string) =>
    setFAvance((prev) => (prev === v ? 'Todos' : v));

  // --- Acciones de campo ---
  /** Lo que la cola del teléfono tiene de esta cara (o undefined). */
  const colaDe = (f: PautaRuta) => cola.get(llaveCara(f.anio, f.catorcena, f.vendor_face_id));
  /** Se pidió registrar y espera a que suban las fotos (y la base aún no la tiene). */
  const enColaRegistro = (f: PautaRuta) => !f.fecha_toma && !!colaDe(f)?.registrarPedido;
  /** La cola ya la registró en esta pestaña, pero la lista aún no se recarga. */
  const registradaEnSesion = (f: PautaRuta) =>
    !f.fecha_toma && regSesion.has(llaveCara(f.anio, f.catorcena, f.vendor_face_id));
  /**
   * Fotos de la cara: las de la lista, más las que la cola mandó después de
   * que llegó su última carga (ésas seguro no vienen en f.fotos), más las que
   * siguen en el teléfono. Las de en medio no se suman: puede faltar una un
   * momento, nunca sobrar; la recarga diferida (al entrar una foto) lo corrige.
   */
  const fotosConCola = (f: PautaRuta) => {
    const c = colaDe(f);
    if (!c) return f.fotos;
    const nuevas = c.ligadasEn.filter((en) => Date.parse(en) >= cargadaHasta).length;
    return f.fotos + nuevas + c.porSubir;
  };

  /**
   * La toma quedó registrada en el modal. Se refleja en memoria para que el
   * avance se vea al instante, sin recargar toda la catorcena. Si quedó en la
   * cola (fotos por subir), no se pinta "Tomada": la marca de la cola ya lo
   * dice, y la base todavía no la tiene.
   */
  const tomaRegistrada = (vendorFaceId: string, info: InfoRegistro) => {
    const ahora = new Date().toISOString();
    if (!info.enCola)
      setFilasLocal((prev) =>
        prev.map((f) => {
          if (f.vendor_face_id !== vendorFaceId) return f;
          // La RPC no pisa una toma anterior: aquí se respeta igual.
          return {
            ...f,
            fecha_toma: f.fecha_toma || ahora,
            toma_por: f.toma_por || email,
            // Las fotos reales de la toma (antes sumaba 1 sin importar cuántas).
            fotos: Math.max(f.fotos, info.fotos),
            avance: f.fecha_comprobacion ? 'COMPROBADA' : 'TOMADA',
          };
        })
      );
    setOfrecerEnCola(info.enCola);
    // Con la toma cerrada, se ofrece levantar incidencia del sitio: el
    // monitorista ya está parado frente a la valla y acaba de fotografiarla
    // — es EL momento de reportar lo que vio mal.
    const fila = filas.find((f) => f.vendor_face_id === vendorFaceId);
    if (fila) setOfrecerIncEn(fila.site_id);
  };

  /**
   * Guardado del reporte levantado desde Pauta. La lógica completa (regla
   * de duplicidad, evidencia por grupo) vive en lib/crearReporte —la misma
   * de Incidencias—; aquí solo se cierra el modal y se refresca el
   * distintivo de abiertas del sitio.
   */
  const guardarReporte = async (grupos: GrupoReporte[]) => {
    const creadas = await crearReporte(grupos, { email, misDep });
    if (!creadas) return; // duplicado o error: el modal se queda abierto.
    const sitio = nuevaEn;
    setNuevaEn(null);
    if (sitio) cargarAbiertas([sitio]);
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
  if (loading && !yaCargo)
    return (
      <div className="loading" role="status">
        Cargando pauta…
      </div>
    );

  if (catorcenas.length === 0 && modo === 'analista')
    return err ? (
      // Falló la lectura (sin señal): no es que no haya catorcenas.
      <div className="err" role="alert">
        No se pudo leer la Pauta ({err}).{' '}
        <button type="button" className="btn ghost sm" onClick={reintentarCatorcenas}>
          Reintentar
        </button>
      </div>
    ) : (
      <div className="empty">Todavía no hay ninguna catorcena de Pauta cargada.</div>
    );
  if (catorcenas.length === 0)
    return (
      <>
        <h2 className="page">Pauta y monitoreo</h2>
        <p className="phint">Campañas por ruta y avance de campo.</p>
        {err && (
          <div className="err" role="alert">
            {err}
          </div>
        )}
        <div className="empty">
          Todavía no hay ninguna catorcena cargada.
          {puedeImportar ? (
            <div style={{ marginTop: 14 }}>
              <button className="btn" onClick={() => setImportar(true)}>
                <Ic i={Download} />Importar pauta
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

  /** Pestañas Lista / Indicadores, iguales a los segmentos de Rutas. */
  const pestanas = (
    <div className="toolbar">
      <div className="rt-chips rt-segmento" role="group" aria-label="Vista">
        {(['lista', 'indicadores'] as const).map((v) => (
          <button
            key={v}
            type="button"
            className={'rt-chip' + (vista === v ? ' on' : '')}
            aria-pressed={vista === v}
            onClick={() => v !== vista && subirYLuego(() => setVista(v), 'pauta-vista')}
          >
            {v === 'lista' ? 'Lista' : 'Indicadores'}
          </button>
        ))}
      </div>
    </div>
  );

  const selectorCatorcena = (
    <select
      aria-label="Catorcena"
      value={catSel ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        subirYLuego(() => setCatSel(v), 'pauta-catorcena');
      }}
    >
      {catorcenas.map((c) => {
        const clave = claveCatorcena(c.anio, c.numero);
        return (
          <option key={clave} value={clave}>
            {etiquetaCatorcena(c.numero, c.anio)}
          </option>
        );
      })}
    </select>
  );

  // La revisión de tomas se mudó a Comprobaciones (Erik, 23-oct-2026): a
  // quien la ve ahí se le dice, por si llega aquí siguiendo el texto viejo
  // del aviso («pestaña Analista»; revisión 3, 23-oct-2026).
  const avisoTomas = onIrATomas ? (
    <p className="phint">
      Revisar las tomas de los monitoristas ahora está en Comprobaciones › Tomas de Pauta.{' '}
      <button type="button" className="btn ghost sm" onClick={onIrATomas}>
        Ir a Tomas de Pauta
      </button>
    </p>
  ) : null;

  // Indicadores: la misma catorcena; el monitorista, solo sus rutas
  // (coordinador y manager ven todo, Erik 14-oct-2026).
  if (vista === 'indicadores')
    return (
      <>
        <h2 className="page">
          Pauta y monitoreo
          {recargando && (
            <span role="status" style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 10 }}>
              <span className="spinner" />
              Actualizando…
            </span>
          )}
        </h2>
        {pestanas}
        {avisoTomas}
        {err && (
          <div className="err" role="alert">
            {err}
          </div>
        )}
        <div className="toolbar filtros-pildora">{selectorCatorcena}</div>
        {catSelLeida && (
          <div className={recargando ? 'recargando' : undefined}>
            <IndicadoresPauta
              filas={filasMias}
              asignaciones={estadoAsig}
              anio={catSelLeida.anio}
              numero={catSelLeida.numero}
              etiquetaCat={etiquetaCatorcena(catSelLeida.numero, catSelLeida.anio)}
              soloMisRutas={!veTodo}
            />
          </div>
        )}
      </>
    );

  // Analista (22-oct-2026): las tomas registradas de la catorcena, por
  // campaña y versión, para revisarlas foto por foto. Su revisión es la
  // comprobación; un cambio recarga la catorcena en silencio. Desde el
  // 23-oct-2026 vive en Comprobaciones («Tomas de Pauta»), que pone su
  // propio título y pestañas.
  if (modo === 'analista' && vista === 'analista' && revisaAnalista)
    return (
      <>
        <p className="phint">
          {soloVer
            ? 'Tomas que registran los monitoristas. Solo ves: revisar, rechazar y comprobar lo hace el analista.'
            : 'Tomas que registran los monitoristas: revisa cada foto y la toma queda comprobada.'}
        </p>
        {err && (
          <div className="err" role="alert">
            {err}
          </div>
        )}
        <div className="toolbar filtros-pildora">{selectorCatorcena}</div>
        {catSelLeida && (
          <AnalistaPauta
            filas={filasMias}
            anio={catSelLeida.anio}
            numero={catSelLeida.numero}
            etiquetaCat={etiquetaCatorcena(catSelLeida.numero, catSelLeida.anio)}
            onCambio={() => catSel != null && cargar(catSel, true)}
            soloVer={soloVer}
          />
        )}
      </>
    );

  return (
    <>
      <h2 className="page">
        Pauta y monitoreo
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
        Qué campaña va en cada cara, cómo va el avance y cómo llegar.
      </p>
      {pestanas}
      {avisoTomas}
      {err && (
        <div className="err" role="alert">
          {err}
        </div>
      )}
      {/* Monitorista: solo sus rutas asignadas (Erik, 19-oct-2026). */}
      {!veTodo &&
        (estadoAsig === 'cargando' ? (
          <div className="phint" role="status">
            Leyendo tus rutas…
          </div>
        ) : estadoAsig !== 'listas' ? (
          <div className="err" role="alert">
            No se pudieron leer tus rutas asignadas: {estadoAsig}
          </div>
        ) : filasMias.length === 0 ? (
          <div className="empty">
            No tienes rutas asignadas en esta catorcena. Pide al coordinador que te asigne una.
          </div>
        ) : (
          <p className="phint" style={{ marginTop: 0 }}>
            Ves solo tus rutas asignadas.
          </p>
        ))}

      {/* Píldoras (rediseño, oct-2026): catorcena y ruta; la ruta se resalta
          cuando filtra. */}
      <div className="toolbar filtros-pildora">
        {/* Catorcena, ruta, campañas y tarjetas cambian mucho el alto de la
            lista: se sube la página antes (lib/subirAntes.ts, 5-oct-2026). */}
        {selectorCatorcena}
        <select
          aria-label="Ruta"
          className={fRuta !== 'Todas' ? 'on' : undefined}
          value={fRuta}
          onChange={(e) => {
            const v = e.target.value;
            subirYLuego(() => setFRuta(v), 'pauta-ruta');
          }}
        >
          <option value="Todas">Ruta: todas</option>
          {rutas.map((r) => (
            <option key={r} value={r}>
              {/* ⭐ = asignada a este usuario por el coordinador. */}
              {misRutas.has(r) ? '⭐ ' : ''}
              {/^\d+$/.test(r) ? `Ruta ${r}` : r}
            </option>
          ))}
        </select>
      </div>
      <div className="toolbar">
        {/* El filtro de avance ya no es un select: son las tarjetas de
            abajo, que ahora se tocan para filtrar. */}
        <input
          className="search"
          aria-label="Buscar sitio, cara o campaña"
          placeholder="Buscar sitio, cara, campaña…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {puedeImportar && (
          <button className="btn ghost sm" onClick={() => setImportar(true)}>
            <Ic i={Download} />Importar
          </button>
        )}
        {puedeImportar && (
          <button
            className="btn ghost sm"
            onClick={sincronizarRutas}
            disabled={sincronizando || catSel == null}
            aria-busy={sincronizando}
            title="Crea/actualiza las rutas de monitoreo con los sitios y secuencias de esta catorcena"
          >
            {sincronizando && <span className="spinner" />}
            <Ic i={MapIcon} />Sincronizar rutas
          </button>
        )}
      </div>

      {/* Campañas de la ruta: el filtro principal del monitorista. */}
      {campanasRuta.length > 0 && (
        <div className={recargando ? 'recargando' : undefined} style={{ marginBottom: 14 }}>
          <div id="pauta-campanas-tit" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
            Campañas en {fRuta === 'Todas' ? 'la catorcena' : `la ruta ${fRuta}`}{' '}
            ({campanasRuta.length}) — toca para filtrar
          </div>
          {/* El texto de arriba titula el grupo de chips (revisión de accesibilidad, 24-oct-2026). */}
          <div className="chips" role="group" aria-labelledby="pauta-campanas-tit">
            {/* "Toca para filtrar" es LA interacción de esta vista: son
                botones con altura táctil real, no pills de 24px que en un
                teléfono se fallaban con el dedo. */}
            {campanasRuta.map(([c, n]) => {
              const on = fCampanas.includes(c);
              return (
                <button
                  type="button"
                  key={c}
                  onClick={() => subirYRegresar(() => toggleCampana(c))}
                  className="pill"
                  aria-pressed={on}
                  style={{
                    cursor: 'pointer',
                    border: 'none',
                    font: 'inherit',
                    fontSize: 12,
                    fontWeight: 700,
                    padding: '8px 12px',
                    minHeight: 36,
                    // Apagado = el fondo de .tag, con su pareja clara (tema
                    // claro/oscuro, 24-sep-2026). Encendido: naranja con
                    // texto --sobre-acento, igual en los dos temas.
                    background: on ? 'var(--accent)' : 'var(--tag-fondo)',
                    color: on ? 'var(--sobre-acento)' : 'var(--muted)',
                    whiteSpace: 'normal',
                    textAlign: 'left',
                    /* Los nombres de campaña del Excel suelen ser UN token
                       (SEGUROS_MONTERREY_NYL_2026): sin esto no hay dónde
                       romper y el chip se sale de la pantalla. */
                    overflowWrap: 'anywhere',
                    wordBreak: 'break-word',
                    maxWidth: '100%',
                  }}
                >
                  {c} · {n}
                </button>
              );
            })}
            {fCampanas.length > 0 && (
              <button
                type="button"
                onClick={() => subirYRegresar(() => setFCampanas([]))}
                className="pill"
                aria-label="Limpiar filtro de campañas"
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

      {/* Tarjetas DINÁMICAS: cada una es un botón que filtra la lista —
          tocar Pendientes enseña solo lo pendiente; tocarla otra vez lo
          quita. Sitios y Caras limpian el filtro de avance. Los conteos de
          avance salen de `base` (sin ese filtro), para que las cifras no
          se pongan en cero al filtrar. */}
      <div className={'cards' + (recargando ? ' recargando' : '')}>
        {(
          [
            {
              l: 'Sitios',
              n: sitios.length,
              activa: false,
              // Sitios y Caras limpian TODOS los filtros de tarjeta.
              click: () => {
                setFAvance('Todos');
                setFConInc(false);
              },
            },
            {
              l: 'Caras',
              n: stats.total,
              activa: false,
              click: () => {
                setFAvance('Todos');
                setFConInc(false);
              },
            },
            // Pendientes en ámbar (atención: es lo que falta), como estaba.
            {
              l: 'Pendientes',
              n: stats.pend,
              c: 'var(--warn)',
              activa: fAvance === 'PENDIENTE',
              click: () => toggleAvance('PENDIENTE'),
            },
            {
              l: 'Tomadas',
              n: stats.tom,
              c: colorTono('azul'),
              activa: fAvance === 'TOMADA',
              click: () => toggleAvance('TOMADA'),
            },
            {
              l: 'Comprobadas',
              n: stats.comp,
              c: COLOR_AVANCE.COMPROBADA.color,
              activa: fAvance === 'COMPROBADA',
              click: () => toggleAvance('COMPROBADA'),
            },
            // Incidencias abiertas en los sitios de este filtro; tocarla
            // deja SOLO los sitios que tienen alguna. Combina con el
            // avance: "pendientes con incidencia" es una pregunta real.
            {
              l: 'Incidencias',
              n: stats.inc,
              c: colorTono('rojo'),
              activa: fConInc,
              click: () => setFConInc((v) => !v),
            },
          ] as {
            l: string;
            n: number;
            c?: string;
            activa: boolean;
            click: () => void;
          }[]
        ).map((t) => (
          <button
            type="button"
            key={t.l}
            className="card"
            onClick={() => {
              // Sitios/Caras sin filtro de tarjeta activo no cambian nada:
              // ni se mueve la página.
              if ((t.l === 'Sitios' || t.l === 'Caras') && fAvance === 'Todos' && !fConInc) return;
              subirYRegresar(t.click);
            }}
            // Sitios y Caras limpian el filtro, no se prenden ni apagan: sin
            // aria-pressed (revisión de accesibilidad, 24-oct-2026).
            aria-pressed={t.l === 'Sitios' || t.l === 'Caras' ? undefined : t.activa}
            style={{
              cursor: 'pointer',
              textAlign: 'left',
              font: 'inherit',
              width: '100%',
              color: 'var(--txt)',
              borderColor: t.activa ? 'var(--accent)' : 'var(--line)',
              // El tinte de "lo activo" (el del menú), con su pareja clara
              // (tema claro/oscuro, 24-sep-2026).
              background: t.activa ? 'var(--activo-fondo)' : 'var(--panel)',
            }}
          >
            <div className="n" style={{ color: t.c }}>
              {t.n}
            </div>
            <div className="l">
              {t.l}
              {t.activa ? <span aria-hidden="true">{' ✕'}</span> : ''}
            </div>
          </button>
        ))}
      </div>

      {/* Asignación de la ruta (solo coordinador/manager, con una ruta
          elegida): quién la recorre. Asignar dispara la notificación al
          usuario — el trigger de ruta_asignaciones.sql avisa a su campana
          y a su celular. */}
      {puedeImportar &&
        fRuta !== 'Todas' &&
        rutaIdDeClave.has(fRuta) &&
        (() => {
          const rutaId = rutaIdDeClave.get(fRuta)!;
          const deEsta = asignaciones.filter((a) => a.ruta_id === rutaId);
          const sinAsignar = asignables.filter(
            (u) => !deEsta.some((a) => a.usuario_email === u.email)
          );
          return (
            <div
              style={{
                background: 'var(--panel)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: '11px 13px',
                marginBottom: 14,
              }}
            >
              {/* h3 con el mismo look del div de antes (revisión de accesibilidad, 24-oct-2026). */}
              <h3 style={{ font: 'inherit', fontSize: 12, fontWeight: 700, margin: '0 0 8px' }}>
                <Ic i={User} />{/^\d+$/.test(fRuta) ? `Ruta ${fRuta}` : fRuta} asignada a
              </h3>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                {deEsta.length === 0 && (
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Nadie todavía.
                  </span>
                )}
                {deEsta.map((a) => (
                  <span
                    key={a.id}
                    className="pill"
                    style={{ background: fondoTono('azul'), color: colorTono('azul') }}
                  >
                    {a.usuario_email.split('@')[0]}
                    <button
                      type="button"
                      className="btn-icono"
                      onClick={() => quitarAsignacion(a)}
                      aria-label={`Quitar la ruta a ${a.usuario_email}`}
                      title="Quitar asignación"
                      style={{
                        minWidth: 32,
                        minHeight: 32,
                        margin: '-8px 0 -8px 2px',
                        fontSize: 13,
                        fontWeight: 800,
                        color: 'inherit',
                      }}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <select
                  value=""
                  aria-label={`Asignar la ruta ${fRuta} a`}
                  aria-busy={asignando}
                  disabled={asignando}
                  onChange={(e) => asignarRuta(rutaId, e.target.value)}
                  style={{ width: 'auto', minWidth: 170 }}
                >
                  <option value="">＋ Asignar a…</option>
                  {sinAsignar.map((u) => (
                    <option key={u.email} value={u.email}>
                      {u.nombre} ({u.email.split('@')[0]})
                    </option>
                  ))}
                </select>
                {asignando && (
                  <span role="status">
                    <span className="spinner" />
                    <span style={SOLO_LECTOR}>Asignando…</span>
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                Al asignar, le llega la notificación y su ruta se le abre sola
                al entrar a Pauta.
              </div>
            </div>
          );
        })()}

      {/* Navegación del recorrido filtrado, por tramos de 10 paradas.
          Nace plegada: es material de inducción para quien no se sabe la
          ruta, no del día a día. El toggle lo ve cualquiera (Erik,
          ago-2026): así el monitorista nuevo lo prende desde su propio
          celular sin depender del coordinador. */}
      {tramos.length > 0 && (
        <div className={recargando ? 'recargando' : undefined} style={{ marginBottom: 14 }}>
          <button
            type="button"
            className="btn ghost sm"
            onClick={toggleGuias}
            aria-expanded={verGuias}
          >
            <span aria-hidden="true">{verGuias ? '▾' : '▸'}</span> <Ic i={MapIcon} />Guías de ruta (Google Maps)
          </button>
          {verGuias && (
            <div
              style={{
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
                alignItems: 'center',
                marginTop: 8,
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
                  <Ic i={MapIcon} />
                  {tramos.length === 1
                    ? 'Abrir en Google Maps'
                    : `Paradas ${t.desde}–${t.hasta}`}
                </a>
              ))}
              {stats.sinCoord > 0 && (
                <span
                  className="pill"
                  style={{ background: fondoTono('ambar'), color: colorTono('ambar') }}
                  title="Sin coordenadas en inventario: no se puede navegar"
                >
                  <span aria-hidden="true">⚠</span> {stats.sinCoord} sin ubicación
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {sitios.length === 0 ? (
        <div className="empty">Sin resultados con estos filtros.</div>
      ) : (
        <div className={'inc-list agrupada' + (recargando ? ' recargando' : '')}>
          {sitios.slice(0, limiteSitios).map((s) => (
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
                  {/* h3 (el único nivel bajo el h2 de la página); .titulo le
                      da el mismo look de antes (revisión de accesibilidad, 24-oct-2026). */}
                  <h3 className="titulo">{s.site_id}</h3>
                  <div className="meta">{s.direccion || '(sin dirección)'}</div>
                  {/* Incidencias abiertas del sitio: aquí NO se reparan —
                      es para que el monitorista sepa si lo que va a
                      reportar YA existe. El tag es sobrio (solo el conteo,
                      sin áreas: mezclaba cosas) y al tocarlo abre el
                      detalle mínimo. */}
                  {(() => {
                    const e = abiertas[s.site_id];
                    if (!e || !e.abiertas) return null;
                    const alarma =
                      e.hay_critica || (e.horas_peor ?? 0) > HORAS_ALARMA;
                    return (
                      <div style={{ marginTop: 6 }}>
                        <button
                          type="button"
                          onClick={() => abrirIncidenciasDe(s.site_id)}
                          className="tag"
                          aria-haspopup="dialog"
                          style={{
                            cursor: 'pointer',
                            font: 'inherit',
                            fontSize: 11,
                            minHeight: 32,
                            color: alarma ? colorTono('rojo') : NARANJA,
                            borderColor: alarma ? colorTono('rojo') : NARANJA,
                            border: '1px solid',
                            background: 'transparent',
                            fontWeight: alarma ? 700 : 400,
                          }}
                        >
                          <span aria-hidden="true">{alarma ? '🔴' : '⚠'}</span> {e.abiertas} incidencia
                          {e.abiertas === 1 ? '' : 's'} abierta
                          {e.abiertas === 1 ? '' : 's'} <span aria-hidden="true">›</span>
                        </button>
                      </div>
                    );
                  })()}
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
                  <span aria-hidden="true">⚠</span> Sin coordenadas en inventario — guíate por la dirección.
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
                              background: fondoTono(
                                f.estatus === 'NUEVO' ? 'azul' : 'gris'
                              ),
                              color:
                                f.estatus === 'NUEVO' ? colorTono('azul') : 'var(--muted)',
                            }}
                          >
                            {f.estatus}
                          </span>
                        )}
                        {/* La cola del teléfono va encima de lo del servidor:
                            "Por subir" en gris (el ámbar ya es "Tomada"). */}
                        {enColaRegistro(f) ? (
                          <span
                            className="pill"
                            style={{ color: 'var(--muted)', background: fondoTono('gris') }}
                          >
                            <Ic i={CloudUpload} />
                            {/* Con error no está "registrando": espera al monitorista. */}
                            {colaDe(f)?.conError
                              ? 'Sin registrar'
                              : (colaDe(f)?.porSubir ?? 0) > 0
                                ? `Por subir · ${colaDe(f)?.porSubir}`
                                : 'Registrando…'}
                          </span>
                        ) : registradaEnSesion(f) ? (
                          <span className="pill" style={{ ...COLOR_AVANCE.TOMADA }}>
                            Tomada · actualizando…
                          </span>
                        ) : (
                          <span
                            className="pill"
                            style={{ ...COLOR_AVANCE[f.avance] }}
                          >
                            {f.avance === 'PENDIENTE'
                              ? 'Pendiente'
                              : f.avance === 'TOMADA'
                                ? `Tomada ${fmt(f.fecha_toma)}`
                                : `Comprobada ${fmt(f.fecha_comprobacion)}`}
                          </span>
                        )}
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
                          modal con cámara y galería, no guarda a ciegas.
                          Comprobar ya no vive aquí ni en el modal: desde el
                          22-oct-2026 lo hace el analista al revisar las
                          fotos (Comprobaciones › Tomas de Pauta). */}
                      {/* El analista es solo de revisión (Erik, 24-oct-2026):
                          no registra ni termina tomas; la evidencia la ve
                          en «Tomas de Pauta». Solo se le deja ver la que ya
                          existe. */}
                      {(!soloRevisa || f.fecha_toma || colaDe(f) || registradaEnSesion(f)) &&
                        (() => {
                          const texto = colaDe(f)
                            ? `Ver toma (${fotosConCola(f)})`
                            : f.fecha_toma || registradaEnSesion(f)
                              ? `Evidencia${f.fotos ? ` (${f.fotos})` : ''}`
                              : f.fotos > 0
                                ? `Terminar toma (${f.fotos})`
                                : 'Registrar toma';
                          return (
                            <button
                              type="button"
                              className={f.fecha_toma || colaDe(f) || registradaEnSesion(f) ? 'btn ghost sm' : 'btn sm'}
                              onClick={() => setTomaDe(f)}
                              // El mismo texto se repite en cada cara: el nombre
                              // lleva el sitio y la cara (revisión de
                              // accesibilidad, 24-oct-2026).
                              aria-label={`${texto} · ${s.site_id} cara ${f.cara || '—'}`}
                              aria-haspopup="dialog"
                            >
                              <Ic i={Camera} />
                              {texto}
                            </button>
                          );
                        })()}
                      {f.fecha_comprobacion && f.comprobacion_por && (
                        <span
                          style={{ fontSize: 11, color: 'var(--muted)' }}
                        >
                          Comprobó {f.comprobacion_por.split('@')[0]}
                        </span>
                      )}
                      {/* La cola no pudo con esta toma: se dice aquí, en rojo. */}
                      {colaDe(f)?.conError && (
                        <span style={{ fontSize: 11, color: colorTono('rojo'), flexBasis: '100%' }}>
                          {/* "Fotos sin subir" solo si de verdad queda alguna
                              y no se pidió el registro; si no, es el registro. */}
                          {(colaDe(f)?.porSubir ?? 0) > 0 && !colaDe(f)?.registrarPedido
                            ? 'Fotos sin subir'
                            : 'No se registró'}
                          :{' '}
                          {colaDe(f)?.ultimoError || 'abre la toma.'}
                        </span>
                      )}
                      {/* Fotos extra (o sin registro pedido) que siguen en el teléfono. */}
                      {!colaDe(f)?.conError && !!colaDe(f) && !enColaRegistro(f) && (colaDe(f)?.porSubir ?? 0) > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--muted)', flexBasis: '100%' }}>
                          {colaDe(f)?.porSubir} por subir desde este teléfono
                        </span>
                      )}
                      {/* Fotos subidas pero la toma nunca se registró (se cerró
                          la ventana sin tocar Registrar): que no se pierda de vista. */}
                      {!colaDe(f) && !f.fecha_toma && !registradaEnSesion(f) && f.fotos > 0 && !f.rechazo_motivo && (
                        <span style={{ fontSize: 11, color: 'var(--muted)', flexBasis: '100%' }}>
                          {f.fotos} {f.fotos === 1 ? 'foto subida' : 'fotos subidas'} · falta registrar la toma
                        </span>
                      )}
                      {/* Toma regresada: el monitorista ve el motivo sin
                          abrir nada — es su pendiente más urgente. */}
                      {!f.fecha_toma && f.rechazo_motivo && (
                        <span
                          style={{
                            fontSize: 11,
                            color: colorTono('rojo'),
                            flexBasis: '100%',
                          }}
                        >
                          <span aria-hidden="true">⛔</span> Regresada: “{f.rechazo_motivo}”
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
      {sitios.length > limiteSitios && (
        <div style={{ textAlign: 'center', margin: '14px 0' }}>
          <button
            type="button"
            className="btn ghost"
            onClick={() => setLimiteSitios((n) => n + SITIOS_POR_PAGINA)}
          >
            Ver {Math.min(SITIOS_POR_PAGINA, sitios.length - limiteSitios)} sitios más
          </button>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }} role="status">
            Mostrando {limiteSitios} de {sitios.length} sitios
          </div>
        </div>
      )}

      {tomaDe && (
        <RegistrarTomaModal
          fila={tomaDe}
          email={email}
          soloLectura={soloRevisa}
          onClose={() => setTomaDe(null)}
          onRegistrada={tomaRegistrada}
        />
      )}

      {/* Detalle mínimo de las incidencias abiertas del sitio: nombre,
          área y estatus — lo justo para que el monitorista sepa si lo que
          iba a reportar ya existe. Sin folios ni botones de trabajo: eso
          es del módulo de Incidencias. */}
      {verIncDe && (
        <ModalIncidenciasSitio sitio={verIncDe} incidencias={incsDelSitio} onCerrar={() => setVerIncDe(null)} />
      )}

      {/* La pregunta sutil tras registrar la toma: un diálogo chico y
          centrado, no un confirm() del navegador. "No" no castiga: un tap
          en el fondo también lo cierra. */}
      {ofrecerIncEn && !nuevaEn && (
        <ModalOfrecerIncidencia
          sitio={ofrecerIncEn}
          enCola={ofrecerEnCola}
          onCerrar={() => setOfrecerIncEn(null)}
          onLevantar={() => {
            setNuevaEn(ofrecerIncEn);
            setOfrecerIncEn(null);
          }}
        />
      )}

      {/* NuevaInc con el sitio ligado: EL MISMO modal de Incidencias
          (catálogo, caras, evidencia, GPS) y el mismo guardado compartido
          (lib/crearReporte) — nada que aprender de nuevo ni gemelos que
          mantener. */}
      {nuevaEn && (
        <NuevaInc
          preset={{ un: UNIDAD_PAUTA, siteId: nuevaEn }}
          unidades={[UNIDAD_PAUTA]}
          onSave={guardarReporte}
          onClose={() => setNuevaEn(null)}
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

/**
 * Texto solo para el lector de pantalla (no hay clase en el CSS para esto):
 * se queda en el flujo pero sin verse (revisión de accesibilidad, 24-oct-2026).
 */
const SOLO_LECTOR: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};

/**
 * Detalle mínimo de las incidencias abiertas del sitio. Vivía como JSX
 * dentro de PautaView; es componente para poder darle foco, Tab y Escape
 * con useFocoModal (revisión de accesibilidad, 24-oct-2026).
 */
function ModalIncidenciasSitio({
  sitio,
  incidencias,
  onCerrar,
}: {
  sitio: string;
  /** null = todavía cargando. */
  incidencias: IncidenciaAbierta[] | null;
  onCerrar: () => void;
}) {
  const titRef = useRef<HTMLHeadingElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocoModal(modalRef, titRef, onCerrar);
  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onCerrar();
      }}
    >
      <div
        ref={modalRef}
        className="modal"
        style={{ maxWidth: 400, margin: 'auto 0' }}
        role="dialog"
        aria-modal="true"
        aria-label="Incidencias abiertas"
      >
        <CerrarModal onClick={onCerrar} />
        <h2 ref={titRef} tabIndex={-1} style={{ margin: '0 0 3px', fontSize: 17, outline: 'none' }}>
          Incidencias abiertas
        </h2>
        <p className="phint" style={{ marginBottom: 12 }}>
          {sitio} — si lo que viste ya está aquí, no lo reportes de
          nuevo.
        </p>
        {incidencias === null ? (
          <div className="loading" style={{ padding: 20 }} role="status">
            Cargando…
          </div>
        ) : incidencias.length === 0 ? (
          <div className="empty" style={{ padding: 20 }}>
            Nada abierto en este sitio.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {incidencias.map((i) => (
              <div
                key={i.record_id}
                style={{
                  background: 'var(--panel2)',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: '10px 12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 10,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    {i.nombre_incidencia || '(sin nombre)'}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      marginTop: 2,
                    }}
                  >
                    {i.area || 'Sin área'}
                  </div>
                </div>
                <span
                  className="pill"
                  style={{
                    background: fondoTono(EST_TONO[i.estatus] ?? 'gris'),
                    color: colorTono(EST_TONO[i.estatus] ?? 'gris'),
                  }}
                >
                  {EST_LABEL[i.estatus] || i.estatus}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions" style={{ marginTop: 14 }}>
          <button className="btn ghost" onClick={onCerrar} style={{ width: '100%' }}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * «¿Viste algo mal?» tras registrar la toma. Componente por lo mismo que
 * ModalIncidenciasSitio (revisión de accesibilidad, 24-oct-2026).
 */
function ModalOfrecerIncidencia({
  sitio,
  enCola,
  onCerrar,
  onLevantar,
}: {
  sitio: string;
  /** La toma quedó en la cola del teléfono, no registrada todavía. */
  enCola: boolean;
  onCerrar: () => void;
  onLevantar: () => void;
}) {
  const titRef = useRef<HTMLHeadingElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocoModal(modalRef, titRef, onCerrar);
  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onCerrar();
      }}
    >
      {/* El título cambia según el caso: la ventana se nombra con él. */}
      <div
        ref={modalRef}
        className="modal"
        style={{ maxWidth: 360, margin: 'auto 0' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pauta-ofrecer-inc-titulo"
      >
        <CerrarModal onClick={onCerrar} />
        <h2
          id="pauta-ofrecer-inc-titulo"
          ref={titRef}
          tabIndex={-1}
          style={{ margin: '0 0 3px', fontSize: 17, outline: 'none' }}
        >
          {enCola ? (
            'Toma guardada en el teléfono'
          ) : (
            <>
              <span aria-hidden="true">✓</span> Toma registrada
            </>
          )}
        </h2>
        <p className="phint" style={{ marginBottom: 14 }}>
          {enCola && <>Se registra sola en cuanto suban las fotos (con la app abierta). </>}
          ¿Viste algo mal en <b>{sitio}</b>? Puedes levantar la
          incidencia ahora mismo, con el sitio ya cargado.
        </p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCerrar}>
            No, todo bien
          </button>
          <button className="btn" onClick={onLevantar}>
            <Ic i={Plus} />Levantar incidencia
          </button>
        </div>
      </div>
    </div>
  );
}

export default PautaView;
