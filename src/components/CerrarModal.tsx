// ============================================================
// src/components/CerrarModal.tsx
// Botón ✕ de la esquina de una ventana (rediseño "Precisión", oct-2026).
//
// Hasta ahora las ventanas solo se cerraban con Cancelar —al fondo de
// formularios largos— o tocando afuera. El ✕ hace EXACTAMENTE lo mismo que
// Cancelar: cada ventana le pasa su propio manejador y su `disabled`, así
// que respeta las mismas confirmaciones ("Tienes fotos sin guardar…") y
// los mismos bloqueos mientras guarda. Se coloca con .modal-cerrar
// (estilo/precision.css), anclado a la esquina de .modal.
// ============================================================
import { X } from 'lucide-react';

type Props = { onClick: () => void; disabled?: boolean };

export default function CerrarModal({ onClick, disabled }: Props) {
  return (
    <button
      type="button"
      className="modal-cerrar"
      aria-label="Cerrar"
      title="Cerrar"
      onClick={onClick}
      disabled={disabled}
    >
      <X size={17} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
