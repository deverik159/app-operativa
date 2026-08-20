// ============================================================
// src/components/IncCard.tsx
// Tarjeta de una incidencia con sus acciones. Traducido del HTML.
// ============================================================
import {
  AREAS_ASIGNABLES,
  EST_COLOR,
  EST_LABEL,
  NIVEL_COLOR,
  SLA_VALIDADOR_HORAS,
} from '../lib/constants';
import { slaInfo, caraLabel, areaEfectiva, tieneAreaRedirigida } from '../lib/helpers';
import type { CanInc, EstatusInc, Incidencia, SlaMap } from '../types/db';

/** Modo del modal de reasignación: pedirla, o revisarla como coordinador. */
export type ModoReasign = 'solicitar' | 'aprobar';

type IncCardProps = {
  i: Incidencia;
  can: CanInc;
  role: string;
  email: string;
  onEstatus: (recordId: string, estatus: EstatusInc) => void;
  onRepair: (i: Incidencia) => void;
  onEvidence: (i: Incidencia) => void;
  onChat: (i: Incidencia) => void;
  onReassign: (i: Incidencia, mode: ModoReasign) => void;
  onAsignar: (i: Incidencia) => void;
  onAsignarArea: (i: Incidencia) => void;
  onEdit: (i: Incidencia) => void;
  onRechazarRep: (i: Incidencia) => void;
  onPrevalidar: (i: Incidencia) => void;
  onDescartar: (i: Incidencia) => void;
  slaMap: SlaMap;
  nChat: number;
};

