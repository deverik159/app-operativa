// ============================================================
// src/modules/incidencias/AsignarMaquinaModal.tsx
// Ponerle la máquina a una incidencia reportada sin máquina ANTES de que la
// reparen (Erik, 17-nov-2026).
//
// Hasta hoy la única forma era que el técnico la eligiera al registrar la
// reparación. Con esto el validador de la unidad o el manager se la ponen
// antes, y el técnico ya la ve con su máquina, dirección y nombre (y deja
// de contar en el filtro «Sin máquina»).
//
// Guarda la misma ubicación que el alta y la reparación toman de la cara
// del inventario (lib/ubicacionMaquina.ts). Lo deja la política
// inc_upd_validador (unidad y medio) o inc_upd_manager. Necesita señal: no
// se encola, igual que la corrección.
// ============================================================
import { useState } from 'react';
import { sb } from '../../lib/supabase';
import { haySenal } from '../../lib/datosLocales';
import { ubicacionDeMaquina } from '../../lib/ubicacionMaquina';
import { useAtrasCierra } from '../../lib/atrasVentana';
import type { Incidencia } from '../../types/db';
import CerrarModal from '../../components/CerrarModal';
import ElegirMaquina, { type MaquinaElegida } from '../../components/ElegirMaquina';

type Props = {
  inc: Incidencia;
  onClose: () => void;
  onDone: (recordId: string, patch: Partial<Incidencia>) => void;
};

const SIN_SENAL = 'Necesitas señal para asignar la máquina.';

/** Sin sesión real el UPDATE saldría como anónimo y daría 0 filas (ver CorreccionModal). */
function haySesionReal(): Promise<boolean> {
  return Promise.race([
    sb.auth.getSession().then(
      ({ data }) => !!data.session,
      () => false
    ),
    new Promise<boolean>((res) => setTimeout(() => res(false), 3000)),
  ]);
}

export default function AsignarMaquinaModal({ inc, onClose, onDone }: Props) {
  const [maq, setMaq] = useState<MaquinaElegida>({ sitio: null, cara: null });
  const [busy, setBusy] = useState(false);

  const cerrar = () => {
    if (!busy) onClose();
  };
  useAtrasCierra(cerrar);

  const guardar = async () => {
    if (!maq.cara) return;
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
    const patch = ubicacionDeMaquina(maq.cara, maq.sitio?.direccion);
    // Se cuenta lo afectado: la RLS que no deja pasar responde 0 filas sin
    // error. El .eq de la clave asegura que nadie se la puso mientras tanto
    // (el técnico al reparar, u otro validador).
    const { error, status, count } = await sb
      .from('incidencias')
      .update(patch, { count: 'exact' })
      .eq('record_id', inc.record_id)
      .eq('clave_sitio', inc.clave_sitio || '');
    setBusy(false);
    if (error) {
      const deRed = !haySenal() || !status || status === 401 || status >= 500;
      alert(deRed ? SIN_SENAL : 'No se pudo asignar la máquina: ' + error.message);
      return;
    }
    if (count === 0) {
      alert(
        'No se guardó: alguien más ya le puso máquina o tu rol no permite cambiar esta ' +
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
        if ((e.target as HTMLElement).className === 'overlay') cerrar();
      }}
    >
      <div className="modal">
        <CerrarModal onClick={cerrar} />
        <h2 style={{ margin: '0 0 3px' }}>Asignar máquina</h2>
        <p className="phint">
          {inc.folio} · {inc.nombre_incidencia}
        </p>

        <div className="banner" style={{ marginBottom: 14 }}>
          Se reportó <b>sin máquina</b>. Si ya sabes cuál es, pónsela aquí: el técnico la verá con
          su clave, nombre y dirección, y ya no tendrá que buscarla al reparar.
        </div>

        <div className="field">
          <label>Máquina afectada</label>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
            Búscala por su clave o por su nombre.
          </div>
          <ElegirMaquina unidad={inc.unidad_negocio || ''} disabled={busy} onCambio={setMaq} />
        </div>

        <div className="modal-actions pie-fijo">
          <button className="btn ghost" onClick={cerrar} disabled={busy}>
            Cancelar
          </button>
          <button className="btn" onClick={() => void guardar()} disabled={busy || !maq.cara}>
            {busy ? 'Guardando…' : 'Asignar máquina'}
          </button>
        </div>
      </div>
    </div>
  );
}
