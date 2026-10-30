// ============================================================
// src/components/IconoNav.tsx
// Ícono de cada módulo en el menú (rediseño "Precisión", oct-2026).
//
// Antes el menú usaba emojis (➕ 📥 🗂️…): cada teléfono los dibuja distinto
// y no toman el color del tema. Estos son trazos de lucide-react que
// heredan `currentColor`, así que el activo se pinta con el CSS del menú.
// Si llega un módulo nuevo sin ícono aquí, se sigue viendo su emoji.
// ============================================================
import {
  BarChart3,
  ClipboardCheck,
  Compass,
  Cpu,
  FolderCheck,
  Inbox,
  List,
  Map,
  Package,
  Paperclip,
  Plus,
  Router,
  ScanSearch,
  Signpost,
  Users,
  type LucideIcon,
} from 'lucide-react';

const ICONOS: Record<string, LucideIcon> = {
  nueva: Plus,
  bandeja: Inbox,
  todas: List,
  dashboard: BarChart3,
  disponibilidad: ScanSearch,
  bitacora_vv: Signpost,
  fijacion_externa: Paperclip,
  rutas: Map,
  pauta: ClipboardCheck,
  // Comprobaciones (fase 2, 23-oct-2026): carpeta con palomita, distinta del
  // portapapeles de Pauta.
  comprobaciones: FolderCheck,
  mis_rutas: Compass,
  biobox: Package,
  equipos: Cpu,
  // Aviso NUC (29-oct-2026): el NUC es la computadora de la máquina.
  aviso_nuc: Router,
  usuarios: Users,
};

/**
 * BioGuard (enlace a otra app, 20-oct-2026): su logo es un escudo con un lazo
 * infinito; aquí va en trazo, como el resto del menú, para que tome el color
 * del tema. El escudo es el de lucide; el lazo, dibujado a la medida.
 */
function EscudoBioGuard({ className }: { className: string }) {
  return (
    <svg
      className={className}
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="M12 11.5c-1-1.3-1.9-1.9-2.9-1.9a1.9 1.9 0 0 0 0 3.8c1 0 1.9-.6 2.9-1.9s1.9-1.9 2.9-1.9a1.9 1.9 0 0 1 0 3.8c-1 0-1.9-.6-2.9-1.9" />
    </svg>
  );
}

export default function IconoNav({ k, emoji }: { k: string; emoji: string }) {
  if (k === 'bioguard') return <EscudoBioGuard className="nav-ic" />;
  const Icono = ICONOS[k];
  if (!Icono) return <span className="nav-ic">{emoji}</span>;
  return <Icono className="nav-ic" size={18} strokeWidth={1.8} aria-hidden="true" />;
}

/**
 * Nombre corto para la barra de abajo del celular (5 botones en ~360px).
 * El largo se sigue viendo en escritorio y en la hoja "Más".
 */
const CORTOS: Record<string, string> = {
  todas: 'Incidencias',
  dashboard: 'Indicadores',
  rutas: 'Rutas',
  pauta: 'Pauta',
  comprobaciones: 'Comprobar', // «Comprobaciones» no cabe en la barra (23-oct-2026)
  mis_rutas: 'Mis rutas',
  bitacora_vv: 'Pauta VV', // «Disponibilidad y Pauta VV» (19-oct-2026)
  fijacion_externa: 'Fijación',
  biobox: 'Biobox',
};

export function tituloCorto(k: string, t: string): string {
  if (k === 'bandeja') return t === 'Mis pendientes' ? 'Pendientes' : 'Bandeja';
  return CORTOS[k] ?? t;
}
