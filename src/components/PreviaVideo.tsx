// ============================================================
// src/components/PreviaVideo.tsx
// Previa de un video sin bajar el video (25-sep-2026): el cuadro que se
// guardó al subirlo (misma ruta mini/…jpg que las miniaturas de foto, ver
// lib/storage.ts) con un ▶ encima. Los videos subidos antes no tienen
// cuadro: queda un recuadro oscuro con "🎬 Video", para que se note que SÍ
// hay algo adjunto — antes la tarjeta salía vacía y parecía que no.
// ============================================================
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { urlMiniatura } from '../lib/storage';

type Props = {
  url: string;
  /** Texto para lector de pantalla (el recuadro no tiene más texto útil). */
  alt: string;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  /** Miniatura chica (citas, 36-64px): ▶ chico y sin la leyenda. */
  compacta?: boolean;
};

export default function PreviaVideo({
  url,
  alt,
  className,
  style,
  onClick,
  compacta = false,
}: Props) {
  const [sinCuadro, setSinCuadro] = useState(false);
  // Si la misma caja pasa a otro video, se vuelve a intentar su cuadro.
  useEffect(() => setSinCuadro(false), [url]);
  const boton = compacta ? 18 : 46;
  return (
    <div
      className={className}
      onClick={onClick}
      role="img"
      aria-label={alt}
      style={{
        position: 'relative',
        overflow: 'hidden',
        // Negro en los dos temas, como las franjas de un reproductor.
        background: '#000',
        ...style,
      }}
    >
      {!sinCuadro && (
        <img
          src={urlMiniatura(url)}
          alt=""
          loading="lazy"
          onError={() => setSinCuadro(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      )}
      {sinCuadro && !compacta && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 10,
            textAlign: 'center',
            color: '#fff',
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          🎬 Video
        </span>
      )}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: boton,
          height: boton,
          borderRadius: '50%',
          background: 'rgba(0,0,0,.55)',
          border: `${compacta ? 1 : 2}px solid rgba(255,255,255,.9)`,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: compacta ? 9 : 20,
          // El ▶ se ve cargado a la izquierda: se centra a ojo.
          paddingLeft: compacta ? 1 : 3,
          boxSizing: 'border-box',
        }}
      >
        ▶
      </span>
    </div>
  );
}
