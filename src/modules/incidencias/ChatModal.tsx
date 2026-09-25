// ============================================================
// src/modules/incidencias/ChatModal.tsx
// Chat por incidencia sobre la tabla `mensajes`, con Realtime de Supabase.
// Al recibir un mensaje ajeno marca leídas sus notificaciones, para que el
// globito del botón 💬 se apague solo mientras el chat está abierto.
//
// Estilo WhatsApp (25-sep-2026): abre en el ÚLTIMO mensaje y lo sigue
// mientras se esté al final; si se sube a leer, lo nuevo no jala la vista
// y se avisa con el botón ⬇. Cada mensaje se puede responder (↩︎) con su
// cita, lo propio se corrige dentro de su burbuja (✏️), ✓/✓✓ dicen si
// alguien más ya lo vio (chat_lecturas) y un hilo largo abre compacto:
// solo lo reciente a la vista.
// ============================================================
import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { sb } from '../../lib/supabase';
import { caraIncidencia, sinAcentos } from '../../lib/helpers';
import {
  validarAdjunto,
  subirAdjunto,
  MAX_VIDEO_SEG,
} from '../../lib/adjuntosChat';
import { comprimirImagen } from '../../lib/comprimirImagen';
import type {
  Incidencia,
  Mensaje,
  ChatAdjunto,
  ChatLectura,
} from '../../types/db';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { vigilarRender } from '../../lib/vigia';

type Props = {
  inc: Incidencia;
  email: string;
  nombre: string;
  onClose: () => void;
};

/**
 * Un hilo de más de LARGO mensajes abre COMPACTO: solo los VENTANA más
 * recientes a la vista, y "Ver anteriores" trae los de antes de VENTANA en
 * VENTANA. En celular pintar cientos de burbujas con fotos al abrir es lo
 * que más cuesta, y lo que se consulta casi siempre es lo último.
 */
const LARGO = 30;
const VENTANA = 20;
/** A menos de esta distancia del fondo (px) se considera "al final". */
const PEGADO_PX = 80;

type TrasVentana =
  | { tipo: 'ancla'; alto: number; top: number }
  | { tipo: 'final' };

/**
 * Caja de una foto o video del hilo, con su tamaño decidido ANTES de que
 * cargue — si no, el hilo brinca al llegar cada archivo:
 *  · ancho fijo (lo acota la burbuja con maxWidth): con '100%' la burbuja
 *    se ajustaba al texto mientras cargaba y se ensanchaba al llegar;
 *  · la proporción REAL del archivo (chat_adjuntos.ancho/alto; 4:3 en los
 *    adjuntos sin medidas);
 *  · contain y no cover: el tope de 240px no recorta — en una foto de
 *    evidencia el daño puede estar justo en la orilla.
 */
const cajaMedio = (a: ChatAdjunto): React.CSSProperties => ({
  marginTop: 6,
  display: 'block',
  width: 320,
  maxWidth: '100%',
  aspectRatio: a.ancho && a.alto ? `${a.ancho} / ${a.alto}` : '4 / 3',
  maxHeight: 240,
  objectFit: 'contain',
  borderRadius: 8,
});

const nombreLector = (l: ChatLectura) => l.usuario_nombre || l.usuario_email;

/**
 * Hora de la burbuja, como WhatsApp: "10:32" hoy, "24/9 10:32" otro día
 * (con año si no es el actual). La fecha completa con segundos no cabía
 * junto a ✓ ↩︎ ✏️ en una burbuja corta.
 */
