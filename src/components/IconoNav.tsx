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
  Inbox,
  List,
  Map,
  Package,
  Paperclip,
  Plus,
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
  mis_rutas: Compass,
  biobox: Package,
  usuarios: Users,
};

export default function IconoNav({ k, emoji }: { k: string; emoji: string }) {
  const Icono = ICONOS[k];
  if (!Icono) return <span className="nav-ic">{emoji}</span>;
  return <Icono className="nav-ic" size={18} strokeWidth={1.8} aria-hidden="true" />;
}
