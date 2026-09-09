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
import { caraIncidencia, codigoCara } from '../../lib/helpers';
import { BUCKET_EVIDENCIAS } from '../../lib/storage';
import SubirArchivos from '../../components/SubirArchivos';
import type { ArbolDigital, Evidencia, Incidencia, TipoEvidencia } from '../../types/db';

/** Lo que el modal devuelve al padre para escribir en incidencias. */
export type DatosReparacion = {
  diagnostico: string | null;
  detalle: string;
  /** Solo las llena el árbol de Digital. En las demás áreas van null. */
  incidenciaSrd: string | null;
  arbolDigitalId: number | string | null;
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
  const [arbolListo, setArbolListo] = useState(false);
  const [errArbol, setErrArbol] = useState('');
  const [srdSel, setSrdSel] = useState(inc.incidencia_srd || '');
  const [causaSel, setCausaSel] = useState(inc.causa_raiz || '');
  const [diagnosticoSel, setDiagnosticoSel] = useState(inc.diagnostico || '');
  const [solSel, setSolSel] = useState(inc.solucion || '');

  const areaRepara = inc.assigned_area || inc.area_responsable || '';
  const esDigital = areaRepara.trim().toLowerCase() === 'digital';
  const tecnicasDig = [
    ...new Set(arbol.map((a) => a.incidencia_srd).filter(Boolean)),
  ] as string[];
  const filasSrd = arbol.filter((a) => a.incidencia_srd === srdSel);
  const causasDig = [
    ...new Set(filasSrd.map((a) => a.causa_raiz).filter(Boolean)),
  ] as string[];
  const filasCausa = filasSrd.filter((a) => a.causa_raiz === causaSel);
  const diagnosticosDig = [
    ...new Set(filasCausa.map((a) => a.diagnostico).filter(Boolean)),
  ] as string[];
  const filasDiagnostico = diagnosticosDig.length
    ? filasCausa.filter((a) => a.diagnostico === diagnosticoSel)
    : filasCausa;
  const solsDig = [
    ...new Set(filasDiagnostico.map((a) => a.solucion).filter(Boolean)),
  ] as string[];
  const filaElegida = filasDiagnostico.find((a) => a.solucion === solSel) || null;
  const categoriaDig = filaElegida?.categoria_principal || filasSrd[0]?.categoria_principal;
  // Solo se guía si es Digital Y hay árbol para esta incidencia; si no, se
  // cae al flujo libre en vez de dejar al técnico sin poder capturar.
  const usarArbol = esDigital && tecnicasDig.length > 0;

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
        const { data: a, error: errorArbol } = await sb
          .from('arbol_digital')
          .select(
            'id,incidencia,categoria_principal,incidencia_srd,causa_raiz,diagnostico,solucion,sla_min,sla,sla_fuera'
          )
          // nombre_incidencia se guardó desde catalogo_incidencias.detalle y
          // arbol_digital.incidencia usa exactamente esa descripción visible.
          .eq('incidencia', inc.nombre_incidencia || '')
          .order('incidencia_srd')
          .order('causa_raiz')
          .order('solucion');
        setArbolListo(true);
        if (errorArbol) {
          setErrArbol(errorArbol.message);
          return;
        }
        const filas = (a as ArbolDigital[]) || [];
        setArbol(filas);

        // Una reparación rechazada vuelve a abrir este mismo modal: se
        // reconstruye la ruta guardada por FK para no obligar a clasificarla
        // otra vez ni depender de textos que el catálogo pudiera haber editado.
        const previa = filas.find(
          (x) => String(x.id) === String(inc.arbol_digital_id || '')
        );
        if (previa) {
          setSrdSel(previa.incidencia_srd || '');
          setCausaSel(previa.causa_raiz || '');
          setDiagnosticoSel(previa.diagnostico || '');
          setSolSel(previa.solucion || '');
        } else {
          const tecnicas = [
            ...new Set(filas.map((x) => x.incidencia_srd).filter(Boolean)),
          ] as string[];
          if (tecnicas.length === 1) setSrdSel(tecnicas[0]);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // En cada nivel, una única opción se prellena. Con varias, el técnico
  // decide: "Pantallas en negro" no puede adivinar Telmex o Totalplay.
  useEffect(() => {
    if (srdSel && causasDig.length === 1 && !causaSel) setCausaSel(causasDig[0]);
  }, [srdSel, causasDig, causaSel]);

  useEffect(() => {
    if (causaSel && diagnosticosDig.length === 1 && !diagnosticoSel)
      setDiagnosticoSel(diagnosticosDig[0]);
  }, [causaSel, diagnosticosDig, diagnosticoSel]);

  useEffect(() => {
    if (causaSel && solsDig.length === 1 && !solSel) setSolSel(solsDig[0]);
  }, [causaSel, solsDig, solSel]);

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
    let diagnosticoFinal: string | null = diag.trim() || null;
    let solucion: string | null = null;
    let incidenciaSrd: string | null = null;
    let arbolDigitalId: number | string | null = null;

    if (usarArbol) {
      if (!srdSel) {
        alert('Elige la incidencia técnica de Digital.');
        return;
      }
      if (!causaSel) {
        alert('Elige la causa raíz.');
        return;
      }
      if (diagnosticosDig.length > 0 && !diagnosticoSel) {
        alert('Elige el diagnóstico.');
        return;
      }
      if (!solSel) {
        alert('Elige la solución.');
        return;
      }
      if (!filaElegida) {
        alert('La combinación elegida ya no existe en el catálogo Digital. Recarga e inténtalo de nuevo.');
        return;
      }
      incidenciaSrd = filaElegida.incidencia_srd;
      arbolDigitalId = filaElegida.id;
      causa = filaElegida.causa_raiz;
      diagnosticoFinal = filaElegida.diagnostico;
      solucion = solSel;
    }

    setBusy(true);
    await onSave({
      diagnostico: diagnosticoFinal,
      detalle,
      incidenciaSrd,
      arbolDigitalId,
      causa,
      solucion,
    });
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
          {inc.folio} · {inc.nombre_incidencia} · cara {caraIncidencia(inc)}
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

        {esDigital && !arbolListo && (
          <div className="loading" style={{ marginBottom: 14 }}>
            Cargando clasificación técnica de Digital…
          </div>
        )}

        {esDigital && arbolListo && !usarArbol && (
          <div className={errArbol ? 'err' : 'banner'} style={{ marginBottom: 14 }}>
            {errArbol
              ? `No se pudo cargar el catálogo Digital: ${errArbol}`
              : `“${inc.nombre_incidencia || 'Esta incidencia'}” no tiene clasificación en arbol_digital. La reparación quedará como Sin clasificar.`}
          </div>
        )}

        {!usarArbol && (!esDigital || arbolListo) && (
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
              <label>Incidencia técnica de Digital ({tecnicasDig.length})</label>
              <select
                value={srdSel}
                onChange={(e) => {
                  setSrdSel(e.target.value);
                  setCausaSel('');
                  setDiagnosticoSel('');
                  setSolSel('');
                }}
              >
                <option value="">— Selecciona —</option>
                {tecnicasDig.map((srd) => (
                  <option key={srd} value={srd}>
                    {srd}
                  </option>
                ))}
              </select>
              {categoriaDig && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                  Categoría: <b>{categoriaDig}</b>
                </div>
              )}
            </div>
            {srdSel && (
              <div className="field">
                <label>Causa raíz ({causasDig.length})</label>
                <select
                  value={causaSel}
                  onChange={(e) => {
                    setCausaSel(e.target.value);
                    setDiagnosticoSel('');
                    setSolSel('');
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
            )}
            {causaSel && diagnosticosDig.length > 0 && (
              <div className="field">
                <label>Diagnóstico ({diagnosticosDig.length})</label>
                <select
                  value={diagnosticoSel}
                  onChange={(e) => {
                    setDiagnosticoSel(e.target.value);
                    setSolSel('');
                  }}
                >
                  <option value="">— Selecciona —</option>
                  {diagnosticosDig.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {causaSel && (diagnosticosDig.length === 0 || diagnosticoSel) && (
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
