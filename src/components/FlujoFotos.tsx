// ============================================================
// src/components/FlujoFotos.tsx
// Flujo de fotos reutilizable: tomar → previsualizar → quitar,
// con la opción "No pude tomar foto" + motivo obligatorio.
//
// Es el patrón que ya usa Fijación Externa y el que pide el pendiente 9.2
// (fotos de comprobación de fijación interna). Componente CONTROLADO: el
// padre es dueño del estado, para que pueda subirlas con subirFotos().
// ============================================================
import type { FotoLocal } from '../lib/storage';
import { aFotosLocales } from '../lib/storage';

type FlujoFotosProps = {
  fotos: FotoLocal[];
  onFotos: (fotos: FotoLocal[]) => void;
  /** Marcado "no pude tomar foto". Omitir para desactivar esa opción. */
  sinFoto?: boolean;
  onSinFoto?: (v: boolean) => void;
  motivo?: string;
  onMotivo?: (v: string) => void;
  /** Texto del botón de captura. */
  etiqueta?: string;
  /** Deshabilita todo mientras se guarda. */
  disabled?: boolean;
  /** Máximo de fotos permitidas. 0 = sin límite. */
  max?: number;
};

function FlujoFotos({
  fotos,
  onFotos,
  sinFoto,
  onSinFoto,
  motivo = '',
  onMotivo,
  etiqueta = '📷 Agregar foto',
  disabled = false,
  max = 0,
}: FlujoFotosProps) {
  // La opción "no pude" solo se ofrece si el padre pasa su handler.
  const permiteSinFoto = typeof onSinFoto === 'function';
  const lleno = max > 0 && fotos.length >= max;

  const agregar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nuevas = aFotosLocales(e.target.files);
    const juntas = [...fotos, ...nuevas];
    onFotos(max > 0 ? juntas.slice(0, max) : juntas);
    // Permite volver a elegir el mismo archivo.
    e.target.value = '';
  };

  const quitar = (i: number) => {
    try {
      URL.revokeObjectURL(fotos[i].preview);
    } catch {
      /* ya liberado */
    }
    onFotos(fotos.filter((_, idx) => idx !== i));
  };

  return (
    <div className="field">
      <label>
        Fotos {max > 0 ? `(máx. ${max})` : ''}
        {fotos.length > 0 ? ` · ${fotos.length} seleccionada${fotos.length > 1 ? 's' : ''}` : ''}
      </label>

      {!sinFoto && (
        <>
          {fotos.length > 0 && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill,minmax(84px,1fr))',
                gap: 8,
                marginBottom: 10,
              }}
            >
              {fotos.map((f, i) => (
                <div key={f.preview} style={{ position: 'relative' }}>
                  <img
                    src={f.preview}
                    alt={`Foto ${i + 1}`}
                    style={{
                      width: '100%',
                      height: 84,
                      objectFit: 'cover',
                      borderRadius: 9,
                      border: '1px solid var(--line)',
                      display: 'block',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => quitar(i)}
                    disabled={disabled}
                    aria-label={`Quitar foto ${i + 1}`}
                    style={{
                      position: 'absolute',
                      top: 3,
                      right: 3,
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      border: 'none',
                      background: 'rgba(0,0,0,.72)',
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: 13,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <label
            className={'btn ghost sm' + (disabled || lleno ? ' disabled' : '')}
            style={{
              display: 'inline-block',
              cursor: disabled || lleno ? 'not-allowed' : 'pointer',
              opacity: disabled || lleno ? 0.5 : 1,
            }}
          >
            {lleno ? 'Límite alcanzado' : etiqueta}
            <input
              type="file"
              accept="image/*"
              // capture: en móvil abre la cámara directamente.
              capture="environment"
              multiple={max !== 1}
              onChange={agregar}
              disabled={disabled || lleno}
              style={{ display: 'none' }}
            />
          </label>
        </>
      )}

      {permiteSinFoto && (
        <div style={{ marginTop: 10 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              cursor: disabled ? 'not-allowed' : 'pointer',
              color: 'var(--muted)',
              fontWeight: 600,
            }}
          >
            <input
              type="checkbox"
              checked={!!sinFoto}
              disabled={disabled}
              onChange={(e) => onSinFoto?.(e.target.checked)}
            />
            No pude tomar foto
          </label>

          {sinFoto && (
            <div style={{ marginTop: 8 }}>
              <textarea
                value={motivo}
                onChange={(e) => onMotivo?.(e.target.value)}
                disabled={disabled}
                rows={3}
                placeholder="¿Por qué no se pudo tomar la foto? (obligatorio)"
                style={{ width: '100%' }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Valida el flujo antes de guardar. Devuelve el mensaje de error, o null si
 * todo bien. Se usa igual en todos los módulos para que el mensaje no varíe.
 */
export function validarFlujoFotos(
  fotos: FotoLocal[],
  sinFoto: boolean,
  motivo: string
): string | null {
  if (!sinFoto && fotos.length === 0)
    return "Sube al menos una foto, o marca 'No pude tomar foto' con un motivo.";
  if (sinFoto && !motivo.trim())
    return 'Escribe el motivo por el que no pudiste tomar la foto.';
  return null;
}

export default FlujoFotos;
