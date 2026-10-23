// ============================================================
// src/modules/pauta/RegistrarTomaModal.tsx
// Registro de la toma en campo: fotos de la cara + fecha.
//
// Homologado con el flujo de Incidencias a propósito: mismas clases
// (.overlay/.modal/.field), el mismo componente SubirArchivos con los botones
// de cámara y galería, el mismo bucket `evidencias`, y la evidencia como
// requisito. Quien ya sabe subir una foto en Incidencias no tiene que
// aprender nada nuevo aquí.
//
// COLA DE TOMAS (fase 1 de comprobaciones, Erik, 22-oct-2026). Antes cada
// foto se subía desde aquí al elegirla y, si la subida fallaba, se perdía (la
// cámara de la app no la deja en el carrete). Ahora:
//   · Al elegirla se guarda en el teléfono y sube sola en segundo plano
//     (lib/tomasPauta.ts). El monitorista puede seguir tomando y hasta
//     cerrar esta ventana: se sube mientras la app esté abierta.
//   · "Registrar toma" se lo pide a la cola: registra en cuanto TODAS las
//     fotos entraron y el servidor tiene el mínimo. Con señal pasa en un par
//     de segundos y la ventana se cierra igual que antes.
//   · "Guardar en Fotos" abre la hoja de compartir con las fotos que se
//     tomaron con la cámara de la app en esta ventana.
// Comprobar y regresar ya no viven aquí (22-oct-2026): las tomas las revisa
// el analista foto por foto en Comprobaciones › Tomas de Pauta (AnalistaPauta.tsx).
// ============================================================
import { Camera, ClipboardList, CloudOff, ImageDown, Trash, TriangleAlert } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { sb } from '../../lib/supabase';
import { caraLabel } from '../../lib/helpers';
import { reglaEspecToma } from '../../lib/especToma';
import { pintar } from '../../lib/tonos';
import { BUCKET_EVIDENCIAS } from '../../lib/storage';
import SubirArchivos, { VisorFile } from '../../components/SubirArchivos';
import type { PautaRuta } from '../../types/db';
import { vigilarRender } from '../../lib/vigia';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';
import {
  archivoLocal,
  encolarFotos,
  enRiesgoTrabajo,
  limpiarDespuesPorPath,
  estaEnviando,
  pedirRegistro,
  quitarArchivo,
  quitarPorPath,
  marcarRegistroVisto,
  suscribirTomas,
  tomasRegistradasEnSesion,
  trabajosDeCara,
  type ContextoToma,
} from '../../lib/tomasPauta';
import { tope } from '../../lib/envios';
import { esFinal, gruposParaCompartir, type ArchivoToma } from '../../lib/tomasPautaLogica';
import { esAndroid, guardarEnFotos, puedeGuardarEnFotos } from '../../lib/guardarEnFotos';
import { estaInstalada } from '../../lib/push';
import { pareceSinRed, useEnLinea } from '../../lib/enLinea';

/** Fila de `pauta_evidencias`. */
type EvidenciaPauta = {
  id: number;
  tipo: string | null;
  url: string;
  path: string | null;
  referencia: string | null;
  subido_por: string | null;
  /** De una toma que se regresó: ya no cuenta (14-oct-2026). */
  regresada_en?: string | null;
};

/** Un archivo que sigue en la cola del teléfono (aún no entra a la toma). */
type Local = ArchivoToma & { trabajo: string; enviando: boolean; url: string | null };

/** Lo que el modal le cuenta a la lista al registrar. */
export type InfoRegistro = {
  /** true = quedó pedido en la cola; se registra solo cuando suban las fotos. */
  enCola: boolean;
  /** Fotos de la toma (las del servidor más las de la cola). */
  fotos: number;
};

type Props = {
  fila: PautaRuta;
  email: string;
  onClose: () => void;
  /** Avisa al padre que la toma quedó registrada (o pedida), para refrescar la lista. */
  onRegistrada: (vendorFaceId: string, info: InfoRegistro) => void;
};

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/** Mismo File con un nombre único (la cámara llama a todo "image.jpg"). */
function renombrar(f: File, nombre: string, mime?: string): File {
  try {
    return new File([f], nombre, { type: f.type || mime || 'image/jpeg', lastModified: f.lastModified || Date.now() });
  } catch {
    return f;
  }
}

/** Marca de estado en la esquina de una miniatura en cola. */
function Marca({ l }: { l: Local }) {
  const base: React.CSSProperties = {
    position: 'absolute',
    left: 3,
    bottom: 3,
    width: 24,
    height: 24,
    borderRadius: '50%',
    // Va sobre la foto: igual en los dos temas (como el × de SubirArchivos).
    background: 'rgba(0,0,0,.72)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
  };
  if (l.estado === 'perdido')
    return (
      <span style={{ ...base, color: '#ffb4b4' }} title="No estaba en el teléfono" aria-label="No estaba en el teléfono">
        <Ic i={TriangleAlert} />
      </span>
    );
  if (l.enviando)
    return (
      <span style={base} title="Subiendo" aria-label="Subiendo">
        <span className="spinner" style={{ margin: 0, width: 12, height: 12 }} />
      </span>
    );
  // El servidor no la aceptó: sigue en el teléfono y se reintenta en cada vuelta.
  if (l.estado === 'fallido')
    return (
      <span
        style={{ ...base, color: '#ffb4b4' }}
        title="No se pudo subir; sigue en el teléfono y se reintenta"
        aria-label="No se pudo subir; se reintenta"
      >
        <Ic i={TriangleAlert} />
      </span>
    );
  const texto =
    l.estado === 'subido' || l.estado === 'ligando'
      ? 'Ya subió; falta que entre a la toma'
      : 'Guardada en el teléfono; falta subir';
  return (
    <span style={base} title={texto} aria-label={texto}>
      <Ic i={CloudOff} />
    </span>
  );
}

