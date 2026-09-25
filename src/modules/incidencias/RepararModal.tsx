// ============================================================
// src/modules/incidencias/RepararModal.tsx
// Registro de la reparación por parte del área responsable.
//
// Dos modos según el área:
//   - Digital (con árbol cargado) → causa y solución GUIADAS desde
//     `arbol_digital`, sin texto libre: se estandariza la captura.
//   - Cualquier otra área          → diagnóstico y detalle libres. NO se
//     captura causa raíz: ese catálogo es exclusivo de Digital.
//
// La evidencia de reparación es OBLIGATORIA. Se cuenta la que YA existe en
// la tabla `evidencias` con etapa='reparacion' —subida antes desde el botón
// 📎 Evidencia— más la que se agregue aquí. Son el mismo dato; obligar a
// resubirla sería pedirle al técnico que haga dos veces el mismo trabajo.
//
// MODO SIN SEÑAL (24-sep-2026): las fotos y videos que se agregan aquí YA
// NO se suben al elegirlos. Viajan junto con la reparación al tocar
// Guardar: el padre los entrega a lib/acciones.ts, que los guarda en el
// teléfono ANTES de mandar y los sube solos al volver la red. Antes, sin
// señal, cada foto tronaba con "Error al subir: Load failed" y Guardar
// exigía evidencia ya subida: reparar sin red era imposible.
//   - Mientras tanto (revisión sin señal, 24-sep-2026) cada foto se guarda
//     en el teléfono EN CUANTO termina de prepararse, con el diagnóstico y
//     el detalle (lib/borradorReparacion.ts): si iOS recarga la app al
//     volver de la cámara, al reabrir la reparación de ESTA incidencia se
//     recuperan ("Recuperamos N fotos…"). Antes solo vivían en la memoria
//     del modal y se perdían sin aviso. Si el teléfono no deja guardarlas
//     (sin lugar, sin IndexedDB) se sigue como antes, solo en memoria, y el
//     modal lo dice.
//   - La evidencia de reparación que YA está en la base (de un intento
//     anterior) se sigue viendo y se puede borrar como antes, solo con
//     señal.
//   - El árbol Digital sale de la red o, si no hay, de la copia del teléfono
//     (lib/datosLocales.ts).
// ============================================================
import { useState, useEffect, useRef } from 'react';
import { sb } from '../../lib/supabase';
import { caraIncidencia } from '../../lib/helpers';
import {
  BUCKET_EVIDENCIAS,
  alFallarMiniatura,
  rutaMiniatura,
  urlMiniatura,
} from '../../lib/storage';
import {
  arbolDigitalLocal,
  fechaCopia,
  haySenal,
  redOLocal,
} from '../../lib/datosLocales';
import { colorTono } from '../../lib/tonos';
import {
  abrirReparacion,
  descartarReparacion,
  entregarReparacion,
  guardarFotoReparacion,
  guardarTextosReparacion,
  quitarFotoReparacion,
  recuperarReparacion,
} from '../../lib/borradorReparacion';
import { MAX_VIDEO_BYTES } from '../../lib/comprimirImagen';
import { vigilarRender } from '../../lib/vigia';
import SubirArchivos from '../../components/SubirArchivos';
import PreviaVideo from '../../components/PreviaVideo';
import type { ArbolDigital, Evidencia, Incidencia } from '../../types/db';

/**
 * Lo que el modal usa de cada fila de arbol_digital. Sirve igual para la
 * fila de la red que para la copia del teléfono (ArbolDigitalLocal trae las
 * mismas columnas), sin convertir tipos que aquí no se leen (sla*).
 */
type FilaArbol = Pick<
  ArbolDigital,
  | 'id'
  | 'incidencia'
  | 'categoria_principal'
  | 'incidencia_srd'
  | 'causa_raiz'
  | 'diagnostico'
  | 'solucion'
>;

/** Tope de las dos consultas al abrir: con respaldo, no se espera más. */
const TOPE_CONSULTA_MS = 6000;

/** Pausa tras la última tecla para guardar diagnóstico y detalle en el borrador. */
const PAUSA_TEXTOS_MS = 700;

/**
 * Respuesta con forma de postgrest para "sin sesión real": redOLocal la
 * trata como falla y cae a lo local.
 */
const SIN_SESION = {
  data: null,
  error: { message: 'sin sesión: el token aún no se renueva' },
  status: 0,
};

/**
 * ¿Hay sesión REAL? Al volver la red hay hasta ~60 s en que getSession da
 * null y las consultas salen como anónimo: la RLS contesta [] SIN error, y
 * eso se leería como "el reportante no adjuntó evidencia" o "esta
 * incidencia no tiene clasificación Digital" (y se guardaría Sin
 * clasificar). Sin sesión, la consulta cuenta como sin red.
 */
async function haySesionReal(): Promise<boolean> {
  try {
    const { data } = await sb.auth.getSession();
    return !!data.session;
  } catch {
    return false;
  }
}

/**
 * Mismo orden que la consulta (incidencia_srd, causa_raiz, solucion; nulos
 * al final, como Postgres en ASC): de él sale el orden de las opciones.
 */
function ordenArbol(a: FilaArbol, b: FilaArbol): number {
  for (const k of ['incidencia_srd', 'causa_raiz', 'solucion'] as const) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = x.localeCompare(y, 'es');
    if (c) return c;
  }
  return 0;
}

