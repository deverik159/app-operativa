// ============================================================
// src/modules/biobox/ChecklistConfigModal.tsx
// Edición del checklist desde la app (solo coordinación).
//
// El checklist es catálogo, no código: los puntos a revisar los define quien
// opera las máquinas, y los va a cambiar conforme aprenda qué se rompe. Si
// vivieran en el código, cada ajuste sería un despliegue.
//
// LO QUE MÁS IMPORTA DE ESTA PANTALLA es la columna "incidencia": ligar un
// punto con una entrada del catálogo de incidencias es lo que hace que, al
// marcar una anomalía en campo, la incidencia salga ya con su área, su nivel
// y su SLA correctos, sin que el revisor tenga que saber nada de eso.
//
// Editar un punto NO reescribe el pasado: las revisiones ya hechas guardan su
// propia copia del texto (ver revisiones_schema.sql, nota 2).
// ============================================================
import { useState, useEffect } from 'react';
import { sb } from '../../lib/supabase';
import { catalogoUnico, llaveCatalogo } from '../../lib/catalogo';
import type {
  ChecklistPlantilla,
  ChecklistPunto,
  CatalogoIncidencia,
} from '../../types/db';

type Props = {
  unidad: string;
  tipo: string;
  email: string;
  onClose: () => void;
};

/** Fila en edición. `id` negativo = todavía no existe en la base. */
type Fila = ChecklistPunto & { sucia?: boolean };

