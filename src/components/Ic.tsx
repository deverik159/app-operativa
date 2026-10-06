// ============================================================
// src/components/Ic.tsx
// Ícono en línea con el texto (rediseño "Precisión", oct-2026).
//
// Sustituye a los emojis de botones, etiquetas y avisos: los emojis cada
// teléfono los dibuja distinto y no toman el color del tema. Mide 1.1em, así
// que se ajusta solo al tamaño de letra de donde esté, y hereda el color
// (currentColor). El espacio con el texto lo da .ic (estilo/precision.css).
//
//   <button className="btn ghost sm"><Ic i={Download} />Importar</button>
// ============================================================
import type { LucideIcon } from 'lucide-react';

export default function Ic({ i: Icono, className }: { i: LucideIcon; className?: string }) {
  return (
    <Icono
      className={'ic' + (className ? ' ' + className : '')}
      size="1.1em"
      strokeWidth={2}
      aria-hidden="true"
    />
  );
}
