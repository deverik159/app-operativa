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
import RegistrarTomaModal from './RegistrarTomaModal';
import NuevaInc from '../incidencias/NuevaInc';
import type { GrupoReporte } from '../incidencias/NuevaInc';
import type { PautaRuta } from '../../types/db';
import { vigilarRender } from '../../lib/vigia';

/**
 * La pauta es de Ecovallas Impreso (decisión de sep-2026): los reportes
 * que nacen aquí se capturan en esa unidad, sin selector.
 */
const UNIDAD_PAUTA = 'Ecovallas';

/** Tope de filas: el límite duro de Supabase es 1000 por consulta. */
const PAGINA = 1000;

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
};

function PautaView({ puedeImportar, email, misDep, recargarSignal }: Props) {
  vigilarRender('PautaView');
  const [filas, setFilas] = useState<PautaRuta[]>([]);
  const [catorcenas, setCatorcenas] = useState<number[]>([]);
  const [catSel, setCatSel] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
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
  useEffect(() => {
    const ids = [...new Set(filas.map((f) => f.site_id))];
    setAbiertas({});
    cargarAbiertas(ids);
  }, [filas, cargarAbiertas]);

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

  const cargarAsignaciones = useCallback(async () => {
    const { data } = await sb
      .from('ruta_asignaciones')
      .select('id,ruta_id,usuario_email');
    setAsignaciones(
      (data as { id: number; ruta_id: number; usuario_email: string }[]) || []
    );
  }, []);

  useEffect(() => {
    cargarAsignaciones();
    if (puedeImportar) {
      sb.rpc('usuarios_asignables').then(({ data }) => {
        setAsignables((data as { email: string; nombre: string }[]) || []);
      });
    }
  }, [cargarAsignaciones, puedeImportar]);

  /** ruta_clave → ruta_monitoreo_id (para asignar) según la catorcena. */
  const rutaIdDeClave = useMemo(() => {
    const m = new Map<string, number>();
    filas.forEach((f) => {
      if (f.ruta_clave && f.ruta_monitoreo_id != null)
        m.set(f.ruta_clave, f.ruta_monitoreo_id);
    });
    return m;
  }, [filas]);

  /** Claves de ruta asignadas a MÍ, presentes en esta catorcena. */
  const misRutas = useMemo(() => {
    const misIds = new Set(
      asignaciones
        .filter((a) => a.usuario_email.toLowerCase() === email.toLowerCase())
        .map((a) => a.ruta_id)
    );
    const claves = new Set<string>();
    filas.forEach((f) => {
      if (f.ruta_clave && f.ruta_monitoreo_id != null && misIds.has(f.ruta_monitoreo_id))
        claves.add(f.ruta_clave);
    });
    return claves;
  }, [asignaciones, filas, email]);

  /**
   * Al abrir Pauta, la ruta asignada se pre-filtra SOLA — una vez. Si el
   * usuario cambia el filtro después, se respeta: esto es un arranque
   * cómodo, no una jaula.
   */
  const [prefiltrada, setPrefiltrada] = useState(false);
  useEffect(() => {
    if (prefiltrada || !filas.length || !asignaciones.length) return;
    const primera = [...misRutas][0];
    if (primera && fRuta === 'Todas') setFRuta(primera);
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
    if (catSel == null) return;
    if (
      !confirm(
        `Se crearán/actualizarán las rutas de monitoreo con los sitios y ` +
          `secuencias de la catorcena ${catSel} (las foráneas PLAZA/EDOMEX ` +
          `no aplican). ¿Continuar?`
      )
    )
      return;
    setSincronizando(true);
    const { data, error } = await sb.rpc('sincronizar_rutas_desde_pauta', {
      p_catorcena: catSel,
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
          ? `, ${r.foraneos_omitidos} sitios foráneos fuera (PLAZA/EDOMEX)`
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

  /** Número de carga: la respuesta de una carga superada se descarta. */
  const cargaSeq = useRef(0);
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
  const cargar = useCallback(async (cat: number, silenciosa = false) => {
    const miCarga = ++cargaSeq.current;
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
        .eq('catorcena', cat)
        .order('ruta_numero', { ascending: true, nullsFirst: false })
        .order('secuencia', { ascending: true })
        .range(desde, desde + PAGINA - 1);
      if (miCarga !== cargaSeq.current) return; // otra carga más nueva manda
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
    setFilas(todas);
    setLoading(false);
  }, []);

  useEffect(() => {
    cargarCatorcenas();
  }, [cargarCatorcenas]);

  useEffect(() => {
    if (catSel != null) cargar(catSel);
  }, [catSel, cargar]);

  // Recarga pedida desde afuera (notificación de pauta abierta).
  useEffect(() => {
    if (recargarSignal && catSel != null) {
      cargar(catSel, true);
      cargarAsignaciones();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recargarSignal]);

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
  // En dos pasos a propósito: `base` aplica todo MENOS el avance, y las
  // tarjetas (Pendientes/Tomadas/Comprobadas) cuentan sobre `base` — así
  // al filtrar por Pendientes, la tarjeta de Comprobadas no se pone en
  // cero y sigue siendo un botón con sentido.
  const base = useMemo(
    () =>
      filas.filter((f) => {
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
    [filas, fRuta, fCampanas, q]
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
  const stats = useMemo(() => {
    const t = {
      total: base.length,
      pend: 0,
      tom: 0,
      comp: 0,
      sinCoord: 0,
      inc: 0,
    };
    const sitiosVistos = new Set<string>();
    base.forEach((f) => {
      if (f.avance === 'PENDIENTE') t.pend++;
      else if (f.avance === 'TOMADA') t.tom++;
      else t.comp++;
      // Incidencias abiertas: se suman UNA vez por sitio, no por cara.
      if (!sitiosVistos.has(f.site_id)) {
        sitiosVistos.add(f.site_id);
        t.inc += abiertas[f.site_id]?.abiertas ?? 0;
      }
    });
    visibles.forEach((f) => {
      if (!f.navegable) t.sinCoord++;
    });
    return t;
  }, [base, visibles, abiertas]);

  /** Tarjeta-botón: toca para filtrar por ese avance; tocar de nuevo, quita. */
  const toggleAvance = (v: string) =>
    setFAvance((prev) => (prev === v ? 'Todos' : v));

  // --- Acciones de campo ---
  /**
   * Registra la comprobación (la VALIDACIÓN del coordinador — la RPC
   * exige coordinador/manager desde pauta_comprobacion_coordinador.sql).
   * Se dispara desde el visor de evidencia: comprobar sin ver las fotos
   * no debe ser posible. Devuelve si quedó, para que el modal cierre.
   */
  const comprobar = async (fila: PautaRuta): Promise<boolean> => {
    const { error } = await sb.rpc('registrar_comprobacion', {
      p_catorcena: fila.catorcena,
      p_vendor_face_id: fila.vendor_face_id,
    });
    if (error) {
      alert('No se pudo registrar: ' + error.message);
      return false;
    }
    const ahora = new Date().toISOString();
    setFilasLocal((prev) =>
      prev.map((f) =>
        f.vendor_face_id === fila.vendor_face_id
          ? { ...f, fecha_comprobacion: ahora, avance: 'COMPROBADA' }
          : f
      )
    );
    return true;
  };

  /**
   * El coordinador regresó la toma (la RPC ya notificó al monitorista):
   * la cara vuelve a PENDIENTE con su motivo visible.
   */
  const tomaRegresada = (vendorFaceId: string, motivo: string) => {
    setFilasLocal((prev) =>
      prev.map((f) =>
        f.vendor_face_id === vendorFaceId
          ? {
              ...f,
              fecha_toma: null,
              toma_por: null,
              avance: 'PENDIENTE',
              rechazo_motivo: motivo,
              rechazada_por: email,
            }
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
    setFilasLocal((prev) =>
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
              {/* ⭐ = asignada a este usuario por el coordinador. */}
              {misRutas.has(r) ? '⭐ ' : ''}
              {/^\d+$/.test(r) ? `Ruta ${r}` : r}
            </option>
          ))}
        </select>
        {/* El filtro de avance ya no es un select: son las tarjetas de
            abajo, que ahora se tocan para filtrar. */}
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
        {puedeImportar && (
          <button
            className="btn ghost sm"
            onClick={sincronizarRutas}
            disabled={sincronizando || catSel == null}
            title="Crea/actualiza las rutas de monitoreo con los sitios y secuencias de esta catorcena"
          >
            {sincronizando && <span className="spinner" />}
            🗺️ Sincronizar rutas
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
                    // Apagado = el fondo de .tag, con su pareja clara (tema
                    // claro/oscuro, 24-sep-2026). Encendido: naranja con
                    // texto oscuro, igual en los dos temas.
                    background: on ? 'var(--accent)' : 'var(--tag-fondo)',
                    color: on ? '#151515' : 'var(--muted)',
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

      {/* Tarjetas DINÁMICAS: cada una es un botón que filtra la lista —
          tocar Pendientes enseña solo lo pendiente; tocarla otra vez lo
          quita. Sitios y Caras limpian el filtro de avance. Los conteos de
          avance salen de `base` (sin ese filtro), para que las cifras no
          se pongan en cero al filtrar. */}
      <div className="cards">
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
            onClick={t.click}
            aria-pressed={t.activa}
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
              {t.activa ? ' ✕' : ''}
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
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
                👤 {/^\d+$/.test(fRuta) ? `Ruta ${fRuta}` : fRuta} asignada a
              </div>
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
                {asignando && <span className="spinner" />}
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
        <div style={{ marginBottom: 14 }}>
          <button
            type="button"
            className="btn ghost sm"
            onClick={toggleGuias}
            aria-expanded={verGuias}
          >
            {verGuias ? '▾' : '▸'} 🗺️ Guías de ruta (Google Maps)
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
                  🗺️{' '}
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
                  ⚠ {stats.sinCoord} sin ubicación
                </span>
              )}
            </div>
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
                          {alarma ? '🔴' : '⚠'} {e.abiertas} incidencia
                          {e.abiertas === 1 ? '' : 's'} abierta
                          {e.abiertas === 1 ? '' : 's'} ›
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
                          Comprobar YA NO vive aquí: es del coordinador y
                          está DENTRO del visor — primero se ven las fotos,
                          luego se valida o se regresa. */}
                      {(() => {
                        const porComprobar =
                          !!f.fecha_toma && !f.fecha_comprobacion;
                        const revisa = puedeImportar && porComprobar;
                        return (
                          <button
                            className={
                              revisa
                                ? 'btn ok sm'
                                : f.fecha_toma
                                  ? 'btn ghost sm'
                                  : 'btn sm'
                            }
                            onClick={() => setTomaDe(f)}
                          >
                            {revisa ? '🔎' : '📷'}{' '}
                            {revisa
                              ? `Revisar y comprobar${f.fotos ? ` (${f.fotos})` : ''}`
                              : f.fecha_toma
                                ? `Evidencia${f.fotos ? ` (${f.fotos})` : ''}`
                                : 'Registrar toma'}
                          </button>
                        );
                      })()}
                      {f.fecha_comprobacion && f.comprobacion_por && (
                        <span
                          style={{ fontSize: 11, color: 'var(--muted)' }}
                        >
                          Entregó {f.comprobacion_por.split('@')[0]}
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
                          ⛔ Regresada: “{f.rechazo_motivo}”
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
          puedeComprobar={puedeImportar}
          onComprobar={comprobar}
          onRegresada={tomaRegresada}
        />
      )}

      {/* Detalle mínimo de las incidencias abiertas del sitio: nombre,
          área y estatus — lo justo para que el monitorista sepa si lo que
          iba a reportar ya existe. Sin folios ni botones de trabajo: eso
          es del módulo de Incidencias. */}
      {verIncDe && (
        <div
          className="overlay"
          onClick={(e) => {
            if ((e.target as HTMLElement).className === 'overlay')
              setVerIncDe(null);
          }}
        >
          <div className="modal" style={{ maxWidth: 400, margin: 'auto 0' }}>
            <h2 style={{ margin: '0 0 3px', fontSize: 17 }}>
              Incidencias abiertas
            </h2>
            <p className="phint" style={{ marginBottom: 12 }}>
              {verIncDe} — si lo que viste ya está aquí, no lo reportes de
              nuevo.
            </p>
            {incsDelSitio === null ? (
              <div className="loading" style={{ padding: 20 }}>
                Cargando…
              </div>
            ) : incsDelSitio.length === 0 ? (
              <div className="empty" style={{ padding: 20 }}>
                Nada abierto en este sitio.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {incsDelSitio.map((i) => (
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
              <button
                className="btn ghost"
                onClick={() => setVerIncDe(null)}
                style={{ width: '100%' }}
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* La pregunta sutil tras registrar la toma: un diálogo chico y
          centrado, no un confirm() del navegador. "No" no castiga: un tap
          en el fondo también lo cierra. */}
      {ofrecerIncEn && !nuevaEn && (
        <div
          className="overlay"
          onClick={(e) => {
            if ((e.target as HTMLElement).className === 'overlay')
              setOfrecerIncEn(null);
          }}
        >
          <div className="modal" style={{ maxWidth: 360, margin: 'auto 0' }}>
            <h2 style={{ margin: '0 0 3px', fontSize: 17 }}>
              ✓ Toma registrada
            </h2>
            <p className="phint" style={{ marginBottom: 14 }}>
              ¿Viste algo mal en <b>{ofrecerIncEn}</b>? Puedes levantar la
              incidencia ahora mismo, con el sitio ya cargado.
            </p>
            <div className="modal-actions">
              <button
                className="btn ghost"
                onClick={() => setOfrecerIncEn(null)}
              >
                No, todo bien
              </button>
              <button
                className="btn"
                onClick={() => {
                  setNuevaEn(ofrecerIncEn);
                  setOfrecerIncEn(null);
                }}
              >
                ➕ Levantar incidencia
              </button>
            </div>
          </div>
        </div>
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

export default PautaView;