function ChecklistConfigModal({ unidad, tipo, email, onClose }: Props) {
  // Hay un checklist POR TIPO DE MEDIO: una máquina digital no se revisa
  // como una impresa. El selector de aquí decide cuál se está editando.
  const [tipoSel, setTipoSel] = useState(tipo);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [plantilla, setPlantilla] = useState<ChecklistPlantilla | null>(null);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [catalogo, setCatalogo] = useState<CatalogoIncidencia[]>([]);
  const [nuevoId, setNuevoId] = useState(-1);

  const cargar = async () => {
    setCargando(true);
    const [pl, cat] = await Promise.all([
      sb
        .from('checklist_plantillas')
        .select('*')
        .eq('unidad_negocio', unidad)
        // Los MISMOS filtros y el mismo orden que RevisionModal. Si aquí se
        // omitiera `activa`, se editaría una plantilla desactivada mientras
        // el campo usa otra: dos checklists distintos con la misma pantalla.
        .eq('activa', true)
        .or(`tipo_medio.eq.${tipoSel},tipo_medio.is.null`)
        .order('tipo_medio', { nullsFirst: false })
        .order('id')
        .limit(1),
      sb
        .from('catalogo_incidencias')
        .select('detalle,area,impacto,origen,tipo,tipo_mueble')
        .ilike('unidad_negocio', unidad)
        .order('detalle'),
    ]);

    if (pl.error) {
      setErr('No se pudo cargar: ' + pl.error.message);
      setCargando(false);
      return;
    }
    // Se colapsa aquí, una sola vez, en vez de en cada render del select.
    // El catálogo trae la misma incidencia repetida por tipo de medio.
    setCatalogo(catalogoUnico((cat.data as CatalogoIncidencia[]) || []));

    const p = ((pl.data as ChecklistPlantilla[]) || [])[0] || null;
    setPlantilla(p);
    if (!p) {
      setFilas([]);
      setCargando(false);
      return;
    }
    const { data } = await sb
      .from('checklist_puntos')
      .select('*')
      .eq('plantilla_id', p.id)
      // `activo` es indispensable: `quitar()` desactiva en vez de borrar, y
      // sin este filtro el punto "borrado" reaparecería en el editor al
      // recargar —editable pero invisible en campo para siempre—.
      .eq('activo', true)
      .order('orden')
      .order('id');
    setFilas(((data as ChecklistPunto[]) || []).map((x) => ({ ...x })));
    setCargando(false);
  };

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unidad, tipoSel]);

  const crearPlantilla = async () => {
    setGuardando(true);
    setErr('');
    const { data, error } = await sb
      .from('checklist_plantillas')
      .insert({
        nombre: `Revisión de máquina ${tipoSel.toLowerCase()}`,
        unidad_negocio: unidad,
        tipo_medio: tipoSel,
        descripcion: 'Hoja de vida. Se llena en cada visita de ruta.',
        creada_por: email,
      })
      .select()
      .single();
    setGuardando(false);
    if (error) {
      setErr('No se pudo crear el checklist: ' + error.message);
      return;
    }
    setPlantilla(data as ChecklistPlantilla);
    setFilas([]);
  };

  const editar = (id: number, campo: keyof ChecklistPunto, v: unknown) =>
    setFilas((prev) =>
      prev.map((f) => (f.id === id ? { ...f, [campo]: v, sucia: true } : f))
    );

  const agregar = () => {
    if (!plantilla) return;
    // El orden salta de 10 en 10: deja hueco para meter un punto en medio sin
    // renumerar todo.
    const max = filas.reduce((m, f) => Math.max(m, f.orden), 0);
    setFilas((prev) => [
      ...prev,
      {
        id: nuevoId,
        plantilla_id: plantilla.id,
        orden: max + 10,
        grupo: filas[filas.length - 1]?.grupo || 'General',
        texto: '',
        ayuda: null,
        incidencia_sugerida: null,
        exige_foto_anomalia: true,
        critico: false,
        activo: true,
        sucia: true,
      },
    ]);
    setNuevoId((n) => n - 1);
  };

  const quitar = async (f: Fila) => {
    if (f.id < 0) {
      setFilas((prev) => prev.filter((x) => x.id !== f.id));
      return;
    }
    if (
      !confirm(
        'Se desactiva este punto. Las revisiones ya hechas lo conservan; solo ' +
          'deja de aparecer en las nuevas. ¿Continuar?'
      )
    )
      return;
    // Desactivar en vez de borrar: un DELETE dejaría `punto_id` en NULL en
    // las respuestas históricas y se perdería el hilo con el catálogo.
    const { error } = await sb
      .from('checklist_puntos')
      .update({ activo: false })
      .eq('id', f.id);
    if (error) setErr('No se pudo desactivar: ' + error.message);
    else setFilas((prev) => prev.filter((x) => x.id !== f.id));
  };

  const guardar = async () => {
    if (!plantilla) return;
    const sucias = filas.filter((f) => f.sucia);
    const vacias = sucias.filter((f) => !f.texto.trim());
    if (vacias.length) {
      setErr('Hay puntos sin texto. Escríbelos o quítalos.');
      return;
    }
    setGuardando(true);
    setErr('');
    setOk('');

    const nuevas = sucias.filter((f) => f.id < 0);
    const existentes = sucias.filter((f) => f.id > 0);

    if (nuevas.length) {
      const { error } = await sb.from('checklist_puntos').insert(
        nuevas.map((f) => ({
          plantilla_id: plantilla.id,
          orden: f.orden,
          grupo: f.grupo || null,
          texto: f.texto.trim(),
          ayuda: f.ayuda || null,
          incidencia_sugerida: f.incidencia_sugerida || null,
          exige_foto_anomalia: f.exige_foto_anomalia,
          critico: f.critico,
          activo: true,
        }))
      );
      if (error) {
        setGuardando(false);
        setErr('No se pudieron agregar los puntos nuevos: ' + error.message);
        return;
      }
    }

    for (const f of existentes) {
      const { error } = await sb
        .from('checklist_puntos')
        .update({
          orden: f.orden,
          grupo: f.grupo || null,
          texto: f.texto.trim(),
          ayuda: f.ayuda || null,
          incidencia_sugerida: f.incidencia_sugerida || null,
          exige_foto_anomalia: f.exige_foto_anomalia,
          critico: f.critico,
        })
        .eq('id', f.id);
      if (error) {
        setGuardando(false);
        setErr('No se pudo guardar "' + f.texto + '": ' + error.message);
        return;
      }
    }

    setGuardando(false);
    setOk(
      `Guardado: ${nuevas.length} nuevo(s), ${existentes.length} modificado(s).`
    );
    cargar();
  };

  const sinLigar = filas.filter((f) => !f.incidencia_sugerida).length;

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay' && !guardando)
          onClose();
      }}
    >
      <div className="modal" style={{ maxWidth: 860 }}>
        <h2 style={{ margin: '0 0 3px' }}>Checklist de revisión</h2>
        <p className="phint">
          {unidad} · lo que se revisa en cada visita
        </p>

        <div className="toolbar" style={{ marginTop: 8 }}>
          <span className="tag">Checklist de:</span>
          <select
            style={{ width: 'auto' }}
            value={tipoSel}
            onChange={(e) => setTipoSel(e.target.value)}
            disabled={guardando}
          >
            <option value="Impreso">Máquinas impresas</option>
            <option value="Digital">Máquinas digitales</option>
          </select>
        </div>

        {err && <div className="err">{err}</div>}
        {ok && <div className="banner">{ok}</div>}

        {cargando ? (
          <div style={{ padding: '18px 0', fontSize: 13, color: 'var(--muted)' }}>
            Cargando…
          </div>
        ) : !plantilla ? (
          <>
            <div className="banner" style={{ marginTop: 12 }}>
              Todavía no hay checklist para {unidad} {tipoSel.toLowerCase()}.
              Al crearlo queda vacío y se le van agregando los puntos a
              revisar.
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>
                Cancelar
              </button>
              <button className="btn" onClick={crearPlantilla} disabled={guardando}>
                Crear checklist
              </button>
            </div>
          </>
        ) : (
          <>
            {catalogo.length === 0 && (
              <div className="banner" style={{ marginTop: 10 }}>
                No hay catálogo de incidencias para {unidad}, así que no se
                puede ligar ningún punto. Las anomalías se registrarán en la
                revisión pero no podrán levantar incidencia.
              </div>
            )}
            {catalogo.length > 0 && sinLigar > 0 && (
              <div className="banner" style={{ marginTop: 10 }}>
                {sinLigar} punto(s) sin incidencia ligada. Funcionan igual, pero
                al marcar la anomalía el revisor tendrá que elegir del catálogo
                completo a mano.
              </div>
            )}

            <div
              style={{
                maxHeight: '54vh',
                overflowY: 'auto',
                border: '1px solid var(--line)',
                borderRadius: 10,
                marginTop: 12,
              }}
            >
              {filas.length === 0 && (
                <div
                  style={{ padding: 14, fontSize: 13, color: 'var(--muted)' }}
                >
                  Sin puntos. Agrega el primero abajo.
                </div>
              )}
              {filas.map((f) => (
                <div
                  key={f.id}
                  style={{
                    padding: '10px 11px',
                    borderBottom: '1px solid var(--line)',
                    background: f.sucia ? 'rgba(79,140,255,.07)' : 'transparent',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      gap: 7,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                    }}
                  >
                    <input
                      type="number"
                      value={f.orden}
                      onChange={(e) =>
                        editar(f.id, 'orden', parseInt(e.target.value) || 0)
                      }
                      title="Orden"
                      style={{ width: 68, flexShrink: 0 }}
                    />
                    <input
                      value={f.grupo || ''}
                      onChange={(e) => editar(f.id, 'grupo', e.target.value)}
                      placeholder="Grupo"
                      style={{ width: 130, flexShrink: 0 }}
                    />
                    <input
                      value={f.texto}
                      onChange={(e) => editar(f.id, 'texto', e.target.value)}
                      placeholder="Qué se revisa"
                      style={{ flex: 1, minWidth: 170 }}
                    />
                    <button
                      type="button"
                      className="btn-icono"
                      onClick={() => quitar(f)}
                      aria-label="Quitar del checklist"
                      title="Quitar del checklist"
                    >
                      🗑
                    </button>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      gap: 7,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      marginTop: 7,
                    }}
                  >
                    <input
                      value={f.ayuda || ''}
                      onChange={(e) => editar(f.id, 'ayuda', e.target.value)}
                      placeholder="Ayuda para el revisor (opcional)"
                      style={{ flex: 1, minWidth: 170 }}
                    />
                    <select
                      value={f.incidencia_sugerida || ''}
                      onChange={(e) =>
                        editar(f.id, 'incidencia_sugerida', e.target.value)
                      }
                      style={{ width: 230, flexShrink: 0 }}
                      title="Incidencia que se propone si este punto sale mal"
                    >
                      <option value="">— sin incidencia ligada —</option>
                      {catalogo.map((c) => (
                        <option key={llaveCatalogo(c)} value={c.detalle}>
                          {c.detalle}
                          {c.area ? ` (${c.area})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      gap: 14,
                      marginTop: 7,
                      fontSize: 11,
                      color: 'var(--muted)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={f.exige_foto_anomalia}
                        onChange={(e) =>
                          editar(f.id, 'exige_foto_anomalia', e.target.checked)
                        }
                        style={{ width: 'auto' }}
                      />
                      Exigir foto si sale mal
                    </label>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={f.critico}
                        onChange={(e) => editar(f.id, 'critico', e.target.checked)}
                        style={{ width: 'auto' }}
                      />
                      Crítico (si falla, la máquina no sirve)
                    </label>
                  </div>
                </div>
              ))}
            </div>

            <div className="toolbar" style={{ marginTop: 10 }}>
              <button className="btn sm ghost" onClick={agregar}>
                + Agregar punto
              </button>
              <span className="tag">{filas.length} puntos</span>
              {filas.some((f) => f.sucia) && (
                <span
                  className="tag"
                  style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}
                >
                  cambios sin guardar
                </span>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose} disabled={guardando}>
                Cerrar
              </button>
              <button
                className="btn"
                onClick={guardar}
                disabled={guardando || !filas.some((f) => f.sucia)}
              >
                {guardando ? 'Guardando…' : 'Guardar cambios'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default ChecklistConfigModal;
