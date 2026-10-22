// ============================================================
// src/lib/tomasPautaLogica.ts
// Lo PURO de la cola de tomas de Pauta (lib/tomasPauta.ts): nombres, rutas,
// qué sigue en cada trabajo y los textos. Sin IndexedDB, sin Supabase y sin
// React: lo prueba tests/tomasPautaLogica.test.mjs.
//
// Fase 1 de comprobaciones (Erik, 22-oct-2026): la foto de la toma se guarda
// en el teléfono antes de subir y sube en cola; la toma se registra sola
// cuando todas sus fotos entraron. Las reglas de abajo salen del mapeo y de
// la revisión del diseño del 22-oct-2026:
//   · La ruta de Storage se fija UNA vez al encolar (hoy llevaba Date.now()
//     de cada intento y un reintento creaba otro archivo).
//   · registrar_toma no cuenta fotos y, si las vigentes ya estaban
//     revisadas, comprueba la toma en el acto: por eso solo se registra
//     cuando TODO el trabajo quedó ligado y el servidor tiene el mínimo.
//   · Una foto "perdida" (no estaba en el teléfono) bloquea el registro
//     hasta que el monitorista la quite o la reponga.
// ============================================================

export type TipoArchivo = 'foto' | 'video';

/**
 * Vida de un archivo en la cola:
 *   local   → solo en el teléfono;
 *   subido  → ya está en Storage, falta su fila;
 *   ligando → se mandó el INSERT y no se supo si entró (se consulta antes de
 *             repetirlo);
 *   ligado  → su fila está en pauta_evidencias (fin);
 *   quitado → el monitorista lo quitó (fin; si llegó a subir, la cola limpia
 *             el servidor: ver `limpiar`);
 *   perdido → no estaba en el teléfono (no cupo o falló la lectura 3 veces);
 *   fallido → el servidor lo rechazó con un error que no es de red. El Blob
 *             se CONSERVA (era la única copia: la cámara de la app no la deja
 *             en el carrete), se reintenta en cada vuelta y bloquea el cierre
 *             y el registro hasta que suba, se quite o se descarte
 *             (revisión del código, 22-oct-2026).
 */
export type EstadoArchivo = 'local' | 'subido' | 'ligando' | 'ligado' | 'quitado' | 'perdido' | 'fallido';

export type ArchivoToma = {
  /** Id corto, único dentro del trabajo (llave del Blob: t:<id del trabajo>:<fid>). */
  fid: string;
  /** Orden de captura dentro del trabajo (1, 2, 3…). */
  n: number;
  /** Ruta FIJA en el bucket evidencias. */
  path: string;
  /** Nombre único con extensión (para la hoja de compartir y el aviso). */
  nombre: string;
  mime: string;
  tipo: TipoArchivo;
  bytes: number;
  referencia: string | null;
  /** Hora del teléfono al encolar (solo se muestra; no decide nada). */
  encolado_en: string;
  /** Cámara de la app o galería: solo las de cámara se ofrecen para Fotos. */
  origen: 'camara' | 'galeria';
  estado: EstadoArchivo;
  /** Lecturas del teléfono que fallaron seguidas (regla de 3, como visitas). */
  lecturasFallidas?: number;
  /**
   * Se quitó después de llegar a Storage: la cola borra su fila y su objeto
   * (con reintento) antes de cerrar el trabajo. Lo hace la cola y no la
   * pantalla, para no chocar con un INSERT en vuelo (revisión, 22-oct-2026).
   * 'objeto' = se descartó: solo se borra el archivo si NO tiene fila (lo
   * que ya entró a la toma se queda).
   */
  limpiar?: boolean | 'objeto';
  /**
   * Ya está en Storage (pasó por 'subido'). Un 'fallido' con esta marca solo
   * falta ligarlo: no necesita el Blob (tras recargar sin él no es "perdido").
   */
  arriba?: boolean;
  /** Cuándo entró su fila (ISO, reloj del teléfono). */
  ligado_en?: string;
  /**
   * Cuándo se mandó su INSERT por primera vez (ISO, reloj del teléfono): la
   * lista solo suma como "nueva" la que se mandó después de que su última
   * carga llegó (ésa seguro no viene en la cuenta del servidor).
   */
  insert_en?: string;
};

