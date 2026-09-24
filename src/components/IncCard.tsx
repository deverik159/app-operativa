// ============================================================
// src/components/IncCard.tsx
// Tarjeta de una incidencia con sus acciones. Traducido del HTML.
// ============================================================
import {
  EST_COLOR,
  EST_LABEL,
  NIVEL_COLOR,
} from '../lib/constants';
import { slaInfo, slaInfoValidador, caraIncidencia, areaEfectiva, tieneAreaRedirigida } from '../lib/helpers';
import { alFallarMiniatura, urlMiniatura } from '../lib/storage';
import type { CanInc, EstatusInc, Incidencia, SlaMap } from '../types/db';

/** Modo del modal de reasignación: pedirla, o revisarla como coordinador. */
export type ModoReasign = 'solicitar' | 'aprobar';

type IncCardProps = {
  i: Incidencia;
  can: CanInc;
  email: string;
  onEstatus: (recordId: string, estatus: EstatusInc) => void;
  onRepair: (i: Incidencia) => void;
  onEvidence: (i: Incidencia) => void;
  onChat: (i: Incidencia) => void;
  onReassign: (i: Incidencia, mode: ModoReasign) => void;
  /** Corrección del validador: cambia qué incidencia es, según el catálogo. */
  onCorregir: (i: Incidencia) => void;
  onEdit: (i: Incidencia) => void;
  onRechazarRep: (i: Incidencia) => void;
  /** Primera foto del reporte. La tarjeta la enseña sin abrir la galería. */
  foto?: string | null;
  onPrevalidar: (i: Incidencia) => void;
  onDescartar: (i: Incidencia) => void;
  slaMap: SlaMap;
  /** Minutos configurados para validar captura y reparación. */
  slaValidacion: { reporte: number; reparacion: number };
  nChat: number;
  /**
   * La tarjeta tiene una acción (validar, reparar…) guardada en el
   * teléfono que se manda sola al volver la señal (modo sin señal,
   * 24-sep-2026). Enseña el chip "⏳ En cola" y apaga lo que va directo al
   * servidor (editar, corrección, reasignación): el servidor todavía no
   * tiene el estatus que se ve. Las acciones de la cola siguen: la que se
   * encoló ya no aparece (la tarjeta enseña su resultado) y la siguiente
   * —p. ej. reparar tras prevalidar, sin señal— sale en orden detrás de
   * ella (lib/acciones.ts).
   */
  enCola?: boolean;
  /**
   * La acción guardada en el teléfono se quedó con un error que no es de
   * red: NO se enviará sola (revisión sin señal, 24-sep-2026). La tarjeta
   * enseña el estatus real (la vista no la superpone) y el chip lo dice, en
   * vez de un "⏳ En cola" que prometía un envío que nunca llegaba.
   */
  conError?: boolean;
  /** Una acción de esta tarjeta se está mandando ahora: evita el doble toque. */
  ocupada?: boolean;
};

