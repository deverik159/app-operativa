// ============================================================
// src/modules/mis-rutas/CapturaSitio.tsx
// La captura dentro de la tarjeta de un sitio en Mis rutas › Comprobaciones
// (fase 3, incremento 2, 26-oct-2026; especificación §6.1).
//
// Qué hace:
//   · Cámara y Galería (sin botón de Video, B6: un video elegido en Galería
//     se sube como «Otra» y nunca cuenta). Cada foto pasa por la hoja
//     «¿qué es? ¿de cuál?» (HojaQueEs) y se guarda en el teléfono; la cola
//     (lib/colaFotos/adaptadorComp) la sube, la liga y registra sola cada
//     toma en cuanto su plantilla está completa (B11).
//   · Miniaturas de las fotos de la visita con «Usar también para…» (la misma
//     foto en otra versión, mismo cliente_id) y «Quitar» (de toda la visita
//     o de una sola versión).
//   · «Guardar en Fotos» por sitio: lo tomado con la cámara de la app en esta
//     sesión más lo que siga en la cola, con nombres <sitio_clave>_<DDMM>_<n>.
//     Los File se preparan ANTES del toque: navigator.share({files}) va sin
//     ningún await antes (lib/guardarEnFotos).
//   · «Listo con este sitio»: cierra la visita, registra lo completo y la
//     tarjeta pinta en ámbar lo que falta («Falta: Larga de Suburbia V1»).
//
// La cola nunca lanza: cada acción contesta y aquí solo se dice. Los errores
// de una acción van con role="alert"; lo demás con role="status".
// ============================================================
import { Camera } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Ic from '../../components/Ic';
import { sb } from '../../lib/supabase';
import { BUCKET_EVIDENCIAS } from '../../lib/storage';
import { prepararArchivos } from '../../lib/comprimirImagen';
import { esAndroid, guardarEnFotos, puedeGuardarEnFotos } from '../../lib/guardarEnFotos';
import { colorTono, fondoTono } from '../../lib/tonos';
import { etiquetaDePos, type MomentoPos } from '../../lib/plantillasComp';
import { nombreToma, type TarjetaSitio } from '../../lib/misTomasComp';
import { esFinal } from '../../lib/colaFotos/logica';
import { textoNoLigada, type EstadoVisita, type FotoEnVisita } from '../../lib/colaFotos/logicaComp';
import {
  archivoLocalComp,
  archivosParaGuardar,
  cerrarVisita,
  claveDeVisita,
  encolarFotosComp,
  fotosQuitadasDeVerdad,
  gruposParaCompartir,
  quitarFotoComp,
  usarTambienPara,
  type FotoNueva,
  type ResultadoCerrar,
} from '../../lib/colaFotos/adaptadorComp';
import {
  camaraPorSacar,
  candidatasDeCual,
  candidatasUsarTambien,
  diaFilaSitio,
  fotoDeLaHoja,
  fotosArribaSinEnviar,
  idsEnCola,
  opcionesQueEs,
  plural,
  POS_EXTRA,
  tomaAbiertaEnPantalla,
  visitaDeTarjeta,
  type FotoPorSacar,
} from '../../lib/capturaComp';
import HojaQueEs, { type EleccionHoja } from './HojaQueEs';

// ------------------------------------------------------------
// Lo que dura la sesión de la app (no la pantalla): la tarjeta se desmonta
// al cambiar de filtro o de día y esto no se debe perder.
// ------------------------------------------------------------

/** Fotos tomadas con la cámara de la APP (no llegan al carrete del iPhone), por visita. */
const deCamara = new Map<string, File[]>();
/** La última versión elegida en el sitio (el loop de Vía Verde), por visita. */
const ultimaPorVisita = new Map<string, number>();
/**
 * Fotos ya elegidas que esperan su hoja, por visita. Fuera del componente:
 * si la lista se relee y la tarjeta se desmonta (p. ej. con el chip «Por
 * tomar» y la última toma recién enviada), la foto de la cámara NO se pierde;
 * la hoja vuelve a salir cuando la tarjeta regresa.
 */
const pendientesPorVisita = new Map<string, Pendiente[]>();

