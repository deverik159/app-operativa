// ============================================================
// src/modules/biobox/EstadoMaquinaPanel.tsx
// Lo que esta máquina trae abierto, arriba del checklist.
//
// PARA QUÉ: que el operador, antes de empezar a revisar, vea todo lo que ya
// está levantado en esa máquina — sea de su área o no.
//
//   Si le toca a él      → lo repara, y se le contabiliza (repaired_by_email).
//   Si es de otra área   → sabe QUÉ es, CUÁNTO lleva y QUÉ ÁREA la repara, y
//                          va a preguntar por qué sigue detenida.
//
// Ese segundo caso es el que no existía. El operador llegaba, revisaba, veía
// la máquina mal y volvía a levantar la misma incidencia que ya estaba
// levantada desde hacía dos meses — porque no tenía forma de saberlo.
//
// LO QUE NO HACE: no deja actuar sobre lo que no es suyo. Es una pantalla
// para saber e ir a preguntar, no para meterse al trabajo de otra área. Por
// eso no trae botones de reparar ni de cambiar estatus.
// ============================================================
import { useState, useEffect } from 'react';
import {
  detalleMaquina,
  HORAS_ALARMA,
  type IncidenciaAbierta,
} from '../../lib/estadoMaquina';
import { fmtHoras, caraLabel } from '../../lib/helpers';
import { EST_COLOR, EST_LABEL } from '../../lib/constants';

type Props = {
  siteId: string;
  /** Al montarse avisa cuántas encontró, por si el padre quiere reaccionar. */
  onCargado?: (n: number) => void;
};

function EstadoMaquinaPanel({ siteId, onCargado }: Props) {
  const [filas, setFilas] = useState<IncidenciaAbierta[]>([]);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState('');
  const [abierto, setAbierto] = useState(true);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const r = await detalleMaquina(siteId);
      if (!vivo) return;
      setFilas(r.filas);
      setErr(r.error);
      setCargando(false);
      onCargado?.(r.filas.length);
    })();
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  if (cargando) {
    return (
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        Consultando qué trae abierto esta máquina…
      </div>
    );
  }

  // Un fallo aquí NO puede llevarse la revisión. Se avisa y se sigue.
  if (err) {
    return (
      <div
        className="banner"
        style={{ marginBottom: 12, borderColor: '#6a5520', color: '#ffdf9e' }}
      >
        ⚠️ No se pudo consultar lo que esta máquina trae abierto ({err}). Puedes
        revisarla de todos modos, pero fíjate de no levantar algo que ya esté
        reportado.
      </div>
    );
  }

  // Sin nada abierto se dice explícitamente. Es información, no ausencia de
  // información: significa "puedes levantar lo que encuentres sin duplicar".
  if (!filas.length) {
    return (
      <div
        style={{
          background: 'rgba(34,197,94,.08)',
          border: '1px solid rgba(34,197,94,.35)',
          borderRadius: 10,
          padding: '9px 12px',
          marginBottom: 12,
          fontSize: 13,
          color: 'var(--ok)',
        }}
      >
        ✓ Esta máquina no trae nada abierto.
      </div>
    );
  }

  const detenidas = filas.filter(
    (f) => (f.horas_en_estatus ?? 0) > HORAS_ALARMA
  ).length;
  const mias = filas.filter((f) => f.es_de_mi_area).length;

  return (
    <div
      style={{
        border: '1px solid ' + (detenidas ? '#ef4444' : 'var(--line)'),
        borderRadius: 12,
        marginBottom: 14,
        overflow: 'hidden',
        background: detenidas ? 'rgba(239,68,68,.05)' : 'var(--panel2)',
      }}
    >
      <button
        onClick={() => setAbierto((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          width: '100%',
          textAlign: 'left',
          background: 'none',
          border: 'none',
          color: 'inherit',
          font: 'inherit',
          padding: '10px 12px',
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          {/* Concordancia completa: "1 incidencia abierta" contra
              "2 incidencias abiertas". Un "1 incidencias abiertas" en la
              primera línea de la pantalla se nota, y de gratis. */}
          {abierto ? '▾' : '▸'} Máquina con {filas.length}{' '}
          {filas.length === 1 ? 'incidencia abierta' : 'incidencias abiertas'}
        </span>
        {detenidas > 0 && (
          <span
            className="pill"
            style={{ background: '#ef444422', color: '#ef4444' }}
          >
            {detenidas} detenida{detenidas === 1 ? '' : 's'} +{' '}
            {fmtHoras(HORAS_ALARMA)}
          </span>
        )}
        {mias > 0 && (
          <span
            className="pill"
            style={{ background: '#22c55e22', color: '#22c55e' }}
          >
            {mias} de tu área
          </span>
        )}
      </button>

      {abierto && (
        <div style={{ padding: '0 12px 10px' }}>
          {filas.map((f) => {
            const alarma = (f.horas_en_estatus ?? 0) > HORAS_ALARMA;
            return (
              <div
                key={f.record_id}
                style={{
                  borderTop: '1px solid var(--line)',
                  padding: '9px 0',
                  fontSize: 12,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    gap: 7,
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  <b style={{ fontSize: 13 }}>{f.folio || f.record_id}</b>
                  <span
                    className="pill"
                    style={{
                      background: (EST_COLOR[f.estatus] || '#666') + '22',
                      color: EST_COLOR[f.estatus] || '#aaa',
                    }}
                  >
                    {EST_LABEL[f.estatus] || f.estatus}
                  </span>
                  <span
                    className="pill"
                    style={{
                      background: alarma ? '#ef444422' : 'var(--panel)',
                      color: alarma ? '#ef4444' : 'var(--muted)',
                    }}
                    title="Lleva en este estatus"
                  >
                    ⏳ {fmtHoras(f.horas_en_estatus)}
                  </span>
                </div>

                <div style={{ marginTop: 3 }}>
                  {f.nombre_incidencia}
                  {f.clave_medio ? ` · cara ${caraLabel(f.clave_medio)}` : ''}
                </div>

                {/* ÁREA, no persona. Antes decía "pregúntale a Luis Rojas ·
                    Marcela Ramírez", resuelto con destinatarios_notif. Se
                    quitó por decisión de Erik: la conversación es con el área.
                    Mandar al operador con un nombre propio crea fricción y
                    además envejece mal — la gente rota, el área no. */}
                <div style={{ marginTop: 4, color: 'var(--muted)' }}>
                  La repara: <b>{f.area || '(sin área)'}</b>
                </div>

                {/* La observación con la que se reportó. Es lo que convierte
                    un renglón de catálogo en algo reconocible parado frente a
                    la máquina: "NUC con fallas" puede ser cualquier cosa. */}
                {f.observaciones && (
                  <div
                    style={{
                      marginTop: 4,
                      paddingLeft: 9,
                      borderLeft: '2px solid var(--line)',
                      color: 'var(--muted)',
                      fontStyle: 'italic',
                    }}
                  >
                    “{f.observaciones}”
                  </div>
                )}
              </div>
            );
          })}

          <div
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              marginTop: 9,
              lineHeight: 1.5,
            }}
          >
            Antes de levantar aquí una incidencia, revisa que no sea la misma
            — para que no la vuelvas a levantar. Revisa con el área
            responsable.
          </div>
        </div>
      )}
    </div>
  );
}

export default EstadoMaquinaPanel;
