// ============================================================
// src/components/MenuMas.tsx
// "Más" del menú inferior en celular (rediseño "Precisión", oct-2026).
//
// Antes la barra de abajo era una tira con TODOS los módulos (7 a 11 para
// un coordinador o un manager) que había que deslizar de lado. Ahora en
// celular se quedan los 4 primeros —el orden de `nav` en App.tsx ya va por
// importancia según el rol— y el resto vive en esta hoja. En escritorio no
// cambia nada: el menú lateral sigue mostrando todo (CSS: .nav-extra y
// .nav-mas solo actúan a ≤780px, ver estilo/precision.css).
//
// La hoja se monta en <body> con un portal, por la misma razón que
// CampanaNotifs y MenuUsuario: en iOS lo fijo dentro de otra pieza fija o
// sticky pinta bien pero puede no recibir los toques.
//
// (1-nov-2026, Erik) Con 12 módulos la lista ya no cabe: la cabeza (asa y
// título) se queda fija y se arrastra hacia abajo para cerrar; solo la
// lista se desplaza. Antes el asa era puro dibujo y el dedo movía la lista.
// ============================================================
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import IconoNav from './IconoNav';

export type ItemMas = { k: string; ic: string; t: string; badge?: number };

type Props = {
  items: ItemMas[];
  /** La pestaña abierta está entre los de la hoja: "Más" se marca activo. */
  activa: boolean;
  onElegir: (item: ItemMas) => void;
};

export default function MenuMas({ items, activa, onElegir }: Props) {
  const [abierta, setAbierta] = useState(false);
  const pendientes = items.reduce((s, i) => s + (i.badge && i.badge > 0 ? i.badge : 0), 0);
  const hoja = useRef<HTMLDivElement>(null);
  const arrastre = useRef<{ y0: number; t0: number; dy: number } | null>(null);

  // Mueve la hoja con el dedo; `con` = con transición (soltar o regresar).
  const moverHoja = (dy: number, con: boolean) => {
    const h = hoja.current;
    if (!h) return;
    h.style.transition = con ? 'transform .2s cubic-bezier(.2,.8,.2,1)' : 'none';
    h.style.transform = dy ? `translateY(${dy}px)` : '';
  };

  const empezarArrastre = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    arrastre.current = { y0: e.clientY, t0: e.timeStamp, dy: 0 };
  };

  const seguirArrastre = (e: PointerEvent<HTMLDivElement>) => {
    const a = arrastre.current;
    if (!a) return;
    a.dy = Math.max(0, e.clientY - a.y0);
    moverHoja(a.dy, false);
  };

  // Cierra si bajó más de 80px o si fue un jalón rápido; si no, regresa.
  const soltarArrastre = (e: PointerEvent<HTMLDivElement>) => {
    const a = arrastre.current;
    arrastre.current = null;
    if (!a) return;
    const rapido = a.dy > 20 && a.dy / Math.max(1, e.timeStamp - a.t0) > 0.5;
    if (a.dy > 80 || rapido) {
      moverHoja(hoja.current?.offsetHeight ?? 600, true);
      setTimeout(() => setAbierta(false), 180);
    } else {
      moverHoja(0, true);
    }
  };

  useEffect(() => {
    if (!abierta) return;
    const tecla = (e: KeyboardEvent) => e.key === 'Escape' && setAbierta(false);
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [abierta]);

  return (
    <>
      <button
        type="button"
        className={'nav-item nav-mas' + (activa ? ' active' : '')}
        aria-haspopup="dialog"
        aria-expanded={abierta}
        onClick={() => setAbierta(true)}
      >
        <MoreHorizontal className="nav-ic" size={18} strokeWidth={1.8} aria-hidden="true" />
        <span>Más</span>
        {pendientes > 0 && <span className="badge">{pendientes}</span>}
      </button>
      {abierta &&
        createPortal(
          <>
            <div className="hoja-mas-velo" onClick={() => setAbierta(false)} />
            <div ref={hoja} className="hoja-mas" role="dialog" aria-label="Más módulos">
              <div
                className="hoja-mas-cabeza"
                onPointerDown={empezarArrastre}
                onPointerMove={seguirArrastre}
                onPointerUp={soltarArrastre}
                onPointerCancel={soltarArrastre}
              >
                <div className="hoja-mas-asa" />
                <h3>Más módulos</h3>
              </div>
              <div className="hoja-mas-lista">
                {items.map((n) => (
                  <button
                    key={n.k}
                    type="button"
                    className="hoja-mas-fila"
                    onClick={() => {
                      setAbierta(false);
                      onElegir(n);
                    }}
                  >
                    <span className="hoja-mas-ic">
                      <IconoNav k={n.k} emoji={n.ic} />
                    </span>
                    <span className="hoja-mas-t">{n.t}</span>
                    {!!n.badge && n.badge > 0 && <span className="badge">{n.badge}</span>}
                    <ChevronRight className="hoja-mas-chev" size={16} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
