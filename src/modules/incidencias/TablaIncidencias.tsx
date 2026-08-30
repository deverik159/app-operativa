// ============================================================
// src/modules/incidencias/TablaIncidencias.tsx
// La vista de tabla: toda la trazabilidad en un solo barrido.
//
// DE DÓNDE SALE: pliego petitorio (ago-2026) — "la base de datos que se
// muestra en la otra App... poder entrar y ver toda la trazabilidad de todos
// los reportes... fue de lo que más le gustó a todas las áreas".
//
// Es una VISTA de las mismas filas que ya pasaron por los filtros de
// IncidenciasView — no consulta nada por su cuenta. Eso garantiza que la
// tabla, las tarjetas y el contador digan siempre lo mismo, y que la RLS ya
// haya decidido qué puede ver quien mira.
//
// EL EXPORT es solo para coordinador (y manager, que es comodín en toda la
// app). Decisión de Erik, ago-2026. Vale ser honestos sobre qué protege:
// esconder el botón evita el uso casual — el CSV masivo circulando por
// WhatsApp — pero no es un candado criptográfico: quien ya puede VER los
// datos podría copiarlos a mano. El control real de qué ve cada quien sigue
// siendo la RLS; esto controla qué tan fácil es llevárselo en bloque.
// ============================================================
import { EST_COLOR, EST_LABEL } from '../../lib/constants';
import {
  caraLabel,
  horasEnProceso,
  horasValidacionReparacion,
  fmtHoras,
} from '../../lib/helpers';
import type { Incidencia } from '../../types/db';

type Props = {
  /** Las filas YA filtradas por IncidenciasView. */
  items: Incidencia[];
  /** true = coordinador o manager: se le ofrece el export. */
  puedeExportar: boolean;
};

function fecha(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  });
}

/**
 * Celda a texto CSV. Comillas dobladas y todo entre comillas: una
 * observación con coma, salto de línea o comillas rompería las columnas
 * de medio archivo sin avisar.
 */
function csv(v: unknown): string {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function exportar(items: Incidencia[]) {
  const cab = [
    'folio', 'estatus', 'unidad_negocio', 'incidencia', 'nivel', 'tipo',
    'origen', 'area_responsable', 'area_que_repara', 'clave_sitio', 'cara',
    'lado', 'direccion', 'municipio', 'plaza', 'campania', 'observaciones',
    'capturada_por', 'fecha_reporte', 'validada_por', 'fecha_validacion',
    'reparada_por', 'fecha_reparacion', 'diagnostico', 'causa_raiz',
    'solucion', 'detalle_reparacion', 'horas_validacion_a_reparacion',
    'horas_en_proceso_ahora',
  ];
  const filas = items.map((i) =>
    [
      i.folio, EST_LABEL[i.estatus] || i.estatus, i.unidad_negocio,
      i.nombre_incidencia, i.nivel, i.tipo, i.origen, i.area_responsable,
      i.assigned_area || i.area_responsable, i.clave_sitio,
      caraLabel(i.clave_medio), i.lado, i.direccion, i.municipio, i.plaza,
      i.campania, i.observaciones, i.captured_by, i.fecha_reporte,
      i.validator_email, i.validator_at, i.repaired_by_email, i.repaired_at,
      i.diagnostico, i.causa_raiz, i.solucion, i.detalle_reparacion,
      horasValidacionReparacion(i)?.toFixed(1) ?? '',
      horasEnProceso(i)?.toFixed(1) ?? '',
    ]
      .map(csv)
      .join(',')
  );
  // El BOM al frente es lo que hace que Excel en español abra el archivo con
  // acentos correctos y separado en columnas. Sin él, "Fijación" llega como
  // "FijaciÃ³n" y todo cae en la columna A.
  const blob = new Blob(['﻿' + [cab.join(','), ...filas].join('\r\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `incidencias_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  // NO revocar en seguida: Safari (iPhone/iPad/Mac) resuelve la descarga
  // de forma asíncrona y revocar el blob al instante podía abortarla — el
  // usuario tocaba Exportar y no pasaba nada.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function TablaIncidencias({ items, puedeExportar }: Props) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          marginBottom: 10,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {items.length} incidencia{items.length === 1 ? '' : 's'} — las mismas
          que dejan pasar los filtros de arriba.
        </span>
        {puedeExportar && (
          <button
            className="btn ghost sm"
            onClick={() => exportar(items)}
            title="Descarga lo filtrado como CSV (abre en Excel)"
          >
            ⬇️ Exportar ({items.length})
          </button>
        )}
      </div>

      {/* La tabla scrollea DENTRO de su contenedor. En celular esto es lo que
          evita que toda la página se mueva de lado: el dedo arrastra la
          tabla, no la app.
          maxHeight: sin él, el scroll vertical era el de la página y el
          `position:sticky` de los encabezados no tenía contra qué pegarse —
          en 13 columnas se perdía la referencia de cuál era cuál. */}
      <div
        style={{
          overflowX: 'auto',
          maxHeight: '75vh',
          border: '1px solid var(--line)',
          borderRadius: 12,
          background: 'var(--panel)',
        }}
      >
        <table
          style={{
            borderCollapse: 'collapse',
            width: '100%',
            minWidth: 980,
            fontSize: 12,
          }}
        >
          <thead>
            <tr>
              {[
                'Folio', 'Estatus', 'Unidad', 'Incidencia', 'Cara', 'Sitio',
                'Municipio', 'Repara', 'Nivel', 'Capturada', 'Por',
                '⏳ En proceso', 'Reparó',
              ].map((h) => (
                <th
                  key={h}
                  style={{
                    position: 'sticky',
                    top: 0,
                    background: 'var(--panel2)',
                    textAlign: 'left',
                    padding: '9px 10px',
                    borderBottom: '1px solid var(--line)',
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '.04em',
                    color: 'var(--muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const enProc = horasEnProceso(i);
              return (
                <tr key={i.record_id}>
                  <td style={celda}>
                    <b>{i.folio || i.record_id}</b>
                  </td>
                  <td style={celda}>
                    <span
                      className="pill"
                      style={{
                        background: (EST_COLOR[i.estatus] || '#666') + '22',
                        color: EST_COLOR[i.estatus] || '#aaa',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {EST_LABEL[i.estatus] || i.estatus}
                    </span>
                  </td>
                  <td style={celda}>{i.unidad_negocio}</td>
                  <td style={{ ...celda, minWidth: 180 }}>
                    {i.nombre_incidencia}
                  </td>
                  <td style={celda}>{caraLabel(i.clave_medio)}</td>
                  <td style={celda}>{i.clave_sitio}</td>
                  <td style={celda}>{i.municipio || '—'}</td>
                  <td style={celda}>
                    {i.assigned_area || i.area_responsable || '—'}
                  </td>
                  <td style={celda}>{i.nivel || '—'}</td>
                  <td style={{ ...celda, whiteSpace: 'nowrap' }}>
                    {fecha(i.fecha_reporte)}
                  </td>
                  <td style={celda}>
                    {(i.captured_by || '—').split('@')[0]}
                  </td>
                  <td
                    style={{
                      ...celda,
                      whiteSpace: 'nowrap',
                      color:
                        enProc != null && enProc > 72
                          ? 'var(--hi)'
                          : undefined,
                      fontWeight: enProc != null && enProc > 72 ? 700 : 400,
                    }}
                  >
                    {enProc != null ? fmtHoras(enProc) : '—'}
                  </td>
                  <td style={celda}>
                    {(i.repaired_by_email || '—').split('@')[0]}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const celda: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid var(--line)',
  verticalAlign: 'top',
};

export default TablaIncidencias;
