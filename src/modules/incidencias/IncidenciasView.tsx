// ============================================================
// src/modules/incidencias/IncidenciasView.tsx
// Vista contenedora del módulo Incidencias: carga los datos, aplica filtros
// y orquesta los modales. Es el equivalente al cuerpo de App() del HTML,
// pero acotado a incidencias (App.tsx solo hace sesión y navegación).
//
// Modos:
//   'bandeja' — lo que le toca hacer al rol ahora mismo
//   'todas'   — todo lo que la RLS le deja ver, con filtros
//
// Carga (auditoría primer mes, 24-sep-2026): lo ABIERTO llega completo
// (paginado); del historial terminal, las 1000 más recientes, y más atrás
// solo si se filtra por fecha. Ver `cargar`.
// ============================================================
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { sb } from '../../lib/supabase';
import {
  UNIDADES,
  AREAS_RESP,
  EST_LABEL,
  SLA_VALIDACION_DEFAULT,
} from '../../lib/constants';
import {
  slaHoras,
  slaInfo,
  slaInfoValidador,
  areaEfectiva,
  sinAcentos,
} from '../../lib/helpers';
import { crearReporte } from '../../lib/crearReporte';
import IncCard from '../../components/IncCard';
import NuevaInc from './NuevaInc';
import type { PresetNueva, GrupoReporte } from './NuevaInc';
import RepararModal from './RepararModal';
import type { DatosReparacion } from './RepararModal';
import EvidenciaModal from './EvidenciaModal';
import ChatModal from './ChatModal';
import ReasignModal from './ReasignModal';
import type { ModoReasign } from './ReasignModal';
import EditModal from './EditModal';
import CorreccionModal from './CorreccionModal';
import TablaIncidencias from './TablaIncidencias';
import MotivoModal from './MotivoModal';
import type {
  CanInc,
  Incidencia,
  EstatusInc,
  SlaMap,
  SlaArea,
  SlaValidacion,
  UsuarioRol,
} from '../../types/db';

/** Filas por página: el tope duro de PostgREST es 1000 por consulta. */
const PAGINA = 1000;

/**
 * Tope de seguridad de páginas de ABIERTAS (20,000 filas). No se espera
 * llegar nunca; existe para que un error de datos no ponga a un celular a
 * bajar la base entera. Si se alcanza, la pantalla lo AVISA: un tope
 * silencioso es justo el bug que esta carga vino a quitar.
 */
const TOPE_PAGINAS_ABIERTAS = 20;

/**
 * Tope de páginas del historial cuando el usuario lo pide desde una fecha
 * vieja (10,000 terminales). También se avisa si se alcanza.
 */
const TOPE_PAGINAS_HISTORIAL = 10;

/**
 * Estatus TERMINALES: ya nadie tiene que hacer nada con ellas. Todo lo demás
 * es "abierto" (rechazada incluida: le toca corregir al reportante).
 */
const TERMINALES = ['cerrada', 'no_reparado'];
/** Lo mismo, en la sintaxis de lista que espera `.not('estatus','in',…)`. */
const TERMINALES_LISTA = '(cerrada,no_reparado)';

/**
 * Fotos de tarjeta: cuántos record_id van en cada llamada a la RPC y
 * cuántas llamadas viajan a la vez. 400 ids caben de sobra en el cuerpo del
 * POST, y 3 en paralelo no saturan la conexión de un celular.
 */
const LOTE_FOTOS = 400;
const FOTOS_EN_PARALELO = 3;

/**
 * Tarjetas que se pintan de un jalón. Pintar 2,000 IncCard en un teléfono
 * congela la pantalla varios segundos; se pintan de 150 en 150 con un botón
 * "Mostrar más" (auditoría primer mes, 24-sep-2026). La tabla no se corta.
 */
const PASO_PINTADO = 150;

/**
 * ¿La RPC fotos_tarjetas no existe todavía? (primer_mes.sql sin correr).
 * Se recuerda por sesión para no pagar un viaje fallido en cada recarga; al
 * recargar la app se vuelve a intentar.
 */
let faltaRpcFotos = false;

type ResultadoPaginado = {
  filas: Incidencia[];
  error: string | null;
  /** Se llegó al tope de páginas con la última llena: puede haber más. */
  topado: boolean;
};

/**
 * Trae una consulta paginada de 1000 en 1000 hasta que una página venga
 * incompleta (o se llegue al tope). `pagina` ARMA la consulta cada vez: un
 * builder de postgrest-js vuelve a disparar la petición en cada await, así
 * que es más claro construir uno por página.
 *
 * `vigente` corta el ciclo si otra carga más nueva ya lo superó: no tiene
 * caso seguir bajando páginas que se van a tirar.
 *
 * OJO (paginado por OFFSET): si una incidencia cambia de estatus justo
 * mientras se bajan las páginas, las filas se recorren y una puede saltarse
 * o repetirse. Las repetidas se quitan al unir; una saltada reaparece en la
 * siguiente recarga. Con < 1000 abiertas (lo normal) es una sola página y
 * el caso no existe.
 */
