// ============================================================
// src/modules/mis-rutas/ComprobacionesHoy.tsx
// Mis rutas › Comprobaciones: la lista del monitorista, fase 3,
// incremento 1 (26-oct-2026; especificación §6.1). SOLO LECTURA: la
// cámara, la cola y el registro llegan en el incremento 2.
//
// Qué enseña: SUS tomas (comp_mis_tomas: las de su ruta, las que Victor le
// puso a mano en Formato y las devueltas que él tomó) del día elegido, una
// tarjeta por sitio en el orden de la ruta: primero las devueltas (en rojo),
// luego por ruta y parada y al final «Sin ruta». Arriba el día con flechas
// (hoy ±3; lo futuro solo se ve) y los chips Por tomar · Devueltas ·
// Enviadas. En HOY también salen las vencidas y las devueltas de otros días.
//
// La asignación de Marco llega sola: comp_mis_tomas refresca en la base la
// ruta y el monitorista de las tomas sin fotos antes de contestar (A4). No
// hay trigger ni botón aquí.
//
// SIN SEÑAL: igual que Mis rutas. Abre con la copia del teléfono
// (datosLocales, llave 'comp-hoy|<correo>') y lo dice; la copia solo se
// reemplaza con una respuesta que llegó completa, con red y con sesión REAL
// antes y después (al volver la señal hay ~60 s en que todo sale como
// anónimo). Se pide hoy −3 a hoy +3: con la copia se puede mover el día.
//
// Reglas anti-ciclo (app pasmada, 24-sep-2026): los efectos dependen de
// textos o números, y todo setState que sigue a una lectura se compara antes
// con un ref.
// ============================================================
import { ChevronLeft, ChevronRight, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sb } from '../../lib/supabase';
import { vigilarRender } from '../../lib/vigia';
import { diaCdmx } from '../../lib/fechasCdmx';
import { minutosCdmx } from '../../lib/franjaHorario';
import { guardarCompHoyLocal, haySenal, haySesionReal, leerCompHoyLocal } from '../../lib/datosLocales';
// Sin comprobacionesApi (revisión del 26-oct-2026, regresiones-1): Mis rutas
// no baja el API del Supervisor.
import { leerMisTomasComp } from '../../lib/misTomasApi';
import { textoFallaF3 } from '../../lib/fallasComp';
import {
  armarTarjetas,
  contarEstados,
  DIAS_ALREDEDOR,
  etiquetaDia,
  leerMisTomas,
  motivoCopiaDeFalla,
  rangoMisTomas,
  sumarDias,
  tomasDelDia,
  type FiltroMisTomas,
  type MotivoCopia,
  type RespMisTomas,
} from '../../lib/misTomasComp';
import { colorTono, fondoTono } from '../../lib/tonos';
import Ic from '../../components/Ic';
import TarjetaSitioComp from './TarjetaSitioComp';

type Datos = {
  resp: RespMisTomas;
  origen: 'red' | 'local';
  /** ISO de cuándo se bajó (para «lista guardada el …»). */
  guardado: string;
  /** Rango pedido. */
  desde: string;
  hasta: string;
};

type ResultadoRed =
  | { tipo: 'ok'; datos: Datos }
  | { tipo: 'red'; motivo: MotivoCopia }
  | { tipo: 'error'; mensaje: string };

/** Tarjetas por tanda («Ver más»): una ruta de Vía Verde puede traer decenas de sitios. */
const TANDA = 40;

/** Hoy en CDMX (no la zona del teléfono): el mismo día que usa la base. */
const hoyAhora = () => diaCdmx(new Date());

/**
 * La lista de la red. 'red' = sin señal, sin sesión real o algo no contestó:
 * se queda la copia. Una lectura SIN sesión real jamás se toma por buena.
 */
