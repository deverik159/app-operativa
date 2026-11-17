// ============================================================
// src/lib/marcarFoto.ts
// Marcar la falla sobre la foto antes de mandarla (Erik, 17-nov-2026).
//
// Algunos reportantes encierran la falla en un óvalo con el editor de su
// teléfono antes de adjuntar la foto. La app lo hace igual en cualquier
// teléfono: óvalo, flecha o trazo libre. Se sube solo la foto marcada.
//
// Aquí van las cuentas y el dibujo, sin pantalla: se prueban en
// tests/marcarFoto.test.mjs. La pantalla es components/MarcarFoto.tsx.
// ============================================================

export type Herramienta = 'ovalo' | 'flecha' | 'libre';

export type Punto = { x: number; y: number };

/** Una marca, en pixeles de la foto (no de la pantalla). */
export type Marca = {
  tipo: Herramienta;
  color: string;
  /** Óvalo y flecha: inicio y fin del arrastre. Libre: todo el trazo. */
  puntos: Punto[];
};

export const COLORES = [
  { nombre: 'Rojo', valor: '#ff2d2d' },
  { nombre: 'Amarillo', valor: '#ffd400' },
] as const;

/** Lado mayor con el que se dibuja y se guarda: el mismo tope que la compresión. */
export const LADO_MAX_MARCA = 1600;

/** Grosor de la línea según el tamaño de la foto: ~8 px en una de 1600. */
export function grosor(ancho: number, alto: number): number {
  return Math.max(3, Math.round(Math.max(ancho, alto) / 200));
}

/**
 * Del toque en pantalla a pixeles de la foto. `caja` es el rectángulo del
 * canvas en pantalla (getBoundingClientRect); el resultado queda dentro de
 * la foto aunque el dedo se salga.
 */
export function aPuntoFoto(
  clienteX: number,
  clienteY: number,
  caja: { left: number; top: number; width: number; height: number },
  ancho: number,
  alto: number
): Punto {
  const x = ((clienteX - caja.left) / (caja.width || 1)) * ancho;
  const y = ((clienteY - caja.top) / (caja.height || 1)) * alto;
  return {
    x: Math.min(ancho, Math.max(0, x)),
    y: Math.min(alto, Math.max(0, y)),
  };
}

/**
 * ¿La marca tiene tamaño? Un toque sin arrastrar no deja un punto rojo
 * suelto en la foto. `minimo` en pixeles de la foto.
 */
export function marcaValida(m: Marca, minimo: number): boolean {
  if (m.puntos.length < 2) return false;
  const xs = m.puntos.map((p) => p.x);
  const ys = m.puntos.map((p) => p.y);
  const ancho = Math.max(...xs) - Math.min(...xs);
  const alto = Math.max(...ys) - Math.min(...ys);
  if (m.tipo === 'ovalo') return ancho >= minimo && alto >= minimo;
  return Math.hypot(ancho, alto) >= minimo;
}

/** Centro y radios del óvalo que cabe en el arrastre. */
export function ovaloDe(a: Punto, b: Punto): { cx: number; cy: number; rx: number; ry: number } {
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    rx: Math.abs(b.x - a.x) / 2,
    ry: Math.abs(b.y - a.y) / 2,
  };
}

/** Las dos alas de la punta de la flecha, que apunta a `fin`. */
export function puntaFlecha(inicio: Punto, fin: Punto, largo: number): [Punto, Punto] {
  const ang = Math.atan2(fin.y - inicio.y, fin.x - inicio.x);
  const abre = Math.PI / 7;
  return [
    { x: fin.x - largo * Math.cos(ang - abre), y: fin.y - largo * Math.sin(ang - abre) },
    { x: fin.x - largo * Math.cos(ang + abre), y: fin.y - largo * Math.sin(ang + abre) },
  ];
}

/** Lo mínimo del contexto 2D que usa el dibujo (así se prueba sin navegador). */
export type Lienzo = Pick<
  CanvasRenderingContext2D,
  'beginPath' | 'moveTo' | 'lineTo' | 'ellipse' | 'stroke' | 'save' | 'restore'
> & {
  strokeStyle: CanvasRenderingContext2D['strokeStyle'];
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  shadowColor: string;
  shadowBlur: number;
};

/**
 * Pinta una marca. Lleva una sombra oscura suave para que el rojo y el
 * amarillo se lean sobre cualquier fondo.
 */
export function dibujarMarca(ctx: Lienzo, m: Marca, g: number): void {
  if (m.puntos.length < 2) return;
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.lineWidth = g;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = g;
  ctx.beginPath();
  const a = m.puntos[0];
  const b = m.puntos[m.puntos.length - 1];
  if (m.tipo === 'ovalo') {
    const o = ovaloDe(a, b);
    ctx.ellipse(o.cx, o.cy, Math.max(o.rx, 1), Math.max(o.ry, 1), 0, 0, Math.PI * 2);
  } else if (m.tipo === 'flecha') {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    const [i, d] = puntaFlecha(a, b, g * 4);
    ctx.moveTo(i.x, i.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(d.x, d.y);
  } else {
    ctx.moveTo(a.x, a.y);
    for (const p of m.puntos.slice(1)) ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Nombre de la foto marcada: el mismo con «_marcada», siempre .jpg. */
export function nombreMarcada(nombre: string): string {
  const base = nombre.replace(/\.[^.]+$/, '').replace(/_marcada$/, '');
  return `${base}_marcada.jpg`;
}
