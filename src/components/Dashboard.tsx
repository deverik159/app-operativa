// ============================================================
// src/components/Dashboard.tsx
// Panel de indicadores. Traducido del HTML.
// ============================================================
import { UNIDADES, EST_COLOR } from '../lib/constants';
import type { Incidencia } from '../types/db';

// 'items' son las incidencias visibles para el rol; 'stats' los totales ya
// calculados por la vista contenedora (no se recalculan aquí).
type Stats = {
  total: number;
  porValidar: number;
  enProceso: number;
  cerradas: number;
  efect: number;
};

function Dashboard({ items, stats }: { items: Incidencia[]; stats: Stats }) {
  const byUN = UNIDADES.map((u) => ({
    k: u,
    v: items.filter((i) => i.unidad_negocio === u).length,
  })).filter((x) => x.v > 0);
  const maxUN = Math.max(...byUN.map((x) => x.v), 1);
  return (
    <>
      <h2 className="page">Indicadores</h2>
      <p className="phint">
        En vivo desde tu base de datos ({stats.total} incidencias visibles para tu
        rol).
      </p>
      <div className="cards">
        <div className="card">
          <div className="n">{stats.total}</div>
          <div className="l">Visibles</div>
        </div>
        <div className="card">
          <div className="n" style={{ color: EST_COLOR.por_validar }}>
            {stats.porValidar}
          </div>
          <div className="l">Por validar</div>
        </div>
        <div className="card">
          <div className="n" style={{ color: EST_COLOR.en_proceso }}>
            {stats.enProceso}
          </div>
          <div className="l">En proceso</div>
        </div>
        <div className="card">
          <div className="n" style={{ color: EST_COLOR.cerrada }}>
            {stats.cerradas}
          </div>
          <div className="l">Cerradas</div>
        </div>
        <div className="card">
          <div className="n" style={{ color: 'var(--accent)' }}>
            {stats.efect}%
          </div>
          <div className="l">Efectividad</div>
        </div>
      </div>
      <div className="card">
        <div className="l" style={{ marginBottom: 12 }}>
          Por unidad de negocio
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {byUN.map((x) => (
            <div
              key={x.k}
              style={{
                display: 'grid',
                gridTemplateColumns: '120px 1fr 40px',
                alignItems: 'center',
                gap: 10,
                fontSize: 13,
              }}
            >
              <span>{x.k}</span>
              <div
                style={{
                  background: 'var(--panel2)',
                  borderRadius: 8,
                  height: 16,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    borderRadius: 8,
                    background: 'var(--accent2)',
                    width: (x.v / maxUN) * 100 + '%',
                  }}
                ></div>
              </div>
              <span style={{ textAlign: 'right' }}>{x.v}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export default Dashboard;
