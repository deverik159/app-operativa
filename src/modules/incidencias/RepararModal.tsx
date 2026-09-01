// ============================================================
// src/modules/incidencias/RepararModal.tsx
// Registro de la reparación por parte del área responsable.
//
// Dos modos según el área:
//   - Digital (con árbol cargado) → causa y solución GUIADAS desde
//     `arbol_digital`, sin texto libre: se estandariza la captura.
//   - Cualquier otra área          → diagnóstico y detalle libres. NO se
//     captura causa raíz: ese catálogo es exclusivo de Digital.
//
// La evidencia de reparación es OBLIGATORIA. Se cuenta la que YA existe en
// la tabla `evidencias` con etapa='reparacion' —subida antes desde el botón
// 📎 Evidencia— más la que se suba aquí. Son el mismo dato; obligar a
// resubirla sería pedirle al técnico que haga dos veces el mismo trabajo.
// ============================================================
import { useState, useEffect } from 'react';
import { sb } from '../../lib/supabase';
import { caraLabel, codigoCara } from '../../lib/helpers';
import { BUCKET_EVIDENCIAS } from '../../lib/storage';
import SubirArchivos from '../../components/SubirArchivos';
import type { ArbolDigital, Evidencia, Incidencia, TipoEvidencia } from '../../types/db';

/** Lo que el modal devuelve al padre para escribir en incidencias. */
export type DatosReparacion = {
  diagnostico: string;
  detalle: string;
  /** Solo la llena el árbol de Digital. En las demás áreas va null. */
  causa: string | null;
  solucion: string | null;
};

type Props = {
  inc: Incidencia;
  email: string;
  onClose: () => void;
  onSave: (datos: DatosReparacion) => void | Promise<void>;
};