function IncCard({
  i,
  can,
  email,
  onEstatus,
  onRepair,
  onEvidence,
  onChat,
  onReassign,
  onCorregir,
  onEdit,
  onRechazarRep,
  foto,
  onPrevalidar,
  onDescartar,
  slaMap,
  slaValidacion,
  nChat,
  enCola = false,
  conError = false,
  ocupada = false,
}: IncCardProps) {
  // Evidencia y chat siguen abiertos siempre. Mientras una acción se manda,
  // nada más que cambie la incidencia; con algo en la cola, nada de lo que
  // va directo al servidor.
  const bloqueada = ocupada;
  const bloqueadaRed = enCola || ocupada;
  const activa = !['cerrada', 'no_reparado'].includes(i.estatus);
  const prevalidacionPend =
    i.requiere_prevalidacion && !i.prevalidada && i.estatus === 'en_proceso';
  // Se evalúa contra el área EFECTIVA: si la incidencia se redirigió a
  // Mantenimiento, los técnicos que aplican son los de Mantenimiento, no los
  // del área que dice el catálogo.
  const areaReal = areaEfectiva(i);
  // Reparar exige rol Y área. `reparaEn` llega de IncidenciasView con los
  // departamentos reales del usuario; si no viene, se conserva el
  // comportamiento por rol de siempre.
  const puedeReparar =
    !!can.reparar && (can.reparaEn ? can.reparaEn(i) : true);
  const redirigida = tieneAreaRedirigida(i);
  const mio =
    (i.captured_by || '').toLowerCase() === (email || '').toLowerCase();

  // EDITAR es del REPORTANTE, sobre lo suyo y solo mientras la base se lo
  // permita (política inc_upd_reportante: por_validar y rechazada).
  //
  // OJO con `can.crear` en vez de `role === 'reportante'`: `role` es el rol
  // PRINCIPAL, el que gana por ROLE_PRIORITY. Quien tiene reportante +
  // reparación acaba con role='reparacion' y perdía el botón sobre sus
  // propias capturas — el mismo defecto que ya nos costó la bandeja de Dulce.
  // `can.crear` mira TODOS sus roles.
  const puedeEditar =
    !!can.crear && mio && ['por_validar', 'rechazada'].includes(i.estatus);

  // CORREGIR es del VALIDADOR: cambia la clasificación contra el catálogo.
  // Solo mientras la incidencia esté ANTES de la reparación: una vez
  // reparada, el técnico ya trabajó sobre esa clasificación y reclasificarla
  // desharía el contexto de lo que se reparó (Erik, sep-2026). Una cerrada
  // tampoco se reclasifica.
  const puedeCorregir =
    !!can.validar && activa && i.estatus !== 'reparado';

  const slaRep =
    i.estatus === 'en_proceso' && i.sla_reparacion_inicio
      ? slaInfo(
          i.sla_reparacion_inicio,
          (slaMap || {})[areaReal.toLowerCase()]
        )
      : null;
  const slaValReporte =
    i.estatus === 'por_validar' && i.fecha_reporte
      ? slaInfoValidador(i.fecha_reporte, slaValidacion.reporte)
      : null;
  const slaValReparacion =
    i.estatus === 'reparado' && i.sla_validacion_inicio
      ? slaInfoValidador(i.sla_validacion_inicio, slaValidacion.reparacion)
      : null;
  const sla = slaRep || slaValReporte || slaValReparacion;
  const etiquetaSla = slaRep
    ? 'SLA área'
    : slaValReporte
      ? 'Validar reporte'
      : 'Validar reparación';
  return (
    <div className="inc">
      <div className="inc-top">
        <div>
          <div className="folio">
            {i.folio || '(sin folio)'} · {i.unidad_negocio}
          </div>
          <div className="titulo">{i.nombre_incidencia}</div>
          {i.incidencia_srd && (
            <div
              style={{
                color: 'var(--accent2)',
                fontSize: 12,
                fontWeight: 700,
                marginTop: 3,
              }}
            >
              ⚙ Digital: {i.incidencia_srd}
            </div>
          )}
          <div className="meta">
            {i.medio} · {i.clave_sitio}
            {i.lado || i.clave_medio ? ` · cara ${caraIncidencia(i)}` : ''}
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
                className="pill multilinea"
                style={{ background: sla.color + '22', color: sla.color }}
              >
                ⏱ {etiquetaSla}: {sla.label}
              </span>
            </div>
          )}
          {(ocupada || enCola) && (
            <div style={{ marginTop: 6 }}>
              <span
                className="pill multilinea"
                style={{ background: '#f59e0b22', color: '#f59e0b' }}
                title={
                  ocupada
                    ? 'Mandando…'
                    : 'Guardada en el teléfono: se envía sola al volver la señal'
                }
              >
                {ocupada ? (
                  <>
                    <span className="spinner" />
                    Guardando…
                  </>
                ) : (
                  '⏳ En cola'
                )}
              </span>
            </div>
          )}
          {conError && !ocupada && (
            <div style={{ marginTop: 6 }}>
              <span
                className="pill multilinea"
                style={{ background: '#ef444422', color: '#ef4444' }}
                title="No se enviará sola: vuelve a hacerla (se ofrece descartar la anterior) o descártala en el aviso de pendientes"
              >
                ⚠ No se pudo enviar: vuelve a hacerla o descártala en el aviso
              </span>
            </div>
          )}
        </div>
      </div>
      {i.observaciones && <div className="obs">“{i.observaciones}”</div>}
      {/* Contacto del solicitante (lo captura MKT): quien atiende ve a
          quién regresarle respuesta sin buscar en ningún otro lado. */}
      {(i.contacto_correo || i.contacto_telefono || i.via_reporte) && (
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px' }}>
          👤 Solicitó{i.via_reporte ? ` por ${i.via_reporte}` : ''}:{' '}
          {[i.contacto_correo, i.contacto_telefono].filter(Boolean).join(' · ')}
        </div>
      )}
      {/* La foto del reporte, abajo del encabezado (pliego petitorio,
          ago-2026): el validador decide viendo, no abriendo la galería.
          El tamaño lo gobierna .inc-foto en index.css — en celular toma el
          ancho completo de la tarjeta, en escritorio se acota, y el
          object-fit:cover evita que una foto vertical de celular estire la
          tarjeta tres pantallas. Clic = galería completa. */}
      {foto && (
        <img
          // key: si la tarjeta cambia de foto (p. ej. al pasar a reparado),
          // se crea un <img> nuevo y no hereda el estado del anterior.
          key={foto}
          className="inc-foto"
          // La MINIATURA (640 px, ~50 KB) y no el original de 1600 px que se
          // pintaba a 200 px de alto: con 300 usuarios era el grueso del
          // egress (auditoría, 24-sep-2026). Las fotos subidas antes de las
          // miniaturas no la tienen y caen solas al original.
          src={urlMiniatura(foto)}
          onError={alFallarMiniatura(foto)}
          alt={'Evidencia del reporte ' + (i.folio || '')}
          loading="lazy"
          onClick={() => onEvidence(i)}
        />
      )}
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
        {i.lado && (
          <span
            className="tag"
            style={{ background: '#a78bfa22', color: '#a78bfa' }}
            title="Lado de la cara reportada"
          >
            🧭 Cara {i.lado}
          </span>
        )}
        {/* tipo (Imponderable…) y origen ya no se muestran en la tarjeta:
            se siguen guardando para los KPIs (Erik, 30-ago-2026). */}
        {/* Los .tag apagan a propósito el quiebre de palabra del body; aquí
            el contenido es dato libre y hay que reponerlo o desborda. */}
        {i.area_responsable && (
          <span className="tag" style={{ overflowWrap: 'anywhere', maxWidth: '100%' }}>
            → {i.area_responsable}
          </span>
        )}
        {/* Rastro visible de la reasignación: quien la recibe ve de un
            vistazo que antes le pertenecía a otra área. */}
        {i.reasignada_de && (
          <span
            className="pill multilinea"
            style={{ background: '#a78bfa22', color: '#a78bfa' }}
            title={`Reasignada: antes pertenecía a ${i.reasignada_de}`}
          >
            🔁 Antes: {i.reasignada_de}
          </span>
        )}
        {redirigida && (
          <span
            className="pill multilinea"
            style={{ background: '#ff5a3c22', color: '#ff5a3c' }}
            title="Área que realmente repara (el catálogo decía otra)"
          >
            🛠 Repara: {i.assigned_area}
          </span>
        )}
        {i.campania && (
          <span className="tag" style={{ overflowWrap: 'anywhere', maxWidth: '100%' }}>
            🎯 {i.campania}
          </span>
        )}
        {/* Rastro visible de los rechazos: el motivo se sobrescribe con cada
            rechazo nuevo, así que sin este chip dos rechazos se ven igual
            que uno. El contador lo lleva la base (trigger). */}
        {(i.rechazos_reparacion || 0) > 0 && (
          <span
            className="pill multilinea"
            style={{ background: '#ef444422', color: '#ef4444' }}
            title="Veces que el validador rechazó la reparación"
          >
            ↩ {i.rechazos_reparacion} rechazo
            {(i.rechazos_reparacion || 0) > 1 ? 's' : ''} de reparación
          </span>
        )}
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
          <button
            className="btn ghost sm"
            onClick={() => onEdit(i)}
            disabled={bloqueadaRed}
          >
            ✏️ Editar
          </button>
        )}
        {i.estatus === 'en_proceso' &&
          !i.reasignacion_pendiente &&
          can.reasignar && (
            <button
              className="btn ghost sm"
              onClick={() => onReassign(i, 'solicitar')}
              disabled={bloqueadaRed}
            >
              🔀 Reasignar
            </button>
          )}
        {i.reasignacion_pendiente && can.aprobarReasign && (
          <button
            className="btn ghost sm"
            onClick={() => onReassign(i, 'aprobar')}
            disabled={bloqueadaRed}
          >
            🔀 Revisar reasignación
          </button>
        )}
        {puedeCorregir && (
          <button
            className="btn ghost sm"
            onClick={() => onCorregir(i)}
            disabled={bloqueadaRed}
          >
            🧭 Corrección
          </button>
        )}
      </div>
      {can.validar && i.estatus === 'por_validar' && (
        <div className="inc-actions">
          {/* UN SOLO BOTÓN. Estuvo partido en "Validar" y "Validar y asignar"
              mientras existió la asignación de técnico; al quitarse ésta, la
              segunda mitad se quedó sin nada que hacer.

              El rechazo tampoco está aquí: ver la nota del final. */}
          <button
            className="btn ok sm"
            onClick={() => onEstatus(i.record_id, 'en_proceso')}
            disabled={bloqueada}
          >
            ✓ Validar incidencia
          </button>
        </div>
      )}

      {prevalidacionPend && (
        <div style={{ marginTop: 9 }}>
          {/* multilinea: la frase completa mide ~320px en nowrap y en un
              teléfono ensanchaba TODA la lista de tarjetas (los items del
              grid no encogen por debajo de su min-content). */}
          <span
            className="pill multilinea"
            style={{ background: '#4f8cff22', color: '#4f8cff' }}
          >
            ⚡ Directa a Digital · prevalidación pendiente
          </span>
        </div>
      )}
      {puedeReparar && i.estatus === 'en_proceso' && prevalidacionPend && (
        <div className="inc-actions">
          <button
            className="btn ok sm"
            onClick={() => onPrevalidar(i)}
            disabled={bloqueada}
          >
            ✓ Prevalidar
          </button>
          <button
            className="btn hi sm"
            onClick={() => onDescartar(i)}
            disabled={bloqueada}
          >
            ✕ Descartar
          </button>
        </div>
      )}
      {puedeReparar && i.estatus === 'en_proceso' && !prevalidacionPend && (
        <div className="inc-actions">
          <button
            className="btn warn sm"
            onClick={() => onRepair(i)}
            disabled={bloqueada}
          >
            🔧 Registrar reparación
          </button>
        </div>
      )}
      {can.validar && i.estatus === 'reparado' && (
        <div className="inc-actions">
          <button
            className="btn ok sm"
            disabled={bloqueada}
            onClick={() => {
              // Aprobar CIERRA la incidencia y ya no hay vuelta atrás desde
              // la app: merece el mismo seguro que salir con captura a
              // medias. El rechazo no lo necesita — su modal de motivo ya
              // es un paso deliberado.
              if (
                !confirm(
                  `¿Aprobar la reparación de ${i.folio || 'esta incidencia'}? ` +
                    'La incidencia se cierra.'
                )
              )
                return;
              onEstatus(i.record_id, 'cerrada');
            }}
          >
            ✓ Aprobar reparación
          </button>
          <button
            className="btn hi sm"
            onClick={() => onRechazarRep(i)}
            disabled={bloqueada}
          >
            ✕ Rechazar (regresar al área)
          </button>
        </div>
      )}
    </div>
  );
}

