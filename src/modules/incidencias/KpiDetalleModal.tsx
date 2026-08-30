// ============================================================
// src/modules/incidencias/KpiDetalleModal.tsx
// El detrás de un número del panel de indicadores.
//
// EL PROBLEMA QUE RESUELVE: el panel decía "42 abiertas" y ahí se acababa.
// Para saber DÓNDE estaban esas 42 había que irse a Incidencias y reconstruir
// el mismo filtro a mano — y casi nunca queda igual, así que los números de
// las dos pantallas no cuadraban y nadie sabía cuál creer.
//
// Aquí se abre el mismo conjunto que produjo el número. No es una consulta
// nueva: son literalmente las filas que la tarjeta contó, así que no pueden
// discrepar.
//
// DOS CORTES, NO UNO. Al hacer clic se ve por SITIO —que es la pregunta de
// operación: qué ubicaciones están dando lata— y con una pestaña se pasa a
// por INCIDENCIA —la pregunta de mantenimiento: qué se está descomponiendo—.
// Son las dos lecturas del mismo dato y cambiar entre ellas no debería costar
// una pantalla nueva.
// ============================================================
import { useState, useMemo, useEffect } from 'react';
import { EST_COLOR, EST_LABEL } from '../../lib/constants';
import {
  caraLabel,
  horasValidacionReparacion,
  horasEnProceso,
  fmtHoras,
} from '../../lib/helpers';
import type { Incidencia } from '../../types/db';

/** Cuántos grupos se listan antes de cortar. */
const TOPE_GRUPOS = 40;
/** Cuántos folios se muestran dentro de un grupo abierto. */
const TOPE_FOLIOS = 25;

type Corte = 'sitio' | 'incidencia';

type Props = {
  titulo: string;
  /** Contexto: qué filtros estaban puestos cuando se hizo clic. */
  subtitulo?: string;
  items: Incidencia[];
  /** Con cuál de los dos cortes abre. */
  corteInicial?: Corte;
  /**
   * Cómo ordenar.
   *
   * 'cantidad' (por omisión) responde "dónde hay más". Sirve para casi todo.
   *
   * 'tiempo' responde "qué lleva más detenido", que es otra pregunta. Cuando
   * se abre desde "Peor tiempo en proceso", ordenar por cantidad escondería
   * justo la incidencia que se quiere ver: la que lleva 80 días atorada es
   * UNA, y con el otro orden acabaría hasta abajo detrás de sitios con tres
   * casos recientes.
   */
  orden?: 'cantidad' | 'tiempo';
  onClose: () => void;
};

type Grupo = {
  clave: string;
  etiqueta: string;
  sub: string;
  filas: Incidencia[];
  /** Lo que lleva detenida la peor del grupo. null si ninguna está en proceso. */
  peorHoras: number | null;
};

