// ============================================================
// src/modules/rutas/ImportarRutasExcelModal.tsx
// Importa las rutas desde el Excel de operación (una clave, un responsable).
//
// ESTO REEMPLAZA AL KML PARA BIOBOX, y la diferencia es de fondo.
//
// El mapa identificaba cada máquina por un nombre escrito a mano en My Maps,
// así que había que empatarlo con inventario a fuerza de heurísticas: número
// después del guion, parecido de nombre, cercanía. Funcionaba, pero cualquier
// nombre mal escrito abría la puerta a un empate equivocado — y un empate
// equivocado manda al monitorista a otra colonia.
//
// El Excel de operación trae `NOMECLATURA A QUANTUM`, que ES la clave
// (`MX_CM_BB_MED_0001`). No hay nada que adivinar: o la clave existe en
// inventario o no existe. Por eso aquí no hay vista previa de empates, solo
// una lista de las que no existen —que es un problema de alta de inventario,
// no de importación—.
//
// La ruta sale de la columna RESPONSABLE, que es quien la recorre.
//
// Reusa `importar_rutas_capas`: cada responsable se manda como una "capa".
// La función ya sabe crear la ruta si no existe, conservar su número y color
// si ya existía, y mandar cada máquina al segmento que le toca según su tipo
// de medio en inventario.
// ============================================================
import { useState } from 'react';
import * as XLSX from 'xlsx';
import { sb } from '../../lib/supabase';
import { UNIDADES } from '../../lib/constants';

type Props = {
  onClose: () => void;
  onImportado: (resumen: string) => void;
};

type Fila = { site_id: string; responsable: string };

type Resultado = {
  rutas_creadas: number;
  rutas_usadas: number;
  ubicaciones: number;
  movidas_de_ruta: number;
  omitidas: number;
  omitidos_ejemplo: string[];
  sobrantes: number;
  sobrantes_borradas: boolean;
};