async function traerDeRed(email: string): Promise<ResultadoRed> {
  if (!haySenal()) return { tipo: 'red', motivo: 'senal' };
  if (!(await haySesionReal(email))) return { tipo: 'red', motivo: 'sesion' };
  const { desde, hasta } = rangoMisTomas(hoyAhora());
  const r = await leerMisTomasComp(desde, hasta);
  if (!r.ok) {
    // Revisión del 26-oct-2026 (monitorista-1): sin señal, «sin sesión» (401
    // o CP001), «ocupada» y «tardó» son pasajeros para quien solo LEE: se
    // queda la copia sin alerta roja (motivoCopiaDeFalla).
    const motivo = motivoCopiaDeFalla(r);
    if (motivo) return { tipo: 'red', motivo };
    // Un «sin permiso» mientras el token se renueva no es un error real: si
    // la sesión ya no es la de este correo, se queda la copia.
    if (!(await haySesionReal(email))) return { tipo: 'red', motivo: 'sesion' };
    return { tipo: 'error', mensaje: textoFallaF3(r) };
  }
  // DESPUÉS: si la sesión se cayó a medio camino, la respuesta pudo salir anónima.
  if (!(await haySesionReal(email))) return { tipo: 'red', motivo: 'sesion' };
  return { tipo: 'ok', datos: { resp: r.data, origen: 'red', guardado: new Date().toISOString(), desde, hasta } };
}

function fechaHora(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const h = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? `hoy ${h}`
    : `${d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })} ${h}`;
}

const ETIQUETA_FILTRO: Record<Exclude<FiltroMisTomas, null>, string> = {
  por_tomar: 'Por tomar',
  vencidas: 'Vencidas',
  devueltas: 'Devueltas',
  enviadas: 'Enviadas',
};