export type TrabajoToma = {
  v: 1;
  /** UUID propio: llave en IndexedDB, de los Blobs y del descarte. */
  id: string;
  /** correo|año|catorcena|cara: para encontrar el trabajo activo de una cara. */
  clave: string;
  /** Solo la sesión de este correo lo procesa y lo ve. */
  email: string;
  anio: number;
  catorcena: number;
  vfid: string;
  site_id: string;
  cara: string | null;
  campana: string | null;
  /** Fotos que exige la especificación (al pedir el registro). */
  minimo: number;
  /** El monitorista tocó "Registrar toma". */
  registrar: boolean;
  registrarPedidoEn: string | null;
  /**
   * La fecha_rechazo que el SERVIDOR tenía en la primera lectura después de
   * pedir el registro, hecha con la sesión validada (undefined = aún no se
   * lee). "Regresada" se decide contra ella y no contra el reloj del
   * teléfono (revisión, 22-oct-2026).
   */
  rechazoBase?: string | null;
  /** El último error que ya se avisó (para no repetirlo en cada vuelta). */
  avisado?: string | null;
  /** registrar_toma ya respondió bien (o la toma ya estaba registrada). */
  registrada: boolean;
  archivos: ArchivoToma[];
  ultimoError: string | null;
  /** El último intento dio un error que no se arregla solo. */
  conError: boolean;
  creado_en: string;
  actualizado_en: string;
};

/** La fila de pauta_monitoreo de la cara (lo que importa a la cola). */
export type EstadoTomaServidor = {
  fecha_toma: string | null;
  fecha_comprobacion: string | null;
  fecha_rechazo: string | null;
  /** Para citarlo si la toma se regresó (la lista del teléfono puede no traerlo aún). */
  rechazo_motivo?: string | null;
};

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();

/** correo|año|catorcena|cara: un trabajo activo por cara y por usuario. */
export function claveTrabajo(email: string, anio: number, catorcena: number, vfid: string): string {
  return `${norm(email)}|${anio}|${catorcena}|${vfid}`;
}

/** Misma limpieza que el nombre de hoy en RegistrarTomaModal (hay vfid con ", "). */
export function limpiarNombre(s: string): string {
  return (s || '').replace(/[^\w.\-]/g, '_');
}

const EXT_VIDEO = /^(mov|mp4|m4v|webm|3gp|3g2|avi|mkv)$/i;

/** ¿Video? Por el tipo MIME o, si no viene, por la extensión. */
export function tipoDeArchivo(mime: string | null | undefined, nombre: string | null | undefined): TipoArchivo {
  if ((mime || '').toLowerCase().startsWith('video')) return 'video';
  if ((mime || '').toLowerCase().startsWith('image')) return 'foto';
  const m = /\.([a-z0-9]{1,8})$/i.exec(nombre || '');
  return m && EXT_VIDEO.test(m[1]) ? 'video' : 'foto';
}

/**
 * Extensión en minúsculas: la del nombre, o la del tipo MIME (jpeg → jpg,
 * quicktime → mov), o jpg/mp4. iOS decide "Guardar imagen/video" por ella.
 */
export function extensionDe(nombre: string | null | undefined, mime: string | null | undefined, tipo: TipoArchivo): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(nombre || '');
  if (m) return m[1].toLowerCase();
  const sub = ((mime || '').split('/')[1] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'quicktime') return 'mov';
  if (sub) return sub;
  return tipo === 'video' ? 'mp4' : 'jpg';
}

/**
 * Ruta FIJA de un archivo en el bucket evidencias. Mismo formato de siempre
 * (cara_catAÑO-N_día_marca) más -<idCorto>-<n>: dos fotos del mismo
 * milisegundo, o de dos trabajos, nunca chocan. Un choque haría que "ya
 * existe" contara como subida y la segunda foto se perdería en silencio.
 */