export default IncCard;

// ============================================================
// NOTA — POR QUÉ YA NO HAY "RECHAZAR" EN LA VALIDACIÓN DE CAPTURA
// ============================================================
// Se quitó a petición de Erik el 26-ago-2026, con el argumento de que ya
// existe un rechazo en la etapa de reparación. Son dos cosas distintas y vale
// la pena que quede escrito, porque la diferencia se nota hasta que estorba:
//
//   Rechazar reparación (sigue ahí)  El trabajo se hizo mal. Regresa al ÁREA
//                                    para que lo rehaga. Estado: en_proceso.
//
//   Rechazar captura (se quitó)      El reporte está mal: sitio equivocado,
//                                    duplicado, o no es una incidencia.
//                                    Regresaba al REPORTANTE. Estado:
//                                    rechazada.
//
// CONSECUENCIA: `rechazada` ya no se puede alcanzar desde la app. Con eso
// quedan sin uso el botón ✏️ Editar del reportante en ese estado, y la rama
// de aviso `rechazada` que se agregó en `ajustes_incidencias_base.sql`.
// Ninguna de las dos estorba —hay filas viejas en ese estado y la RLS lo
// sigue permitiendo— pero tampoco se van a ejercitar.
//
// Y queda una pregunta abierta: qué hace el validador con un reporte que está
// mal. Hoy sus únicas salidas son aprobarlo —y meterle carga a un área por
// algo que no existe, que además le cuenta en los indicadores— o dejarlo en
// `por_validar` para siempre. Si eso empieza a doler, la vuelta es traer este
// botón con otro nombre ("↩ Devolver al reportante"), no inventar un estado
// nuevo: el flujo completo ya existe del otro lado.

