// ============================================================
// src/modules/rutas/ImportarRutasArchivoModal.tsx
// Vista previa del Excel de rutas genérico (Clave Nueva, Ruta, Secuencia,
// Estatus, VALLAS, Dirección) ANTES de importar (rutas, 5-oct-2026).
//
// POR QUÉ: antes el archivo se mandaba directo a `importar_rutas` y su
// columna Dirección pisaba sin avisar lo que se veía en Rutas. Ahora, quien
// importa ve lado a lado la dirección de QTM (inventario) y la del archivo
// cuando NO dicen lo mismo, y ELIGE cuál se queda: una elección para todo
// el archivo y, si quiere, sitio por sitio. Nadie corrige direcciones en
// campo (Erik, 5-oct-2026).
//
// Si se elige QTM la dirección sigue viva: se guarda la fuente ('qtm'), no
// el texto, y si QTM la corrige mañana, en Rutas se ve sola. La de archivo
// se queda como texto fijo hasta el siguiente archivo.
//
// Para no marcar diferencias falsas se compara normalizado (sin acentos,
// mayúsculas, signos, BLVD/BOULEVARD, AV/AVENIDA, S/N…): ver
// normalizarDireccion en rutasComun.ts.
//
// Reimportar (rutas, 5-oct-2026): cada sitio que YA está en una ruta
// arranca con la fuente que tiene hoy (lo que se eligió la vez pasada no
// se pierde por volver a subir el archivo); los nuevos esperan la elección
// para todo el archivo. Tocar esa elección general sí cambia TODAS. Y si el
// archivo mueve sitios que hoy están en otra ruta, pide confirmación con la
// lista (de qué ruta sale cada uno), igual que el armado: antes solo avisaba
// y un Excel viejo podía revolver rutas sin que nadie lo decidiera. Ambas
// cosas se leen FRESCAS de la base al abrir, no de lo que Rutas tenía
// cargado desde hace rato.
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { sb } from '../../lib/supabase';
import { tope } from '../../lib/envios';
import { pareceSinRed } from '../../lib/enLinea';
import { haySesionReal } from '../../lib/datosLocales';
import { sinAcentos } from '../../lib/helpers';
import { vigilarRender } from '../../lib/vigia';
import {
  mismaDireccion,
  textoFalla,
  TOPE_LECTURA_MS,
  traerPaginado,
  trozos,
  type Resumen,
  type Ubic,
} from './rutasComun';

/** Una fila útil del archivo. */
export type FilaArchivo = {
  site_id: string;
  ruta: number;
  secuencia: number | null;
  estatus: string;
  vallas: number | null;
  direccion: string;
};

type Fuente = 'qtm' | 'archivo';

/** Dónde está HOY un sitio del archivo (fila fresca de vw_rutas_con_coords). */
type Actual = {
  ruta: number;
  nombre: string | null;
  unidad: string;
  tipo: string;
  fuente: Fuente | null;
};
type FilaActual = {
  site_id: string;
  ruta_numero: number;
  ruta_nombre: string | null;
  ruta_unidad: string;
  ruta_tipo: string;
  direccion_fuente: string | null;
};

