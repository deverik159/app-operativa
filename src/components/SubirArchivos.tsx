// ============================================================
// src/components/SubirArchivos.tsx
// Selector de fotos y videos pensado para campo.
//
// Reemplaza al <input type="file"> crudo, que en móvil se ve como un botón
// gris "Elegir archivos" seguido de "No se eligió ningún archivo" — poco
// claro y con un objetivo táctil diminuto.
//
// En móvil ofrece DOS caminos, porque son cosas distintas:
//   📷 Cámara  → deja elegir entre tomar foto y grabar video.
//   🖼️ Galería → input sin capture: abre el carrete o el explorador.
//
// El botón de cámara solo aparece en dispositivos táctiles: en escritorio
// `capture` se ignora y el usuario acabaría con dos botones que hacen lo
// mismo.
// ============================================================
import { useRef, useState, useEffect } from 'react';
import { prepararArchivos } from '../lib/comprimirImagen';

type Props = {
  /** Recibe los archivos elegidos. Se acumulan en el padre, no aquí. */
  onFiles: (files: File[]) => void;
  /** Archivos ya elegidos, para pintar miniaturas. Omitir si el padre sube al instante. */
  archivos?: File[];
  /** Quitar uno de la lista de arriba. */
  onQuitar?: (indice: number) => void;
  multiple?: boolean;
  disabled?: boolean;
  /** Por defecto acepta foto y video. */
  accept?: string;
  /** Texto de ayuda bajo los botones. */
  ayuda?: string;
};

/** ¿El dispositivo se maneja con el dedo? Entonces tiene cámara usable. */
function usaTactil(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/** Miniatura de un File. Crea y libera su objectURL. */
function MiniFile({
  file,
  onQuitar,
  disabled,
}: {
  file: File;
  onQuitar?: () => void;
  disabled?: boolean;
}) {
  const [url, setUrl] = useState('');
  const esVideo = file.type.startsWith('video');

  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    // Sin revoke, cada foto elegida queda en memoria hasta recargar.
    return () => URL.revokeObjectURL(u);
  }, [file]);

  return (
    <div style={{ position: 'relative', width: 76 }}>
      {esVideo ? (
        <div
          style={{
            width: 76,
            height: 76,
            borderRadius: 9,
            border: '1px solid var(--line)',
            background: 'var(--panel2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 24,
          }}
        >
          🎥
        </div>
      ) : (
        url && (
          <img
            src={url}
            alt={file.name}
            style={{
              width: 76,
              height: 76,
              objectFit: 'cover',
              borderRadius: 9,
              border: '1px solid var(--line)',
              display: 'block',
            }}
          />
        )
      )}
      {onQuitar && (
        <button
          type="button"
          onClick={onQuitar}
          disabled={disabled}
          aria-label={`Quitar ${file.name}`}
          style={{
            position: 'absolute',
            top: 3,
            right: 3,
            /* 30 y no 24: mismo criterio que .btn-icono — un ✕ de 24px en
               la esquina de una miniatura de 76px es imposible de atinar
               con el dedo y se borraba la foto equivocada. */
            width: 30,
            height: 30,
            borderRadius: '50%',
            border: 'none',
            background: 'rgba(0,0,0,.75)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function SubirArchivos({
  onFiles,
  archivos,
  onQuitar,
  multiple = true,
  disabled = false,
  accept = 'image/*,video/*',
  ayuda,
}: Props) {
  const camFotoRef = useRef<HTMLInputElement>(null);
  const camVideoRef = useRef<HTMLInputElement>(null);
  const galRef = useRef<HTMLInputElement>(null);
  // Se calcula una vez: el tipo de puntero no cambia durante la sesión.
  const [tactil] = useState(usaTactil);
  const [procesando, setProcesando] = useState(false);
  const [eligeCamara, setEligeCamara] = useState(false);

  const aceptaFoto = accept.includes('image');
  const aceptaVideo = accept.includes('video');

  const manejar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setEligeCamara(false);
    // Permite volver a elegir el MISMO archivo (si no, onChange no dispara).
    e.target.value = '';
    if (!files.length) return;
    // Comprimir/validar AQUÍ, al elegir — no al guardar. Antes una foto de
    // iPhone de 8 MB (o un video que rebasaba el bucket) se descubría hasta
    // el final de la revisión, y el error tumbaba TODO el guardado con un
    // mensaje de "mala señal" que invitaba a reintentar en vano.
    setProcesando(true);
    const { listos, rechazos } = await prepararArchivos(files);
    setProcesando(false);
    if (rechazos.length) alert('No se agregaron:\n\n' + rechazos.join('\n'));
    if (listos.length) onFiles(listos);
  };

  const estiloBoton: React.CSSProperties = {
    flex: '1 1 140px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 46,
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {tactil && (
          <button
            type="button"
            className="btn"
            style={estiloBoton}
            disabled={disabled || procesando}
            onClick={() => {
              if (aceptaFoto && aceptaVideo) setEligeCamara((v) => !v);
              else if (aceptaVideo) camVideoRef.current?.click();
              else camFotoRef.current?.click();
            }}
          >
            {procesando ? (
              <span className="spinner" />
            ) : (
              <span style={{ fontSize: 17 }}>📷</span>
            )}{' '}
            {procesando ? 'Procesando…' : 'Cámara'}
          </button>
        )}
        <button
          type="button"
          className="btn ghost"
          style={estiloBoton}
          disabled={disabled || procesando}
          onClick={() => galRef.current?.click()}
        >
          <span style={{ fontSize: 17 }}>🖼️</span>{' '}
          {tactil ? 'Galería' : 'Elegir archivos'}
        </button>
      </div>

      {tactil && eligeCamara && aceptaFoto && aceptaVideo && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 8,
            marginTop: 8,
            padding: 8,
            border: '1px solid var(--line)',
            borderRadius: 10,
            background: 'var(--panel2)',
          }}
        >
          <button
            type="button"
            className="btn ghost"
            disabled={disabled || procesando}
            onClick={() => camFotoRef.current?.click()}
          >
            📷 Tomar foto
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={disabled || procesando}
            onClick={() => camVideoRef.current?.click()}
          >
            🎥 Grabar video
          </button>
        </div>
      )}

      {/* Inputs reales, ocultos: foto y video van separados porque Android
          no abre bien la cámara con un accept mixto, mientras que iPhone
          puede bloquear el cambio de modo si recibe solo image/*. */}
      <input
        ref={camFotoRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={manejar}
        disabled={disabled}
        style={{ display: 'none' }}
      />
      <input
        ref={camVideoRef}
        type="file"
        accept="video/*"
        capture="environment"
        onChange={manejar}
        disabled={disabled}
        style={{ display: 'none' }}
      />
      <input
        ref={galRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={manejar}
        disabled={disabled}
        style={{ display: 'none' }}
      />

      {archivos && archivos.length > 0 && (
        <div
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}
        >
          {archivos.map((f, i) => (
            <MiniFile
              key={`${f.name}-${f.lastModified}-${i}`}
              file={f}
              disabled={disabled}
              onQuitar={onQuitar ? () => onQuitar(i) : undefined}
            />
          ))}
        </div>
      )}

      {ayuda && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
          {ayuda}
        </div>
      )}
    </div>
  );
}

export default SubirArchivos;