/** Saca de «Guardar en Fotos» la foto de cámara que de verdad se quitó. */
function quitarDeCamara(clave: string, nombre: string): void {
  const l = (deCamara.get(clave) ?? []).filter((f) => f.name !== nombre);
  if (l.length) deCamara.set(clave, l);
  else deCamara.delete(clave);
}
/**
 * «Quitar» y «Quitar de A» que esperan saber si la foto de verdad se fue (por
 * visita): su copia de cámara se saca cuando la cola la deja como lápida firme
 * (camaraPorSacar).
 */
const porSacarDeCamara = new Map<string, FotoPorSacar[]>();

/** Botones chicos de cada foto: 44 px y el texto largo se parte (375 px sin scroll horizontal). */
const BOTON_FOTO = { minHeight: 44, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'left' } as const;

type Pendiente = { file: File; origen: 'camara' | 'galeria'; tomada_en: string | null };

type Ubicacion = { lat: number; lng: number; precision_m: number; en: number };

/**
 * La ubicación, SOLO si el permiso ya está dado (no se pregunta a mitad de
 * la ruta: es opcional). Se reusa por 2 minutos.
 */
function useUbicacion() {
  const ref = useRef<Ubicacion | null>(null);
  const pedir = useCallback(() => {
    try {
      if (typeof navigator === 'undefined' || !navigator.geolocation || !navigator.permissions?.query) return;
      if (ref.current && Date.now() - ref.current.en < 120000) return;
      void navigator.permissions
        .query({ name: 'geolocation' as PermissionName })
        .then((p) => {
          if (p.state !== 'granted') return;
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              ref.current = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                precision_m: Math.round(pos.coords.accuracy),
                en: Date.now(),
              };
            },
            () => {
              /* sin ubicación: la foto va sin coordenadas */
            },
            { enableHighAccuracy: false, maximumAge: 60000, timeout: 8000 }
          );
        })
        .catch(() => {
          /* Safari viejo sin Permissions: sin ubicación */
        });
    } catch {
      /* sin ubicación */
    }
  }, []);
  return { ref, pedir };
}

/** La miniatura de una foto de la visita: el File del teléfono o, ya arriba, la dirección pública. */
function MiniFoto({ f }: { f: FotoEnVisita }) {
  const [src, setSrc] = useState<string | null>(null);
  const arriba = f.estado === 'ligado' || f.estado === 'subido';
  useEffect(() => {
    let vivo = true;
    let objeto: string | null = null;
    const publica = () => {
      try {
        return sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(f.path).data.publicUrl;
      } catch {
        return null;
      }
    };
    if (f.tipo === 'video') {
      setSrc(null);
      return;
    }
    if (!esFinal(f.estado) && f.enTelefono) {
      void archivoLocalComp(f.trabajo, f.fid).then((file) => {
        if (!vivo) return;
        if (file) {
          objeto = URL.createObjectURL(file);
          setSrc(objeto);
        } else setSrc(arriba ? publica() : null);
      });
    } else setSrc(arriba ? publica() : null);
    return () => {
      vivo = false;
      if (objeto) URL.revokeObjectURL(objeto);
    };
  }, [f.trabajo, f.fid, f.path, f.tipo, f.estado, f.enTelefono, arriba]);
  const caja = {
    width: 72,
    height: 72,
    borderRadius: 8,
    border: '1px solid var(--line)',
    flexShrink: 0,
    background: 'var(--panel2)',
    objectFit: 'cover' as const,
  };
  if (!src)
    return (
      <div style={{ ...caja, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }} aria-hidden="true">
        {f.tipo === 'video' ? '🎥' : '🖼️'}
      </div>
    );
  return <img src={src} alt="" style={caja} loading="lazy" />;
}