// ============================================================
// NOTA — SE QUITÓ TODO LO DE ASIGNAR TÉCNICO (ago-2026)
// ============================================================
// Por decisión de Erik. La razón de fondo: eran DOS modelos distintos
// conviviendo, y el segundo es el que la operación necesita.
//
//   MODELO VIEJO — la persona.  Un coordinador reparte incidencias entre
//     técnicos de tres áreas (AREAS_ASIGNABLES). El trabajo "es de alguien".
//
//   MODELO NUEVO — la máquina.  El operador llega a su sitio y ve TODO lo
//     abierto ahí, sea de quien sea. Si le toca, lo repara; si no, va con
//     quien le toca y pregunta por qué sigue detenido. El trabajo "es del
//     área", y la máquina es de su operador.
//
// Con los dos encendidos, una incidencia podía estar asignada a un técnico y
// al mismo tiempo ser responsabilidad del operador del sitio, sin que ninguno
// de los dos supiera cuál de las dos cosas mandaba.
//
// QUÉ SE QUITÓ: el botón, el modal, el chip 👷, el filtro "Mis asignadas", la
// constante AREAS_ASIGNABLES y el segundo botón de validar.
//
// QUÉ NO SE TOCÓ, y por qué:
//   · Las columnas `asignado_tecnico`, `asignado_tecnico_email`,
//     `asignado_por`, `asignado_en` y `assigned_to` siguen en la base con lo
//     que ya tenían. Borrarlas perdería el histórico de quién estuvo asignado
//     a qué, que es dato real aunque el flujo cambie.
//   · El trigger `notificar_tecnico` queda DESACTIVADO, no borrado
//     (ver quitar_asignacion_tecnico.sql). Reactivarlo es una línea.
//   · `repaired_by_email` no tiene nada que ver con esto y sigue igual: es
//     quien REGISTRÓ la reparación, y de ahí sale "Quién repara más". Que el
//     operador arregle algo y se le cuente sigue funcionando exactamente
//     igual que antes.
