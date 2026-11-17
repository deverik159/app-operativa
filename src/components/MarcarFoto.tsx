// ============================================================
// src/components/MarcarFoto.tsx
// Pantalla para marcar la falla sobre una foto antes de mandarla
// (Erik, 17-nov-2026): óvalo, flecha o trazo libre, en rojo o amarillo.
//
// Todo pasa en el teléfono, sin señal. Al tocar «Listo» la foto marcada
// reemplaza a la original en la lista (se sube solo la marcada, como con el
// editor del teléfono). Sin marcas, «Listo» no cambia nada.
// Las cuentas y el dibujo viven en lib/marcarFoto.ts.
// ============================================================
import { ArrowUpRight, Circle, Pencil, Trash2, Undo2, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  aPuntoFoto,
  COLORES,
  dibujarMarca,
  grosor,
  LADO_MAX_MARCA,
  marcaValida,
  nombreMarcada,
  type Herramienta,
  type Marca,
} from '../lib/marcarFoto';
import { useFocoModal } from '../lib/useFocoModal';
import Ic from './Ic';

type Fuente = ImageBitmap | HTMLImageElement;

/** Abre la foto respetando su orientación (igual que comprimirImagen). */
async function abrirFoto(file: File): Promise<Fuente> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Safari viejo o formato raro: cae al <img>.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('no decodificable'));
      img.src = url;
    });
    // Ya cargada: la URL se puede soltar, el <img> conserva la imagen.
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const HERRAMIENTAS: { id: Herramienta; nombre: string; icono: LucideIcon }[] = [
  { id: 'ovalo', nombre: 'Óvalo', icono: Circle },
  { id: 'flecha', nombre: 'Flecha', icono: ArrowUpRight },
  { id: 'libre', nombre: 'Trazo', icono: Pencil },
];

