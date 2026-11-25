// ============================================================
// src/components/EnlaceFoto.tsx
// Enlace a una foto (o video) que, en la app instalada en computadora, la
// abre en un visor DENTRO de la app (Erik, 25-nov-2026).
//
// Antes todas eran <a target="_blank">: en la app instalada de Windows eso
// abre una pestaña de Chrome o Edge y saca a la persona de la app. Ahora:
//   · app instalada en computadora → visor encima de todo (fondo oscuro,
//     Esc o ✕ para cerrar, flechas para pasar entre las fotos de la misma
//     galería, «Abrir aparte» si de verdad la quiere en otra ventana);
//   · navegador o teléfono → igual que antes, otra pestaña.
// Ctrl/⌘/Shift + clic y el clic central siguen abriendo aparte.
//
// El visor va por portal a <body> con z-index 1050: por encima de los
// modales (.overlay, 960). Esc se atrapa en la fase de captura para que no
// cierre también el modal de abajo.
// ============================================================
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import {
  useEffect,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { fotosDentroDeLaApp } from '../lib/plataforma';

export type MedioVisor = { url: string; tipo?: 'foto' | 'video'; titulo?: string };

type Props = {
  href: string;
  /** 'video' se reproduce en el visor; por omisión es foto. */
  tipo?: 'foto' | 'video';
  /** Las demás fotos de la misma pantalla, para pasar con las flechas. */
  galeria?: MedioVisor[];
  /** Posición de esta foto en `galeria`. */
  indice?: number;
  children: ReactNode;
  title?: string;
  style?: CSSProperties;
  className?: string;
  'aria-label'?: string;
};

export default function EnlaceFoto({
  href,
  tipo = 'foto',
  galeria,
  indice = 0,
  children,
  title,
  style,
  className,
  'aria-label': ariaLabel,
}: Props) {
  const [abierto, setAbierto] = useState<number | null>(null);
  const lista: MedioVisor[] = galeria && galeria.length ? galeria : [{ url: href, tipo, titulo: title }];

  const alClic = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (!fotosDentroDeLaApp()) return;
    e.preventDefault();
    setAbierto(galeria && galeria.length ? Math.min(Math.max(indice, 0), galeria.length - 1) : 0);
  };

  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={title}
        style={style}
        className={className}
        aria-label={ariaLabel}
        onClick={alClic}
      >
        {children}
      </a>
      {abierto !== null && (
        <VisorFoto lista={lista} inicial={abierto} onCerrar={() => setAbierto(null)} />
      )}
    </>
  );
}

const boton: CSSProperties = {
  background: 'rgba(255,255,255,.14)',
  color: '#fff',
  border: '1px solid rgba(255,255,255,.25)',
  borderRadius: 999,
  width: 40,
  height: 40,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  flexShrink: 0,
};

function VisorFoto({
  lista,
  inicial,
  onCerrar,
}: {
  lista: MedioVisor[];
  inicial: number;
  onCerrar: () => void;
}) {
  const [i, setI] = useState(inicial);
  const actual = lista[i] ?? lista[0];
  const varias = lista.length > 1;
  const pasar = (d: number) => setI((x) => (x + d + lista.length) % lista.length);

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Captura: que el modal de abajo no se cierre también.
        e.preventDefault();
        e.stopPropagation();
        onCerrar();
      } else if (varias && e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        setI((x) => (x - 1 + lista.length) % lista.length);
      } else if (varias && e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        setI((x) => (x + 1) % lista.length);
      }
    };
    window.addEventListener('keydown', tecla, true);
    return () => window.removeEventListener('keydown', tecla, true);
  }, [onCerrar, varias, lista.length]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Foto"
      // Los eventos del portal suben por el árbol de React hasta el modal
      // que lo abrió: se cortan aquí para que no lo cierren.
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onCerrar();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1050,
        background: 'rgba(0,0,0,.9)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '56px 64px',
      }}
    >
      <div style={{ position: 'absolute', top: 10, right: 12, display: 'flex', gap: 8 }}>
        <a
          href={actual.url}
          target="_blank"
          rel="noreferrer"
          style={{ ...boton, width: 'auto', padding: '0 14px', gap: 6, fontSize: 13, textDecoration: 'none' }}
          title="Abrir en otra ventana"
        >
          <ExternalLink size={16} aria-hidden="true" />
          Abrir aparte
        </a>
        <button type="button" style={boton} onClick={onCerrar} aria-label="Cerrar" title="Cerrar (Esc)">
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      {varias && (
        <button
          type="button"
          style={{ ...boton, position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}
          onClick={() => pasar(-1)}
          aria-label="Anterior"
          title="Anterior (←)"
        >
          <ChevronLeft size={22} aria-hidden="true" />
        </button>
      )}

      {actual.tipo === 'video' ? (
        <video
          key={actual.url}
          src={actual.url}
          controls
          autoPlay
          playsInline
          style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8, background: '#000' }}
        />
      ) : (
        <img
          key={actual.url}
          src={actual.url}
          alt={actual.titulo || 'Foto'}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8 }}
        />
      )}

      {varias && (
        <>
          <button
            type="button"
            style={{ ...boton, position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)' }}
            onClick={() => pasar(1)}
            aria-label="Siguiente"
            title="Siguiente (→)"
          >
            <ChevronRight size={22} aria-hidden="true" />
          </button>
          <div
            style={{
              position: 'absolute',
              bottom: 14,
              left: '50%',
              transform: 'translateX(-50%)',
              color: '#fff',
              fontSize: 13,
              opacity: 0.85,
            }}
          >
            {i + 1} de {lista.length}
          </div>
        </>
      )}
    </div>,
    document.body
  );
}
