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
// ============================================================
import { useState, useEffect, useMemo } from 'react';
import { sb } from '../../lib/supabase';
import {
  catalogoParaMuebles,
  llaveCatalogo,
  filtrarCatalogo,
} from '../../lib/catalogo';
import type { OpcionesCatalogo } from '../../lib/catalogo';
import { tieneAreaRedirigida } from '../../lib/helpers';
import type { CatalogoIncidencia, Incidencia } from '../../types/db';

type Props = {
  inc: Incidencia;
  onClose: () => void;
  onDone: (recordId: string, patch: Partial<Incidencia>) => void;
};

/** Fila de solo lectura: lo que el catálogo decide y aquí no se discute. */
function Derivado({ label, valor }: { label: string; valor: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div
        style={{
          background: 'var(--panel2)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: '10px 12px',
          fontSize: 14,
          color: valor ? 'var(--txt)' : 'var(--muted)',
        }}
      >
        {valor || '—'}
      </div>
    </div>
  );
}

function CorreccionModal({ inc, onClose, onDone }: Props) {
  const [cat, setCat] = useState<OpcionesCatalogo>({
    opciones: [],
    restringido: false,
    sinCatalogo: [],
  });
  const [loading, setLoading] = useState(true);
  const [errCat, setErrCat] = useState('');
  const [llave, setLlave] = useState('');
  const [busca, setBusca] = useState('');
  const [observaciones, setObservaciones] = useState(inc.observaciones || '');
  const [busy, setBusy] = useState(false);

  // El catálogo se filtra por unidad, igual que en el alta. `ilike` porque la
  // unidad viene escrita distinto entre tablas ('Biobox' vs 'BIOBOX').
  useEffect(() => {
    let vivo = true;
    (async () => {
      // `select('*')` y no la lista de columnas: si el catálogo tiene
      // `tipo_medio`, viene; y si no la tiene, no truena. Pedirla por nombre
      // daría 400 y el modal se quedaría vacío sin decir por qué.
      const { data, error } = await sb
        .from('catalogo_incidencias')
        .select('*')
        .ilike('unidad_negocio', inc.unidad_negocio || '%')
        .limit(1000);
      if (!vivo) return;
      if (error) setErrCat('No se pudo cargar el catálogo: ' + error.message);
      // Se RESTRINGE al mueble de esta cara. Ahí cada incidencia existe una
      // sola vez y el área ya viene decidida: es lo que evita que "Adicional
      // dañado" en una cara impresa salga dirigida a Digital.
      setCat(
        catalogoParaMuebles((data as CatalogoIncidencia[]) || [], [
          inc.tipo_mueble,
        ])
      );
      setLoading(false);
    })();
    return () => {
      vivo = false;
    };
  }, [inc.unidad_negocio, inc.tipo_mueble]);

  // Preselección: si el nombre actual existe en el catálogo, se marca solo.
  // Si no existe (incidencia vieja, o texto capturado a mano), se deja en
  // blanco a propósito — eso ES el motivo por el que hay que corregirla.
  useEffect(() => {
    if (!cat.opciones.length || llave) return;
    const actual = cat.opciones.find((c) => c.detalle === inc.nombre_incidencia);
    if (actual) setLlave(llaveCatalogo(actual));
  }, [cat, inc.nombre_incidencia, llave]);

  const sel = useMemo(
    () => cat.opciones.find((c) => llaveCatalogo(c) === llave) || null,
    [cat, llave]
  );

  // La opción elegida se conserva siempre en la lista, aunque el texto del
  // buscador ya no la encuentre. Si no, escribir después de elegir la haría
  // desaparecer del `select` y el navegador mostraría otra cosa como
  // seleccionada — se guardaría una incidencia distinta de la que se ve.
  const visibles = useMemo(() => {
    const base = filtrarCatalogo(cat.opciones, busca);
    if (sel && !base.some((c) => llaveCatalogo(c) === llave)) return [sel, ...base];
    return base;
  }, [cat, busca, sel, llave]);

  // `impacto` en el catálogo viene con espacios de sobra; `nivel` no.
  const nivelNuevo = (sel?.impacto || '').trim();
  const areaNueva = (sel?.area || '').trim();
  const cambiaArea = !!sel && areaNueva !== (inc.area_responsable || '');
  const redirigida = tieneAreaRedirigida(inc);

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
    setBusy(true);
    // Solo estos cinco. `assigned_area` queda fuera a propósito.
    const patch: Partial<Incidencia> = {
      nombre_incidencia: sel.detalle,
      nivel: nivelNuevo || null,
      origen: (sel.origen || '').trim() || null,
      tipo: (sel.tipo || '').trim() || null,
      area_responsable: areaNueva || null,
      observaciones: observaciones.trim() || null,
    };
    const { error } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id);
    setBusy(false);
    if (error) {
      alert('No se pudo corregir: ' + error.message);
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
        <h2 style={{ margin: '0 0 3px' }}>Corregir clasificación</h2>
        <p className="phint">
          {inc.folio} · {inc.clave_sitio}
        </p>

        {errCat && <div className="err">{errCat}</div>}

        <div className="banner" style={{ marginBottom: 14 }}>
          Aquí se corrige <b>qué incidencia es</b>. El nivel, el origen, el tipo
          y el área responsable los pone el catálogo — por eso salen de solo
          lectura y cambian solos al elegir otra entrada.
        </div>

        <div className="field">
          <label>
            Incidencia (del catálogo · {visibles.length} de{' '}
            {cat.opciones.length}
            {cat.restringido ? ` · ${inc.tipo_mueble}` : ''})
          </label>
          {loading ? (
            <div className="loading">Cargando catálogo…</div>
          ) : (
            <>
              <input
                placeholder="Buscar por incidencia o por área…"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                style={{ marginBottom: 8 }}
              />
              <select value={llave} onChange={(e) => setLlave(e.target.value)}>
                <option value="">— Selecciona —</option>
                {visibles.map((c) => (
                  <option key={llaveCatalogo(c)} value={llaveCatalogo(c)}>
                    {c.detalle}
                    {c.area ? ` (${c.area})` : ''}
                  </option>
                ))}
              </select>
              {cat.sinCatalogo.length > 0 && (
                <div
                  style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}
                >
                  ⚠️ El catálogo no tiene entradas para el mueble{' '}
                  <b>{cat.sinCatalogo.join(', ')}</b>: salen todas las
                  incidencias y el área no viene decidida. Fíjate en el área
                  entre paréntesis.
                </div>
              )}
              {busca && visibles.length === 0 && (
                <div
                  style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}
                >
                  Nada coincide con “{busca}”.
                </div>
              )}
            </>
          )}
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            Ahora dice: “{inc.nombre_incidencia || '—'}”
          </div>
        </div>

        <div className="row2">
          <Derivado label="Nivel" valor={nivelNuevo} />
          <Derivado label="Origen" valor={(sel?.origen || '').trim()} />
        </div>
        <div className="row2">
          <Derivado label="Tipo" valor={(sel?.tipo || '').trim()} />
          <Derivado label="Área responsable" valor={areaNueva} />
        </div>

        {cambiaArea && (
          <div
            style={{
              background: '#3a2e12',
              border: '1px solid #6a5520',
              borderRadius: 10,
              padding: '10px 12px',
              margin: '4px 0 12px',
              fontSize: 13,
              color: '#ffdf9e',
            }}
          >
            ⚠️ El área responsable pasa de{' '}
            <b>{inc.area_responsable || '—'}</b> a <b>{areaNueva || '—'}</b>. Es
            la que miden los indicadores de carga.
            {reiniciaSla && (
              <>
                <br />
                <br />
                ⏱ Como ya está <b>en proceso</b>, el reloj del SLA se reinicia:{' '}
                {areaNueva || 'el área nueva'} empieza con su plazo completo y
                el retraso acumulado hasta ahora deja de contarse.
              </>
            )}
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
            🛠 La sigue reparando <b>{inc.assigned_area}</b>. Corregir la
            clasificación no cambia eso; si ya no le toca, pídele al área que
            solicite la reasignación.
          </div>
        )}

        <div className="field">
          <label>Observaciones</label>
          <textarea
            rows={2}
            value={observaciones}
            onChange={(e) => setObservaciones(e.target.value)}
          />
        </div>

        <div className="modal-actions">
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