/**
 * Miniatura de una evidencia (foto) o enlace (video).
 *
 * Vive FUERA de RepararModal a propósito: declarada adentro, cada tecla en
 * diagnóstico/detalle creaba un tipo de componente nuevo y React remontaba
 * el <img> — que volvía a pedir la miniatura (404 en fotos sin mini/) y
 * parpadeaba al caer al original en cada tecla.
 */
function Miniatura({
  e,
  size,
  onBorrar,
  deshabilitado = false,
}: {
  e: Evidencia;
  size: number;
  /** Con esto, la miniatura trae su 🗑 debajo (solo evidencia propia). */
  onBorrar?: () => void;
  deshabilitado?: boolean;
}) {
  const visual =
    e.tipo === 'foto' ? (
      <a href={e.url} target="_blank" rel="noreferrer" title={e.referencia || ''}>
        <img
          // Miniatura de 56-64 px: bajar el original de 1600 px aquí era
          // puro egress. Las fotos viejas sin miniatura caen al original.
          src={urlMiniatura(e.url)}
          onError={alFallarMiniatura(e.url)}
          alt={e.referencia || `Evidencia de ${e.etapa}`}
          style={{
            width: size,
            height: size,
            objectFit: 'cover',
            borderRadius: 7,
            border: '1px solid var(--line)',
            display: 'block',
          }}
        />
      </a>
    ) : (
      // Su cuadro con ▶ (o el recuadro 🎬 si es un video viejo), del mismo
      // tamaño que las fotos: el texto "🎥 video" parecía otra cosa.
      <a href={e.url} target="_blank" rel="noreferrer" title={e.referencia || ''}>
        <PreviaVideo
          url={e.url}
          alt={e.referencia || `Video de ${e.etapa}`}
          compacta
          style={{
            width: size,
            height: size,
            borderRadius: 7,
            border: '1px solid var(--line)',
          }}
        />
      </a>
    );
  if (!onBorrar) return visual;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
      }}
    >
      {visual}
      <button
        type="button"
        className="btn-icono"
        onClick={onBorrar}
        disabled={deshabilitado}
        aria-label="Eliminar evidencia"
        title="Eliminar"
      >
        🗑
      </button>
    </div>
  );
}

/** Lo que el modal devuelve al padre para escribir en incidencias. */
export type DatosReparacion = {
  diagnostico: string | null;
  detalle: string;
  /** Solo las llena el árbol de Digital. En las demás áreas van null. */
  incidenciaSrd: string | null;
  arbolDigitalId: number | string | null;
  causa: string | null;
  solucion: string | null;
  /**
   * Fotos/videos NUEVOS de la reparación, ya preparados (comprimidos por
   * SubirArchivos) y todavía en el teléfono. Se suben al guardar, con la
   * reparación (modo sin señal, 24-sep-2026).
   */
  archivos: File[];
};

/**
 * Cómo salió la reparación, para el borrador del teléfono (revisión sin
 * señal, 24-sep-2026):
 *   'terminada' → aplicada, o ya no aplica (conflicto): se borra;
 *   'enCola'    → quedó en la cola: se marca entregado y se borra al salir;
 *   nada        → el modal sigue abierto (error, sin permiso): se queda.
 */
export type FinReparacion = 'terminada' | 'enCola';

type Props = {
  inc: Incidencia;
  email: string;
  onClose: () => void;
  /**
   * Guarda la reparación. `alProgreso` pinta en el botón cómo va
   * ("Subiendo 2 de 3…"). Si la reparación se guarda o queda en la cola,
   * el padre cierra el modal; si falla, lo deja abierto con lo capturado.
   * Devuelve cómo salió (ver FinReparacion).
   */
  onSave: (
    datos: DatosReparacion,
    op: { alProgreso: (texto: string) => void }
  ) => FinReparacion | void | Promise<FinReparacion | void>;
};

