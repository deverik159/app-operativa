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
//
// Modo sin señal (24-sep-2026):
//   - Cada carga buena se guarda en el teléfono (lib/datosLocales.ts). Si
//     la primera no llega, se enseña esa copia con su fecha, no el error
//     crudo "incidencias: TypeError: Load failed".
//   - Validar, aprobar, rechazar, prevalidar, descartar y reparar pasan por
//     lib/acciones.ts: sin red quedan guardadas en el teléfono y se mandan
//     solas. Mientras tanto se SUPERPONEN a la lista (ver `superponer`)
//     para que la tarjeta no regrese a su estatus viejo tras un ↻.
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
  codigoCara,
} from '../../lib/helpers';
import { crearReporte } from '../../lib/crearReporte';
import {
  haySenal,
  guardarListaLocal,
  leerListaLocal,
} from '../../lib/datosLocales';
import type { ListaLocal } from '../../lib/datosLocales';
import { vigilarRender } from '../../lib/vigia';
import {
  accionesPendientes,
  descartarAccion,
  ejecutarAccion,
  suscribirAcciones,
} from '../../lib/acciones';
import type {
  AccionNueva,
  AccionPendiente,
  ClaseAccion,
  ResultadoAccion,
} from '../../lib/acciones';
import IncCard from '../../components/IncCard';
import NuevaInc from './NuevaInc';
import type { PresetNueva, GrupoReporte } from './NuevaInc';
import RepararModal from './RepararModal';
import type { DatosReparacion, FinReparacion } from './RepararModal';
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

// --- Modo sin señal (24-sep-2026) ---

/**
 * Topes de las lecturas de la lista. Ya hay copia en el teléfono de
 * respaldo, así que no se reintenta a ciegas (postgrest-js reintenta cada
 * GET 3 veces, ~7 s): una página de 1000 filas con mala señal cabe de sobra
 * en 25 s; más que eso es una conexión colgada.
 */
const TOPE_PAGINA_MS = 25000;
const TOPE_FOTOS_MS = 20000;
const TOPE_SLA_MS = 15000;
/** Primera carga lenta: a los 5 s se enseña la copia mientras sigue llegando. */
const ESPERA_COPIA_MS = 5000;
/**
 * Tope para esperar la copia de la lista del teléfono (app pasmada sin
 * señal, 24-sep-2026). Con IndexedDB colgada (iOS al suspender la PWA) una
 * lectura tarda hasta 15 s (el tope de la transacción) y la vista se
 * quedaba en "Cargando datos…" todo ese rato. La lectura sigue: si llega
 * después y aún no hay lista, se pone (ver usarCopia).
 */
const TOPE_COPIA_MS = 3000;
/**
 * Tope para saber si hay sesión: getSession espera a que se renueve el
 * token, y sin red eso son ~25 s.
 */
const TOPE_SESION_MS = 6000;
/**
 * Acción atendida en pantalla: su salida de la cola durante este lapso NO
 * recarga la lista (ya se reflejó con patchInc). Pasado el lapso, una
 * salida es de fondo (se mandó sola al volver la red) y sí recarga.
 */
const GRACIA_PRIMER_PLANO_MS = 8000;
const MENSAJE_EN_COLA =
  'Sin señal: quedó guardado en el teléfono y se enviará solo al volver la red.';

// --- Revisión sin señal (24-sep-2026) ---

/** Tope de la relectura de las filas de acciones que salieron solas de la cola. */
const TOPE_RELECTURA_MS = 12000;
/**
 * Separación mínima entre escrituras de la copia del teléfono. La copia es
 * la lista completa (1–2 MB, más si se amplió el historial) y cada escritura
 * la clona en el hilo principal: antes se reescribía 2 s después de cada
 * cambio (40 validaciones seguidas = 40 escrituras y tirones al desplazar).
 * Lo pendiente se escribe de inmediato al irse a segundo plano o al salir.
 */
const ESPACIO_COPIAS_MS = 30000;
/** Respiro para que React asiente lista y fotos antes de copiarlas. */
const MIN_ESPERA_COPIA_MS = 500;
/**
 * Reintentos de una página de la lista ante una falla PASAJERA (fetch que
 * se cae al cambiar de antena, 503 mientras PostgREST recarga su esquema,
 * 520 de Cloudflare). Solo cuando no hay nada que enseñar mientras (ni
 * lista en pantalla ni copia): con respaldo se enseña enseguida y el reloj
 * de abajo reintenta solo. Antes de `.retry(false)` postgrest-js los hacía
 * siempre (1, 2 y 4 s, ~7 s sin red).
 */
const ESPERAS_REINTENTO_MS = [1000, 2000];
/** Con la copia en pantalla y el teléfono "con red", se reintenta cada tanto. */
const INTERVALO_REINTENTO_MS = 45000;

/** Nombre de cada acción en los avisos de la vista. */
const NOMBRE_ACCION: Record<ClaseAccion, string> = {
  validar: 'La validación',
  aprobar_reparacion: 'La aprobación de la reparación',
  rechazar_reparacion: 'El rechazo de la reparación',
  prevalidar: 'La prevalidación',
  descartar_prevalidacion: 'El descarte',
  reparacion: 'La reparación',
};

/**
 * La acción se quedó en la cola con un error que NO es de red: no se
 * enviará sola (lib/acciones.ts la reintenta, pero da lo mismo). Viene en
 * AccionPendiente.conError (motor, revisión sin señal); se lee sin exigir
 * el campo para no depender de la versión del contrato.
 */
const conErrorDe = (p: AccionPendiente): boolean =>
  (p as AccionPendiente & { conError?: boolean }).conError === true;

/**
 * ¿La fila del servidor ya trae lo que la acción cambiaba? (estatus y
 * prevalidación: lo que decide qué botón sale y si la campana sobra.)
 */
const aplicadaEn = (p: AccionPendiente, fila: Incidencia): boolean =>
  (p.patch.estatus === undefined || fila.estatus === p.patch.estatus) &&
  (p.patch.prevalidada === undefined || fila.prevalidada === p.patch.prevalidada);

/**
 * ¿Falla pasajera que vale un reintento corto? Un tope vencido (conexión
 * colgada) NO: repetirlo sería otra espera larga.
 */
function esTransitoria(status: number, mensaje: string): boolean {
  if (status === 503 || status === 520) return true;
  return status === 0 && !/abort|timed? ?out|timeout/i.test(mensaje);
}

const dormir = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/** Lo que da `conTope` si la promesa no llegó a tiempo. */
const TARDA = Symbol('tarda');

/** `p` con tope: al vencer da TARDA; `p` sigue su curso (no se cancela). */
function conTope<T>(p: Promise<T>, ms: number): Promise<T | typeof TARDA> {
  return new Promise((res) => {
    const t = setTimeout(() => res(TARDA), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      () => {
        clearTimeout(t);
        res(TARDA);
      }
    );
  });
}

/**
 * AbortSignal con tope. AbortSignal.timeout no existe en Safari < 16: ahí
 * se arma a mano (mismo patrón que lib/envios.ts). Un abort regresa
 * status 0, que cuenta como falla de red.
 */
function tope(ms: number): AbortSignal {
  const AS = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof AS.timeout === 'function') return AS.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/**
 * ¿Hay sesión REAL? Al volver la red hay hasta ~60 s en que getSession da
 * null y las consultas salen como anónimo: la RLS contesta 200 con lista
 * VACÍA. Una carga así vaciaría la pantalla y, peor, la copia del teléfono.
 * Sin sesión (o si tarda más del tope) la carga cuenta como sin red.
 */
async function haySesionReal(): Promise<boolean> {
  try {
    const r = await Promise.race([
      sb.auth.getSession(),
      new Promise<null>((res) => setTimeout(() => res(null), TOPE_SESION_MS)),
    ]);
    return !!r?.data.session;
  } catch {
    return false;
  }
}

/** Mensajes de fetch sin red (Chrome, Safari, WebViews); como lib/envios.ts. */
const RE_RED =
  /failed to fetch|load failed|networkerror|network request failed|network connection was lost|internet connection appears to be offline|timed? ?out|timeout|aborterror|operation was aborted|fetcherror|err_network|err_internet_disconnected/i;

/**
 * ¿La consulta falló por red? Sin status (fetch no llegó o se cortó por
 * tope), status transitorio (sesión por renovar, gateway caído) o mensaje
 * de fetch sin red.
 */
function esFallaRed(status: number, mensaje: string): boolean {
  if (!status || status >= 500 || [401, 408, 425, 429].includes(status))
    return true;
  return RE_RED.test(mensaje);
}

