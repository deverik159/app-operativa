// ============================================================
// src/modules/incidencias/CorreccionModal.tsx
// Corrección del validador: cambia QUÉ incidencia es.
//
// POR QUÉ EXISTE, Y POR QUÉ NO ES EL EditModal DE ANTES:
//
// El EditModal viejo dejaba al validador escoger a mano `nivel`, `origen`,
// `tipo` y `area_responsable`. Eso permitía que la incidencia dijera
// "Apagado (Iluminación)" y al mismo tiempo tuviera área "Digital" y nivel
// "Bajo" — una combinación que el catálogo nunca produciría. A partir de ahí
// los indicadores miden algo que no existe: la carga se le carga a un área
// que no clasificó nada.
//
// Aquí solo se elige la ENTRADA DEL CATÁLOGO. Los cuatro campos derivados se
// muestran de solo lectura y se recalculan solos. La regla del negocio vive
// en `catalogo_incidencias`, que es donde se puede mantener sin tocar código.
//
// LO QUE NO SE TOCA: `assigned_area`. Si alguien ya había redirigido la
// reparación a otra área, esa decisión se respeta (decisión de Erik,
// ago-2026). Corregir la clasificación no deshace quién la está reparando.
//
// SIN SEÑAL (modo sin señal, 24-sep-2026): el catálogo sale de la red con
// tope corto o de la copia del teléfono (lib/datosLocales.ts). GUARDAR sí
// necesita señal: la corrección no se encola, y sin red se dice claro.
//
// La elección del catálogo vive en SelectorFalla, que comparte con la
// corrección del reportante (EditModal, 13-oct-2026).
//
// CAMPAÑA (Erik, 24-nov-2026): el validador también la corrige aquí, con el
// mismo campo que el reportante (CampoCampania).
// ============================================================
import { Clock, Wrench } from 'lucide-react';
import { useState } from 'react';
import { sb } from '../../lib/supabase';
import { haySenal } from '../../lib/datosLocales';
import { ladoAlReclasificar } from '../../lib/catalogo';
import { descartarDuplicada, duplicadasEnProceso, ErrorConsultaDuplicados } from '../../lib/duplicados';
import { tope } from '../../lib/envios';
import { pareceSinRed } from '../../lib/enLinea';
import { tieneAreaRedirigida } from '../../lib/helpers';
import { vigilarRender } from '../../lib/vigia';
import type { CatalogoIncidencia, Incidencia } from '../../types/db';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';
import SelectorFalla, { Derivado } from './SelectorFalla';
import CampoCampania from './CampoCampania';

type Props = {
  inc: Incidencia;
  onClose: () => void;
  onDone: (recordId: string, patch: Partial<Incidencia>) => void;
};

const SIN_SENAL = 'Necesitas señal para esto.';

/**
 * ¿Hay sesión real para escribir? (modo sin señal, 24-sep-2026). En la
 * ventana en que auth-js aún no renueva el token, el UPDATE saldría como
 * anónimo y la RLS lo dejaría en 0 filas sin error. Tope de 3 s: sin red y
 * con el token vencido, getSession espera la renovación.
 */
function haySesionReal(): Promise<boolean> {
  return Promise.race([
    sb.auth.getSession().then(
      ({ data }) => !!data.session,
      () => false
    ),
    new Promise<boolean>((res) => setTimeout(() => res(false), 3000)),
  ]);
}