const mismoTexto = (a: string | null | undefined, b: string | null | undefined) =>
  (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

/** Encabezado normalizado → campo. Acepta las variantes que se han visto
 *  (con y sin acento, mayúsculas, "Clave" a secas). */
function campoDe(encabezado: string): keyof FilaArchivo | null {
  const h = sinAcentos(encabezado).replace(/[^a-z0-9]+/g, ' ').trim();
  if (h === 'clave nueva' || h === 'clave' || h === 'site id' || h === 'site_id') return 'site_id';
  if (h === 'ruta' || h === 'no ruta' || h === 'numero de ruta') return 'ruta';
  if (h === 'secuencia' || h === 'orden') return 'secuencia';
  if (h === 'estatus' || h === 'status') return 'estatus';
  if (h === 'vallas' || h === 'caras') return 'vallas';
  if (h === 'direccion' || h === 'domicilio') return 'direccion';
  return null;
}

/** Número de ruta: 3, "3" o "Ruta 3". Nada de 0 ni vacíos (Number('') = 0
 *  colaba filas sin ruta a la "Ruta 0"). */
function numeroRuta(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  const m = /^\s*(?:ruta\s*)?(\d+)\s*$/i.exec(String(v ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

function numeroONulo(v: unknown): number | null {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convierte las filas crudas de la hoja (sheet_to_json) en filas útiles.
 * Devuelve también cuántas se descartaron (sin clave o sin ruta numérica).
 */
export function leerFilasArchivo(rows: Record<string, unknown>[]): {
  filas: FilaArchivo[];
  descartadas: number;
  conDireccion: boolean;
} {
  let descartadas = 0;
  let conDireccion = false;
  const filas: FilaArchivo[] = [];
  for (const r of rows) {
    const f: Partial<Record<keyof FilaArchivo, unknown>> = {};
    for (const [k, v] of Object.entries(r)) {
      const c = campoDe(k);
      if (c && f[c] === undefined) f[c] = v;
      if (c === 'direccion') conDireccion = true;
    }
    const site_id = String(f.site_id ?? '').trim();
    const ruta = numeroRuta(f.ruta);
    if (!site_id || ruta == null) {
      // Renglones en blanco al final de la hoja no cuentan como descartados.
      if (site_id || f.ruta != null) descartadas++;
      continue;
    }
    filas.push({
      site_id,
      ruta,
      secuencia: numeroONulo(f.secuencia),
      estatus: String(f.estatus ?? '').trim().toUpperCase(),
      vallas: numeroONulo(f.vallas),
      direccion: String(f.direccion ?? '').trim(),
    });
  }
  return { filas, descartadas, conDireccion };
}

type Resultado = {
  rutas_creadas?: number;
  ubicaciones_procesadas?: number;
  omitidas?: number;
  omitidos_ejemplo?: unknown[];
};

/** Las filas que se ven por tanda en la comparación (iPhone viejo). */
const POR_TANDA = 40;

export default function ImportarRutasArchivoModal({
  unidad,
  tipo,
  nombreArchivo,
  filas: filasCrudas,
  descartadas,
  resumen,
  ubicsSegmento,
  onClose,
  onImportado,
}: {
  unidad: string;
  tipo: string;
  /** Paradas actuales del segmento (las que Rutas ya tenía cargadas). Solo
   *  cubren mientras llega la lectura fresca de la base, que es la que
   *  decide la fuente inicial y qué sitios cambian de ruta (rutas,
   *  5-oct-2026). */
  ubicsSegmento: Ubic[];
  nombreArchivo: string;
  filas: FilaArchivo[];
  descartadas: number;
  /** Rutas actuales del segmento: para decir cuáles son nuevas. */
  resumen: Resumen[];
  onClose: () => void;
  onImportado: (resumen: string) => void;
}) {
  vigilarRender('ImportarRutasArchivoModal');

  // Una clave repetida en el archivo: gana la ÚLTIMA (es lo que haría la
  // base al aplicar el upsert en orden).
  const { filas, repetidas } = useMemo(() => {
    const m = new Map<string, FilaArchivo>();
    for (const f of filasCrudas) m.set(f.site_id, f);
    return { filas: [...m.values()], repetidas: filasCrudas.length - m.size };
  }, [filasCrudas]);

  // --- Dirección de QTM por sitio (primera cara del segmento) ---
  const [cargando, setCargando] = useState(true);
  const [errCarga, setErrCarga] = useState('');
  const [qtm, setQtm] = useState<Map<string, string>>(new Map());
  /** Dónde está hoy cada sitio del archivo, leído al abrir; null = aún no. */
  const [actuales, setActuales] = useState<Map<string, Actual> | null>(null);
  const [intento, setIntento] = useState(0);
  const claveSitios = filas.map((f) => f.site_id).join('|');

  useEffect(() => {
    let activo = true;
    setCargando(true);
    setErrCarga('');
    (async () => {
      const ids = claveSitios ? claveSitios.split('|') : [];
      const m = new Map<string, string>();
      for (const t of trozos(ids, 100)) {
        const r = await traerPaginado<{ site_id: string; vendor_face_id: string; direccion: string | null }>(
          (desde, hasta, senal) =>
            sb
              .from('inventario')
              .select('site_id,vendor_face_id,direccion')
              .eq('unidad_negocio', unidad)
              .eq('tipo_medio', tipo)
              .in('site_id', t)
              .order('vendor_face_id')
              .range(desde, hasta)
              .abortSignal(senal)
        );
        if (!activo) return;
        if (r.error) {
          setErrCarga('No se pudo leer el inventario para comparar. ' + textoFalla(r.error, r.sinRed));
          setCargando(false);
          return;
        }
        // La primera cara (orden por vendor_face_id) manda, como en la vista.
        for (const x of r.filas) if (!m.has(x.site_id)) m.set(x.site_id, x.direccion || '');
      }
      // Dónde está HOY cada sitio, en CUALQUIER ruta (rutas, 5-oct-2026):
      // decide la fuente inicial y qué se mueve. site_id es único en
      // ruta_ubicaciones, así que cada sitio sale una vez como mucho.
      const act = new Map<string, Actual>();
      for (const t of trozos(ids, 100)) {
        const r = await traerPaginado<FilaActual>(
          (desde, hasta, senal) =>
            sb
              .from('vw_rutas_con_coords')
              .select('site_id,ruta_numero,ruta_nombre,ruta_unidad,ruta_tipo,direccion_fuente')
              .in('site_id', t)
              .order('site_id')
              .range(desde, hasta)
              .abortSignal(senal),
          { topeMs: TOPE_LECTURA_MS }
        );
        if (!activo) return;
        if (r.error) {
          setErrCarga('No se pudo leer en qué ruta está hoy cada sitio. ' + textoFalla(r.error, r.sinRed));
          setCargando(false);
          return;
        }
        for (const x of r.filas)
          act.set(x.site_id, {
            ruta: x.ruta_numero,
            nombre: x.ruta_nombre,
            unidad: x.ruta_unidad,
            tipo: x.ruta_tipo,
            fuente: x.direccion_fuente === 'archivo' ? 'archivo' : x.direccion_fuente === 'qtm' ? 'qtm' : null,
          });
      }
      if (!activo) return;
      setQtm(m);
      setActuales(act);
      setCargando(false);
    })();
    return () => {
      activo = false;
    };
  }, [claveSitios, unidad, tipo, intento]);

  /** site_id → cómo está HOY (ruta y fuente de la dirección). La lectura
   *  fresca manda; lo que Rutas tenía cargado solo cubre mientras llega (la
   *  pantalla no deja importar antes de que llegue). */
  const hoy = useMemo(() => {
    if (actuales) return actuales;
    const m = new Map<string, Actual>();
    for (const u of ubicsSegmento)
      m.set(u.site_id, {
        ruta: u.ruta_numero,
        nombre: u.ruta_nombre,
        unidad,
        tipo,
        fuente: u.direccion_fuente ?? null,
      });
    return m;
  }, [actuales, ubicsSegmento, unidad, tipo]);

  // --- Clasificación ---
  const analisis = useMemo(() => {
    const difieren: FilaArchivo[] = [];
    let iguales = 0;
    let sinDirArchivo = 0;
    const fueraDeSegmento: string[] = [];
    for (const f of filas) {
      const q = qtm.get(f.site_id);
      if (q === undefined) {
        fueraDeSegmento.push(f.site_id);
        continue;
      }
      if (!f.direccion) {
        sinDirArchivo++;
        continue;
      }
      if (!q || mismaDireccion(q, f.direccion)) iguales++;
      else difieren.push(f);
    }
    const numeros = [...new Set(filas.map((f) => f.ruta))].sort((a, b) => a - b);
    const existentes = new Set(resumen.map((r) => r.numero));
    // (QA, 5-oct-2026) El archivo MUEVE en la base los sitios que hoy están
    // en otra ruta: antes pasaba sin que se viera. Desde el 5-oct pide
    // confirmación.
    // (corrector, 5-oct-2026) Los que hoy están en una ruta de OTRA unidad o
    // medio ya no se mueven: importar_rutas los omite con su motivo (misma
    // regla que el armado; si no, "Sincronizar rutas" los regresaba y el
    // sitio brincaba entre las dos). Aquí solo se avisa, sin confirmación.
    const cambianDeRuta: { site_id: string; de: string; a: number }[] = [];
    const otroSegmento: { site_id: string; de: string }[] = [];
    for (const f of filas) {
      const h = hoy.get(f.site_id);
      if (!h) continue;
      const otroSeg = !mismoTexto(h.unidad, unidad) || !mismoTexto(h.tipo, tipo);
      if (otroSeg) {
        otroSegmento.push({
          site_id: f.site_id,
          de: `Ruta ${h.ruta}` + (h.nombre ? ` · ${h.nombre}` : '') + ` de ${h.unidad} ${h.tipo}`,
        });
        continue;
      }
      if (h.ruta === f.ruta) continue;
      cambianDeRuta.push({
        site_id: f.site_id,
        de: `Ruta ${h.ruta}` + (h.nombre ? ` · ${h.nombre}` : ''),
        a: f.ruta,
      });
    }
    return {
      cambianDeRuta,
      otroSegmento,
      difieren,
      difierenSet: new Set(difieren.map((f) => f.site_id)),
      iguales,
      sinDirArchivo,
      fueraDeSegmento,
      numeros,
      nuevas: numeros.filter((n) => !existentes.has(n)),
    };
  }, [filas, qtm, resumen, hoy]);

  // --- Elección ---
  /** null = no se ha tocado la elección para todo el archivo. */
  const [global, setGlobal] = useState<Fuente | null>(null);
  /** Excepciones sitio por sitio (solo de las que difieren). */
  const [porSitio, setPorSitio] = useState<Record<string, Fuente>>({});
  const [verHasta, setVerHasta] = useState(POR_TANDA);

  const elegirGlobal = (f: Fuente) => {
    // Cambiar la elección general reinicia las excepciones Y pisa la fuente
    // que cada sitio tenía hoy: así lo que se ve marcado es exactamente lo
    // que se va a guardar.
    setGlobal(f);
    setPorSitio({});
  };
  /** Lo que tendría el sitio sin excepción propia: la elección general si
   *  ya se tocó; si no, la fuente que tiene HOY en su ruta (rutas,
   *  5-oct-2026); si es nuevo, QTM cuando no hay diferencia y null
   *  (= falta elegir) cuando la hay. */
  const baseDe = (f: FilaArchivo): Fuente | null =>
    global ?? hoy.get(f.site_id)?.fuente ?? (analisis.difierenSet.has(f.site_id) ? null : 'qtm');
  /** undefined = no se manda: el archivo no trae dirección, así que no hay
   *  nada que elegir y la base CONSERVA la fuente de una parada que ya
   *  existía (en una nueva pone 'qtm'). null = falta elegir. */
  const fuenteDe = (f: FilaArchivo): Fuente | null | undefined => {
    const q = qtm.get(f.site_id);
    if (!f.direccion) return undefined;
    if (q === undefined || !q) return 'archivo'; // QTM no la tiene
    return porSitio[f.site_id] ?? baseDe(f);
  };
  const elegirSitio = (f: FilaArchivo, fu: Fuente) =>
    setPorSitio((prev) => {
      const n = { ...prev };
      if (fu === baseDe(f)) delete n[f.site_id];
      else n[f.site_id] = fu;
      return n;
    });
  const cuantasArchivo = analisis.difieren.filter((f) => fuenteDe(f) === 'archivo').length;
  const pendientes = analisis.difieren.filter((f) => fuenteDe(f) == null).length;
  /** Las que difieren y ya estaban en una ruta (arrancan con su fuente). */
  const yaEnRuta = analisis.difieren.filter((f) => hoy.get(f.site_id)?.fuente).length;
  /** De las que difieren, cuántas usan HOY la del archivo y con esta
   *  elección pasarían a QTM (QA, 5-oct-2026: antes no se veía). */
  const pasanAQtm = analisis.difieren.filter(
    (f) => hoy.get(f.site_id)?.fuente === 'archivo' && fuenteDe(f) === 'qtm'
  ).length;
  const faltaElegir = pendientes > 0;

  // --- Importar ---
  const [importando, setImportando] = useState(false);
  const [errImp, setErrImp] = useState('');
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);
  const enCurso = useRef(false);
  /** Panel "estos sitios cambian de ruta" abierto (rutas, 5-oct-2026). */
  const [confirmarMover, setConfirmarMover] = useState(false);
  const avisoMoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // El botón Importar está en el pie fijo y la lista puede ser larga: el
    // panel se trae a la vista para que no parezca que no pasó nada.
    // (QA, 5-oct-2026) 'center' y no 'nearest': con 'nearest' los botones
    // del panel quedaban debajo del pie fijo (sticky) y no se veían.
    if (confirmarMover) avisoMoverRef.current?.scrollIntoView({ block: 'center' });
  }, [confirmarMover]);

  const importar = async (moverConfirmado = false) => {
    if (enCurso.current || faltaElegir) return;
    if (analisis.cambianDeRuta.length > 0 && !moverConfirmado) {
      setConfirmarMover(true);
      return;
    }
    setConfirmarMover(false);
    enCurso.current = true;
    setImportando(true);
    setErrImp('');
    try {
      if (!(await haySesionReal())) {
        if (vivo.current)
          setErrImp('Tu sesión se está reconectando. Espera unos segundos y vuelve a tocar Importar.');
        return;
      }
      const p_filas = filas.map((f) => ({
        site_id: f.site_id,
        ruta: f.ruta,
        secuencia: f.secuencia,
        estatus: f.estatus,
        vallas: f.vallas,
        direccion: f.direccion,
        origen: 'archivo',
        ...(fuenteDe(f) ? { fuente_direccion: fuenteDe(f) as Fuente } : {}),
      }));
      const { data, error, status } = await sb
        .rpc('importar_rutas', { p_unidad: unidad, p_tipo: tipo, p_filas })
        .abortSignal(tope(60000));
      if (!vivo.current) return;
      if (error || status === 0) {
        const sinRed = status === 0 || pareceSinRed(error, status);
        setErrImp(
          sinRed
            ? 'Sin señal o la red tardó demasiado: no sé si se alcanzó a importar. Vuelve a tocar Importar cuando tengas señal (repetirlo no duplica nada).'
            : 'Error al importar: ' + (error?.message || 'desconocido')
        );
        return;
      }
      const r = (data || {}) as Resultado;
      setResultado(r);
      onImportado(
        `${nombreArchivo}: ${r.ubicaciones_procesadas ?? 0} ubicaciones procesadas, ${r.rutas_creadas ?? 0} rutas creadas` +
          ((r.omitidas ?? 0) > 0 ? `, ${r.omitidas} omitidas` : '') +
          '.'
      );
    } finally {
      enCurso.current = false;
      if (vivo.current) setImportando(false);
    }
  };

  const cerrar = () => {
    if (importando) return;
    onClose();
  };

  const ejemplos = (resultado?.omitidos_ejemplo || []).map((e) => {
    if (e && typeof e === 'object') {
      const o = e as { site_id?: string; motivo?: string };
      return `${o.site_id ?? '?'}${o.motivo ? ': ' + o.motivo : ''}`;
    }
    return String(e);
  });

  return (
    // rt-overlay-full/rt-armado (QA, 5-oct-2026): pantalla completa en el
    // teléfono, como el armado; con el padding del overlay quedaba un hueco
    // bajo el pie fijo por donde se asomaba la lista.
    <div
      className="overlay rt-overlay-full"
      onClick={(e) => {
        if (e.target === e.currentTarget) cerrar();
      }}
    >
      <div className="modal rt-armado" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="rt-armado-cab">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>Importar rutas de {unidad} {tipo}</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{nombreArchivo}</div>
          </div>
          <button type="button" className="btn-icono" onClick={cerrar} disabled={importando} aria-label="Cerrar">
            ✕
          </button>
        </div>

        {/* Resumen */}
        <div className="cards" style={{ margin: '12px 0' }}>
          <div className="card">
            <div className="n">{filas.length}</div>
            <div className="l">Sitios</div>
          </div>
          <div className="card">
            <div className="n">{analisis.numeros.length}</div>
            <div className="l">Rutas ({analisis.nuevas.length} nuevas)</div>
          </div>
          <div className="card">
            <div className="n">{cargando ? '…' : analisis.fueraDeSegmento.length + descartadas}</div>
            <div className="l">Se omiten</div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 10 }}>
          {analisis.nuevas.length > 0 && (
            <div>
              Rutas que se crean: {analisis.nuevas.slice(0, 20).join(', ')}
              {analisis.nuevas.length > 20 ? '…' : ''}.
            </div>
          )}
          {descartadas > 0 && <div>{descartadas} renglones sin clave o sin número de ruta: no se importan.</div>}
          {repetidas > 0 && <div>{repetidas} claves vienen repetidas en el archivo: cuenta la última.</div>}
          {!cargando && analisis.cambianDeRuta.length > 0 && (
            <div style={{ color: 'var(--st-ambar)' }}>
              ⚠{' '}
              {analisis.cambianDeRuta.length === 1
                ? '1 sitio hoy está en otra ruta y el archivo lo cambia'
                : `${analisis.cambianDeRuta.length} sitios hoy están en otra ruta y el archivo los cambia`}{' '}
              (
              {analisis.cambianDeRuta
                .slice(0, 5)
                .map((c) => `${c.site_id}: ${c.de} → Ruta ${c.a}`)
                .join(', ')}
              {analisis.cambianDeRuta.length > 5 ? '…' : ''}). Antes de importar te pido confirmarlo.
            </div>
          )}
          {!cargando && analisis.otroSegmento.length > 0 && (
            <div style={{ color: 'var(--st-ambar)' }}>
              ⚠{' '}
              {analisis.otroSegmento.length === 1
                ? '1 sitio ya está en una ruta de otra unidad o medio y no se mueve'
                : `${analisis.otroSegmento.length} sitios ya están en una ruta de otra unidad o medio y no se mueven`}{' '}
              (
              {analisis.otroSegmento
                .slice(0, 5)
                .map((c) => `${c.site_id}: ${c.de}`)
                .join(', ')}
              {analisis.otroSegmento.length > 5 ? '…' : ''}): la base los omite. Si de verdad cambian, primero
              quítalos de esa ruta.
            </div>
          )}
          {!cargando && analisis.fueraDeSegmento.length > 0 && (
            <div>
              {analisis.fueraDeSegmento.length} sitios no están en el inventario de {unidad} {tipo} (
              {analisis.fueraDeSegmento.slice(0, 5).join(', ')}
              {analisis.fueraDeSegmento.length > 5 ? '…' : ''}): si son de otra unidad o medio, la base los omite.
            </div>
          )}
        </div>

        {errCarga && (
          <div className="err">
            {errCarga}{' '}
            <button type="button" className="btn sm ghost" onClick={() => setIntento((n) => n + 1)}>
              Reintentar
            </button>
          </div>
        )}
        {cargando && !errCarga && (
          <div className="loading" style={{ padding: 20 }}>
            <span className="spinner" />
            Comparando direcciones con QTM…
          </div>
        )}

        {/* Direcciones */}
        {!cargando && !errCarga && !resultado && (
          <>
            {analisis.difieren.length === 0 ? (
              <div className="ok-msg">
                Las direcciones del archivo coinciden con QTM
                {analisis.sinDirArchivo > 0
                  ? ` (${analisis.sinDirArchivo} no traen dirección: las que ya estaban en una ruta conservan la suya y las nuevas usan la de QTM)`
                  : ''}
                {/* (rutas, 5-oct-2026) las que ya estaban en una ruta
                    conservan su fuente: ver baseDe. */}
                . Los sitios nuevos usarán la de QTM, que se actualiza sola; los que ya estaban en una ruta conservan
                la que usan hoy.
              </div>
            ) : (
              <div className="rt-dirs">
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  {analisis.difieren.length} de {filas.length} sitios traen una dirección distinta a la de QTM
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
                  ¿Cuál se queda en la ruta? Con <b>QTM</b>, si mañana la corrigen en QTM se ve sola. Con{' '}
                  <b>Archivo</b>, se queda la de este Excel hasta el siguiente archivo.
                  {!global && yaEnRuta > 0 && (
                    <>
                      {' '}
                      {yaEnRuta === 1
                        ? 'El sitio que ya estaba en una ruta conserva la que usa hoy'
                        : `Los ${yaEnRuta} que ya estaban en una ruta conservan la que usan hoy`}
                      ; elegir abajo para todo el archivo los cambia también.
                    </>
                  )}
                </div>
                <div className="rt-seg" role="radiogroup" aria-label="Usar dirección de">
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Usar dirección de:</span>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={global === 'qtm'}
                    className={'rt-chip' + (global === 'qtm' ? ' on' : '')}
                    onClick={() => elegirGlobal('qtm')}
                  >
                    QTM (inventario)
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={global === 'archivo'}
                    className={'rt-chip' + (global === 'archivo' ? ' on' : '')}
                    onClick={() => elegirGlobal('archivo')}
                  >
                    Archivo
                  </button>
                </div>
                {pendientes > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 8px' }}>
                    {pendientes === 1 ? 'Falta 1 sitio nuevo' : `Faltan ${pendientes} sitios nuevos`} por elegir: usa la
                    opción para todo el archivo o tócalos uno por uno.
                  </div>
                )}
                {pendientes === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 8px' }}>
                    Puedes cambiar sitio por sitio tocando la otra opción. Quedan {cuantasArchivo} con la del archivo
                    y {analisis.difieren.length - cuantasArchivo} con la de QTM.
                    {pasanAQtm > 0 && (
                      <b style={{ color: 'var(--st-ambar)' }}>
                        {' '}
                        {pasanAQtm} de ellas hoy usan la del archivo y pasarán a la de QTM.
                      </b>
                    )}
                  </div>
                )}
                <div style={{ display: 'grid', gap: 8 }}>
                  {analisis.difieren.slice(0, verHasta).map((f) => {
                    const actual = fuenteDe(f) ?? null;
                    return (
                      <div key={f.site_id} className="rt-dir-fila">
                        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                          {f.site_id} · Ruta {f.ruta}
                          {hoy.get(f.site_id)?.fuente && (
                            <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                              {' '}
                              · hoy usa la de {hoy.get(f.site_id)?.fuente === 'archivo' ? 'archivo' : 'QTM'}
                            </span>
                          )}
                        </div>
                        <div className="rt-dir-opciones">
                          {(['qtm', 'archivo'] as Fuente[]).map((fu) => (
                            <button
                              key={fu}
                              type="button"
                              className={'rt-dir-op' + (actual === fu ? ' on' : '')}
                              aria-pressed={actual === fu}
                              onClick={() => elegirSitio(f, fu)}
                            >
                              <span className="rt-dir-et">{fu === 'qtm' ? 'QTM' : 'Archivo'}</span>
                              {fu === 'qtm' ? qtm.get(f.site_id) : f.direccion}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {analisis.difieren.length > verHasta && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    style={{ marginTop: 8 }}
                    onClick={() => setVerHasta((n) => n + POR_TANDA)}
                  >
                    Ver {Math.min(POR_TANDA, analisis.difieren.length - verHasta)} más
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {resultado && (
          <div className="ok-msg" style={{ marginTop: 10 }}>
            Importación lista: {resultado.ubicaciones_procesadas ?? 0} ubicaciones procesadas,{' '}
            {resultado.rutas_creadas ?? 0} rutas creadas
            {(resultado.omitidas ?? 0) > 0 ? `, ${resultado.omitidas} omitidas` : ''}.
            {ejemplos.length > 0 && (
              <div style={{ marginTop: 6 }}>
                Omitidas (ejemplos): {ejemplos.join(' · ')}
              </div>
            )}
          </div>
        )}
        {/* Confirmación de mover (rutas, 5-oct-2026): la base no cambió nada
            todavía. Misma forma que la del armado. */}
        {confirmarMover && !resultado && analisis.cambianDeRuta.length > 0 && (
          <div className="rt-aviso" ref={avisoMoverRef}>
            <b>
              {analisis.cambianDeRuta.length === 1
                ? 'Este sitio hoy está en otra ruta y el archivo lo cambia:'
                : `Estos ${analisis.cambianDeRuta.length} sitios hoy están en otra ruta y el archivo los cambia:`}
            </b>
            <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
              {analisis.cambianDeRuta.slice(0, 12).map((c) => (
                <li key={c.site_id}>
                  {c.site_id}: sale de {c.de} y pasa a la Ruta {c.a}
                </li>
              ))}
              {analisis.cambianDeRuta.length > 12 && <li>y {analisis.cambianDeRuta.length - 12} más</li>}
            </ul>
            <div>Si continúas, salen de su ruta de hoy y quedan solo en la que dice el archivo.</div>
            <div className="rt-aviso-acc">
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => setConfirmarMover(false)}
                disabled={importando}
              >
                No, déjame revisar
              </button>
              <button type="button" className="btn sm warn" onClick={() => importar(true)} disabled={importando}>
                {importando ? 'Importando…' : 'Sí, importar y moverlos'}
              </button>
            </div>
          </div>
        )}
        {errImp && <div className="err" style={{ marginTop: 10 }}>{errImp}</div>}

        <div className="rt-pie">
          <div style={{ fontSize: 12, color: 'var(--muted)', flex: '1 1 160px' }}>
            {faltaElegir && !resultado ? 'Elige qué dirección se queda para poder importar.' : ''}
            {!faltaElegir && !resultado && confirmarMover ? 'Confirma arriba los sitios que cambian de ruta.' : ''}
          </div>
          <button type="button" className="btn ghost sm" onClick={cerrar} disabled={importando}>
            {resultado ? 'Cerrar' : 'Cancelar'}
          </button>
          {!resultado && (
            <button
              type="button"
              className="btn ok"
              onClick={() => importar()}
              disabled={importando || cargando || !!errCarga || faltaElegir || filas.length === 0}
            >
              {importando ? 'Importando…' : `Importar ${filas.length} sitios`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
