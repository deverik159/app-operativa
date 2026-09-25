// ============================================================
// src/components/EnviosPendientes.tsx
// Aviso global de reportes que no han salido del teléfono.
//
// POR QUÉ (auditoría primer mes, 24-sep-2026): sin señal, el reporte queda
// en la cola del teléfono (lib/envios.ts) en vez de perderse. Este aviso es
// la mitad visible de esa cola: dice cuántos hay, los reintenta solo y deja
// descartarlos. Vive en el armazón (App) para verse desde cualquier pestaña.
//
// Cuándo se intenta enviar: al montar, al volver la red ('online'), al
// volver a primer plano (visibilitychange) y cada ~2 min mientras haya
// pendientes y la pestaña esté visible. Con la pestaña oculta no: en iOS
// el trabajo en segundo plano se congela y solo gastaría batería. Se
// intenta aunque el navegador diga que no hay red: en algunos Android lo
// dice en falso, y sin red de verdad el intento falla al instante
// (revisión primer mes, 24-sep-2026; ver procesarPendientes).
//
// Si el teléfono no tiene IndexedDB no truena nada: la cola vive en memoria
// y el aviso solo aparece si hay algo que avisar.
//
// MODO SIN SEÑAL (24-sep-2026): el aviso también lleva la cola de ACCIONES
// (validar, aprobar/rechazar reparación, prevalidar, descartar y registrar
// reparación; lib/acciones.ts) con los mismos disparadores, y uno más: al
// renovarse la sesión (TOKEN_REFRESHED / SIGNED_IN). Al volver la red,
// auth-js tarda hasta ~60 s en renovar un token vencido y en ese rato las
// colas esperan (no se manda nada como anon); en cuanto hay sesión, salen
// sin esperar al reloj de 2 min. Las dos colas corren A LA VEZ (revisión
// sin señal, 24-sep-2026): antes los reportes esperaban a que terminara la
// de acciones, y una reparación con un video de 40 MB y señal débil los
// retenía más de 20 min. Son independientes: cada una lleva su orden.
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { sb } from '../lib/supabase';
import {
  descartarEnvio,
  listarPendientes,
  procesarPendientes,
  registrarEmailActivo,
  suscribirEnvios,
  type ResumenPendiente,
} from '../lib/envios';
import {
  descartarAccion,
  listarAccionesAviso,
  procesarAccionesPendientes,
  suscribirAcciones,
  tomarAvisosAcciones,
  type ResumenAccion,
} from '../lib/acciones';

/** Reintento periódico mientras haya pendientes. */
const CADA_MS = 2 * 60 * 1000;

/** "14:05" si es de hoy; "22 sep. 14:05" si no. */
function hora(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const h = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? h
    : `${d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })} ${h}`;
}

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