function CorreccionModal({ inc, onClose, onDone }: Props) {
  // Ciclo de renders que no suelta el hilo → error del módulo (app pasmada
  // sin señal, 24-sep-2026; ver lib/vigia.ts).
  vigilarRender('CorreccionModal');
  /** La entrada del catálogo elegida (SelectorFalla). */
  const [sel, setSel] = useState<CatalogoIncidencia | null>(null);
  const [observaciones, setObservaciones] = useState(inc.observaciones || '');
  const [campania, setCampania] = useState(inc.campania || '');
  const [busy, setBusy] = useState(false);
  /**
   * La corrección chocó con otra igual en proceso (23-nov-2026): en vez de
   * guardar, se ofrece «Descartar como duplicada de <folio>».
   */
  const [choque, setChoque] = useState<{ detalle: string; folios: string[] } | null>(null);
  const [errDup, setErrDup] = useState('');
  // Solo se descarta una por validar, en proceso o devuelta (lo revisa la base).
  const puedeDescartar = ['por_validar', 'en_proceso', 'rechazada'].includes(inc.estatus);

  const descartar = async (folio: string) => {
    if (!choque) return;
    if (!haySenal()) {
      setErrDup(SIN_SENAL);
      return;
    }
    setBusy(true);
    setErrDup('');
    if (!(await haySesionReal())) {
      setBusy(false);
      setErrDup(SIN_SENAL);
      return;
    }
    try {
      const patch = await descartarDuplicada(inc.record_id, folio, choque.detalle, tope(30000));
      setBusy(false);
      onDone(inc.record_id, patch);
    } catch (e) {
      setBusy(false);
      setErrDup(
        pareceSinRed(e)
          ? 'La red no respondió. Revisa la incidencia antes de volver a intentarlo: pudo haberse guardado.'
          : (e as { message?: string })?.message || String(e)
      );
    }
  };

  // `impacto` en el catálogo viene con espacios de sobra; `nivel` no.
  const nivelNuevo = (sel?.impacto || '').trim();
  const areaNueva = (sel?.area || '').trim();
  const cambiaArea = !!sel && areaNueva !== (inc.area_responsable || '');
  const redirigida = tieneAreaRedirigida(inc);
  // Entra o sale del Adicional o la Puerta: su cara afectada lo sigue.
  const ladoNuevo = sel ? ladoAlReclasificar(inc.lado, sel.detalle) : undefined;

  // El trigger `set_sla` tiene esta regla, verificada el 26-ago-2026:
  //
  //   if estatus = 'en_proceso' and area_responsable cambió
  //   then sla_reparacion_inicio := now();
  //
  // O sea: corregir el área de algo que ya está en proceso pone el reloj en
  // cero. Probablemente es lo correcto —el área nueva no tiene por qué
  // cargar con el retraso de la anterior— pero es un efecto invisible desde
  // la pantalla, y de los que después nadie sabe explicar por qué el
  // indicador de un área se ve mejor de lo que fue. Se avisa antes.
  const reiniciaSla = cambiaArea && inc.estatus === 'en_proceso';

  const guardar = async () => {
    if (!sel) {
      alert('Elige del catálogo qué incidencia es.');
      return;
    }
    // La corrección no se encola (modo sin señal, 24-sep-2026).
    if (!haySenal()) {
      alert(SIN_SENAL);
      return;
    }
    setBusy(true);
    if (!(await haySesionReal())) {
      setBusy(false);
      alert(SIN_SENAL);
      return;
    }
    // ══ REGLA DE DUPLICIDAD (Erik, 23-nov-2026) ══ La misma que al levantar
    // una incidencia (lib/duplicados.ts): si con la falla corregida ya hay
    // otra igual EN PROCESO en la misma cara, no se guarda. Pasó con
    // EVD00040 y EVD00041: una se corrigió a «Estructura con grafiti» en la
    // cara donde la otra ya estaba en proceso, y quedaron dos. Si la consulta
    // falla por red, se pide señal; si falla por otra cosa, no frena (mejor
    // esfuerzo, igual que al capturar).
    if (sel.detalle !== inc.nombre_incidencia) {
      try {
        const choques = (
          await duplicadasEnProceso(
            [
              {
                clave_medio: inc.clave_medio,
                clave_sitio: inc.clave_sitio,
                lado: ladoNuevo !== undefined ? ladoNuevo : inc.lado,
                nombre_incidencia: sel.detalle,
                unidad_negocio: inc.unidad_negocio,
                medio: inc.medio,
              },
            ],
            { lanzarSiFalla: true }
          )
        ).filter((c) => c.folio !== inc.folio);
        if (choques.length) {
          // No se guarda: se ofrece descartarla como duplicada (abajo).
          setBusy(false);
          setChoque({
            detalle: sel.detalle,
            folios: [...new Set(choques.map((c) => c.folio).filter((f): f is string => !!f))],
          });
          return;
        }
      } catch (err) {
        const st = err instanceof ErrorConsultaDuplicados ? err.status : 0;
        if (!haySenal() || !st || st === 401 || st >= 500) {
          setBusy(false);
          alert(SIN_SENAL);
          return;
        }
      }
    }
    // Solo estos (y `lado` si entra o sale del Adicional o la Puerta).
    // `assigned_area` queda fuera a propósito.
    const patch: Partial<Incidencia> = {
      nombre_incidencia: sel.detalle,
      nivel: nivelNuevo || null,
      origen: (sel.origen || '').trim() || null,
      tipo: (sel.tipo || '').trim() || null,
      area_responsable: areaNueva || null,
      observaciones: observaciones.trim() || null,
      campania: campania.trim() || null,
      ...(ladoNuevo !== undefined ? { lado: ladoNuevo } : {}),
    };
    // Se CUENTA lo afectado (modo sin señal, 24-sep-2026): la RLS que no deja
    // pasar la fila responde 0 filas SIN error, y antes eso se daba por
    // guardado y la tarjeta enseñaba una corrección que la base no tenía.
    // `count` y no `.select()`: devolver la fila exigiría que el validador
    // pueda LEERLA ya con el área nueva, y esa política no está a la vista.
    // Solo un 0 explícito cuenta como "no se guardó".
    const { error, status, count } = await sb
      .from('incidencias')
      .update(patch, { count: 'exact' })
      .eq('record_id', inc.record_id);
    setBusy(false);
    if (error) {
      // status 0 = sin respuesta; 401/5xx = sesión o servidor de paso.
      const deRed = !haySenal() || !status || status === 401 || status >= 500;
      alert(deRed ? SIN_SENAL : 'No se pudo corregir: ' + error.message);
      return;
    }
    if (count === 0) {
      alert(
        'No se guardó la corrección: tu rol o tu área no permiten cambiar esta ' +
          'incidencia. Refresca con ↻ (Recargar) y revisa cómo quedó.'
      );
      return;
    }
    onDone(inc.record_id, patch);
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onClose();
      }}
    >
      <div className="modal">
        <CerrarModal onClick={onClose} />
        <h2 style={{ margin: '0 0 3px' }}>Corregir clasificación</h2>
        <p className="phint">
          {inc.folio} · {inc.clave_sitio}
        </p>

        <div className="banner" style={{ marginBottom: 14 }}>
          Aquí se corrige <b>qué incidencia es</b>. El nivel y el área
          responsable los pone el catálogo — por eso salen de solo lectura y
          cambian solos al elegir otra entrada.
        </div>

        <SelectorFalla
          unidad={inc.unidad_negocio}
          mueble={inc.tipo_mueble}
          actual={inc.nombre_incidencia}
          onElegir={(c) => {
            setSel(c);
            // Otra falla: el choque anterior ya no aplica.
            setChoque(null);
            setErrDup('');
          }}
        />

        {/* Origen y tipo se siguen recalculando y guardando con el patch;
            solo dejaron de mostrarse (Erik, 30-ago-2026). */}
        <div className="row2">
          <Derivado label="Nivel" valor={nivelNuevo} />
          <Derivado label="Área responsable" valor={areaNueva} />
        </div>

        {cambiaArea && (
          // Caja de aviso ámbar con pareja en el tema claro (tema
          // claro/oscuro, 24-sep-2026).
          <div
            style={{
              background: 'var(--aviso-fondo)',
              border: '1px solid var(--aviso-borde)',
              borderRadius: 10,
              padding: '10px 12px',
              margin: '4px 0 12px',
              fontSize: 13,
              color: 'var(--aviso-txt)',
            }}
          >
            ⚠️ El área responsable pasa de{' '}
            <b>{inc.area_responsable || '—'}</b> a <b>{areaNueva || '—'}</b>. Es
            la que miden los indicadores de carga.
            {reiniciaSla && (
              <>
                <br />
                <br />
                <Ic i={Clock} />Como ya está <b>en proceso</b>, el reloj del SLA se reinicia:{' '}
                {areaNueva || 'el área nueva'} empieza con su plazo completo y
                el retraso acumulado hasta ahora deja de contarse.
              </>
            )}
            {/* Mismas condiciones que trg_notificar_correccion_area
                (migración 20261016164756): en proceso, área nueva y sin
                assigned_area, que es la que repara y no cambia. */}
            {reiniciaSla && !inc.assigned_area && areaNueva && (
              <>
                <br />
                <br />
                Se avisará a los técnicos de <b>{areaNueva}</b>.
              </>
            )}
          </div>
        )}

        {ladoNuevo !== undefined && (
          <div className="phint" style={{ margin: '0 0 12px' }}>
            {ladoNuevo
              ? <>La cara afectada pasa a ser <b>{ladoNuevo}</b>.</>
              : <>Deja de ser {inc.lado === 'Puerta' ? 'de la puerta' : 'del adicional'}: la cara afectada queda vacía.</>}
          </div>
        )}

        {redirigida && (
          <div
            style={{
              background: 'var(--panel2)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '10px 12px',
              marginBottom: 12,
              fontSize: 13,
              color: 'var(--muted)',
            }}
          >
            <Ic i={Wrench} />La sigue reparando <b>{inc.assigned_area}</b>. Corregir la
            clasificación no cambia eso; si ya no le toca, pídele al área que
            solicite la reasignación.
          </div>
        )}

        <CampoCampania
          valor={campania}
          onCambio={setCampania}
          unidad={inc.unidad_negocio}
          cara={inc.clave_medio}
          fechaReporte={inc.fecha_reporte}
        />

        <div className="field">
          <label>Observaciones</label>
          <textarea
            rows={2}
            value={observaciones}
            onChange={(e) => setObservaciones(e.target.value)}
          />
        </div>

        {choque && (
          // Regla de duplicidad (23-nov-2026): no se guardó la corrección.
          <div
            role="alert"
            style={{
              background: 'var(--aviso-fondo)',
              border: '1px solid var(--aviso-borde)',
              borderRadius: 10,
              padding: '10px 12px',
              margin: '4px 0 12px',
              fontSize: 13,
              color: 'var(--aviso-txt)',
            }}
          >
            Ya hay una «{choque.detalle}» en proceso en esta cara:{' '}
            <b>{choque.folios.join(', ') || '—'}</b>. No se guardó la corrección.
            {puedeDescartar && choque.folios.length > 0 ? (
              <>
                <br />
                Si es el mismo trabajo, descártala como duplicada: no cuenta en los
                indicadores y al reportante le llega un aviso (no le queda pendiente).
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  {choque.folios.map((f) => (
                    <button
                      key={f}
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() => void descartar(f)}
                    >
                      {busy ? 'Guardando…' : `Descartar como duplicada de ${f}`}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {errDup && (
              <div className="err" style={{ marginTop: 8 }}>
                {errDup}
              </div>
            )}
          </div>
        )}

        <div className="modal-actions pie-fijo">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn" onClick={guardar} disabled={busy || !sel}>
            {busy ? 'Guardando…' : 'Guardar corrección'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CorreccionModal;