function KpiDetalleModal({
  titulo,
  subtitulo,
  items,
  corteInicial = 'sitio',
  orden = 'cantidad',
  onClose,
}: Props) {
  const [corte, setCorte] = useState<Corte>(corteInicial);
  // Al ordenar por tiempo se abre solo el primer grupo: quien entra por "peor
  // tiempo en proceso" viene a ver UNA incidencia, y obligarlo a un clic más
  // para encontrarla sería devolverle la pregunta.
  const [abierto, setAbierto] = useState<string>('');
  const [autoAbierto, setAutoAbierto] = useState(false);

  const grupos = useMemo<Grupo[]>(() => {
    const m = new Map<string, Grupo>();
    items.forEach((i) => {
      const clave =
        corte === 'sitio'
          ? i.clave_sitio || '(sin clave)'
          : i.nombre_incidencia || '(sin incidencia)';
      let g = m.get(clave);
      if (!g) {
        g = {
          clave,
          etiqueta: clave,
          // El subtítulo cambia según el corte: en sitio interesa dónde está;
          // en incidencia, a qué área le toca.
          sub:
            corte === 'sitio'
              ? [i.direccion, i.municipio].filter(Boolean).join(' · ')
              : i.area_responsable || '',
          filas: [],
          peorHoras: null,
        };
        m.set(clave, g);
      }
      g.filas.push(i);
      const h = horasEnProceso(i);
      if (h != null && (g.peorHoras == null || h > g.peorHoras)) g.peorHoras = h;
    });

    const gs = [...m.values()];
    // Dentro de cada grupo, cuando se ordena por tiempo, la más atorada
    // primero. Con el orden por cantidad se deja como venía (por fecha),
    // que es lo que se esperaba de una lista.
    if (orden === 'tiempo') {
      gs.forEach((g) =>
        g.filas.sort(
          (a, b) => (horasEnProceso(b) ?? -1) - (horasEnProceso(a) ?? -1)
        )
      );
      // -1 y no 0 para las que no están en proceso: así se van al final en
      // vez de mezclarse con las que llevan minutos.
      return gs.sort((a, b) => (b.peorHoras ?? -1) - (a.peorHoras ?? -1));
    }
    return gs.sort((a, b) => b.filas.length - a.filas.length);
  }, [items, corte, orden]);

  // Se hace en un efecto y con bandera propia: hacerlo dentro del useMemo
  // sería mutar estado durante el render, y una sola vez, para que si el
  // usuario cierra el grupo no se le vuelva a abrir en el siguiente pintado.
  useEffect(() => {
    if (orden !== 'tiempo' || autoAbierto || !grupos.length) return;
    setAbierto(grupos[0].clave);
    setAutoAbierto(true);
  }, [orden, autoAbierto, grupos]);

  const recortados = grupos.slice(0, TOPE_GRUPOS);
  const omitidos = grupos.length - recortados.length;

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onClose();
      }}
    >
      <div className="modal" style={{ maxWidth: 760 }}>
        <h2 style={{ margin: '0 0 3px' }}>{titulo}</h2>
        <p className="phint">
          {items.length} incidencia{items.length === 1 ? '' : 's'}
          {subtitulo ? ` · ${subtitulo}` : ''}
        </p>

        <div className="toolbar" style={{ marginBottom: 12 }}>
          <button
            className={'btn sm ' + (corte === 'sitio' ? '' : 'ghost')}
            onClick={() => {
              setCorte('sitio');
              setAbierto('');
            }}
          >
            📍 Por sitio ({new Set(items.map((i) => i.clave_sitio)).size})
          </button>
          <button
            className={'btn sm ' + (corte === 'incidencia' ? '' : 'ghost')}
            onClick={() => {
              setCorte('incidencia');
              setAbierto('');
            }}
          >
            🔧 Por incidencia (
            {new Set(items.map((i) => i.nombre_incidencia)).size})
          </button>
        </div>

        {items.length === 0 ? (
          <div className="empty">No hay incidencias detrás de este número.</div>
        ) : (
          <div
            style={{
              maxHeight: '58vh',
              overflowY: 'auto',
              border: '1px solid var(--line)',
              borderRadius: 12,
            }}
          >
            {recortados.map((g) => {
              const esta = abierto === g.clave;
              return (
                <div
                  key={g.clave}
                  style={{ borderBottom: '1px solid var(--line)' }}
                >
                  <button
                    onClick={() => setAbierto(esta ? '' : g.clave)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      textAlign: 'left',
                      background: 'none',
                      border: 'none',
                      color: 'inherit',
                      padding: '11px 13px',
                      cursor: 'pointer',
                      font: 'inherit',
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>
                        {esta ? '▾ ' : '▸ '}
                        {g.etiqueta}
                      </span>
                      {g.sub && (
                        <span
                          style={{
                            display: 'block',
                            fontSize: 12,
                            color: 'var(--muted)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {g.sub}
                        </span>
                      )}
                    </span>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {orden === 'tiempo' && g.peorHoras != null && (
                        <span
                          className="pill"
                          style={{
                            background:
                              g.peorHoras > 72 ? '#ef444422' : 'var(--panel2)',
                            color: g.peorHoras > 72 ? '#ef4444' : 'var(--muted)',
                          }}
                        >
                          ⏳ {fmtHoras(g.peorHoras)}
                        </span>
                      )}
                      <span
                        className="pill"
                        style={{
                          background: 'var(--panel2)',
                          color: 'var(--txt)',
                        }}
                      >
                        {g.filas.length}
                      </span>
                    </span>
                  </button>

                  {esta && (
                    <div style={{ padding: '0 13px 12px' }}>
                      {g.filas.slice(0, TOPE_FOLIOS).map((i) => (
                        <div
                          key={i.record_id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            flexWrap: 'wrap',
                            fontSize: 12,
                            padding: '5px 0',
                            borderTop: '1px solid var(--line)',
                          }}
                        >
                          <b>{i.folio || i.record_id}</b>
                          <span
                            className="pill"
                            style={{
                              background:
                                (EST_COLOR[i.estatus] || '#666') + '22',
                              color: EST_COLOR[i.estatus] || '#aaa',
                            }}
                          >
                            {EST_LABEL[i.estatus] || i.estatus}
                          </span>
                          <span style={{ color: 'var(--muted)' }}>
                            {corte === 'sitio'
                              ? i.nombre_incidencia
                              : i.clave_sitio}
                            {i.clave_medio
                              ? ` · cara ${caraLabel(i.clave_medio)}`
                              : ''}
                          </span>
                          {/* La fecha iba suelta y no decía de qué era. Es la
                              de REPORTE, y ahora lo dice: en una lista donde
                              también se muestra un tiempo transcurrido, una
                              fecha sin etiqueta se lee como cualquier cosa. */}
                          <span
                            style={{ color: 'var(--muted)', marginLeft: 'auto' }}
                          >
                            Reportada:{' '}
                            {i.fecha_reporte
                              ? new Date(i.fecha_reporte).toLocaleDateString(
                                  'es-MX',
                                  { dateStyle: 'medium' }
                                )
                              : '—'}
                          </span>
                          {/* Validación → reparación. Solo aparece cuando se
                              puede medir: un "0 h" en algo que todavía no se
                              repara sería mentira. */}
                          {/* Lo que lleva ATORADA. Solo sale en las que están
                              en proceso; en las demás no significa nada. Se
                              pinta en rojo pasando las 72 h para que en una
                              lista larga salten solas. */}
                          {horasEnProceso(i) != null && (
                            <span
                              className="pill"
                              style={{
                                background:
                                  (horasEnProceso(i) as number) > 72
                                    ? '#ef444422'
                                    : 'var(--panel2)',
                                color:
                                  (horasEnProceso(i) as number) > 72
                                    ? '#ef4444'
                                    : 'var(--muted)',
                              }}
                              title="Lleva en proceso"
                            >
                              ⏳ {fmtHoras(horasEnProceso(i))}
                            </span>
                          )}
                          {horasValidacionReparacion(i) != null && (
                            <span
                              className="pill"
                              style={{
                                background: 'var(--panel2)',
                                color: 'var(--muted)',
                              }}
                              title="De que se validó a que se reparó"
                            >
                              ⏱ {fmtHoras(horasValidacionReparacion(i))}
                            </span>
                          )}
                        </div>
                      ))}
                      {g.filas.length > TOPE_FOLIOS && (
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--muted)',
                            paddingTop: 6,
                          }}
                        >
                          … y {g.filas.length - TOPE_FOLIOS} más. Búscalas en
                          Incidencias filtrando por {g.etiqueta}.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Nunca cortar en silencio: si no caben todos, se dice cuántos
            faltan. Una lista truncada sin aviso se lee como completa. */}
        {omitidos > 0 && (
          <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 10 }}>
            ⚠️ Se muestran los {TOPE_GRUPOS} con más incidencias. Faltan{' '}
            {omitidos} {corte === 'sitio' ? 'sitios' : 'incidencias'} con menos
            casos.
          </div>
        )}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

export default KpiDetalleModal;