function EnviosPendientes({
  email,
  onEnviado,
}: {
  email: string;
  onEnviado: () => void;
}) {
  const [lista, setLista] = useState<ResumenPendiente[]>([]);
  const [acciones, setAcciones] = useState<ResumenAccion[]>([]);
  const [abierto, setAbierto] = useState(false);
  // Una bandera por cola (verificación de la revisión sin señal,
  // 24-sep-2026): con un video lento en la de acciones, la de reportes se
  // puede reintentar y descartar.
  const [enviandoReportes, setEnviandoReportes] = useState(false);
  const [enviandoAcciones, setEnviandoAcciones] = useState(false);
  const trabajando = enviandoReportes || enviandoAcciones;
  /** Avisos de la última vuelta (omitidos por duplicado, etc.): una vez. */
  const [mensajes, setMensajes] = useState<string[]>([]);
  // App pasa una flecha nueva en cada render: con ref no se re-suscribe todo.
  const onEnviadoRef = useRef(onEnviado);
  onEnviadoRef.current = onEnviado;
  const hayPendientesRef = useRef(false);
  /**
   * La vuelta en curso de CADA cola: varios disparadores juntos no la
   * duplican (ni repiten sus avisos). Una por cola y no una para las dos
   * (verificación de la revisión sin señal, 24-sep-2026): con una sola, un
   * video de 40 MB con señal débil en la de acciones (~35 min de tope) hacía
   * que cada disparador devolviera esa misma promesa y los reportes que
   * fallaron en su primer intento no se volvían a intentar hasta que
   * terminara.
   */
  const vueltaReportesRef = useRef<Promise<void> | null>(null);
  const vueltaAccionesRef = useRef<Promise<void> | null>(null);
  /** Las dos colas que terminan casi juntas piden UNA recarga de listas, no dos. */
  const relojRecarga = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(relojRecarga.current), []);

  // El borrador del alta usa este correo de respaldo cuando auth-js no da
  // la sesión a tiempo (sin red y con el token vencido).
  useEffect(() => {
    registrarEmailActivo(email);
  }, [email]);

  const refrescar = useCallback(async () => {
    try {
      const [l, la] = await Promise.all([listarPendientes(email), listarAccionesAviso(email)]);
      hayPendientesRef.current = l.length + la.length > 0;
      setLista(l);
      setAcciones(la);
      // Avisos de acciones que se mandaron por su cuenta (p. ej. una previa
      // de la misma incidencia antes de la que se acaba de tocar). Solo los
      // de este correo (revisión sin señal, 24-sep-2026: teléfono compartido).
      const buzon = tomarAvisosAcciones(email);
      if (buzon.length) setMensajes((m) => [...m, ...buzon]);
    } catch {
      /* el aviso nunca debe romper la app */
    }
  }, [email]);

  const procesar = useCallback((): Promise<void> => {
    if (!email) return Promise.resolve();
    /** Una cola: si ya corre, se devuelve esa vuelta; si no, se lanza. */
    const correr = (
      ref: { current: Promise<void> | null },
      marcar: (v: boolean) => void,
      vuelta: () => Promise<{ mensajes: string[]; recargar: boolean }>
    ): Promise<void> => {
      if (ref.current) return ref.current;
      marcar(true);
      const p = (async () => {
        try {
          const r = await vuelta();
          if (r.mensajes.length) setMensajes((m) => [...m, ...r.mensajes]);
          // Salió al menos uno (o ya existe su incidencia, o una acción ya
          // no aplica): que App recargue las listas, como con ↻.
          if (r.recargar) {
            window.clearTimeout(relojRecarga.current);
            relojRecarga.current = window.setTimeout(() => onEnviadoRef.current(), 300);
          }
        } catch {
          /* se reintenta en la siguiente vuelta */
        }
      })().finally(() => {
        ref.current = null;
        marcar(false);
        refrescar();
      });
      ref.current = p;
      return p;
    };
    // Las dos colas a la vez y cada una por su lado (ver cabecera): un video
    // de una no retiene a la otra.
    return Promise.all([
      correr(vueltaAccionesRef, setEnviandoAcciones, async () => {
        const r = await procesarAccionesPendientes(email);
        return { mensajes: r.mensajes, recargar: r.terminadas > 0 };
      }),
      correr(vueltaReportesRef, setEnviandoReportes, async () => {
        const r = await procesarPendientes(email);
        return { mensajes: r.mensajes, recargar: r.terminados > 0 || r.conFilasNuevas > 0 };
      }),
    ]).then(() => undefined);
  }, [email, refrescar]);

  // Cambios en las colas (de esta pestaña o de otra). Con un respiro: cada
  // foto subida avisa, y no hace falta releer la cola por cada una.
  useEffect(() => {
    let t: number | undefined;
    const alCambiar = () => {
      window.clearTimeout(t);
      t = window.setTimeout(refrescar, 250);
    };
    const quitarEnvios = suscribirEnvios(alCambiar);
    const quitarAcciones = suscribirAcciones(alCambiar);
    refrescar();
    return () => {
      quitarEnvios();
      quitarAcciones();
      window.clearTimeout(t);
    };
  }, [refrescar]);

  // La sesión se renovó: lo que esperaba sesión sale ya (ver arriba). Fuera
  // del callback (setTimeout): auth-js pide no llamar a Supabase dentro.
  useEffect(() => {
    if (!email) return;
    let quitar = () => {};
    try {
      const { data } = sb.auth.onAuthStateChange((evento) => {
        if (evento !== 'TOKEN_REFRESHED' && evento !== 'SIGNED_IN') return;
        window.setTimeout(() => {
          if (hayPendientesRef.current) procesar();
        }, 0);
      });
      quitar = () => data.subscription.unsubscribe();
    } catch {
      /* sin este disparador quedan los demás */
    }
    return () => quitar();
  }, [email, procesar]);

  // Los disparadores del reintento automático.
  useEffect(() => {
    if (!email) return;
    procesar();
    const alVolverRed = () => procesar();
    const alVerse = () => {
      if (document.visibilityState === 'visible') procesar();
    };
    window.addEventListener('online', alVolverRed);
    document.addEventListener('visibilitychange', alVerse);
    const reloj = window.setInterval(() => {
      if (hayPendientesRef.current && document.visibilityState === 'visible') procesar();
    }, CADA_MS);
    return () => {
      window.removeEventListener('online', alVolverRed);
      document.removeEventListener('visibilitychange', alVerse);
      window.clearInterval(reloj);
    };
  }, [email, procesar]);

  const descartar = async (p: ResumenPendiente) => {
    const texto = p.filasCreadas
      ? `La incidencia de ${p.sitio} YA existe en el sistema: solo se descartarán ` +
        `${plural(p.archivosPendientes, 'foto o video que faltaba', 'fotos o videos que faltaban')} ` +
        'por subir.\n\n¿Descartarlos?'
      : `¿Descartar el reporte de ${p.sitio}?\n\nSe borra de este teléfono y NO se enviará.`;
    if (!confirm(texto)) return;
    const r = await descartarEnvio(p.id);
    if (r === 'ocupado')
      alert('Ese reporte se está enviando en este momento. Espera a que termine e intenta de nuevo.');
    refrescar();
  };

  /** Descartar una acción = NO se aplicará (modo sin señal, 24-sep-2026). */
  const descartarUna = async (p: ResumenAccion) => {
    const faltan = p.archivos - p.ligados;
    const texto =
      `¿Descartar «${p.resumen}»?\n\nNO se aplicará: se borra de este teléfono. ` +
      'Si todavía hace falta, tendrás que hacerla otra vez.' +
      (p.archivos > 0 && faltan > 0
        ? `\n\nTambién se borran ${plural(faltan, 'foto o video', 'fotos o videos')} que no se han subido.`
        : '') +
      (p.ligados > 0 ? '\n\nLo que ya se subió se queda en la evidencia de la incidencia.' : '');
    if (!confirm(texto)) return;
    const r = await descartarAccion(p.id);
    if (r === 'ocupado')
      alert('Esa acción se está enviando en este momento. Espera a que termine e intenta de nuevo.');
    refrescar();
  };

  const n = lista.length;
  const m = acciones.length;
  if (!n && !m && !mensajes.length) return null;

  const soloFotos = n > 0 && lista.every((p) => p.filasCreadas);
  const titulo =
    n && m
      ? `📤 ${plural(n, 'reporte', 'reportes')} y ${plural(m, 'acción', 'acciones')} sin enviar`
      : m
        ? `📤 ${plural(m, 'acción', 'acciones')} sin enviar`
        : soloFotos
          ? `📤 Fotos de ${plural(n, 'reporte', 'reportes')} sin subir`
          : `📤 ${plural(n, 'reporte', 'reportes')} sin enviar`;
  const enRiesgo =
    lista.some((p) => p.soloMemoria || p.fueraDelTelefono > 0) ||
    acciones.some((p) => p.soloMemoria || p.fueraDelTelefono > 0);

  const renglon = {
    // El borde de .banner, con su pareja del tema claro (tema claro/oscuro,
    // 24-sep-2026).
    borderTop: '1px solid var(--info-borde)',
    marginTop: 8,
    paddingTop: 8,
    display: 'flex',
    gap: 10,
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  } as const;

  return (
    <div className="banner" style={{ margin: '10px 16px 0' }} role="status">
      {mensajes.map((msg, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            marginBottom: 6,
            color: 'var(--warn)',
          }}
        >
          <span style={{ minWidth: 0 }}>{msg}</span>
          <button
            type="button"
            className="btn ghost sm"
            aria-label="Cerrar aviso"
            onClick={() => setMensajes((ms) => ms.filter((_, j) => j !== i))}
            style={{ flexShrink: 0 }}
          >
            ✕
          </button>
        </div>
      ))}

      {n + m > 0 && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ flex: '1 1 220px', minWidth: 0 }}>
              <b>{titulo}</b> ·{' '}
              {trabajando ? 'enviando…' : 'se reintenta solo al volver la señal'}
            </span>
            <button
              type="button"
              className="btn sm"
              // Se puede tocar mientras alguna cola con pendientes esté
              // parada (la otra puede seguir con un video lento).
              disabled={(!n || enviandoReportes) && (!m || enviandoAcciones)}
              onClick={() => procesar()}
            >
              {trabajando && <span className="spinner" />} Reintentar ahora
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setAbierto((a) => !a)}
              aria-expanded={abierto}
            >
              {abierto ? 'Ocultar' : 'Ver detalle'}
            </button>
          </div>
          {enRiesgo && (
            <div style={{ marginTop: 6, color: 'var(--warn)' }}>
              ⚠️ Parte de esto no cupo en el teléfono: no cierres la app hasta que se envíe.
            </div>
          )}

          {abierto &&
            lista.map((p) => (
              <div key={p.id} style={renglon}>
                {/* minWidth:0: una clave de sitio larga encoge en vez de
                    empujar el botón fuera del aviso. */}
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <div style={{ fontWeight: 700 }}>{p.sitio}</div>
                  <div>
                    {plural(p.partidas, 'partida', 'partidas')} ·{' '}
                    {plural(p.filas, 'cara', 'caras')} · {hora(p.creado_en)}
                    {p.enviando && ' · enviando…'}
                  </div>
                  {p.filasCreadas && (
                    <div>
                      La incidencia ya se creó; faltan{' '}
                      {plural(p.archivosPendientes, 'archivo', 'archivos')}.
                    </div>
                  )}
                  {p.soloMemoria && (
                    <div style={{ color: 'var(--warn)' }}>
                      No se pudo guardar en el teléfono: si cierras la app, se pierde.
                    </div>
                  )}
                  {!p.soloMemoria && p.fueraDelTelefono > 0 && (
                    <div style={{ color: 'var(--warn)' }}>
                      {plural(p.fueraDelTelefono, 'archivo no cupo', 'archivos no cupieron')} en
                      el teléfono: si cierras la app, habrá que subirlos de nuevo.
                    </div>
                  )}
                  {p.ultimoError && (
                    <div style={{ opacity: 0.75 }}>Último intento: {p.ultimoError}</div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={p.enviando || enviandoReportes}
                  onClick={() => descartar(p)}
                  style={{ flexShrink: 0 }}
                >
                  Descartar
                </button>
              </div>
            ))}

          {abierto &&
            acciones.map((p) => (
              <div key={p.id} style={renglon}>
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <div style={{ fontWeight: 700 }}>{p.resumen}</div>
                  <div>
                    {hora(p.creado_en)}
                    {p.archivos > 0 &&
                      ` · ${plural(p.archivos, 'foto o video', 'fotos o videos')}` +
                        (p.ligados > 0 ? ` (${p.ligados} ya subidos)` : '')}
                    {p.enviando && ' · enviando…'}
                  </div>
                  {p.soloMemoria && (
                    <div style={{ color: 'var(--warn)' }}>
                      No se pudo guardar en el teléfono: si cierras la app, se pierde.
                    </div>
                  )}
                  {!p.soloMemoria && p.fueraDelTelefono > 0 && (
                    <div style={{ color: 'var(--warn)' }}>
                      {plural(p.fueraDelTelefono, 'archivo no cupo', 'archivos no cupieron')} en
                      el teléfono: si cierras la app, se pierden.
                    </div>
                  )}
                  {p.ultimoError &&
                    (p.conError ? (
                      <div style={{ color: 'var(--warn)' }}>No se pudo aplicar: {p.ultimoError}</div>
                    ) : (
                      <div style={{ opacity: 0.75 }}>Último intento: {p.ultimoError}</div>
                    ))}
                </div>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={p.enviando || enviandoAcciones}
                  onClick={() => descartarUna(p)}
                  style={{ flexShrink: 0 }}
                >
                  Descartar
                </button>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

export default EnviosPendientes;