function RepararModal({ inc, email, onClose, onSave }: Props) {
  // Ciclo de renders que no suelta el hilo → error del módulo (app pasmada
  // sin señal, 24-sep-2026; ver lib/vigia.ts).
  vigilarRender('RepararModal');
  const [diag, setDiag] = useState(inc.diagnostico || '');
  const [detalle, setDetalle] = useState(inc.detalle_reparacion || '');
  const [busy, setBusy] = useState(false);
  const guardandoRef = useRef(false);
  /** Texto de avance mientras se guarda (lo manda lib/acciones.ts). */
  const [progreso, setProgreso] = useState('');

  const [evReporte, setEvReporte] = useState<Evidencia[]>([]);
  const [evRep, setEvRep] = useState<Evidencia[]>([]);
  const [cargandoEv, setCargandoEv] = useState(true);
  /**
   * La consulta de evidencias no llegó (sin señal): no se sabe qué hay en la
   * base. Se dice eso, y NO "el reportante no adjuntó evidencia".
   */
  const [evSinRed, setEvSinRed] = useState(false);
  /**
   * Fotos/videos nuevos: viajan con la reparación al Guardar. Además se
   * guardan en el teléfono al elegirlos (borrador; ver cabecera).
   */
  const [archivos, setArchivos] = useState<File[]>([]);
  /**
   * El borrador de esta apertura (revisión sin señal, 24-sep-2026). null
   * sin correo: entonces todo vive solo en memoria, como antes.
   */
  const [sesion] = useState(() => abrirReparacion(email, inc));
  /** Lo que se recuperó de una apertura anterior (para el aviso). */
  const [recuperado, setRecuperado] = useState<{
    fotos: number;
    textos: boolean;
    ilegibles: number;
  } | null>(null);
  /**
   * Se está leyendo el borrador de una apertura anterior (verificación de
   * la revisión sin señal, 24-sep-2026). Mientras, Guardar espera y Cancelar
   * cierra SIN descartar: al terminar, entregar/descartar borran también lo
   * adoptado, y un Guardar temprano mandaba la reparación sin esas fotos y
   * luego las borraba del teléfono. Lo normal es un instante (una lectura de
   * claves); siempre termina (cada operación de IndexedDB tiene tope).
   */
  const [recuperando, setRecuperando] = useState(!!sesion);
  /** Fotos que el teléfono NO dejó guardar: solo viven en memoria. */
  const [sinCopia, setSinCopia] = useState<File[]>([]);
  const montado = useRef(true);
  useEffect(() => {
    // Otra vez en true: StrictMode (dev) desmonta y vuelve a montar.
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);
  /**
   * SubirArchivos está comprimiendo una foto recién elegida (revisión sin
   * señal, 24-sep-2026). Mientras, no se deja Guardar: antes, un Guardar en
   * ese lapso mandaba la reparación sin esa foto y la foto llegaba después
   * a un modal ya cerrado, perdida sin aviso (en HEAD la subida seguía
   * aunque el modal se cerrara). Cerrar sí se puede, con confirmación y sin
   * descartar el borrador (ver `cerrar`; app pasmada sin señal,
   * 24-sep-2026): la foto que llega después se guarda igual en el teléfono
   * y se recupera al reabrir. SubirArchivos no expone su
   * `procesando`, así que se detecta aquí: empieza con el `change` de su
   * input (ver alEmpezarAElegir) y termina con onFiles; un tope cubre la
   * tanda que se rechaza entera (no llama a onFiles).
   */
  const [procesando, setProcesando] = useState(false);
  const relojProcesando = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(relojProcesando.current), []);

  const [arbol, setArbol] = useState<FilaArbol[]>([]);
  const [arbolListo, setArbolListo] = useState(false);
  /** El árbol salió de la copia del teléfono (no había señal). */
  const [arbolDeCopia, setArbolDeCopia] = useState(false);
  const [errArbol, setErrArbol] = useState('');
  const [srdSel, setSrdSel] = useState(inc.incidencia_srd || '');
  const [causaSel, setCausaSel] = useState(inc.causa_raiz || '');
  const [diagnosticoSel, setDiagnosticoSel] = useState(inc.diagnostico || '');
  const [solSel, setSolSel] = useState(inc.solucion || '');

  const areaRepara = inc.assigned_area || inc.area_responsable || '';
  const esDigital = areaRepara.trim().toLowerCase() === 'digital';
  const tecnicasDig = [
    ...new Set(arbol.map((a) => a.incidencia_srd).filter(Boolean)),
  ] as string[];
  const filasSrd = arbol.filter((a) => a.incidencia_srd === srdSel);
  const causasDig = [
    ...new Set(filasSrd.map((a) => a.causa_raiz).filter(Boolean)),
  ] as string[];
  const filasCausa = filasSrd.filter((a) => a.causa_raiz === causaSel);
  const diagnosticosDig = [
    ...new Set(filasCausa.map((a) => a.diagnostico).filter(Boolean)),
  ] as string[];
  const filasDiagnostico = diagnosticosDig.length
    ? filasCausa.filter((a) => a.diagnostico === diagnosticoSel)
    : filasCausa;
  const solsDig = [
    ...new Set(filasDiagnostico.map((a) => a.solucion).filter(Boolean)),
  ] as string[];
  const filaElegida = filasDiagnostico.find((a) => a.solucion === solSel) || null;
  const categoriaDig = filaElegida?.categoria_principal || filasSrd[0]?.categoria_principal;
  // Solo se guía si es Digital Y hay árbol para esta incidencia; si no, se
  // cae al flujo libre en vez de dejar al técnico sin poder capturar.
  const usarArbol = esDigital && tecnicasDig.length > 0;

  useEffect(() => {
    let vivo = true;
    (async () => {
      // Una sola consulta para las dos etapas y luego se parten: la evidencia
      // de reporte es el contexto, la de reparación es el requisito.
      //
      // Sin reintentos y con tope (modo sin señal, 24-sep-2026): antes, sin
      // red, eran ~7 s de reintentos con Guardar bloqueado y al final el
      // falso "El reportante no adjuntó evidencia". Lo local de respaldo es
      // "no se sabe" (null).
      const ev = await redOLocal<Evidencia[] | null>(
        async (senal) => {
          if (!(await haySesionReal())) return SIN_SESION;
          return sb
            .from('evidencias')
            .select('*')
            .eq('record_id', inc.record_id)
            .in('etapa', ['reporte', 'reparacion'])
            .order('creado_en')
            .retry(false)
            .abortSignal(senal);
        },
        async () => null,
        // Sin la espera larga de redOLocal para "sin copia" (integración de
        // la revisión sin señal, 24-sep-2026): el respaldo null siempre cuenta
        // como vacío y la red colgada tenía Guardar apagado hasta 20 s, y el
        // árbol Digital (que ahora también lo apaga, U7) no se pide hasta
        // terminar aquí. "No se sabe" ya tiene su texto y su regla abajo.
        { topeMs: TOPE_CONSULTA_MS, topeSinCopiaMs: 0 }
      ).catch(() => ({ datos: null, origen: 'local' as const }));
      if (!vivo) return;
      if (ev.origen === 'red' && ev.datos) {
        const todas = ev.datos;
        setEvReporte(todas.filter((e) => e.etapa === 'reporte'));
        // Lo ya subido desde el botón 📎 Evidencia cuenta para el requisito.
        setEvRep(todas.filter((e) => e.etapa === 'reparacion'));
      } else {
        setEvSinRed(true);
      }
      setCargandoEv(false);

      if (esDigital) {
        // nombre_incidencia se guardó desde catalogo_incidencias.detalle y
        // arbol_digital.incidencia usa exactamente esa descripción visible.
        const nombre = inc.nombre_incidencia || '';
        // De la red o, sin señal, de la copia del teléfono con el MISMO
        // filtro (igualdad exacta) y el MISMO orden. Antes, sin red, salía
        // "No se pudo cargar el catálogo Digital: TypeError: Load failed" y
        // la reparación quedaba Sin clasificar (modo sin señal, 24-sep-2026).
        const r = await redOLocal<FilaArbol[]>(
          async (senal) => {
            if (!(await haySesionReal())) return SIN_SESION;
            return sb
              .from('arbol_digital')
              .select(
                'id,incidencia,categoria_principal,incidencia_srd,causa_raiz,diagnostico,solucion,sla_min,sla,sla_fuera'
              )
              .eq('incidencia', nombre)
              .order('incidencia_srd')
              .order('causa_raiz')
              .order('solucion')
              .retry(false)
              .abortSignal(senal);
          },
          async () =>
            (await arbolDigitalLocal())
              .filter((x) => x.incidencia === nombre)
              .sort(ordenArbol),
          { topeMs: TOPE_CONSULTA_MS }
        ).catch(() => ({ datos: [] as FilaArbol[], origen: 'local' as const }));
        if (!vivo) return;
        const filas = r.datos || [];
        if (r.origen === 'local') {
          setArbolDeCopia(true);
          // Sin red y sin copia: no se puede afirmar que "no tiene
          // clasificación"; se dice lo que pasa y se deja el texto libre.
          if (!filas.length && !(await fechaCopia('arbol_digital').catch(() => null))) {
            if (!vivo) return;
            setErrArbol(
              'Sin señal, y este teléfono aún no guarda el catálogo Digital. ' +
                'Escribe el diagnóstico y el detalle: la reparación quedará como ' +
                'Sin clasificar.'
            );
            setArbolListo(true);
            return;
          }
        }
        setArbolListo(true);
        setArbol(filas);

        // Una reparación rechazada vuelve a abrir este mismo modal: se
        // reconstruye la ruta guardada por FK para no obligar a clasificarla
        // otra vez ni depender de textos que el catálogo pudiera haber editado.
        const previa = filas.find(
          (x) => String(x.id) === String(inc.arbol_digital_id || '')
        );
        if (previa) {
          setSrdSel(previa.incidencia_srd || '');
          setCausaSel(previa.causa_raiz || '');
          setDiagnosticoSel(previa.diagnostico || '');
          setSolSel(previa.solucion || '');
        } else {
          const tecnicas = [
            ...new Set(filas.map((x) => x.incidencia_srd).filter(Boolean)),
          ] as string[];
          if (tecnicas.length === 1) setSrdSel(tecnicas[0]);
        }
      }
    })();
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // En cada nivel, una única opción se prellena. Con varias, el técnico
  // decide: "Pantallas en negro" no puede adivinar Telmex o Totalplay.
  //
  // Dependen del TEXTO de la opción única y no de los arreglos (app pasmada
  // sin señal, 24-sep-2026): causasDig y compañía se arman de nuevo en cada
  // render, y con ellos en las dependencias estos efectos corrían en todos.
  // '' = no hay exactamente una opción (las opciones nunca son '': se
  // filtran con Boolean).
  const causaUnica = causasDig.length === 1 ? causasDig[0] : '';
  const diagnosticoUnico = diagnosticosDig.length === 1 ? diagnosticosDig[0] : '';
  const solUnica = solsDig.length === 1 ? solsDig[0] : '';
  useEffect(() => {
    if (srdSel && causaUnica && !causaSel) setCausaSel(causaUnica);
  }, [srdSel, causaUnica, causaSel]);

  useEffect(() => {
    if (causaSel && diagnosticoUnico && !diagnosticoSel) setDiagnosticoSel(diagnosticoUnico);
  }, [causaSel, diagnosticoUnico, diagnosticoSel]);

  useEffect(() => {
    if (causaSel && solUnica && !solSel) setSolSel(solUnica);
  }, [causaSel, solUnica, solSel]);

  // --- Borrador en el teléfono (revisión sin señal, 24-sep-2026) ---
  /** Textos con los que abrió el modal (los de la incidencia). */
  const textosIniciales = useRef({ diag, detalle });
  const textosAhora = useRef({ diag, detalle });
  textosAhora.current = { diag, detalle };
  /** Ya se escribieron textos en el borrador (desde ahí, cada cambio cuenta). */
  const textosEscritos = useRef(false);

  // Al abrir: lo que quedó de una apertura anterior de ESTA reparación (iOS
  // recargó la app al volver de la cámara, un aviso navegó, Atrás cambió de
  // pestaña). Las fotos van primero, en el orden en que se tomaron.
  const yaRecupero = useRef(false);
  useEffect(() => {
    // Una vez por apertura (StrictMode corre los efectos dos veces en dev:
    // la segunda duplicaba las fotos).
    if (!sesion || yaRecupero.current) return;
    yaRecupero.current = true;
    void recuperarReparacion(sesion).then((r) => {
      if (montado.current) setRecuperando(false);
      if (!r || !montado.current) return;
      if (r.archivos.length) setArchivos((prev) => [...r.archivos, ...prev]);
      // Los textos solo si el técnico no ha escrito nada todavía.
      const ini = textosIniciales.current;
      const intactos =
        textosAhora.current.diag === ini.diag &&
        textosAhora.current.detalle === ini.detalle;
      const traeTextos =
        !!r.textos && (r.textos.diag !== ini.diag || r.textos.detalle !== ini.detalle);
      if (r.textos && intactos && traeTextos) {
        setDiag(r.textos.diag);
        setDetalle(r.textos.detalle);
      }
      if (r.archivos.length || (intactos && traeTextos) || r.ilegibles)
        setRecuperado({
          fotos: r.archivos.length,
          textos: intactos && traeTextos,
          ilegibles: r.ilegibles,
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Diagnóstico y detalle, con una pausa (no por tecla). Solo si cambiaron:
  // abrir y cerrar sin escribir no deja borrador.
  useEffect(() => {
    if (!sesion) return;
    const ini = textosIniciales.current;
    if (!textosEscritos.current && diag === ini.diag && detalle === ini.detalle) return;
    const t = setTimeout(() => {
      textosEscritos.current = true;
      void guardarTextosReparacion(sesion, diag, detalle);
    }, PAUSA_TEXTOS_MS);
    return () => clearTimeout(t);
  }, [diag, detalle, sesion]);
  // Al desmontarse (p. ej. Atrás en Android) lo último que se tecleó.
  useEffect(
    () => () => {
      if (!sesion) return;
      const ini = textosIniciales.current;
      const { diag: d, detalle: dt } = textosAhora.current;
      if (textosEscritos.current || d !== ini.diag || dt !== ini.detalle)
        void guardarTextosReparacion(sesion, d, dt);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  /** Terminó de prepararse una tanda: a la lista y, una por una, al teléfono. */
  const alElegir = (nuevos: File[]) => {
    clearTimeout(relojProcesando.current);
    // Si el modal ya se desmontó (navegación), la foto igual se guarda en el
    // teléfono: se recupera al reabrir esta reparación.
    if (montado.current) {
      setProcesando(false);
      setArchivos((prev) => [...prev, ...nuevos]);
    }
    if (!sesion) return;
    nuevos.forEach((f) => {
      void guardarFotoReparacion(sesion, f).then((ok) => {
        if (!ok && !sesion.cerrada && montado.current)
          setSinCopia((prev) => [...prev, f]);
      });
    });
  };

  /** Quitar con × una foto nueva: también del teléfono. */
  const alQuitar = (i: number) => {
    const f = archivos[i];
    setArchivos((prev) => prev.filter((_, k) => k !== i));
    if (f && sesion) void quitarFotoReparacion(sesion, f);
  };

  /**
   * El `change` del input de SubirArchivos, ANTES de que lo maneje: ahí
   * empieza a comprimir (ver `procesando`). Los videos que rebasan el tope
   * se rechazan al instante y no cuentan. El tope crece con la tanda.
   */
  const alEmpezarAElegir = (e: React.FormEvent<HTMLDivElement>) => {
    const t = e.target as HTMLInputElement;
    if (t.type !== 'file' || !t.files?.length) return;
    const posibles = Array.from(t.files).filter(
      (f) => !(f.type.startsWith('video/') && f.size > MAX_VIDEO_BYTES)
    ).length;
    if (!posibles) return;
    setProcesando(true);
    clearTimeout(relojProcesando.current);
    relojProcesando.current = setTimeout(
      () => {
        if (montado.current) setProcesando(false);
      },
      Math.min(60000, 5000 + 3000 * posibles)
    );
  };

  // La subida al elegir (subirRep) se quitó (modo sin señal, 24-sep-2026):
  // los archivos se quedan en `archivos` y los sube lib/acciones.ts al
  // guardar, con ruta fija por acción (un reintento no duplica la foto).
  // El nombre sigue el de antes: RECORD_ID/FOLIO_CARA_FECHA_reparacion_…

  const [borrandoEv, setBorrandoEv] = useState(false);

  /**
   * El técnico puede quitar LO SUYO antes de mandar a reparar: una foto
   * equivocada se corrige aquí mismo, sin ir a la galería. Espeja la
   * política ev_del (dueño + etapa reparación + en_proceso), igual que
   * hace EvidenciaModal, para no ofrecer un 🗑 que la base rechazaría.
   */
  const puedeBorrarEv = (e: Evidencia) =>
    (e.subido_por || '').toLowerCase() === (email || '').toLowerCase();

  const borrarEvRep = async (item: Evidencia) => {
    // Lo que ya está en la base solo se borra con señal: un borrado a medias
    // (archivo sí, fila no) dejaría una evidencia rota. Lo nuevo, que sigue
    // en el teléfono, se quita con su ✕ sin red.
    if (!haySenal() || !(await haySesionReal())) {
      alert('Necesitas señal para quitar una foto que ya se subió.');
      return;
    }
    if (!confirm('¿Eliminar esta evidencia de reparación?')) return;
    setBorrandoEv(true);
    // Mismo orden que la galería: primero el archivo, luego la fila. Si el
    // archivo falla, la fila queda y se reintenta; al revés quedaría un
    // archivo colgado sin referencia.
    // La miniatura va en la misma llamada; si no existe, Storage la ignora.
    if (item.path)
      await sb.storage
        .from(BUCKET_EVIDENCIAS)
        .remove([item.path, rutaMiniatura(item.path)]);
    const { data, error } = await sb
      .from('evidencias')
      .delete()
      .eq('id', item.id)
      .select('id');
    setBorrandoEv(false);
    if (error) {
      alert('No se pudo eliminar: ' + error.message);
      return;
    }
    // 0 filas = la RLS lo negó en silencio (convención de esta base).
    if (!data || data.length === 0) {
      alert('No se pudo eliminar: no tienes permiso sobre esta evidencia.');
      return;
    }
    setEvRep((prev) => prev.filter((x) => x.id !== item.id));
  };

  const guardar = async () => {
    // Doble toque: dos reparaciones iguales en la cola chocarían entre sí.
    if (guardandoRef.current) return;
    // Con una foto a medio preparar, se iría sin ella (ver `procesando`); y
    // sin las recuperadas mientras se leen (ver `recuperando`).
    if (procesando || recuperando) return;
    // Digital sin el árbol todavía: usarArbol aún es false y se guardaría sin
    // clasificación (causa_raiz/solucion en null), dejando incidencia_srd y
    // arbol_digital_id del ciclo anterior en una re-reparación (revisión sin
    // señal, 24-sep-2026). El botón ya está apagado; esto es por si acaso.
    if (esDigital && !arbolListo) return;
    if (!usarArbol && !detalle.trim()) {
      alert('Escribe el detalle de la reparación.');
      return;
    }
    // Cuentan las dos: la ya subida (de un intento anterior o de 📎
    // Evidencia) y la nueva que sigue en el teléfono. Sin señal no se sabe
    // qué hay en la base, así que ahí manda la nueva.
    if (evRep.length + archivos.length === 0) {
      alert(
        evSinRed
          ? 'Adjunta al menos una foto o video de la reparación (sin señal no se ven las que ya subiste).'
          : 'Adjunta al menos una foto o video de la reparación.'
      );
      return;
    }

    let causa: string | null = null;
    let diagnosticoFinal: string | null = diag.trim() || null;
    let solucion: string | null = null;
    let incidenciaSrd: string | null = null;
    let arbolDigitalId: number | string | null = null;

    if (usarArbol) {
      if (!srdSel) {
        alert('Elige la incidencia técnica de Digital.');
        return;
      }
      if (!causaSel) {
        alert('Elige la causa raíz.');
        return;
      }
      if (diagnosticosDig.length > 0 && !diagnosticoSel) {
        alert('Elige el diagnóstico.');
        return;
      }
      if (!solSel) {
        alert('Elige la solución.');
        return;
      }
      if (!filaElegida) {
        alert('La combinación elegida ya no existe en el catálogo Digital. Recarga e inténtalo de nuevo.');
        return;
      }
      incidenciaSrd = filaElegida.incidencia_srd;
      arbolDigitalId = filaElegida.id;
      causa = filaElegida.causa_raiz;
      diagnosticoFinal = filaElegida.diagnostico;
      solucion = solSel;
    }

    guardandoRef.current = true;
    setBusy(true);
    setProgreso('');
    try {
      const fin = await onSave(
        {
          diagnostico: diagnosticoFinal,
          detalle,
          incidenciaSrd,
          arbolDigitalId,
          causa,
          solucion,
          archivos,
        },
        { alProgreso: setProgreso }
      );
      // El borrador sobra en cuanto la reparación quedó hecha o en la cola
      // (el motor guarda su propia copia); si el modal sigue abierto, se
      // queda (ver FinReparacion).
      if (sesion && (fin === 'terminada' || fin === 'enCola'))
        void entregarReparacion(sesion, fin);
    } finally {
      // Si se guardó o quedó en la cola, el padre ya cerró el modal y esto
      // no hace nada; si falló, el modal sigue con todo lo capturado.
      guardandoRef.current = false;
      setBusy(false);
      setProgreso('');
    }
  };

  const ocupado = busy || borrandoEv;

  /**
   * Cerrar con fotos nuevas sin guardar las tira: se pregunta, igual que
   * al marcar fijado en Fijación Externa.
   *
   * Ningún "preparando / buscando fotos" deja el modal sin salida (app
   * pasmada sin señal, 24-sep-2026): antes Cancelar y el fondo se apagaban
   * mientras se preparaba una foto, y durante el guardado Cancelar no
   * tenía salida si el guardado se atoraba. Ahora solo el guardado apaga el
   * fondo (un roce no cierra), y Cancelar sigue con confirmación.
   */
  const cerrar = (desdeFondo = false) => {
    if (busy) {
      if (desdeFondo) return;
      // El guardado lo lleva el padre y sigue solo; el borrador no se
      // descarta: si el guardado falla, las fotos siguen en el teléfono.
      if (
        confirm(
          'La reparación se está guardando. Si cierras, el guardado sigue por su cuenta ' +
            '(o queda en la cola del teléfono): no la vuelvas a capturar.\n\n¿Cerrar de todas formas?'
        )
      )
        onClose();
      return;
    }
    // Con una foto a medio preparar se cierra SIN descartar: la foto llega
    // después a alElegir, que la guarda en el teléfono aunque el modal ya no
    // esté, y se ofrece al reabrir esta reparación.
    if (procesando) {
      if (
        confirm(
          sesion
            ? 'Se está preparando una foto. Si cierras ahora, las fotos que elegiste se quedan ' +
                'en el teléfono y se recuperan al reabrir esta reparación.\n\n¿Cerrar?'
            : 'Se está preparando una foto. Si cierras ahora, las fotos sin guardar se pierden.\n\n¿Cerrar?'
        )
      )
        onClose();
      return;
    }
    // Aún no se ven las fotos recuperadas: se cierra sin descartarlas (se
    // vuelven a ofrecer al reabrir) en vez de borrar lo que no se vio.
    if (recuperando) {
      onClose();
      return;
    }
    if (
      archivos.length > 0 &&
      !confirm('Tienes fotos sin guardar. ¿Descartarlas?')
    )
      return;
    // Cerrar a propósito descarta también el borrador del teléfono: ya no
    // se ofrece al reabrir.
    if (sesion) void descartarReparacion(sesion);
    onClose();
  };

  /** Fotos de la lista que solo viven en memoria (el teléfono no las guardó). */
  const nSinCopia = archivos.filter((f) => sinCopia.includes(f)).length;

  return (
    <div
      className="overlay"
      onClick={(e) => {
        // Con el guardado en curso, un roce en el fondo no debe cerrar; con
        // fotos nuevas elegidas, se pregunta (ver `cerrar`).
        if ((e.target as HTMLElement).className === 'overlay') cerrar(true);
      }}
    >
      <div className="modal">
        <h2 style={{ margin: '0 0 3px' }}>Registrar reparación</h2>
        <p className="phint">
          {inc.folio} · {inc.nombre_incidencia} · cara {caraIncidencia(inc)}
        </p>

        {/* Contexto: qué reportó el reportante y con qué evidencia */}
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
            📋 Reporte del reportante
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            Sitio: <b>{inc.clave_sitio}</b>
            {inc.nombre_biobox ? ` · ${inc.nombre_biobox}` : ''}
            <br />
            {inc.direccion}
            <br />
            {/* Solo el nivel: tipo (Imponderable…) y origen se guardan para
                los KPIs pero dejan de mostrarse (Erik, 30-ago-2026). */}
            Nivel {inc.nivel || '—'}
            {inc.reasignada_de && (
              <>
                <br />
                {/* Morado legible en los dos temas (tema claro/oscuro,
                    24-sep-2026). */}
                <span style={{ color: colorTono('morado') }}>
                  🔁 Reasignada: antes pertenecía a {inc.reasignada_de}
                </span>
              </>
            )}
            {inc.observaciones && (
              <>
                <br />
                Obs.: “{inc.observaciones}”
              </>
            )}
          </div>
          {evReporte.length > 0 ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
              {evReporte.map((e) => (
                <Miniatura key={e.id} e={e} size={64} deshabilitado={ocupado} />
              ))}
            </div>
          ) : (
            !cargandoEv && (
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                {/* Sin señal NO se sabe si hay: decir "no adjuntó" sería
                    falso (modo sin señal, 24-sep-2026). */}
                {evSinRed
                  ? '📴 Sin señal: las fotos ya subidas se verán al volver la red.'
                  : 'El reportante no adjuntó evidencia.'}
              </div>
            )
          )}
        </div>

        {esDigital && !arbolListo && (
          <div className="loading" style={{ marginBottom: 14 }}>
            Cargando clasificación técnica de Digital…
          </div>
        )}

        {esDigital && arbolListo && !usarArbol && (
          <div
            className="banner"
            style={
              errArbol
                ? { marginBottom: 14, borderColor: 'var(--warn)', color: 'var(--warn)' }
                : { marginBottom: 14 }
            }
          >
            {errArbol
              ? `📴 ${errArbol}`
              : `“${inc.nombre_incidencia || 'Esta incidencia'}” no tiene clasificación en arbol_digital${arbolDeCopia ? ' (según la copia del teléfono; sin señal)' : ''}. La reparación quedará como Sin clasificar.`}
          </div>
        )}

        {usarArbol && arbolDeCopia && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
            📴 Sin señal: clasificación Digital de la copia del teléfono.
          </div>
        )}

        {!usarArbol && (!esDigital || arbolListo) && (
          <>
            <div className="field">
              <label>Diagnóstico</label>
              <textarea
                rows={2}
                value={diag}
                onChange={(e) => setDiag(e.target.value)}
                placeholder="Qué se encontró en sitio…"
              />
            </div>
            <div className="field">
              <label>Detalle de reparación</label>
              <textarea
                rows={2}
                value={detalle}
                onChange={(e) => setDetalle(e.target.value)}
                placeholder="Qué se hizo para corregir…"
              />
            </div>
          </>
        )}

        <div className="field">
          <label>
            Evidencia de la reparación (foto/video) —{' '}
            {evRep.length + archivos.length > 0 ? (
              <span style={{ color: 'var(--ok)' }}>
                ✓ {evRep.length + archivos.length} adjunta
                {evRep.length + archivos.length > 1 ? 's' : ''}
              </span>
            ) : (
              // El naranja como TEXTO va con su tono (tema claro/oscuro,
              // 24-sep-2026): --accent en claro solo sirve de fondo.
              <span style={{ color: colorTono('acento') }}>obligatoria</span>
            )}
          </label>

          {/* Lo ya subido (de un intento anterior o de 📎 Evidencia). */}
          {cargandoEv ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Buscando evidencia ya subida…
            </div>
          ) : (
            <>
              {evRep.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    flexWrap: 'wrap',
                    marginBottom: 8,
                  }}
                >
                  {evRep.map((e) => (
                    <Miniatura
                      key={e.id}
                      e={e}
                      size={56}
                      deshabilitado={ocupado}
                      onBorrar={
                        puedeBorrarEv(e) ? () => borrarEvRep(e) : undefined
                      }
                    />
                  ))}
                </div>
              )}
              {evRep.length > 0 && (
                <div
                  style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}
                >
                  Ya cuentas con evidencia de reparación subida. Puedes agregar
                  más, o quitar con 🗑 las tuyas (con señal).
                </div>
              )}
            </>
          )}
          {recuperado && (
            <div className="banner" style={{ marginBottom: 8 }} role="status">
              ♻️{' '}
              {recuperado.fotos > 0
                ? `Recuperamos ${recuperado.fotos} ${recuperado.fotos === 1 ? 'foto que no se había enviado' : 'fotos que no se habían enviado'}${recuperado.textos ? ', y lo que habías escrito' : ''}. ${recuperado.fotos === 1 ? 'Revísala' : 'Revísalas'} antes de guardar.`
                : recuperado.textos
                  ? 'Recuperamos lo que habías escrito y no se había enviado.'
                  : ''}
              {recuperado.ilegibles > 0 &&
                ` ${recuperado.ilegibles === 1 ? 'Una foto guardada no se pudo leer' : `${recuperado.ilegibles} fotos guardadas no se pudieron leer`} del teléfono: si falta, tómala otra vez.`}
            </div>
          )}
          {/* Lo nuevo: se guarda en el teléfono al elegirlo y viaja con la
              reparación al Guardar. Se puede revisar (tocándola) y quitar
              con × antes de mandar; el selector no espera a la consulta de
              lo ya subido. El envoltorio detecta cuándo empieza a preparar
              una foto (ver `procesando`). */}
          <div onChangeCapture={alEmpezarAElegir}>
            <SubirArchivos
              archivos={archivos}
              onFiles={alElegir}
              onQuitar={alQuitar}
              disabled={ocupado}
              ayuda="Se guardan en el teléfono en cuanto las eliges y se suben al guardar. Toca una para revisarla; quítala con × si salió mal."
            />
          </div>
          {nSinCopia > 0 && (
            <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 6 }}>
              ⚠{' '}
              {nSinCopia === 1
                ? 'Una foto no se pudo guardar en el teléfono: si la app se cierra antes de Guardar, se pierde.'
                : `${nSinCopia} fotos no se pudieron guardar en el teléfono: si la app se cierra antes de Guardar, se pierden.`}
            </div>
          )}
        </div>

        {usarArbol && (
          <>
            <div className="field">
              <label>Incidencia técnica de Digital ({tecnicasDig.length})</label>
              <select
                value={srdSel}
                onChange={(e) => {
                  setSrdSel(e.target.value);
                  setCausaSel('');
                  setDiagnosticoSel('');
                  setSolSel('');
                }}
              >
                <option value="">— Selecciona —</option>
                {tecnicasDig.map((srd) => (
                  <option key={srd} value={srd}>
                    {srd}
                  </option>
                ))}
              </select>
              {categoriaDig && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                  Categoría: <b>{categoriaDig}</b>
                </div>
              )}
            </div>
            {srdSel && (
              <div className="field">
                <label>Causa raíz ({causasDig.length})</label>
                <select
                  value={causaSel}
                  onChange={(e) => {
                    setCausaSel(e.target.value);
                    setDiagnosticoSel('');
                    setSolSel('');
                  }}
                >
                  <option value="">— Selecciona —</option>
                  {causasDig.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {causaSel && diagnosticosDig.length > 0 && (
              <div className="field">
                <label>Diagnóstico ({diagnosticosDig.length})</label>
                <select
                  value={diagnosticoSel}
                  onChange={(e) => {
                    setDiagnosticoSel(e.target.value);
                    setSolSel('');
                  }}
                >
                  <option value="">— Selecciona —</option>
                  {diagnosticosDig.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {causaSel && (diagnosticosDig.length === 0 || diagnosticoSel) && (
              <div className="field">
                <label>Solución ({solsDig.length})</label>
                <select value={solSel} onChange={(e) => setSolSel(e.target.value)}>
                  <option value="">— Selecciona —</option>
                  {solsDig.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          {/* Nunca apagado (app pasmada sin señal, 24-sep-2026): mientras
              prepara o guarda, `cerrar` pregunta en vez de ignorar. */}
          <button className="btn ghost" onClick={() => cerrar()}>
            Cancelar
          </button>
          {/* Mientras se busca lo ya subido, Guardar solo espera si todavía
              no hay foto nueva: con una nueva, el requisito ya se cumple. El
              progreso de las subidas ("Subiendo 2 de 3…") lo manda
              lib/acciones.ts; sin red, la reparación queda en la cola.
              Además espera (revisión sin señal, 24-sep-2026) a la foto que
              se está preparando y, en Digital, al árbol: sin él se
              guardaría sin clasificación. */}
          <button
            className="btn warn"
            onClick={guardar}
            disabled={
              ocupado ||
              procesando ||
              recuperando ||
              (esDigital && !arbolListo) ||
              (cargandoEv && archivos.length === 0)
            }
          >
            {(busy || procesando || recuperando) && <span className="spinner" />}
            {busy
              ? progreso || 'Guardando…'
              : procesando
                ? 'Preparando la foto…'
                : recuperando
                  ? 'Buscando fotos sin enviar…'
                  : '🔧 Guardar reparación'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default RepararModal;
