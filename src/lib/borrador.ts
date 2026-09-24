// ============================================================
// src/lib/borrador.ts
// Borrador del alta de incidencias (NuevaInc), guardado en el teléfono.
//
// POR QUÉ (auditoría primer mes, 24-sep-2026): un reporte de sitio con
// varias partidas y fotos tomadas en campo vivía solo en la memoria de la
// pestaña. En iPhone basta abrir la cámara para que iOS, corto de memoria,
// recargue la app al volver: se perdía todo lo capturado. Ahora, mientras
// se captura, se guarda un borrador (con sus fotos) y al volver a abrir el
// alta se ofrece recuperarlo.
//
// Reglas:
//   · Uno por usuario (llave = correo). Sin correo no se guarda nada.
//   · Los archivos van APARTE, cada uno una sola vez con una clave estable
//     ('b:<sesión>:<n>'); el borrador solo referencia claves. Así, teclear
//     en Observaciones no reescribe 20 MB de fotos en cada tecla.
//   · Un archivo que no cabe (cuota, video enorme) no tumba el borrador: se
//     guarda sin él y se cuenta, para decirlo al ofrecerlo.
//   · Una "sesión" es una apertura del formulario. Cuando el reporte se
//     entrega a la cola la sesión se SELLA (o se CIERRA): ninguna escritura
//     tardía (el debounce, una foto que terminaba de copiarse) puede
//     resucitar el borrador.
//   · Nunca bloquea ni revienta: todo es de mejor esfuerzo.
//
// CICLO DE VIDA FRENTE A LA COLA DE ENVÍOS (revisión primer mes,
// 24-sep-2026). Antes el formulario borraba el borrador al entregar el
// reporte, aunque el envío no hubiera quedado entero en el teléfono (se
// borraba la única copia de una foto), y nadie lo borraba si el envío
// terminaba en otra sesión (se ofrecía "Recuperar" de un reporte que ya
// había entrado: duplicado). Ahora el borrador —registro y archivos 'b:'—
// vive EXACTAMENTE hasta que el envío que salió de él queda completo o se
// descarta. Lo cierra la COLA (lib/envios.ts), no el formulario: es la
// única que sabe cuándo terminó, aunque termine en otra pestaña, mañana o
// tras una recarga (Envio.borrador lo nombra).
//   · El envío REUSA los archivos que el borrador ya escribió (su clave
//     'b:', ArchivoEnvio.enBorrador) en vez de copiarlos: sin doble copia
//     que llene el teléfono, y lo que cupo en el borrador cuenta como
//     guardado para el envío. Por eso, mientras exista un envío guardado
//     que salga de una sesión, sus archivos 'b:' no se borran aunque se
//     quite el borrador (respaldaEnvio).
//   · Guardar con red, completo → la cola cierra el borrador al terminar.
//   · Guardar sin red, envío guardado en el teléfono (entero o sin algún
//     archivo) → el formulario SELLA la sesión (deja de escribir, no
//     borra). No se ofrece mientras exista su envío (hayEnvioDeBorrador).
//   · Sin red y solo en memoria (el teléfono no dejó guardar ni el
//     registro del envío) → el borrador es lo único que sobrevive a un
//     cierre: se queda y se ofrece si la pestaña muere antes de insertar.
//     En cuanto la base confirma el insert, la cola lo cierra: si no, al
//     reabrir se ofrecería un reporte que ya entró.
//   · Página muerta a media subida, o cola que termina en otra sesión → el
//     envío está en el teléfono: al retomarse y terminar, la cola cierra el
//     borrador.
//   · Descartar desde el aviso de envíos → se cierra con el envío (el aviso
//     dice "se borra de este teléfono").
//   · Guardar que no pasa (duplicado en proceso, error) → el modal sigue
//     abierto y el borrador también; el envío fallido se quita solo.
//   · Abrir "Nueva" con un envío de ese borrador en cola → no se ofrece ni
//     se borra. La captura nueva reemplaza el registro (es uno por
//     usuario), pero los archivos que usa el envío se quedan.
// Límites: si un envío solo en memoria manda su insert, la respuesta se
// pierde y la pestaña muere justo ahí, al reabrir se ofrece el borrador (no
// hay forma de saber si entró). Y un envío solo en memoria no impide que
// la captura siguiente reemplace el registro de su borrador y borre sus
// archivos 'b:' (el envío los trae en memoria mientras la pestaña viva); si
// luego la pestaña muere antes de insertar, ese reporte se pierde. Con el
// teléfono así (sin lugar ni para el registro del envío), casi nunca se
// alcanza a guardar un borrador nuevo.
// ============================================================
import {
  guardarArchivo,
  idbDelete,
  idbDeletePrefijo,
  idbGet,
  idbGetAll,
  idbPut,
  leerArchivo,
} from './idb';

/** Un borrador más viejo que esto ya no se ofrece (y se borra). */
export const VIGENCIA_BORRADOR_MS = 48 * 60 * 60 * 1000;

