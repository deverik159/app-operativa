// ============================================================
// src/modules/mis-rutas/MisRutasView.tsx
// "Mis rutas": las rutas asignadas al monitorista, para recorrerlas en campo
// (rutas, 5-oct-2026).
//
// Qué enseña: sus rutas asignadas (ruta_asignaciones por su correo), MENOS
// Ecovallas Impreso —esas viven en Pauta y Monitoreo, la pauta manda ahí—.
// Las de Biobox salen aquí igual que las demás: el monitorista no usa el
// módulo Biobox. Por ruta: las paradas en orden con la dirección ELEGIDA al
// importar (archivo o QTM), mapa con la línea del recorrido y el número de
// cada parada, 🧭 Ir por parada, guías de Google Maps por tramos, y el estado
// de cada parada en la catorcena en curso (✓ visitada con hora, ⏳ en cola,
// pendiente). Si un sitio se visitó dos veces, cuenta la última.
//
// SIN SEÑAL: abre con la copia del teléfono (lib/datosLocales, por usuario)
// y lo dice ("📴 lista guardada el …"). La copia solo se reemplaza con datos
// que llegaron completos, con red y con sesión REAL antes y después (al
// volver la señal hay ~60 s en que todo sale como anónimo y la RLS contesta
// [] sin error). "Marcar visita" va a su propia cola (lib/visitas.ts).
//
// Reglas anti-ciclo (app pasmada, 24-sep-2026): ningún efecto depende de un
// objeto o arreglo de estado; dependen de textos (firmas). Todo setState que
// sigue a una lectura (copia, red, cola) se compara antes con un ref.
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { sb } from '../../lib/supabase';
import { vigilarRender } from '../../lib/vigia';
import { candadoTactil } from '../../lib/mapaTactil';
import { escHtml } from '../../lib/helpers';
import { colorSeguro } from '../rutas/rutasComun';
import { colorTono, fondoTono } from '../../lib/tonos';
import { esNavegable, tramosGoogleMaps } from '../../lib/navegacion';
import {
  catorcenasLocal,
  guardarMisRutasLocal,
  haySenal,
  haySesionReal,
  leerMisRutasLocal,
  type CatorcenaLocal,
  type MisRutasLocal,
  type ParadaMiaLocal,
  type RutaMiaLocal,
  type VisitaMiaLocal,
} from '../../lib/datosLocales';
import {
  suscribirVisitas,
  visitasEnviadasEnSesion,
  visitasPendientes,
  type VisitaPendiente,
} from '../../lib/visitas';
import { crearReporte } from '../../lib/crearReporte';
import IrAqui from '../../components/IrAqui';
import NuevaInc from '../incidencias/NuevaInc';
import type { GrupoReporte, PresetNueva } from '../incidencias/NuevaInc';
import MarcarVisitaModal, { type ParadaVisita } from './MarcarVisitaModal';

// ------------------------------------------------------------
// Datos
// ------------------------------------------------------------

type Datos = {
  rutas: RutaMiaLocal[];
  paradas: ParadaMiaLocal[];
  catorcena: CatorcenaLocal | null;
  visitas: VisitaMiaLocal[];
  origen: 'red' | 'local';
  /** ISO de cuándo se bajó (para "lista guardada el …"). */
  guardado: string;
  /** El avance no se pudo leer (la lista sí). */
  avisoVisitas: string;
};

type Resp<T> = { data: T | null; error: { message: string; code?: string } | null; status: number };

/** Tope de cada consulta: con señal colgada la vista no se queda en "Cargando…". */
const TOPE_CONSULTA_MS = 15000;
/** Tope de TODA la carga de la red (varias consultas seguidas). */
const TOPE_CARGA_MS = 35000;
/** Filas por página (tope de PostgREST) y páginas máximas. */
const PAGINA = 1000;
const MAX_PAGINAS = 20;

/** Instante límite de la carga en curso (lo fija traerDeRed). */
let limiteCarga = 0;

/**
 * Una consulta con tope: el AbortSignal corta el fetch, y la carrera cubre
 * la espera de auth-js antes de mandarlo (sin red y con el token vencido,
 * ~25 s que la señal no corta). El tope es el menor entre el de la consulta
 * y lo que le queda a la carga entera. Sin respuesta = status 0.
 */
async function pedir<T>(armar: (senal: AbortSignal) => PromiseLike<Resp<T>>): Promise<Resp<T>> {
  const resta = limiteCarga ? limiteCarga - Date.now() : TOPE_CONSULTA_MS;
  if (resta <= 0) return { data: null, error: { message: 'La red tardó demasiado' }, status: 0 };
  const control = new AbortController();
  let reloj: number | undefined;
  const vencido = new Promise<Resp<T>>((res) => {
    reloj = window.setTimeout(() => {
      control.abort();
      res({ data: null, error: { message: 'La red tardó demasiado' }, status: 0 });
    }, Math.min(TOPE_CONSULTA_MS, resta));
  });
  try {
    const consulta = Promise.resolve()
      .then(() => armar(control.signal))
      .then(
        (r) => r,
        (e: unknown): Resp<T> => ({ data: null, error: { message: String((e as Error)?.message || e) }, status: 0 })
      );
    return await Promise.race([consulta, vencido]);
  } finally {
    window.clearTimeout(reloj);
  }
}