function RegistrarTomaModal({ fila, email, onClose, onRegistrada }: Props) {
  vigilarRender('RegistrarTomaModal');
  const [evidencias, setEvidencias] = useState<EvidenciaPauta[]>([]);
  const [cargando, setCargando] = useState(true);
  /** No se pudo leer el servidor por falta de señal (no es un error). */
  const [sinServidor, setSinServidor] = useState(false);
  const [locales, setLocales] = useState<Local[]>([]);
  /** Ya se pidió registrar esta toma y espera a que suban las fotos. */
  const [registroPedido, setRegistroPedido] = useState(false);
  /**
   * La cola terminó el registro con esta ventana abierta (la `fila` no se
   * entera hasta la recarga): cuenta como ya registrada (revisión del
   * código, 22-oct-2026).
   */
  const [registradaAqui, setRegistradaAqui] = useState(() =>
    // La lista la pinta «Tomada · actualizando…» (la cola ya la registró y la
    // recarga no llega): la ventana no debe ofrecer registrarla otra vez.
    tomasRegistradasEnSesion(email).some(
      (r) => r.anio === fila.anio && r.catorcena === fila.catorcena && r.vfid === fila.vendor_face_id
    )
  );
  /** Rutas que la cola tiene como quitadas (también las de otra vez): no son evidencia vigente. */
  const [rutasQuitadas, setRutasQuitadas] = useState<Set<string>>(() => new Set());
  /**
   * Fotos que acaban de entrar a la toma y que la lectura del servidor aún no
   * trae: sin ellas la cuenta bajaba un momento («llevas 2. Faltan 1»).
   * `seq` dice qué lectura ya las alcanza a ver.
   */
  const [recientes, setRecientes] = useState<{ path: string; seq: number }[]>([]);
  const seqRef = useRef(0);
  /** El error que dejó la cola (toma comprobada, faltan fotos…). */
  const [errorCola, setErrorCola] = useState<string | null>(null);
  /** Archivos que no cupieron en el teléfono (solo en la memoria de la app). */
  const [enRiesgo, setEnRiesgo] = useState(0);
  /** Copiando lo elegido al teléfono. */
  const [guardando, setGuardando] = useState(false);
  const [registrando, setRegistrando] = useState(false);
  const [preguntaCerrar, setPreguntaCerrar] = useState(false);
  const [ref, setRef] = useState('');
  const [err, setErr] = useState('');
  const [aviso, setAviso] = useState('');
  /** Foto local abierta en grande. */
  const [ver, setVer] = useState<File | null>(null);
  const enLinea = useEnLinea();

  /** Fotos de la cámara de la app tomadas en ESTA ventana, ya renombradas (para Fotos). */
  const [deCamara, setDeCamara] = useState<{ path: string; file: File }[]>([]);
  const [grupo, setGrupo] = useState(0);
  const [compartiendo, setCompartiendo] = useState(false);
  const [puedeFotos] = useState(puedeGuardarEnFotos);
  const [android] = useState(esAndroid);

  /** Los File de esta ventana por ruta: miniaturas sin volver a bajarlas. */
  const sesionPorPath = useRef(new Map<string, File>());
  /**
   * Las fotos de la cola leídas del teléfono (de otra vez que se abrió esta
   * toma), ya con su nombre único: el visor y «Guardar en Fotos» las usan.
   */
  const leidosPorPath = useRef(new Map<string, File>());
  /** Rutas que el monitorista quitó aquí (no cuentan como recién subidas). */
  const quitadasAqui = useRef(new Set<string>());
  /** objectURL por ruta (se liberan al cerrar). */
  const urls = useRef(new Map<string, string>());
  const vivo = useRef(true);
  const registrandoRef = useRef(false);
  const enRiesgoRef = useRef(0);
  enRiesgoRef.current = enRiesgo;

  // Prender en el cuerpo y apagar en la limpieza: en desarrollo (StrictMode)
  // un ref que solo se apaga quedaba apagado (lección de Pauta, 20-oct-2026).
  useEffect(() => {
    vivo.current = true;
    const mapa = urls.current;
    return () => {
      vivo.current = false;
      mapa.forEach((u) => URL.revokeObjectURL(u));
      mapa.clear();
    };
  }, []);

  /**
   * La especificación de toma manda cuántas fotos se exigen (3 si no hay).
   * Los videos suman evidencia pero no cuentan para el mínimo: la espec
   * habla de tomas fotográficas.
   */
  const regla = reglaEspecToma(fila.espec_toma);
  // El hex de la regla, en su tono legible del tema activo. null cuando la
  // regla trae una var() (estándar = --muted): ese recuadro va sin tinte ni
  // borde, como siempre (tema claro/oscuro, 24-sep-2026).
  const tonoRegla = pintar(regla.color);

  const yaRegistrada = !!fila.fecha_toma || registradaAqui;
  /** Comprobada: ya no se agregan ni se quitan fotos (la base lo impide). */
  const cerrada = !!fila.fecha_comprobacion;

  const ctx: ContextoToma = {
    anio: fila.anio,
    catorcena: fila.catorcena,
    vfid: fila.vendor_face_id,
    site_id: fila.site_id,
    cara: fila.cara || caraLabel(fila.vendor_face_id) || null,
    campana: fila.campana,
  };

  /** Lecturas pedidas y la última aplicada: una respuesta vieja no pisa a una nueva. */
  const pedidaRef = useRef(0);
  const aplicadaRef = useRef(0);
  const cargar = useCallback(async () => {
    const n = ++pedidaRef.current;
    const desde = seqRef.current;
    const { data, error, status } = await sb
      .from('pauta_evidencias')
      .select('*')
      // Número + año (14-oct-2026): la misma cara puede tener la Cat-1 de
      // dos años distintos.
      .eq('anio', fila.anio)
      .eq('catorcena', fila.catorcena)
      .eq('vendor_face_id', fila.vendor_face_id)
      .order('creado_en')
      // Con una barra la consulta ni falla ni contesta: a los 8 s cuenta como
      // sin señal (el efecto de enLinea la vuelve a pedir).
      .abortSignal(tope(8000));
    // Con una barra, una lectura vieja podía llegar después de una nueva y
    // bajar la cuenta sin que nada la corrigiera.
    if (!vivo.current || n < aplicadaRef.current) return;
    aplicadaRef.current = n;
    if (error) {
      // Sin señal no es un error: se dice aparte y se cuenta con la lista.
      if (pareceSinRed(error, status)) setSinServidor(true);
      else setErr('No se pudo cargar la evidencia: ' + error.message);
    } else {
      setEvidencias((data as EvidenciaPauta[]) || []);
      setSinServidor(false);
      // Esta lectura ya ve las que entraron antes de pedirla.
      setRecientes((prev) => (prev.some((r) => r.seq <= desde) ? prev.filter((r) => r.seq > desde) : prev));
    }
    setCargando(false);
  }, [fila.anio, fila.catorcena, fila.vendor_face_id]);

  /** Lo de la cola para esta cara (con su miniatura) y su estado. */
  const firmaCola = useRef('');
  /** Lo que la lectura anterior tenía en la cola, por ruta. */
  const pendientesAntes = useRef(new Map<string, Local>());
  const pedidoAntes = useRef(false);
  const leerCola = useCallback(async () => {
    let ts: Awaited<ReturnType<typeof trabajosDeCara>> = [];
    try {
      ts = await trabajosDeCara(email, fila.anio, fila.catorcena, fila.vendor_face_id);
    } catch {
      return;
    }
    // Ventana ya cerrada: no se crean URLs que nadie liberaría.
    if (!vivo.current) return;
    const lista: Local[] = [];
    for (const t of ts)
      for (const a of t.archivos)
        if (a.estado !== 'ligado' && a.estado !== 'quitado')
          lista.push({ ...a, trabajo: t.id, enviando: estaEnviando(t.id), url: null });
    for (const l of lista) {
      const foto = l.tipo === 'foto' && !urls.current.has(l.path);
      // Los videos de la cámara no llevan miniatura, pero sí van a «Guardar en Fotos».
      const video =
        l.tipo === 'video' &&
        l.origen === 'camara' &&
        !sesionPorPath.current.has(l.path) &&
        !leidosPorPath.current.has(l.path);
      if (foto || video) {
        let f = sesionPorPath.current.get(l.path) ?? leidosPorPath.current.get(l.path) ?? null;
        if (!f) {
          const leido = await archivoLocal(l.trabajo, l.fid);
          if (!vivo.current) return;
          if (leido) {
            f = renombrar(leido, l.nombre, l.mime);
            leidosPorPath.current.set(l.path, f);
          }
        }
        // Otra lectura en paralelo pudo crearla mientras se esperaba.
        if (foto && f && !urls.current.has(l.path)) urls.current.set(l.path, URL.createObjectURL(f));
      }
      l.url = urls.current.get(l.path) ?? null;
    }
    if (!vivo.current) return;
    // Lo que la cola tiene por quitado (también de otra vez, p. ej. tras
    // Descartar sin señal): aunque su fila siga un rato, ya no es evidencia.
    // Solo las que la cola va a QUITAR de la toma (limpiar === true): una
    // descartada que ya entró ('objeto') o una quitada sin limpieza sigue
    // siendo evidencia y debe contarse.
    const quitadas = [
      ...new Set(
        ts
          .flatMap((t) => t.archivos)
          .filter((a) => a.estado === 'quitado' && a.limpiar === true)
          .map((a) => a.path)
      ),
    ].sort();
    const pedido = ts.some((t) => t.registrar && !t.registrada);
    const conErr = ts.find((t) => t.conError)?.ultimoError ?? null;
    const riesgo = ts.reduce((s, t) => s + enRiesgoTrabajo(t), 0);
    // El registro pedido desapareció sin error y la cola lo registró aquí.
    const recienRegistrada =
      pedidoAntes.current &&
      !pedido &&
      !conErr &&
      tomasRegistradasEnSesion(email).some(
        (r) => r.anio === fila.anio && r.catorcena === fila.catorcena && r.vfid === fila.vendor_face_id
      );
    pedidoAntes.current = pedido;
    // Regla anti-congelamiento (24-sep-2026): sin cambios, no se re-renderiza.
    const firma = JSON.stringify([
      lista.map((l) => [l.path, l.estado, l.enviando, !!l.url]),
      pedido,
      conErr,
      riesgo,
      quitadas,
    ]);
    if (firma === firmaCola.current) return;
    firmaCola.current = firma;
    // Una foto salió de la cola (ya entró a la toma): se relee el servidor y,
    // mientras llega, se sigue contando (no si se quitó o se perdió).
    const ahora = new Set(lista.map((l) => l.path));
    const salieron = [...pendientesAntes.current.values()].filter((l) => !ahora.has(l.path));
    const entraron = salieron.filter((l) => {
      if (l.tipo !== 'foto' || l.estado === 'perdido' || quitadasAqui.current.has(l.path)) return false;
      const sigue = ts.flatMap((t) => t.archivos).find((a) => a.path === l.path);
      return !sigue || sigue.estado === 'ligado';
    });
    pendientesAntes.current = new Map(lista.map((l) => [l.path, l]));
    if (entraron.length) {
      const nuevas = entraron.map((l) => ({ path: l.path, seq: ++seqRef.current }));
      setRecientes((prev) => [...prev, ...nuevas]);
    }
    setLocales(lista);
    setRutasQuitadas(new Set(quitadas));
    setRegistroPedido(pedido);
    setErrorCola(conErr);
    setEnRiesgo(riesgo);
    if (recienRegistrada) {
      setRegistradaAqui(true);
      setAviso('');
      // El rojo de un intento anterior (p. ej. la foto rechazada que ya subió) ya no aplica.
      setErr('');
      // Lo vio aquí: el aviso breve no lo repite al cerrar.
      marcarRegistroVisto(fila.anio, fila.catorcena, fila.vendor_face_id);
    }
    if (salieron.length) void cargar();
  }, [email, fila.anio, fila.catorcena, fila.vendor_face_id, cargar]);

  useEffect(() => {
    void cargar();
    void leerCola();
    let t: number | undefined;
    const quitar = suscribirTomas(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => void leerCola(), 250);
    });
    return () => {
      quitar();
      window.clearTimeout(t);
    };
  }, [cargar, leerCola]);

  // Volvió la señal: lo que no se pudo leer del servidor, se lee.
  useEffect(() => {
    if (enLinea && sinServidor) void cargar();
  }, [enLinea, sinServidor, cargar]);

  // --- Cuentas ---
  const enCola = new Set(locales.map((l) => l.path));
  // Lo que ya entró y lo que sigue en la cola no se cuenta dos veces (una
  // foto 'ligando' puede estar ya en el servidor). Tampoco lo que se quitó
  // aquí y la cola aún no limpia: si no, reaparecía como foto subida.
  const vigentes = evidencias.filter(
    (e) =>
      !e.regresada_en &&
      !(e.path && (enCola.has(e.path) || quitadasAqui.current.has(e.path) || rutasQuitadas.has(e.path)))
  );
  const regresadas = evidencias.filter((e) => !!e.regresada_en);
  const fotosServidor =
    (sinServidor || cargando) && !evidencias.length
      ? // Sin lectura (sin señal o aún buscando): lo que dice la lista
        // (aproximado: incluye videos). Si no, mientras busca diría "faltan
        // todas" e invitaría a repetirlas.
        Math.max(0, fila.fotos || 0)
      : vigentes.filter((e) => e.tipo !== 'video').length;
  const pendientes = locales.filter((l) => !esFinal(l.estado));
  const fotosCola = pendientes.filter((l) => l.tipo === 'foto').length;
  const perdidas = locales.filter((l) => l.estado === 'perdido');
  const enServidor = new Set(evidencias.map((e) => e.path));
  const fotosRecientes = recientes.filter((r) => !enServidor.has(r.path) && !enCola.has(r.path)).length;
  const total = fotosServidor + fotosCola + fotosRecientes;
  const faltanFotos = Math.max(0, regla.fotos - total);
  const hayAlgo =
    vigentes.length + pendientes.length + fotosRecientes > 0 || (sinServidor && (fila.fotos || 0) > 0);
  // Las de la cámara que siguen en la cola de otra vez que se abrió esta toma
  // (la cola avisa «ábrela y toca Guardar en Fotos»).
  const deEstaVentana = new Set(deCamara.map((d) => d.path));
  const deColaCamara = locales
    .filter((l) => l.origen === 'camara' && !deEstaVentana.has(l.path))
    .map((l) => leidosPorPath.current.get(l.path))
    .filter((f): f is File => !!f);
  // Fotos primero y videos al final. En Android, Compartir no acepta más de
  // ~50 MiB por vez: un video más grande ahí trababa el grupo de las fotos.
  const todosCamara = [...deCamara.map((d) => d.file), ...deColaCamara];
  const esVideo = (f: File) => f.type.startsWith('video/');
  const muyGrande = (f: File) => android && esVideo(f) && f.size > 50 * 1024 * 1024;
  const paraFotos = [
    ...todosCamara.filter((f) => !esVideo(f)),
    ...todosCamara.filter((f) => esVideo(f) && !muyGrande(f)),
  ];
  const videosGrandes = todosCamara.filter(muyGrande).length;
  const camaraSinSubir = deCamara.some((d) => enCola.has(d.path)) || deColaCamara.length > 0;

  // El «faltan N» de un intento de registro se va solo cuando ya no faltan.
  const errFaltan = useRef('');
  useEffect(() => {
    if (faltanFotos === 0 && errFaltan.current && err === errFaltan.current) {
      errFaltan.current = '';
      setErr('');
    }
  }, [faltanFotos, err]);

  // --- Acciones ---
  const subir = async (files: File[], origen: 'camara' | 'galeria') => {
    if (!files.length) return;
    setErr('');
    setAviso('');
    setGuardando(true);
    try {
      const r = await encolarFotos(email, ctx, files.map((file) => ({ file, origen })), ref);
      if (r.tipo === 'error') {
        setErr(r.mensaje);
        return;
      }
      r.archivos.forEach((a, i) => sesionPorPath.current.set(a.path, files[i]));
      if (origen === 'camara') {
        const nuevas = r.archivos
          // Fotos y videos: la cámara de la app no deja ninguno en el carrete.
          .map((a, i) => ({ path: a.path, file: renombrar(files[i], a.nombre, a.mime) }));
        if (nuevas.length) setDeCamara((prev) => [...prev, ...nuevas]);
      }
    } catch (e) {
      setErr('No se pudo guardar en el teléfono: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      if (vivo.current) setGuardando(false);
      void leerCola();
    }
  };

  /** Quitar una foto que sigue en la cola: no espera a la subida. */
  const quitarLocal = async (l: Local) => {
    const texto =
      l.estado === 'perdido'
        ? '¿Quitar esta foto? Ya no estaba en el teléfono.'
        : l.estado === 'subido' || l.estado === 'ligando'
          ? '¿Quitar esta foto? Ya subió, pero no ha entrado a la toma: se quita de la toma y del teléfono.'
          : l.estado === 'fallido'
            ? '¿Quitar esta foto? No se pudo subir: se borra del teléfono.'
            : '¿Quitar esta foto? Todavía no se sube: se borra del teléfono.';
    if (!confirm(texto)) return;
    quitadasAqui.current.add(l.path);
    const r = await quitarArchivo(l.trabajo, l.fid);
    if (r === 'no-estaba') {
      // Justo terminó de entrar (su trabajo ya cerró): sigue en la toma. No
      // se esconde; se relee y se dice cómo quitarla.
      quitadasAqui.current.delete(l.path);
      void cargar();
      void leerCola();
      if (vivo.current)
        setAviso('Esa foto ya había entrado a la toma. Si no la quieres, bórrala con el bote de su miniatura.');
      return;
    }
    setDeCamara((prev) => prev.filter((d) => d.path !== l.path));
    void leerCola();
  };

  const borrar = async (ev: EvidenciaPauta) => {
    if (!confirm('¿Eliminar esta evidencia?')) return;
    // Si esa ruta sigue en la cola (p. ej. a medio registrar), se marca
    // quitada antes: la cola no la vuelve a insertar.
    const enCola = ev.path ? await quitarPorPath(email, ev.path) : false;
    // Primero la fila y se confirma que se borró: si la toma se comprobó
    // mientras el modal estaba abierto, la base ya no deja borrar (22-oct-2026)
    // y no debe irse el archivo de una foto que sigue registrada. Después el
    // archivo; si eso fallara, queda un huérfano en Storage, que es lo menos
    // malo.
    const { data, error, status } = await sb.from('pauta_evidencias').delete().eq('id', ev.id).select('id');
    // Sin señal y con la ruta en la cola: la cola la borra después, con
    // reintento. Solo por falla de red: si la base lo rechazó (comprobada),
    // la foto sigue a la vista con el mensaje de abajo.
    if (enCola && ev.path && error && pareceSinRed(error, status) && (await limpiarDespuesPorPath(email, ev.path))) {
      setEvidencias((prev) => prev.filter((x) => x.id !== ev.id));
      setDeCamara((prev) => prev.filter((d) => d.path !== ev.path));
      setAviso('Se quita de la toma en cuanto haya señal.');
      void leerCola();
      return;
    }
    if (error) {
      setErr('No se pudo eliminar: ' + error.message);
      return;
    }
    if (!data || data.length === 0) {
      setErr('No se pudo eliminar: la toma ya está comprobada o no tienes permiso.');
      return;
    }
    if (ev.path) await sb.storage.from(BUCKET_EVIDENCIAS).remove([ev.path]);
    setEvidencias((prev) => prev.filter((x) => x.id !== ev.id));
    if (ev.path) setDeCamara((prev) => prev.filter((d) => d.path !== ev.path));
  };

  /**
   * "Registrar toma": se lo pide a la cola (único camino a registrar_toma).
   * Con señal queda registrada en un par de segundos; si no, se cierra con
   * el aviso de que se registra sola cuando suban las fotos.
   */
  const registrar = async () => {
    if (registrandoRef.current) return;
    setPreguntaCerrar(false);
    if (!hayAlgo) {
      setErr('Adjunta al menos una foto o video. La toma ES la captura de la evidencia.');
      return;
    }
    if (perdidas.length) {
      setErr(
        `${perdidas.length === 1 ? 'Una foto ya no estaba' : `${perdidas.length} fotos ya no estaban`} en el teléfono: ` +
          'quítala(s) y vuelve a tomarla(s).'
      );
      return;
    }
    // La especificación es la condición: sin sus fotos, la toma no se
    // registra — es exactamente lo que el analista rechazaría después.
    if (faltanFotos > 0) {
      const msg = `La especificación pide ${regla.fotos} fotos (${regla.resumen}) y llevas ${total}. Faltan ${faltanFotos}.`;
      errFaltan.current = msg;
      setErr(msg);
      return;
    }
    registrandoRef.current = true;
    setRegistrando(true);
    setErr('');
    setAviso('');
    const r = await pedirRegistro(email, ctx, regla.fotos, {
      // Sin motivo de regreso a la vista, la base de "regresada" es "sin
      // rechazo" y no hace falta ir a la red para fijarla.
      sinRechazo: !fila.rechazo_motivo,
      enPantalla: () => vivo.current,
    });
    registrandoRef.current = false;
    if (!vivo.current) return;
    setRegistrando(false);
    if (r.tipo === 'error') {
      setErr(r.mensaje);
      void leerCola();
      return;
    }
    if (r.tipo === 'registrada') {
      onRegistrada(fila.vendor_face_id, { enCola: false, fotos: Math.max(r.fotos, total) });
      onClose();
      return;
    }
    // Pedido en la cola. Si hay fotos que no cupieron en el teléfono, cerrar
    // esta ventana invita a salir de la app y perderlas: aquí se queda.
    if (enRiesgoRef.current > 0) {
      setRegistroPedido(true);
      setAviso(
        'Quedó pedido el registro, pero tu teléfono no tiene espacio: no salgas de la app ni abras la cámara hasta que suban las fotos.'
      );
      return;
    }
    onRegistrada(fila.vendor_face_id, { enCola: true, fotos: total });
    onClose();
  };

  /** Cerrar: si quedan fotos sin registrar (o fuera del teléfono), se pregunta antes. */
  const intentarCerrar = () => {
    if (guardando || registrando) return;
    if (enRiesgo > 0 && pendientes.length) {
      setPreguntaCerrar(true);
      return;
    }
    // Mientras busca lo ya subido, la cuenta es aproximada: no se pregunta.
    if (!cargando && !yaRegistrada && !registroPedido && !cerrada && total > 0) {
      setPreguntaCerrar(true);
      return;
    }
    onClose();
  };

  // La cola registró (o ya está pedido) con la pregunta abierta: «¿La
  // registras?» ya no aplica. Solo sigue la de "no cupieron" mientras haya
  // fotos fuera del teléfono por subir.
  const preguntaRiesgo = enRiesgo > 0 && pendientes.length > 0;
  useEffect(() => {
    if ((yaRegistrada || registroPedido) && !preguntaRiesgo) setPreguntaCerrar(false);
  }, [yaRegistrada, registroPedido, preguntaRiesgo]);

  // --- Guardar en Fotos ---
  const grupos = gruposParaCompartir(paraFotos, android);
  const grupoActual = grupos[Math.min(grupo, Math.max(0, grupos.length - 1))] || [];
  const guardarFotos = () => {
    if (!grupoActual.length || compartiendo) return;
    setCompartiendo(true);
    // La hoja de compartir de iOS 15 a veces no resolvía la promesa: el botón
    // no debe quedar trabado.
    const reloj = window.setTimeout(() => {
      if (vivo.current) setCompartiendo(false);
    }, 10000);
    // Sin await antes: share() necesita el toque del usuario vigente.
    void guardarEnFotos(grupoActual).then((r) => {
      window.clearTimeout(reloj);
      if (!vivo.current) return;
      setCompartiendo(false);
      if (r === 'reintentar') setAviso('No se abrió Compartir: toca otra vez «Guardar en Fotos».');
      else if (r === 'error' || r === 'no-disponible') setAviso('Este teléfono no dejó abrir Compartir.');
      else if (r === 'abierta' && grupos.length > 1) setGrupo((i) => (i + 1) % grupos.length);
    });
  };
  const textoGuardar =
    grupos.length > 1
      ? `Guardar en Fotos (${Math.min(grupo, grupos.length - 1) + 1} de ${grupos.length})`
      : `Guardar en Fotos (${paraFotos.length})`;
  const hayVideo = grupoActual.some((f) => f.type.startsWith('video/'));
  const ayudaGuardar = android
    ? 'Se abre Compartir: elige Fotos o Galería.'
    : hayVideo
      ? 'Se abre Compartir: elige la opción «Guardar…».'
      : `Se abre Compartir: elige «Guardar ${grupoActual.length === 1 ? 'imagen' : `${grupoActual.length} imágenes`}».`;

  // --- Textos de estado ---
  const resumenCola =
    pendientes.length > 0
      ? `${plural(total, 'foto', 'fotos')}` +
        (fotosServidor ? ` · ${plural(fotosServidor, 'subida', 'subidas')}` : '') +
        ` · ${pendientes.length} en el teléfono, ${
          !enLinea ? 'sin señal' : pendientes.some((l) => l.enviando) ? 'subiendo…' : 'en espera de subir'
        }`
      : '';

  return (
    <div
      className="overlay"
      onClick={(e) => {
        // Mientras copia al teléfono o registra, un roce en el overlay no
        // debe cerrar el modal.
        if ((e.target as HTMLElement).className === 'overlay') intentarCerrar();
      }}
    >
      <div className="modal">
        <CerrarModal onClick={intentarCerrar} disabled={guardando || registrando} />
        <h2 style={{ margin: '0 0 3px' }}>
          {yaRegistrada ? 'Evidencia de la toma' : 'Registrar toma'}
        </h2>
        <p className="phint">
          {fila.site_id} · cara {fila.cara || caraLabel(fila.vendor_face_id)} ·{' '}
          {fila.campana || '(sin campaña)'}
        </p>

        {err && <div className="err">{err}</div>}
        {errorCola && !err && <div className="err">{errorCola}</div>}
        {aviso && (
          <div className="banner" style={{ marginBottom: 12 }} role="status">
            {aviso}
          </div>
        )}

        {/* Contexto: qué debe fotografiar y con qué especificación. */}
        <div
          style={{
            background: 'var(--panel2)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '11px 12px',
            marginBottom: 14,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
            <Ic i={ClipboardList} />Qué se está monitoreando
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            {fila.direccion || '(sin dirección)'}
            <br />
            Campaña: <b style={{ color: 'var(--txt)' }}>{fila.campana || '—'}</b>
            {fila.version && (
              <>
                <br />
                Arte: {fila.version}
              </>
            )}
            {fila.campana_anterior && (
              <>
                <br />
                Antes: {fila.campana_anterior}
              </>
            )}
            <br />
            {fila.medio} · {fila.estatus}
            {fila.fecha_fijacion && ` · fijada ${fila.fecha_fijacion}`}
          </div>

          {/* La especificación de toma, al pie y con su color: es LA
              instrucción de trabajo — decide cuántas fotos van. El color
              lo pone la regla (lib/especToma); ámbar = texto que la app
              aún no homologa y hay que leer con cuidado. */}
          <div
            style={{
              marginTop: 10,
              paddingTop: 9,
              borderTop: '1px solid var(--line)',
              fontSize: 12,
              lineHeight: 1.55,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                padding: '4px 10px',
                borderRadius: 8,
                fontWeight: 700,
                background: tonoRegla?.background,
                color: tonoRegla?.color ?? regla.color,
                border: tonoRegla ? '1px solid ' + tonoRegla.borderColor : undefined,
                overflowWrap: 'anywhere',
              }}
            >
              <Ic i={Camera} />{fila.espec_toma?.trim() || 'Sin especificación de toma'}
            </span>
            <div style={{ color: 'var(--muted)', marginTop: 4 }}>
              Requiere <b style={{ color: tonoRegla?.color ?? regla.color }}>{regla.fotos} fotos</b>{' '}
              ({regla.resumen}).
            </div>
          </div>
        </div>

        {yaRegistrada &&
          (fila.fecha_toma ? (
            <div className="banner" style={{ marginBottom: 14 }}>
              Esta cara ya tiene toma registrada
              {fila.toma_por ? ` por ${fila.toma_por.split('@')[0]}` : ''}. Puedes
              agregar más evidencia; la fecha original no cambia.
            </div>
          ) : (
            <div className="banner" style={{ marginBottom: 14 }} role="status">
              ✓ La toma quedó registrada. Puedes agregar más evidencia.
            </div>
          ))}

        {!yaRegistrada && registroPedido && (
          <div className="banner" style={{ marginBottom: 14 }} role="status">
            Ya pediste registrar esta toma: se registra sola en cuanto suban las fotos (con la app abierta).
          </div>
        )}

        {/* Toma de reposición: el monitorista ve POR QUÉ se la regresaron
            antes de volver a disparar la cámara. Desde el 22-oct-2026 la
            regresa el analista (antes, el coordinador). */}
        {!yaRegistrada && !registroPedido && fila.rechazo_motivo && (
          <div className="err">
            ⛔ El analista regresó la toma: “{fila.rechazo_motivo}”. Sube las fotos que faltan.
          </div>
        )}

        {sinServidor && (
          <div className="banner" style={{ marginBottom: 12 }} role="status">
            Sin señal: no se ven las fotos que ya subiste
            {fila.fotos ? `; según la lista llevas ${fila.fotos}` : ''}. Toma solo las que faltan: todo se
            cuenta al volver la señal.
          </div>
        )}

        <div className="field">
          <label>Referencia / ubicación (opcional)</label>
          <input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="Ej. toma larga, cara norte, con obstrucción"
            disabled={guardando}
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Se etiqueta con este texto lo que subas a continuación.
          </div>
        </div>

        <div className="field">
          <label>
            Fotos de la cara —{' '}
            {faltanFotos === 0 ? (
              <span style={{ color: fotosCola ? 'var(--muted)' : 'var(--ok)' }}>
                ✓ {total}/{regla.fotos}
                {fotosCola > 0 && ` (${fotosCola} por subir)`}
              </span>
            ) : (
              // --accent-txt: el naranja como texto, con pareja legible en
              // el tema claro (tema claro/oscuro, 24-sep-2026).
              <span style={{ color: 'var(--accent-txt)' }}>
                {total}/{regla.fotos} · faltan {faltanFotos}
                {fotosCola > 0 && ` (${fotosCola} por subir)`}
              </span>
            )}
          </label>

          {/* La cámara no espera a la lectura del servidor: con una barra
              tardaba decenas de segundos (el conteo solo hace falta para
              registrar). */}
          {cargando && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }} role="status">
              Buscando evidencia ya subida…
            </div>
          )}
          {resumenCola && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }} role="status">
              {resumenCola}
            </div>
          )}
          {(vigentes.length > 0 || locales.length > 0) && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill,minmax(84px,1fr))',
                gap: 8,
                marginBottom: 10,
              }}
            >
              {vigentes.map((ev) => {
                // Con el File de esta ventana se pinta sin volver a bajarla.
                const local = ev.path ? sesionPorPath.current.get(ev.path) : undefined;
                const src = (ev.path && urls.current.get(ev.path)) || ev.url;
                return (
                  <div key={`s-${ev.id}`}>
                    {ev.tipo === 'video' ? (
                      <a
                        href={ev.url}
                        target="_blank"
                        rel="noreferrer"
                        className="tag"
                        style={{
                          display: 'flex',
                          height: 84,
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 22,
                        }}
                      >
                        🎥
                      </a>
                    ) : local ? (
                      <img
                        src={src}
                        alt={ev.referencia || 'Evidencia de la toma'}
                        onClick={() => setVer(local)}
                        role="button"
                        style={{
                          width: '100%',
                          height: 84,
                          objectFit: 'cover',
                          borderRadius: 9,
                          border: '1px solid var(--line)',
                          display: 'block',
                          cursor: 'pointer',
                        }}
                      />
                    ) : (
                      <a href={ev.url} target="_blank" rel="noreferrer">
                        <img
                          src={ev.url}
                          alt={ev.referencia || 'Evidencia de la toma'}
                          style={{
                            width: '100%',
                            height: 84,
                            objectFit: 'cover',
                            borderRadius: 9,
                            border: '1px solid var(--line)',
                            display: 'block',
                          }}
                        />
                      </a>
                    )}
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--muted)',
                        marginTop: 3,
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 4,
                      }}
                    >
                      {/* nowrap: sin él, text-overflow no hace nada (el
                          texto envuelve y se corta a media palabra bajo la
                          miniatura); el title conserva el texto completo. */}
                      <span
                        style={{
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={ev.referencia || ''}
                      >
                        {ev.referencia || ''}
                      </span>
                      {!cerrada && (
                        <button
                          type="button"
                          className="btn-icono"
                          onClick={() => borrar(ev)}
                          aria-label="Eliminar evidencia"
                          title="Eliminar"
                        >
                          <Ic i={Trash} className="solo" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {locales.map((l) => {
                const f = sesionPorPath.current.get(l.path) ?? leidosPorPath.current.get(l.path);
                return (
                  <div key={`c-${l.trabajo}-${l.fid}`}>
                    <div style={{ position: 'relative' }}>
                      {l.tipo === 'video' || !l.url ? (
                        <div
                          className="tag"
                          style={{
                            display: 'flex',
                            height: 84,
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 22,
                          }}
                        >
                          {l.tipo === 'video' ? '🎥' : '🖼️'}
                        </div>
                      ) : (
                        <img
                          src={l.url}
                          alt={l.referencia || `Foto ${l.n} en el teléfono`}
                          onClick={f ? () => setVer(f) : undefined}
                          role={f ? 'button' : undefined}
                          style={{
                            width: '100%',
                            height: 84,
                            objectFit: 'cover',
                            borderRadius: 9,
                            border: '1px solid var(--line)',
                            display: 'block',
                            cursor: f ? 'pointer' : undefined,
                          }}
                        />
                      )}
                      <Marca l={l} />
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: l.estado === 'perdido' || l.estado === 'fallido' ? 'var(--warn)' : 'var(--muted)',
                        marginTop: 3,
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 4,
                      }}
                    >
                      <span
                        style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={
                          l.estado === 'perdido'
                            ? 'No estaba en el teléfono'
                            : l.estado === 'fallido'
                              ? 'No se pudo subir; se reintenta'
                              : l.referencia || ''
                        }
                      >
                        {l.estado === 'perdido' ? 'No estaba' : l.estado === 'fallido' ? 'No subió' : l.referencia || ''}
                      </span>
                      <button
                        type="button"
                        className="btn-icono"
                        onClick={() => quitarLocal(l)}
                        aria-label="Quitar foto"
                        title="Quitar"
                      >
                        <Ic i={Trash} className="solo" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Guardar en Fotos: la cámara de la app no deja las fotos en el
              carrete. Solo las tomadas con la cámara en esta ventana (las
              de la galería ya están en Fotos). */}
          {/* También sin botón (todo es un video demasiado grande): el
              aviso de que no se puede compartir y de lo que no cupo sí sale. */}
          {puedeFotos && (paraFotos.length > 0 || videosGrandes > 0) && (
            <div style={{ marginBottom: 10 }}>
              {paraFotos.length > 0 && (
                <>
                  <button
                    type="button"
                    className={enRiesgo > 0 ? 'btn sm' : 'btn ghost sm'}
                    onClick={guardarFotos}
                    disabled={compartiendo}
                  >
                    <Ic i={ImageDown} />
                    {textoGuardar}
                  </button>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{ayudaGuardar}</div>
                </>
              )}
              {videosGrandes > 0 && (
                <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 4 }}>
                  {videosGrandes === 1 ? 'Un video pesa' : `${videosGrandes} videos pesan`} demasiado para
                  Compartir en este teléfono: espera a que suba.
                </div>
              )}
              {(enRiesgo > 0 || (!enLinea && camaraSinSubir)) && (
                <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 4 }}>
                  {enRiesgo > 0
                    ? `${plural(enRiesgo, 'foto no cupo', 'fotos no cupieron')} en el teléfono: si cierras la app antes de que suban, se pierden.` +
                      (paraFotos.length > 0 ? ' Guárdalas en Fotos.' : ' No cierres la app.')
                    : paraFotos.length > 0
                      ? 'Sin señal: guárdalas también en Fotos por si acaso.'
                      : 'Sin señal: no cierres la app hasta que suba.'}
                </div>
              )}
            </div>
          )}

          {regresadas.length > 0 && (
            <details style={{ marginBottom: 10, fontSize: 12, color: 'var(--muted)' }}>
              <summary style={{ cursor: 'pointer' }}>
                {regresadas.length} {regresadas.length === 1 ? 'archivo' : 'archivos'} de la toma
                regresada (ya no cuentan)
              </summary>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill,minmax(64px,1fr))',
                  gap: 6,
                  marginTop: 6,
                  opacity: 0.6,
                }}
              >
                {regresadas.map((ev) => (
                  <a key={ev.id} href={ev.url} target="_blank" rel="noreferrer" className="tag" style={{ display: 'block', padding: 0 }}>
                    {ev.tipo === 'video' ? (
                      <span style={{ display: 'flex', height: 64, alignItems: 'center', justifyContent: 'center' }}>🎥</span>
                    ) : (
                      <img
                        src={ev.url}
                        alt="Evidencia de la toma regresada"
                        style={{ width: '100%', height: 64, objectFit: 'cover', borderRadius: 8, display: 'block' }}
                      />
                    )}
                  </a>
                ))}
              </div>
            </details>
          )}

          {cerrada ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Toma comprobada: ya no se agregan ni se quitan fotos.
            </div>
          ) : (
            <SubirArchivos
              onFiles={subir}
              esperarOnFiles
              // Mientras registra, una foto nueva llegaría tarde al registro.
              disabled={guardando || registrando}
              ayuda={
                'Se guardan en el teléfono y se suben solas. Puedes cerrar esta ventana: se suben mientras la app esté abierta.' +
                (!estaInstalada() && pendientes.length
                  ? ' Estás en Safari: si cierras esta pestaña, vuelve a abrir esta página en Safari (no el ícono) para que terminen de subir.'
                  : '')
              }
            />
          )}
          {guardando && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }} role="status">
              <span className="spinner" />
              Guardando en el teléfono…
            </div>
          )}
        </div>

        {preguntaCerrar ? (
          <div className="modal-actions pie-fijo" style={{ flexWrap: 'wrap' }}>
            <div style={{ flexBasis: '100%', fontSize: 13, marginBottom: 6 }} role="alert">
              {enRiesgo > 0 && pendientes.length
                ? `${plural(enRiesgo, 'foto no cupo', 'fotos no cupieron')} en el teléfono: si cierras la app antes de que suban, se pierden. Espera a que suban o guárdalas en Fotos.`
                : faltanFotos === 0
                  ? `Ya tienes las ${plural(total, 'foto', 'fotos')}, pero la toma no está registrada. ¿La registras?`
                  : pendientes.length
                    ? `Tus ${plural(total, 'foto', 'fotos')} quedan guardadas y se suben solas. Te faltan ${faltanFotos} para registrar la toma.`
                    : `Llevas ${plural(total, 'foto subida', 'fotos subidas')}, pero la toma no está registrada: te faltan ${faltanFotos}.`}
            </div>
            {enRiesgo > 0 && pendientes.length ? (
              <>
                <button className="btn ghost" onClick={onClose} disabled={guardando || registrando}>
                  Cerrar de todos modos
                </button>
                <button className="btn" onClick={() => setPreguntaCerrar(false)}>
                  Esperar
                </button>
              </>
            ) : faltanFotos === 0 ? (
              <>
                <button className="btn ghost" onClick={onClose} disabled={guardando || registrando}>
                  Cerrar sin registrar
                </button>
                <button className="btn" onClick={registrar} disabled={registrando || guardando || cargando}>
                  {registrando ? 'Registrando…' : 'Registrar toma'}
                </button>
              </>
            ) : (
              <>
                <button className="btn ghost" onClick={onClose} disabled={guardando || registrando}>
                  Cerrar
                </button>
                <button className="btn" onClick={() => setPreguntaCerrar(false)}>
                  Seguir tomando
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="modal-actions pie-fijo">
            <button className="btn ghost" onClick={intentarCerrar} disabled={guardando || registrando}>
              Cerrar
            </button>
            {!yaRegistrada && !registroPedido && !cerrada && (
              <button
                className="btn"
                onClick={registrar}
                disabled={registrando || guardando || cargando}
              >
                {registrando ? 'Registrando…' : 'Registrar toma'}
              </button>
            )}
          </div>
        )}
      </div>
      {ver && <VisorFile file={ver} onClose={() => setVer(null)} />}
    </div>
  );
}

export default RegistrarTomaModal;