/** Encabezado comparable: sin acentos, sin signos, en mayúsculas. */
function norm(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Forma de una clave: MX_CM_BB_MED_0001. */
const RE_CLAVE = /^[A-Z]{2}_[A-Z]{2}_[A-Z]{2,3}_[A-Z]{3}_\d{3,5}$/;

function ImportarRutasExcelModal({ onClose, onImportado }: Props) {
  // Misma lección que en el KML: la unidad se elige, no se hereda.
  const [unidad, setUnidad] = useState('');
  const [leyendo, setLeyendo] = useState(false);
  const [importando, setImportando] = useState(false);
  const [err, setErr] = useState('');
  const [filas, setFilas] = useState<Fila[] | null>(null);
  /**
   * Clave del Excel → `site_id` real de inventario. No siempre son la misma
   * cadena: ver la nota larga en la consulta de inventario.
   */
  const [existen, setExisten] = useState<Map<string, string>>(new Map());
  const [avisos, setAvisos] = useState<string[]>([]);
  const [quitarFaltantes, setQuitarFaltantes] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  const onArchivo = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0];
    ev.target.value = '';
    if (!f) return;
    if (!unidad) {
      setErr('Primero elige a qué unidad de negocio pertenece este archivo.');
      return;
    }

    setErr('');
    setAvisos([]);
    setFilas(null);
    setResultado(null);
    setLeyendo(true);

    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });

      // La hoja buena es la que tenga columnas de clave y de responsable. Se
      // busca en todas en vez de asumir la primera: el archivo que devuelve
      // operación trae también hojas de instrucciones y de correcciones.
      let encontradas: Fila[] = [];
      let hojaUsada = '';
      const problemas: string[] = [];

      for (const nombreHoja of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
          wb.Sheets[nombreHoja],
          { defval: null }
        );
        if (!rows.length) continue;

        const cols = Object.keys(rows[0]);
        const colClave = cols.find((c) => norm(c).includes('NOMECLATURA'));
        // "RESPONSABLE FINAL" gana sobre "RESPONSABLE (actual)": la primera
        // es la que operación llenó, la segunda es lo que ya traía.
        const colResp =
          cols.find((c) => norm(c).includes('RESPONSABLE FINAL')) ||
          cols.find((c) => norm(c).startsWith('RESPONSABLE'));
        if (!colClave || !colResp) continue;

        const acc: Fila[] = [];
        rows.forEach((r, i) => {
          const clave = String(r[colClave] ?? '').trim().toUpperCase();
          const resp = String(r[colResp] ?? '').trim().toUpperCase();
          if (!clave && !resp) return;
          if (!clave) {
            problemas.push(`Fila ${i + 2}: sin clave.`);
            return;
          }
          if (!RE_CLAVE.test(clave)) {
            problemas.push(`Fila ${i + 2}: "${clave}" no tiene forma de clave.`);
            return;
          }
          if (!resp) {
            problemas.push(`${clave}: sin responsable, se omite.`);
            return;
          }
          acc.push({ site_id: clave, responsable: resp });
        });

        if (acc.length > encontradas.length) {
          encontradas = acc;
          hojaUsada = nombreHoja;
        }
      }

      if (!encontradas.length) {
        setErr(
          'No encontré columnas de clave y responsable. El archivo debe traer ' +
            'una hoja con "NOMECLATURA A QUANTUM" y "RESPONSABLE".'
        );
        setLeyendo(false);
        return;
      }

      // Una máquina en dos rutas: se queda la primera y se avisa.
      const vistas = new Set<string>();
      const unicas: Fila[] = [];
      encontradas.forEach((x) => {
        if (vistas.has(x.site_id)) {
          problemas.push(`${x.site_id} aparece más de una vez; se toma la primera.`);
          return;
        }
        vistas.add(x.site_id);
        unicas.push(x);
      });

      // ¿Cuáles existen en inventario, y con qué site_id?
      //
      // AQUÍ ESTÁ LA SUTILEZA QUE COSTÓ UNA MIGRACIÓN FALLIDA. `inventario`
      // guarda DOS claves por máquina y no siempre son iguales:
      //
      //   vendor_face_id = MX_CM_BB_MEC_0200   ← con el segmento de 3 letras
      //   site_id        = MX_CM_BB_0200       ← sin él
      //
      // El Excel de operación usa la forma larga, la del `vendor_face_id`.
      // Buscar solo por `site_id` dejaba fuera 11 máquinas que sí existían;
      // parecían faltantes y estuvimos a punto de renombrarlas en la base.
      //
      // Se busca por las DOS columnas, y lo que se manda a la ruta es el
      // `site_id`, que es lo que `ruta_ubicaciones` guarda y lo que el
      // trigger de segmento valida.
      const aSiteId = new Map<string, string>();
      const claves = unicas.map((x) => x.site_id);
      for (let i = 0; i < claves.length; i += 100) {
        const lote = claves.slice(i, i + 100);
        // Dos consultas en vez de un `.or(...)`: con 100 claves la condición
        // combinada arma una URL enorme y PostgREST la rechaza.
        const [porSite, porFace] = await Promise.all([
          sb
            .from('inventario')
            .select('site_id,vendor_face_id')
            .eq('unidad_negocio', unidad)
            .in('site_id', lote),
          sb
            .from('inventario')
            .select('site_id,vendor_face_id')
            .eq('unidad_negocio', unidad)
            .in('vendor_face_id', lote),
        ]);
        const errQ = porSite.error || porFace.error;
        if (errQ) {
          setErr('No se pudo consultar el inventario: ' + errQ.message);
          setLeyendo(false);
          return;
        }
        type Inv = { site_id: string | null; vendor_face_id: string };
        [
          ...((porSite.data as Inv[]) || []),
          ...((porFace.data as Inv[]) || []),
        ].forEach((r) => {
          if (!r.site_id) return;
          // La clave del Excel pudo empatar por cualquiera de las dos; se
          // registran ambas apuntando al mismo site_id.
          if (r.site_id) aSiteId.set(r.site_id, r.site_id);
          if (r.vendor_face_id) aSiteId.set(r.vendor_face_id, r.site_id);
        });
      }

      // Solo se conservan las claves que el archivo pidió.
      const resueltas = new Map<string, string>();
      claves.forEach((c) => {
        const sid = aSiteId.get(c);
        if (sid) resueltas.set(c, sid);
      });
      const distintas = [...resueltas.entries()].filter(([c, sid]) => c !== sid);
      if (distintas.length) {
        problemas.push(
          `${distintas.length} clave(s) empataron por vendor_face_id y entran ` +
            'con su site_id de inventario.'
        );
      }

      setFilas(unicas);
      setExisten(resueltas);
      setAvisos(problemas);
      if (hojaUsada) {
        setAvisos((p) => [`Se leyó la hoja "${hojaUsada}".`, ...p]);
      }
    } catch (e) {
      setErr('No se pudo leer el archivo: ' + (e as Error).message);
    }
    setLeyendo(false);
  };

  const importables = (filas || []).filter((f) => existen.has(f.site_id));
  const faltantes = (filas || []).filter((f) => !existen.has(f.site_id));

  const porRuta = new Map<string, Fila[]>();
  importables.forEach((f) => {
    porRuta.set(f.responsable, [...(porRuta.get(f.responsable) || []), f]);
  });

  const importar = async () => {
    if (!importables.length) return;
    setImportando(true);
    setErr('');

    // Sin secuencia: el Excel no lleva orden de recorrido. La lista de campo
    // se ordena por urgencia de todos modos, y el orden geográfico se puede
    // calcular después con las coordenadas de inventario.
    const capas = [...porRuta.entries()].map(([resp, fs]) => ({
      nombre: `Ruta ${resp.charAt(0) + resp.slice(1).toLowerCase()}`,
      // OJO: va el site_id RESUELTO contra inventario, no la clave tal
      // como venía en el Excel. Ver la nota de la consulta de inventario.
      paradas: fs.map((f, i) => ({
        site_id: existen.get(f.site_id) as string,
        secuencia: i + 1,
      })),
    }));

    // Las que el archivo trae pero no se pudieron importar NO deben salir de
    // su ruta si alguien pide la limpieza: estaban en el archivo.
    const conservar = faltantes.map((f) => f.site_id);

    const { data, error } = await sb.rpc('importar_rutas_capas', {
      p_unidad: unidad,
      p_capas: capas,
      p_quitar_faltantes: quitarFaltantes,
      p_conservar: conservar,
    });
    setImportando(false);

    if (error) {
      setErr('No se pudo importar: ' + error.message);
      return;
    }
    const r = data as Resultado;
    setResultado(r);
    onImportado(
      `${r.ubicaciones} máquinas en ${r.rutas_usadas} rutas ` +
        `(${r.rutas_creadas} nuevas)` +
        (r.movidas_de_ruta ? `, ${r.movidas_de_ruta} cambiaron de ruta` : '') +
        (r.omitidas ? `, ${r.omitidas} omitidas` : '') +
        '.'
    );
  };

  // --- Resultado ---
  if (resultado) {
    return (
      <div className="overlay">
        <div className="modal">
          <h2 style={{ margin: '0 0 3px' }}>Importación lista</h2>
          <p className="phint">{unidad}</p>

          <div style={{ display: 'grid', gap: 8, margin: '14px 0' }}>
            {[
              ['Máquinas asignadas a ruta', resultado.ubicaciones],
              ['Rutas usadas', resultado.rutas_usadas],
              ['De ésas, nuevas', resultado.rutas_creadas],
              ['Cambiaron de ruta', resultado.movidas_de_ruta],
              ['Omitidas', resultado.omitidas],
            ].map(([t, n]) => (
              <div
                key={t as string}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}
              >
                <span style={{ fontSize: 13, color: 'var(--muted)', minWidth: 0 }}>
                  {t}
                </span>
                <b>{n}</b>
              </div>
            ))}
          </div>

          {resultado.sobrantes > 0 && !resultado.sobrantes_borradas && (
            <div className="banner" style={{ marginBottom: 12 }}>
              Hay {resultado.sobrantes} máquinas en rutas de {unidad} que no
              venían en este archivo. Se quedaron donde estaban.
            </div>
          )}

          <div className="modal-actions">
            <button className="btn" onClick={onClose} style={{ width: '100%' }}>
              Cerrar
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay' && !importando)
          onClose();
      }}
    >
      <div className="modal" style={{ maxWidth: 700 }}>
        <h2 style={{ margin: '0 0 3px' }}>Importar rutas desde Excel</h2>
        <p className="phint">
          Una fila por máquina: su clave y quién la recorre. La ruta se arma
          con eso, sin empatar nombres.
        </p>

        {err && <div className="err">{err}</div>}

        {!filas && (
          <>
            <div className="field" style={{ marginTop: 14 }}>
              <label>¿De qué unidad de negocio es este archivo?</label>
              <select
                value={unidad}
                onChange={(e) => {
                  setUnidad(e.target.value);
                  setErr('');
                }}
                disabled={leyendo}
              >
                <option value="">— elige la unidad —</option>
                {UNIDADES.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>

            <div
              style={{
                background: 'var(--panel2)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '11px 12px',
                margin: '14px 0',
                fontSize: 12,
                color: 'var(--muted)',
                lineHeight: 1.7,
              }}
            >
              <div
                style={{
                  fontWeight: 700,
                  fontSize: 12,
                  marginBottom: 6,
                  color: 'var(--txt)',
                }}
              >
                Qué debe traer el archivo
              </div>
              Una hoja con estas dos columnas:
              <br />
              <b>NOMECLATURA A QUANTUM</b> — la clave de la máquina
              (MX_CM_BB_MED_0001).
              <br />
              <b>RESPONSABLE</b> — quién recorre esa máquina. Ese nombre se
              vuelve la ruta.
              <br />
              <br />
              El resto de las columnas y las demás hojas se ignoran.
            </div>

            <label
              className={'btn' + (unidad ? '' : ' ghost')}
              style={{
                display: 'block',
                textAlign: 'center',
                cursor: leyendo || !unidad ? 'default' : 'pointer',
                opacity: unidad ? 1 : 0.5,
              }}
            >
              {leyendo
                ? 'Leyendo…'
                : unidad
                  ? `📄 Elegir archivo para ${unidad}`
                  : '📄 Elige primero la unidad'}
              <input
                type="file"
                accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                style={{ display: 'none' }}
                onChange={onArchivo}
                disabled={leyendo || !unidad}
              />
            </label>
          </>
        )}

        {filas && (
          <>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <span className="tag">{filas.length} filas</span>
              <span
                className="tag"
                style={{ color: 'var(--ok)', borderColor: 'var(--ok)' }}
              >
                {importables.length} en inventario
              </span>
              {faltantes.length > 0 && (
                <span
                  className="tag"
                  style={{ color: 'var(--bad)', borderColor: 'var(--bad)' }}
                >
                  {faltantes.length} sin dar de alta
                </span>
              )}
              <span className="tag">{porRuta.size} rutas</span>
            </div>

            {avisos.length > 0 && (
              <div className="banner" style={{ marginTop: 10 }}>
                {avisos.slice(0, 4).join(' ')}
                {avisos.length > 4 && ` (+${avisos.length - 4} más)`}
              </div>
            )}

            <div
              style={{
                maxHeight: '34vh',
                overflowY: 'auto',
                border: '1px solid var(--line)',
                borderRadius: 10,
                marginTop: 12,
              }}
            >
              {[...porRuta.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([resp, fs]) => (
                  <div
                    key={resp}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '9px 12px',
                      borderBottom: '1px solid var(--line)',
                      fontSize: 13,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>Ruta {resp}</span>
                    <span style={{ color: 'var(--muted)' }}>
                      {fs.length} máquinas
                    </span>
                  </div>
                ))}
            </div>

            {faltantes.length > 0 && (
              <>
                <p className="phint" style={{ marginTop: 12 }}>
                  Estas {faltantes.length} no están en el inventario de{' '}
                  {unidad}, así que no se pueden asignar a una ruta. Hay que
                  darlas de alta primero; la importación sigue sin ellas.
                </p>
                <div
                  style={{
                    maxHeight: '18vh',
                    overflowY: 'auto',
                    border: '1px solid var(--bad)',
                    borderRadius: 10,
                    marginTop: 8,
                  }}
                >
                  {faltantes.map((f) => (
                    <div
                      key={f.site_id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '6px 12px',
                        borderBottom: '1px solid var(--line)',
                        fontSize: 12,
                      }}
                    >
                      <span>{f.site_id}</span>
                      <span style={{ color: 'var(--muted)' }}>{f.responsable}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                marginTop: 12,
                fontSize: 12,
              }}
            >
              <input
                type="checkbox"
                checked={quitarFaltantes}
                onChange={(e) => setQuitarFaltantes(e.target.checked)}
                style={{ width: 'auto', marginTop: 3 }}
              />
              <span>
                Quitar de las rutas las máquinas que no vengan en este archivo.
                <span style={{ color: 'var(--muted)' }}>
                  {' '}
                  Úsalo solo si este archivo es la lista completa de {unidad}.
                </span>
              </span>
            </label>

            <div className="modal-actions" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={onClose} disabled={importando}>
                Cancelar
              </button>
              <button
                className="btn"
                onClick={importar}
                disabled={importando || importables.length === 0}
              >
                {importando
                  ? 'Importando…'
                  : `Importar ${importables.length} máquinas`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default ImportarRutasExcelModal;