/** «en el teléfono», «subiendo…», «✓ arriba»… */
function textoEstadoFoto(f: FotoEnVisita): { texto: string; tono: 'verde' | 'ambar' | 'rojo' | 'gris' } {
  switch (f.estado) {
    case 'ligado':
      // POR QUÉ (27-oct-2026): si ninguna versión la aceptó (cerradas,
      // futuras o ajenas) el servidor ni la registró; el ✓ verde mentía. Igual
      // si se quitó de su última versión (26-oct-2026): ya no está en ninguna.
      if (!f.ligada_en.length) return { texto: 'arriba, pero no cuenta en ninguna versión', tono: 'ambar' };
      return { texto: '✓ arriba', tono: 'verde' };
    case 'subido':
      return { texto: 'subida, ligando…', tono: 'gris' };
    case 'fallido':
      return { texto: 'no entró: revisa el aviso de arriba', tono: 'rojo' };
    case 'perdido':
      return { texto: 'se perdió: vuelve a tomarla', tono: 'rojo' };
    default:
      return { texto: 'en el teléfono', tono: 'gris' };
  }
}

export type PropsCaptura = {
  email: string;
  t: TarjetaSitio;
  hoy: string;
  estado: EstadoVisita | null;
  incluidas: ReadonlySet<string>;
  /** Pide a la lista releer comp_mis_tomas en silencio (tras «Listo», un registro…). */
  onListaCambio: () => void;
  /** Lo que contestó «Listo con este sitio» (la tarjeta pinta en ámbar lo que falta). */
  onCierre: (c: ResultadoCerrar | null) => void;
};

