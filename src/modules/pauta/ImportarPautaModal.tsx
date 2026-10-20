// ============================================================
// src/modules/pauta/ImportarPautaModal.tsx
// Importa una catorcena desde el Excel de pauta.
//
// Dos cosas cambian en cada archivo y por eso NO se pueden dar por fijas:
//
//   1. El nombre de la hoja: 'CAT 16(15) 21JUL-03AGO'. Se ofrece un selector
//      con las hojas del libro y se preselecciona la que empiece con CAT.
//   2. El nombre de las columnas de campaña: 'Campaign Version CAT 16 (15)'
//      lleva el número de catorcena dentro. Se detectan por patrón y la más
//      reciente es la campaña actual; la otra, la anterior. En el cambio de
//      año la más reciente es la de número CHICO (Cat-1 contra Cat-26).
//
// La catorcena es número + AÑO (14-oct-2026) y el archivo no trae el año:
// se propone el de la catorcena con ese número más cercana a las fechas de
// fijación del archivo (o a hoy), y solo se ofrecen años que existan en el
// calendario.
//
// Antes de mandar nada se muestra una vista previa con lo que se detectó.
// Importar reemplaza la catorcena completa: conviene ver qué se va a cargar.
//
// La clave de sitio de cada cara sale del inventario (QTM rige, 20-oct-2026),
// no de la columna CLAVE SITIO: ver lib/sitioDesdeInventario.
// ============================================================
import { Search } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import type { WorkBook } from 'xlsx';
import { cargarXlsx } from '../../lib/xlsxDiferido';
import { esErrorDeChunk } from '../../lib/cargaDiferida';
import { sb } from '../../lib/supabase';
import { anioMasCercano, esMasReciente, etiquetaCatorcena, type CatConAnio } from '../../lib/catorcena';
import {
  carasDe,
  sitiosDesdeInventario,
  type ResultadoSitios,
  type SitioCorregido,
} from '../../lib/sitioDesdeInventario';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';

/** Fila ya normalizada, lista para la RPC. */
type FilaPauta = Record<string, string | null> & {
  site_id: string | null;
  vendor_face_id: string | null;
};

/** Lo que se detectó al leer la hoja, para confirmar antes de importar. */
type Analisis = {
  hoja: string;
  catorcena: number | null;
  etiqueta: string;
  filas: FilaPauta[];
  colCampana: string | null;
  colCampanaAnterior: string | null;
  campanas: number;
  sitios: number;
  rutas: string[];
  foraneas: number;
  faltantes: string[];
};

type Resultado = {
  anio?: number;
  recibidas: number;
  insertadas: number;
  borradas: number;
  duplicadas_omitidas: number;
  avance_conservado: number;
  campanas: number;
  sitios: number;
  sin_coordenadas: number;
  foraneas_sin_ruta: number;
};

/** Lo que se cambió de la clave de sitio del archivo según el inventario. */
type AjusteSitios = { corregidas: SitioCorregido[]; sinInventario: string[] };

/** Columnas que deben existir sí o sí. */
const OBLIGATORIAS = ['CLAVE SITIO', 'Vendor Face ID'];

/** Caras por consulta al inventario: el filtro `in` va en la URL. */
const LOTE_INVENTARIO = 150;

/** vendor_face_id → site_id de QTM para las caras dadas. Lanza si falla. */
async function sitiosDeInventario(caras: string[]): Promise<Map<string, string>> {
  const lotes: string[][] = [];
  for (let i = 0; i < caras.length; i += LOTE_INVENTARIO) lotes.push(caras.slice(i, i + LOTE_INVENTARIO));
  const respuestas = await Promise.all(
    lotes.map((lote) => sb.from('inventario').select('vendor_face_id,site_id').in('vendor_face_id', lote))
  );
  const mapa = new Map<string, string>();
  for (const { data, error } of respuestas) {
    if (error) throw new Error(error.message);
    for (const r of (data || []) as { vendor_face_id: string; site_id: string | null }[]) {
      if (r.site_id) mapa.set(r.vendor_face_id, r.site_id);
    }
  }
  return mapa;
}

/** Convierte una celda de fecha a ISO (YYYY-MM-DD) o null. */
function aFecha(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    // toISOString pasa a UTC y puede restar un día. Se arma a mano en local.
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
}

const txt = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

type Props = { onClose: () => void; onImportado: () => void };