/** Lo que se guarda. `D` son los datos del formulario (los define NuevaInc). */
export type Borrador<D> = {
  email: string;
  sesion: string;
  guardado_en: number;
  datos: D;
  /** Claves de los archivos que SÍ quedaron en el teléfono. */
  archivos: string[];
  /** Cuántos archivos del formulario NO cupieron en el teléfono. */
  noGuardados: number;
  /** Para el aviso "Tienes un reporte sin terminar…". */
  resumen: { sitio: string | null; partidas: number };
};

/** Id de una apertura del formulario. */
export function nuevaSesionBorrador(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ------------------------------------------------------------
// Claves estables de archivos
// ------------------------------------------------------------

/**
 * Cada File del formulario recibe su clave la primera vez que se ve, y la
 * conserva mientras viva el objeto (WeakMap: no retiene fotos ya quitadas).
 * Editar una partida reutiliza los mismos File, así que no se reescriben.
 */
const clavePorArchivo = new WeakMap<File, string>();
let consecutivo = 0;

export function claveDeArchivo(sesion: string, f: File): string {
  const previa = clavePorArchivo.get(f);
  if (previa && previa.startsWith(`b:${sesion}:`)) return previa;
  const k = `b:${sesion}:${Date.now().toString(36)}${(consecutivo++).toString(36)}`;
  clavePorArchivo.set(f, k);
  return k;
}

/** Lo que esta pestaña sabe de cada sesión. */
type EstadoSesion = {
  /** Claves ya escritas en el teléfono. */
  escritas: Set<string>;
  /** Claves que no cupieron: no se reintentan en cada tecla. */
  fallidas: Set<string>;
  /** Cola: una escritura a la vez por sesión (el debounce y el cierre pueden coincidir). */
  cadena: Promise<unknown>;
};
const sesiones = new Map<string, EstadoSesion>();
const cerradas = new Set<string>();

function estadoDe(sesion: string): EstadoSesion {
  let st = sesiones.get(sesion);
  if (!st) {
    st = { escritas: new Set(), fallidas: new Set(), cadena: Promise.resolve() };
    sesiones.set(sesion, st);
  }
  return st;
}

/** Encola `trabajo` detrás de lo pendiente de la sesión; nunca rechaza. */
function enCola<T>(sesion: string, trabajo: () => Promise<T>, respaldo: T): Promise<T> {
  const st = estadoDe(sesion);
  const p = st.cadena.then(trabajo).catch(() => respaldo);
  st.cadena = p;
  return p;
}

/**
 * La clave 'b:' de `f` si su copia de ESTA sesión ya quedó escrita en el
 * teléfono (confirmado en esta pestaña); null si no. El envío la reusa en
 * vez de copiar el archivo otra vez (ver "Ciclo de vida" arriba).
 */
export function claveYaGuardada(sesion: string, f: File): string | null {
  const k = clavePorArchivo.get(f);
  if (!k || !k.startsWith(`b:${sesion}:`) || cerradas.has(sesion)) return null;
  return sesiones.get(sesion)?.escritas.has(k) ? k : null;
}

/**
 * ¿Algún envío guardado en la cola sale de esta sesión? Entonces sus
 * archivos 'b:' son también los del envío y no se borran. Se lee el
 * almacén de la cola directo (lib/envios importa este módulo, no al revés).
 * Si no se puede leer se contesta que sí: un Blob de más ocupa espacio; uno
 * de menos es una foto perdida.
 */
async function respaldaEnvio(sesion: string): Promise<boolean> {
  try {
    const envios = await idbGetAll<{ borrador?: { sesion?: string } | null }>('envios');
    return envios.some((e) => e?.borrador?.sesion === sesion);
  } catch {
    return true;
  }
}

// ------------------------------------------------------------
// Operaciones
// ------------------------------------------------------------

/**
 * Guarda el borrador. Escribe solo los archivos nuevos, borra los que ya no
 * se usan y al final el registro (que solo referencia claves).
 * Devuelve cuántos archivos no cupieron, para avisar en el formulario.
 */
export function guardarBorrador<D>(p: {
  email: string;
  sesion: string;
  datos: D;
  archivos: File[];
  resumen: { sitio: string | null; partidas: number };
}): Promise<{ guardado: boolean; noGuardados: number }> {
  const nada = { guardado: false, noGuardados: 0 };
  if (!p.email || cerradas.has(p.sesion)) return Promise.resolve(nada);
  return enCola(
    p.sesion,
    async () => {
      const st = estadoDe(p.sesion);
      const refs = p.archivos.map((f) => ({ k: claveDeArchivo(p.sesion, f), f }));
      for (const { k, f } of refs) {
        if (cerradas.has(p.sesion)) return nada;
        if (st.escritas.has(k) || st.fallidas.has(k)) continue;
        const ok = await guardarArchivo(k, f);
        if (cerradas.has(p.sesion)) {
          // Se cerró mientras se copiaba: no dejar el Blob huérfano.
          if (ok) idbDelete('archivos', k).catch(() => {});
          return nada;
        }
        (ok ? st.escritas : st.fallidas).add(k);
      }
      // Fotos quitadas del formulario (o de una partida borrada): fuera.
      const vivas = new Set(refs.map((r) => r.k));
      [...st.escritas].forEach((k) => {
        if (vivas.has(k)) return;
        st.escritas.delete(k);
        idbDelete('archivos', k).catch(() => {});
      });
      // Si el registro guardado era de OTRA sesión (el usuario ya lo
      // descartó o recuperó), sus archivos se quedarían huérfanos. Salvo
      // que un envío en cola los use: se borran al cerrarse con él.
      const previo = await idbGet<Borrador<unknown>>('borradores', p.email).catch(() => undefined);
      if (previo && previo.sesion !== p.sesion && !(await respaldaEnvio(previo.sesion)))
        idbDeletePrefijo('archivos', `b:${previo.sesion}:`).catch(() => {});
      if (cerradas.has(p.sesion)) return nada;
      const noGuardados = refs.filter((r) => st.fallidas.has(r.k)).length;
      const registro: Borrador<D> = {
        email: p.email,
        sesion: p.sesion,
        guardado_en: Date.now(),
        datos: p.datos,
        archivos: refs.filter((r) => st.escritas.has(r.k)).map((r) => r.k),
        noGuardados,
        resumen: p.resumen,
      };
      await idbPut('borradores', registro);
      return { guardado: true, noGuardados };
    },
    nada
  );
}

/**
 * El borrador vigente de este correo, o null. Uno vencido (más de 48 h) se
 * borra aquí mismo con sus archivos: nadie lo va a recuperar ya.
 */
export async function leerBorrador<D>(email: string): Promise<Borrador<D> | null> {
  if (!email) return null;
  try {
    const b = await idbGet<Borrador<D>>('borradores', email);
    if (!b) return null;
    if (!b.guardado_en || Date.now() - b.guardado_en > VIGENCIA_BORRADOR_MS) {
      await quitarBorrador(email, b.sesion);
      return null;
    }
    return b;
  } catch {
    return null;
  }
}

/**
 * Rehidrata los archivos de un borrador como File. Quien lo recupera ADOPTA
 * su sesión: las claves quedan registradas como ya escritas, así que seguir
 * capturando no vuelve a copiar esas fotos. Los que no se encuentren
 * simplemente no vienen en el mapa (quien llama los cuenta).
 */
export async function cargarArchivosBorrador<D>(b: Borrador<D>): Promise<Map<string, File>> {
  const st = estadoDe(b.sesion);
  const m = new Map<string, File>();
  for (const k of b.archivos || []) {
    const f = await leerArchivo(k);
    if (!f) continue;
    clavePorArchivo.set(f, k);
    st.escritas.add(k);
    m.set(k, f);
  }
  return m;
}

/**
 * Borra el borrador de esta sesión (registro y archivos). Si el registro
 * guardado es de OTRA sesión no lo toca: p. ej. el formulario se abrió, se
 * ignoró la oferta de recuperar y se cerró vacío — el borrador viejo sigue
 * siendo del usuario. No cierra la sesión: si el formulario sigue abierto,
 * lo siguiente que se capture se vuelve a guardar.
 *
 * Los archivos se quedan si un envío guardado en la cola todavía los usa
 * (revisión primer mes, 24-sep-2026): p. ej. el borrador vencido (48 h) de
 * un reporte que sigue esperando señal. Los borra la cola al cerrarlo.
 */
export function quitarBorrador(email: string, sesion: string): Promise<void> {
  return enCola(
    sesion,
    async () => {
      const st = estadoDe(sesion);
      st.escritas.clear();
      st.fallidas.clear();
      const b = await idbGet<Borrador<unknown>>('borradores', email).catch(() => undefined);
      if (b && b.sesion === sesion) await idbDelete('borradores', email).catch(() => {});
      if (!(await respaldaEnvio(sesion)))
        await idbDeletePrefijo('archivos', `b:${sesion}:`).catch(() => {});
    },
    undefined
  );
}

/**
 * Cierra la sesión y borra su borrador: su envío quedó completo o se
 * descartó (lo llama la cola, lib/envios.ts), o el usuario descartó el
 * borrador. El cierre es INMEDIATO —antes de cualquier await— para que un
 * guardado del debounce que dispare justo después ya no escriba.
 */
export function cerrarBorrador(email: string, sesion: string): Promise<void> {
  cerradas.add(sesion);
  return quitarBorrador(email, sesion);
}

/**
 * Deja de escribir el borrador de esta sesión desde esta pestaña, SIN
 * borrarlo (revisión primer mes, 24-sep-2026): el formulario ya entregó el
 * reporte a la cola, que usa sus archivos y lo cerrará al terminar. Sin el
 * sello, la escritura de salida del formulario podía llegar DESPUÉS de que
 * otra pestaña terminara el envío y cerrara el borrador, y lo resucitaba:
 * se ofrecía recuperar un reporte que ya había entrado.
 */
export function sellarBorrador(sesion: string): void {
  cerradas.add(sesion);
}
