// ============================================================
// src/modules/incidencias/DuplicadaModal.tsx
// «Descartar como duplicada» desde la tarjeta por validar (Erik,
// 23-nov-2026; caso EVD00040/EVD00041).
//
// No se escribe ningún folio: al abrir busca con la regla de duplicados
// (lib/duplicados.ts) otra igual EN PROCESO en la misma cara. Si hay una, la
// confirma; si hay varias, se elige; si no hay, lo dice. Descartar la deja
// «Duplicada de <folio>»: no cuenta en indicadores, al reportante no le
// queda pendiente y le llega un aviso; fotos y chat se conservan.
//
// Todo lo decide la base (inc_descartar_duplicada). Necesita señal: no se
// encola.
// ============================================================
import { useEffect, useState } from 'react';
import { haySenal, haySesionReal } from '../../lib/datosLocales';
import { tope } from '../../lib/envios';
import { pareceSinRed } from '../../lib/enLinea';
import { descartarDuplicada, duplicadasEnProceso } from '../../lib/duplicados';
import { vigilarRender } from '../../lib/vigia';
import type { Incidencia } from '../../types/db';
import CerrarModal from '../../components/CerrarModal';

const SIN_SENAL = 'Necesitas señal para esto.';

type Props = {
  inc: Incidencia;
  onClose: () => void;
  onDone: (recordId: string, patch: Partial<Incidencia>) => void;
};

function DuplicadaModal({ inc, onClose, onDone }: Props) {
  vigilarRender('DuplicadaModal');
  /** null = buscando. */
  const [opciones, setOpciones] = useState<string[] | null>(null);
  const [elegida, setElegida] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let vivo = true;
    if (!haySenal()) {
      setOpciones([]);
      setErr(SIN_SENAL);
      return;
    }
    duplicadasEnProceso([inc], { signal: tope(20000), lanzarSiFalla: true })
      .then((ch) => {
        if (!vivo) return;
        const folios = [
          ...new Set(ch.map((c) => c.folio).filter((f): f is string => !!f && f !== inc.folio)),
        ];
        setOpciones(folios);
        setElegida(folios[0] || '');
      })
      .catch((e) => {
        if (!vivo) return;
        setOpciones([]);
        setErr(pareceSinRed(e) ? SIN_SENAL : 'No se pudo buscar la original: ' + (e?.message || e));
      });
    return () => {
      vivo = false;
    };
  }, [inc]);

  const descartar = async () => {
    if (!elegida) return;
    if (!haySenal()) {
      setErr(SIN_SENAL);
      return;
    }
    setBusy(true);
    setErr('');
    if (!(await haySesionReal())) {
      setBusy(false);
      setErr(SIN_SENAL);
      return;
    }
    try {
      const patch = await descartarDuplicada(inc.record_id, elegida, null, tope(30000));
      setBusy(false);
      onDone(inc.record_id, patch);
    } catch (e) {
      setBusy(false);
      setErr(
        pareceSinRed(e)
          ? 'La red no respondió. Revisa la incidencia antes de volver a intentarlo: pudo haberse guardado.'
          : (e as { message?: string })?.message || String(e)
      );
    }
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay' && !busy) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dup-titulo" style={{ maxWidth: 520 }}>
        <CerrarModal onClick={onClose} disabled={busy} />
        <h2 id="dup-titulo" style={{ margin: '0 0 3px' }}>Descartar como duplicada</h2>
        <p className="phint">
          {inc.folio} · {inc.nombre_incidencia} · {inc.clave_sitio || '(sin clave)'}
        </p>

        {opciones === null ? (
          <p className="phint">Buscando otra igual en proceso…</p>
        ) : opciones.length === 0 ? (
          !err && (
            <div className="banner" style={{ marginBottom: 12 }}>
              No hay otra «{inc.nombre_incidencia}» en proceso en esta cara. Si la otra sigue por validar,
              valida primero esa y luego descarta esta.
            </div>
          )
        ) : (
          <>
            <div className="banner" style={{ marginBottom: 12 }}>
              Ya está en proceso la misma falla en la misma cara. Esta queda como <b>duplicada</b>: no cuenta en
              los indicadores, al reportante le llega un aviso y no le queda pendiente. Sus fotos y su chat se
              conservan.
            </div>
            {opciones.length > 1 ? (
              <div className="field">
                <label htmlFor="dup-original">Es duplicada de</label>
                <select
                  id="dup-original"
                  value={elegida}
                  onChange={(e) => setElegida(e.target.value)}
                  disabled={busy}
                >
                  {opciones.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p style={{ margin: '0 0 12px' }}>
                Es duplicada de <b>{elegida}</b>.
              </p>
            )}
          </>
        )}

        {err && <div className="err" role="alert">{err}</div>}
        <div className="modal-actions pie-fijo" style={{ marginTop: 12 }}>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className="btn" onClick={() => void descartar()} disabled={busy || !elegida}>
            {busy ? 'Guardando…' : elegida ? `Descartar como duplicada de ${elegida}` : 'Descartar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default DuplicadaModal;
