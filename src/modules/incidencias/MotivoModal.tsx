// ============================================================
// src/modules/incidencias/MotivoModal.tsx
// Modal genérico de "escribe un motivo". Lo reutilizan dos flujos:
//   - rechazar una reparación (regresa al área)
//   - descartar una incidencia auto-ruteada (regresa al reportante)
// Migrado del HTML con paridad.
// ============================================================
import { useState } from 'react';

type MotivoModalProps = {
  titulo: string;
  label: string;
  onClose: () => void;
  /** Recibe el motivo ya recortado. Puede ser async. */
  onSubmit: (motivo: string) => void | Promise<void>;
};

function MotivoModal({ titulo, label, onClose, onSubmit }: MotivoModalProps) {
  const [texto, setTexto] = useState('');
  const [busy, setBusy] = useState(false);

  const enviar = async () => {
    if (!texto.trim()) {
      alert('Escribe el motivo.');
      return;
    }
    setBusy(true);
    await onSubmit(texto.trim());
    setBusy(false);
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        // Solo cierra si el clic fue en el fondo, no dentro del modal.
        if ((e.target as HTMLElement).className === 'overlay') onClose();
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
            autoFocus
          />
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn hi" onClick={enviar} disabled={busy}>
            {busy ? '…' : 'Rechazar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default MotivoModal;