/** "dd/mm hh:mm" en hora del teléfono, para decir de cuándo es la copia. */
function fechaHoraCorta(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(d.getDate())}/${dos(d.getMonth() + 1)} ${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

/**
 * Lista + acciones que siguen en el teléfono. Sin esto, un ↻ (o cualquier
 * recarga) traía la versión del servidor —que aún no tiene la acción— y la
 * tarjeta validada o reparada "regresaba" a su estatus viejo con el botón
 * otra vez a la mano. Se aplican en orden de creación. El rechazo de
 * reparación también suma el contador que en la base suma el trigger
 * inc_cuenta_rechazo (solo si la fila todavía está en 'reparado').
 */
function superponer(
  items: Incidencia[],
  acciones: AccionPendiente[]
): Incidencia[] {
  if (!acciones.length) return items;
  const porId = new Map<string, AccionPendiente[]>();
  for (const a of acciones) {
    const l = porId.get(a.record_id);
    if (l) l.push(a);
    else porId.set(a.record_id, [a]);
  }
  return items.map((i) => {
    const lista = porId.get(i.record_id);
    if (!lista) return i;
    let r = i;
    for (const a of lista) {
      const cuenta =
        a.clase === 'rechazar_reparacion' && r.estatus === 'reparado'
          ? { rechazos_reparacion: (r.rechazos_reparacion || 0) + 1 }
          : {};
      r = { ...r, ...a.patch, ...cuenta };
    }
    return r;
  });
}

/** Texto corto de la acción para la cola: "Validar EV00012 · MX_CM_EV_3299". */
function resumenDe(verbo: string, i: Incidencia): string {
  const donde = i.clave_sitio || i.clave_medio || '';
  return `${verbo} ${i.folio || '(sin folio)'}${donde ? ' · ' + donde : ''}`;
}

type ResultadoPaginado = {
  filas: Incidencia[];
  error: string | null;
  /** HTTP de la respuesta que falló (0 = no llegó). */
  status: number;
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
 *
 * `reintentar` (revisión sin señal, 24-sep-2026) decide, ante una página
 * fallida, si se vuelve a pedir ESA página (y espera lo que toque); sin él,
 * la primera falla termina la carga.
 */
async function traerPaginado(
  pagina: (
    desde: number,
    hasta: number
  ) => PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
    status?: number;
  }>,
  topePaginas: number,
  vigente: () => boolean,
  reintentar?: (status: number, mensaje: string, intento: number) => Promise<boolean>
): Promise<ResultadoPaginado> {
  let filas: Incidencia[] = [];
  for (let n = 0; n < topePaginas; n++) {
    const desde = n * PAGINA;
    let intento = 0;
    let r = await pagina(desde, desde + PAGINA - 1);
    while (
      r.error &&
      reintentar &&
      vigente() &&
      (await reintentar(r.status ?? 0, r.error.message, intento++))
    )
      r = await pagina(desde, desde + PAGINA - 1);
    const { data, error, status } = r;
    if (error)
      return { filas, error: error.message, status: status ?? 0, topado: false };
    const lote = (data as Incidencia[] | null) || [];
    filas = filas.concat(lote);
    if (lote.length < PAGINA || !vigente())
      return { filas, error: null, status: status ?? 200, topado: false };
  }
  return { filas, error: null, status: 200, topado: true };
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
        // Con tope (modo sin señal, 24-sep-2026): con la conexión colgada,
        // la copia de la lista no se guardaba nunca (se guarda al terminar
        // las fotos).
        const { data, error } = await sb
          .rpc('fotos_tarjetas', { p_ids: lote })
          .abortSignal(tope(TOPE_FOTOS_MS));
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
    .limit(3000)
    .retry(false)
    .abortSignal(tope(TOPE_FOTOS_MS));
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
  // Un ciclo de renders que no suelta el hilo acaba en el ErrorBoundary del
  // módulo y no en la app congelada (app pasmada sin señal, 24-sep-2026;
  // ver lib/vigia.ts). Primera línea, antes de los hooks.
  vigilarRender('IncidenciasView');
  /**
   * Lo que dijo el servidor (o la copia del teléfono), más lo que el
   * usuario ya aplicó con éxito. Las acciones que siguen en la cola NO van
   * aquí: se superponen en `itemsVista` (ver `superponer`).
   */
  const [items, setItems] = useState<Incidencia[]>([]);
  // Para guardar la copia con la lista YA fusionada (la de pantalla).
  const itemsRef = useRef(items);
  itemsRef.current = items;
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
  const fotosRef = useRef(fotos);
  fotosRef.current = fotos;

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
  // Para la copia del teléfono: el SLA vigente y si llegó del servidor.
  const slaRef = useRef({ map: slaMap, val: slaValidacion });
  slaRef.current = { map: slaMap, val: slaValidacion };
  const slaLlego = useRef(false);

  /**
   * La lista en pantalla NO es fresca (modo sin señal, 24-sep-2026):
   *   desde — cuándo se guardó lo que se ve (null = no hay copia)
   *   lenta — la primera carga sigue en camino y, mientras, se ve la copia
   *   error — no fue la red sino otro error (el recuadro rojo lo dice)
   *   conSenal — el teléfono dice tener red (revisión sin señal,
   *              24-sep-2026): la falla fue del servidor o pasajera, y el
   *              aviso no dice "Sin señal" en falso
   * null = la lista es la del servidor.
   */
  const [sinRed, setSinRed] = useState<{
    desde: string | null;
    lenta: boolean;
    error: boolean;
    conSenal: boolean;
  } | null>(null);
  const sinRedRef = useRef(sinRed);
  sinRedRef.current = sinRed;
  /**
   * Cuándo se obtuvo la lista en pantalla (servidor o copia). Es también la
   * fecha con la que se escribe la copia (revisión sin señal, 24-sep-2026):
   * lo que se ve es de entonces más lo aplicado después. Antes una bandera
   * `listaFresca` solo dejaba escribir tras una carga buena y lo aplicado
   * sobre la copia se perdía (U3). Nunca hay datos pedidos sin sesión: esa
   * carga cae a la copia.
   */
  const listaDe = useRef<string | null>(null);
  /** Hay una carga en camino (los reintentos automáticos no la duplican). */
  const cargandoRef = useRef(false);
  /**
   * Llegó un reintento automático (online, al frente, sesión renovada)
   * mientras corría una carga: no se duplica, pero tampoco se pierde. Si esa
   * carga no trajo la lista del servidor, se repite al terminar (app pasmada
   * sin señal, 24-sep-2026): la señal que volvía a media lectura de la copia
   * esperaba al reloj de 45 s.
   */
  const intentoPendiente = useRef(false);

  /**
   * Acciones de este usuario que siguen en el teléfono (lib/acciones.ts) y
   * las que acaban de salir de la cola en segundo plano (`pegadas`): éstas
   * se siguen superponiendo hasta que termine la recarga que las refleja,
   * para que la tarjeta no parpadee a su estatus viejo.
   */
  const [pendientes, setPendientes] = useState<AccionPendiente[]>([]);
  const pendientesRef = useRef<AccionPendiente[]>([]);
  const [pegadas, setPegadas] = useState<AccionPendiente[]>([]);
  const pegadasRef = useRef<AccionPendiente[]>([]);
  /** Tarjetas con una acción mandándose ahora (candado de doble toque). */
  const [ocupadas, setOcupadas] = useState<Set<string>>(() => new Set());
  const ocupadasRef = useRef<Set<string>>(new Set());
  /** record_id → hasta cuándo su salida de la cola es "de primer plano". */
  const primerPlanoHasta = useRef(new Map<string, number>());
  const recargaTrasCola = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  /** La campana, en ref: las vueltas de la cola la usan sin re-suscribirse. */
  const avisosCampana = useRef({ onNotifAtendida, onRecargarNotifs });
  avisosCampana.current = { onNotifAtendida, onRecargarNotifs };

  /**
   * La copia del teléfono (revisión sin señal, 24-sep-2026). Se escribe
   * SOLO tras una carga buena del servidor o un cambio de fila (acción
   * aplicada, edición, alta), con ESPACIO_COPIAS_MS entre escrituras, y lo
   * pendiente de inmediato al irse a segundo plano o al salir de la vista.
   * Antes: 2 s después de CUALQUIER cambio de lista, fotos o SLA (X5), y
   * nunca mientras la lista en pantalla fuera la copia o una recarga
   * fallida: lo que se validaba o reparaba en ese estado no entraba a la
   * copia y, al volver a montar la vista sin señal, la tarjeta regresaba a
   * su estatus viejo con el botón a la mano (U3: conflicto falso y fotos
   * duplicadas al repetir).
   *
   * Se escribe la lista de pantalla (con las acciones que acaban de salir
   * solas de la cola encima, `pegadas`) con la fecha de LO QUE SE VE
   * (`listaDe`): la de la carga buena, o la de la copia si de ahí salió. Así
   * una copia vieja con una fila corregida no se hace pasar por nueva
   * (guardarListaLocal respeta `guardado`; sin él pone la de ahora).
   */
  const ultimaCopia = useRef(0);
  const relojCopia = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cadenaCopia = useRef<Promise<void>>(Promise.resolve());
  /**
   * Desmontada, no se programa nada: una relectura que llega tarde no debe
   * reescribir la copia después de Salir (App la borra a los 2 s).
   */
  const montada = useRef(true);
  useEffect(() => {
    // Otra vez en true: StrictMode (dev) desmonta y vuelve a montar.
    montada.current = true;
    return () => {
      montada.current = false;
    };
  }, []);
  const escribirCopia = useCallback((): Promise<void> => {
    clearTimeout(relojCopia.current);
    relojCopia.current = undefined;
    // Una a la vez: dos escrituras cruzadas podían dejar la más vieja.
    cadenaCopia.current = cadenaCopia.current
      .then(async () => {
        const desde = listaDe.current;
        // Sin lista que guardar todavía (ni del servidor ni copia).
        if (desde === null) return;
        ultimaCopia.current = Date.now();
        const lista: ListaLocal = {
          // '' = copia de una versión anterior sin fecha.
          guardado: desde || new Date().toISOString(),
          items: superponer(itemsRef.current, pegadasRef.current),
          fotos: fotosRef.current,
          slaMap: slaRef.current.map,
          slaValidacion: slaRef.current.val,
        };
        await guardarListaLocal(email, lista);
      })
      .catch(() => {
        /* sin copia: la siguiente lo vuelve a intentar */
      });
    return cadenaCopia.current;
  }, [email]);
  const pedirCopia = useCallback(() => {
    if (!montada.current) return;
    // Ya hay una programada: esa lleva lo de ahora (lee los refs al correr).
    if (relojCopia.current !== undefined) return;
    const espera = Math.max(
      MIN_ESPERA_COPIA_MS,
      ultimaCopia.current + ESPACIO_COPIAS_MS - Date.now()
    );
    relojCopia.current = setTimeout(() => void escribirCopia(), espera);
  }, [escribirCopia]);
  useEffect(() => {
    const volcar = () => {
      if (relojCopia.current !== undefined) void escribirCopia();
    };
    const alOcultar = () => {
      if (document.visibilityState === 'hidden') volcar();
    };
    document.addEventListener('visibilitychange', alOcultar);
    window.addEventListener('pagehide', volcar);
    return () => {
      document.removeEventListener('visibilitychange', alOcultar);
      window.removeEventListener('pagehide', volcar);
      // Al salir de la vista (otro módulo, Salir) se escribe lo pendiente.
      volcar();
    };
  }, [escribirCopia]);

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

  /**
   * Número de APERTURA de cada modal que guarda (revisión del blindaje,
   * 24-sep-2026). Ahora se puede cerrar un modal mientras su guardado sigue
   * (Cancelar ya no se apaga si la red se atora); si el usuario abre otro
   * del mismo tipo y el primero termina después, su "cerrar al terminar"
   * cerraba el NUEVO y se perdía lo capturado ahí (EditModal no tiene
   * borrador). Cada guardado recuerda la apertura en que empezó y solo
   * cierra si sigue siendo la misma. Se cuenta en el render (no en un
   * efecto) para que el onDone de ESTE render ya lleve el número correcto;
   * en el doble render de StrictMode el segundo ve el mismo valor y no suma.
   */
  const aperturas = useRef({ alta: 0, rep: 0, edit: 0 });
  const vistoAbierto = useRef<{
    alta: boolean;
    rep: Incidencia | null;
    edit: Incidencia | null;
  }>({ alta: false, rep: null, edit: null });
  {
    const altaAbierta = !!(nuevaAbierta || presetNew);
    const v = vistoAbierto.current;
    if (altaAbierta !== v.alta) {
      v.alta = altaAbierta;
      if (altaAbierta) aperturas.current.alta++;
    }
    if (repairing !== v.rep) {
      v.rep = repairing;
      if (repairing) aperturas.current.rep++;
    }
    if (editOf !== v.edit) {
      v.edit = editOf;
      if (editOf) aperturas.current.edit++;
    }
  }
  const aperturaEdit = aperturas.current.edit;

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
  // useMemo: va a cada tarjeta, y un objeto nuevo en cada render las
  // repintaba todas aunque nada suyo cambiara (ver React.memo en IncCard).
  const can: CanInc = useMemo(
    () => ({
      crear: has('reportante'),
      validar: has('validador'),
      reparar: has('reparacion'),
      reparaEn,
      reasignar: has('reparacion'),
      aprobarReasign: has('validador'),
    }),
    [has, reparaEn]
  );

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
   * La lectura de la copia de la lista, COMPARTIDA mientras va en curso (app
   * pasmada sin señal, 24-sep-2026). Antes cada ↻ subía cargaSeq, tiraba la
   * lectura que iba en camino y abría otra espera de hasta 15 s. Ahora quien
   * llega se une a la misma lectura y al mismo tope, contado desde la
   * primera: ↻ ya no reinicia nada.
   *   lectura — la lectura completa, sin tope (nunca rechaza)
   *   espera  — la misma con TOPE_COPIA_MS: TARDA si no llegó a tiempo
   */
  const lecturaCopia = useRef<{
    lectura: Promise<ListaLocal | null>;
    espera: Promise<ListaLocal | null | typeof TARDA>;
  } | null>(null);
  const leerCopia = useCallback(() => {
    const enCurso = lecturaCopia.current;
    if (enCurso) return enCurso;
    const lectura = leerListaLocal(email).catch(() => null);
    const nueva = { lectura, espera: conTope(lectura, TOPE_COPIA_MS) };
    lecturaCopia.current = nueva;
    void lectura.then(() => {
      if (lecturaCopia.current === nueva) lecturaCopia.current = null;
    });
    return nueva;
  }, [email]);

  /**
   * La copia del teléfono, cuando la red no alcanza (modo sin señal,
   * 24-sep-2026). Solo SUSTITUYE la lista si todavía no hay ninguna en
   * pantalla: en una recarga fallida se conserva la de pantalla y solo
   * cambia el aviso.
   *   'lenta'  — la primera carga sigue en camino: se enseña la copia
   *              mientras (si no hay copia, se sigue en "Cargando…").
   *   'sinRed' — no hubo red (o no hubo sesión real): se queda la copia.
   *   'error'  — error que NO es de red: la copia, con el error a la vista.
   */
  const usarCopia = useCallback(
    async (miCarga: number, motivo: 'lenta' | 'sinRed' | 'error') => {
      if (miCarga !== cargaSeq.current) return;
      const lenta = motivo === 'lenta';
      let puso = false;
      // Se busca la copia mientras no haya lista en pantalla (ni del
      // servidor ni de la copia). Antes lo decidía `yaCargo`: si la primera
      // lectura no la encontraba, ya no se volvía a buscar hasta remontar la
      // vista (app pasmada sin señal, 24-sep-2026).
      if (listaDe.current === null) {
        const { lectura, espera } = leerCopia();
        const leida = await espera;
        if (miCarga !== cargaSeq.current) return;
        // No llegó a tiempo: se deja la pantalla sin copia (en vez de
        // "Cargando datos…") y, si llega después y sigue sin haber lista,
        // una carga normal la pone (de memoria, ya sin espera).
        if (leida === TARDA)
          void lectura.then((tarde) => {
            if (tarde && listaDe.current === null && montada.current && !cargandoRef.current)
              void cargarRef.current();
          });
        const copia = leida === TARDA ? null : leida;
        if (listaDe.current === null) {
          if (lenta && !copia) return;
          if (copia) {
            // Lo que ya esté en pantalla va primero y no se pierde: el alta
            // se pinta desde "Cargando datos…" y su fila puede llegar antes
            // que la copia (ver crear).
            setItems((prev) => {
              const deCopia = copia.items || [];
              if (!prev.length) return deCopia;
              const ids = new Set(prev.map((i) => i.record_id));
              return [...prev, ...deCopia.filter((i) => !ids.has(i.record_id))];
            });
            if (copia.fotos) setFotos(copia.fotos);
            // SLA de la copia si el servidor no lo ha dado.
            if (!slaLlego.current) {
              if (copia.slaMap) setSlaMap(copia.slaMap);
              if (copia.slaValidacion) setSlaValidacion(copia.slaValidacion);
            }
            // Lo de pantalla ya no es del servidor: si se vuelve a guardar
            // (una acción aplicada), va con SU fecha, no la de ahora.
            listaDe.current = copia.guardado;
            puso = true;
          }
          yaCargo.current = true;
          setLoading(false);
        } else if (lenta) return; // la red llegó mientras se leía la copia
      } else if (lenta) return;
      // Error que no es de red en una recarga: basta el recuadro del error;
      // la lista de pantalla no cambió.
      if (motivo === 'error' && !puso) {
        setRecargando(false);
        return;
      }
      setRecargando(lenta);
      // Mismo aviso que el de pantalla: se conserva el objeto (regla del
      // 24-sep-2026: un setState tras una lectura local compara antes).
      const aviso = {
        desde: listaDe.current,
        lenta,
        error: motivo === 'error',
        conSenal: haySenal(),
      };
      setSinRed((prev) =>
        prev &&
        prev.desde === aviso.desde &&
        prev.lenta === aviso.lenta &&
        prev.error === aviso.error &&
        prev.conSenal === aviso.conSenal
          ? prev
          : aviso
      );
    },
    [leerCopia]
  );

  /**
   * SLA por área y de validación. Si no llegan (sin señal), se toman de la
   * copia del teléfono; se vuelven a pedir tras la siguiente carga buena.
   */
  const slaEnCamino = useRef(false);
  const cargarSla = useCallback(async () => {
    if (slaLlego.current || slaEnCamino.current) return;
    slaEnCamino.current = true;
    try {
      if (haySenal() && (await haySesionReal())) {
        // slaMap: horas de SLA por área, en minúsculas (así lo espera IncCard).
        const [r1, r2] = await Promise.all([
          sb
            .from('sla_areas')
            .select('area,sla_horas')
            .retry(false)
            .abortSignal(tope(TOPE_SLA_MS)),
          sb
            .from('sla_validacion')
            .select('etapa,minutos')
            .retry(false)
            .abortSignal(tope(TOPE_SLA_MS)),
        ]);
        if (!r1.error && !r2.error) {
          const m: SlaMap = {};
          ((r1.data as SlaArea[]) || []).forEach((r) => {
            if (r.area) {
              const h = slaHoras(r.sla_horas);
              if (h) m[r.area.trim().toLowerCase()] = h;
            }
          });
          setSlaMap(m);
          const siguiente: { reporte: number; reparacion: number } = {
            ...SLA_VALIDACION_DEFAULT,
          };
          ((r2.data as SlaValidacion[]) || []).forEach((s) => {
            if (
              (s.etapa === 'reporte' || s.etapa === 'reparacion') &&
              Number.isFinite(Number(s.minutos)) &&
              Number(s.minutos) > 0
            )
              siguiente[s.etapa] = Number(s.minutos);
          });
          setSlaValidacion(siguiente);
          slaLlego.current = true;
          // Si ya hay lista, la copia se lleva el SLA bueno (revisión sin
          // señal: la copia ya no se reescribe en cada cambio de estado).
          if (listaDe.current) pedirCopia();
          return;
        }
      }
      // La misma lectura (y el mismo tope) que la lista: con IndexedDB
      // colgada esto tenía tomado slaEnCamino hasta 15 s.
      const copia = await leerCopia().espera;
      if (copia && copia !== TARDA && !slaLlego.current) {
        if (copia.slaMap) setSlaMap(copia.slaMap);
        if (copia.slaValidacion) setSlaValidacion(copia.slaValidacion);
      }
    } finally {
      slaEnCamino.current = false;
    }
  }, [email, pedirCopia, leerCopia]);

  /**
   * Acciones pendientes del teléfono → estado. Si alguna SALIÓ de la cola en
   * segundo plano (se mandó sola al volver la red, chocó con otra persona o
   * se descartó), se queda superpuesta ("pegada") y se relee su fila para
   * traer lo que de verdad quedó en el servidor (ver confirmarSalidas). Las
   * que se atendieron en pantalla no: ya se reflejaron con patchInc.
   */
  const cargarRef = useRef<() => Promise<void>>(async () => {});
  /** Suelta pegadas: su efecto ya está en `items` (o nunca se aplicó). */
  const soltarPegadas = useCallback((ids: Set<string>) => {
    if (!ids.size) return;
    setPegadas((prev) => {
      const sig = prev.filter((p) => !ids.has(p.id));
      pegadasRef.current = sig;
      return sig;
    });
  }, []);

  /**
   * Acciones que salieron SOLAS de la cola (revisión sin señal,
   * 24-sep-2026): se releen SUS filas (una consulta chica) y se ponen en
   * `items`. Antes solo quedaban "pegadas" hasta una recarga completa (1000
   * filas con '*'); si esa recarga fallaba con señal débil —el PATCH chico
   * sí llegó— se soltaban igual y la tarjeta regresaba a su estatus viejo
   * con el botón otra vez (U2): repetir daba un conflicto falso y, en una
   * reparación, fotos duplicadas. La relectura también resuelve bien las que
   * salieron por conflicto o descarte: trae lo que de verdad hay.
   * Si la relectura no se puede, se recurre a la recarga completa, y las
   * pegadas ya NO se sueltan en una carga fallida: solo en una buena.
   * También se apaga la campana de las que sí quedaron aplicadas (U9, parte
   * de la vista): el 'enCola' la apagó sin red y su UPDATE no llegó.
   */
  const confirmarSalidas = useCallback(
    async (salidas: AccionPendiente[]) => {
      const rids = [...new Set(salidas.map((p) => p.record_id))];
      let filas: Incidencia[] | null = null;
      if (haySenal() && (await haySesionReal())) {
        const { data, error } = await sb
          .from('incidencias')
          .select('*')
          .in('record_id', rids)
          .retry(false)
          .abortSignal(tope(TOPE_RELECTURA_MS));
        if (!error) filas = (data as Incidencia[] | null) || [];
      }
      if (!filas) {
        clearTimeout(recargaTrasCola.current);
        recargaTrasCola.current = setTimeout(() => void cargarRef.current(), 800);
        return;
      }
      const porId = new Map(filas.map((f) => [f.record_id, f]));
      filas.forEach((f) => tocadasEnCarga.current?.add(f.record_id));
      if (filas.length)
        setItems((prev) => prev.map((i) => porId.get(i.record_id) ?? i));
      // Sin fila (la RLS ya no la deja ver): la siguiente carga la quita.
      soltarPegadas(new Set(salidas.map((p) => p.id)));
      pedirCopia();
      const aplicadas = salidas.filter((p) => {
        const f = porId.get(p.record_id);
        return !!f && aplicadaEn(p, f);
      });
      if (aplicadas.length) {
        [...new Set(aplicadas.map((p) => p.record_id))].forEach((rid) =>
          avisosCampana.current.onNotifAtendida(rid)
        );
        setTimeout(() => avisosCampana.current.onRecargarNotifs(), 400);
      }
    },
    [soltarPegadas, pedirCopia]
  );

  const refrescarPendientes = useCallback(async (): Promise<
    AccionPendiente[]
  > => {
    let lista: AccionPendiente[];
    try {
      lista = await accionesPendientes(email);
    } catch {
      return pendientesRef.current;
    }
    const antes = pendientesRef.current;
    // La misma cola que la de pantalla no pide render (regla del 24-sep-2026:
    // un setState tras una lectura local compara antes). accionesPendientes
    // arma objetos nuevos en cada lectura y esto corre con CADA cambio de la
    // cola: sin comparar, cada vuelta rehacía itemsVista, la bandeja y las
    // tarjetas con la cola igual. Son pocas filas y todas serializables.
    if (JSON.stringify(lista) === JSON.stringify(antes)) return antes;
    pendientesRef.current = lista;
    setPendientes(lista);
    const siguen = new Set(lista.map((p) => p.id));
    const ahora = Date.now();
    const salieron = antes.filter(
      (p) =>
        !siguen.has(p.id) &&
        !ocupadasRef.current.has(p.record_id) &&
        (primerPlanoHasta.current.get(p.record_id) ?? 0) < ahora
    );
    if (salieron.length) {
      // Se quedan superpuestas mientras se confirma. No las que tenían
      // error (nunca se superpusieron: repintarlas mentiría si se
      // descartaron) ni sin señal: sin red nada pudo haberse enviado, así
      // que salieron por descarte y la tarjeta vuelve a lo que es.
      const fijar = haySenal() ? salieron.filter((p) => !conErrorDe(p)) : [];
      if (fijar.length) {
        setPegadas((prev) => {
          const sig = [...prev, ...fijar];
          pegadasRef.current = sig;
          return sig;
        });
        pedirCopia();
      }
      void confirmarSalidas(salieron);
    }
    return lista;
  }, [email, confirmarSalidas, pedirCopia]);

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
   *
   * Sin señal (modo sin señal, 24-sep-2026): sin red o sin sesión REAL no
   * se pide nada (una lectura como anónimo da lista vacía SIN error) y se
   * usa la copia del teléfono (`usarCopia`). Cada carga buena reescribe esa
   * copia al terminar las fotos. Las páginas van sin reintentos y con tope:
   * el respaldo ya es la copia.
   */
  const cargar = useCallback(async () => {
    const miCarga = ++cargaSeq.current;
    // Esta carga ya trae lo que pedía una recarga "tras la cola" pendiente
    // (p. ej. el aviso global recargó primero al terminar su vuelta).
    clearTimeout(recargaTrasCola.current);
    const tocadas = new Set<string>();
    tocadasEnCarga.current = tocadas;
    cargandoRef.current = true;
    const primera = !yaCargo.current;
    if (primera) setLoading(true);
    else setRecargando(true);
    setErr('');
    const vigente = () => miCarga === cargaSeq.current;
    const desdeHist = desdeHistorial.current;
    desdePedido.current = desdeHist;
    // Las pegadas de ANTES de esta carga quedan reflejadas al terminarla.
    const pegadasAlEmpezar = new Set(pegadasRef.current.map((p) => p.id));
    // Primera carga lenta: a los pocos segundos, la copia mientras llega.
    const espera = primera
      ? setTimeout(() => void usarCopia(miCarga, 'lenta'), ESPERA_COPIA_MS)
      : undefined;
    // Falla pasajera de una página SIN nada que enseñar mientras (ni lista
    // en pantalla ni copia): un par de reintentos cortos, como los que hacía
    // postgrest-js antes de `.retry(false)`. Con respaldo, o sin señal, no se
    // espera: se enseña enseguida y los disparadores (y el reloj) reintentan
    // (revisión sin señal, 24-sep-2026).
    const reintentar = async (status: number, mensaje: string, intento: number) => {
      if (intento >= ESPERAS_REINTENTO_MS.length) return false;
      if (!haySenal() || !esTransitoria(status, mensaje)) return false;
      if (yaCargo.current) return false;
      // Compartida y con tope (ver leerCopia): TARDA cuenta como "sin copia".
      const copia = await leerCopia().espera;
      if (copia && copia !== TARDA) return false;
      await dormir(ESPERAS_REINTENTO_MS[intento]);
      return vigente() && haySenal();
    };
    /** Trajo la lista del servidor (ver intentoPendiente, en el finally). */
    let buena = false;
    try {
      if (!haySenal() || !(await haySesionReal())) {
        if (!vigente()) return;
        desdePedido.current = null;
        // Las pegadas NO se sueltan aquí (U2): sin red ni sesión no se sabe
        // qué quedó; se quedan hasta una carga (o relectura) buena.
        await usarCopia(miCarga, 'sinRed');
        return;
      }
      const [abiertas, terminales] = await Promise.all([
        traerPaginado(
          (desde, hasta) =>
            sb
              .from('incidencias')
              .select('*')
              .not('estatus', 'in', TERMINALES_LISTA)
              .order('fecha_reporte', { ascending: false })
              .order('record_id', { ascending: true })
              .range(desde, hasta)
              .retry(false)
              .abortSignal(tope(TOPE_PAGINA_MS)),
          TOPE_PAGINAS_ABIERTAS,
          vigente,
          reintentar
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
              .range(desde, hasta)
              .retry(false)
              .abortSignal(tope(TOPE_PAGINA_MS));
          },
          // Sin fecha pedida: UNA página (las 1000 más recientes). "Topado"
          // con una sola página = vino llena = el historial está recortado.
          desdeHist ? TOPE_PAGINAS_HISTORIAL : 1,
          vigente,
          reintentar
        ),
      ]);
      // Una carga más nueva ya está en camino: esta respuesta es vieja.
      if (!vigente()) return;
      tocadasEnCarga.current = null;
      // Con error (mala señal) se CONSERVA la lista anterior —y sus fotos—:
      // vaciarla hacía desaparecer el trabajo de la pantalla justo cuando no
      // hay red para volver a traerlo. Si es la primera carga, la copia del
      // teléfono (y el aviso dice de cuándo es, no "TypeError: Load failed").
      const fallo = abiertas.error ? abiertas : terminales.error ? terminales : null;
      if (fallo) {
        // De esa fecha no llegó nada: ya no "va en camino". Sin esto, tras un
        // fallo, poner la misma fecha o una más reciente no volvía a pedirla
        // (el efecto de "Desde" la daba por pedida) y solo ↻ la traía
        // (revisión primer mes, 24-sep-2026).
        desdePedido.current = null;
        // Las pegadas NO se sueltan en una carga fallida (U2): la tarjeta
        // volvía a su estatus viejo aunque la acción sí hubiera llegado.
        const deRed = esFallaRed(fallo.status, fallo.error || '');
        if (!deRed) setErr('incidencias: ' + fallo.error);
        await usarCopia(miCarga, deRed ? 'sinRed' : 'error');
        // Pasado el primer intento —bien o mal— ninguna recarga vuelve a
        // poner la pantalla en "Cargando…" (desmontaría los modales).
        if (vigente()) {
          yaCargo.current = true;
          setLoading(false);
          setRecargando(false);
        }
        return;
      }
      buena = true;
      yaCargo.current = true;
      setLoading(false);
      setRecargando(false);
      setSinRed(null);
      // Carga BUENA con sesión real: la copia que se escriba lleva esta fecha.
      listaDe.current = new Date().toISOString();
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
      soltarPegadas(pegadasAlEmpezar);
      // Carga buena: la copia del teléfono la recibe ya (sin esperar a las
      // fotos, que pueden tardar) y otra vez con las fotos, con la
      // separación mínima entre las dos (ver pedirCopia).
      pedirCopia();
      // Las acciones que siguen en el teléfono se vuelven a superponer, y el
      // SLA se pide otra vez si al abrir no llegó.
      void refrescarPendientes();
      if (!slaLlego.current) void cargarSla();

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
          .limit(500)
          .retry(false)
          .abortSignal(tope(TOPE_FOTOS_MS)),
      ]);
      if (!vigente()) return;
      // Si fallaron (mala señal), las tarjetas conservan las fotos que ya
      // tenían: mapas vacíos las dejaban a todas sin foto.
      if (mapas && !errReas) {
        const mReasign: Record<string, string> = {};
        ((reasEv as { record_id: string; evidencia: string }[]) || []).forEach(
          (r) => {
            if (!mReasign[r.record_id]) mReasign[r.record_id] = r.evidencia;
          }
        );
        setFotos({
          reporte: mapas.reporte,
          reparacion: mapas.reparacion,
          reasign: mReasign,
        });
        pedirCopia();
      }
    } finally {
      clearTimeout(espera);
      if (vigente()) {
        cargandoRef.current = false;
        tocadasEnCarga.current = null;
        if (intentoPendiente.current) {
          intentoPendiente.current = false;
          // Fuera de esta vuelta: que primero se asiente lo de esta carga.
          if (!buena && haySenal())
            setTimeout(() => {
              if (montada.current && !cargandoRef.current) void cargarRef.current();
            }, 0);
        }
      }
    }
  }, [email, usarCopia, cargarSla, refrescarPendientes, soltarPegadas, pedirCopia, leerCopia]);
  cargarRef.current = cargar;

  useEffect(() => {
    cargar();
    void cargarSla();
  }, [cargar, cargarSla]);

  /**
   * Con la lista de la copia en pantalla, se reintenta sola cuando vuelve la
   * señal, cuando la app regresa a primer plano y cuando se renueva la sesión
   * (al volver la red hay hasta ~60 s sin sesión real: la carga que cae ahí
   * se queda en la copia y la trae el TOKEN_REFRESHED). Sin esto, la copia
   * se quedaba hasta tocar ↻ (modo sin señal, 24-sep-2026).
   */
  useEffect(() => {
    const intentar = () => {
      // También si la PRIMERA carga no terminó (app pasmada sin señal,
      // 24-sep-2026): ahí sinRed sigue en null y 'online' no hacía nada.
      if (!(sinRedRef.current || !yaCargo.current) || !haySenal()) return;
      // Con una en camino, se repite al terminar ella (ver intentoPendiente).
      if (cargandoRef.current) {
        intentoPendiente.current = true;
        return;
      }
      void cargar();
    };
    const alVisible = () => {
      if (document.visibilityState === 'visible') intentar();
    };
    window.addEventListener('online', intentar);
    document.addEventListener('visibilitychange', alVisible);
    // Sin await dentro del aviso de auth: auth-js lo llama con su candado
    // tomado y una consulta ahí adentro se puede trabar.
    const { data } = sb.auth.onAuthStateChange((evento, sesion) => {
      if (sesion && (evento === 'TOKEN_REFRESHED' || evento === 'SIGNED_IN'))
        setTimeout(intentar, 0);
    });
    // Una falla pasajera CON señal (503 al recargar el esquema, antena que
    // cambia) no dispara 'online': sin reloj, la lista vieja se quedaba hasta
    // tocar ↻ (revisión sin señal, 24-sep-2026). Solo a la vista, con el
    // teléfono "con red" y si fue la red (un error de otro tipo se repetiría).
    const reloj = setInterval(() => {
      const s = sinRedRef.current;
      if (s && !s.error && document.visibilityState === 'visible') intentar();
    }, INTERVALO_REINTENTO_MS);
    return () => {
      window.removeEventListener('online', intentar);
      document.removeEventListener('visibilitychange', alVisible);
      data.subscription.unsubscribe();
      clearInterval(reloj);
    };
  }, [cargar]);

  /**
   * Acciones en la cola del teléfono: al montar y cada vez que la cola
   * cambia (en esta pestaña o en otra). Con un respiro, para no releer
   * IndexedDB en ráfaga mientras una acción avanza paso por paso.
   */
  useEffect(() => {
    let vivo = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const refrescar = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (vivo) void refrescarPendientes();
      }, 150);
    };
    refrescar();
    const quitar = suscribirAcciones(refrescar);
    return () => {
      vivo = false;
      clearTimeout(t);
      clearTimeout(recargaTrasCola.current);
      quitar();
    };
  }, [refrescarPendientes]);

  // La copia del teléfono (modo sin señal, 24-sep-2026) ya no se escribe
  // desde un efecto sobre la lista, las fotos y el SLA: ver pedirCopia
  // (revisión sin señal, 24-sep-2026).

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
    // Los campos y no el objeto `historial` (regla del 24-sep-2026: ningún
    // efecto depende de un objeto de estado): cada carga buena arma uno
    // nuevo aunque diga lo mismo.
  }, [fDesde, vistaVeTerminales, historial.frontera, historial.tope, cargar]);

  /**
   * La lista TAL COMO LA VE el usuario: la de `items` con las acciones que
   * siguen en el teléfono encima (modo sin señal, 24-sep-2026). De aquí
   * salen la bandeja, el globito del menú, los filtros y las tarjetas: una
   * validación en cola no debe seguir contando como "por validar".
   *
   * Las que se quedaron con un error que no es de red (conError) NO se
   * superponen (revisión sin señal, 24-sep-2026): no se van a enviar solas,
   * y pintarlas como hechas sacaba la incidencia de la bandeja, escondía el
   * botón y el reloj de SLA seguía corriendo sin que nadie la atendiera.
   */
  const itemsVista = useMemo(
    () =>
      superponer(items, [...pegadas, ...pendientes.filter((p) => !conErrorDe(p))]),
    [items, pegadas, pendientes]
  );
  /** Tarjetas con una acción esperando señal (chip ⏳ En cola). */
  const enColaIds = useMemo(
    () =>
      new Set(pendientes.filter((p) => !conErrorDe(p)).map((p) => p.record_id)),
    [pendientes]
  );
  /** Tarjetas con una acción que no se pudo enviar (chip ⚠, ver IncCard). */
  const conErrorIds = useMemo(
    () => new Set(pendientes.filter(conErrorDe).map((p) => p.record_id)),
    [pendientes]
  );

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

    const it = itemsVista.find((i) => i.record_id === focoRecordId);

    if (!it) {
      let cancelado = false;
      (async () => {
        // Sin red (o sin sesión real, que daría un falso "ya no está
        // disponible") no se puede saber: se dice eso (modo sin señal,
        // 24-sep-2026).
        const avisoSinRed =
          '📴 Sin señal: la incidencia de la notificación no está en la ' +
          'lista guardada. Ábrela de nuevo al volver la red.';
        if (!haySenal() || !(await haySesionReal())) {
          if (cancelado) return;
          setAvisoFoco(avisoSinRed);
          onFocoAplicado?.();
          return;
        }
        const { data, error, status } = await sb
          .from('incidencias')
          .select('*')
          .eq('record_id', focoRecordId)
          .maybeSingle();
        if (cancelado) return;
        if (error && esFallaRed(status, error.message)) {
          setAvisoFoco(avisoSinRed);
          onFocoAplicado?.();
          return;
        }

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
  }, [focoRecordId, itemsVista, loading, onFocoAplicado]);

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
      return itemsVista;

    const yo = (email || '').toLowerCase();

    return itemsVista.filter((i) => {
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
  }, [itemsVista, misRoles, email, reparaEn]);

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
    return itemsVista.filter(
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
  }, [itemsVista, bandeja.length, misRoles, email, reparaEn]);

  useEffect(() => {
    onBandejaCount?.(accionables);
  }, [accionables, onBandejaCount]);

  // Áreas elegibles al dirigir una incidencia: las del catálogo MÁS las que
  // ya existen en los datos (Urban, Imprenta, Op. Bio Box… no están en
  // AREAS_RESP, y sin esto no se podrían elegir).
  const areasElegibles = useMemo(() => {
    const set = new Set<string>(AREAS_RESP);
    itemsVista.forEach((i) => {
      if (i.area_responsable) set.add(i.area_responsable);
      if (i.assigned_area) set.add(i.assigned_area);
    });
    return [...set].sort();
  }, [itemsVista]);

  const visibles = useMemo(() => {
    const base = modo === 'bandeja' ? bandeja : itemsVista;
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
    itemsVista,
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
      [...new Set(itemsVista.map((i) => i.area_reportante).filter(Boolean))].sort() as string[],
    [itemsVista]
  );

  // --- Acciones ---
  /**
   * Aplica un patch en memoria para no recargar toda la lista. También a la
   * copia del teléfono, aunque lo de pantalla sea esa copia o una recarga
   * fallida (U3, ver pedirCopia).
   */
  const patchInc = (rid: string, patch: Partial<Incidencia>) => {
    marcarTocada(rid);
    setItems((prev) =>
      prev.map((i) => (i.record_id === rid ? { ...i, ...patch } : i))
    );
    pedirCopia();
  };

  /** Reemplaza una fila entera por la que devolvió el servidor (y en la copia). */
  const reemplazarFila = (fila: Incidencia) => {
    marcarTocada(fila.record_id);
    setItems((prev) =>
      prev.map((i) => (i.record_id === fila.record_id ? fila : i))
    );
    pedirCopia();
  };

  const marcarOcupada = (rid: string, si: boolean) => {
    if (si) ocupadasRef.current.add(rid);
    else ocupadasRef.current.delete(rid);
    setOcupadas(new Set(ocupadasRef.current));
  };

  /**
   * Aviso tras una acción. Va un instante después para que primero se pinte
   * el cambio (el modal que se cierra, la tarjeta que cambia): un alert
   * congela la pantalla tal como está.
   */
  const avisar = (texto: string) => {
    setTimeout(() => alert(texto), 60);
  };

  /**
   * Corre una acción de validación o reparación por lib/acciones.ts (modo
   * sin señal, 24-sep-2026). Ahí se guarda en el teléfono ANTES de mandar,
   * se manda enseguida y, si no hay red, se queda en la cola y sale sola.
   * La precondición (el estatus que el usuario VE, y la misma reparación)
   * y la reconciliación de 0 filas —"otra persona ya la atendió" contra "tu
   * rol no lo permite", que antes hacía explicarSinCambio aquí— viven allá.
   *
   * Aquí queda lo de pantalla:
   *   - candado por tarjeta: un doble toque no manda (ni encola) dos veces;
   *   - la misma acción no se encola dos veces (otra distinta sí: sale en
   *     orden detrás, y su precondición es el estatus que ya se ve). Si la
   *     que ya está se quedó con error (conError), no se promete que "se
   *     enviará sola": se ofrece descartarla y mandar ésta;
   *   - 'enCola'    → la campana local, y el aviso de que saldrá sola;
   *   - 'conflicto' → la fila real (si vino) y el mensaje;
   *   - 'sinPermiso' / 'error' → el mensaje.
   * 'hecha' la resuelve quien llama (cada acción refleja distinto).
   */
  const correrAccion = async (
    a: AccionNueva,
    op?: { alProgreso?: (texto: string) => void }
  ): Promise<ResultadoAccion | null> => {
    const rid = a.record_id;
    if (ocupadasRef.current.has(rid)) return null;
    // La MISMA acción dos veces no (la tarjeta ya enseña su resultado, pero
    // por si acaso). Otra distinta sí: sale en orden detrás de la primera
    // (p. ej. reparar tras prevalidar, sin señal).
    const previa = pendientesRef.current.find(
      (p) => p.record_id === rid && p.clase === a.clase
    );
    if (previa && !conErrorDe(previa)) {
      avisar(
        'Esto ya está guardado en el teléfono y se enviará solo al volver la red.'
      );
      return null;
    }
    // La anterior no se va a enviar (revisión sin señal, 24-sep-2026): antes
    // se decía "se enviará sola" y nunca salía. Se ofrece reemplazarla; si
    // no, el modal (si lo hay) sigue abierto con lo capturado.
    if (
      previa &&
      !confirm(
        `${NOMBRE_ACCION[a.clase]} anterior de ${a.folio || 'esta incidencia'} no se pudo enviar` +
          (previa.ultimoError ? `: ${previa.ultimoError}` : '.') +
          '\n\n¿Descartarla y mandar ésta?'
      )
    )
      return null;
    /** Otras acciones de esta incidencia que siguen en la cola (van antes). */
    const otrasAntes = pendientesRef.current.filter(
      (p) => p.record_id === rid && p.id !== previa?.id
    );
    marcarOcupada(rid, true);
    let r: ResultadoAccion;
    try {
      r =
        previa && (await descartarAccion(previa.id).catch(() => 'ocupado' as const)) !== 'ok'
          ? {
              tipo: 'error',
              mensaje:
                'La anterior se está intentando enviar en este momento. Espera unos segundos y vuelve a intentarlo.',
            }
          : await ejecutarAccion(email, a, op);
    } catch (e) {
      r = {
        tipo: 'error',
        mensaje:
          'No se pudo guardar: ' + (e instanceof Error ? e.message : String(e)),
      };
    }
    // Su salida de la cola ya se refleja aquí (patchInc / fila real): que
    // no dispare una recarga completa. Si quedó en cola, su salida SÍ será
    // de fondo y sí recarga.
    if (r.tipo === 'enCola') primerPlanoHasta.current.delete(rid);
    else primerPlanoHasta.current.set(rid, Date.now() + GRACIA_PRIMER_PLANO_MS);
    await refrescarPendientes();
    marcarOcupada(rid, false);
    switch (r.tipo) {
      case 'enCola':
        // La campana deja de avisar de esta incidencia: el usuario ya hizo
        // su parte, aunque el servidor aún no lo sepa.
        onNotifAtendida(rid);
        // Detrás de otra acción de la misma incidencia la cola la deja
        // esperando aunque haya señal, y detrás de una con error no sale
        // hasta descartar esa: no se promete "al volver la red" en falso
        // (revisión sin señal, 24-sep-2026).
        avisar(
          otrasAntes.some(conErrorDe)
            ? 'Quedó guardado en el teléfono, pero la acción anterior de esta incidencia no se pudo enviar: descártala en el aviso de pendientes («Ver detalle») para que ésta salga.'
            : otrasAntes.length && haySenal()
              ? 'Quedó guardado en el teléfono: se envía en cuanto salga la acción anterior de esta incidencia.'
              : MENSAJE_EN_COLA
        );
        break;
      case 'conflicto':
        if (r.fila) reemplazarFila(r.fila);
        avisar(
          r.mensaje ||
            'Esta incidencia ya la atendió otra persona. Tu lista ya se actualizó.'
        );
        break;
      case 'sinPermiso':
      case 'error':
        avisar(r.mensaje);
        break;
    }
    return r;
  };

  /**
   * ¿La acción que falló se quedó de todos modos en la cola (p. ej. un
   * error que se reintenta solo)? Entonces el modal se cierra: volver a
   * guardar encolaría otra igual.
   */
  const quedoEnCola = (rid: string, clase: ClaseAccion) =>
    pendientesRef.current.some(
      (p) => p.record_id === rid && p.clase === clase && !conErrorDe(p)
    );

  /** Validar (→ en_proceso) y aprobar reparación (→ cerrada). */
  const cambiarEstatus = async (rid: string, estatus: EstatusInc) => {
    // La fila que el usuario VE (con lo de la cola encima, ver itemsVista):
    // su estatus es la precondición.
    const actual = itemsVista.find((i) => i.record_id === rid);
    if (!actual) return;
    let a: AccionNueva;
    if (estatus === 'en_proceso') {
      // Se deja rastro de quién validó y cuándo (la hora del teléfono AL
      // TOCAR, aunque la acción salga más tarde de la cola).
      a = {
        clase: 'validar',
        record_id: rid,
        folio: actual.folio,
        resumen: resumenDe('Validar', actual),
        esperado: actual.estatus,
        // La MISMA vuelta del ciclo que se ve (M7, revisión sin señal,
        // 24-sep-2026): por_validar → validada → descartada → corregida
        // regresa al mismo estatus, y solo validator_at delata el cambio.
        validatorAtVisto: actual.validator_at ?? null,
        patch: {
          estatus: 'en_proceso',
          validator_approved: true,
          validator_email: email,
          validator_at: new Date().toISOString(),
        },
      };
    } else if (estatus === 'cerrada') {
      // Al aprobar una reparación además debe ser LA MISMA reparación que se
      // revisó: si otro la rechazó y el técnico la volvió a reparar, el
      // estatus vuelve a 'reparado' y solo repaired_at delata el cambio.
      a = {
        clase: 'aprobar_reparacion',
        record_id: rid,
        folio: actual.folio,
        resumen: resumenDe('Aprobar reparación', actual),
        esperado: actual.estatus,
        repairedAtVisto: actual.repaired_at ? actual.repaired_at : undefined,
        patch: { estatus: 'cerrada' },
      };
    } else {
      // IncCard solo pide estos dos; reparar va por guardarReparacion.
      console.warn('[incidencias] cambio de estatus no soportado:', estatus);
      return;
    }
    const r = await correrAccion(a);
    if (r?.tipo !== 'hecha') return;
    patchInc(rid, { ...a.patch, ...(r.fila ?? {}) });
    onNotifAtendida(rid);
    setTimeout(onRecargarNotifs, 400);
    if (r.aviso) avisar(r.aviso);
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
      archivos,
    }: DatosReparacion,
    op?: { alProgreso?: (texto: string) => void }
  ): Promise<FinReparacion | undefined> => {
    // Solo se cierra el modal de ESTA apertura (ver `aperturas`).
    const miApertura = aperturas.current.rep;
    const cerrarSiEsElMismo = () => {
      if (aperturas.current.rep === miApertura) setRepairing(null);
    };
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
      // Fijada UNA vez, al tocar Guardar: es la marca con la que la cola
      // reconoce su propia reparación si la respuesta se pierde.
      repaired_at: new Date().toISOString(),
    };
    const r = await correrAccion(
      {
        clase: 'reparacion',
        record_id: inc.record_id,
        folio: inc.folio,
        resumen: resumenDe('Reparación', inc),
        // Precondición: sigue en el estatus en que se abrió el modal, y sin
        // otra reparación hecha mientras tanto (la cola puede salir tarde).
        esperado: inc.estatus,
        repairedAtVisto: inc.repaired_at ?? null,
        patch,
        archivos,
        // Mismo nombre que antes subía el modal al elegir cada foto: el
        // FOLIO abre el nombre para que la URL diga de qué incidencia es.
        nombreArchivo: {
          folio: inc.folio,
          cara: codigoCara(inc.clave_medio) || inc.clave_sitio || 'sitio',
        },
      },
      { alProgreso: op?.alProgreso }
    );
    // Lo que se devuelve le dice al modal qué hacer con su borrador del
    // teléfono (ver FinReparacion; revisión sin señal, 24-sep-2026).
    if (!r) return undefined;
    switch (r.tipo) {
      case 'hecha':
        patchInc(inc.record_id, { ...patch, ...(r.fila ?? {}) });
        cerrarSiEsElMismo();
        onNotifAtendida(inc.record_id);
        setTimeout(onRecargarNotifs, 400);
        // P. ej. "Supabase no devolvió la clasificación técnica…".
        if (r.aviso) avisar(r.aviso);
        return 'terminada';
      case 'enCola':
        // En la cola ya va.
        cerrarSiEsElMismo();
        return 'enCola';
      case 'conflicto':
        // Si otro ya la movió, el modal no tiene sentido.
        cerrarSiEsElMismo();
        return 'terminada';
      default:
        // Sin permiso o error: el modal sigue abierto con fotos y textos
        // para corregir o reintentar… salvo que se haya quedado en la cola.
        if (quedoEnCola(inc.record_id, 'reparacion')) {
          cerrarSiEsElMismo();
          return 'enCola';
        }
        return undefined;
    }
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
    const r = await correrAccion({
      clase: 'rechazar_reparacion',
      record_id: inc.record_id,
      folio: inc.folio,
      resumen: resumenDe('Rechazar reparación', inc),
      esperado: inc.estatus,
      repairedAtVisto: inc.repaired_at ? inc.repaired_at : undefined,
      patch,
    });
    if (!r) return;
    if (r.tipo === 'hecha') {
      // El contador de rechazos lo incrementa el trigger inc_cuenta_rechazo
      // en la base (por eso NO va en el patch que se manda). Si la acción no
      // devolvió la fila, se refleja aquí para que la tarjeta lo enseñe sin
      // esperar una recarga.
      patchInc(
        inc.record_id,
        r.fila
          ? { ...patch, ...r.fila }
          : { ...patch, rechazos_reparacion: (inc.rechazos_reparacion || 0) + 1 }
      );
      setMotivoOf(null);
      onNotifAtendida(inc.record_id);
      setTimeout(onRecargarNotifs, 400);
      if (r.aviso) avisar(r.aviso);
    } else if (
      r.tipo === 'enCola' ||
      r.tipo === 'conflicto' ||
      quedoEnCola(inc.record_id, 'rechazar_reparacion')
    ) {
      setMotivoOf(null);
    }
  };

  const prevalidar = async (inc: Incidencia) => {
    const patch: Partial<Incidencia> = { prevalidada: true };
    const r = await correrAccion({
      clase: 'prevalidar',
      record_id: inc.record_id,
      folio: inc.folio,
      resumen: resumenDe('Prevalidar', inc),
      esperado: inc.estatus,
      // Misma vuelta del ciclo que se ve (M7, ver cambiarEstatus).
      validatorAtVisto: inc.validator_at ?? null,
      patch,
    });
    if (r?.tipo !== 'hecha') return;
    patchInc(inc.record_id, { ...patch, ...(r.fila ?? {}) });
    if (r.aviso) avisar(r.aviso);
  };

  const descartarPrevalidacion = async (inc: Incidencia, motivo: string) => {
    const patch: Partial<Incidencia> = {
      estatus: 'rechazada',
      prevalidada: false,
      motivo_rechazo_reparacion: motivo,
    };
    const r = await correrAccion({
      clase: 'descartar_prevalidacion',
      record_id: inc.record_id,
      folio: inc.folio,
      resumen: resumenDe('Descartar', inc),
      esperado: inc.estatus,
      // Misma vuelta del ciclo que se ve (M7, ver cambiarEstatus).
      validatorAtVisto: inc.validator_at ?? null,
      patch,
    });
    if (!r) return;
    if (r.tipo === 'hecha') {
      patchInc(inc.record_id, { ...patch, ...(r.fila ?? {}) });
      setMotivoOf(null);
      onNotifAtendida(inc.record_id);
      if (r.aviso) avisar(r.aviso);
    } else if (
      r.tipo === 'enCola' ||
      r.tipo === 'conflicto' ||
      quedoEnCola(inc.record_id, 'descartar_prevalidacion')
    ) {
      setMotivoOf(null);
    }
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
    // Solo se cierra el alta de ESTA apertura (ver `aperturas`).
    const miApertura = aperturas.current.alta;
    const creadas = await crearReporte(grupos, { email, misDep });
    if (!creadas) return;
    creadas.forEach((c) => marcarTocada(c.record_id));
    // Sin duplicar: si una recarga terminó mientras se subían las fotos, la
    // lista ya trae estas filas desde el servidor.
    const ids = new Set(creadas.map((c) => c.record_id));
    setItems((prev) => [...creadas, ...prev.filter((p) => !ids.has(p.record_id))]);
    // A la copia del teléfono también (ya no la escribe un efecto por cada
    // cambio de lista; ver pedirCopia).
    pedirCopia();
    if (aperturas.current.alta === miApertura) {
      onCerrarNueva?.();
      setPresetNew(null);
    }
    setTimeout(onRecargarNotifs, 400);
  };

  // --- Tarjetas con identidad estable (React.memo en IncCard) ---
  // Con funciones y objetos nuevos en cada render, abrir el alta, teclear en
  // el buscador o cualquier aviso repintaba las 150 tarjetas (60-90 ms por
  // commit en escritorio, varias veces más en iPhone; app pasmada sin señal,
  // 24-sep-2026). Las que leen el estado del render (cambiarEstatus,
  // prevalidar) pasan por un ref con la versión de ESTE render: la tarjeta
  // las llama al tocar, nunca al pintar.
  const deEsteRender = useRef({ cambiarEstatus, prevalidar });
  deEsteRender.current = { cambiarEstatus, prevalidar };
  const alEstatus = useCallback(
    (rid: string, estatus: EstatusInc) =>
      void deEsteRender.current.cambiarEstatus(rid, estatus),
    []
  );
  const alPrevalidar = useCallback(
    (inc: Incidencia) => void deEsteRender.current.prevalidar(inc),
    []
  );
  const alChat = useCallback(
    (inc: Incidencia) => {
      setChatOf(inc);
      onChatLeido(inc.record_id);
    },
    [onChatLeido]
  );
  const alReasignar = useCallback(
    (inc: Incidencia, mode: ModoReasign) => setReassignOf({ inc, mode }),
    []
  );
  const alRechazarRep = useCallback(
    (inc: Incidencia) => setMotivoOf({ inc, kind: 'rechazo_rep' }),
    []
  );
  const alDescartar = useCallback(
    (inc: Incidencia) => setMotivoOf({ inc, kind: 'descartar' }),
    []
  );
  /**
   * El minuto en curso, para las tarjetas memorizadas: su reloj de SLA
   * ("por vencer · 12 min") se calcula al pintarlas, con la hora de ese
   * momento. Antes cualquier render de la vista lo recalculaba; con
   * React.memo solo se recalcularía al cambiar la incidencia y se quedaría
   * viejo. Así se recalcula en los renders de la vista, a lo más una vez
   * por minuto.
   */
  const minuto = Math.floor(Date.now() / 60000);

  /**
   * El alta se pinta TAMBIÉN mientras la vista dice "Cargando datos…" (app
   * pasmada sin señal, 24-sep-2026). "+ Nueva" desde otro módulo monta la
   * vista en "Cargando…", y el alta esperaba a la lista: sin señal y con
   * IndexedDB colgada, hasta 15 s, y cada ↻ volvía a empezar. Su fila no se
   * pierde si la lista llega después: `crear` la marca como tocada (la
   * fusión con el servidor la conserva) y usarCopia pone la copia DETRÁS de
   * lo que ya haya. La key conserva la MISMA instancia al terminar la carga:
   * el alta cambia de lugar en el árbol y, sin key, React la desmontaría con
   * lo capturado (fotos, GPS).
   */
  const modalNueva = (nuevaAbierta || presetNew) && (
    <NuevaInc
      key="alta"
      preset={presetNew}
      unidades={misUnidades}
      esMKT={misDep.some((d) => d.trim().toUpperCase() === 'MKT')}
      onClose={() => {
        onCerrarNueva?.();
        setPresetNew(null);
      }}
      onSave={crear}
    />
  );

  // --- Render ---
  if (loading)
    return (
      <>
        <div className="loading">Cargando datos…</div>
        {modalNueva}
      </>
    );

  return (
    <>
      {err && <div className="err">{err}</div>}
      {/* La lista NO es fresca: se dice de cuándo es, en vez del error crudo
          "incidencias: TypeError: Load failed" (modo sin señal, 24-sep-2026). */}
      {sinRed && (
        <div
          className="banner"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
          role="status"
        >
          {/* Con el teléfono "con red" la falla fue pasajera o del
              servidor: no se dice "Sin señal" en falso (revisión sin señal,
              24-sep-2026); se reintenta sola (ver el reloj de arriba). */}
          {sinRed.lenta
            ? `⏳ La lista sigue cargando; mientras, ves la guardada el ${fechaHoraCorta(sinRed.desde || '')}.`
            : !sinRed.desde
              ? sinRed.conSenal && !sinRed.error
                ? 'No se pudo cargar la lista; se reintenta sola.'
                : '📴 Sin señal: este teléfono aún no guarda una lista. Se cargará sola al volver la red.'
              : sinRed.error
                ? `Se muestra la lista guardada el ${fechaHoraCorta(sinRed.desde)}.`
                : sinRed.conSenal
                  ? `No se pudo actualizar la lista; se reintenta sola. Se muestra la del ${fechaHoraCorta(sinRed.desde)}.`
                  : `📴 Sin señal: lista guardada el ${fechaHoraCorta(sinRed.desde)}.`}
        </div>
      )}
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
              // El rojo de .err, con su pareja en el tema claro (tema
              // claro/oscuro, 24-sep-2026).
              color: alertasValidacion.vencidas > 0 ? 'var(--err-txt)' : 'var(--warn)',
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
              onEstatus={alEstatus}
              onRepair={setRepairing}
              onEvidence={setEvidenceOf}
              onChat={alChat}
              onReassign={alReasignar}
              onCorregir={setCorrigiendo}
              onEdit={setEditOf}
              onRechazarRep={alRechazarRep}
              onPrevalidar={alPrevalidar}
              onDescartar={alDescartar}
              minuto={minuto}
              slaMap={slaMap}
              slaValidacion={slaValidacion}
              nChat={chatCounts[i.record_id] || 0}
              enCola={enColaIds.has(i.record_id)}
              conError={conErrorIds.has(i.record_id)}
              ocupada={ocupadas.has(i.record_id)}
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
      {modalNueva}
      {repairing && (
        <RepararModal
          inc={repairing}
          email={email}
          onClose={() => setRepairing(null)}
          onSave={(p, op) => guardarReparacion(repairing, p, op)}
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
            // Solo si sigue abierta la MISMA edición (ver `aperturas`).
            if (aperturas.current.edit === aperturaEdit) setEditOf(null);
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
          boton={motivoOf.kind === 'descartar' ? 'Descartar' : 'Rechazar'}
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