export default function MarcarFoto({
  file,
  onListo,
  onCancelar,
}: {
  file: File;
  /** La foto ya marcada (JPEG). */
  onListo: (marcada: File) => void;
  onCancelar: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fuenteRef = useRef<Fuente | null>(null);
  const [tam, setTam] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState('');
  const [herramienta, setHerramienta] = useState<Herramienta>('ovalo');
  const [color, setColor] = useState<string>(COLORES[0].valor);
  const [marcas, setMarcas] = useState<Marca[]>([]);
  const [guardando, setGuardando] = useState(false);
  /** La marca que se está dibujando con el dedo (no provoca renders). */
  const actualRef = useRef<{ marca: Marca; puntero: number } | null>(null);
  const marcasRef = useRef<Marca[]>([]);
  marcasRef.current = marcas;
  const cuadroRef = useRef(0);

  const raizRef = useRef<HTMLDivElement>(null);
  const tituloRef = useRef<HTMLHeadingElement>(null);

  const cancelar = useCallback(() => {
    if (marcasRef.current.length && !window.confirm('¿Descartar las marcas?')) return;
    onCancelar();
  }, [onCancelar]);
  useFocoModal(raizRef, tituloRef, cancelar);

  // Abrir la foto, al tamaño con el que se guarda.
  useEffect(() => {
    let vivo = true;
    abrirFoto(file)
      .then((f) => {
        if (!vivo) {
          if ('close' in f) f.close();
          return;
        }
        fuenteRef.current = f;
        const w0 = 'naturalWidth' in f ? f.naturalWidth : f.width;
        const h0 = 'naturalHeight' in f ? f.naturalHeight : f.height;
        const esc = Math.min(1, LADO_MAX_MARCA / Math.max(w0, h0, 1));
        setTam({ w: Math.max(1, Math.round(w0 * esc)), h: Math.max(1, Math.round(h0 * esc)) });
      })
      .catch(() => {
        if (vivo) setError('No se pudo abrir esta foto para marcarla.');
      });
    return () => {
      vivo = false;
      const f = fuenteRef.current;
      if (f && 'close' in f) f.close();
      fuenteRef.current = null;
      cancelAnimationFrame(cuadroRef.current);
    };
  }, [file]);

  /** Foto + marcas guardadas + la que se está dibujando. */
  const pintar = useCallback(() => {
    const cv = canvasRef.current;
    const f = fuenteRef.current;
    if (!cv || !f || !tam) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(f, 0, 0, tam.w, tam.h);
    const g = grosor(tam.w, tam.h);
    for (const m of marcasRef.current) dibujarMarca(ctx, m, g);
    if (actualRef.current) dibujarMarca(ctx, actualRef.current.marca, g);
  }, [tam]);

  useEffect(() => {
    pintar();
  }, [pintar, marcas]);

  const pintarPronto = () => {
    cancelAnimationFrame(cuadroRef.current);
    cuadroRef.current = requestAnimationFrame(pintar);
  };

  const punto = (e: React.PointerEvent<HTMLCanvasElement>) =>
    aPuntoFoto(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), tam!.w, tam!.h);

  const alBajar = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Un solo dedo a la vez: el segundo no empieza otra marca.
    if (!tam || actualRef.current || guardando) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = punto(e);
    actualRef.current = {
      puntero: e.pointerId,
      marca: { tipo: herramienta, color, puntos: [p, p] },
    };
  };

  const alMover = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = actualRef.current;
    if (!a || a.puntero !== e.pointerId) return;
    const p = punto(e);
    if (a.marca.tipo === 'libre') a.marca.puntos.push(p);
    else a.marca.puntos[1] = p;
    pintarPronto();
  };

  const alSoltar = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = actualRef.current;
    if (!a || a.puntero !== e.pointerId) return;
    actualRef.current = null;
    // Un toque sin arrastrar no deja marca.
    if (tam && marcaValida(a.marca, grosor(tam.w, tam.h) * 2)) {
      setMarcas((ms) => [...ms, a.marca]);
    } else {
      pintarPronto();
    }
  };

  const listo = async () => {
    const cv = canvasRef.current;
    if (!marcas.length) {
      onCancelar();
      return;
    }
    if (!cv) return;
    setGuardando(true);
    try {
      pintar();
      const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/jpeg', 0.85));
      if (!blob) throw new Error('sin imagen');
      onListo(new File([blob], nombreMarcada(file.name), { type: 'image/jpeg', lastModified: Date.now() }));
    } catch {
      setGuardando(false);
      alert('No se pudo guardar la foto marcada. Intenta otra vez o mándala sin marcar.');
    }
  };

  const barra: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'center',
  };
  const botonOscuro = (activo: boolean): React.CSSProperties => ({
    minHeight: 44,
    minWidth: 44,
    padding: '0 12px',
    borderRadius: 22,
    border: activo ? '2px solid #fff' : '1px solid rgba(255,255,255,.25)',
    background: activo ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.06)',
    color: '#fff',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    cursor: 'pointer',
  });
  /** Deshacer y Borrar todo: apagados mientras no hay marcas. */
  const sinMarcas: React.CSSProperties = {
    ...botonOscuro(false),
    opacity: marcas.length && !guardando ? 1 : 0.4,
  };

  return (
    <div
      ref={raizRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="marcar-foto-titulo"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1250,
        // Editor de fotos: fondo negro en los dos temas, como el visor.
        background: '#000',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingTop: 'max(10px, env(safe-area-inset-top))',
        paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
        paddingLeft: 'max(12px, env(safe-area-inset-left))',
        paddingRight: 'max(12px, env(safe-area-inset-right))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" style={botonOscuro(false)} onClick={cancelar} disabled={guardando}>
          Cancelar
        </button>
        <h2
          id="marcar-foto-titulo"
          ref={tituloRef}
          tabIndex={-1}
          style={{ flex: 1, textAlign: 'center', fontSize: 15, margin: 0, fontWeight: 600 }}
        >
          Marcar la falla
        </h2>
        <button
          type="button"
          className="btn"
          style={{ minHeight: 44 }}
          onClick={() => void listo()}
          disabled={guardando || !tam}
        >
          {guardando ? <span className="spinner" /> : 'Listo'}
        </button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {error ? (
          <div role="alert" style={{ textAlign: 'center', fontSize: 14 }}>
            {error}
          </div>
        ) : !tam ? (
          <span className="spinner" aria-label="Abriendo la foto" />
        ) : (
          <canvas
            ref={canvasRef}
            width={tam.w}
            height={tam.h}
            aria-label="Foto: arrastra el dedo para marcar"
            onPointerDown={alBajar}
            onPointerMove={alMover}
            onPointerUp={alSoltar}
            onPointerCancel={alSoltar}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              width: 'auto',
              height: 'auto',
              borderRadius: 6,
              // El dedo dibuja, no mueve la página ni hace zoom.
              touchAction: 'none',
              cursor: 'crosshair',
            }}
          />
        )}
      </div>

      <div style={{ fontSize: 12, color: 'rgba(255,255,255,.7)', textAlign: 'center' }}>
        {herramienta === 'ovalo'
          ? 'Arrastra el dedo para encerrar la falla.'
          : herramienta === 'flecha'
            ? 'Arrastra desde donde sale la flecha hasta la falla.'
            : 'Dibuja con el dedo.'}
      </div>

      <div style={barra}>
        {HERRAMIENTAS.map((h) => (
          <button
            key={h.id}
            type="button"
            style={botonOscuro(herramienta === h.id)}
            aria-pressed={herramienta === h.id}
            onClick={() => setHerramienta(h.id)}
          >
            <Ic i={h.icono} /> {h.nombre}
          </button>
        ))}
      </div>
      <div style={barra}>
        {COLORES.map((c) => (
          <button
            key={c.valor}
            type="button"
            aria-label={c.nombre}
            aria-pressed={color === c.valor}
            onClick={() => setColor(c.valor)}
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              border: color === c.valor ? '3px solid #fff' : '1px solid rgba(255,255,255,.35)',
              background: c.valor,
              cursor: 'pointer',
              padding: 0,
            }}
          />
        ))}
        <button
          type="button"
          style={sinMarcas}
          disabled={!marcas.length || guardando}
          onClick={() => setMarcas((ms) => ms.slice(0, -1))}
        >
          <Ic i={Undo2} /> Deshacer
        </button>
        <button
          type="button"
          style={sinMarcas}
          disabled={!marcas.length || guardando}
          onClick={() => setMarcas([])}
        >
          <Ic i={Trash2} /> Borrar todo
        </button>
      </div>
    </div>
  );
}
