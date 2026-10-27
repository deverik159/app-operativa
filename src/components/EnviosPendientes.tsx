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
//
// MIS RUTAS (rutas, 5-oct-2026): una tercera cola, la de VISITAS del
// monitorista (lib/visitas.ts: "Marcar visita" sin señal), con los mismos
// disparadores, su propia vuelta y su propio descartar.
//
// TOMAS DE PAUTA (fase 1 de comprobaciones, 22-oct-2026): una cuarta cola,
// la de las fotos de la toma (lib/tomasPauta.ts), con los mismos
// disparadores. Una subida normal NO se pinta aquí (sería un aviso por cada
// foto): solo lo que pide atención (`atencion`: un error, algo que no cupo
// en el teléfono o un intento que ya falló). Pero TODO cuenta para los
// reintentos (hayPendientesRef). Cuando una toma termina, el aviso breve
// (components/AvisoBreve) lo dice unos segundos y se recargan las listas.
//
// TOMAS DE COMPROBACIONES (fase 3, incremento 2, 26-oct-2026; especificación
// §6.3 y B9): una quinta cola, la de las fotos de Mis rutas › Comprobaciones
// (lib/colaFotos/adaptadorComp), con el mismo patrón correr(...) de Pauta y
// los mismos disparadores. Igual que en Pauta solo se pintan las visitas que
// piden atención, pero todas cuentan para los reintentos. Sus avisos llegan
// con TIPO (objetos, no textos): un 'regreso' recarga la lista sin buscar
// nada en el texto. Su aviso breve («✓ COL_551 · 6 fotos arriba · 3 tomas
// enviadas») es otra píldora con sus propias funciones (AvisoBreve por props).
// ============================================================
import { Camera, MapPin } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sb } from '../lib/supabase';
import Ic from './Ic';
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
import {
  descartarVisita,
  listarVisitasAviso,
  procesarVisitasPendientes,
  suscribirVisitas,
  tomarAvisosVisitas,
  type ResumenVisita,
} from '../lib/visitas';
import {
  descartarToma,
  ligadasHastaAhora,
  listarTomasAviso,
  procesarTomasPendientes,
  suscribirTomas,
  tomarAvisosTomas,
  tomarLogrosTomas,
  type ResumenTomaAviso,
} from '../lib/tomasPauta';
import { textoLogro, type Logro } from '../lib/tomasPautaLogica';
import { logrosPorMostrar as porMostrarPauta } from '../lib/tomasPauta';
import {
  descartarTomaComp,
  listarTomasCompAviso,
  logrosPorMostrarComp,
  procesarTomasCompPendientes,
  quitadasHastaAhora,
  suscribirTomasComp,
  textoLogroComp,
  tomarAvisosTomasComp,
  tomarLogrosTomasComp,
  type AvisoCola,
  type LogroComp,
  type ResumenAvisoCola,
} from '../lib/colaFotos/adaptadorComp';
import AvisoBreve from './AvisoBreve';
import LimiteSilencioso from './LimiteSilencioso';

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

/** ¿El aviso de la cola de tomas dice que el analista regresó la toma? */
const esRegreso = (m: string) => /regresó la toma/.test(m);