function IncCard({
  i,
  can,
  role,
  email,
  onEstatus,
  onRepair,
  onEvidence,
  onChat,
  onReassign,
  onAsignar,
  onAsignarArea,
  onEdit,
  onRechazarRep,
  onPrevalidar,
  onDescartar,
  slaMap,
  nChat,
}: IncCardProps) {
  const activa = !['cerrada', 'no_reparado'].includes(i.estatus);
  const prevalidacionPend =
    i.requiere_prevalidacion && !i.prevalidada && i.estatus === 'en_proceso';
  // Se evalúa contra el área EFECTIVA: si la incidencia se redirigió a
  // Mantenimiento, los técnicos que aplican son los de Mantenimiento, no los
  // del área que dice el catálogo.
  const areaReal = areaEfectiva(i);
  const redirigida = tieneAreaRedirigida(i);
  const asignable =
    can.asignarTecnico &&
    i.estatus === 'en_proceso' &&
    AREAS_ASIGNABLES.includes(areaReal);
  // Solo tiene sentido dirigir el trabajo mientras siga abierta.
  const puedeAsignarArea =
    can.asignarArea && !['cerrada', 'no_reparado'].includes(i.estatus);
  const mio =
    (i.captured_by || '').toLowerCase() === (email || '').toLowerCase();
  const puedeEditar = can.validar
    ? activa
    : role === 'reportante' &&
      mio &&
      ['por_validar', 'rechazada'].includes(i.estatus);
  const slaRep =
    i.estatus === 'en_proceso' && i.sla_reparacion_inicio
      ? slaInfo(
          i.sla_reparacion_inicio,
          (slaMap || {})[areaReal.toLowerCase()]
        )
      : null;
  const slaVal =
    i.estatus === 'reparado' && i.sla_validacion_inicio
      ? slaInfo(i.sla_validacion_inicio, SLA_VALIDADOR_HORAS)
      : null;
  const sla = slaRep || slaVal;
  return (
    <div className="inc">
      <div className="inc-top">
        <div>
          <div className="folio">
            {i.folio || '(sin folio)'} · {i.unidad_negocio}
          </div>
          <div className="titulo">{i.nombre_incidencia}</div>
          <div className="meta">
            {i.medio} · {i.clave_sitio}
            {i.clave_medio ? ` · cara ${caraLabel(i.clave_medio)}` : ''}
            {i.nombre_biobox ? ` · ${i.nombre_biobox}` : ''}
            <br />
            {i.direccion}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span
            className="pill"
            style={{
              background: (EST_COLOR[i.estatus] || '#666') + '22',
              color: EST_COLOR[i.estatus] || '#aaa',
            }}
          >
            {EST_LABEL[i.estatus] || i.estatus}
          </span>
          {sla && (
            <div style={{ marginTop: 6 }}>
              <span
                className="pill"
                style={{ background: sla.color + '22', color: sla.color }}
              >
                ⏱ {slaRep ? 'SLA área' : 'SLA validación'}: {sla.label}
              </span>
            </div>
          )}
        </div>
      </div>
      {i.observaciones && <div className="obs">“{i.observaciones}”</div>}
      <div className="chips">
        {i.nivel && (
          <span
            className="pill"
            style={{
              background: (NIVEL_COLOR[i.nivel] || '#555') + '22',
              color: NIVEL_COLOR[i.nivel] || '#aaa',
            }}
          >
            Nivel {i.nivel}
          </span>
        )}
        {i.tipo && <span className="tag">{i.tipo}</span>}
        {i.origen && <span className="tag">Origen: {i.origen}</span>}
        {i.area_responsable && <span className="tag">→ {i.area_responsable}</span>}
        {redirigida && (
          <span
            className="pill"
            style={{ background: '#ff5a3c22', color: '#ff5a3c' }}
            title="Área que realmente repara (el catálogo decía otra)"
          >
            🛠 Repara: {i.assigned_area}
          </span>
        )}
        {i.asignado_tecnico && (
          <span
            className="tag"
            style={{ background: '#22c55e22', color: '#22c55e' }}
          >
            👷 {i.asignado_tecnico}
          </span>
        )}
        {i.campania && <span className="tag">🎯 {i.campania}</span>}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
        🕒 Capturada:{' '}
        {i.fecha_reporte
          ? new Date(i.fecha_reporte).toLocaleString('es-MX', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })
          : '—'}
        {i.catorcena ? ` · Cat-${i.catorcena}` : ''}
        {i.semana ? ` · Sem ${i.semana}` : ''}
        {i.captured_by ? ` · por ${String(i.captured_by).split('@')[0]}` : ''}
      </div>
      {(i.detalle_reparacion || i.diagnostico || i.causa_raiz || i.solucion) && (
        <div
          className="obs"
          style={{
            background: 'var(--panel2)',
            borderRadius: 9,
            padding: '9px 11px',
            marginTop: 9,
            color: 'var(--muted)',
          }}
        >
          {i.diagnostico && (
            <div>
              <b>Diagnóstico:</b> {i.diagnostico}
            </div>
          )}
          {i.causa_raiz && (
            <div>
              <b>Causa raíz:</b> {i.causa_raiz}
            </div>
          )}
          {i.solucion && (
            <div>
              <b>Solución:</b> {i.solucion}
            </div>
          )}
          {i.detalle_reparacion && (
            <div>
              <b>Reparación:</b> {i.detalle_reparacion}
            </div>
          )}
        </div>
      )}
      {i.estatus === 'en_proceso' && i.motivo_rechazo_reparacion && (
        <div
          className="obs"
          style={{
            background: '#3a1a1a',
            border: '1px solid #5a2a2a',
            borderRadius: 9,
            padding: '9px 11px',
            marginTop: 9,
            color: '#ffb4b4',
          }}
        >
          ⚠️ Reparación rechazada por el validador: “
          {i.motivo_rechazo_reparacion}”
        </div>
      )}
      {i.reasignacion_pendiente && (
        <div style={{ marginTop: 9 }}>
          <span
            className="pill"
            style={{ background: '#a78bfa22', color: '#a78bfa' }}
          >
            🔀 Reasignación pendiente
          </span>
        </div>
      )}
      <div className="inc-actions">
        <button className="btn ghost sm" onClick={() => onEvidence(i)}>
          📎 Evidencia
        </button>
        <button className="btn ghost sm" onClick={() => onChat(i)}>
          💬 Chat
          {nChat > 0 && (
            <span
              className="badge-pulse"
              style={{
                marginLeft: 6,
                background: '#22c55e',
                color: '#0b3d1e',
                borderRadius: 20,
                fontSize: 10,
                fontWeight: 800,
                padding: '0 6px',
              }}
            >
              {nChat}
            </span>
          )}
        </button>
        {puedeEditar && (
          <button className="btn ghost sm" onClick={() => onEdit(i)}>
            ✏️ Editar
          </button>
        )}
        {i.estatus === 'en_proceso' &&
          !i.reasignacion_pendiente &&
          can.reasignar && (
            <button
              className="btn ghost sm"
              onClick={() => onReassign(i, 'solicitar')}
            >
              🔀 Reasignar
            </button>
          )}
        {i.reasignacion_pendiente && can.aprobarReasign && (
          <button
            className="btn ghost sm"
            onClick={() => onReassign(i, 'aprobar')}
          >
            🔀 Revisar reasignación
          </button>
        )}
        {puedeAsignarArea && (
          <button className="btn ghost sm" onClick={() => onAsignarArea(i)}>
            🛠 {redirigida ? 'Cambiar área que repara' : 'Asignar área'}
          </button>
        )}
        {asignable && (
          <button className="btn ghost sm" onClick={() => onAsignar(i)}>
            👷 {i.asignado_tecnico ? 'Reasignar técnico' : 'Asignar técnico'}
          </button>
        )}
      </div>
      {can.validar && i.estatus === 'por_validar' && (
        <div className="inc-actions">
          <button
            className="btn ok sm"
            onClick={() => onEstatus(i.record_id, 'en_proceso')}
          >
            ✓ Aprobar y asignar
          </button>
          <button
            className="btn hi sm"
            onClick={() => onEstatus(i.record_id, 'rechazada')}
          >
            ✕ Rechazar
          </button>
        </div>
      )}
      {prevalidacionPend && (
        <div style={{ marginTop: 9 }}>
          <span
            className="pill"
            style={{ background: '#4f8cff22', color: '#4f8cff' }}
          >
            ⚡ Directa a Digital · prevalidación pendiente
          </span>
        </div>
      )}
      {can.reparar && i.estatus === 'en_proceso' && prevalidacionPend && (
        <div className="inc-actions">
          <button className="btn ok sm" onClick={() => onPrevalidar(i)}>
            ✓ Prevalidar
          </button>
          <button className="btn hi sm" onClick={() => onDescartar(i)}>
            ✕ Descartar
          </button>
        </div>
      )}
      {can.reparar && i.estatus === 'en_proceso' && !prevalidacionPend && (
        <div className="inc-actions">
          <button className="btn warn sm" onClick={() => onRepair(i)}>
            🔧 Registrar reparación
          </button>
        </div>
      )}
      {can.validar && i.estatus === 'reparado' && (
        <div className="inc-actions">
          <button
            className="btn ok sm"
            onClick={() => onEstatus(i.record_id, 'cerrada')}
          >
            ✓ Aprobar reparación
          </button>
          <button className="btn hi sm" onClick={() => onRechazarRep(i)}>
            ✕ Rechazar (regresar al área)
          </button>
        </div>
      )}
    </div>
  );
}

export default IncCard;