/** ¿Falla de transporte (se usa la copia) y no un error definitivo? */
function esFallaRed(r: Resp<unknown>): boolean {
  if (!r.error) return false;
  const s = r.status;
  return !s || s === 401 || s === 408 || s === 425 || s === 429 || s >= 500;
}

/** Correo para un ilike exacto: '_' y '%' no son comodines aquí. */
function correoLike(email: string): string {
  return email.replace(/[\\%_]/g, (c) => '\\' + c);
}

function aNumero(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** AAAA-MM-DD en la hora del teléfono. */
function diaLocal(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** Medianoche LOCAL de un 'AAAA-MM-DD' (+dias). */
function inicioDeDia(fecha: string, dias = 0): Date {
  const [y, m, d] = fecha.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, (d || 1) + dias, 0, 0, 0, 0);
}

function contieneHoy(c: CatorcenaLocal | null | undefined, hoy: string): boolean {
  return !!c && c.fecha_inicio.slice(0, 10) <= hoy && c.fecha_fin.slice(0, 10) >= hoy;
}

/** ¿Instante dentro de la catorcena? (días completos en la hora del teléfono) */
function enCatorcena(iso: string, c: CatorcenaLocal | null): boolean {
  if (!c) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= inicioDeDia(c.fecha_inicio).getTime() && t < inicioDeDia(c.fecha_fin, 1).getTime();
}

/** Ecovallas Impreso vive en Pauta y Monitoreo: aquí no se enseña. */
function esEcovallasImpreso(r: { unidad_negocio: string; tipo_medio: string }): boolean {
  return /^ecovallas$/i.test((r.unidad_negocio || '').trim()) && /^impreso$/i.test((r.tipo_medio || '').trim());
}

const COLS_PARADAS =
  'ruta_id,site_id,secuencia,direccion,direccion_qtm,direccion_fuente,municipio,latitud,longitud,estatus_archivo,sin_match_inventario';
/** Las de antes de la migración de rutas (5-oct-2026), por si la app llega primero. */
const COLS_PARADAS_ANTES =
  'ruta_id,site_id,secuencia,direccion_archivo,municipio,latitud,longitud,estatus_archivo,sin_match_inventario';

type FilaParada = Partial<ParadaMiaLocal> & { direccion_archivo?: string | null };

function aParada(f: FilaParada): ParadaMiaLocal {
  const dir = (f.direccion ?? f.direccion_archivo ?? '') || '';
  return {
    ruta_id: Number(f.ruta_id),
    site_id: String(f.site_id || ''),
    secuencia: aNumero(f.secuencia),
    direccion: dir.trim() || null,
    direccion_qtm: f.direccion_qtm ?? null,
    direccion_fuente: f.direccion_fuente ?? null,
    municipio: f.municipio ?? null,
    latitud: aNumero(f.latitud),
    longitud: aNumero(f.longitud),
    estatus_archivo: f.estatus_archivo ?? null,
    sin_match_inventario: f.sin_match_inventario ?? null,
  };
}

type ResultadoRed =
  | { tipo: 'ok'; datos: Datos; guardar: boolean }
  | { tipo: 'red' }
  | { tipo: 'error'; mensaje: string };

/** Las páginas de una consulta (tope de 1000 filas por consulta). */
async function todas<T>(
  armar: (desde: number, senal: AbortSignal) => PromiseLike<Resp<T[]>>
): Promise<Resp<T[]>> {
  const filas: T[] = [];
  for (let i = 0; i < MAX_PAGINAS; i++) {
    const r = await pedir<T[]>((s) => armar(i * PAGINA, s));
    if (r.error) return r;
    const d = r.data || [];
    filas.push(...d);
    if (d.length < PAGINA) return { data: filas, error: null, status: r.status };
  }
  return { data: filas, error: null, status: 200 };
}

/**
 * Todo de la red. 'red' = sin red, sin sesión real o algo no contestó: se
 * queda la copia. Una lectura vacía SIN sesión real jamás se toma por buena.
 */
async function traerDeRed(email: string): Promise<ResultadoRed> {
  if (!haySenal()) return { tipo: 'red' };
  limiteCarga = Date.now() + TOPE_CARGA_MS;
  if (!(await haySesionReal(email))) return { tipo: 'red' };
  const em = email.trim().toLowerCase();

  const a = await pedir<{ ruta_id: number }[]>((s) =>
    sb
      .from('ruta_asignaciones')
      .select('ruta_id')
      .ilike('usuario_email', correoLike(em))
      .limit(PAGINA)
      .retry(false)
      .abortSignal(s)
  );
  if (a.error) return esFallaRed(a) ? { tipo: 'red' } : { tipo: 'error', mensaje: 'No se pudieron leer tus rutas: ' + a.error.message };
  const ids = [...new Set((a.data || []).map((x) => Number(x.ruta_id)).filter(Number.isFinite))];

  let rutas: RutaMiaLocal[] = [];
  if (ids.length) {
    const r = await pedir<RutaMiaLocal[]>((s) =>
      sb
        .from('rutas_monitoreo')
        .select('id,numero,nombre,color,unidad_negocio,tipo_medio,activa')
        .in('id', ids)
        .retry(false)
        .abortSignal(s)
    );
    if (r.error) return esFallaRed(r) ? { tipo: 'red' } : { tipo: 'error', mensaje: 'No se pudieron leer tus rutas: ' + r.error.message };
    rutas = (r.data || [])
      .filter((x) => !esEcovallasImpreso(x))
      .map((x) => ({ ...x, id: Number(x.id), numero: Number(x.numero) }))
      .sort(
        (x, y) =>
          x.unidad_negocio.localeCompare(y.unidad_negocio, 'es') ||
          x.numero - y.numero ||
          x.tipo_medio.localeCompare(y.tipo_medio, 'es')
      );
  }
  const rutaIds = rutas.map((r) => r.id);

  let paradas: ParadaMiaLocal[] = [];
  if (rutaIds.length) {
    const consulta = (cols: string) =>
      todas<FilaParada>((desde, s) =>
        sb
          .from('vw_rutas_con_coords')
          .select(cols)
          .in('ruta_id', rutaIds)
          .order('ruta_id', { ascending: true })
          .order('secuencia', { ascending: true, nullsFirst: false })
          .order('site_id', { ascending: true })
          .range(desde, desde + PAGINA - 1)
          .retry(false)
          .abortSignal(s) as unknown as PromiseLike<Resp<FilaParada[]>>
      );
    let p = await consulta(COLS_PARADAS);
    // 42703 = columna que no existe: la base aún no tiene la migración de
    // rutas. Se lee como antes (la dirección del archivo tal cual).
    if (p.error && p.error.code === '42703') p = await consulta(COLS_PARADAS_ANTES);
    if (p.error) return esFallaRed(p) ? { tipo: 'red' } : { tipo: 'error', mensaje: 'No se pudieron leer las paradas: ' + p.error.message };
    paradas = (p.data || []).map(aParada).filter((x) => x.site_id && Number.isFinite(x.ruta_id));
  }

  // La catorcena en curso (días completos, hora del teléfono).
  const hoy = diaLocal(new Date());
  let catorcena: CatorcenaLocal | null = null;
  const c = await pedir<CatorcenaLocal[]>((s) =>
    sb
      .from('catorcenas')
      .select('numero,fecha_inicio,fecha_fin,cat_texto')
      .lte('fecha_inicio', hoy)
      .gte('fecha_fin', hoy)
      .order('fecha_inicio', { ascending: false })
      .limit(1)
      .retry(false)
      .abortSignal(s)
  );
  if (c.error) {
    if (esFallaRed(c)) return { tipo: 'red' };
  } else catorcena = (c.data || [])[0] ?? null;
  if (!catorcena) {
    // Sin respuesta útil: la copia de catorcenas del teléfono.
    catorcena = (await catorcenasLocal().catch(() => [] as CatorcenaLocal[])).find((x) => contieneHoy(x, hoy)) ?? null;
  }

  // Las visitas del usuario en esa catorcena. Si no se pueden leer (la tabla
  // aún no existe, permiso), la lista sí se enseña, pero NO se guarda: la
  // copia tendría un avance vacío que no es verdad.
  let visitas: VisitaMiaLocal[] = [];
  let avisoVisitas = '';
  let guardar = true;
  if (catorcena && rutaIds.length) {
    const desde = inicioDeDia(catorcena.fecha_inicio).toISOString();
    const hasta = inicioDeDia(catorcena.fecha_fin, 1).toISOString();
    const v = await todas<VisitaMiaLocal>((d, s) =>
      sb
        .from('ruta_visitas')
        .select('site_id,ruta_id,visitado_en')
        // (rutas, 5-oct-2026, revisión) .eq y no .ilike: la regla de alta
        // obliga usuario_email = lower(auth_email()), así que siempre está
        // en minúsculas (ruta_asignaciones es de antes y sí sigue con ilike).
        .eq('usuario_email', em)
        .gte('visitado_en', desde)
        .lt('visitado_en', hasta)
        .order('visitado_en', { ascending: true })
        .order('id', { ascending: true })
        .range(d, d + PAGINA - 1)
        .retry(false)
        .abortSignal(s) as unknown as PromiseLike<Resp<VisitaMiaLocal[]>>
    );
    if (v.error) {
      if (esFallaRed(v)) return { tipo: 'red' };
      avisoVisitas = 'No se pudo leer el avance de visitas: ' + v.error.message;
      guardar = false;
    } else visitas = (v.data || []).map((x) => ({ site_id: x.site_id, ruta_id: aNumero(x.ruta_id), visitado_en: x.visitado_en }));
  }

  // DESPUÉS: si la sesión se cayó a medio camino, algo pudo salir anónimo.
  if (!(await haySesionReal(email))) return { tipo: 'red' };
  return {
    tipo: 'ok',
    guardar,
    datos: { rutas, paradas, catorcena, visitas, origen: 'red', guardado: new Date().toISOString(), avisoVisitas },
  };
}

/** La copia del teléfono, con el avance acotado a la catorcena de HOY. */
async function deCopia(copia: MisRutasLocal): Promise<Datos> {
  const hoy = diaLocal(new Date());
  const locales = await catorcenasLocal().catch(() => [] as CatorcenaLocal[]);
  const actual = locales.find((x) => contieneHoy(x, hoy)) ?? (contieneHoy(copia.catorcena, hoy) ? copia.catorcena : null);
  const misma =
    !!actual &&
    !!copia.catorcena &&
    actual.fecha_inicio.slice(0, 10) === copia.catorcena.fecha_inicio.slice(0, 10);
  return {
    rutas: copia.rutas,
    paradas: copia.paradas,
    catorcena: actual,
    // Visitas de otra catorcena no cuentan para esta.
    visitas: misma ? copia.visitas : [],
    origen: 'local',
    guardado: copia.guardado,
    avisoVisitas: '',
  };
}

// ------------------------------------------------------------
// Presentación
// ------------------------------------------------------------

function fechaHora(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const h = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? `hoy ${h}`
    : `${d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })} ${h}`;
}

function fechaCorta(f: string): string {
  const d = inicioDeDia(f);
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
}

function nombreRuta(r: RutaMiaLocal): string {
  return `Ruta ${r.numero}${r.nombre ? ' · ' + r.nombre : ''}`;
}

type Estado =
  | { tipo: 'visitada'; en: string }
  | { tipo: 'cola'; en: string; conError: boolean; enviando: boolean }
  | { tipo: 'pendiente' };

/** ¿Ver las guías de Google Maps? Se recuerda en el teléfono. */
const LLAVE_GUIAS = 'misrutas_ver_guias';

function MisRutasView({
  email,
  misDep,
  recargarSignal,
}: {
  email: string;
  misDep: string[];
  /** ↻ de la barra o envíos que salieron: se vuelve a leer. */
  recargarSignal: number;
}) {
  // Dentro del ErrorBoundary de App (ver lib/vigia.ts).
  vigilarRender('MisRutasView');

  const [datos, setDatos] = useState<Datos | null>(null);
  const datosRef = useRef<Datos | null>(null);
  const firmaDatosRef = useRef('');
  const [cargando, setCargando] = useState(true);
  const cargandoRef = useRef(true);
  const [actualizando, setActualizando] = useState(false);
  const actualizandoRef = useRef(false);
  const [error, setError] = useState('');
  const errorRef = useRef('');
  const [pend, setPend] = useState<VisitaPendiente[]>([]);
  const firmaPendRef = useRef('');
  /** Visitas que ya entraron en esta pestaña (lib/visitas), por si la red no se relee. */
  const [enviadas, setEnviadas] = useState<VisitaMiaLocal[]>([]);
  const firmaEnviadasRef = useRef('');
  const [rutaSel, setRutaSel] = useState<number | null>(null);
  const [aviso, setAviso] = useState('');
  const [visitaEn, setVisitaEn] = useState<ParadaVisita | null>(null);
  const [nuevaEn, setNuevaEn] = useState<PresetNueva | null>(null);
  const [verGuias, setVerGuias] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LLAVE_GUIAS) === '1';
    } catch {
      return false;
    }
  });
  const seqRef = useRef(0);
  const montadoRef = useRef(true);
  useEffect(() => {
    // Se vuelve a poner en true al montar: en desarrollo (StrictMode) React
    // desmonta y remonta, y sin esto la vista ya no aplicaría nada.
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
    };
  }, []);

  // ---- setState comparados con su ref (reglas anti-ciclo) ----
  const ponerDatos = (d: Datos) => {
    const firma = JSON.stringify(d);
    if (firma === firmaDatosRef.current) return;
    firmaDatosRef.current = firma;
    datosRef.current = d;
    setDatos(d);
  };
  const ponerCargando = (v: boolean) => {
    if (cargandoRef.current === v) return;
    cargandoRef.current = v;
    setCargando(v);
  };
  const ponerActualizando = (v: boolean) => {
    if (actualizandoRef.current === v) return;
    actualizandoRef.current = v;
    setActualizando(v);
  };
  const ponerError = (v: string) => {
    if (errorRef.current === v) return;
    errorRef.current = v;
    setError(v);
  };

  /**
   * Carga: primero la copia (al instante, si no hay nada en pantalla) y luego
   * la red. Con red buena y sesión real, se reemplaza y se guarda la copia.
   * El consecutivo descarta respuestas de una carga vieja.
   */
  const cargar = useCallback(async () => {
    const seq = ++seqRef.current;
    const vigente = () => montadoRef.current && seq === seqRef.current;
    if (!datosRef.current) {
      const copia = await leerMisRutasLocal(email);
      if (!vigente()) return;
      if (copia) {
        const d = await deCopia(copia);
        if (!vigente()) return;
        ponerDatos(d);
        ponerCargando(false);
      }
    }
    ponerActualizando(true);
    const r = await traerDeRed(email).catch(
      (e: unknown): ResultadoRed => ({ tipo: 'error', mensaje: String((e as Error)?.message || e) })
    );
    if (!vigente()) return;
    ponerActualizando(false);
    if (r.tipo === 'ok') {
      ponerError('');
      ponerDatos(r.datos);
      ponerCargando(false);
      if (r.guardar) {
        const { origen: _o, avisoVisitas: _a, ...resto } = r.datos;
        void guardarMisRutasLocal(email, resto);
      }
      return;
    }
    if (r.tipo === 'error') ponerError(r.mensaje);
    // Sin red (o error): se queda lo que haya; si no había nada, la copia.
    if (!datosRef.current) {
      const copia = await leerMisRutasLocal(email);
      if (!vigente()) return;
      if (copia) ponerDatos(await deCopia(copia));
    } else if (datosRef.current.origen === 'red' && r.tipo === 'red') {
      // Lo de la pantalla ya no está al día: que se diga.
      ponerDatos({ ...datosRef.current, origen: 'local' });
    }
    ponerCargando(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  useEffect(() => {
    void cargar();
  }, [cargar, recargarSignal]);

  // Volvió la red o se renovó la sesión: si lo de pantalla es la copia, se
  // vuelve a pedir (con un respiro: los eventos llegan en ráfaga).
  useEffect(() => {
    let t: number | undefined;
    const reintentar = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (montadoRef.current && datosRef.current?.origen !== 'red' && !actualizandoRef.current) void cargar();
      }, 1500);
    };
    let quitarAuth = () => {};
    try {
      const { data } = sb.auth.onAuthStateChange((evento) => {
        if (evento === 'TOKEN_REFRESHED' || evento === 'SIGNED_IN') reintentar();
      });
      quitarAuth = () => data.subscription.unsubscribe();
    } catch {
      /* quedan los demás disparadores */
    }
    window.addEventListener('online', reintentar);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('online', reintentar);
      quitarAuth();
    };
  }, [cargar]);

  // La cola de visitas: ⏳ en cada parada mientras no entre.
  useEffect(() => {
    let vivo = true;
    let t: number | undefined;
    const leer = async () => {
      const l = await visitasPendientes(email).catch(() => [] as VisitaPendiente[]);
      if (!vivo) return;
      const firma = JSON.stringify(l);
      if (firma !== firmaPendRef.current) {
        firmaPendRef.current = firma;
        setPend(l);
      }
      const env = visitasEnviadasEnSesion(email);
      const fe = JSON.stringify(env);
      if (fe !== firmaEnviadasRef.current) {
        firmaEnviadasRef.current = fe;
        setEnviadas(env);
      }
    };
    const alCambiar = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => void leer(), 200);
    };
    const quitar = suscribirVisitas(alCambiar);
    void leer();
    return () => {
      vivo = false;
      window.clearTimeout(t);
      quitar();
    };
  }, [email]);

  // ---- Derivados ----
  const rutas = datos?.rutas ?? [];
  const rutaActual = rutas.find((r) => r.id === rutaSel) ?? rutas[0] ?? null;
  const catorcena = datos?.catorcena ?? null;

  /** Estado de cada sitio en la catorcena: la ÚLTIMA visita cuenta; la cola encima. */
  const estados = useMemo(() => {
    const m = new Map<string, Estado>();
    // Por instante y no por texto: la base responde '+00:00' donde el
    // teléfono escribió 'Z'.
    const t = (iso: string) => {
      const n = Date.parse(iso);
      return Number.isFinite(n) ? n : 0;
    };
    const todas = [...(datos?.visitas ?? []), ...enviadas].filter((v) => enCatorcena(v.visitado_en, catorcena));
    for (const v of todas) {
      const e = m.get(v.site_id);
      if (!e || (e.tipo === 'visitada' && t(v.visitado_en) > t(e.en)))
        m.set(v.site_id, { tipo: 'visitada', en: v.visitado_en });
    }
    for (const p of pend) {
      const e = m.get(p.site_id);
      // Una visita en cola más nueva que la registrada es la que manda.
      if (!e || e.tipo !== 'visitada' || t(p.visitado_en) > t(e.en))
        m.set(p.site_id, { tipo: 'cola', en: p.visitado_en, conError: p.conError, enviando: p.enviando });
    }
    return m;
  }, [datos, enviadas, pend, catorcena]);

  const paradasDe = useCallback(
    (rutaId: number) =>
      (datos?.paradas ?? [])
        .filter((p) => p.ruta_id === rutaId)
        .sort(
          (a, b) =>
            (a.secuencia ?? Number.MAX_SAFE_INTEGER) - (b.secuencia ?? Number.MAX_SAFE_INTEGER) ||
            a.site_id.localeCompare(b.site_id)
        ),
    [datos]
  );

  const paradas = useMemo(() => (rutaActual ? paradasDe(rutaActual.id) : []), [rutaActual, paradasDe]);
  const navegables = useMemo(
    () => paradas.filter((p) => esNavegable({ lat: p.latitud, lng: p.longitud })),
    [paradas]
  );
  const tramos = useMemo(
    () =>
      tramosGoogleMaps(
        navegables.map((p) => ({ lat: p.latitud as number, lng: p.longitud as number, nombre: p.site_id }))
      ),
    [navegables]
  );

  const avanceDe = (rutaId: number) => {
    // (rutas, 5-oct-2026, revisión) Igual que el avance del coordinador
    // (AvanceVisitas): una parada RETIRADA no cuenta, así los dos ven el
    // mismo "N de M".
    const ps = paradasDe(rutaId).filter((p) => (p.estatus_archivo || '').toUpperCase() !== 'RETIRADA');
    let hechas = 0;
    let cola = 0;
    for (const p of ps) {
      const e = estados.get(p.site_id);
      if (e?.tipo === 'visitada') hechas++;
      else if (e?.tipo === 'cola') cola++;
    }
    return { total: ps.length, hechas, cola };
  };

  // ---- Mapa (Leaflet): línea del recorrido y número de parada ----
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapObj = useRef<L.Map | null>(null);
  const capa = useRef<L.LayerGroup | null>(null);
  /** Lo que el efecto dibuja; el efecto depende de su FIRMA (texto), no del arreglo. */
  const dibujo = useRef<{ color: string; puntos: { n: number; p: ParadaMiaLocal; estado: Estado['tipo'] }[] }>({
    color: '',
    puntos: [],
  });
  const puntosMapa = navegables.map((p) => ({
    n: paradas.indexOf(p) + 1,
    p,
    estado: (estados.get(p.site_id)?.tipo ?? 'pendiente') as Estado['tipo'],
  }));
  // (rutas, 5-oct-2026, revisión) El color entra al trazo SVG y al HTML del
  // ícono: solo un #rrggbb válido (un var() en un atributo SVG no se pinta y
  // un texto raro se metería al estilo).
  const colorRuta = colorSeguro(rutaActual?.color);
  dibujo.current = { color: colorRuta, puntos: puntosMapa };
  const firmaMapa =
    (rutaActual?.id ?? '') +
    '|' +
    colorRuta +
    '|' +
    puntosMapa.map((x) => `${x.n}:${x.p.site_id}:${x.p.latitud}:${x.p.longitud}:${x.estado}`).join(';');
  const hayMapa = puntosMapa.length > 0;

  useEffect(() => {
    const div = mapDiv.current;
    if (!div) return;
    if (mapObj.current && mapObj.current.getContainer() !== div) {
      mapObj.current.remove();
      mapObj.current = null;
      capa.current = null;
    }
    if (!mapObj.current) {
      mapObj.current = L.map(div, { zoomControl: true }).setView([19.43, -99.13], 11);
      // En táctil, un dedo desplaza la página y no el mapa (ver mapaTactil).
      candadoTactil(mapObj.current);
      // OSM estándar (mismo motivo que RutasView). Sin señal no hay mosaicos:
      // quedan la línea y los números, que sí sirven para ubicarse.
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 19,
      }).addTo(mapObj.current);
    }
    const mapa = mapObj.current;
    if (capa.current) mapa.removeLayer(capa.current);
    const grp = L.layerGroup();
    const { color, puntos } = dibujo.current;
    const linea = puntos.map((x) => [x.p.latitud as number, x.p.longitud as number] as [number, number]);
    // El color de la ruta es un DATO (el que le puso el coordinador), no del
    // tema: se respeta en los dos temas.
    if (linea.length > 1) L.polyline(linea, { color, weight: 4, opacity: 0.75 }).addTo(grp);
    puntos.forEach((x) => {
      // Colores del tema por variable CSS: el divIcon es HTML y las lee.
      const fondo =
        x.estado === 'visitada' ? colorTono('verde') : x.estado === 'cola' ? colorTono('ambar') : 'var(--panel)';
      const texto = x.estado === 'pendiente' ? 'var(--txt)' : 'var(--sobre-ok)';
      const icono = L.divIcon({
        className: 'mis-rutas-parada',
        html:
          `<div style="width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;` +
          `font:700 12px/1 system-ui,sans-serif;background:${fondo};color:${texto};` +
          `border:3px solid ${escHtml(color)};box-shadow:0 1px 4px var(--sombra)">${x.n}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      // Todo escapado: la clave y la dirección vienen de archivos ajenos.
      L.marker([x.p.latitud as number, x.p.longitud as number], { icon: icono })
        .bindPopup(
          `<b>${x.n}. ${escHtml(x.p.site_id)}</b><br>${escHtml(x.p.direccion || '(sin dirección)')}` +
            (x.estado === 'visitada' ? '<br>✓ Visitada' : x.estado === 'cola' ? '<br>⏳ Visita sin enviar' : '')
        )
        .addTo(grp);
    });
    grp.addTo(mapa);
    capa.current = grp;
    const ajustar = () => {
      if (!mapObj.current) return;
      mapObj.current.invalidateSize();
      if (linea.length === 1) mapObj.current.setView(linea[0], 15);
      else if (linea.length > 1) mapObj.current.fitBounds(linea, { padding: [30, 30], maxZoom: 16 });
    };
    ajustar();
    const t = window.setTimeout(ajustar, 250);
    return () => window.clearTimeout(t);
  }, [firmaMapa, hayMapa]);

  // El mapa se libera al salir del módulo.
  useEffect(
    () => () => {
      try {
        mapObj.current?.remove();
      } catch {
        /* ya liberado */
      }
      mapObj.current = null;
      capa.current = null;
    },
    []
  );

  const cambiarGuias = () => {
    setVerGuias((v) => {
      try {
        localStorage.setItem(LLAVE_GUIAS, v ? '0' : '1');
      } catch {
        /* sin almacenamiento: solo esta vez */
      }
      return !v;
    });
  };

  /** Guardado del reporte levantado aquí: el mismo de Incidencias y Pauta. */
  const guardarReporte = async (grupos: GrupoReporte[]) => {
    const creadas = await crearReporte(grupos, { email, misDep });
    if (!creadas) return; // duplicado o error: el modal se queda abierto.
    setNuevaEn(null);
    // (rutas, 5-oct-2026, QA) Con red no salía ninguna confirmación (sin
    // señal ya avisa crearReporte con su alert). Arreglo vacío = quedó en
    // la cola: el aviso de envíos de arriba lo enseña.
    if (creadas.length) {
      const folios = creadas.map((c) => c.folio).filter(Boolean);
      setAviso(
        `✓ Incidencia levantada${folios.length ? ` (folio ${[...new Set(folios)].join(', ')})` : ''}.`
      );
    }
  };

  // ---- Render ----
  if (cargando && !datos) return <div className="loading">Cargando tus rutas…</div>;

  const encabezado = (
    <>
      <h2 className="page">Mis rutas</h2>
      <p className="phint">
        Tus rutas asignadas, en orden. Marca cada visita con su foto; sin señal se guarda en el
        teléfono y se envía sola. Las rutas de Ecovallas Impreso están en Pauta y Monitoreo.
      </p>
    </>
  );

  if (!datos) {
    return (
      <>
        {encabezado}
        {error && <div className="err">{error}</div>}
        <div className="empty">
          No se pudieron cargar tus rutas y este teléfono no tiene una copia guardada. Busca señal y
          vuelve a intentarlo.
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn" onClick={() => void cargar()} disabled={actualizando}>
              {actualizando && <span className="spinner" />} Reintentar
            </button>
          </div>
        </div>
      </>
    );
  }

  const deCopiaLocal = datos.origen === 'local';

  return (
    <>
      {encabezado}

      {/* Mientras la red contesta (1-2 s con señal) no se asusta con 📴:
          la copia se enseña tal cual y se dice "actualizando…". */}
      {deCopiaLocal && (!actualizando || !haySenal()) && (
        <div className="banner" role="status" style={{ marginBottom: 12 }}>
          📴 Lista guardada {datos.guardado ? fechaHora(datos.guardado) : '—'}: sin señal (o la
          red no contestó) se trabaja con lo guardado en el teléfono.{' '}
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void cargar()}
            disabled={actualizando}
            style={{ marginLeft: 6 }}
          >
            {actualizando ? (
              <>
                <span className="spinner" /> Actualizando…
              </>
            ) : (
              'Reintentar'
            )}
          </button>
        </div>
      )}
      {error && <div className="err">{error}</div>}
      {datos.avisoVisitas && <div className="err">{datos.avisoVisitas}</div>}
      {aviso && (
        <div
          className="banner"
          role="status"
          style={{ marginBottom: 12, display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'flex-start' }}
        >
          <span style={{ minWidth: 0 }}>{aviso}</span>
          <button type="button" className="btn ghost sm" aria-label="Cerrar aviso" onClick={() => setAviso('')}>
            ✕
          </button>
        </div>
      )}

      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
        {catorcena ? (
          <>
            Catorcena <b style={{ color: 'var(--txt)' }}>{catorcena.numero}</b> ·{' '}
            {fechaCorta(catorcena.fecha_inicio)} – {fechaCorta(catorcena.fecha_fin)}
          </>
        ) : (
          'Sin catorcena en curso registrada: el avance no se puede contar.'
        )}
        {actualizando && ' · actualizando…'}
      </div>

      {rutas.length === 0 ? (
        <div className="empty">
          No tienes rutas asignadas aquí. El coordinador te las asigna desde Rutas de Monitoreo (las de
          Ecovallas Impreso, desde Pauta y Monitoreo).
        </div>
      ) : (
        <>
          {/* Selector de ruta: con una sola no hace falta elegir. */}
          {rutas.length > 1 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {rutas.map((r) => {
                const a = avanceDe(r.id);
                const activa = rutaActual?.id === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={'btn sm' + (activa ? '' : ' ghost')}
                    aria-pressed={activa}
                    onClick={() => setRutaSel(r.id)}
                    style={{ textAlign: 'left' }}
                  >
                    {nombreRuta(r)} · {r.unidad_negocio} {r.tipo_medio}
                    {catorcena && ` · ${a.hechas}/${a.total}`}
                  </button>
                );
              })}
            </div>
          )}

          {rutaActual &&
            (() => {
              const a = avanceDe(rutaActual.id);
              return (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>
                    <span
                      aria-hidden
                      style={{
                        display: 'inline-block',
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: colorSeguro(rutaActual.color),
                        marginRight: 6,
                      }}
                    />
                    {nombreRuta(rutaActual)}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    {rutaActual.unidad_negocio} · {rutaActual.tipo_medio} · {a.total} parada
                    {a.total === 1 ? '' : 's'}
                    {catorcena && (
                      <>
                        {' '}
                        · <b style={{ color: colorTono('verde') }}>✓ {a.hechas} visitada{a.hechas === 1 ? '' : 's'}</b>
                        {a.cola > 0 && (
                          <b style={{ color: colorTono('ambar') }}> · ⏳ {a.cola} sin enviar</b>
                        )}
                      </>
                    )}
                    {rutaActual.activa === false && ' · ruta inactiva'}
                  </div>
                </div>
              );
            })()}

          {hayMapa && (
            <div
              ref={mapDiv}
              style={{
                height: 300,
                borderRadius: 12,
                border: '1px solid var(--line)',
                marginBottom: 12,
                overflow: 'hidden',
                // (rutas, 5-oct-2026, QA) Igual que .rutas-map/.rt-mapa: los
                // controles de Leaflet traen z-index 1000 y, sin un contexto
                // propio, tapaban "Marcar visita", la hoja "¿Cómo te llevo?"
                // y el menú inferior (y el toque caía en el mapa).
                isolation: 'isolate',
                zIndex: 0,
              }}
            />
          )}

          {tramos.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <button type="button" className="btn ghost sm" onClick={cambiarGuias} aria-expanded={verGuias}>
                {verGuias ? '▾' : '▸'} 🗺️ Guías de ruta (Google Maps)
              </button>
              {verGuias && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {tramos.length === 1 ? 'Navegar el recorrido:' : `Navegar por tramos (${tramos.length}):`}
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
                      🗺️ {tramos.length === 1 ? 'Abrir en Google Maps' : `Paradas ${t.desde}–${t.hasta}`}
                    </a>
                  ))}
                  {paradas.length > navegables.length && (
                    <span
                      className="pill"
                      style={{ background: fondoTono('ambar'), color: colorTono('ambar') }}
                      title="Sin coordenadas en inventario: no entran en la guía"
                    >
                      ⚠ {paradas.length - navegables.length} sin ubicación
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {paradas.length === 0 ? (
            <div className="empty">Esta ruta todavía no tiene paradas.</div>
          ) : (
            <div className="inc-list">
              {paradas.map((p, i) => {
                const e = estados.get(p.site_id) ?? ({ tipo: 'pendiente' } as Estado);
                const navegable = esNavegable({ lat: p.latitud, lng: p.longitud });
                const retirada = (p.estatus_archivo || '').toUpperCase() === 'RETIRADA';
                return (
                  <div key={p.site_id} className="inc">
                    <div className="inc-top">
                      <div style={{ minWidth: 0 }}>
                        <div className="folio">
                          Parada {i + 1}
                          {p.secuencia != null && p.secuencia !== i + 1 ? ` · secuencia ${p.secuencia}` : ''}
                        </div>
                        <div className="titulo" style={{ overflowWrap: 'anywhere' }}>
                          {p.site_id}
                        </div>
                        <div className="meta">
                          {p.direccion || '(sin dirección)'}
                          {p.municipio ? ` · ${p.municipio}` : ''}
                        </div>
                        <div style={{ marginTop: 6 }}>
                          {e.tipo === 'visitada' && (
                            <span
                              className="pill"
                              style={{ background: fondoTono('verde'), color: colorTono('verde') }}
                            >
                              ✓ Visitada {fechaHora(e.en)}
                            </span>
                          )}
                          {e.tipo === 'cola' && (
                            <span
                              className="pill"
                              style={{
                                background: fondoTono(e.conError ? 'rojo' : 'ambar'),
                                color: colorTono(e.conError ? 'rojo' : 'ambar'),
                              }}
                              title={e.conError ? 'Revisa el aviso de envíos de arriba' : undefined}
                            >
                              {e.conError
                                ? `⚠ Visita ${fechaHora(e.en)} no se pudo enviar`
                                : `⏳ Visita ${fechaHora(e.en)} ${e.enviando ? 'enviándose…' : 'sin enviar'}`}
                            </span>
                          )}
                          {e.tipo === 'pendiente' && (
                            <span
                              className="pill"
                              style={{ background: fondoTono('gris'), color: 'var(--muted)' /* --st-gris en oscuro da 3.2:1 (QA, 5-oct-2026) */ }}
                            >
                              {catorcena ? 'Pendiente en esta catorcena' : 'Pendiente'}
                            </span>
                          )}
                          {retirada && (
                            <span
                              className="pill"
                              style={{ background: fondoTono('rojo'), color: colorTono('rojo'), marginLeft: 6 }}
                            >
                              Retirada
                            </span>
                          )}
                        </div>
                      </div>
                      <IrAqui destino={{ lat: p.latitud, lng: p.longitud, nombre: p.site_id }} />
                    </div>
                    {!navegable && (
                      <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 6 }}>
                        ⚠ Sin coordenadas en inventario — guíate por la dirección.
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() =>
                          setVisitaEn({
                            ruta_id: p.ruta_id,
                            site_id: p.site_id,
                            secuencia: i + 1,
                            direccion: p.direccion,
                            rutaTexto: rutaActual ? nombreRuta(rutaActual) : 'Ruta',
                          })
                        }
                      >
                        📸 {e.tipo === 'pendiente' ? 'Marcar visita' : 'Marcar otra visita'}
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() =>
                          setNuevaEn({
                            un: rutaActual?.unidad_negocio,
                            siteId: p.site_id,
                            direccion: p.direccion,
                          })
                        }
                      >
                        ➕ Levantar incidencia
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {visitaEn && (
        <MarcarVisitaModal
          email={email}
          parada={visitaEn}
          onClose={() => setVisitaEn(null)}
          onGuardada={(texto) => {
            setVisitaEn(null);
            setAviso(texto);
          }}
        />
      )}

      {/* El MISMO alta de Incidencias (catálogo, caras, evidencia, cola sin
          señal) con el sitio y la dirección elegida ya puestos. */}
      {nuevaEn && (
        <NuevaInc
          preset={nuevaEn}
          unidades={nuevaEn.un ? [nuevaEn.un] : undefined}
          onSave={guardarReporte}
          onClose={() => setNuevaEn(null)}
        />
      )}
    </>
  );
}

export default MisRutasView;
