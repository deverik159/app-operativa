// ============================================================
// src/modules/incidencias/MotivoModal.tsx
// Modal genérico de "escribe un motivo". Lo reutilizan dos flujos:
//   - rechazar una reparación (regresa al área)
//   - descartar una incidencia auto-ruteada (regresa al reportante)
// Migrado del HTML con paridad.
//
// Quien abre el modal decide cuándo se cierra (al guardarse o quedar en la
// cola del teléfono sin señal): si el envío falla, el modal sigue abierto
// con el motivo escrito para reintentar (modo sin señal, 24-sep-2026).
// ============================================================
import { useState } from 'react';

type MotivoModalProps = {
  titulo: string;
  label: string;
  /** Texto del botón de confirmar. Por omisión, "Rechazar". */
  boton?: string;
  onClose: () => void;
  /** Recibe el motivo ya recortado. Puede ser async. */
  onSubmit: (motivo: string) => void | Promise<void>;
};

function MotivoModal({
  titulo,
  label,
  boton = 'Rechazar',
  onClose,
  onSubmit,
}: MotivoModalProps) {
  const [texto, setTexto] = useState('');
  const [busy, setBusy] = useState(false);

  const enviar = async () => {
    // Doble toque: el segundo no debe mandar (ni encolar) otra vez.
    if (busy) return;
    if (!texto.trim()) {
      alert('Escribe el motivo.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(texto.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        // Solo cierra si el clic fue en el fondo, no dentro del modal. Con
        // el envío en curso tampoco: la acción ya va en camino.
        if ((e.target as HTMLElement).className === 'overlay' && !busy)
          onClose();
      }}
    >
      <div className="modal">
        <h2 style={{ margin: '0 0 3px' }}>{titulo}</h2>
        <div className="field">
          <label>{label}</label>
          <textarea
            rows={3}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className="btn hi" onClick={enviar} disabled={busy}>
            {busy && <span className="spinner" />}
            {busy ? 'Guardando…' : boton}
          </button>
        </div>
      </div>
    </div>
  );
}

export default MotivoModal;