function horaMensaje(iso: string): string {
  const d = new Date(iso);
  const hora = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const hoy = new Date();
  if (d.toDateString() === hoy.toDateString()) return hora;
  const fecha =
    d.getFullYear() === hoy.getFullYear()
      ? `${d.getDate()}/${d.getMonth() + 1}`
      : `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  return `${fecha} ${hora}`;
}

/** "hace 5 min", "hoy 10:32", "ayer 18:02", "24/9 18:02". */
function cuando(iso: string): string {
  const d = new Date(iso);
  const seg = (Date.now() - d.getTime()) / 1000;
  if (seg < 60) return 'hace un momento';
  if (seg < 3600) return `hace ${Math.floor(seg / 60)} min`;
  const hora = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const hoy = new Date();
  const ayer = new Date();
  ayer.setDate(hoy.getDate() - 1);
  if (d.toDateString() === hoy.toDateString()) return `hoy ${hora}`;
  if (d.toDateString() === ayer.toDateString()) return `ayer ${hora}`;
  return `${d.getDate()}/${d.getMonth() + 1} ${hora}`;
}

function ChatModal({ inc, email, nombre, onClose }: Props) {
  vigilarRender('ChatModal');
  const [msgs, setMsgs] = useState<Mensaje[]>([]);
  const [texto, setTexto] = useState('');
  const [loading, setLoading] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  /** El contenido de la caja: su alto cambia cuando llegan fotos o mensajes. */
  const contRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const esMio = (m: Mensaje) =>
    (m.autor_email || '').toLowerCase() === email.toLowerCase();
  const autorDe = (m: Mensaje) =>
    esMio(m) ? 'Tú' : m.autor_nombre || m.autor_email || 'Alguien';

  /** Mensaje propio que se corrige dentro de su burbuja. null = ninguno. */
  const [editando, setEditando] = useState<Mensaje | null>(null);
  const [textoEd, setTextoEd] = useState('');
  const [errEd, setErrEd] = useState('');
  const [guardandoEd, setGuardandoEd] = useState(false);
  /** Mensaje al que se está respondiendo. null = mensaje suelto. */
  const [respondiendo, setRespondiendo] = useState<Mensaje | null>(null);
  /** Espejos para el catch de enviar, que corre con el estado del envío. */
  const textoRef = useRef('');
  textoRef.current = texto;
  const respondiendoRef = useRef<Mensaje | null>(null);
  respondiendoRef.current = respondiendo;

  /** Quién vio este chat, hasta qué mensaje y cuándo (sin la fila propia). */
  const [lecturas, setLecturas] = useState<ChatLectura[]>([]);
  /** false = la base aún no tiene chat_lecturas: no se pintan ✓ ni ✓✓. */
  const [conLecturas, setConLecturas] = useState(false);
  /** Burbuja propia con el detalle "Visto por…" abierto. */
  const [verVistos, setVerVistos] = useState<number | null>(null);
  // "hace 5 min" se recalcula al pintar: un repintado por minuto lo
  // mantiene al día mientras el chat sigue abierto sin actividad.
  const [, setReloj] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setReloj((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);
  // Para quien NO tiene fila en chat_lecturas (hilos de antes de esta
  // función, incidencias que nadie vuelve a abrir, la app vieja en caché):
  // haber escrito el mensaje N es haber visto lo anterior. Sin esto, un
  // mensaje ya contestado justo debajo decía "Nadie lo ha visto todavía",
  // y el chat se usa en disputas. Con margen de 10 s: dos mensajes que se
  // cruzan (cada quien escribió sin haber recibido el del otro) no cuentan.
  // Quien SÍ tiene fila se juzga solo por ella — la escribe su propia app
  // cuando de verdad tuvo lo último a la vista.
  const otrasLecturas = useMemo(() => {
    const yo = email.toLowerCase();
    const t = (s: string) => Date.parse(s) || 0;
    const porEmail = new Map<string, ChatLectura>();
    lecturas.forEach((l) => {
      const k = l.usuario_email.toLowerCase();
      if (k !== yo) porEmail.set(k, l);
    });
    const ultimoDe = new Map<string, Mensaje>();
    msgs.forEach((m) => {
      const k = (m.autor_email || '').toLowerCase();
      if (!k || k === yo || porEmail.has(k)) return;
      const u = ultimoDe.get(k);
      if (!u || m.id > u.id) ultimoDe.set(k, m);
    });
    ultimoDe.forEach((n, k) => {
      const limite = t(n.creado_en) - 10_000;
      let hasta = 0;
      msgs.forEach((m) => {
        if (t(m.creado_en) <= limite && m.id > hasta) hasta = m.id;
      });
      if (!hasta) return;
      porEmail.set(k, {
        record_id: n.record_id,
        usuario_email: k,
        usuario_nombre: n.autor_nombre,
        ultimo_id: hasta,
        visto_en: n.creado_en,
      });
    });
    return [...porEmail.values()].sort((a, b) => t(b.visto_en) - t(a.visto_en));
  }, [lecturas, msgs, email]);

  /** Búsqueda en el hilo: filtra por texto y autor, sin acentos. */
  const [buscar, setBuscar] = useState('');
  const busca = buscar.trim();
  // Espejos para lo que corre fuera del render actual (temporizadores,
  // listeners registrados una sola vez, el regreso de un await).
  const buscaRef = useRef('');
  buscaRef.current = busca;
  const editandoIdRef = useRef<number | null>(null);
  editandoIdRef.current = editando?.id ?? null;

  /** Hilo compacto: id del primer mensaje a la vista. null = completo. */
  const [desdeId, setDesdeId] = useState<number | null>(null);
  const idxDesde =
    desdeId == null ? 0 : Math.max(0, msgs.findIndex((m) => m.id === desdeId));
  // La búsqueda recorre el hilo COMPLETO: lo compacto es solo la vista.
  const ocultos = busca ? 0 : idxDesde;
  const coincide = (m: Mensaje) =>
    sinAcentos(
      `${m.texto} ${m.autor_nombre || ''} ${m.autor_email || ''}`
    ).includes(sinAcentos(busca));
  const msgsVisibles = busca
    ? msgs.filter(coincide)
    : idxDesde > 0
      ? msgs.slice(idxDesde)
      : msgs;
  const puedeCompactar =
    !busca && msgs.length > LARGO && msgs.length - ocultos > VENTANA;

  /** Para armar las citas: el original se busca por id en el hilo. */
  const porId = useMemo(() => new Map(msgs.map((m) => [m.id, m])), [msgs]);
  // La barra "Respondiendo a…" pinta el original VIVO: si su autor lo
  // corrige mientras se escribe la respuesta, la barra lo refleja.
  const respondiendoVivo =
    respondiendo && (porId.get(respondiendo.id) ?? respondiendo);

  /** Adjuntos del hilo, agrupados por mensaje. */
  const [adjuntos, setAdjuntos] = useState<Record<number, ChatAdjunto[]>>({});
  /** Archivo elegido y aún no enviado. */
  const [pendiente, setPendiente] = useState<File | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [errAdj, setErrAdj] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Scroll ──────────────────────────────────────────────────────────
  // `pegadoRef` = la vista está al final y debe seguir lo que llegue. Vive
  // en un ref porque se consulta DESPUÉS de que el contenido creció (una
  // foto que carga, un mensaje nuevo): medir la distancia en ese momento
  // ya no dice dónde estaba el usuario. El estado solo pinta el botón ⬇.
  const pegadoRef = useRef(true);
  const [pegado, setPegado] = useState(true);
  /** Mensajes ajenos que llegaron mientras se leía más arriba. */
  const [nuevos, setNuevos] = useState(0);

  const marcarPegado = (p: boolean) => {
    pegadoRef.current = p;
    setPegado(p);
    // Con búsqueda, estar al final de los RESULTADOS no es haber visto lo
    // que llegó sin coincidir: esos siguen contados hasta limpiarla.
    if (p && !busca) {
      setNuevos(0);
      // Llegar al final (scroll, ⬇, mensaje propio) es ver lo último.
      marcarLeido();
    }
  };

  const irAlFinal = () => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
    marcarPegado(true);
  };

  const alDesplazar = () => {
    const box = boxRef.current;
    if (!box) return;
    const p = box.scrollHeight - box.scrollTop - box.clientHeight < PEGADO_PX;
    if (p !== pegadoRef.current) marcarPegado(p);
  };

  /** Si se estaba al final, se queda al final aunque el contenido crezca. */
  const pegarAbajo = () => {
    const box = boxRef.current;
    if (box && pegadoRef.current) box.scrollTop = box.scrollHeight;
  };

  // Todo lo que cambia de alto —fotos que cargan, adjuntos que llegan
  // ~600 ms después de su mensaje, el teclado de Android que encoge el
  // modal, la barra de "Respondiendo a…"— pasa por aquí.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(pegarAbajo);
    ro.observe(box);
    if (contRef.current) ro.observe(contRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(pegarAbajo, [adjuntos]);

  // Girar a horizontal (pantalla baja: el overlay pasa a desplazarse)
  // dejaba el overlay arriba, con el último mensaje y el campo fuera de
  // pantalla. Si se seguía el final, se baja como al abrir — salvo que se
  // esté escribiendo en el buscador, que vive arriba.
  const buscadorRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-height: 519px)');
    const alCambiar = (e: MediaQueryListEvent) => {
      if (!e.matches || !pegadoRef.current) return;
      if (document.activeElement === buscadorRef.current) return;
      requestAnimationFrame(() => {
        const ov = boxRef.current?.closest<HTMLElement>('.overlay');
        if (ov) ov.scrollTop = ov.scrollHeight;
      });
    };
    // addListener: Safari anterior a 14 no tiene addEventListener aquí.
    if (mq.addEventListener) mq.addEventListener('change', alCambiar);
    else mq.addListener(alCambiar);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', alCambiar);
      else mq.removeListener(alCambiar);
    };
  }, []);

  // Al abrir: al último mensaje. Después, cada mensaje nuevo: si es mío o
  // se estaba al final, se sigue; si se estaba leyendo arriba, se cuenta
  // en el botón ⬇ en vez de jalar la vista. Las ediciones no mueven nada.
  // Lo nuevo se reconoce por id y no por "el último de la lista": un
  // mensaje recuperado al reconectar entra EN MEDIO (van en orden de id), y
  // Realtime entrega en ráfaga al volver de segundo plano (React junta los
  // INSERT en un solo render).
  const conocidosRef = useRef<Set<number> | null>(null);
  useLayoutEffect(() => {
    if (loading) return;
    if (!conocidosRef.current) {
      conocidosRef.current = new Set(msgs.map((m) => m.id));
      irAlFinal();
      // En pantalla baja (horizontal) el modal no lleva tope y lo que se
      // desplaza es el overlay: también se baja, solo esta vez al abrir.
      const ov = boxRef.current?.closest<HTMLElement>('.overlay');
      if (ov && ov.scrollHeight > ov.clientHeight) ov.scrollTop = ov.scrollHeight;
      return;
    }
    const conocidos = conocidosRef.current;
    const llegados = msgs.filter((m) => !conocidos.has(m.id));
    if (!llegados.length) return;
    llegados.forEach((m) => conocidos.add(m.id));
    const ajenos = llegados.filter((m) => !esMio(m));
    // Escribiendo en una edición se trata como leer más arriba: seguir el
    // final sacaría de la vista el campo con el foco (y el teclado abierto)
    // al llegar una foto. Una edición abierta SIN foco no cuenta: se puede
    // estar escribiendo abajo, al final, y ahí sí se sigue.
    const enCampoEdicion =
      !!editando && document.activeElement === edRef.current;
    const siguiendo = pegadoRef.current && !enCampoEdicion;
    if (llegados.some(esMio) || siguiendo) {
      irAlFinal();
      // Con búsqueda activa, lo que no coincide no se pinta: se cuenta en
      // el ⬇ (que al tocarlo limpia la búsqueda) para no perderlo.
      const sinPintar = busca ? ajenos.filter((m) => !coincide(m)).length : 0;
      if (sinPintar) setNuevos((n) => n + sinPintar);
    } else {
      // También frena al ResizeObserver, que lee pegadoRef.
      if (pegadoRef.current) marcarPegado(false);
      setNuevos((n) => n + ajenos.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, msgs.length]);

  // ── Visto ───────────────────────────────────────────────────────────
  // Se marca SOLO con lo último de verdad a la vista: pestaña visible, al
  // final del hilo y sin búsqueda (un ✓✓ falso es el peor error de un
  // recibo de lectura). Momentos: al abrir, al llegar al final (marcarPegado),
  // con cada mensaje nuevo estando al final, al volver a la app, y cada
  // minuto mientras se sigue ahí — así "visto hace…" no envejece con el
  // chat abierto enfrente. El mismo mensaje se re-marca a lo más cada minuto.
  //
  // Hasta dónde se tiene el hilo SEGÚN EL SERVIDOR (`sincroRef`): avanza
  // solo con lo que llegó de la base —carga inicial, Realtime (incluido el
  // eco de lo propio) y recargarNuevos—, nunca con la respuesta HTTP de un
  // envío propio. Con el socket caído y HTTP vivo (pasar de wifi a 4G), lo
  // propio tapaba lo ajeno que se perdió: ni se recuperaba al reconectar ni
  // debe marcarse como visto. Es el MAYOR id recibido, no el último en
  // llegar: Realtime entrega en orden de commit.
  const sincroRef = useRef(0);
  const avanzarSincro = (ms: Mensaje[]) => {
    ms.forEach((m) => {
      if (m.id > sincroRef.current) sincroRef.current = m.id;
    });
  };
  const marcadoRef = useRef<{ id: number; t: number } | null>(null);
  const reintentoRef = useRef<number | undefined>(undefined);
  const intentosRef = useRef(0);
  const cargandoRef = useRef(true);
  cargandoRef.current = loading;
  /** Para no seguir reintentando ni escribir estado con el chat cerrado. */
  const montadoRef = useRef(true);
  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
      window.clearTimeout(reintentoRef.current);
    };
  }, []);
  const marcarLeido = () => {
    const id = sincroRef.current;
    if (!id || cargandoRef.current || !montadoRef.current) return;
    if (document.visibilityState === 'hidden') return;
    if (!pegadoRef.current || buscaRef.current) return;
    const prev = marcadoRef.current;
    if (prev && prev.id === id && Date.now() - prev.t < 60_000) return;
    marcadoRef.current = { id, t: Date.now() };
    sb.rpc('marcar_chat_leido', {
      p_record_id: inc.record_id,
      p_ultimo_id: id,
      p_nombre: nombre,
    }).then(({ error }) => {
      if (!error) {
        intentosRef.current = 0;
        return;
      }
      if (!montadoRef.current) return;
      // Con 4G débil lo normal es abrir, leer y cerrar sin que llegue nada
      // más: sin reintento, esa lectura nunca quedaría. 5 s, 10 s, 20 s y
      // luego cada minuto mientras el chat siga abierto.
      marcadoRef.current = null;
      const n = intentosRef.current++;
      window.clearTimeout(reintentoRef.current);
      reintentoRef.current = window.setTimeout(
        () => marcarLeido(),
        n < 3 ? 5000 * 2 ** n : 60_000
      );
    });
  };

  /**
   * Lecturas y mensajes perdidos. Realtime no reenvía lo que pasó con el
   * socket caído (iOS lo suspende con la PWA en segundo plano): al volver o
   * al reconectar se vuelve a leer, o el ✓ se quedaba sencillo y faltaban
   * mensajes hasta que llegara otro.
   */
  const recargarLecturas = () => {
    sb.from('chat_lecturas')
      .select('*')
      .eq('record_id', inc.record_id)
      .then(({ data, error }) => {
        if (error || !montadoRef.current) return;
        setLecturas((data as ChatLectura[]) || []);
        setConLecturas(true);
      });
  };
  const recargarNuevos = () => {
    // Durante la carga inicial ya se está trayendo todo. Con el hilo vacío
    // sincroRef es 0 y trae desde el principio: el primer mensaje también
    // se puede perder.
    if (cargandoRef.current) return;
    sb.from('mensajes')
      .select('*')
      .eq('record_id', inc.record_id)
      .gt('id', sincroRef.current)
      .order('id')
      .then(({ data, error }) => {
        if (error || !montadoRef.current || !data?.length) return;
        const lista = data as Mensaje[];
        avanzarSincro(lista);
        lista.forEach(add);
        cargarAdjuntos();
        // Igual que al llegar por Realtime: si se están viendo, sus avisos
        // de la campana ya no están pendientes.
        if (lista.some((m) => !esMio(m))) marcarNotifsChat();
        // Lo recuperado se marca visto solo si se quedó a la vista (al final).
        marcarLeido();
      });
  };

  useEffect(() => {
    if (!loading) marcarLeido();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, msgs.length]);
  useEffect(() => {
    const alVolver = () => {
      if (document.visibilityState !== 'visible') return;
      recargarNuevos();
      recargarLecturas();
      marcarLeido();
    };
    const alReconectar = () => marcarLeido();
    document.addEventListener('visibilitychange', alVolver);
    window.addEventListener('online', alReconectar);
    const cadaMinuto = window.setInterval(() => marcarLeido(), 60_000);
    return () => {
      document.removeEventListener('visibilitychange', alVolver);
      window.removeEventListener('online', alReconectar);
      window.clearInterval(cadaMinuto);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Al cambiar la ventana compacta: "ver anteriores" conserva lo que se
  // estaba leyendo en su lugar (lo de arriba crece, la vista no brinca);
  // "compactar" vuelve al final, que es lo que queda a la vista.
  const trasVentana = useRef<TrasVentana | null>(null);
  useLayoutEffect(() => {
    const t = trasVentana.current;
    const box = boxRef.current;
    trasVentana.current = null;
    // Se limpió la búsqueda estando al final: lo contado ya está a la vista.
    if (!busca && pegadoRef.current && !t) {
      setNuevos(0);
      marcarLeido();
    }
    if (!t || !box) return;
    if (t.tipo === 'final') {
      irAlFinal();
      return;
    }
    box.scrollTop = t.top + (box.scrollHeight - t.alto);
    // Se mide YA: si el hilo era tan corto que no tenía scroll, pegadoRef
    // seguía en true y el ResizeObserver mandaría la vista al fondo.
    alDesplazar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desdeId, busca]);

  /**
   * El ⬇. Con la búsqueda activa y mensajes nuevos, esos mensajes casi
   * nunca coinciden con el filtro: se limpia la búsqueda y se baja cuando
   * el hilo completo ya está pintado, o el aviso se apagaría sin verlos.
   */
  const tocarAbajo = () => {
    if (busca && nuevos > 0) {
      trasVentana.current = { tipo: 'final' };
      setBuscar('');
      return;
    }
    irAlFinal();
  };

  const compactar = () => {
    if (msgs.length <= VENTANA) return;
    trasVentana.current = { tipo: 'final' };
    setDesdeId(msgs[msgs.length - VENTANA].id);
  };

  const verAnteriores = (todos: boolean) => {
    const box = boxRef.current;
    if (box)
      trasVentana.current = {
        tipo: 'ancla',
        alto: box.scrollHeight,
        top: box.scrollTop,
      };
    const j = todos ? 0 : Math.max(0, idxDesde - VENTANA);
    setDesdeId(j === 0 ? null : msgs[j].id);
  };

  // Tocar una cita lleva al mensaje original y lo resalta un momento. Si la
  // búsqueda o la compactación lo esconden, primero se abre lo necesario.
  const [resaltado, setResaltado] = useState<number | null>(null);
  const resaltadoTimer = useRef<number | undefined>(undefined);
  const saltoRef = useRef<number | null>(null);
  /** Cambia en cada salto para que el efecto corra aunque se repita el id. */
  const [pulsoSalto, setPulsoSalto] = useState(0);
  useEffect(() => () => window.clearTimeout(resaltadoTimer.current), []);

  const irAMensaje = (id: number) => {
    const i = msgs.findIndex((m) => m.id === id);
    if (i < 0) return;
    if (busca) setBuscar('');
    if (i < idxDesde) setDesdeId(i === 0 ? null : msgs[i].id);
    // Se deja de seguir el final ANTES de que el hilo crezca: si no, el
    // ResizeObserver jalaría la vista al fondo a mitad del salto.
    marcarPegado(false);
    saltoRef.current = id;
    setPulsoSalto((n) => n + 1);
    setResaltado(id);
    window.clearTimeout(resaltadoTimer.current);
    resaltadoTimer.current = window.setTimeout(() => setResaltado(null), 1800);
  };

  useLayoutEffect(() => {
    const id = saltoRef.current;
    const box = boxRef.current;
    if (id == null || !box) return;
    const el = box.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!el) return;
    saltoRef.current = null;
    // En pantalla baja el overlay también se desplaza (abre bajado, hasta el
    // campo de escribir): si la caja no se ve completa, centrar dentro de
    // ella dejaría el original fuera de pantalla. Primero se descubre la
    // caja — cabe, su tope es la pantalla menos 40px.
    const ov = box.closest<HTMLElement>('.overlay');
    if (ov && ov.scrollHeight > ov.clientHeight) {
      const rb = box.getBoundingClientRect();
      const ro = ov.getBoundingClientRect();
      if (rb.top < ro.top || rb.bottom > ro.bottom) ov.scrollTop += rb.top - ro.top - 8;
    }
    // A mano y no con scrollIntoView: ese también desplaza el overlay y la
    // página detrás del modal.
    const top = Math.min(
      box.scrollHeight - box.clientHeight,
      Math.max(
        0,
        box.scrollTop +
          el.getBoundingClientRect().top -
          box.getBoundingClientRect().top -
          Math.max(0, (box.clientHeight - el.offsetHeight) / 2)
      )
    );
    // Sin movimiento (el original ya estaba a la vista, o el hilo no tiene
    // scroll) no llega ningún evento scroll que re-mida: se mide aquí, o
    // el ⬇ se quedaría prendido estando al final.
    if (Math.abs(top - box.scrollTop) < 1) {
      alDesplazar();
      return;
    }
    // Suave solo de cerca: en un hilo largo la animación tardaba más de un
    // segundo en cruzar miles de px. Lejos se brinca directo, como WhatsApp.
    const lejos = Math.abs(top - box.scrollTop) > box.clientHeight * 1.5;
    box.scrollTo({ top, behavior: lejos ? 'auto' : 'smooth' });
  }, [pulsoSalto]);

  const cargarAdjuntos = async () => {
    const { data } = await sb
      .from('chat_adjuntos')
      .select('*')
      .eq('record_id', inc.record_id)
      .order('creado_en');
    const m: Record<number, ChatAdjunto[]> = {};
    ((data as ChatAdjunto[]) || []).forEach((a) => {
      (m[a.mensaje_id] ||= []).push(a);
    });
    setAdjuntos(m);
  };

  // Realtime y el INSERT propio pueden entregar el mismo mensaje: se
  // deduplica por id para no pintarlo dos veces. Y se acomoda en orden de
  // id: lo recuperado al reconectar puede ser anterior a lo que ya llegó
  // en vivo, y al final quedaba debajo de su respuesta.
  const add = (m: Mensaje) =>
    setMsgs((prev) => {
      if (prev.some((x) => x.id === m.id)) return prev;
      const i = prev.findIndex((x) => x.id > m.id);
      return i < 0 ? [...prev, m] : [...prev.slice(0, i), m, ...prev.slice(i)];
    });

  /** Con el chat abierto, los avisos 💬 de este hilo ya no están pendientes. */
  const marcarNotifsChat = () => {
    sb.from('notificaciones')
      .update({ leida: true })
      .eq('evento', 'chat')
      .eq('record_id', inc.record_id)
      .eq('leida', false)
      .then(() => {});
  };

  useEffect(() => {
    let ch: RealtimeChannel | undefined;
    let chLect: RealtimeChannel | undefined;
    // Cerrar el chat antes de que termine de cargar dejaba los canales
    // creados después del cleanup, vivos para siempre.
    let vivo = true;
    (async () => {
      const { data } = await sb
        .from('mensajes')
        .select('*')
        .eq('record_id', inc.record_id)
        .order('creado_en');
      const lista = (data as Mensaje[]) || [];
      avanzarSincro(lista);
      setMsgs(lista);
      if (lista.length > LARGO) setDesdeId(lista[lista.length - VENTANA].id);
      const [, lec] = await Promise.all([
        cargarAdjuntos(),
        sb.from('chat_lecturas').select('*').eq('record_id', inc.record_id),
      ]);
      // Sin la tabla (migración pendiente) no hay ✓✓: mejor nada que un ✓
      // que diga "nadie lo ha visto" sin saberlo.
      if (!vivo) return;
      if (!lec.error) {
        setLecturas((lec.data as ChatLectura[]) || []);
        setConLecturas(true);
      }
      setLoading(false);

      // Canal APARTE: si la tabla aún no está en Realtime, su suscripción
      // falla sola y no se lleva el chat en vivo de los mensajes.
      chLect = sb
        .channel('chat-lect-' + inc.record_id)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'chat_lecturas',
            filter: 'record_id=eq.' + inc.record_id,
          },
          (p) => {
            const l = p.new as ChatLectura;
            if (!l || !l.usuario_email) return;
            setLecturas((prev) => [
              ...prev.filter((x) => x.usuario_email !== l.usuario_email),
              l,
            ]);
          }
        )
        // Al suscribirse (y al reconectar) se vuelve a leer: cubre lo que
        // pasó entre la consulta inicial y la suscripción, o con el socket caído.
        .subscribe((estado) => {
          if (estado === 'SUBSCRIBED') recargarLecturas();
        });

      ch = sb
        .channel('chat-' + inc.record_id)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'mensajes',
            filter: 'record_id=eq.' + inc.record_id,
          },
          (p) => {
            const m = p.new as Mensaje;
            avanzarSincro([m]);
            add(m);
            // Realtime solo trae el mensaje. Sus adjuntos se insertan justo
            // después, en otra tabla, así que se vuelven a leer con un
            // respiro para no llegar antes que el INSERT del otro lado.
            setTimeout(cargarAdjuntos, 600);
            // Si el mensaje es de alguien más y yo tengo el chat abierto,
            // ya lo estoy viendo: se marca leído.
            if (!esMio(m)) marcarNotifsChat();
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'mensajes',
            filter: 'record_id=eq.' + inc.record_id,
          },
          // Una edición del otro lado se refleja en vivo, igual que un
          // mensaje nuevo.
          (p) => {
            const m = p.new as Mensaje;
            setMsgs((prev) =>
              prev.map((x) => (x.id === m.id ? { ...x, ...m } : x))
            );
          }
        )
        // Igual que las lecturas: al suscribirse y al reconectar se traen
        // los mensajes posteriores al último que se tiene.
        .subscribe((estado) => {
          if (estado === 'SUBSCRIBED') recargarNuevos();
        });
    })();

    return () => {
      vivo = false;
      if (ch) sb.removeChannel(ch);
      if (chLect) sb.removeChannel(chLect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Valida el archivo elegido ANTES de dejar enviarlo. */
  const elegirArchivo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const original = e.target.files?.[0];
    e.target.value = '';
    if (!original) return;
    setErrAdj('');
    // Comprimir ANTES de validar: las fotos de un iPhone reciente pasan de
    // 5 MB con frecuencia y el límite las rechazaba sin ofrecer salida.
    // Comprimida (~1600px JPEG) una foto normal queda muy por debajo del
    // tope, que ahora solo frena lo genuinamente incomprimible.
    const f = original.type.startsWith('image/')
      ? await comprimirImagen(original)
      : original;
    const problema = await validarAdjunto(f);
    if (problema) {
      setErrAdj(problema);
      return;
    }
    setPendiente(f);
  };

  /**
   * Ventana de edición: el AUTOR, 15 minutos (como WhatsApp) y con la
   * incidencia abierta. Espeja la política msg_upd_autor para no ofrecer
   * un ✏️ que la base rechazaría; la base es la que manda.
   */
  const puedeEditar = (m: Mensaje) =>
    inc.estatus !== 'cerrada' &&
    esMio(m) &&
    Date.now() - new Date(m.creado_en).getTime() < 15 * 60 * 1000;

  // Al abrir la edición: foco y cursor al final, listo para seguir
  // escribiendo. En un layout effect del mismo toque: iOS solo abre el
  // teclado si el foco llega dentro del gesto del usuario.
  const edRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = edRef.current;
    const box = boxRef.current;
    if (!editando || !ta) return;
    // Sin el scroll automático del foco: ese mostraba solo el campo y
    // dejaba Guardar/Cancelar fuera de vista. Se muestra la burbuja entera
    // (o su parte de arriba, si no cabe).
    ta.focus({ preventScroll: true });
    const n = ta.value.length;
    ta.setSelectionRange(n, n);
    const burbuja = ta.closest<HTMLElement>('[data-mid]');
    if (box && burbuja) {
      const rb = box.getBoundingClientRect();
      const r = burbuja.getBoundingClientRect();
      if (r.bottom > rb.bottom) box.scrollTop += r.bottom - rb.bottom + 8;
      const r2 = burbuja.getBoundingClientRect();
      if (r2.top < rb.top) box.scrollTop -= rb.top - r2.top + 8;
      alDesplazar();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editando?.id]);

  // Edición DENTRO de la burbuja, como WhatsApp (25-sep-2026): tiene su
  // propio texto, así que lo que se estaba escribiendo abajo —y la
  // respuesta o el archivo en curso— no se pierde al corregir un mensaje.
  const empezarEdicion = (m: Mensaje) => {
    setEditando(m);
    setTextoEd(m.texto);
    setErrEd('');
  };

  const cancelarEdicion = () => {
    setEditando(null);
    setTextoEd('');
    setErrEd('');
  };

  /**
   * Se actualiza el texto y nada más: `editado_en` y `texto_original` los
   * pone el trigger en la base, no este cliente.
   */
  const guardarEdicion = async () => {
    const original = editando;
    const t = textoEd.trim();
    if (!original || guardandoEd || !t) return;
    if (t === original.texto) {
      cancelarEdicion();
      return;
    }
    setGuardandoEd(true);
    setErrEd('');
    const { data, error } = await sb
      .from('mensajes')
      .update({ texto: t })
      .eq('id', original.id)
      .select();
    setGuardandoEd(false);
    // Lo de abajo solo toca la edición si sigue siendo ESTA (red de
    // seguridad: mientras hay una edición abierta no se ofrece otro ✏️).
    const sigue = editandoIdRef.current === original.id;
    // 0 filas = la RLS lo negó en silencio (pasaron los 15 minutos, o la
    // incidencia se cerró mientras escribía). La burbuja sigue en edición
    // con el texto, para no perderlo.
    if (error || !data || data.length === 0) {
      if (sigue)
        setErrEd(
          error
            ? 'No se pudo editar: ' + error.message
            : 'Ya no se puede editar: la ventana es de 15 minutos.'
        );
      return;
    }
    const actualizado = data[0] as Mensaje;
    setMsgs((prev) =>
      prev.map((x) => (x.id === actualizado.id ? { ...x, ...actualizado } : x))
    );
    if (sigue) cancelarEdicion();
  };

  const empezarRespuesta = (m: Mensaje) => {
    setRespondiendo(m);
    // Sincrónico, dentro del toque: iOS solo abre el teclado si el foco
    // llega en el mismo gesto del usuario.
    inputRef.current?.focus();
  };

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = texto.trim();

    // Se puede mandar solo un archivo, sin texto.
    if (!t && !pendiente) return;

    const archivo = pendiente;
    const resp = respondiendo;
    // Se limpia de inmediato para que se sienta ágil; si falla, se restaura.
    setTexto('');
    setPendiente(null);
    setRespondiendo(null);
    setErrAdj('');
    // Con un filtro puesto, el mensaje propio casi nunca coincide y no se
    // vería salir: se quita la búsqueda, como al mandar en WhatsApp.
    if (busca) setBuscar('');
    if (archivo) setSubiendo(true);

    try {
      // ORDEN IMPORTANTE: primero sube el archivo, luego crea el mensaje.
      // Al revés, un fallo de subida dejaría un mensaje vacío colgado en el
      // hilo sin forma de saber que le faltaba algo.
      const subido = archivo
        ? await subirAdjunto(archivo, inc.record_id)
        : null;

      const { data, error } = await sb
        .from('mensajes')
        .insert({
          record_id: inc.record_id,
          autor_email: email,
          autor_nombre: nombre,
          texto: t || (subido?.tipo === 'video' ? '🎬 Video' : '📷 Foto'),
          // Solo viaja cuando se responde: un mensaje suelto no depende de
          // la columna (migración chat_respuestas_lecturas).
          ...(resp ? { responde_a: resp.id } : {}),
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      const msg = data as Mensaje;
      add(msg);

      if (subido) {
        const fila: Record<string, unknown> = {
          record_id: inc.record_id,
          mensaje_id: msg.id,
          tipo: subido.tipo,
          url: subido.url,
          path: subido.path,
          nombre: subido.nombre,
          bytes: subido.bytes,
          subido_por: email,
        };
        let { error: eAdj } = await sb.from('chat_adjuntos').insert(
          subido.ancho && subido.alto
            ? { ...fila, ancho: subido.ancho, alto: subido.alto }
            : fila
        );
        // Si la app llegó antes que la migración (columnas ancho/alto aún
        // no existen), se liga sin medidas: la foto no se pierde por eso.
        if (eAdj && /\b(ancho|alto)\b/.test(eAdj.message))
          ({ error: eAdj } = await sb.from('chat_adjuntos').insert(fila));
        // El mensaje ya existe: no se aborta, pero se avisa. Callarlo dejaría
        // al usuario creyendo que mandó una foto que nadie va a ver.
        if (eAdj) setErrAdj('El mensaje se envió, pero el archivo no quedó ligado: ' + eAdj.message);
        else await cargarAdjuntos();
      }
    } catch (ex) {
      const m = ex instanceof Error ? ex.message : String(ex);
      setErrAdj('No se pudo enviar: ' + m);
      // Un envío de solo texto no bloquea el campo, y ↩︎ sigue activo aun
      // subiendo un video: si mientras viajaba se escribió otra cosa o se
      // eligió responder a OTRO mensaje, no se restaura — texto y archivo
      // saldrían como respuesta a quien no era. Lo que falló se nombra en
      // el aviso para no perderlo.
      const otroDestino =
        respondiendoRef.current != null &&
        respondiendoRef.current.id !== resp?.id;
      if (textoRef.current.trim() || otroDestino) {
        const que = [t && `«${t}»`, !otroDestino ? '' : archivo?.name]
          .filter(Boolean)
          .join(' y ');
        if (que) setErrAdj(`No se pudo enviar ${que}: ${m}`);
        if (archivo && !otroDestino) setPendiente(archivo);
      } else {
        setTexto(t);
        // null o el mismo mensaje: no hay otro destino que respetar.
        setRespondiendo(resp);
        if (archivo) setPendiente(archivo);
      }
    } finally {
      setSubiendo(false);
    }
  };

  /** La cita dentro de una burbuja que responde: toca y lleva al original. */
  const cita = (m: Mensaje, mio: boolean) => {
    if (m.responde_a == null) return null;
    const o = porId.get(m.responde_a);
    const foto =
      o &&
      (adjuntos[o.id] || []).find((a) => a.tipo !== 'video' && !a.purgado_en);
    return (
      <button
        type="button"
        onClick={() => o && irAMensaje(o.id)}
        aria-label={
          !o
            ? 'Mensaje no disponible'
            : esMio(o)
              ? 'Ir a tu mensaje'
              : `Ir al mensaje de ${autorDe(o)}`
        }
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          textAlign: 'left',
          margin: '0 0 5px',
          padding: '5px 8px',
          border: 'none',
          // En la burbuja propia (naranja) el azul de acento no se lee: borde
          // oscuro y fondo ACLARADO — oscurecerlo le restaba contraste a la
          // letra oscura (3.99:1; así da ~6:1, igual en los dos temas).
          borderLeft: `3px solid ${mio ? 'rgba(0,0,0,.45)' : 'var(--accent2)'}`,
          borderRadius: 7,
          background: mio ? 'rgba(255,255,255,.25)' : 'var(--panel2)',
          color: 'inherit',
          font: 'inherit',
          cursor: o ? 'pointer' : 'default',
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 11, fontWeight: 700 }}>
            {o ? autorDe(o) : 'Mensaje'}
          </span>
          <span
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              fontSize: 12,
              opacity: 0.85,
              overflowWrap: 'anywhere',
            }}
          >
            {/* Espacios y saltos juntados: con pre-wrap, un "Hola,\n\n…"
                gastaba los 2 renglones de la cita en blanco. */}
            {o ? o.texto.replace(/\s+/g, ' ').trim() : 'Mensaje no disponible'}
          </span>
        </span>
        {foto && (
          <img
            src={foto.url}
            alt=""
            style={{
              width: 36,
              height: 36,
              objectFit: 'cover',
              borderRadius: 5,
              flexShrink: 0,
            }}
          />
        )}
      </button>
    );
  };

  /** Barra sobre el campo de escribir: edición o respuesta en curso. */
  const barraModo = (
    contenido: React.ReactNode,
    onCancelar: () => void,
    etiqueta: string,
    ariaCancelar?: string
  ) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 8,
        padding: '7px 10px',
        background: 'var(--panel2)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        fontSize: 12,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{contenido}</span>
      <button
        type="button"
        className="btn ghost sm"
        onClick={onCancelar}
        aria-label={ariaCancelar}
      >
        {etiqueta}
      </button>
    </div>
  );

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onClose();
      }}
    >
      {/* La altura vive en .modal-chat (index.css): necesita el fallback
          vh→dvh por declaración doble, que un style inline no puede dar. */}
      <div
        className="modal modal-chat"
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        <h2 style={{ margin: '0 0 3px' }}>Chat de la incidencia</h2>
        <p
          className="phint"
          style={{ marginBottom: conLecturas && otrasLecturas.length ? 3 : 10 }}
        >
          {inc.folio} · {inc.nombre_incidencia}
          {inc.lado || inc.clave_medio ? ` · cara ${caraIncidencia(inc)}` : ''}
        </p>
        {/* La última vez que cada quien leyó este chat. */}
        {conLecturas && otrasLecturas.length > 0 && (
          <p
            className="phint"
            style={{
              marginBottom: 10,
              fontSize: 12,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              // Con overflow:hidden un hijo de la columna flex puede
              // encogerse hasta desaparecer (medía 3px) cuando la caja de
              // mensajes pide todo el alto.
              flexShrink: 0,
            }}
          >
            👁 Visto:{' '}
            {otrasLecturas
              .slice(0, 3)
              .map((l) => `${nombreLector(l)} ${cuando(l.visto_en)}`)
              .join(' · ')}
            {otrasLecturas.length > 3 ? ` · +${otrasLecturas.length - 3}` : ''}
          </p>
        )}

        {/* Buscador del hilo: en incidencias largas el dato que importa
            (un folio, una medida, quién dijo qué) queda arriba del pliegue. */}
        {msgs.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input
              ref={buscadorRef}
              value={buscar}
              onChange={(e) => setBuscar(e.target.value)}
              placeholder="🔍 Buscar en el chat…"
              style={{ flex: '1 1 auto', minWidth: 0, width: 'auto' }}
            />
            {puedeCompactar && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={compactar}
                style={{ flexShrink: 0 }}
              >
                🗜 Compactar
              </button>
            )}
          </div>
        )}

        <div
          ref={boxRef}
          className="chat-caja"
          onScroll={alDesplazar}
          style={{
            flex: 1,
            overflowY: 'auto',
            background: 'var(--panel2)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: 12,
            /* 100 y no 220: el modal tiene max-height (80dvh) y este mínimo
               es lo único que puede ceder. Con 220, en horizontal o con el
               teclado abierto la suma de hijos superaba el tope y el campo
               de escribir quedaba fuera de pantalla, sin scroll que llegara
               a él. El flex:1 lo hace crecer cuando sí hay espacio. */
            minHeight: 100,
            marginBottom: 10,
            // El anclaje de scroll de Chrome/Android corregía la vista por
            // su cuenta al abrir mensajes anteriores; Safari no lo tiene.
            // Apagado, el ajuste lo hace SOLO este componente (trasVentana)
            // y el hilo se comporta igual en iPhone que en Android.
            overflowAnchor: 'none',
          }}
        >
          <div ref={contRef}>
            {loading ? (
              <div className="loading">Cargando…</div>
            ) : msgs.length === 0 ? (
              <div
                style={{
                  color: 'var(--muted)',
                  fontSize: 13,
                  textAlign: 'center',
                  padding: 20,
                }}
              >
                Sin mensajes. Escribe el primero.
              </div>
            ) : msgsVisibles.length === 0 ? (
              <div
                style={{
                  color: 'var(--muted)',
                  fontSize: 13,
                  textAlign: 'center',
                  padding: 20,
                }}
              >
                Nada coincide con “{busca}”.
              </div>
            ) : (
              <>
                {ocultos > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'center',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 10,
                      fontSize: 12,
                      color: 'var(--muted)',
                    }}
                  >
                    <span>
                      ⋯ {ocultos}{' '}
                      {ocultos === 1 ? 'mensaje anterior' : 'mensajes anteriores'}
                    </span>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => verAnteriores(false)}
                    >
                      ⬆ Ver {Math.min(VENTANA, ocultos)} más
                    </button>
                    {ocultos > VENTANA && (
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => verAnteriores(true)}
                      >
                        Ver todos
                      </button>
                    )}
                  </div>
                )}
                {msgsVisibles.map((m) => {
                  const mio = esMio(m);
                  const enEdicion = editando?.id === m.id;
                  // Visto = alguien más tuvo a la vista este mensaje o uno
                  // posterior (los ids crecen en orden).
                  const vistos = mio
                    ? otrasLecturas.filter((l) => l.ultimo_id >= m.id)
                    : [];
                  return (
                    <div
                      key={m.id}
                      data-mid={m.id}
                      style={{
                        display: 'flex',
                        justifyContent: mio ? 'flex-end' : 'flex-start',
                        marginBottom: 8,
                      }}
                    >
                      <div
                        style={{
                          maxWidth: '78%',
                          // Editando se abre a todo lo ancho: un "ok" dejaba
                          // un campo de dos letras.
                          width: enEdicion ? '78%' : undefined,
                          background: mio ? 'var(--accent)' : 'var(--panel)',
                          color: mio ? '#151515' : 'var(--txt)',
                          border: '1px solid var(--line)',
                          borderRadius: 12,
                          padding: '7px 11px',
                          // Resalte al llegar desde una cita.
                          boxShadow:
                            resaltado === m.id
                              ? '0 0 0 3px var(--accent2)'
                              : undefined,
                          transition: 'box-shadow .3s',
                        }}
                      >
                        {!mio && (
                          <div
                            style={{ fontSize: 11, fontWeight: 700, marginBottom: 2 }}
                          >
                            {m.autor_nombre || m.autor_email}
                          </div>
                        )}
                        {cita(m, mio)}
                        {enEdicion ? (
                          // Se corrige AQUÍ, dentro de la burbuja, como
                          // WhatsApp. Solo los propios son editables, así
                          // que el fondo siempre es el naranja: los colores
                          // van fijos, no por tema.
                          <div>
                            <textarea
                              ref={edRef}
                              value={textoEd}
                              onChange={(e) => setTextoEd(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  e.preventDefault();
                                  cancelarEdicion();
                                } else if (
                                  e.key === 'Enter' &&
                                  !e.shiftKey &&
                                  !e.nativeEvent.isComposing
                                ) {
                                  // Igual que el campo de abajo: Enter manda.
                                  e.preventDefault();
                                  guardarEdicion();
                                }
                              }}
                              rows={Math.min(6, Math.max(2, Math.ceil(textoEd.length / 30)))}
                              disabled={guardandoEd}
                              aria-label="Corrige tu mensaje"
                              style={{
                                display: 'block',
                                width: '100%',
                                resize: 'none',
                                background: 'rgba(255,255,255,.45)',
                                color: '#151515',
                                border: '1px solid rgba(0,0,0,.3)',
                                borderRadius: 8,
                                padding: '6px 8px',
                              }}
                            />
                            {errEd && (
                              <div
                                role="alert"
                                style={{ fontSize: 12, fontWeight: 700, marginTop: 4 }}
                              >
                                {errEd}
                              </div>
                            )}
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'flex-end',
                                gap: 6,
                                marginTop: 6,
                              }}
                            >
                              <button
                                type="button"
                                className="btn sm"
                                onClick={cancelarEdicion}
                                disabled={guardandoEd}
                                // Deshabilitado a mano: la regla del tema
                                // claro para .btn:disabled quita la opacidad
                                // y el color en línea le gana a su gris, así
                                // que se veía igual que activo.
                                style={{
                                  background: 'transparent',
                                  color: '#151515',
                                  border: '1px solid rgba(0,0,0,.35)',
                                  boxShadow: 'none',
                                  opacity: guardandoEd ? 0.45 : 1,
                                }}
                              >
                                Cancelar
                              </button>
                              <button
                                type="button"
                                className="btn sm"
                                onClick={guardarEdicion}
                                disabled={guardandoEd || !textoEd.trim()}
                                style={{
                                  background: '#151515',
                                  color: '#fff',
                                  boxShadow: 'none',
                                  opacity: guardandoEd || !textoEd.trim() ? 0.45 : 1,
                                }}
                              >
                                {guardandoEd ? 'Guardando…' : 'Guardar'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div
                            style={{
                              fontSize: 14,
                              lineHeight: 1.4,
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {m.texto}
                          </div>
                        )}

                        {(adjuntos[m.id] || []).map((a) =>
                          a.purgado_en ? (
                            // El archivo ya se borró. Se dice explícitamente en
                            // vez de dejar un hueco: quien lee el hilo meses
                            // después debe entender que ahí HUBO algo, y por qué
                            // ya no está.
                            <div
                              key={a.id}
                              style={{
                                marginTop: 6,
                                fontSize: 11,
                                opacity: 0.65,
                                fontStyle: 'italic',
                              }}
                            >
                              📎 {a.tipo === 'video' ? 'Video' : 'Foto'} eliminado
                              al cerrar la incidencia
                            </div>
                          ) : a.tipo === 'video' ? (
                            <video
                              key={a.id}
                              src={a.url}
                              controls
                              playsInline
                              preload="metadata"
                              onLoadedMetadata={pegarAbajo}
                              style={{
                                ...cajaMedio(a),
                                // Franjas del video: negras en los dos temas.
                                background: '#000',
                              }}
                            />
                          ) : (
                            <a
                              key={a.id}
                              href={a.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <img
                                src={a.url}
                                alt={a.nombre || 'foto'}
                                loading="lazy"
                                onLoad={pegarAbajo}
                                style={{
                                  ...cajaMedio(a),
                                  background: 'var(--panel2)',
                                }}
                              />
                            </a>
                          )
                        )}

                        <div
                          style={{
                            fontSize: 10,
                            // .85 y no .7: en la burbuja propia (naranja) la hora
                            // daba 3.8:1 en los dos temas; así da 4.9 (tema
                            // claro/oscuro, 24-sep-2026).
                            opacity: 0.85,
                            marginTop: 3,
                            textAlign: 'right',
                            display: 'flex',
                            // La hora entera en un renglón; si con ✓ ↩︎ ✏️ no
                            // cabe, bajan los botones y no la hora partida.
                            flexWrap: 'wrap',
                            justifyContent: 'flex-end',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <span style={{ whiteSpace: 'nowrap' }}>
                            {m.editado_en ? '(editado) · ' : ''}
                            {horaMensaje(m.creado_en)}
                          </span>
                          {/* ✓ enviado · ✓✓ ya lo vio alguien más. Tocar
                              abre quién y cuándo (nada solo en title). */}
                          {mio && conLecturas && (
                            <button
                              type="button"
                              className="btn-icono sobre-acento"
                              style={{
                                minWidth: 30,
                                minHeight: 32,
                                fontSize: 12,
                                letterSpacing: -3,
                                paddingRight: 3,
                                fontWeight: vistos.length ? 800 : 400,
                                opacity: vistos.length ? 1 : 0.7,
                              }}
                              onClick={() =>
                                setVerVistos((v) => (v === m.id ? null : m.id))
                              }
                              aria-expanded={verVistos === m.id}
                              aria-label={
                                vistos.length
                                  ? `Visto por ${vistos.map(nombreLector).join(', ')}`
                                  : 'Enviado, nadie lo ha visto todavía'
                              }
                            >
                              {vistos.length ? '✓✓' : '✓'}
                            </button>
                          )}
                          {inc.estatus !== 'cerrada' && !enEdicion && (
                            <button
                              type="button"
                              className={mio ? 'btn-icono sobre-acento' : 'btn-icono'}
                              style={{ minWidth: 32, minHeight: 32 }}
                              onClick={() => empezarRespuesta(m)}
                              aria-label="Responder a este mensaje"
                            >
                              ↩︎
                            </button>
                          )}
                          {/* Una edición a la vez, como WhatsApp: con otra
                              abierta (o guardándose) no se ofrece ✏️. */}
                          {mio && puedeEditar(m) && !editando && (
                            <button
                              type="button"
                              className="btn-icono sobre-acento"
                              style={{ minWidth: 32, minHeight: 32 }}
                              onClick={() => empezarEdicion(m)}
                              aria-label="Editar mensaje"
                              title="Editar (15 min)"
                            >
                              ✏️
                            </button>
                          )}
                        </div>
                        {mio && verVistos === m.id && (
                          <div
                            style={{
                              fontSize: 11,
                              marginTop: 2,
                              textAlign: 'right',
                              opacity: 0.9,
                            }}
                          >
                            {vistos.length
                              ? 'Visto por ' +
                                vistos
                                  // visto_en es la ÚLTIMA vez que abrió el
                                  // chat, no la hora en que vio este mensaje.
                                  .map(
                                    (l) =>
                                      `${nombreLector(l)} (última vez ${cuando(l.visto_en)})`
                                  )
                                  .join(', ')
                              : 'Nadie lo ha visto todavía'}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* Alto 0: el botón flota sobre el borde de abajo de la caja sin
            cambiar el acomodo del modal. */}
        <div style={{ height: 0, position: 'relative' }}>
          {(!pegado || nuevos > 0) && !loading && (
            <button
              type="button"
              className="btn-icono"
              onClick={tocarAbajo}
              aria-label={
                nuevos > 0
                  ? `Ir al final: ${nuevos} mensajes nuevos`
                  : 'Ir al último mensaje'
              }
              style={{
                position: 'absolute',
                right: 12,
                bottom: 22,
                zIndex: 1,
                gap: 4,
                padding: '0 10px',
                borderRadius: 20,
                background: 'var(--panel)',
                border: '1px solid var(--line)',
                boxShadow: '0 2px 8px var(--sombra)',
                fontSize: 14,
                fontWeight: 700,
              }}
            >
              ⬇{nuevos > 0 ? ` ${nuevos}` : ''}
            </button>
          )}
        </div>

        {inc.estatus === 'cerrada' ? (
          <div className="banner">
            🔒 Incidencia cerrada — el chat es de solo lectura.
          </div>
        ) : (
          <>
            {errAdj && (
              <div
                className="err"
                style={{ marginBottom: 8 }}
                onClick={() => setErrAdj('')}
              >
                {errAdj}
              </div>
            )}

            {pendiente && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 8,
                  padding: '7px 10px',
                  background: 'var(--panel2)',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  fontSize: 12,
                }}
              >
                <span>
                  {pendiente.type.startsWith('video') ? '🎬' : '📷'}
                </span>
                <span
                  style={{
                    flex: 1,
                    /* Sin minWidth:0 el flex no encoge por debajo del nombre
                       completo del archivo (nowrap): un IMG_2026...HDR.jpg
                       empujaba el MB y la ✕ de Quitar fuera del modal. */
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {pendiente.name}
                </span>
                <span style={{ color: 'var(--muted)' }}>
                  {(pendiente.size / 1024 / 1024).toFixed(1)} MB
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setPendiente(null)}
                  title="Quitar"
                >
                  ✕
                </button>
              </div>
            )}

            {respondiendoVivo &&
              barraModo(
                <>
                  <span style={{ display: 'block', fontWeight: 700 }}>
                    ↩︎ Respondiendo{' '}
                    {esMio(respondiendoVivo)
                      ? 'a tu mensaje'
                      : `a ${autorDe(respondiendoVivo)}`}
                  </span>
                  <span
                    style={{
                      display: 'block',
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {respondiendoVivo.texto}
                  </span>
                </>,
                () => setRespondiendo(null),
                '✕',
                'Cancelar respuesta'
              )}

            {/* flexWrap + flex-basis chico en el input: sin eso, el
                min-content del campo (~200px) + 📎 + "Enviar" sumaban más
                que el ancho del modal en 360px y el botón de enviar quedaba
                cortado fuera de pantalla, peor aún durante "Subiendo…". */}
            <form onSubmit={enviar} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                ref={fileRef}
                type="file"
                accept="image/*,video/*"
                onChange={elegirArchivo}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                className="btn ghost"
                onClick={() => fileRef.current?.click()}
                disabled={subiendo}
                style={{ flexShrink: 0 }}
                title={`Foto o video de máximo ${MAX_VIDEO_SEG} s`}
              >
                📎
              </button>
              <input
                ref={inputRef}
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                placeholder={
                  pendiente
                    ? 'Comentario (opcional)…'
                    : respondiendo
                      ? 'Escribe tu respuesta…'
                      : 'Escribe un mensaje…'
                }
                disabled={subiendo}
                // 100 y no 140: en 320px (iPhone SE de 1a) con 140 el campo
                // bajaba a otro renglón, y con la barra de "Respondiendo a…"
                // el modal ya no cabía. Crece igual donde sobra espacio.
                style={{ flex: '1 1 100px', minWidth: 0, width: 'auto' }}
              />
              <button className="btn" type="submit" disabled={subiendo}>
                {subiendo && <span className="spinner" />}
                {subiendo ? 'Subiendo…' : 'Enviar'}
              </button>
            </form>

            <p className="phint" style={{ marginTop: 6, fontSize: 11 }}>
              Los archivos del chat se borran al cerrar la incidencia. Para
              evidencia que deba conservarse, usa 📎 Evidencia.
            </p>
          </>
        )}

        <div className="modal-actions" style={{ marginTop: 10 }}>
          <button className="btn ghost" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

export default ChatModal;