export function rutaFoto(p: {
  anio: number;
  catorcena: number;
  vfid: string;
  dia: string;
  marcaMs: number;
  idCorto: string;
  n: number;
  ext: string;
}): string {
  const cat = `${p.anio}-${p.catorcena}`;
  const nombre = limpiarNombre(`${p.vfid}_cat${cat}_${p.dia}_${p.marcaMs}-${p.idCorto}-${p.n}`);
  const ext = (p.ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  return `pauta/${cat}/${nombre}.${ext}`;
}

/**
 * Nombre único para la hoja de compartir (la cámara llama a todo "image.jpg").
 * `n` lleva también el id corto del trabajo: con señal, cada foto cae en su
 * propio trabajo y el número solo no basta.
 */
export function nombreParaCompartir(vfid: string, n: number | string, ext: string): string {
  return `toma_${limpiarNombre(vfid)}_${n}.${(ext || 'jpg').toLowerCase()}`;
}

/** Estados en los que el archivo ya no necesita nada de la cola ('fallido' sí: se reintenta). */
export function esFinal(e: EstadoArchivo): boolean {
  return e === 'ligado' || e === 'quitado' || e === 'perdido';
}

/** Lo que falta mandar, en orden: primero las fotos (FIFO) y al final los videos. */
export function porMandar(t: Pick<TrabajoToma, 'archivos'>): ArchivoToma[] {
  const pend = t.archivos.filter((a) => !esFinal(a.estado));
  return [...pend.filter((a) => a.tipo === 'foto'), ...pend.filter((a) => a.tipo === 'video')].sort((a, b) =>
    a.tipo === b.tipo ? a.n - b.n : a.tipo === 'foto' ? -1 : 1
  );
}

/** ¿Ya no queda nada que hacer con este trabajo? (se borra del teléfono) */
export function listoParaCerrar(t: Pick<TrabajoToma, 'archivos' | 'registrar' | 'registrada'>): boolean {
  return (
    t.archivos.every((a) => esFinal(a.estado) && !a.limpiar) && (!t.registrar || t.registrada)
  );
}

/** Archivos quitados que aún dejan algo en el servidor por limpiar. */
export function porLimpiar(t: Pick<TrabajoToma, 'archivos'>): ArchivoToma[] {
  return t.archivos.filter((a) => a.estado === 'quitado' && a.limpiar);
}

/**
 * Ya no hay nada del monitorista, solo limpiar en el servidor lo que quitó
 * (p. ej. tras Descartar sin señal): la cola lo termina sola y no se pinta
 * ni pide atención.
 */
export function soloLimpieza(t: Pick<TrabajoToma, 'archivos' | 'registrar' | 'registrada'>): boolean {
  return (
    t.archivos.length > 0 && t.archivos.every((a) => a.estado === 'quitado') && !(t.registrar && !t.registrada)
  );
}

/** Archivos que el servidor rechazó y siguen en el teléfono. */
export function fallidos(t: Pick<TrabajoToma, 'archivos'>): number {
  return t.archivos.filter((a) => a.estado === 'fallido').length;
}

/** Fotos (no videos) del trabajo que siguen en el teléfono sin entrar. */
export function fotosPorSubir(t: Pick<TrabajoToma, 'archivos'>): number {
  return t.archivos.filter((a) => a.tipo === 'foto' && !esFinal(a.estado)).length;
}

/** Fotos que no estaban en el teléfono (bloquean el registro). */
export function fotosPerdidas(t: Pick<TrabajoToma, 'archivos'>): number {
  return t.archivos.filter((a) => a.tipo === 'foto' && a.estado === 'perdido').length;
}

/** Cuántas fotos faltan para el mínimo, contando las del servidor y las que vienen en la cola. */
export function faltanFotos(minimo: number, fotosServidor: number, fotosEnCola: number): number {
  return Math.max(0, (minimo || 0) - Math.max(0, fotosServidor) - Math.max(0, fotosEnCola));
}

/** Instante de un timestamp de la base (tolerante a '+00:00', microsegundos y sin zona). */
export function instanteDe(s: string | null | undefined): number {
  if (!s) return NaN;
  let t = String(s).trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  // Postgres en texto da "+00"; Date.parse solo entiende "+00:00".
  if (/[+-]\d{2}$/.test(t)) t += ':00';
  if (!/[zZ]$|[+-]\d{2}(:?\d{2})?$/.test(t)) t += 'Z';
  return Date.parse(t);
}

export type DecisionRegistro =
  /** Aún hay archivos por mandar: primero ellos. */
  | { tipo: 'esperar' }
  /** No se pidió registrar: nada que hacer. */
  | { tipo: 'noPedido' }
  /** La toma ya tiene fecha_toma (la registró esta cola u otro): hecho. */
  | { tipo: 'hecho' }
  /** El analista la regresó después de que se pidió el registro. */
  | { tipo: 'regresada' }
  /** Hay fotos que no estaban en el teléfono. */
  | { tipo: 'perdidas'; n: number }
  /** El servidor ve menos fotos de las que este trabajo ya ligó: sesión anónima. */
  | { tipo: 'sinSesion' }
  /** No llega al mínimo de la especificación. */
  | { tipo: 'faltan'; n: number }
  | { tipo: 'registrar' };

/**
 * ¿Se llama registrar_toma? Solo cuando todo el trabajo quedó en un estado
 * final, no hay fotos perdidas, la toma no se registró ni se regresó
 * mientras tanto y el servidor ya tiene el mínimo. `fotosServidor` = fotos
 * vigentes (sin video) con path distinto.
 */
export function decidirRegistro(
  t: Pick<TrabajoToma, 'archivos' | 'registrar' | 'registrada' | 'rechazoBase' | 'minimo'>,
  estado: EstadoTomaServidor | null,
  fotosServidor: number
): DecisionRegistro {
  if (!t.registrar || t.registrada) return { tipo: 'noPedido' };
  if (t.archivos.some((a) => !esFinal(a.estado))) return { tipo: 'esperar' };
  if (estado?.fecha_toma) return { tipo: 'hecho' };
  // El analista la regresó DESPUÉS de pedir el registro: el servidor trae una
  // fecha_rechazo distinta de la que tenía en la primera lectura tras el
  // pedido. Se comparan valores del servidor (el reloj del teléfono puede ir
  // atrasado y un rechazo anterior al pedido es justo lo que la toma repone).
  if (t.rechazoBase !== undefined && estado?.fecha_rechazo) {
    const base = instanteDe(t.rechazoBase);
    const ahora = instanteDe(estado.fecha_rechazo);
    if (!Number.isFinite(base) || (Number.isFinite(ahora) && ahora !== base)) return { tipo: 'regresada' };
  }
  const perdidas = fotosPerdidas(t);
  if (perdidas > 0) return { tipo: 'perdidas', n: perdidas };
  const ligadas = t.archivos.filter((a) => a.tipo === 'foto' && a.estado === 'ligado').length;
  // La RLS de pauta_evidencias contesta [] sin error a una sesión anónima
  // (al volver la red hay ~60 s así): ver menos de lo que YA entró desde este
  // teléfono no es "faltan", es "todavía no hay sesión".
  if (fotosServidor < ligadas) return { tipo: 'sinSesion' };
  const faltan = faltanFotos(t.minimo, fotosServidor, 0);
  if (faltan > 0) return { tipo: 'faltan', n: faltan };
  return { tipo: 'registrar' };
}

/** Lo que la lista de Pauta y el modal pintan de cada cara con trabajo en cola. */
export type ResumenCara = {
  id: string;
  /** Archivos que siguen en el teléfono (fotos y videos). */
  porSubir: number;
  fotosPorSubir: number;
  /** Fotos de estos trabajos que ya entraron (la lista aún puede no verlas). */
  ligadas: number;
  /** Cuándo se mandó el INSERT de cada una de esas fotos (ISO): la lista suma las que su última carga no veía. */
  ligadasEn: string[];
  registrarPedido: boolean;
  registrada: boolean;
  conError: boolean;
  ultimoError: string | null;
};

/** Llave de una cara en la lista de Pauta: año-catorcena-cara. */
export function llaveCara(anio: number, catorcena: number, vfid: string): string {
  return `${anio}-${catorcena}-${vfid}`;
}

export function resumenPorCara(trabajos: TrabajoToma[]): Map<string, ResumenCara> {
  const m = new Map<string, ResumenCara>();
  for (const t of trabajos) {
    if (soloLimpieza(t)) continue;
    const k = llaveCara(t.anio, t.catorcena, t.vfid);
    const ligadas = t.archivos.filter((a) => a.tipo === 'foto' && a.estado === 'ligado');
    const r: ResumenCara = {
      id: t.id,
      porSubir: t.archivos.filter((a) => !esFinal(a.estado)).length,
      fotosPorSubir: fotosPorSubir(t),
      ligadas: ligadas.length,
      ligadasEn: ligadas.map((a) => a.insert_en || a.ligado_en || a.encolado_en),
      registrarPedido: t.registrar && !t.registrada,
      registrada: t.registrada,
      conError: !!t.conError,
      ultimoError: t.ultimoError,
    };
    const previo = m.get(k);
    // Dos trabajos de la misma cara (raro: dos correos en un teléfono) se suman.
    if (previo) {
      previo.porSubir += r.porSubir;
      previo.fotosPorSubir += r.fotosPorSubir;
      previo.ligadas += r.ligadas;
      previo.ligadasEn.push(...r.ligadasEn);
      previo.registrarPedido ||= r.registrarPedido;
      previo.conError ||= r.conError;
      previo.ultimoError ||= r.ultimoError;
    } else m.set(k, r);
  }
  return m;
}

/**
 * Lo que terminó la cola, para el aviso breve. `fotos`: en un registro, las
 * de la TOMA en el servidor; en fotos sueltas, las que subió ese trabajo.
 * `llave` (año-catorcena-cara) y `en` (ms) sirven para juntar los de una
 * misma cara y soltar los que el monitorista ya vio en pantalla.
 */
export type Logro = {
  site_id: string;
  cara: string | null;
  registrada: boolean;
  fotos: number;
  llave?: string;
  en?: number;
};

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/**
 * Junta los logros de una misma cara: si se registró, cuenta una toma con
 * las fotos de la toma (no la suma de cada foto suelta que subió antes: eso
 * contaba de más); si no, suma las fotos sueltas.
 */
export function juntarPorCara(logros: Logro[]): Logro[] {
  const porCara = new Map<string, Logro>();
  for (const l of logros) {
    const k = l.llave ?? `${l.site_id}|${l.cara ?? ''}`;
    const p = porCara.get(k);
    if (!p) porCara.set(k, { ...l });
    else if (l.registrada || p.registrada) {
      const fotos = Math.max(l.registrada ? l.fotos : 0, p.registrada ? p.fotos : 0);
      porCara.set(k, { ...p, registrada: true, fotos });
    } else p.fotos += l.fotos;
  }
  return [...porCara.values()];
}

/**
 * El aviso breve al terminar (Erik: "pequeño y no invasivo"). Con el sitio y
 * la cara, que es lo que el monitorista ve en la lista; varios se juntan en
 * uno solo.
 */
export function textoLogro(todos: Logro[]): string {
  const logros = juntarPorCara(todos);
  if (!logros.length) return '';
  const fotos = logros.reduce((s, l) => s + l.fotos, 0);
  if (logros.length === 1) {
    const l = logros[0];
    const donde = `${l.site_id}${l.cara ? ` · cara ${l.cara}` : ''}`;
    // Corto: en un iPhone cabe en dos renglones. Sin "(0 fotos)" cuando las
    // fotos subieron antes y solo faltaba registrar.
    return l.registrada
      ? `✓ Toma registrada · ${donde}${l.fotos > 0 ? ` · ${plural(l.fotos, 'foto', 'fotos')}` : ''}`
      : `✓ ${plural(l.fotos, 'foto subida', 'fotos subidas')} · ${donde}`;
  }
  const tomas = logros.filter((l) => l.registrada).length;
  return tomas
    ? `✓ ${plural(tomas, 'toma registrada', 'tomas registradas')} · ${plural(fotos, 'foto', 'fotos')}`
    : `✓ ${plural(fotos, 'foto subida', 'fotos subidas')}`;
}

/**
 * Grupos para la hoja de compartir. Chrome en Android acepta hasta 10
 * archivos y 50 MiB por share (y cada share necesita su propio toque); iOS
 * no pone tope, va en un solo grupo.
 */
export function gruposParaCompartir<T extends { size: number }>(files: T[], android: boolean): T[][] {
  if (!files.length) return [];
  if (!android) return [files];
  const MAX_N = 10;
  const MAX_BYTES = 50 * 1024 * 1024;
  const grupos: T[][] = [];
  let actual: T[] = [];
  let bytes = 0;
  for (const f of files) {
    if (actual.length && (actual.length >= MAX_N || bytes + f.size > MAX_BYTES)) {
      grupos.push(actual);
      actual = [];
      bytes = 0;
    }
    actual.push(f);
    bytes += f.size;
  }
  if (actual.length) grupos.push(actual);
  return grupos;
}