function ImportarPautaModal({ onClose, onImportado }: Props) {
  const [libro, setLibro] = useState<WorkBook | null>(null);
  /** La librería de Excel, bajada al abrir el primer archivo (ver xlsxDiferido). */
  const xlsx = useRef<typeof import('xlsx') | null>(null);
  const [hojas, setHojas] = useState<string[]>([]);
  const [hojaSel, setHojaSel] = useState('');
  const [analisis, setAnalisis] = useState<Analisis | null>(null);
  const [catorcena, setCatorcena] = useState('');
  const [anio, setAnio] = useState('');
  /** El calendario, para proponer el año y validar que la catorcena exista. */
  const [calendario, setCalendario] = useState<CatConAnio[] | null>(null);
  /** Fecha de referencia del archivo (fijación del medio), para el año. */
  const [fechaRef, setFechaRef] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [leyendo, setLeyendo] = useState(false);
  const [importando, setImportando] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  /** Claves de sitio corregidas con el inventario en la última importación. */
  const [ajuste, setAjuste] = useState<AjusteSitios | null>(null);

  useEffect(() => {
    let vivo = true;
    sb.from('catorcenas')
      .select('numero,anio,fecha_inicio,fecha_fin')
      .order('fecha_inicio')
      .then(({ data, error }) => {
        if (!vivo) return;
        if (error) setErr('No se pudo leer el calendario de catorcenas: ' + error.message);
        setCalendario((data as CatConAnio[]) || []);
      });
    return () => {
      vivo = false;
    };
  }, []);

  /** Años del calendario que tienen la catorcena escrita. */
  const aniosDeCat = (calendario || [])
    .filter((c) => Number(c.numero) === Number(catorcena))
    .map((c) => Number(c.anio));

  /**
   * ¿Las fechas del archivo caen lejos de la catorcena elegida? Pasa si se
   * importa la Cat-1 de un año cuyo calendario todavía no está cargado: el
   * único año disponible sería el anterior y se REEMPLAZARÍA su pauta
   * (revisión, 14-oct-2026). El archivo de pauta trae fijaciones de la
   * catorcena previa, así que se tolera un desfase de hasta ~2 meses.
   */
  const fueraDeFechas = (() => {
    const elegida = (calendario || []).find(
      (c) => Number(c.numero) === Number(catorcena) && Number(c.anio) === Number(anio)
    );
    if (!elegida?.fecha_inicio || !fechaRef) return null;
    const dias = Math.abs(Date.parse(elegida.fecha_inicio) - Date.parse(fechaRef)) / 86400000;
    return dias > 60 ? elegida.fecha_inicio : null;
  })();

  // Propone el año cuando cambian la catorcena, el archivo o el calendario.
  useEffect(() => {
    if (!calendario || !catorcena) return;
    const propuesto = anioMasCercano(calendario, Number(catorcena), fechaRef);
    setAnio(propuesto != null ? String(propuesto) : '');
  }, [calendario, catorcena, fechaRef]);

  const abrirArchivo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr('');
    setAnalisis(null);
    setResultado(null);
    setLeyendo(true);
    try {
      const buf = await f.arrayBuffer();
      // cellDates: sin esto las fechas llegan como número serial de Excel.
      const XLSX = await cargarXlsx();
      xlsx.current = XLSX;
      const wb = XLSX.read(buf, { cellDates: true });
      setLibro(wb);
      setHojas(wb.SheetNames);
      // La hoja de la catorcena empieza con "CAT"; el resto son auxiliares.
      const sugerida =
        wb.SheetNames.find((n) => /^CAT\s*\d/i.test(n.trim())) ||
        wb.SheetNames[0];
      setHojaSel(sugerida);
      analizar(wb, sugerida);
    } catch (ex) {
      // Si lo que no llegó fue la librería (sin señal, o un despliegue nuevo
      // borró su chunk), el archivo está bien: decirlo, y en español
      // (revisión primer mes, 24-sep-2026).
      setErr(
        esErrorDeChunk(ex)
          ? 'No se pudo descargar el lector de Excel. Revisa tu señal e inténtalo de nuevo (si sigue fallando, recarga la app).'
          : 'No se pudo leer el archivo: ' + (ex as Error).message
      );
    }
    setLeyendo(false);
    e.target.value = '';
  };

  const analizar = (wb: WorkBook, hoja: string) => {
    // Siempre hay librería aquí: solo se analiza un libro ya leído con ella.
    const XLSX = xlsx.current;
    if (!XLSX) return;
    setErr('');
    setResultado(null);
    const ws = wb.Sheets[hoja];
    if (!ws) {
      setErr('La hoja no existe en el archivo.');
      return;
    }
    const crudas = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
      defval: null,
    });
    if (crudas.length === 0) {
      setErr('La hoja está vacía.');
      setAnalisis(null);
      return;
    }

    const cols = Object.keys(crudas[0]);
    const faltantes = OBLIGATORIAS.filter((c) => !cols.includes(c));

    // Las columnas de campaña traen la catorcena en el nombre y cambian cada
    // periodo: se detectan por patrón, no por texto exacto.
    const campCols = cols
      .map((c) => {
        const m = c.match(/Campaign\s+Version\s+CAT\s*(\d+)/i);
        return m ? { col: c, num: Number(m[1]) } : null;
      })
      .filter(Boolean) as { col: string; num: number }[];
    // La más reciente primero (en el cambio de año, la de número chico).
    campCols.sort((a, b) => (esMasReciente(a.num, b.num) ? -1 : esMasReciente(b.num, a.num) ? 1 : 0));
    const colCampana = campCols[0]?.col || null;
    const colCampanaAnterior = campCols[1]?.col || null;

    // La catorcena sale del nombre de la columna; si no, del nombre de la hoja.
    const deHoja = hoja.match(/CAT\s*(\d+)/i);
    const cat = campCols[0]?.num ?? (deHoja ? Number(deHoja[1]) : null);

    const filas: FilaPauta[] = crudas
      .filter((r) => txt(r['Vendor Face ID']) && txt(r['CLAVE SITIO']))
      .map((r) => ({
        site_id: txt(r['CLAVE SITIO']),
        vendor_face_id: txt(r['Vendor Face ID']),
        clave: txt(r['CLAVE']),
        cara: txt(r['CARA']),
        direccion: txt(r['DIRECCIÓN']),
        id_estado: txt(r['ID ESTADO']),
        estado: txt(r['ESTADO']),
        id_medio: txt(r['ID MEDIO']),
        medio: txt(r['MEDIO']),
        ruta_clave: txt(r['RUTA']),
        secuencia: txt(r['SECUENCIA']),
        contract_number: txt(r['Contract Number']),
        orden_fijacion: txt(r['ORDEN DE FIJACIÓN']),
        campana: colCampana ? txt(r[colCampana]) : null,
        version: txt(r['VERSIÓN']),
        campana_anterior: colCampanaAnterior
          ? txt(r[colCampanaAnterior])
          : null,
        estatus: txt(r['ESTATUS']),
        corte: txt(r['CORTE']),
        sales_person: txt(r['Sales Person']),
        espec_fijacion: txt(r['ESPEC FIJACIÓN']),
        espec_toma: txt(r['ESPEC TOMA']),
        fecha_fijacion: aFecha(r['FECHA DE FIJACIÓN']),
        fecha_toma: aFecha(r['FECHA DE TOMA']),
        fecha_comprobacion: aFecha(r['FECHA COMPROBACIÓN']),
        fecha_modificacion: aFecha(r['FECHA MODIFICACIÓN']),
        observaciones_campo: txt(r['OBSERVACIONES CAMPO']),
        observaciones_analista: txt(r['OBSERVACIONES ANALISTA']),
        detalle_observaciones: txt(r['DETALLE OBSERVACIONES ANALISTA']),
        comentarios: txt(r['COMENTARIOS']),
      }));

    const rutas = [
      ...new Set(filas.map((f) => f.ruta_clave).filter(Boolean)),
    ] as string[];

    // La fecha de fijación del medio (la mediana) ubica el año.
    const fechas = filas
      .map((f) => f.fecha_fijacion)
      .filter((x): x is string => !!x)
      .sort();
    setFechaRef(fechas.length ? fechas[Math.floor(fechas.length / 2)] : null);

    setAnalisis({
      hoja,
      catorcena: cat,
      etiqueta: hoja.trim(),
      filas,
      colCampana,
      colCampanaAnterior,
      campanas: new Set(filas.map((f) => f.campana).filter(Boolean)).size,
      sitios: new Set(filas.map((f) => f.site_id)).size,
      rutas: rutas.sort(),
      foraneas: filas.filter((f) => !/^\d+$/.test(f.ruta_clave || '')).length,
      faltantes,
    });
    if (cat != null) setCatorcena(String(cat));
  };

  const importar = async () => {
    if (!analisis) return;
    const cat = Number(catorcena);
    if (!cat || cat < 1) {
      setErr('Indica el número de catorcena.');
      return;
    }
    const an = Number(anio);
    if (!an || !aniosDeCat.includes(an)) {
      setErr(`La Cat-${cat} no está en el calendario${an ? ` de ${an}` : ''}. Revisa el número y el año.`);
      return;
    }
    if (fueraDeFechas) {
      setErr(
        `Las fechas del archivo (alrededor del ${fechaRef}) no corresponden a la ` +
          `${etiquetaCatorcena(cat, an)}, que empieza el ${fueraDeFechas}. ` +
          `Revisa el número y el año; si es de un año nuevo, primero hay que cargar ese año en el calendario.`
      );
      return;
    }

    // QTM rige la clave de sitio de cada cara. Sin el inventario no se
    // importa: con la del archivo "Sincronizar rutas" podría crear paradas
    // fantasma.
    setImportando(true);
    setErr('');
    let sitios: ResultadoSitios<FilaPauta>;
    try {
      sitios = sitiosDesdeInventario(analisis.filas, await sitiosDeInventario(carasDe(analisis.filas)));
    } catch (ex) {
      setImportando(false);
      setErr('No se pudo consultar el inventario (QTM) para revisar las claves de sitio: ' + (ex as Error).message);
      return;
    }
    const nCorr = sitios.corregidas.length;
    const nSin = sitios.sinInventario.length;

    if (
      !confirm(
        `Se va a REEMPLAZAR toda la pauta de la ${etiquetaCatorcena(cat, an)}.\n\n` +
          `Se cargarán ${analisis.filas.length} filas.\n` +
          (nCorr > 0
            ? `${nCorr} ${nCorr === 1 ? 'cara trae' : 'caras traen'} una clave de sitio distinta a la del inventario (QTM): se usará la de QTM.\n`
            : '') +
          (nSin > 0
            ? `${nSin} ${nSin === 1 ? 'cara no está' : 'caras no están'} en el inventario: se deja la clave de sitio del archivo.\n`
            : '') +
          `El avance de campo ya registrado (tomas y comprobaciones) se conserva.\n\n` +
          '¿Continuar?'
      )
    ) {
      setImportando(false);
      return;
    }

    const { data, error } = await sb.rpc('importar_pauta', {
      p_catorcena: cat,
      p_etiqueta: analisis.etiqueta,
      p_filas: sitios.filas,
      p_anio: an,
    });
    setImportando(false);
    if (error) {
      setErr('No se pudo importar: ' + error.message);
      return;
    }
    setAjuste({ corregidas: sitios.corregidas, sinInventario: sitios.sinInventario });
    setResultado(data as Resultado);
    onImportado();
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        // Con la RPC corriendo NO se cierra: un roce en la franja lateral
        // del overlay dejaba la importación a ciegas — la catorcena SÍ se
        // reemplazaba en el servidor pero el usuario nunca veía el resultado.
        if ((e.target as HTMLElement).className === 'overlay' && !importando)
          onClose();
      }}
    >
      <div className="modal">
        <CerrarModal onClick={onClose} disabled={importando} />
        <h2 style={{ margin: '0 0 3px' }}>Importar pauta</h2>
        <p className="phint">
          Carga la catorcena desde el Excel. Reemplaza la pauta de ese periodo.
        </p>

        {err && <div className="err">{err}</div>}

        <div className="field">
          <label>Archivo de pauta (.xlsx)</label>
          <input
            type="file"
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            onChange={abrirArchivo}
            disabled={leyendo || importando}
          />
          {leyendo && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Leyendo…
            </div>
          )}
        </div>

        {libro && hojas.length > 0 && (
          <div className="field">
            <label>Hoja de la catorcena</label>
            <select
              value={hojaSel}
              onChange={(e) => {
                setHojaSel(e.target.value);
                analizar(libro, e.target.value);
              }}
              disabled={importando}
            >
              {hojas.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              El nombre cambia cada periodo; verifica que sea la correcta.
            </div>
          </div>
        )}

        {analisis && (
          <>
            {analisis.faltantes.length > 0 && (
              <div className="err">
                A esta hoja le faltan columnas obligatorias:{' '}
                <b>{analisis.faltantes.join(', ')}</b>. ¿Es la hoja correcta?
              </div>
            )}

            <div className="row2">
              <div className="field">
                <label>Catorcena</label>
                <input
                  type="number"
                  value={catorcena}
                  onChange={(e) => setCatorcena(e.target.value)}
                  disabled={importando}
                />
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  {analisis.catorcena != null
                    ? `Detectada del archivo. Corrígela si no es la correcta.`
                    : 'No se pudo detectar: escríbela a mano.'}
                </div>
              </div>
              <div className="field">
                <label>Año</label>
                <select
                  value={anio}
                  onChange={(e) => setAnio(e.target.value)}
                  disabled={importando || aniosDeCat.length === 0}
                >
                  {aniosDeCat.length === 0 && <option value="">—</option>}
                  {aniosDeCat.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  {calendario == null ? (
                    'Leyendo el calendario…'
                  ) : aniosDeCat.length === 0 ? (
                    'Esa catorcena no está en el calendario.'
                  ) : fueraDeFechas ? (
                    <span style={{ color: 'var(--warn)' }}>
                      ⚠ Las fechas del archivo no corresponden a esta catorcena (empieza el {fueraDeFechas}).
                    </span>
                  ) : (
                    'El archivo no trae el año: se propone el más cercano a sus fechas.'
                  )}
                </div>
              </div>
            </div>

            <div
              style={{
                background: 'var(--panel2)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '11px 12px',
                marginBottom: 14,
                fontSize: 13,
                lineHeight: 1.7,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
                <Ic i={Search} />Lo que se detectó
              </div>
              <div style={{ color: 'var(--muted)' }}>
                <b style={{ color: 'var(--txt)' }}>{analisis.filas.length}</b>{' '}
                filas · <b style={{ color: 'var(--txt)' }}>{analisis.sitios}</b>{' '}
                sitios ·{' '}
                <b style={{ color: 'var(--txt)' }}>{analisis.campanas}</b>{' '}
                campañas
                <br />
                Campaña actual:{' '}
                <b style={{ color: 'var(--txt)' }}>
                  {analisis.colCampana || '⚠ no detectada'}
                </b>
                <br />
                Campaña anterior:{' '}
                <b style={{ color: 'var(--txt)' }}>
                  {analisis.colCampanaAnterior || '— sin comparativo'}
                </b>
                <br />
                Rutas: {analisis.rutas.join(', ') || '—'}
                {analisis.foraneas > 0 && (
                  <>
                    <br />
                    <span style={{ color: 'var(--warn)' }}>
                      {analisis.foraneas} filas de plazas foráneas — se cargan
                      sin ruta de recorrido.
                    </span>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {resultado && (
          <div className="ok-msg" style={{ lineHeight: 1.7 }}>
            <b>
              Importación completa
              {resultado.anio ? ` · ${etiquetaCatorcena(catorcena, resultado.anio)}` : ''}.
            </b>
            <br />
            {resultado.insertadas} filas cargadas · {resultado.borradas}{' '}
            reemplazadas · {resultado.sitios} sitios · {resultado.campanas}{' '}
            campañas
            {resultado.duplicadas_omitidas > 0 && (
              <>
                <br />
                {resultado.duplicadas_omitidas} filas duplicadas del archivo se
                omitieron.
              </>
            )}
            <br />
            <b>{resultado.avance_conservado}</b> registros de avance de campo se
            conservaron.
            {resultado.sin_coordenadas > 0 && (
              <>
                <br />
                <span style={{ color: 'var(--warn)' }}>
                  ⚠ {resultado.sin_coordenadas} caras sin coordenadas en
                  inventario: no se podrá navegar hacia ellas.
                </span>
              </>
            )}
            {ajuste && ajuste.corregidas.length > 0 && (
              <>
                <br />
                <span style={{ color: 'var(--warn)' }}>
                  ⚠ {ajuste.corregidas.length}{' '}
                  {ajuste.corregidas.length === 1 ? 'cara traía' : 'caras traían'} otra
                  clave de sitio en el archivo; se usó la del inventario (QTM):
                </span>
                <ul style={{ margin: '2px 0 0', paddingLeft: 18, fontSize: 12 }}>
                  {ajuste.corregidas.map((c) => (
                    <li key={c.vendor_face_id} style={{ overflowWrap: 'anywhere' }}>
                      {c.vendor_face_id}: {c.archivo || '—'} → <b>{c.inventario}</b>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {ajuste && ajuste.sinInventario.length > 0 && (
              <details style={{ marginTop: 2 }}>
                <summary style={{ cursor: 'pointer' }}>
                  {ajuste.sinInventario.length}{' '}
                  {ajuste.sinInventario.length === 1 ? 'cara no está' : 'caras no están'} en el
                  inventario: se dejó la clave de sitio del archivo.
                </summary>
                <div style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                  {ajuste.sinInventario.join(', ')}
                </div>
              </details>
            )}
          </div>
        )}

        <div className="modal-actions pie-fijo">
          <button className="btn ghost" onClick={onClose} disabled={importando}>
            {resultado ? 'Cerrar' : 'Cancelar'}
          </button>
          {!resultado && (
            <button
              className="btn"
              onClick={importar}
              disabled={
                importando ||
                !analisis ||
                analisis.filas.length === 0 ||
                analisis.faltantes.length > 0 ||
                !anio ||
                !!fueraDeFechas
              }
            >
              {importando
                ? 'Importando…'
                : `Importar ${analisis?.filas.length || 0} filas`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ImportarPautaModal;