export default function ComprobacionesHoy({ email, recargarSignal }: { email: string; recargarSignal: number }) {
  // Dentro del ErrorBoundary de App (ver lib/vigia.ts).
  vigilarRender('ComprobacionesHoy');

  const [datos, setDatos] = useState<Datos | null>(null);
  const datosRef = useRef<Datos | null>(null);
  const firmaRef = useRef('');
  const [cargando, setCargando] = useState(true);
  const cargandoRef = useRef(true);
  const [actualizando, setActualizando] = useState(false);
  const actualizandoRef = useRef(false);
  const [error, setError] = useState('');
  const errorRef = useRef('');
  const [motivo, setMotivo] = useState<MotivoCopia>('senal');
  const motivoRef = useRef<MotivoCopia>('senal');

  const [hoy, setHoy] = useState(hoyAhora);
  const [dia, setDia] = useState(hoy);
  const [filtro, setFiltro] = useState<FiltroMisTomas>(null);
  const [limite, setLimite] = useState(TANDA);
  const [minuto, setMinuto] = useState<number | null>(() => minutosCdmx());

  const seqRef = useRef(0);
  const montadoRef = useRef(true);
  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
    };
  }, []);

  // ---- setState comparados con su ref (reglas anti-ciclo) ----
  const ponerDatos = (d: Datos) => {
    const firma = JSON.stringify(d);
    if (firma === firmaRef.current) return;
    firmaRef.current = firma;
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
  const ponerMotivo = (v: MotivoCopia) => {
    if (motivoRef.current === v) return;
    motivoRef.current = v;
    setMotivo(v);
  };

  /** La copia del teléfono, validada; null si no hay o no se entiende. */
  const deCopia = async (): Promise<Datos | null> => {
    const c = await leerCompHoyLocal(email);
    const resp = c ? leerMisTomas(c.respuesta) : null;
    return c && resp ? { resp, origen: 'local', guardado: c.guardado, desde: c.desde, hasta: c.hasta } : null;
  };

  /**
   * Primero la copia (si no hay nada en pantalla) y luego la red. Con red
   * buena y sesión real se reemplaza y se guarda. El consecutivo descarta
   * respuestas de una carga vieja.
   */
  const cargar = useCallback(async () => {
    const seq = ++seqRef.current;
    const vigente = () => montadoRef.current && seq === seqRef.current;
    if (!datosRef.current) {
      const d = await deCopia();
      if (!vigente()) return;
      if (d) {
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
      void guardarCompHoyLocal(email, { desde: r.datos.desde, hasta: r.datos.hasta, respuesta: r.datos.resp });
      return;
    }
    if (r.tipo === 'error') {
      ponerError(r.mensaje);
      ponerMotivo('base');
    } else {
      // Pasajero: un error viejo ya no aplica; el aviso de arriba dice por qué.
      ponerError('');
      ponerMotivo(r.motivo);
    }
    if (!datosRef.current) {
      const d = await deCopia();
      if (!vigente()) return;
      if (d) ponerDatos(d);
    } else if (datosRef.current.origen === 'red') {
      // Lo de la pantalla ya no está al día (sin red o con error): que se
      // diga con su hora y que el reintento por online/TOKEN_REFRESHED corra
      // (revisión del 26-oct-2026: antes, con error, seguía como 'red').
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

  // El reloj de la franja (cada 30 s) y el cambio de día a medianoche: si se
  // estaba viendo «Hoy», se pasa al nuevo hoy.
  const hoyRef = useRef(hoy);
  useEffect(() => {
    const t = window.setInterval(() => {
      const m = minutosCdmx();
      setMinuto((x) => (x === m ? x : m));
      const h = hoyAhora();
      if (h !== hoyRef.current) {
        const antes = hoyRef.current;
        hoyRef.current = h;
        setHoy(h);
        setDia((d) => (d === antes ? h : d));
      }
    }, 30000);
    return () => window.clearInterval(t);
  }, []);

  // Otro día u otro filtro: de nuevo la primera tanda.
  useEffect(() => setLimite(TANDA), [dia, filtro]);

  // ---- Derivados ----
  const tomas = datos?.resp.tomas;
  const delDia = useMemo(() => (tomas ? tomasDelDia(tomas, dia, hoy) : []), [tomas, dia, hoy]);
  const cuenta = useMemo(() => contarEstados(delDia, hoy), [delDia, hoy]);
  const tarjetas = useMemo(() => (tomas ? armarTarjetas(tomas, dia, hoy, filtro) : []), [tomas, dia, hoy, filtro]);
  const visibles = tarjetas.slice(0, limite);

  const minDia = sumarDias(hoy, -DIAS_ALREDEDOR);
  const maxDia = sumarDias(hoy, DIAS_ALREDEDOR);
  /** ¿La lista que hay (red o copia) cubre el día que se ve? */
  const cubre = !!datos && (!datos.desde || !datos.hasta || (dia >= datos.desde && dia <= datos.hasta));

  // ---- Render ----
  const explicacion = (
    <p className="phint">
      Las tomas de Comprobaciones que te tocan, por sitio y en el orden de tu ruta. Por ahora es solo para consultar:
      qué sitio, a qué hora y qué fotos pide cada campaña. Las fotos todavía no se suben desde aquí.
    </p>
  );

  if (cargando && !datos) {
    return (
      <>
        {explicacion}
        <div className="loading">Cargando tus comprobaciones…</div>
      </>
    );
  }

  if (!datos) {
    return (
      <>
        {explicacion}
        {error && (
          <div className="err" role="alert">
            {error}
          </div>
        )}
        <div className="empty">
          {error
            ? 'No se pudo leer tu lista de Comprobaciones.'
            : motivo === 'senal'
              ? 'No se pudo cargar tu lista de Comprobaciones y este teléfono no tiene una copia guardada. Busca señal y vuelve a intentarlo.'
              : motivo === 'sesion'
                ? 'Tu sesión se está renovando y este teléfono no tiene una copia guardada. Vuelve a intentarlo en un momento.'
                : 'La base no contestó a tiempo y este teléfono no tiene una copia guardada. Vuelve a intentarlo en un momento.'}
          <div style={{ marginTop: 12 }}>
            {/* 44 px (revisión del 26-oct-2026): .btn en móvil medía ~41. */}
            <button
              type="button"
              className="btn"
              onClick={() => void cargar()}
              disabled={actualizando}
              style={{ minHeight: 44 }}
            >
              {actualizando && <span className="spinner" />} Reintentar
            </button>
          </div>
        </div>
      </>
    );
  }

  const deCopiaLocal = datos.origen === 'local';
  const nada = datos.resp.tomas.length === 0;

  return (
    <>
      {explicacion}

      {deCopiaLocal && (!actualizando || !haySenal()) && (
        <div className="banner" role="status" style={{ marginBottom: 12 }}>
          <Ic i={WifiOff} />
          Lista guardada {datos.guardado ? fechaHora(datos.guardado) : '—'}:{' '}
          {motivo === 'sesion'
            ? 'tu sesión se está renovando; tu lista guardada sigue aquí.'
            : motivo === 'base'
              ? 'la base no contestó a tiempo; se trabaja con lo guardado en el teléfono.'
              : 'sin señal (o la red no contestó) se trabaja con lo guardado en el teléfono.'}{' '}
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void cargar()}
            disabled={actualizando}
            style={{ marginLeft: 6, minHeight: 44 }}
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
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
      {datos.resp.cortada && (
        <div className="banner" role="status">
          Tienes muchísimas tomas: la lista se cortó y salen primero las devueltas y las de hoy.
        </div>
      )}

      {/* El día, con flechas: hoy ±3 (lo que se guarda en el teléfono). */}
      <div
        role="group"
        aria-label="Día"
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}
      >
        <button
          type="button"
          className="btn ghost"
          aria-label="Día anterior"
          disabled={dia <= minDia}
          onClick={() => setDia((d) => sumarDias(d, -1))}
          style={{ minWidth: 44, minHeight: 44, padding: '8px 10px' }}
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        {/* Solo el día va en aria-live (revisión del 26-oct-2026): con
            «actualizando…» adentro, VoiceOver repetía el día en cada carga. */}
        <div style={{ flex: '1 1 auto', minWidth: 0, textAlign: 'center' }}>
          <b style={{ fontSize: 16 }} aria-live="polite">
            {etiquetaDia(dia, hoy)}
          </b>
          {actualizando && <span style={{ fontSize: 12, color: 'var(--muted)' }}> · actualizando…</span>}
        </div>
        <button
          type="button"
          className="btn ghost"
          aria-label="Día siguiente"
          disabled={dia >= maxDia}
          onClick={() => setDia((d) => sumarDias(d, 1))}
          style={{ minWidth: 44, minHeight: 44, padding: '8px 10px' }}
        >
          <ChevronRight size={20} aria-hidden="true" />
        </button>
        {dia !== hoy && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setDia(hoy)}
            style={{ minHeight: 44, flex: '1 1 100%' }}
          >
            Volver a hoy
          </button>
        )}
      </div>
      {dia > hoy && (
        <div className="phint" style={{ marginTop: 0 }}>
          Día por venir: solo para ver lo que toca.
        </div>
      )}
      {dia < hoy && (
        <div className="phint" style={{ marginTop: 0 }}>
          Día pasado: lo que quedó por tomar también sale en Hoy como vencido.
        </div>
      )}

      {/* Chips que filtran (sobre las tomas del día). */}
      {!nada && cubre && (
        <div className="rt-chips rt-segmento" role="group" aria-label="Filtrar tomas" style={{ marginBottom: 12 }}>
          {(Object.keys(ETIQUETA_FILTRO) as Exclude<FiltroMisTomas, null>[]).map((k) => {
            const on = filtro === k;
            const n = cuenta[k];
            // «Vencidas» solo cuando hay (o está elegido): casi siempre sobra.
            if (k === 'vencidas' && n === 0 && !on) return null;
            const rojo = k === 'devueltas' && n > 0;
            return (
              <button
                key={k}
                type="button"
                className={'rt-chip' + (on ? ' on' : '')}
                aria-pressed={on}
                onClick={() => setFiltro(on ? null : k)}
                style={{
                  minHeight: 44,
                  color: rojo && !on ? colorTono('rojo') : undefined,
                  background: rojo && !on ? fondoTono('rojo') : undefined,
                }}
              >
                {on ? '✓ ' : ''}
                {ETIQUETA_FILTRO[k]} ({n})
              </button>
            );
          })}
        </div>
      )}

      {nada ? (
        <div className="empty">
          No tienes tomas de Comprobaciones en estos días. Cuando el coordinador te asigne una ruta con sitios por comprobar
          (o el Supervisor te ponga una toma), aparecen aquí solas.
        </div>
      ) : !cubre ? (
        <div className="empty">La lista guardada en el teléfono no llega a ese día. Busca señal para actualizarla.</div>
      ) : tarjetas.length === 0 ? (
        <div className="empty">{filtro ? 'Nada con este filtro ese día.' : 'Ese día no tienes tomas.'}</div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            {tarjetas.length} sitio{tarjetas.length === 1 ? '' : 's'}
            {filtro ? ' con este filtro' : ''}
          </div>
          <div className="inc-list agrupada">
            {visibles.map((t) => (
              <TarjetaSitioComp key={t.clave} t={t} hoy={hoy} minuto={minuto} />
            ))}
          </div>
          {tarjetas.length > visibles.length && (
            <div style={{ textAlign: 'center', margin: '14px 0' }}>
              <button
                type="button"
                className="btn ghost"
                style={{ minHeight: 44 }}
                onClick={() => setLimite((n) => n + TANDA)}
              >
                Ver {Math.min(TANDA, tarjetas.length - visibles.length)} más (faltan {tarjetas.length - visibles.length})
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