function RepararModal({ inc, email, onClose, onSave }: Props) {
  const [diag, setDiag] = useState(inc.diagnostico || '');
  const [detalle, setDetalle] = useState(inc.detalle_reparacion || '');
  const [busy, setBusy] = useState(false);

  const [evReporte, setEvReporte] = useState<Evidencia[]>([]);
  const [evRep, setEvRep] = useState<Evidencia[]>([]);
  const [cargandoEv, setCargandoEv] = useState(true);
  const [subiendoRep, setSubiendoRep] = useState(false);

  const [arbol, setArbol] = useState<ArbolDigital[]>([]);
  const [diagSel, setDiagSel] = useState('');
  const [solSel, setSolSel] = useState('');

  const esDigital = (inc.area_responsable || '').toLowerCase() === 'digital';
  const causasDig = [
    ...new Set(arbol.map((a) => a.causa_raiz).filter(Boolean)),
  ] as string[];
  const solsDig = [
    ...new Set(
      arbol
        .filter((a) => a.causa_raiz === diagSel)
        .map((a) => a.solucion)
        .filter(Boolean)
    ),
  ] as string[];
  // Solo se guía si es Digital Y hay árbol para esta incidencia; si no, se
  // cae al flujo libre en vez de dejar al técnico sin poder capturar.
  const usarArbol = esDigital && causasDig.length > 0;

  useEffect(() => {
    (async () => {
      // Una sola consulta para las dos etapas y luego se parten: la evidencia
      // de reporte es el contexto, la de reparación es el requisito.
      const { data: ev } = await sb
        .from('evidencias')
        .select('*')
        .eq('record_id', inc.record_id)
        .in('etapa', ['reporte', 'reparacion'])
        .order('creado_en');
      const todas = (ev as Evidencia[]) || [];
      setEvReporte(todas.filter((e) => e.etapa === 'reporte'));
      // Lo ya subido desde el botón 📎 Evidencia cuenta para el requisito.
      setEvRep(todas.filter((e) => e.etapa === 'reparacion'));
      setCargandoEv(false);

      if (esDigital) {
        const { data: a } = await sb
          .from('arbol_digital')
          .select('causa_raiz,solucion')
          .ilike('incidencia', inc.nombre_incidencia || '');
        setArbol((a as ArbolDigital[]) || []);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subirRep = async (files: File[]) => {
    if (!files.length) return;
    setSubiendoRep(true);

    for (const f of files) {
      const tipo: TipoEvidencia = f.type.startsWith('video') ? 'video' : 'foto';
      // El FOLIO abre el nombre: el archivo se comparte por su URL y sin el
      // folio nadie sabe de qué incidencia es la foto sin abrir la app.
      const folio = (inc.folio || '').trim();
      const cara = codigoCara(inc.clave_medio) || inc.clave_sitio || 'sitio';
      const fecha = new Date().toISOString().slice(0, 10);
      const ext = (
        f.name.split('.').pop() || (tipo === 'video' ? 'mp4' : 'jpg')
      ).toLowerCase();
      const nombre = `${folio ? folio + '_' : ''}${cara}_${fecha}_reparacion_${Date.now()}.${ext}`.replace(
        /[^\w.\-]/g,
        '_'
      );
      const path = `${inc.record_id}/${nombre}`;

      const { error: up } = await sb.storage
        .from(BUCKET_EVIDENCIAS)
        .upload(path, f);
      if (up) {
        alert('Error al subir: ' + up.message);
        continue;
      }
      const url = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path).data
        .publicUrl;
      const { data, error: insErr } = await sb
        .from('evidencias')
        .insert({
          record_id: inc.record_id,
          etapa: 'reparacion',
          tipo,
          url,
          path,
          subido_por: email,
        })
        .select()
        .single();
      // Sin avisar el error, el archivo quedaba en Storage pero la fila no:
      // la galería salía vacía "sin explicación" y el técnico resubía.
      if (insErr) {
        alert('La foto se subió pero no se pudo registrar: ' + insErr.message);
        continue;
      }
      if (data) setEvRep((prev) => [...prev, data as Evidencia]);
    }

    setSubiendoRep(false);
  };

  const guardar = async () => {
    if (!usarArbol && !detalle.trim()) {
      alert('Escribe el detalle de la reparación.');
      return;
    }
    if (evRep.length === 0) {
      alert('Adjunta al menos una foto o video de la reparación.');
      return;
    }

    let causa: string | null = null;
    let solucion: string | null = null;

    if (usarArbol) {
      if (!diagSel) {
        alert('Elige el diagnóstico / causa raíz.');
        return;
      }
      if (!solSel) {
        alert('Elige la solución.');
        return;
      }
      causa = diagSel;
      solucion = solSel;
    }

    setBusy(true);
    await onSave({ diagnostico: diag, detalle, causa, solucion });
    setBusy(false);
  };

  /** Miniatura de una evidencia (foto) o enlace (video). */
  const Miniatura = ({ e, size }: { e: Evidencia; size: number }) =>
    e.tipo === 'foto' ? (
      <a href={e.url} target="_blank" rel="noreferrer" title={e.referencia || ''}>
        <img
          src={e.url}
          alt={e.referencia || `Evidencia de ${e.etapa}`}
          style={{
            width: size,
            height: size,
            objectFit: 'cover',
            borderRadius: 7,
            border: '1px solid var(--line)',
            display: 'block',
          }}
        />
      </a>
    ) : (
      <a href={e.url} target="_blank" rel="noreferrer" className="tag">
        🎥 video
      </a>
    );

  return (
    <div
      className="overlay"
      onClick={(e) => {
        // Con una subida o el guardado en curso, un roce en el fondo no
        // debe cerrar: dejaría archivos a medias.
        if (
          (e.target as HTMLElement).className === 'overlay' &&
          !busy &&
          !subiendoRep
        )
          onClose();
      }}
    >
      <div className="modal">
        <h2 style={{ margin: '0 0 3px' }}>Registrar reparación</h2>
        <p className="phint">
          {inc.folio} · {inc.nombre_incidencia} · cara {caraLabel(inc.clave_medio)}
        </p>

        {/* Contexto: qué reportó el reportante y con qué evidencia */}
        <div
          style={{
            background: 'var(--panel2)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '11px 12px',
            marginBottom: 14,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
            📋 Reporte del reportante
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            Sitio: <b>{inc.clave_sitio}</b>
            {inc.nombre_biobox ? ` · ${inc.nombre_biobox}` : ''}
            <br />
            {inc.direccion}
            <br />
            {/* Solo el nivel: tipo (Imponderable…) y origen se guardan para
                los KPIs pero dejan de mostrarse (Erik, 30-ago-2026). */}
            Nivel {inc.nivel || '—'}
            {inc.reasignada_de && (
              <>
                <br />
                <span style={{ color: '#a78bfa' }}>
                  🔁 Reasignada: antes pertenecía a {inc.reasignada_de}
                </span>
              </>
            )}
            {inc.observaciones && (
              <>
                <br />
                Obs.: “{inc.observaciones}”
              </>
            )}
          </div>
          {evReporte.length > 0 ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
              {evReporte.map((e) => (
                <Miniatura key={e.id} e={e} size={64} />
              ))}
            </div>
          ) : (
            !cargandoEv && (
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                El reportante no adjuntó evidencia.
              </div>
            )
          )}
        </div>

        {!usarArbol && (
          <>
            <div className="field">
              <label>Diagnóstico</label>
              <textarea
                rows={2}
                value={diag}
                onChange={(e) => setDiag(e.target.value)}
                placeholder="Qué se encontró en sitio…"
              />
            </div>
            <div className="field">
              <label>Detalle de reparación</label>
              <textarea
                rows={2}
                value={detalle}
                onChange={(e) => setDetalle(e.target.value)}
                placeholder="Qué se hizo para corregir…"
              />
            </div>
          </>
        )}

        <div className="field">
          <label>
            Evidencia de la reparación (foto/video) —{' '}
            {evRep.length > 0 ? (
              <span style={{ color: 'var(--ok)' }}>
                ✓ {evRep.length} adjunta{evRep.length > 1 ? 's' : ''}
              </span>
            ) : (
              <span style={{ color: 'var(--accent)' }}>obligatoria</span>
            )}
          </label>

          {cargandoEv ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Buscando evidencia ya subida…
            </div>
          ) : (
            <>
              {evRep.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    flexWrap: 'wrap',
                    marginBottom: 8,
                  }}
                >
                  {evRep.map((e) => (
                    <Miniatura key={e.id} e={e} size={56} />
                  ))}
                </div>
              )}
              <SubirArchivos
                onFiles={subirRep}
                disabled={subiendoRep}
                ayuda="Se suben en cuanto las eliges."
              />
              {subiendoRep && (
                <div
                  style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}
                >
                  <span className="spinner" />
                  Subiendo…
                </div>
              )}
              {evRep.length > 0 && (
                <div
                  style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}
                >
                  Ya cuentas con evidencia de reparación. Puedes agregar más si
                  hace falta.
                </div>
              )}
            </>
          )}
        </div>

        {usarArbol && (
          <>
            <div className="field">
              <label>
                Diagnóstico / Causa raíz (árbol Digital · {causasDig.length})
              </label>
              <select
                value={diagSel}
                onChange={(e) => {
                  setDiagSel(e.target.value);
                  setSolSel(''); // la solución depende de la causa elegida
                }}
              >
                <option value="">— Selecciona —</option>
                {causasDig.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            {diagSel && (
              <div className="field">
                <label>Solución ({solsDig.length})</label>
                <select value={solSel} onChange={(e) => setSolSel(e.target.value)}>
                  <option value="">— Selecciona —</option>
                  {solsDig.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button
            className="btn ghost"
            onClick={onClose}
            disabled={busy || subiendoRep}
          >
            Cancelar
          </button>
          {/* subiendoRep también bloquea: en 4G una foto tarda, y guardar a
              media subida cerraba el modal perdiendo los archivos restantes
              (o soltaba el alert falso de "adjunta al menos una foto"). */}
          <button
            className="btn warn"
            onClick={guardar}
            disabled={busy || cargandoEv || subiendoRep}
          >
            {(busy || subiendoRep) && <span className="spinner" />}
            {busy
              ? 'Guardando…'
              : subiendoRep
                ? 'Subiendo fotos…'
                : '🔧 Guardar reparación'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default RepararModal;