/** Los avisos de Comprobaciones vienen con tipo: aquí solo hace falta su texto. */
const textosComp = (l: AvisoCola[]) => l.map((a) => a.texto);

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
  const [visitas, setVisitas] = useState<ResumenVisita[]>([]);
  /** Todos los trabajos de la cola de tomas (se pintan solo los que piden atención). */
  const [tomas, setTomas] = useState<ResumenTomaAviso[]>([]);
  /** Tomas que terminaron y aún no se muestran en el aviso breve. */
  const [logros, setLogros] = useState<Logro[]>([]);
  /** Visitas de Comprobaciones (5.ª cola; se pintan solo las que piden atención). */
  const [tomasComp, setTomasComp] = useState<ResumenAvisoCola[]>([]);
  const [logrosComp, setLogrosComp] = useState<LogroComp[]>([]);
  const [abierto, setAbierto] = useState(false);
  // Una bandera por cola (verificación de la revisión sin señal,
  // 24-sep-2026): con un video lento en la de acciones, la de reportes se
  // puede reintentar y descartar.
  const [enviandoReportes, setEnviandoReportes] = useState(false);
  const [enviandoAcciones, setEnviandoAcciones] = useState(false);
  const [enviandoVisitas, setEnviandoVisitas] = useState(false);
  const [enviandoTomas, setEnviandoTomas] = useState(false);
  const [enviandoComp, setEnviandoComp] = useState(false);
  const trabajando = enviandoReportes || enviandoAcciones || enviandoVisitas || enviandoTomas || enviandoComp;
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
  const vueltaVisitasRef = useRef<Promise<void> | null>(null);
  const vueltaTomasRef = useRef<Promise<void> | null>(null);
  const vueltaCompRef = useRef<Promise<void> | null>(null);
  /** Lo último que se pintó de las tres colas (ver refrescar). */
  const firmaListasRef = useRef('');
  /** Las dos colas que terminan casi juntas piden UNA recarga de listas, no dos. */
  const relojRecarga = useRef<number | undefined>(undefined);
  /** Cuándo toca la recarga pedida (para no aplazar una que va antes). */
  const recargaEnRef = useRef(0);
  /** Lo último visto de ligadasHastaAhora (ver refrescar). */
  const ligadasVistasRef = useRef(ligadasHastaAhora());
  /** Lo último visto de quitadasHastaAhora (Comprobaciones; ver refrescar). */
  const quitadasVistasRef = useRef(quitadasHastaAhora());
  useEffect(
    () => () => {
      window.clearTimeout(relojRecarga.current);
      // Si no, tras un remontaje (Fast Refresh) ninguna recarga volvía a pedirse.
      relojRecarga.current = undefined;
    },
    []
  );

  /**
   * Pide a App recargar las listas, como con ↻. Pronta cuando algo cambió de
   * estado (salió un reporte, se registró una toma). Las fotos sueltas que
   * terminan de subir no cambian el estado de la toma: su recarga se difiere
   * y espera a que no haya una ventana abierta (el monitorista suele seguir
   * tomando fotos; revisión del código, 22-oct-2026).
   */
  const pedirRecarga = useCallback((diferida: boolean) => {
    const espera = diferida ? 10_000 : 300;
    const en = Date.now() + espera;
    if (relojRecarga.current !== undefined && recargaEnRef.current <= en) return;
    window.clearTimeout(relojRecarga.current);
    const disparar = () => {
      if (diferida && document.querySelector('.overlay')) {
        recargaEnRef.current = Date.now() + espera;
        relojRecarga.current = window.setTimeout(disparar, espera);
        return;
      }
      relojRecarga.current = undefined;
      onEnviadoRef.current();
    };
    recargaEnRef.current = en;
    relojRecarga.current = window.setTimeout(disparar, espera);
  }, []);

  /** Suma avisos sin repetir los que ya se ven. */
  const sumarMensajes = useCallback((nuevos: string[]) => {
    if (!nuevos.length) return;
    setMensajes((m) => {
      const sin = [...new Set(nuevos)].filter((x) => !m.includes(x));
      return sin.length ? [...m, ...sin] : m;
    });
  }, []);

  // El borrador del alta usa este correo de respaldo cuando auth-js no da
  // la sesión a tiempo (sin red y con el token vencido).
  useEffect(() => {
    registrarEmailActivo(email);
  }, [email]);

  const refrescar = useCallback(async () => {
    try {
      const [l, la, lv, lt, lc] = await Promise.all([
        listarPendientes(email),
        listarAccionesAviso(email),
        // Una cola de visitas que no carga no debe esconder las otras dos.
        listarVisitasAviso(email).catch(() => [] as ResumenVisita[]),
        // Ni una de tomas (22-oct-2026).
        listarTomasAviso(email).catch(() => [] as ResumenTomaAviso[]),
        // Ni la de Comprobaciones (26-oct-2026).
        listarTomasCompAviso(email).catch(() => [] as ResumenAvisoCola[]),
      ]);
      // Las tomas cuentan TODAS para los reintentos (cada 2 min, sesión
      // renovada), aunque solo se pinten las que piden atención.
      hayPendientesRef.current = l.length + la.length + lv.length + lt.length + lc.length > 0;
      // (rutas, 5-oct-2026, revisión) Regla anti-congelamiento del 24-sep:
      // un setState tras una lectura local se compara con un ref. Si las
      // listas dicen lo mismo que la vez pasada, no se re-renderiza.
      const firma = JSON.stringify([l, la, lv, lt, lc]);
      if (firma !== firmaListasRef.current) {
        firmaListasRef.current = firma;
        setLista(l);
        setAcciones(la);
        setVisitas(lv);
        setTomas(lt);
        setTomasComp(lc);
      }
      // Avisos de acciones que se mandaron por su cuenta (p. ej. una previa
      // de la misma incidencia antes de la que se acaba de tocar). Solo los
      // de este correo (revisión sin señal, 24-sep-2026: teléfono compartido).
      const deTomas = tomarAvisosTomas(email);
      const buzon = [...tomarAvisosAcciones(email), ...tomarAvisosVisitas(email), ...deTomas];
      sumarMensajes(buzon);
      // Una toma regresada: la lista se recarga para que la ventana vea el
      // motivo (y no vuelva a chocar con "regresada" al registrar).
      if (deTomas.some(esRegreso)) pedirRecarga(false);
      // Tomas que terminaron (aquí o en el primer intento al encolar): el
      // aviso breve y la recarga de las listas (Pauta deja de verla pendiente).
      const nuevos = tomarLogrosTomas(email);
      if (nuevos.length) {
        setLogros((prev) => [...prev, ...nuevos]);
        pedirRecarga(!nuevos.some((l) => l.registrada));
      }
      // Comprobaciones (26-oct-2026): avisos con tipo y logros por visita. Un
      // regreso recarga ya; un logro con tomas enviadas también; si solo
      // subieron fotos, diferido (el monitorista suele seguir tomando).
      const deComp = tomarAvisosTomasComp(email);
      sumarMensajes(textosComp(deComp));
      if (deComp.some((a) => a.tipo === 'regreso')) pedirRecarga(false);
      const nuevosComp = tomarLogrosTomasComp(email);
      if (nuevosComp.length) {
        setLogrosComp((prev) => [...prev, ...nuevosComp]);
        pedirRecarga(!nuevosComp.some((x) => x.tomas > 0));
      }
      // Entró una foto de una toma que sigue en cola (sin logro todavía): la
      // lista se recarga diferido para que su cuenta no se quede desfasada.
      const ligadas = ligadasHastaAhora();
      if (ligadas !== ligadasVistasRef.current) {
        ligadasVistasRef.current = ligadas;
        pedirRecarga(true);
      }
      // Comprobaciones (26-oct-2026): una foto que la cola ya quitó del
      // servidor (entera o de una toma) cambia lo que `tiene` cada toma; la
      // tarjeta ya la descuenta y la lista se relee diferido.
      const quitadas = quitadasHastaAhora();
      if (quitadas !== quitadasVistasRef.current) {
        quitadasVistasRef.current = quitadas;
        pedirRecarga(true);
      }
    } catch {
      /* el aviso nunca debe romper la app */
    }
  }, [email, pedirRecarga, sumarMensajes]);

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
          sumarMensajes(r.mensajes);
          // Salió al menos uno (o ya existe su incidencia, o una acción ya
          // no aplica): que App recargue las listas, como con ↻.
          if (r.recargar) pedirRecarga(false);
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
      correr(vueltaVisitasRef, setEnviandoVisitas, async () => {
        const r = await procesarVisitasPendientes(email);
        return { mensajes: r.mensajes, recargar: r.terminadas > 0 };
      }),
      correr(vueltaTomasRef, setEnviandoTomas, async () => {
        const r = await procesarTomasPendientes(email);
        // Solo un registro (o un regreso) cambia la toma; las fotos sueltas
        // recargan diferido por su logro (ver refrescar).
        return { mensajes: r.mensajes, recargar: r.registradas > 0 || r.mensajes.some(esRegreso) };
      }),
      // La 5.ª cola (Comprobaciones, 26-oct-2026): el regreso se reconoce por
      // su tipo; lo terminado recarga por su logro (ver refrescar).
      correr(vueltaCompRef, setEnviandoComp, async () => {
        const r = await procesarTomasCompPendientes(email);
        return { mensajes: textosComp(r.mensajes), recargar: r.mensajes.some((a) => a.tipo === 'regreso') };
      }),
    ]).then(() => undefined);
  }, [email, refrescar, pedirRecarga, sumarMensajes]);

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
    const quitarVisitas = suscribirVisitas(alCambiar);
    const quitarTomas = suscribirTomas(alCambiar);
    const quitarComp = suscribirTomasComp(alCambiar);
    refrescar();
    return () => {
      quitarEnvios();
      quitarAcciones();
      quitarVisitas();
      quitarTomas();
      quitarComp();
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

  /** Descartar una visita = NO se registrará (rutas, 5-oct-2026). */
  const descartarVis = async (p: ResumenVisita) => {
    const texto =
      `¿Descartar la visita a ${p.site_id}?\n\nNO se registrará: se borra de este teléfono ` +
      'con sus fotos. Si todavía hace falta, vuelve a marcarla en Mis rutas.';
    if (!confirm(texto)) return;
    const r = await descartarVisita(p.id);
    if (r === 'ocupado')
      alert('Esa visita se está enviando en este momento. Espera a que termine e intenta de nuevo.');
    refrescar();
  };

  /** Descartar una toma = lo que no subió se borra del teléfono (22-oct-2026). */
  const descartarTom = async (p: ResumenTomaAviso) => {
    const faltan = Math.max(0, p.archivos - p.ligados);
    const texto =
      `¿Descartar la toma de ${p.resumen}?\n\n` +
      (faltan > 0
        ? `Se borran de este teléfono ${plural(faltan, 'foto o video que no se ha subido', 'fotos o videos que no se han subido')}. `
        : '') +
      (p.ligados > 0 ? 'Lo que ya subió se queda en la evidencia de la toma. ' : '') +
      (p.registrarPedido ? 'La toma NO quedará registrada: hazlo desde Pauta cuando tengas las fotos.' : '');
    if (!confirm(texto)) return;
    const r = await descartarToma(p.id);
    if (r === 'ocupado')
      alert('Esa toma se está enviando en este momento. Espera a que termine e intenta de nuevo.');
    refrescar();
  };

  /** Descartar una visita de Comprobaciones = lo que no subió se borra del teléfono (26-oct-2026). */
  const descartarComp = async (p: ResumenAvisoCola) => {
    const faltan = Math.max(0, p.archivos - p.ligados);
    const texto =
      `¿Descartar las fotos de ${p.resumen}?\n\n` +
      (faltan > 0
        ? `Se borran de este teléfono ${plural(faltan, 'foto o video que no se ha subido', 'fotos o videos que no se han subido')}. `
        : '') +
      (p.ligados > 0 ? 'Lo que ya subió se queda en sus tomas. ' : '') +
      (p.registrarPedido ? 'Las tomas que faltaba enviar NO se envían: hazlo con «Listo con este sitio» en Mis rutas.' : '');
    if (!confirm(texto)) return;
    const r = await descartarTomaComp(p.id);
    if (r === 'ocupado')
      alert('Esas fotos se están enviando en este momento. Espera a que termine e intenta de nuevo.');
    refrescar();
  };

  const mostrados = useCallback((k: number) => setLogros((prev) => prev.slice(k)), []);
  const mostradosComp = useCallback((k: number) => setLogrosComp((prev) => prev.slice(k)), []);
  const aviso = (
    <>
      <LimiteSilencioso nombre="aviso-breve">
        <AvisoBreve<Logro> logros={logros} onMostrados={mostrados} porMostrar={porMostrarPauta} texto={textoLogro} />
      </LimiteSilencioso>
      <LimiteSilencioso nombre="aviso-breve-comp">
        <AvisoBreve<LogroComp>
          logros={logrosComp}
          onMostrados={mostradosComp}
          porMostrar={logrosPorMostrarComp}
          texto={textoLogroComp}
        />
      </LimiteSilencioso>
    </>
  );

  const n = lista.length;
  const m = acciones.length;
  const nv = visitas.length;
  // De las tomas solo se pintan las que piden atención (ver cabecera).
  const tomasVisibles = tomas.filter((p) => p.atencion);
  const nt = tomasVisibles.length;
  // Lo mismo con las visitas de Comprobaciones (26-oct-2026).
  const compVisibles = tomasComp.filter((p) => p.atencion);
  const nc = compVisibles.length;
  if (!n && !m && !nv && !nt && !nc && !mensajes.length) return aviso;

  const soloFotos = n > 0 && lista.every((p) => p.filasCreadas);
  // "📤 1 reporte, 2 acciones y 3 visitas sin enviar" (rutas, 5-oct-2026):
  // las partes que haya, unidas en español.
  const partes = [
    ...(n ? [plural(n, 'reporte', 'reportes')] : []),
    ...(m ? [plural(m, 'acción', 'acciones')] : []),
    ...(nv ? [plural(nv, 'visita', 'visitas')] : []),
    ...(nt ? [plural(nt, 'toma', 'tomas')] : []),
    ...(nc ? [plural(nc, 'sitio de Comprobaciones', 'sitios de Comprobaciones')] : []),
  ];
  const unidas =
    partes.length > 1 ? `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}` : partes[0];
  const titulo =
    n && !m && !nv && !nt && !nc && soloFotos
      ? `📤 Fotos de ${plural(n, 'reporte', 'reportes')} sin subir`
      : `📤 ${unidas} sin enviar`;
  const enRiesgo =
    lista.some((p) => p.soloMemoria || p.fueraDelTelefono > 0) ||
    acciones.some((p) => p.soloMemoria || p.fueraDelTelefono > 0) ||
    visitas.some((p) => p.soloMemoria || p.fueraDelTelefono > 0) ||
    tomas.some((p) => p.soloMemoria || p.fueraDelTelefono > 0) ||
    tomasComp.some((p) => p.soloMemoria || p.fueraDelTelefono > 0);

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
    <>
    {aviso}
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

      {n + m + nv + nt + nc > 0 && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ flex: '1 1 220px', minWidth: 0 }}>
              <b>{titulo}</b> ·{' '}
              {/* (rutas, 5-oct-2026, QA) Un error definitivo (sin permiso,
                  ruta retirada) no sale solo: no prometer que sí. */}
              {trabajando
                ? 'enviando…'
                : acciones.some((p) => p.conError) ||
                    visitas.some((p) => p.conError) ||
                    tomasVisibles.some((p) => p.conError) ||
                    compVisibles.some((p) => p.conError)
                  ? 'hay envíos que no salen solos: toca «Ver detalle»'
                  : 'se reintenta solo al volver la señal'}
            </span>
            <button
              type="button"
              className="btn sm"
              // Se puede tocar mientras alguna cola con pendientes esté
              // parada (la otra puede seguir con un video lento).
              disabled={
                (!n || enviandoReportes) &&
                (!m || enviandoAcciones) &&
                (!nv || enviandoVisitas) &&
                (!nt || enviandoTomas) &&
                (!nc || enviandoComp)
              }
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

          {abierto &&
            visitas.map((p) => (
              <div key={p.id} style={renglon}>
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <div style={{ fontWeight: 700 }}><Ic i={MapPin} />{p.resumen}</div>
                  <div>
                    Visita de las {hora(p.visitado_en)} · {plural(p.fotos, 'foto', 'fotos')}
                    {p.subidas > 0 && ` (${p.subidas} ya subidas)`}
                    {p.enviando && ' · enviando…'}
                  </div>
                  {p.soloMemoria && (
                    <div style={{ color: 'var(--warn)' }}>
                      No se pudo guardar en el teléfono: si cierras la app, se pierde.
                    </div>
                  )}
                  {!p.soloMemoria && p.fueraDelTelefono > 0 && (
                    <div style={{ color: 'var(--warn)' }}>
                      {plural(p.fueraDelTelefono, 'foto no cupo', 'fotos no cupieron')} en el
                      teléfono: si cierras la app, se pierden.
                    </div>
                  )}
                  {p.ultimoError &&
                    (p.conError ? (
                      <div style={{ color: 'var(--warn)' }}>No se pudo registrar: {p.ultimoError}</div>
                    ) : (
                      <div style={{ opacity: 0.75 }}>Último intento: {p.ultimoError}</div>
                    ))}
                </div>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={p.enviando || enviandoVisitas}
                  onClick={() => descartarVis(p)}
                  style={{ flexShrink: 0 }}
                >
                  Descartar
                </button>
              </div>
            ))}

          {abierto && (
            <LimiteSilencioso nombre="aviso-tomas">
              {tomasVisibles.map((p) => (
                <div key={p.id} style={renglon}>
                  <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    <div style={{ fontWeight: 700 }}>
                      <Ic i={Camera} />Toma de {p.resumen}
                    </div>
                    <div>
                      {hora(p.creado_en)}
                      {p.archivos > 0 &&
                        ` · ${plural(p.archivos, 'foto o video', 'fotos o videos')}` +
                          (p.ligados > 0 ? ` (${p.ligados} ya subidos)` : '')}
                      {p.registrarPedido && ' · se registra al subir'}
                      {p.enviando && ' · enviando…'}
                    </div>
                    {p.soloMemoria && (
                      <div style={{ color: 'var(--warn)' }}>
                        No se pudo guardar en el teléfono: si cierras la app, se pierde.
                      </div>
                    )}
                    {!p.soloMemoria && p.fueraDelTelefono > 0 && (
                      <div style={{ color: 'var(--warn)' }}>
                        {plural(p.fueraDelTelefono, 'foto no cupo', 'fotos no cupieron')} en el
                        teléfono: si cierras la app, se pierden.
                      </div>
                    )}
                    {p.ultimoError &&
                      (p.conError ? (
                        <div style={{ color: 'var(--warn)' }}>{p.ultimoError}</div>
                      ) : (
                        <div style={{ opacity: 0.75 }}>Último intento: {p.ultimoError}</div>
                      ))}
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={p.enviando || enviandoTomas}
                    onClick={() => descartarTom(p)}
                    style={{ flexShrink: 0 }}
                  >
                    Descartar
                  </button>
                </div>
              ))}
            </LimiteSilencioso>
          )}

          {abierto && (
            <LimiteSilencioso nombre="aviso-tomas-comp">
              {compVisibles.map((p) => (
                <div key={p.id} style={renglon}>
                  <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    <div style={{ fontWeight: 700 }}>
                      <Ic i={Camera} />Comprobaciones · {p.resumen}
                    </div>
                    <div>
                      {hora(p.creado_en)}
                      {p.archivos > 0 &&
                        ` · ${plural(p.archivos, 'foto o video', 'fotos o videos')}` +
                          (p.ligados > 0 ? ` (${p.ligados} ya subidos)` : '')}
                      {p.registrarPedido && ' · se envía al subir'}
                      {p.enviando && ' · enviando…'}
                    </div>
                    {p.soloMemoria && (
                      <div style={{ color: 'var(--warn)' }}>
                        No se pudo guardar en el teléfono: si cierras la app, se pierde.
                      </div>
                    )}
                    {!p.soloMemoria && p.fueraDelTelefono > 0 && (
                      <div style={{ color: 'var(--warn)' }}>
                        {plural(p.fueraDelTelefono, 'foto no cupo', 'fotos no cupieron')} en el
                        teléfono: si cierras la app, se pierden.
                      </div>
                    )}
                    {p.ultimoError &&
                      (p.conError ? (
                        <div style={{ color: 'var(--warn)' }}>{p.ultimoError}</div>
                      ) : (
                        <div style={{ opacity: 0.75 }}>Último intento: {p.ultimoError}</div>
                      ))}
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={p.enviando || enviandoComp}
                    onClick={() => descartarComp(p)}
                    style={{ flexShrink: 0 }}
                  >
                    Descartar
                  </button>
                </div>
              ))}
            </LimiteSilencioso>
          )}
        </>
      )}
    </div>
    </>
  );
}

export default EnviosPendientes;
