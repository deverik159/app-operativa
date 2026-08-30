// ============================================================
// src/modules/pauta/ImportarPautaModal.tsx
// Importa una catorcena desde el Excel de pauta.
//
// Dos cosas cambian en cada archivo y por eso NO se pueden dar por fijas:
//
//   1. El nombre de la hoja: 'CAT 16(15) 21JUL-03AGO'. Se ofrece un selector
//      con las hojas del libro y se preselecciona la que empiece con CAT.
//   2. El nombre de las columnas de campaña: 'Campaign Version CAT 16 (15)'
//      lleva el número de catorcena dentro. Se detectan por patrón y la de
//      número mayor es la campaña actual; la menor, la anterior.
//
// Antes de mandar nada se muestra una vista previa con lo que se detectó.
// Importar reemplaza la catorcena completa: conviene ver qué se va a cargar.
// ============================================================
import { useState } from 'react';
import * as XLSX from 'xlsx';
import { sb } from '../../lib/supabase';

/** Fila ya normalizada, lista para la RPC. */
type FilaPauta = Record<string, string | null>;

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

/** Columnas que deben existir sí o sí. */
const OBLIGATORIAS = ['CLAVE SITIO', 'Vendor Face ID'];

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
  const [libro, setLibro] = useState<XLSX.WorkBook | null>(null);
  const [hojas, setHojas] = useState<string[]>([]);
  const [hojaSel, setHojaSel] = useState('');
  const [analisis, setAnalisis] = useState<Analisis | null>(null);
  const [catorcena, setCatorcena] = useState('');
  const [err, setErr] = useState('');
  const [leyendo, setLeyendo] = useState(false);
  const [importando, setImportando] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);

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
      setErr('No se pudo leer el archivo: ' + (ex as Error).message);
    }
    setLeyendo(false);
    e.target.value = '';
  };

  const analizar = (wb: XLSX.WorkBook, hoja: string) => {
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
    campCols.sort((a, b) => b.num - a.num);
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
    if (
      !confirm(
        `Se va a REEMPLAZAR toda la pauta de la catorcena ${cat}.\n\n` +
          `Se cargarán ${analisis.filas.length} filas.\n` +
          `El avance de campo ya registrado (tomas y comprobaciones) se conserva.\n\n` +
          '¿Continuar?'
      )
    )
      return;

    setImportando(true);
    setErr('');
    const { data, error } = await sb.rpc('importar_pauta', {
      p_catorcena: cat,
      p_etiqueta: analisis.etiqueta,
      p_filas: analisis.filas,
    });
    setImportando(false);
    if (error) {
      setErr('No se pudo importar: ' + error.message);
      return;
    }
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
                🔎 Lo que se detectó
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
            <b>Importación completa.</b>
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
          </div>
        )}

        <div className="modal-actions">
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
                analisis.faltantes.length > 0
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