async function traerPaginado(
  pagina: (
    desde: number,
    hasta: number
  ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  topePaginas: number,
  vigente: () => boolean
): Promise<ResultadoPaginado> {
  let filas: Incidencia[] = [];
  for (let n = 0; n < topePaginas; n++) {
    const desde = n * PAGINA;
    const { data, error } = await pagina(desde, desde + PAGINA - 1);
    if (error) return { filas, error: error.message, topado: false };
    const lote = (data as Incidencia[] | null) || [];
    filas = filas.concat(lote);
    if (lote.length < PAGINA || !vigente())
      return { filas, error: null, topado: false };
  }
  return { filas, error: null, topado: true };
}

/**
 * Orden de la lista: fecha de reporte descendente, las que no tienen fecha
 * al final y record_id de desempate (estable entre recargas: sin él, dos
 * con la misma fecha podían intercambiarse y la tarjeta "brincaba").
 */
function porFechaDesc(a: Incidencia, b: Incidencia): number {
  const fa = a.fecha_reporte ? Date.parse(a.fecha_reporte) : NaN;
  const fb = b.fecha_reporte ? Date.parse(b.fecha_reporte) : NaN;
  const sinA = Number.isNaN(fa);
  const sinB = Number.isNaN(fb);
  if (sinA !== sinB) return sinA ? 1 : -1;
  if (!sinA && fa !== fb) return fb - fa;
  return a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0;
}

/**
 * dd/mm/aaaa del DÍA UTC de una marca ISO. Se toma el día igual que el
 * filtro de fechas de la vista (primeros 10 caracteres), para que la fecha
 * que dice el aviso sea la misma que hay que poner en "Desde".
 */
function diaCorto(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

/**
 * Inicio (00:00 UTC, en ms) de un 'YYYY-MM-DD' del input date, o null si
 * todavía no es una fecha completa y creíble. En escritorio el input emite
 * el año a medio teclear (0002, 0020, 0202…): esos no cuentan.
 */
function inicioDiaUtc(dia: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || Number(dia.slice(0, 4)) < 2000)
    return null;
  const ms = Date.parse(dia + 'T00:00:00Z');
  return Number.isNaN(ms) ? null : ms;
}

type MapasFotos = {
  reporte: Record<string, string>;
  reparacion: Record<string, string>;
};

/**
 * Fotos de tarjeta de una lista de record_id, con la RPC fotos_tarjetas
 * (primer_mes.sql). Devuelve null si falló (mala señal): quien llama
 * conserva las fotos que ya tenía.
 *
 * POR QUÉ LA RPC (auditoría primer mes, 24-sep-2026): antes salían de una
 * sola consulta global a `evidencias` con .limit(3000). Con volumen, las
 * 3000 fotos más recientes se las comían las incidencias nuevas y las
 * tarjetas viejas se quedaban sin foto, sin aviso. La RPC recibe los ids y
 * devuelve UN jsonb (escalar: no le aplica el tope de 1000 filas), así que
 * cada tarjeta cargada recibe la suya. Es SECURITY INVOKER: la RLS de
 * evidencias sigue aplicando al usuario.
 *
 * Semántica, la misma de antes (ajuste de Erik, ago-2026):
 *   reporte    → la foto MÁS VIEJA de la etapa 'reporte'
 *   reparacion → la foto MÁS RECIENTE de la etapa 'reparacion'
 *
 * Si la RPC no existe (PGRST202: aún no se corre primer_mes.sql) cae a la
 * consulta anterior, para no romper en el intervalo entre desplegar el
 * frontend y correr el SQL. `conRespaldo=false` omite ese respaldo (sirve
 * para pedir la foto de UNA tarjeta sin bajar 3000 filas).
 */
async function traerFotosTarjetas(
  ids: string[],
  conRespaldo = true
): Promise<MapasFotos | null> {
  const mapas: MapasFotos = { reporte: {}, reparacion: {} };
  if (!ids.length) return mapas;

  if (!faltaRpcFotos) {
    const lotes: string[][] = [];
    for (let k = 0; k < ids.length; k += LOTE_FOTOS)
      lotes.push(ids.slice(k, k + LOTE_FOTOS));
    let siguiente = 0;
    let fallo: { code?: string; message?: string } | null = null;
    // Un grupo chico de "trabajadores" que se van repartiendo los lotes:
    // nunca hay más de FOTOS_EN_PARALELO llamadas en vuelo.
    const trabajador = async () => {
      while (!fallo && siguiente < lotes.length) {
        const lote = lotes[siguiente++];
        const { data, error } = await sb.rpc('fotos_tarjetas', { p_ids: lote });
        if (error) {
          fallo = error;
          return;
        }
        const obj = (data || {}) as Record<
          string,
          { reporte?: string | null; reparacion?: string | null }
        >;
        Object.entries(obj).forEach(([rid, f]) => {
          if (f?.reporte) mapas.reporte[rid] = f.reporte;
          if (f?.reparacion) mapas.reparacion[rid] = f.reparacion;
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FOTOS_EN_PARALELO, lotes.length) }, trabajador)
    );
    const err = fallo as { code?: string; message?: string } | null;
    if (!err) return mapas;
    const noExiste =
      err.code === 'PGRST202' ||
      /could not find the function/i.test(err.message || '');
    if (!noExiste) return null;
    faltaRpcFotos = true;
    console.warn(
      '[incidencias] Falta la función fotos_tarjetas: corre primer_mes.sql en ' +
        'Supabase. Mientras, las fotos de tarjeta salen de las 3000 evidencias ' +
        'más recientes (las tarjetas viejas pueden quedar sin foto).'
    );
  }
  if (!conRespaldo) return null;

  // Respaldo: la consulta de antes. Viene en orden descendente y cada etapa
  // elige distinto:
  //   - reporte: el mapa se SOBREESCRIBE al iterar → queda la más VIEJA;
  //   - reparación: solo la PRIMERA escritura por record_id → la más RECIENTE.
  const { data: evs, error: errEv } = await sb
    .from('evidencias')
    .select('record_id,url,etapa')
    .eq('tipo', 'foto')
    .in('etapa', ['reporte', 'reparacion'])
    .order('creado_en', { ascending: false })
    .limit(3000);
  if (errEv) return null;
  (
    (evs as { record_id: string | null; url: string; etapa: string }[]) || []
  ).forEach((e) => {
    if (!e.record_id) return;
    if (e.etapa === 'reporte') mapas.reporte[e.record_id] = e.url;
    else if (!mapas.reparacion[e.record_id]) mapas.reparacion[e.record_id] = e.url;
  });
  return mapas;
}

/**
 * ¿Dos marcas de tiempo son el mismo instante? Se compara el valor y no el
 * texto: la base devuelve "…+00:00" y el cliente escribe "…Z".
 */
function mismoInstante(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return !a && !b;
  return Date.parse(a) === Date.parse(b);
}

type ModoVista = 'bandeja' | 'todas';

/** Motivo pendiente de capturar: rechazar una reparación o descartar. */
type MotivoPend = { inc: Incidencia; kind: 'rechazo_rep' | 'descartar' };

type Props = {
  email: string;
  nombre: string;
  /** Roles distintos del usuario (de usuario_roles). */
  misRoles: string[];
  /** Departamentos del usuario; el primero se usa como area_reportante. */
  misDep: string[];
  /** Filas completas de usuario_roles: rol + unidad + departamento. */
  rolesDetalle: UsuarioRol[];
  modo: ModoVista;
  /** Rol principal (el de mayor prioridad). Lo usa IncCard. */
  role: string;
  chatCounts: Record<string, number>;
  onChatLeido: (recordId: string) => void;
  /** Refresca la campana tras una acción que dispara notificaciones. */
  onRecargarNotifs: () => void;
  /**
   * Marca leídos los avisos de una incidencia recién ACCIONADA: si ya se
   * hizo la acción, la campana no debe seguir diciendo que hay algo ahí.
   */
  onNotifAtendida: (recordId: string) => void;
  /** record_id a enfocar al llegar desde una notificación. */
  focoRecordId?: string;
  /** Avisa que ya se aplicó el foco, para que el padre lo limpie. */
  onFocoAplicado?: () => void;
  /** Modal de alta, controlado por App (el botón vive en el menú). */
  nuevaAbierta?: boolean;
  onCerrarNueva?: () => void;
  /** Contador del botón ↻: al subir, recarga las incidencias. */
  recargarSignal?: number;
  /** Reporta cuántas incidencias accionables hay, para el badge del menú. */
  onBandejaCount?: (n: number) => void;
};

function IncidenciasView({
  email,
  nombre,
  misRoles,
  misDep,
  rolesDetalle,
  modo,
  role,
  chatCounts,
  onChatLeido,
  onRecargarNotifs,
  onNotifAtendida,
  focoRecordId,
  onFocoAplicado,
  nuevaAbierta,
  onCerrarNueva,
  recargarSignal,
  onBandejaCount,
}: Props) {
  const [items, setItems] = useState<Incidencia[]>([]);
  /**
   * Fotos para la tarjeta, por record_id. La tarjeta enseña LA foto que
   * cuenta la historia del momento (ajuste de Erik, ago-2026):
   *   reporte    → la PRIMERA subida al reportar
   *   reparacion → la MÁS RECIENTE de la reparación (el resultado final)
   *   reasign    → la evidencia de la solicitud de reasignación pendiente
   */
  const [fotos, setFotos] = useState<{
    reporte: Record<string, string>;
    reparacion: Record<string, string>;
    reasign: Record<string, string>;
  }>({ reporte: {}, reparacion: {}, reasign: {} });

  /**
   * La foto que le toca a la tarjeta según su momento:
   *   - reasignación pendiente → la evidencia de la solicitud, que es lo
   *     que el validador está decidiendo;
   *   - reparado/cerrada → la foto de la reparación, con la del reporte de
   *     respaldo si la reparación no trajo foto;
   *   - todo lo demás → la primera foto del reporte.
   */
  /**
   * Unidades de negocio del usuario, para acotar el filtro y el alta.
   * Una fila con unidad null (= todas) o el comodín manager/viewer abren
   * la lista completa; si no, solo las unidades de sus filas de rol.
   */
  const misUnidades = useMemo(() => {
    const todas =
      misRoles.includes('manager') ||
      misRoles.includes('viewer') ||
      rolesDetalle.some((r) => !r.unidad_negocio);
    if (todas || rolesDetalle.length === 0) return UNIDADES;
    return UNIDADES.filter((u) =>
      rolesDetalle.some(
        (r) => (r.unidad_negocio || '').toLowerCase() === u.toLowerCase()
      )
    );
  }, [misRoles, rolesDetalle]);

  const fotoDe = (i: Incidencia): string | undefined => {
    if (i.reasignacion_pendiente && fotos.reasign[i.record_id])
      return fotos.reasign[i.record_id];
    if (i.estatus === 'reparado' || i.estatus === 'cerrada')
      return fotos.reparacion[i.record_id] || fotos.reporte[i.record_id];
    return fotos.reporte[i.record_id];
  };
  /**
   * Tarjetas o tabla. La tabla es la trazabilidad completa (pliego
   * petitorio); solo se ofrece en modo 'todas' — en la bandeja lo que
   * importa es accionar, no barrer.
   */
  const [vista, setVista] = useState<'tarjetas' | 'tabla'>('tarjetas');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [slaMap, setSlaMap] = useState<SlaMap>({});
  const [slaValidacion, setSlaValidacion] = useState<{
    reporte: number;
    reparacion: number;
  }>({
    ...SLA_VALIDACION_DEFAULT,
  });

  // Filtros
  const [q, setQ] = useState('');
  const [fUN, setFUN] = useState('Todas');
  const [fEstado, setFEstado] = useState('Todos');
  const [fArea, setFArea] = useState('Todas');
  /** Filtra por el ÁREA QUE REPORTÓ (area_reportante): MKT, Monitoreo… */
  const [fReporta, setFReporta] = useState('Todas');
  /** Rango de fechas de captura. Vacío = sin límite por ese lado. */
  const [fDesde, setFDesde] = useState('');
  const [fHasta, setFHasta] = useState('');

  /**
   * Cambiar de sección (Mis pendientes ↔ Incidencias) limpia el buscador:
   * la vista es una sola instancia y el folio que fija una notificación se
   * quedaba filtrando la otra pestaña — parecía que faltaban registros
   * (Erik, 10-sep-2026). Los demás filtros se conservan.
   */
  useEffect(() => {
    setQ('');
  }, [modo]);

  /** record_id resaltado tras llegar desde una notificación. */
  const [resaltado, setResaltado] = useState('');
  /** Aviso cuando la notificación apunta a algo que este rol no puede ver. */
  const [avisoFoco, setAvisoFoco] = useState('');

  // Modales. El alta (NuevaInc) NO tiene estado propio: la controla App,
  // porque el botón que la abre vive en el menú lateral.
  const [presetNew, setPresetNew] = useState<PresetNueva | null>(null);
  const [repairing, setRepairing] = useState<Incidencia | null>(null);
  const [evidenceOf, setEvidenceOf] = useState<Incidencia | null>(null);
  const [chatOf, setChatOf] = useState<Incidencia | null>(null);
  const [reassignOf, setReassignOf] = useState<{
    inc: Incidencia;
    mode: ModoReasign;
  } | null>(null);
  const [editOf, setEditOf] = useState<Incidencia | null>(null);
  const [corrigiendo, setCorrigiendo] = useState<Incidencia | null>(null);
  const [motivoOf, setMotivoOf] = useState<MotivoPend | null>(null);

  // --- Permisos ---
  // manager puede todo: se trata como comodín en cada verificación.
  const has = useCallback(
    (r: string) => misRoles.includes(r) || misRoles.includes('manager'),
    [misRoles]
  );
  const esSoloViewer =
    misRoles.length > 0 && misRoles.every((r) => r === 'viewer');
  // La tabla reúne trazabilidad y permite exportar el conjunto filtrado; es
  // una vista de consulta para coordinación y administración. La RLS sigue
  // siendo el candado de las filas que llegan desde la base.
  const puedeVerTabla = has('coordinador');
  // `asignarArea` ya no existe. Se quitó junto con AsignarAreaModal: hacía lo
  // mismo que Reasignar —el área dice "esto no es mío, va para allá"— pero
  // sin motivo y sin pasar por el validador, escribiendo `assigned_area` de
  // frente. Dos botones que se leen igual acaban usándose al azar, y ahí los
  // indicadores de carga por área dejan de significar algo. El flujo único es
  // Reasignar. Las filas que ya traen `assigned_area` se siguen respetando:
  // `areaEfectiva` la lee y la tarjeta la enseña con el chip 🛠 Repara.
  /**
   * ¿Puede ESTE usuario reparar ESTA incidencia?
   *
   * `can.reparar` dice si trae la llave (rol); esto dice de qué puerta es
   * (departamento). Sin este filtro, un técnico de Instalaciones veía el
   * botón de reparar en TODO lo `en_proceso` que su RLS le dejara ver — y
   * con más de un rol (p. ej. técnico + validador) la RLS además deja pasar
   * el update aunque el área no sea la suya: las políticas se evalúan con OR.
   *
   * Reglas, las mismas que usan los triggers notificar_* de la base:
   *   - manager: todas las áreas.
   *   - fila de reparacion/coordinador con departamento null = todas las
   *     áreas; unidad_negocio null = todas las unidades.
   *   - se compara contra el área EFECTIVA (assigned_area manda).
   */
  const reparaEn = useCallback(
    (i: Incidencia) => {
      if (misRoles.includes('manager')) return true;
      const area = areaEfectiva(i).trim().toLowerCase();
      const unidad = (i.unidad_negocio || '').trim().toLowerCase();
      // Solo 'reparacion': el coordinador GESTIONA (pauta, rutas, tabla),
      // no repara — en Incidencias es de consulta (Erik, 21-sep-2026).
      return rolesDetalle.some(
        (r) =>
          r.rol === 'reparacion' &&
          (!r.departamento || r.departamento.trim().toLowerCase() === area) &&
          (!r.unidad_negocio ||
            !unidad ||
            r.unidad_negocio.trim().toLowerCase() === unidad)
      );
    },
    [misRoles, rolesDetalle]
  );

  // El coordinador ya NO trae llaves de reparar ni reasignar: ve las
  // incidencias (y conserva la tabla con export), pero no interactúa —
  // su trabajo vive en Pauta y Rutas (Erik, 21-sep-2026).
  const can: CanInc = {
    crear: has('reportante'),
    validar: has('validador'),
    reparar: has('reparacion'),
    reparaEn,
    reasignar: has('reparacion'),
    aprobarReasign: has('validador'),
  };

  // --- Carga ---
  /**
   * Solo la PRIMERA carga pone la pantalla en "Cargando…". Las recargas
   * (↻, o el aviso nuevo que dispara App) actualizan la lista EN SU LUGAR.
   *
   * El bug que esto corrige (auditoría, 24-sep-2026): toda recarga ponía
   * `loading`, el render hacía return antes de los modales y los DESMONTABA.
   * Un validador a media captura en Nueva incidencia —con fotos en
   * memoria— la perdía entera en cuanto llegaba cualquier aviso.
   */
  const yaCargo = useRef(false);
  const [recargando, setRecargando] = useState(false);

  /**
   * Recargar EN SU LUGAR abre una carrera: mientras la consulta viaja (con
   * mala señal, segundos), el usuario puede validar o capturar; si luego la
   * respuesta —tomada ANTES de su acción— reemplazara la lista, su cambio
   * "se revertiría" en pantalla. Por eso cada carga lleva un número (la
   * respuesta de una carga superada por otra más nueva se descarta) y
   * registra las incidencias que el usuario TOCÓ mientras viajaba: esas
   * conservan su versión local al fusionar.
   */
  const cargaSeq = useRef(0);
  const tocadasEnCarga = useRef<Set<string> | null>(null);
  const marcarTocada = (rid: string) => tocadasEnCarga.current?.add(rid);

  /**
   * Hasta dónde llega el HISTORIAL (terminales) cargado.
   *   frontera — instante ISO desde el cual las terminales están COMPLETAS;
   *              las anteriores pueden faltar. null = historial completo.
   *   n        — cuántas terminales se cargaron
   *   tope     — se pidió por fecha y aun así se llegó al tope de páginas:
   *              ir más atrás no traería nada nuevo
   */
  const [historial, setHistorial] = useState<{
    frontera: string | null;
    n: number;
    tope: boolean;
  }>({ frontera: null, n: 0, tope: false });
  /** Se llegó al tope de páginas de ABIERTAS (20,000): se avisa en pantalla. */
  const [topeAbiertas, setTopeAbiertas] = useState(false);
  /**
   * Día ('YYYY-MM-DD') desde el que la SIGUIENTE carga pide el historial
   * completo. null = solo las 1000 terminales más recientes. Lo mantiene el
   * efecto de "Desde" (abajo) al día con lo que la vista necesita. Es ref y
   * no estado para que `cargar` siga siendo estable (sin dependencias).
   *
   * Sí se encoge (revisión primer mes, 24-sep-2026): antes, una vez pedido,
   * se quedaba toda la sesión, y cada recarga —un aviso nuevo, ↻, un envío
   * que sale— volvía a bajar hasta 10 páginas con '*' más sus fotos aunque
   * ya se hubiera quitado "Desde" o se estuviera en una bandeja que no
   * enseña cerradas. Encoger no recarga: lo ya cargado sobra, no falta.
   */
  const desdeHistorial = useRef<string | null>(null);
  /**
   * Frontera de la última carga LIGERA (una página): de ahí para atrás
   * "Desde" necesita pedir historial. null = esa carga trajo el historial
   * completo. Solo la actualizan las cargas ligeras; mientras la vista siga
   * ampliada se queda la última, que puede ser más vieja que la real. Si
   * entonces se pone un "Desde" entre las dos, no se amplía, y la siguiente
   * recarga (ligera) lo corrige: las cerradas de ese tramo parpadean y se
   * vuelven a pedir. Cuesta una recarga ligera de más, no datos.
   */
  const fronteraLigera = useRef<string | null>(null);
  /**
   * Día con el que salió la carga más reciente (null = ligera, o falló).
   * Sirve para no repetir una ampliación que ya va en camino.
   */
  const desdePedido = useRef<string | null>(null);
  /**
   * ¿Lo que se ve incluye terminales? En 'todas', sí. En la bandeja, solo la
   * del reportante (todo lo suyo, en cualquier estatus) y la de manager,
   * coordinador y viewer (= todo lo cargado). La del validador y la del
   * técnico no enseñan ninguna cerrada (ver `bandeja`): ahí ampliar el
   * historial era bajar miles de filas que nadie ve, y el aviso de historial
   * recortado no aplica (revisión primer mes, 24-sep-2026).
   */
  const bandejaVeTerminales = misRoles.some((r) =>
    ['reportante', 'manager', 'coordinador', 'viewer'].includes(r)
  );
  const vistaVeTerminales = modo === 'todas' || bandejaVeTerminales;

  /**
   * DOS consultas en paralelo, no una (auditoría primer mes, 24-sep-2026).
   *
   * Antes era UNA: las 1000 más recientes de todo. La bandeja, el globito del
   * menú y la vista se calculan sobre lo cargado, así que en cuanto hubiera
   * más de 1000 incidencias, lo abierto viejo —un en_proceso de hace meses—
   * desaparecía de "Mis pendientes" SIN aviso.
   *
   *   a) ABIERTAS: todas, paginadas de 1000 en 1000. Es lo accionable y no
   *      se puede recortar.
   *   b) HISTORIAL (cerradas y no reparadas): las 1000 más recientes. Si
   *      vino llena, está recortado y la pantalla lo dice (donde se ven
   *      terminales). Si el usuario filtra "Desde" una fecha más vieja, se
   *      traen todas desde ahí.
   *
   * Si cualquiera de las dos falla, cuenta como error de carga y se conserva
   * lo anterior: una lista a medias se leería como completa.
   */
  const cargar = useCallback(async () => {
    const miCarga = ++cargaSeq.current;
    const tocadas = new Set<string>();
    tocadasEnCarga.current = tocadas;
    if (yaCargo.current) setRecargando(true);
    else setLoading(true);
    setErr('');
    const vigente = () => miCarga === cargaSeq.current;
    const desdeHist = desdeHistorial.current;
    desdePedido.current = desdeHist;
    const [abiertas, terminales] = await Promise.all([
      traerPaginado(
        (desde, hasta) =>
          sb
            .from('incidencias')
            .select('*')
            .not('estatus', 'in', TERMINALES_LISTA)
            .order('fecha_reporte', { ascending: false })
            .order('record_id', { ascending: true })
            .range(desde, hasta),
        TOPE_PAGINAS_ABIERTAS,
        vigente
      ),
      traerPaginado(
        (desde, hasta) => {
          let consulta = sb
            .from('incidencias')
            .select('*')
            .in('estatus', TERMINALES);
          // Las que no traen fecha se incluyen: sin esto, pedir historial
          // por fecha las sacaba de la lista para siempre.
          if (desdeHist)
            consulta = consulta.or(
              `fecha_reporte.gte."${desdeHist}T00:00:00Z",fecha_reporte.is.null`
            );
          return consulta
            .order('fecha_reporte', { ascending: false })
            .order('record_id', { ascending: true })
            .range(desde, hasta);
        },
        // Sin fecha pedida: UNA página (las 1000 más recientes). "Topado"
        // con una sola página = vino llena = el historial está recortado.
        desdeHist ? TOPE_PAGINAS_HISTORIAL : 1,
        vigente
      ),
    ]);
    // Una carga más nueva ya está en camino: esta respuesta es vieja.
    if (miCarga !== cargaSeq.current) return;
    tocadasEnCarga.current = null;
    // Pasado el primer intento —bien o mal— ninguna recarga vuelve a poner
    // la pantalla en "Cargando…" (que desmontaría los modales abiertos).
    yaCargo.current = true;
    setLoading(false);
    setRecargando(false);
    // Con error (mala señal) se CONSERVA la lista anterior —y sus fotos—:
    // vaciarla hacía desaparecer el trabajo de la pantalla justo cuando no
    // hay red para volver a traerlo.
    const error = abiertas.error || terminales.error;
    if (error) {
      setErr('incidencias: ' + error);
      // De esa fecha no llegó nada: ya no "va en camino". Sin esto, tras un
      // fallo, poner la misma fecha o una más reciente no volvía a pedirla
      // (el efecto de "Desde" la daba por pedida) y solo ↻ la traía
      // (revisión primer mes, 24-sep-2026).
      desdePedido.current = null;
      return;
    }
    // Unión sin duplicados: una que cambió de estatus entre las dos
    // consultas puede venir en ambas. Gana la TERMINAL (revisión primer mes,
    // 24-sep-2026): cerrada y no_reparado no se revierten desde la app, así
    // que si una consulta la vio abierta y la otra terminal, la terminal es
    // forzosamente la más nueva. Antes ganaba la abierta y la tarjeta seguía
    // ofreciendo "Aprobar reparación" sobre una ya cerrada. OJO: si algún
    // día otra vía (app vieja, SQL) reabre incidencias, este supuesto deja
    // de valer, y `incidencias` no trae una columna de última modificación
    // con la cual desempatar. El orden final lo da porFechaDesc.
    const vistos = new Set<string>();
    const delServidor: Incidencia[] = [];
    for (const i of [...terminales.filas, ...abiertas.filas]) {
      if (vistos.has(i.record_id)) continue;
      vistos.add(i.record_id);
      delServidor.push(i);
    }
    delServidor.sort(porFechaDesc);
    setTopeAbiertas(abiertas.topado);
    // La más vieja CON fecha: es la frontera del historial cargado.
    let masVieja: string | null = null;
    let masViejaMs = Infinity;
    for (const i of terminales.filas) {
      const ms = i.fecha_reporte ? Date.parse(i.fecha_reporte) : NaN;
      if (!Number.isNaN(ms) && ms < masViejaMs) {
        masViejaMs = ms;
        masVieja = i.fecha_reporte;
      }
    }
    // Umbral de "Desde" para pedir historial (ver fronteraLigera): solo lo
    // mueve una carga ligera, que es la que dice dónde se corta por omisión.
    if (!desdeHist) fronteraLigera.current = terminales.topado ? masVieja : null;
    // Sin fecha pedida: si la página vino llena, lo completo empieza en la
    // más vieja cargada. Pedido por fecha: completo desde ese día (lo de
    // antes no se pidió), salvo que se haya topado.
    setHistorial({
      frontera: terminales.topado
        ? masVieja
        : desdeHist
          ? desdeHist + 'T00:00:00Z'
          : null,
      n: terminales.filas.length,
      tope: !!desdeHist && terminales.topado,
    });
    setItems((prev) => {
      if (!tocadas.size) return delServidor;
      const locales = new Map(prev.map((i) => [i.record_id, i]));
      const idsServidor = new Set(delServidor.map((i) => i.record_id));
      // Las recién creadas que el servidor aún no devolvía, al frente.
      const nuevas = [...tocadas]
        .filter((rid) => !idsServidor.has(rid) && locales.has(rid))
        .map((rid) => locales.get(rid) as Incidencia);
      return [
        ...nuevas,
        ...delServidor.map((s) =>
          tocadas.has(s.record_id) ? locales.get(s.record_id) ?? s : s
        ),
      ];
    });

    // Las fotos de la tarjeta (pliego petitorio, ago-2026). Van DESPUÉS de
    // soltar el loading: la lista se usa igual sin fotos, y así no se le
    // cobra la espera.
    //
    // Por record_id de lo cargado, con la RPC fotos_tarjetas (ver
    // traerFotosTarjetas): cada tarjeta recibe la suya aunque sea vieja.
    // Van también las tocadas en vuelo (p. ej. recién creadas que el
    // servidor aún no devolvía), que se conservan en la lista.
    // La evidencia de reasignación no vive en `evidencias`: viaja como URL
    // en `reasignaciones.evidencia`, y solo importa la solicitud abierta.
    const ids = [
      ...new Set([...delServidor.map((i) => i.record_id), ...tocadas]),
    ];
    const [mapas, { data: reasEv, error: errReas }] = await Promise.all([
      traerFotosTarjetas(ids),
      sb
        .from('reasignaciones')
        .select('record_id,evidencia')
        .eq('estado', 'Solicitada')
        .not('evidencia', 'is', null)
        .limit(500),
    ]);
    // Si fallaron (mala señal), las tarjetas conservan las fotos que ya
    // tenían: mapas vacíos las dejaban a todas sin foto.
    if (!mapas || errReas || miCarga !== cargaSeq.current) return;
    const mReporte = mapas.reporte;
    const mReparacion = mapas.reparacion;
    const mReasign: Record<string, string> = {};
    ((reasEv as { record_id: string; evidencia: string }[]) || []).forEach(
      (r) => {
        if (!mReasign[r.record_id]) mReasign[r.record_id] = r.evidencia;
      }
    );
    setFotos({ reporte: mReporte, reparacion: mReparacion, reasign: mReasign });
  }, []);

  useEffect(() => {
    cargar();
    (async () => {
      // slaMap: horas de SLA por área, en minúsculas (así lo espera IncCard).
      const [{ data }, { data: validaciones }] = await Promise.all([
        sb.from('sla_areas').select('area,sla_horas'),
        sb.from('sla_validacion').select('etapa,minutos'),
      ]);
      const m: SlaMap = {};
      ((data as SlaArea[]) || []).forEach((r) => {
        if (r.area) {
          const h = slaHoras(r.sla_horas);
          if (h) m[r.area.trim().toLowerCase()] = h;
        }
      });
      setSlaMap(m);
      const siguiente: { reporte: number; reparacion: number } = {
        ...SLA_VALIDACION_DEFAULT,
      };
      ((validaciones as SlaValidacion[]) || []).forEach((s) => {
        if (
          (s.etapa === 'reporte' || s.etapa === 'reparacion') &&
          Number.isFinite(Number(s.minutos)) &&
          Number(s.minutos) > 0
        )
          siguiente[s.etapa] = Number(s.minutos);
      });
      setSlaValidacion(siguiente);
    })();
  }, [cargar]);

  /**
   * "Desde" más viejo que el historial cargado → se trae del servidor.
   *
   * Sin esto, con el historial recortado a las 1000 terminales más
   * recientes, filtrar por un mes viejo enseñaba solo lo abierto de ese mes
   * y las cerradas "no existían". Se fija desdeHistorial y se recarga: desde
   * ahí la consulta de terminales es "todas desde esa fecha" (paginada).
   *
   * Solo donde se ven terminales (vistaVeTerminales): 'todas' y las bandejas
   * del reportante y de manager/coordinador/viewer. En "Mis pendientes" del
   * validador o del técnico, un "Desde" viejo ya no baja el historial; si
   * con ese mismo "Desde" pasa a 'todas', ahí se amplía (revisión primer
   * mes, 24-sep-2026).
   *
   * Y a la inversa: si ya no hace falta (se quitó "Desde", se puso uno
   * dentro de la carga ligera o se volvió a una bandeja sin cerradas),
   * desdeHistorial vuelve a null SIN recargar. Lo cargado se queda en
   * pantalla y la siguiente recarga ya sale de una página.
   *
   * La recarga solo se dispara con una fecha completa y válida, y con una
   * pausa: en escritorio el input date emite el año a medio teclear
   * (0002, 0020, 0202…) y cada uno habría sido una recarga.
   */
  useEffect(() => {
    const ms = inicioDiaUtc(fDesde);
    const ligera = fronteraLigera.current;
    // ¿Pide cerradas más viejas que las que trae la carga ligera? Si la
    // ligera vino completa (ligera = null), nunca.
    const pide =
      vistaVeTerminales && ms != null && ligera != null && ms < Date.parse(ligera)
        ? fDesde
        : null;
    desdeHistorial.current = pide;
    if (pide == null || ms == null) return;
    // Ya se pidió por fecha y aun así topó: ir más atrás no traería nada
    // nuevo (el aviso lo dice).
    if (historial.tope) return;
    // Lo cargado ya cubre ese día completo: basta con que las siguientes
    // recargas lo sigan pidiendo (desdeHistorial ya quedó arriba).
    if (historial.frontera && ms >= Date.parse(historial.frontera)) return;
    // Ya va en camino una carga desde esa fecha o antes.
    if (desdePedido.current && desdePedido.current <= fDesde) return;
    const t = setTimeout(() => cargar(), 700);
    return () => clearTimeout(t);
  }, [fDesde, vistaVeTerminales, historial, cargar]);

  // Al llegar desde una notificación: se limpian los filtros y se busca por
  // folio. Lo ABIERTO ya viene completo en la carga; lo que puede faltar es
  // una terminal vieja (fuera de las 1000 más recientes del historial). Si
  // no está en lo cargado, se consulta por record_id antes de concluir que
  // no es visible para este usuario.
  //
  // Al terminar se avisa al padre para que limpie focoRecordId. Si no, cada
  // vez que cambiara `items` (o se remontara la vista) se volvería a forzar
  // el folio viejo en el buscador, borrando lo que el usuario escribiera.
  useEffect(() => {
    if (!focoRecordId) return;
    // Mientras la lista no haya cargado, no se decide nada: se reintenta al
    // siguiente cambio de `items`. `loading` es la señal fiable; `length===0`
    // no lo es, porque una lista legítimamente vacía se veía igual que una
    // que todavía no llega.
    if (loading) return;

    const it = items.find((i) => i.record_id === focoRecordId);

    if (!it) {
      let cancelado = false;
      (async () => {
        const { data, error } = await sb
          .from('incidencias')
          .select('*')
          .eq('record_id', focoRecordId)
          .maybeSingle();
        if (cancelado) return;

        if (data) {
          // Se agrega a la lista actual para que los filtros y el resaltado
          // funcionen igual que con cualquier fila de la carga principal.
          // Tocada: una recarga en vuelo no debe borrarla al fusionar.
          tocadasEnCarga.current?.add(focoRecordId);
          setItems((prev) =>
            prev.some((i) => i.record_id === focoRecordId)
              ? prev
              : [data as Incidencia, ...prev]
          );
          // Su foto de tarjeta: no venía en la carga de fotos porque la fila
          // no estaba cargada. Sin respaldo: si falta la RPC, se queda sin
          // foto en vez de bajar 3000 evidencias por una tarjeta.
          const rid = focoRecordId;
          traerFotosTarjetas([rid], false).then((m) => {
            if (!m) return;
            setFotos((prev) => ({
              ...prev,
              reporte: { ...prev.reporte, ...m.reporte },
              reparacion: { ...prev.reparacion, ...m.reparacion },
            }));
          });
          return;
        }

        setAvisoFoco(
          error
            ? 'No se pudo abrir la incidencia de la notificación: ' + error.message
            : 'La incidencia de esta notificación ya no está disponible.'
        );
        onFocoAplicado?.();
      })();
      return () => {
        cancelado = true;
      };
    }

    // Se limpia TODO lo que podría esconderla, incluidas las fechas y el
    // filtro "Reporta" (faltaba: con otra área elegida, la tarjeta quedaba
    // filtrada y el resaltado no encontraba nada — auditoría primer mes).
    setAvisoFoco('');
    setQ(it.folio || '');
    setFUN('Todas');
    setFArea('Todas');
    setFReporta('Todas');
    setFEstado('Todos');
    setFDesde('');
    setFHasta('');
    setResaltado(focoRecordId);
    onFocoAplicado?.();
  }, [focoRecordId, items, loading, onFocoAplicado]);

  /**
   * Lleva la tarjeta resaltada a la vista y apaga el resalte a los 4 s.
   *
   * Sin esto, "ir a la incidencia" solo escribía el folio en el buscador.
   * Si la lista ya estaba filtrada por ese folio, la pantalla no cambiaba
   * ni un pixel y parecía que el clic se había perdido.
   */
  useEffect(() => {
    if (!resaltado) return;
    const el = document.getElementById('inc-' + resaltado);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setResaltado(''), 4000);
    return () => clearTimeout(t);
    // Solo depende de `resaltado`: los efectos corren después de que el DOM
    // ya se pintó, así que la tarjeta existe cuando esto se ejecuta.
  }, [resaltado]);

  // Botón ↻ de la barra superior. Se compara contra el valor previo para no
  // recargar de más en el montaje (ahí los datos ya vienen frescos).
  const recargaPrev = useRef(recargarSignal);
  useEffect(() => {
    if (recargarSignal !== undefined && recargarSignal !== recargaPrev.current) {
      recargaPrev.current = recargarSignal;
      cargar();
    }
  }, [recargarSignal, cargar]);

  // --- Filtrado ---
  /**
   * Lo accionable: qué le toca hacer ahora.
   *
   * OJO: esto mira `misRoles` (TODOS sus roles), no `role` (el principal).
   * Antes miraba solo `role`, y eso borraba a quien tiene dos.
   *
   * El caso que lo destapó: una persona con `reportante` + `reparacion`.
   * `ROLE_PRIORITY` pone `reparacion` por encima, así que su `role` era
   * 'reparacion', y la bandeja de reparación solo muestra `en_proceso`.
   * Capturaba una incidencia —que nace `por_validar`—, se guardaba bien,
   * y desaparecía de su pantalla sin ningún error. Parecía que no se
   * había guardado. Estaba guardada; su mitad reportante no tenía bandeja.
   *
   * Con varios roles las condiciones se SUMAN: le toca lo de todos.
   */
  const bandeja = useMemo(() => {
    const tiene = (r: string) => misRoles.includes(r);

    // Manager, coordinador y viewer no tienen bandeja acotada: ven todo.
    // Se conserva tal cual estaba.
    if (tiene('manager') || tiene('coordinador') || tiene('viewer'))
      return items;

    const yo = (email || '').toLowerCase();

    return items.filter((i) => {
      // Al validador le toca también REVISAR las reasignaciones pendientes:
      // viven en 'en_proceso' y sin esta condición jamás caían en su
      // bandeja, aunque el botón "Revisar reasignación" es suyo.
      if (
        tiene('validador') &&
        (i.estatus === 'por_validar' ||
          i.estatus === 'reparado' ||
          i.reasignacion_pendiente)
      )
        return true;

      if (tiene('reparacion') && i.estatus === 'en_proceso' && reparaEn(i))
        return true;

      // El reportante ve TODO lo suyo, en cualquier estatus. Antes solo veía
      // lo rechazado —lo accionable— y el efecto fue que capturaba y su
      // reporte desaparecía de su pantalla: no tenía DÓNDE ver en qué va
      // (pliego petitorio, ago-2026). El badge del menú sigue contando solo
      // lo accionable, para que no infle.
      if (tiene('reportante') && (i.captured_by || '').toLowerCase() === yo)
        return true;

      return false;
    });
  }, [items, misRoles, email, reparaEn]);

  /** Aviso sutil para el validador: solo pendientes con reloj naranja o rojo. */
  const alertasValidacion = useMemo(() => {
    if (!can.validar) return { porVencer: 0, vencidas: 0 };
    let porVencer = 0;
    let vencidas = 0;
    bandeja.forEach((i) => {
      const reloj =
        i.estatus === 'por_validar' && i.fecha_reporte
          ? slaInfoValidador(i.fecha_reporte, slaValidacion.reporte)
          : i.estatus === 'reparado' && i.sla_validacion_inicio
            ? slaInfoValidador(i.sla_validacion_inicio, slaValidacion.reparacion)
            : null;
      if (!reloj) return;
      if (reloj.color === '#ef4444') vencidas += 1;
      else if (reloj.color === '#f59e0b') porVencer += 1;
    });
    return { porVencer, vencidas };
  }, [bandeja, can.validar, slaValidacion]);

  // El badge de "Mi bandeja" cuenta solo lo ACCIONABLE, no lo visible. La
  // bandeja del reportante ahora enseña todas sus capturas; si el badge las
  // contara todas, marcaría "12" permanentes y dejaría de significar "te
  // toca hacer algo".
  const accionables = useMemo(() => {
    const tiene = (r: string) => misRoles.includes(r);
    if (tiene('manager') || tiene('coordinador') || tiene('viewer'))
      return bandeja.length;
    const yo = (email || '').toLowerCase();
    return items.filter(
      (i) =>
        (tiene('validador') &&
          (i.estatus === 'por_validar' ||
            i.estatus === 'reparado' ||
            i.reasignacion_pendiente)) ||
        (tiene('reparacion') && i.estatus === 'en_proceso' && reparaEn(i)) ||
        (tiene('reportante') &&
          (i.captured_by || '').toLowerCase() === yo &&
          i.estatus === 'rechazada')
    ).length;
  }, [items, bandeja.length, misRoles, email, reparaEn]);

  useEffect(() => {
    onBandejaCount?.(accionables);
  }, [accionables, onBandejaCount]);

  // Áreas elegibles al dirigir una incidencia: las del catálogo MÁS las que
  // ya existen en los datos (Urban, Imprenta, Op. Bio Box… no están en
  // AREAS_RESP, y sin esto no se podrían elegir).
  const areasElegibles = useMemo(() => {
    const set = new Set<string>(AREAS_RESP);
    items.forEach((i) => {
      if (i.area_responsable) set.add(i.area_responsable);
      if (i.assigned_area) set.add(i.assigned_area);
    });
    return [...set].sort();
  }, [items]);

  const visibles = useMemo(() => {
    const base = modo === 'bandeja' ? bandeja : items;
    return base.filter((i) => {
      if (fUN !== 'Todas' && i.unidad_negocio !== fUN) return false;
      // El filtro de área acepta las dos: las que le tocan por catálogo y
      // las que le redirigieron. Si no, el técnico filtra por su área y no
      // ve el trabajo que sí le asignaron.
      if (
        fArea !== 'Todas' &&
        i.area_responsable !== fArea &&
        i.assigned_area !== fArea
      )
        return false;
      if (fEstado !== 'Todos' && i.estatus !== fEstado) return false;
      // Quién reporta = el área de pertenencia con la que nació el reporte.
      if (fReporta !== 'Todas' && (i.area_reportante || '') !== fReporta)
        return false;
      // Rango de fechas de captura. `fecha_reporte` es un timestamp ISO en
      // UTC; los inputs date dan 'YYYY-MM-DD'. Comparar los primeros 10
      // caracteres evita convertir zonas horarias y que un reporte de las
      // 11 p.m. se cuente como del día siguiente.
      if (i.fecha_reporte) {
        const dia = i.fecha_reporte.slice(0, 10);
        if (fDesde && dia < fDesde) return false;
        if (fHasta && dia > fHasta) return false;
      } else if (fDesde || fHasta) {
        // Sin fecha no se puede afirmar que caiga en el rango.
        return false;
      }
      if (q) {
        // sinAcentos en las dos puntas: "camion" debe encontrar "Camión"
        // sin obligar a escribir el acento en el teclado del celular.
        const s = sinAcentos(
          `${i.folio} ${i.nombre_incidencia} ${i.direccion} ${i.campania}`
        );
        if (!s.includes(sinAcentos(q))) return false;
      }
      return true;
    });
  }, [
    items,
    bandeja,
    modo,
    q,
    fUN,
    fArea,
    fReporta,
    fEstado,
    fDesde,
    fHasta,
  ]);

  /**
   * Pintado progresivo de tarjetas (ver PASO_PINTADO).
   *
   * El corte se guarda JUNTO con la "clave" de filtros para la que se pidió:
   * si cambia un filtro, la búsqueda, la sección o la vista, la clave ya no
   * coincide y se vuelve a PASO_PINTADO sin un efecto de por medio (un
   * efecto dejaría un pintado intermedio con el corte viejo). Una recarga NO
   * cambia la clave: quien ya abrió 450 no se los ve colapsar por un aviso.
   */
  const clavePintado = [
    modo,
    vista,
    q,
    fUN,
    fArea,
    fReporta,
    fEstado,
    fDesde,
    fHasta,
  ].join('|');
  const [pintado, setPintado] = useState({ clave: '', n: PASO_PINTADO });
  const nBasePintado =
    pintado.clave === clavePintado ? pintado.n : PASO_PINTADO;
  // La tarjeta enfocada desde una notificación SIEMPRE queda pintada, aunque
  // esté más abajo del corte: se calcula en el mismo render en que se pone
  // `resaltado`, así que ya existe en el DOM cuando corre el scrollIntoView.
  const idxResaltado = resaltado
    ? visibles.findIndex((i) => i.record_id === resaltado)
    : -1;
  const nPintadas = Math.max(nBasePintado, idxResaltado + 1);
  // …y se queda pintada al apagarse el resalte a los 4 s (si no, el corte
  // volvería a su tamaño y la tarjeta desaparecería bajo el dedo).
  useEffect(() => {
    if (idxResaltado + 1 > nBasePintado)
      setPintado({ clave: clavePintado, n: idxResaltado + 1 });
  }, [idxResaltado, nBasePintado, clavePintado]);

  /**
   * Opciones del filtro "Reporta": las áreas reportantes que de verdad
   * existen en lo cargado. Autoalimentado: si mañana reporta otra área,
   * aparece sola sin tocar código.
   */
  const areasReportantes = useMemo(
    () =>
      [...new Set(items.map((i) => i.area_reportante).filter(Boolean))].sort() as string[],
    [items]
  );

  // --- Acciones ---
  /** Aplica un patch en memoria para no recargar toda la lista. */
  const patchInc = (rid: string, patch: Partial<Incidencia>) => {
    marcarTocada(rid);
    setItems((prev) =>
      prev.map((i) => (i.record_id === rid ? { ...i, ...patch } : i))
    );
  };

  /**
   * Un cambio de estatus que afectó 0 filas puede ser dos cosas distintas:
   * que OTRA persona ya movió la incidencia (la precondición de estatus ya
   * no se cumple) o que la RLS no te deja. Se distingue releyendo la fila;
   * si cambió, la tarjeta se actualiza con lo real.
   *
   * Por qué existe (auditoría, 24-sep-2026): los updates iban solo por
   * record_id y ganaba el último que escribía. Con varios validadores sobre
   * la misma cola, un "aprobar" y un "rechazar" casi simultáneos dejaban
   * una incidencia cerrada de vuelta en proceso, sin aviso para nadie.
   */
  /**
   * Devuelve true si la causa fue que otra persona ya la movió.
   * `reparadaEn`: al aprobar/rechazar una reparación también se exige que
   * sea LA MISMA que se está viendo (ver cambiarEstatus); si otro la rechazó
   * y el técnico volvió a repararla, el estatus coincide pero el trabajo no.
   */
  const explicarSinCambio = async (
    rid: string,
    esperado: EstatusInc,
    reparadaEn?: string | null
  ): Promise<boolean> => {
    const { data } = await sb
      .from('incidencias')
      .select('*')
      .eq('record_id', rid)
      .maybeSingle();
    const actual = data as Incidencia | null;
    const otraReparacion =
      reparadaEn !== undefined && !mismoInstante(actual?.repaired_at, reparadaEn);
    if (actual && (actual.estatus !== esperado || otraReparacion)) {
      marcarTocada(rid);
      setItems((prev) => prev.map((i) => (i.record_id === rid ? actual : i)));
      alert(
        actual.estatus !== esperado
          ? 'Esta incidencia ya la atendió otra persona: ahora está en "' +
              (EST_LABEL[actual.estatus] || actual.estatus) +
              '". Tu lista ya se actualizó.'
          : 'Esta reparación cambió mientras la revisabas (la rechazaron y ' +
              'el técnico la volvió a reparar). Tu lista ya se actualizó: ' +
              'revisa la reparación nueva antes de decidir.'
      );
      return true;
    }
    alert(
      'No se guardó: tu rol o tu área no permiten este cambio en esta incidencia.'
    );
    return false;
  };

  const cambiarEstatus = async (rid: string, estatus: EstatusInc) => {
    const patch: Partial<Incidencia> = { estatus };
    // Se deja rastro de quién aprobó/reparó, además del estatus.
    if (estatus === 'en_proceso') {
      patch.validator_approved = true;
      patch.validator_email = email;
      patch.validator_at = new Date().toISOString();
    }
    if (estatus === 'reparado') {
      patch.repaired_by_email = email;
      patch.repaired_at = new Date().toISOString();
    }
    // Precondición: la incidencia sigue en el estatus que el usuario VE. Al
    // aprobar una reparación (→ cerrada) además debe ser LA MISMA reparación
    // que se revisó: si otro la rechazó y el técnico la volvió a reparar, el
    // estatus vuelve a 'reparado' y solo repaired_at delata el cambio.
    const actual = items.find((i) => i.record_id === rid);
    const esperado = actual?.estatus;
    const exigeReparacion = estatus === 'cerrada' && !!actual?.repaired_at;
    let q = sb.from('incidencias').update(patch).eq('record_id', rid);
    if (esperado) q = q.eq('estatus', esperado);
    if (exigeReparacion) q = q.eq('repaired_at', actual!.repaired_at as string);
    const { data, error } = await q.select('record_id');
    if (error) {
      alert('No se pudo actualizar: ' + error.message);
      return;
    }
    if (!data || data.length === 0) {
      if (esperado)
        await explicarSinCambio(
          rid,
          esperado,
          exigeReparacion ? actual!.repaired_at : undefined
        );
      else alert('No se guardó: tu rol no permite este cambio.');
      return;
    }
    patchInc(rid, patch);
    onNotifAtendida(rid);
    setTimeout(onRecargarNotifs, 400);
  };

  const guardarReparacion = async (
    inc: Incidencia,
    {
      diagnostico,
      detalle,
      incidenciaSrd,
      arbolDigitalId,
      causa,
      solucion,
    }: DatosReparacion
  ) => {
    const patch: Partial<Incidencia> = {
      estatus: 'reparado',
      diagnostico: diagnostico || null,
      detalle_reparacion: detalle || null,
      // Solo Digital manda estas columnas. Así las demás áreas siguen
      // reparando incluso durante el intervalo entre desplegar el frontend y
      // correr incidencias_clasificacion_digital.sql en Supabase.
      ...(incidenciaSrd && arbolDigitalId != null
        ? {
            incidencia_srd: incidenciaSrd,
            arbol_digital_id: arbolDigitalId,
          }
        : {}),
      causa_raiz: causa || null,
      solucion: solucion || null,
      repaired_by_email: email,
      repaired_at: new Date().toISOString(),
    };
    const { data, error } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id)
      // Precondición: sigue en el estatus en que se abrió el modal.
      .eq('estatus', inc.estatus)
      .select(
        'record_id,incidencia_srd,arbol_digital_id,causa_raiz,diagnostico,solucion'
      );
    if (error) {
      alert('No se pudo guardar la reparación: ' + error.message);
      return;
    }
    // La RLS no lanza error cuando el update no te toca: afecta 0 filas y
    // regresa "éxito". Sin esta verificación la app pintaba la incidencia
    // como reparada aunque la base no hubiera guardado nada. 0 filas también
    // es "alguien más ya la movió": explicarSinCambio distingue los dos.
    if (!data || data.length === 0) {
      // Si otro ya la movió, el modal de reparación ya no tiene sentido.
      if (await explicarSinCambio(inc.record_id, inc.estatus)) setRepairing(null);
      return;
    }
    const guardada = data[0] as Partial<Incidencia>;
    if (
      incidenciaSrd &&
      (guardada.incidencia_srd !== incidenciaSrd ||
        String(guardada.arbol_digital_id) !== String(arbolDigitalId))
    ) {
      alert(
        'La reparación se guardó, pero Supabase no devolvió la clasificación ' +
          'técnica de Digital. Recarga y revisa esta incidencia antes de continuar.'
      );
      return;
    }
    patchInc(inc.record_id, { ...patch, ...guardada });
    setRepairing(null);
    onNotifAtendida(inc.record_id);
    setTimeout(onRecargarNotifs, 400);
  };

  const rechazarReparacion = async (inc: Incidencia, motivo: string) => {
    const patch: Partial<Incidencia> = {
      estatus: 'en_proceso',
      motivo_rechazo_reparacion: motivo,
    };
    // Solo se rechaza lo que sigue 'reparado' Y con la misma reparación que
    // se revisó: si otro validador ya la cerró, rechazarla la regresaba a en
    // proceso sin contar el rechazo; si la reparación es otra, se estaría
    // rechazando un trabajo que nadie vio.
    let q = sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id)
      .eq('estatus', inc.estatus);
    if (inc.repaired_at) q = q.eq('repaired_at', inc.repaired_at);
    const { data, error } = await q.select('record_id');
    if (error) {
      alert('No se pudo rechazar: ' + error.message);
      return;
    }
    if (!data || data.length === 0) {
      await explicarSinCambio(
        inc.record_id,
        inc.estatus,
        inc.repaired_at ? inc.repaired_at : undefined
      );
      setMotivoOf(null);
      return;
    }
    // El contador de rechazos lo incrementa el trigger inc_cuenta_rechazo
    // en la base (por eso NO va en el patch que se manda). Aquí solo se
    // refleja en el estado local para que la tarjeta lo enseñe sin esperar
    // una recarga.
    patchInc(inc.record_id, {
      ...patch,
      rechazos_reparacion: (inc.rechazos_reparacion || 0) + 1,
    });
    setMotivoOf(null);
    onNotifAtendida(inc.record_id);
    setTimeout(onRecargarNotifs, 400);
  };

  const prevalidar = async (inc: Incidencia) => {
    const { data, error } = await sb
      .from('incidencias')
      .update({ prevalidada: true })
      .eq('record_id', inc.record_id)
      .eq('estatus', inc.estatus)
      .select('record_id');
    if (error) {
      alert('No se pudo prevalidar: ' + error.message);
      return;
    }
    if (!data || data.length === 0) {
      await explicarSinCambio(inc.record_id, inc.estatus);
      return;
    }
    patchInc(inc.record_id, { prevalidada: true });
  };

  const descartarPrevalidacion = async (inc: Incidencia, motivo: string) => {
    const patch: Partial<Incidencia> = {
      estatus: 'rechazada',
      prevalidada: false,
      motivo_rechazo_reparacion: motivo,
    };
    const { data, error } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id)
      .eq('estatus', inc.estatus)
      .select('record_id');
    if (error) {
      alert('No se pudo descartar: ' + error.message);
      return;
    }
    if (!data || data.length === 0) {
      await explicarSinCambio(inc.record_id, inc.estatus);
      setMotivoOf(null);
      return;
    }
    patchInc(inc.record_id, patch);
    setMotivoOf(null);
    onNotifAtendida(inc.record_id);
  };

  /**
   * Inserta el reporte y liga la evidencia POR GRUPO.
   *
   * La lógica vive en lib/crearReporte.ts, COMPARTIDA con Pauta y
   * Monitoreo (que levanta reportes al terminar una toma): regla de
   * duplicidad, RLS silenciosa y evidencia por grupo son idénticas se
   * capture desde donde se capture. Aquí solo queda lo local: meter las
   * creadas a la lista y cerrar el modal. null = abortado (duplicado o
   * insert fallido): el modal se queda abierto para corregir.
   */
  const crear = async (grupos: GrupoReporte[]) => {
    const creadas = await crearReporte(grupos, { email, misDep });
    if (!creadas) return;
    creadas.forEach((c) => marcarTocada(c.record_id));
    // Sin duplicar: si una recarga terminó mientras se subían las fotos, la
    // lista ya trae estas filas desde el servidor.
    const ids = new Set(creadas.map((c) => c.record_id));
    setItems((prev) => [...creadas, ...prev.filter((p) => !ids.has(p.record_id))]);
    onCerrarNueva?.();
    setPresetNew(null);
    setTimeout(onRecargarNotifs, 400);
  };

  // --- Render ---
  if (loading) return <div className="loading">Cargando datos…</div>;

  return (
    <>
      {err && <div className="err">{err}</div>}
      {avisoFoco && (
        <div className="err" onClick={() => setAvisoFoco('')} role="alert">
          {avisoFoco} <span style={{ opacity: 0.7 }}>(clic para cerrar)</span>
        </div>
      )}

      <h2 className="page">
        {modo === 'bandeja'
          ? has('validador') || has('reparacion')
            ? 'Mis pendientes'
            : 'Mi bandeja'
          : 'Incidencias'}
        {recargando && (
          <span
            style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 10 }}
          >
            <span className="spinner" />
            Actualizando…
          </span>
        )}
      </h2>
      <p className="phint">
        {modo === 'bandeja' && role === 'validador'
          ? 'Por validar y reparaciones por aprobar.'
          : modo === 'bandeja' && role === 'reparacion'
            ? 'Asignadas a tu área.'
            : modo === 'bandeja'
              ? 'Aquí puedes consultar todo lo relacionado a tus incidencias reportadas. Lo rechazado es lo que te toca corregir.'
              : 'Todo lo que tu rol puede ver (filtrado por seguridad).'}
      </p>

      {/* Historial recortado: se dice donde se ven terminales ('todas' y
          las bandejas que enseñan cerradas, ver vistaVeTerminales). Solo si
          afecta a lo que se ve: con "Desde" dentro de lo ya completo, no hay
          nada que avisar. (Auditoría primer mes, 24-sep-2026.)
          En la bandeja va SIN conteo (revisión primer mes, 24-sep-2026):
          historial.n cuenta todas las terminales cargadas, no las de la
          bandeja, y a un reportante le daría un número falso. El reportante
          puro no tiene la pestaña 'todas': sin este aviso, sus cerradas
          viejas desaparecían de "Mi bandeja" sin decir nada. */}
      {vistaVeTerminales &&
        historial.frontera &&
        (inicioDiaUtc(fDesde) ?? -Infinity) < Date.parse(historial.frontera) && (
          <p className="phint" style={{ marginTop: -12 }}>
            {modo === 'todas' ? (
              <>
                🗂 Historial: se muestran las {historial.n.toLocaleString('es-MX')}{' '}
                cerradas o no reparadas más recientes (desde el{' '}
                {diaCorto(historial.frontera)}).{' '}
                {historial.tope
                  ? 'Es el tope de carga de esta pantalla.'
                  : 'Para ver anteriores, filtra por fecha en «Desde».'}
              </>
            ) : (
              <>
                🗂 Las cerradas o no reparadas anteriores al{' '}
                {diaCorto(historial.frontera)} no están cargadas.{' '}
                {historial.tope
                  ? 'Es el tope de carga de esta pantalla.'
                  : 'Para verlas, filtra por fecha en «Desde».'}
              </>
            )}
          </p>
        )}

      {/* Nunca un tope silencioso sobre lo ABIERTO: es lo accionable. */}
      {topeAbiertas && (
        <div
          className="banner"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
        >
          ⚠️ Hay más de{' '}
          {(TOPE_PAGINAS_ABIERTAS * PAGINA).toLocaleString('es-MX')} incidencias
          abiertas: se cargaron las más recientes y las más viejas no aparecen
          aquí. Avisa a sistemas.
        </div>
      )}

      {modo === 'bandeja' &&
        (alertasValidacion.vencidas > 0 || alertasValidacion.porVencer > 0) && (
          <div
            className="banner"
            style={{
              marginBottom: 12,
              borderColor:
                alertasValidacion.vencidas > 0 ? 'var(--hi)' : 'var(--warn)',
              color: alertasValidacion.vencidas > 0 ? '#ffb4b4' : 'var(--warn)',
            }}
          >
            ⏱ Validaciones: {alertasValidacion.vencidas > 0 && (
              <b>{alertasValidacion.vencidas} vencida{alertasValidacion.vencidas === 1 ? '' : 's'}</b>
            )}
            {alertasValidacion.vencidas > 0 && alertasValidacion.porVencer > 0 && ' · '}
            {alertasValidacion.porVencer > 0 && (
              <b>{alertasValidacion.porVencer} por vencer</b>
            )}
          </div>
        )}

      <div className="toolbar">
        <input
          className="search"
          placeholder="Buscar folio, sitio, campaña…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {/* Cada filtro dice QUÉ filtra en su primera opción: sin eso, tres
            selects que dicen "Todas / Todas / Todos" no se distinguen
            (pliego petitorio). El value se queda igual: es el que comparan
            los filtros. */}
        {/* Solo las unidades del usuario: a quien reporta únicamente en
            Ecovallas, ofrecerle Biobox solo produce filtros vacíos. */}
        <select value={fUN} onChange={(e) => setFUN(e.target.value)}>
          <option value="Todas">Unidad: todas</option>
          {misUnidades.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
        <select value={fArea} onChange={(e) => setFArea(e.target.value)}>
          <option value="Todas">Área: todas</option>
          {areasElegibles.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select value={fReporta} onChange={(e) => setFReporta(e.target.value)}>
          <option value="Todas">Reporta: todas</option>
          {areasReportantes.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select value={fEstado} onChange={(e) => setFEstado(e.target.value)}>
          <option value="Todos">Estatus: todos</option>
          {/* `reportado` sale del selector: es un estatus heredado que ya
              no produce el flujo (todo nace en `por_validar` o, con
              auto-ruteo, en `en_proceso`). Se queda en EST_LABEL porque
              hay filas viejas que aún lo traen y deben seguir mostrando
              su etiqueta; lo que se quita es la OPCIÓN de filtrar por él,
              que solo servía para devolver una lista vacía. */}
          {Object.entries(EST_LABEL)
            .filter(([k]) => k !== 'reportado')
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
        </select>
        {/* Rango de fechas de captura. Etiqueta VISIBLE y no solo `title`:
            los tooltips no existen en táctil, y en iOS un input date vacío
            no pinta placeholder — eran dos pastillas en blanco idénticas. */}
        <label className="filtro-fecha">
          <span>Desde</span>
          <input
            type="date"
            className="fecha"
            value={fDesde}
            max={fHasta || undefined}
            onChange={(e) => setFDesde(e.target.value)}
            title="Capturadas desde"
          />
        </label>
        <label className="filtro-fecha">
          <span>Hasta</span>
          <input
            type="date"
            className="fecha"
            value={fHasta}
            min={fDesde || undefined}
            onChange={(e) => setFHasta(e.target.value)}
            title="Capturadas hasta"
          />
        </label>
        {(fDesde || fHasta) && (
          <button
            className="btn ghost sm"
            onClick={() => {
              setFDesde('');
              setFHasta('');
            }}
            title="Quitar el filtro de fechas"
          >
            ✕ fechas
          </button>
        )}
        {modo === 'todas' && puedeVerTabla && (
          <button
            className="btn ghost sm"
            onClick={() =>
              setVista((v) => (v === 'tarjetas' ? 'tabla' : 'tarjetas'))
            }
            title="Cambiar entre tarjetas y tabla de trazabilidad"
          >
            {vista === 'tarjetas' ? '▦ Ver tabla' : '🗂 Ver tarjetas'}
          </button>
        )}
      </div>

      {visibles.length === 0 ? (
        <div className="empty">Sin incidencias para mostrar.</div>
      ) : modo === 'todas' && puedeVerTabla && vista === 'tabla' ? (
        <TablaIncidencias
          items={visibles}
          puedeExportar={puedeVerTabla}
        />
      ) : (
        <>
        <div className="inc-list">
          {visibles.slice(0, nPintadas).map((i) => (
            // El id y el envoltorio son lo que permite hacer scroll hasta la
            // tarjeta y resaltarla al llegar desde una notificación.
            <div
              key={i.record_id}
              id={'inc-' + i.record_id}
              style={
                resaltado === i.record_id
                  ? {
                      outline: '2px solid var(--accent)',
                      outlineOffset: 3,
                      borderRadius: 14,
                      transition: 'outline-color .3s',
                    }
                  : undefined
              }
            >
            <IncCard
              i={i}
              can={can}
              email={email}
              foto={fotoDe(i)}
              onEstatus={cambiarEstatus}
              onRepair={setRepairing}
              onEvidence={setEvidenceOf}
              onChat={(inc) => {
                setChatOf(inc);
                onChatLeido(inc.record_id);
              }}
              onReassign={(inc, mode) => setReassignOf({ inc, mode })}
              onCorregir={setCorrigiendo}
              onEdit={setEditOf}
              onRechazarRep={(inc) =>
                setMotivoOf({ inc, kind: 'rechazo_rep' })
              }
              onPrevalidar={prevalidar}
              onDescartar={(inc) => setMotivoOf({ inc, kind: 'descartar' })}
              slaMap={slaMap}
              slaValidacion={slaValidacion}
              nChat={chatCounts[i.record_id] || 0}
            />
            </div>
          ))}
        </div>
        {/* Nunca cortar en silencio: se dice cuántas hay y cuántas se ven. */}
        {visibles.length > nPintadas && (
          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              justifyContent: 'center',
              flexWrap: 'wrap',
              margin: '16px 0',
              color: 'var(--muted)',
              fontSize: 13,
            }}
          >
            <span>
              Mostrando {nPintadas.toLocaleString('es-MX')} de{' '}
              {visibles.length.toLocaleString('es-MX')}
            </span>
            <button
              className="btn ghost sm"
              onClick={() =>
                setPintado({ clave: clavePintado, n: nPintadas + PASO_PINTADO })
              }
            >
              Mostrar {Math.min(PASO_PINTADO, visibles.length - nPintadas)} más
            </button>
          </div>
        )}
        </>
      )}

      {/* --- Modales --- */}
      {(nuevaAbierta || presetNew) && (
        <NuevaInc
          preset={presetNew}
          unidades={misUnidades}
          esMKT={misDep.some((d) => d.trim().toUpperCase() === 'MKT')}
          onClose={() => {
            onCerrarNueva?.();
            setPresetNew(null);
          }}
          onSave={crear}
        />
      )}
      {repairing && (
        <RepararModal
          inc={repairing}
          email={email}
          onClose={() => setRepairing(null)}
          onSave={(p) => guardarReparacion(repairing, p)}
        />
      )}
      {chatOf && (
        <ChatModal
          inc={chatOf}
          email={email}
          nombre={nombre}
          onClose={() => {
            setChatOf(null);
            onRecargarNotifs();
          }}
        />
      )}
      {reassignOf && (
        <ReasignModal
          inc={reassignOf.inc}
          mode={reassignOf.mode}
          email={email}
          onClose={() => setReassignOf(null)}
          onDone={(rid, patch) => {
            patchInc(rid, patch);
            setReassignOf(null);
            onNotifAtendida(rid);
            setTimeout(onRecargarNotifs, 400);
          }}
        />
      )}
      {corrigiendo && (
        <CorreccionModal
          inc={corrigiendo}
          onClose={() => setCorrigiendo(null)}
          onDone={(rid, patch) => {
            patchInc(rid, patch);
            setCorrigiendo(null);
            setTimeout(onRecargarNotifs, 400);
          }}
        />
      )}
      {editOf && (
        <EditModal
          inc={editOf}
          onAbrirEvidencia={setEvidenceOf}
          onClose={() => setEditOf(null)}
          onDone={(rid, patch) => {
            patchInc(rid, patch);
            setEditOf(null);
            // Vuelve a `por_validar`: al validador le tiene que llegar.
            setTimeout(onRecargarNotifs, 400);
          }}
        />
      )}
      {/* LA EVIDENCIA VA HASTA EL FINAL A PROPÓSITO. Todos los modales usan
          la misma clase `.overlay` y por tanto el mismo z-index, así que
          manda el orden del DOM: el último se pinta encima. Como la galería
          se puede abrir DESDE la edición del reportante, tiene que quedar
          arriba — si se montara antes, se abriría por debajo y parecería que
          el botón no hizo nada. */}
      {evidenceOf && (
        <EvidenciaModal
          inc={evidenceOf}
          email={email}
          esValidador={has('validador')}
          esSoloViewer={esSoloViewer}
          onClose={() => setEvidenceOf(null)}
        />
      )}
      {motivoOf && (
        <MotivoModal
          titulo={
            motivoOf.kind === 'descartar'
              ? 'Descartar incidencia'
              : 'Rechazar reparación'
          }
          label={
            motivoOf.kind === 'descartar'
              ? 'Motivo (se regresa al reportante como no válida)'
              : 'Motivo del rechazo (regresa al área para volver a reparar)'
          }
          onClose={() => setMotivoOf(null)}
          onSubmit={(t) =>
            motivoOf.kind === 'descartar'
              ? descartarPrevalidacion(motivoOf.inc, t)
              : rechazarReparacion(motivoOf.inc, t)
          }
        />
      )}
    </>
  );
}

export default IncidenciasView;