export default function CapturaSitio({ email, t, hoy, estado, incluidas, onListaCambio, onCierre }: PropsCaptura) {
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const clave = useMemo(() => (t.unidad ? claveDeVisita(email, { unidad: t.unidad, sitio_clave: t.sitio_clave, fecha: t.dia }) : ''), [
    email,
    t.unidad,
    t.sitio_clave,
    t.dia,
  ]);
  const enCola = useMemo(() => idsEnCola(estado), [estado]);
  // La visita lleva `incluidas`: la cola no vuelve a sumar lo que `tiene` ya trae.
  const visitaCon = useCallback(
    (extra: readonly number[] = []) => {
      const v = visitaDeTarjeta(t, new Set([...enCola, ...extra]));
      return v ? { ...v, incluidas } : null;
    },
    [t, enCola, incluidas]
  );
  const visita = useMemo(() => visitaCon(), [visitaCon]);
  const tomasVisita = visita?.tomas ?? [];
  // La hoja ofrece TODAS las tomas de la tarjeta (también las vencidas sin
  // fotos que la visita todavía no trae): al elegir una, entra a la visita.
  // POR QUÉ «¿Qué es?» también (26-oct-2026): antes contaba solo lo de la
  // visita mientras quedara algo abierto ahí, y lo que le faltaba a una
  // vencida sin fotos («Corta ☐» de Suburbia V1) no salía como chip.
  // `t` viene sin el filtro del chip (TarjetaSitioComp le pasa la completa).
  const tomasCard = t.tomas;
  const abiertasVisita = tomasVisita.filter((x) => x.fecha <= hoy && tomaAbiertaEnPantalla(x, estado));
  const abiertas = tomasCard.filter((x) => x.fecha <= hoy && tomaAbiertaEnPantalla(x, estado));
  // El día de la fila «Fotos del sitio» (el mismo que pinta la tarjeta).
  const diaSitio = useMemo(() => diaFilaSitio(tomasCard, t.dia), [tomasCard, t.dia]);

  const [pendientes, setPendientesEstado] = useState<Pendiente[]>(() => pendientesPorVisita.get(clave) ?? []);
  const setPendientes = useCallback(
    (fn: (p: Pendiente[]) => Pendiente[]) =>
      setPendientesEstado((p) => {
        const n = fn(p);
        if (n.length) pendientesPorVisita.set(clave, n);
        else pendientesPorVisita.delete(clave);
        return n;
      }),
    [clave]
  );
  const [procesando, setProcesando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [errHoja, setErrHoja] = useState('');
  const [tambien, setTambien] = useState<FotoEnVisita | null>(null);
  const [error, setError] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [cerrando, setCerrando] = useState(false);
  const [ocupadaFoto, setOcupadaFoto] = useState<string | null>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const galRef = useRef<HTMLInputElement>(null);
  const ubic = useUbicacion();
  /** Sube cuando cambia lo que hay en deCamara fuera de un toque (para la firma de «Guardar en Fotos»). */
  const [versionCamara, setVersionCamara] = useState(0);

  // POR QUÉ (26-oct-2026): la hoja «Usar también para…» guarda la foto con la
  // que se abrió. Si mientras tanto la foto se va (p. ej. no contaba en
  // ninguna versión y la cola la quitó al soltar la visita), la hoja se cierra
  // en vez de mandar una foto que ya no está; si sigue, se usa la de ahora
  // (ver fotoDeLaHoja: si solo se soltó la visita, la hoja sigue).
  useEffect(() => {
    if (!tambien) return;
    const ahora = fotoDeLaHoja(estado, tambien);
    if (!ahora) {
      setTambien(null);
      setErrHoja('');
      setMensaje('Esa foto ya no está en la visita.');
    } else if (ahora !== tambien) setTambien(ahora);
  }, [estado, tambien]);

  // «Quitar» y «Quitar de A»: la copia de cámara sale de «Guardar en Fotos»
  // cuando la cola confirma que la foto se fue (ver camaraPorSacar).
  useEffect(() => {
    const pend = porSacarDeCamara.get(clave);
    if (!pend?.length) return;
    const r = camaraPorSacar(estado, pend, fotosQuitadasDeVerdad());
    if (!r.resueltas.length) return;
    for (const n of r.sacar) quitarDeCamara(clave, n);
    const quedan = pend.filter((p) => !r.resueltas.includes(p.cliente_id));
    if (quedan.length) porSacarDeCamara.set(clave, quedan);
    else porSacarDeCamara.delete(clave);
    if (r.sacar.length) setVersionCamara((x) => x + 1);
    // versionCamara: que también se revise al anotar un «Quitar de A» (por si
    // la cola ya contestó y el estado no vuelve a cambiar).
  }, [estado, clave, versionCamara]);

  // ---- Elegir fotos ----
  const manejar = async (e: React.ChangeEvent<HTMLInputElement>, origen: 'camara' | 'galeria') => {
    const files = Array.from(e.target.files || []);
    // Permite volver a elegir el MISMO archivo (si no, onChange no dispara).
    e.target.value = '';
    if (!files.length) return;
    // La hora de la cámara es la de ahora (antes de comprimir); la de
    // Galería la pone la cola con lastModified.
    const tomada = origen === 'camara' ? new Date().toISOString() : null;
    setError('');
    setMensaje('');
    setProcesando(true);
    try {
      const r = await prepararArchivos(files);
      if (!vivo.current) return;
      if (r.rechazos.length) setError('No se agregaron: ' + r.rechazos.join(' '));
      if (r.listos.length) setPendientes((p) => [...p, ...r.listos.map((file) => ({ file, origen, tomada_en: tomada }))]);
    } catch (err) {
      if (vivo.current) setError('No se pudo preparar la foto: ' + String((err as Error)?.message || err));
    } finally {
      if (vivo.current) setProcesando(false);
    }
  };

  // ---- La hoja de la foto que sigue ----
  const actual = pendientes[0] ?? null;
  const totalTanda = useRef(0);
  if (pendientes.length > totalTanda.current) totalTanda.current = pendientes.length;
  if (!pendientes.length && totalTanda.current) totalTanda.current = 0;
  const indice = actual && totalTanda.current > 1 ? { i: totalTanda.current - pendientes.length + 1, n: totalTanda.current } : null;

  const opciones = useMemo(() => opcionesQueEs(tomasCard, estado, incluidas, hoy), [tomasCard, estado, incluidas, hoy]);
  const candidatas = useCallback(
    (pos: string, momento: MomentoPos) => candidatasDeCual(tomasCard, pos, momento, estado, incluidas, hoy),
    [tomasCard, estado, incluidas, hoy]
  );

  const siguiente = () => {
    setErrHoja('');
    setPendientes((p) => p.slice(1));
  };

  const guardarFoto = async (h: EleccionHoja) => {
    if (!actual || guardando) return;
    const v = visitaCon(h.toma_ids);
    if (!v) return;
    setGuardando(true);
    setErrHoja('');
    const u = ubic.ref.current;
    const foto: FotoNueva = {
      file: actual.file,
      origen: actual.origen,
      tomada_en: actual.tomada_en,
      lat: u?.lat ?? null,
      lng: u?.lng ?? null,
      precision_m: u?.precision_m ?? null,
    };
    const r = await encolarFotosComp(email, v, [foto], h);
    if (!vivo.current) return;
    setGuardando(false);
    if (r.tipo === 'error') {
      setErrHoja(r.mensaje);
      return;
    }
    if (h.pos !== POS_EXTRA && h.toma_ids.length === 1) ultimaPorVisita.set(clave, h.toma_ids[0]);
    // Una foto nueva después de «Listo»: el ámbar de entonces ya no aplica.
    onCierre(null);
    if (actual.origen === 'camara') {
      // Para «Guardar en Fotos»: la de la cámara de la app no llega al carrete.
      const a = r.archivos[0];
      let f = actual.file;
      try {
        f = new File([actual.file], a?.nombre || actual.file.name, { type: actual.file.type, lastModified: actual.file.lastModified });
      } catch {
        /* Safari viejo: se queda el nombre original */
      }
      deCamara.set(clave, [...(deCamara.get(clave) ?? []), f]);
    }
    if (!r.enTelefono)
      setMensaje('La foto no cupo en el teléfono: no cierres la app hasta que suba (o guárdala en Fotos).');
    siguiente();
  };

  const cancelarHoja = () => {
    if (!actual) return;
    if (actual.origen === 'camara' && !confirm('¿Descartar esta foto? Todavía no se guardó.')) return;
    siguiente();
  };

  // ---- Usar también para… ----
  const guardarTambien = async (h: EleccionHoja) => {
    if (!tambien || guardando) return;
    const v = visitaCon(h.toma_ids);
    if (!v) return;
    setGuardando(true);
    setErrHoja('');
    const r = await usarTambienPara(
      email,
      v,
      { cliente_id: tambien.cliente_id, path: tambien.path, pos: tambien.pos, momento: tambien.momento, tipo: tambien.tipo, trabajo: tambien.trabajo, fid: tambien.fid },
      h.toma_ids
    );
    if (!vivo.current) return;
    setGuardando(false);
    if (r !== 'ok') {
      setErrHoja(r.error);
      return;
    }
    setTambien(null);
    setMensaje(`La foto también cuenta en ${h.toma_ids.length === 1 ? 'esa versión' : `${h.toma_ids.length} versiones`} (se liga sola).`);
  };

  // ---- Quitar ----
  const nombreDe = (id: number) => {
    const x = t.tomas.find((y) => y.id === id);
    return x ? nombreToma(x) : 'otra toma';
  };
  const quitar = async (f: FotoEnVisita, tomaId?: number) => {
    if (!visita || ocupadaFoto) return;
    const pregunta =
      tomaId === undefined
        ? `¿Quitar la foto ${f.nombre}? ${
            f.estado === 'ligado'
              ? 'Ya está arriba: se borra del servidor. Si alguna de sus tomas ya se envió, ahí se queda y se quita de las demás.'
              : 'Se borra de este teléfono.'
          }`
        : `¿Quitar la foto ${f.nombre} solo de ${nombreDe(tomaId)}?`;
    if (!confirm(pregunta)) return;
    setOcupadaFoto(f.cliente_id);
    setError('');
    const r = await quitarFotoComp(
      email,
      visita,
      { cliente_id: f.cliente_id, path: f.path, pos: f.pos, momento: f.momento, tipo: f.tipo, trabajo: f.trabajo, fid: f.fid },
      tomaId
    );
    if (!vivo.current) return;
    setOcupadaFoto(null);
    if (typeof r === 'object') {
      setError('No se pudo quitar: ' + r.error);
      return;
    }
    // «Guardar en Fotos» deja de ofrecer la copia de cámara solo cuando la
    // cola la deja como lápida firme (camaraPorSacar). POR QUÉ (26-oct-2026):
    // antes «Quitar» entera la sacaba al tocar, y la copia se perdía aunque la
    // base no dejara quitarla (una toma ya enviada o revisada) y la foto
    // volviera a la tarjeta. «Quitar de A» nunca se lleva la foto (si era su
    // única toma, es quitarla entera).
    if (r === 'ok') {
      const l = (porSacarDeCamara.get(clave) ?? []).filter((p) => p.cliente_id !== f.cliente_id);
      porSacarDeCamara.set(clave, [...l, { cliente_id: f.cliente_id, nombre: f.nombre }]);
      setVersionCamara((x) => x + 1);
    }
    if (r === 'no-estaba') setMensaje('Esa foto ya no estaba.');
    else setMensaje(tomaId === undefined ? 'Foto quitada.' : `Foto quitada de ${nombreDe(tomaId)}.`);
    // POR QUÉ (26-oct-2026): la lista se vuelve a leer. Mientras llega, la
    // casilla ya descuenta lo quitado (EstadoVisita.retiradas); y cuando la
    // cola termina de quitarlo en el servidor, el aviso global pide otra
    // lectura (quitadasHastaAhora).
    if (r === 'ok') onListaCambio();
  };

  // ---- Listo con este sitio ----
  const listo = async () => {
    if (!visita || cerrando) return;
    setCerrando(true);
    setError('');
    setMensaje('');
    onCierre(null);
    const r = await cerrarVisita(email, visita, {
      enPantalla: () => vivo.current && typeof document !== 'undefined' && document.visibilityState === 'visible',
    });
    if (!vivo.current) return;
    setCerrando(false);
    if (r.tipo === 'error') {
      setError(r.mensaje);
      return;
    }
    onCierre(r);
    if (r.tipo === 'enCola')
      setMensaje(
        (r.porSubir > 0 ? `${plural(r.porSubir, 'foto sigue', 'fotos siguen')} en el teléfono. ` : '') +
          'Lo completo se envía solo en cuanto haya señal; lo que falte te lo dice el aviso.'
      );
    else {
      const partes: string[] = [];
      if (r.enviadas.length) partes.push(`✓ ${plural(r.enviadas.length, 'toma enviada', 'tomas enviadas')}`);
      if (r.faltan.length) partes.push(`${plural(r.faltan.length, 'toma incompleta', 'tomas incompletas')} (en ámbar)`);
      setMensaje(partes.length ? partes.join(' · ') + '.' : 'Listo: no había nada por enviar.');
    }
    onListaCambio();
  };

  // ---- Guardar en Fotos (preparado ANTES del toque) ----
  const [puedeFotos] = useState(puedeGuardarEnFotos);
  const [android] = useState(esAndroid);
  const [paraFotos, setParaFotos] = useState<File[]>([]);
  const [grupo, setGrupo] = useState(0);
  const [compartiendo, setCompartiendo] = useState(false);
  const firmaFotos = `${estado?.fotos.length ?? 0}|${estado?.porSubir ?? 0}|${deCamara.get(clave)?.length ?? 0}|${versionCamara}`;
  useEffect(() => {
    if (!puedeFotos || !visita) return;
    let vigente = true;
    void archivosParaGuardar(email, visita)
      .catch(() => [] as File[])
      .then((cola) => {
        if (!vigente) return;
        const vistos = new Set<string>();
        const todos: File[] = [];
        for (const f of [...(deCamara.get(clave) ?? []), ...cola]) {
          if (vistos.has(f.name)) continue;
          vistos.add(f.name);
          todos.push(f);
        }
        setParaFotos((prev) => (prev.length === todos.length && prev.every((x, i) => x.name === todos[i].name) ? prev : todos));
      });
    return () => {
      vigente = false;
    };
    // La firma dice cuándo cambió lo que hay que ofrecer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firmaFotos, puedeFotos, email, clave]);
  const grupos = gruposParaCompartir(paraFotos, android);
  const grupoActual = grupos[Math.min(grupo, Math.max(0, grupos.length - 1))] || [];
  const guardarFotos = () => {
    if (!grupoActual.length || compartiendo) return;
    setCompartiendo(true);
    // La hoja de compartir de iOS 15 a veces no resolvía la promesa.
    const reloj = window.setTimeout(() => {
      if (vivo.current) setCompartiendo(false);
    }, 10000);
    // Sin await antes: share() necesita el toque del usuario vigente.
    void guardarEnFotos(grupoActual).then((r) => {
      window.clearTimeout(reloj);
      if (!vivo.current) return;
      setCompartiendo(false);
      if (r === 'reintentar') setMensaje('No se abrió Compartir: toca otra vez «Guardar en Fotos».');
      else if (r === 'error' || r === 'no-disponible') setError('Este teléfono no dejó abrir Compartir.');
      else if (r === 'abierta' && grupos.length > 1) setGrupo((i) => (i + 1) % grupos.length);
    });
  };

  if (!visita) return null;

  const fotos = estado?.fotos ?? [];
  const arribaSinEnviar = !estado ? fotosArribaSinEnviar(t.tomas, hoy) : 0;
  const ocupado = procesando || guardando || cerrando;
  const estiloBoton = { flex: '1 1 130px', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 } as const;

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10, minWidth: 0 }}>
      {estado && estado.porSubir > 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }} role="status">
          {estado.enviando && <span className="spinner" />}⬆ {plural(estado.porSubir, 'foto en el teléfono', 'fotos en el teléfono')}
          {estado.enviando ? ', subiendo…' : ', se suben solas'}
        </div>
      )}
      {estado?.ultimoError && (
        <div style={{ fontSize: 13, color: 'var(--warn)', marginBottom: 6, overflowWrap: 'anywhere' }}>{estado.ultimoError}</div>
      )}
      {arribaSinEnviar > 0 && (
        <div
          style={{
            fontSize: 13,
            marginBottom: 8,
            padding: '6px 10px',
            borderRadius: 8,
            background: fondoTono('ambar'),
            color: colorTono('ambar'),
            overflowWrap: 'anywhere',
          }}
        >
          {plural(arribaSinEnviar, 'foto arriba sin enviar', 'fotos arriba sin enviar')} de días anteriores: toca «Listo con este
          sitio» para enviar lo completo.
        </div>
      )}

      {fotos.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700, marginBottom: 4 }}>
            Fotos de esta visita ({fotos.length})
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
            {fotos.map((f) => {
              const e = textoEstadoFoto(f);
              const etiqueta = f.tipo === 'video' ? 'Video (Otra)' : etiquetaDePos(f.pos) + (f.momento ? ` de ${f.momento === 'dia' ? 'día' : 'noche'}` : '');
              const puedeTambien = f.estado !== 'perdido' && candidatasUsarTambien(f, tomasCard, estado, incluidas, hoy).length > 0;
              return (
                <li key={`${f.trabajo}|${f.fid}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 }}>
                  <MiniFoto f={f} />
                  <div style={{ minWidth: 0, flex: '1 1 auto', fontSize: 13 }}>
                    <div style={{ overflowWrap: 'anywhere' }}>
                      <b>{etiqueta}</b> · <span style={{ color: e.tono === 'gris' ? 'var(--muted)' : colorTono(e.tono) }}>{e.texto}</span>
                    </div>
                    {f.toma_ids.length > 0 && (
                      <div style={{ color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                        {f.ligada_en.length ? 'Cuenta en' : 'Para'}: {(f.ligada_en.length ? f.ligada_en : f.toma_ids).map(nombreDe).join(', ')}
                      </div>
                    )}
                    {f.no_ligada.map((x) => (
                      <div key={x.toma_id} style={{ color: colorTono('ambar'), overflowWrap: 'anywhere' }}>
                        No cuenta en {nombreDe(x.toma_id)}: {textoNoLigada(x.razon)}.
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      {puedeTambien && (
                        <button
                          type="button"
                          className="btn ghost sm"
                          style={BOTON_FOTO}
                          disabled={ocupado || !!ocupadaFoto}
                          onClick={() => {
                            setErrHoja('');
                            setTambien(f);
                          }}
                        >
                          Usar también para…
                        </button>
                      )}
                      {f.toma_ids.length > 1 &&
                        f.toma_ids.map((id) => (
                          <button
                            key={id}
                            type="button"
                            className="btn ghost sm"
                            style={BOTON_FOTO}
                            disabled={ocupado || !!ocupadaFoto}
                            onClick={() => void quitar(f, id)}
                          >
                            Quitar de {nombreDe(id)}
                          </button>
                        ))}
                      <button
                        type="button"
                        className="btn ghost sm"
                        style={BOTON_FOTO}
                        disabled={ocupado || !!ocupadaFoto}
                        onClick={() => void quitar(f)}
                        aria-label={`Quitar la foto ${f.nombre}`}
                      >
                        {ocupadaFoto === f.cliente_id ? <span className="spinner" /> : null}Quitar
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
      {mensaje && (
        <div role="status" style={{ fontSize: 13, marginBottom: 8, overflowWrap: 'anywhere' }}>
          {mensaje}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn"
          style={estiloBoton}
          disabled={ocupado || !abiertas.length}
          onClick={() => {
            ubic.pedir();
            camRef.current?.click();
          }}
        >
          {procesando ? <span className="spinner" /> : <Ic i={Camera} />} {procesando ? 'Procesando…' : 'Cámara'}
        </button>
        <button
          type="button"
          className="btn ghost"
          style={estiloBoton}
          disabled={ocupado || !abiertas.length}
          onClick={() => {
            ubic.pedir();
            galRef.current?.click();
          }}
        >
          <span aria-hidden="true">🖼️</span> Galería
        </button>
        {puedeFotos && grupoActual.length > 0 && (
          <button type="button" className="btn ghost" style={estiloBoton} disabled={compartiendo} onClick={guardarFotos}>
            {compartiendo && <span className="spinner" />}
            {grupos.length > 1
              ? `Guardar en Fotos (${Math.min(grupo, grupos.length - 1) + 1} de ${grupos.length})`
              : `Guardar en Fotos (${paraFotos.length})`}
          </button>
        )}
        <button
          type="button"
          className="btn ghost"
          style={estiloBoton}
          disabled={ocupado || (!abiertasVisita.length && !estado)}
          onClick={() => void listo()}
        >
          {cerrando && <span className="spinner" />} {cerrando ? 'Enviando…' : 'Listo con este sitio'}
        </button>
      </div>
      {!abiertas.length && !estado && (
        <div className="phint" style={{ marginTop: 6 }}>
          Nada por tomar en este sitio.
        </div>
      )}

      {/* Inputs reales, ocultos: la cámara solo foto (sin Video, B6); Galería
          deja elegir varias y también un video (se sube como «Otra»). */}
      <input
        ref={camRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => void manejar(e, 'camara')}
        style={{ display: 'none' }}
      />
      <input
        ref={galRef}
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={(e) => void manejar(e, 'galeria')}
        style={{ display: 'none' }}
      />

      {actual && (
        <HojaQueEs
          key={`${actual.file.name}|${actual.file.lastModified}|${pendientes.length}`}
          modo="nueva"
          sitio_clave={t.sitio_clave}
          dia={t.dia}
          diaSitio={diaSitio}
          archivo={actual.file}
          tipo={actual.file.type.startsWith('video/') ? 'video' : 'foto'}
          indice={indice}
          opciones={opciones}
          candidatas={candidatas}
          ultima={ultimaPorVisita.get(clave) ?? null}
          ocupado={guardando}
          error={errHoja}
          onListo={(h) => void guardarFoto(h)}
          onCancelar={cancelarHoja}
        />
      )}
      {!actual && tambien && (
        <HojaQueEs
          key={`tambien|${tambien.cliente_id}`}
          modo="tambien"
          sitio_clave={t.sitio_clave}
          dia={t.dia}
          diaSitio={diaSitio}
          url={tambien.estado === 'ligado' ? sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(tambien.path).data.publicUrl : null}
          tipo={tambien.tipo}
          opciones={[]}
          posFija={{
            pos: tambien.tipo === 'video' ? POS_EXTRA : tambien.pos,
            momento: tambien.tipo === 'video' ? null : tambien.momento,
            etiqueta: tambien.tipo === 'video' ? 'Otra' : etiquetaDePos(tambien.pos),
          }}
          candidatas={() => candidatasUsarTambien(tambien, tomasCard, estado, incluidas, hoy)}
          ultima={null}
          ocupado={guardando}
          error={errHoja}
          onListo={(h) => void guardarTambien(h)}
          onCancelar={() => {
            setErrHoja('');
            setTambien(null);
          }}
        />
      )}
    </div>
  );
}
