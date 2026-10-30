// ============================================================
// src/modules/comprobaciones/TarjetaFotoComp.tsx
// Una foto de una toma en la revisión de «Mis campañas» (fase 3,
// incremento 3; 29-oct-2026). Patrón de TarjetaFoto de AnalistaPauta.
//
// Sobre la foto va la marca de la revisión, como lápiz sobre una hoja de
// contactos (maqueta «Mesa de revisión», 29-oct-2026): un óvalo verde si
// está correcta o editada y un tache rojo si se rechazó o está marcada para
// rechazar. La marca también va en texto (la pastilla): nunca solo el color.
//
// Las capturas de cámara (origen 'camara') cuentan solas: no llevan
// Correcta, Editada ni Rechazar; quien sube capturas puede quitarlas
// mientras la toma no esté comprobada.
// ============================================================

import { useRef } from 'react';
import { Check, Trash2, Upload } from 'lucide-react';
import Ic from '../../components/Ic';
import { colorTono, fondoTono, type Tono } from '../../lib/tonos';
import { esUrlVideo } from '../../lib/storage';
import { urlPublica } from '../../lib/revisionApi';
import { pathVigente, type FotoRev } from '../../lib/revisionTomas';
import { etiquetaDePos } from '../../lib/plantillasComp';

type Props = {
  f: FotoRev & { n: number | null };
  nombre: string;
  /** Quien revisa puede marcar esta foto (toma por revisar o comprobada, foto de campo vigente). */
  revisable: boolean;
  /** Se puede marcar para rechazar (solo con la toma por revisar o comprobada). */
  rechazable: boolean;
  /** Quien sube capturas puede quitar esta (toma no comprobada). */
  quitable: boolean;
  /** Tocar «Correcta» otra vez quita la marca (solo con la toma por revisar). */
  marcaQuitable: boolean;
  /** ≤ 780 px: controles de 44 px. */
  telefono?: boolean;
  elegida: boolean;
  ocupado: boolean;
  trabajando: boolean;
  nombreDe: (email: string | null | undefined) => string;
  onElegir: () => void;
  onCorrecta: () => void;
  onQuitarMarca: () => void;
  onEditada: (a: File) => void;
  onQuitarCaptura: () => void;
};

function estadoFoto(f: FotoRev, elegida: boolean): { texto: string; tono: Tono; marca: 'ok' | 'x' | null } {
  if (f.devuelta)
    return { texto: f.revision?.estado === 'rechazada' ? `Rechazada: ${f.revision.motivo || 'sin motivo'}` : 'Devuelta con la toma', tono: 'rojo', marca: 'x' };
  if (f.origen === 'camara') return { texto: 'De cámaras (cuenta sola)', tono: 'azul', marca: 'ok' };
  if (elegida) return { texto: 'Para rechazar', tono: 'rojo', marca: 'x' };
  if (f.revision?.estado === 'editada') return { texto: 'Editada', tono: 'azul', marca: 'ok' };
  if (f.revision?.estado === 'correcta') return { texto: 'Correcta', tono: 'verde', marca: 'ok' };
  return { texto: 'Sin revisar', tono: 'ambar', marca: null };
}

export default function TarjetaFotoComp(p: Props) {
  const { f } = p;
  const input = useRef<HTMLInputElement>(null);
  const path = pathVigente(f);
  const url = urlPublica(path);
  const original = urlPublica(f.path);
  const video = f.tipo === 'video' || esUrlVideo(path);
  const e = estadoFoto(f, p.elegida);
  const tactil = p.telefono ? { minHeight: 44 } : undefined;
  const etiqueta = etiquetaDePos(f.pos) + (f.momento ? ` de ${f.momento === 'dia' ? 'día' : 'noche'}` : '');
  return (
    <div
      style={{
        border: '1px solid ' + (p.elegida ? colorTono('rojo') : 'var(--line)'),
        borderRadius: 9,
        overflow: 'hidden',
        background: 'var(--panel2)',
        opacity: f.devuelta ? 0.75 : 1,
      }}
    >
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label={`${p.nombre}, ${etiqueta}: ${e.texto} (abre en otra pestaña)`}
        style={{ display: 'block', position: 'relative', background: 'var(--panel)', aspectRatio: '4 / 3' }}
      >
        {video ? (
          <video src={url} preload="metadata" muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : (
          <img src={url} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )}
        {e.marca && (
          <svg viewBox="0 0 100 75" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            {e.marca === 'ok' ? (
              <path
                d="M54 5 C 80 4, 95 14, 95 36 C 95 58, 78 70, 50 70 C 22 70, 5 59, 5 37 C 5 16, 22 6, 47 7 C 52 7, 56 8, 61 10"
                fill="none"
                stroke={f.origen === 'camara' ? '#5BA8FF' : '#2BE09A'}
                strokeWidth={2.4}
                strokeLinecap="round"
                style={{ filter: 'drop-shadow(0 0 1.5px rgba(0,0,0,.6))' }}
              />
            ) : (
              <g fill="none" stroke="#FF3B50" strokeWidth={2.6} strokeLinecap="round" style={{ filter: 'drop-shadow(0 0 1.5px rgba(0,0,0,.6))' }}>
                <path d="M10 9 C 35 27, 62 49, 90 67" />
                <path d="M89 8 C 63 29, 38 48, 12 68" />
              </g>
            )}
          </svg>
        )}
      </a>
      <div style={{ padding: '7px 8px', display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 11, fontWeight: 700 }}>
          <span style={{ overflowWrap: 'anywhere' }}>{p.nombre}</span>
          <span style={{ color: 'var(--muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{etiqueta}</span>
        </div>
        <span className="pill" style={{ background: fondoTono(e.tono), color: colorTono(e.tono), justifySelf: 'start', maxWidth: '100%', overflowWrap: 'anywhere' }}>
          {e.texto}
        </span>
        {f.origen === 'camara' && (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Subió {p.nombreDe(f.subido_por) || f.subido_por} · día {f.fecha.slice(8, 10)}/{f.fecha.slice(5, 7)}
          </div>
        )}
        {f.otras_tomas > 0 && !f.devuelta && f.origen === 'campo' && (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {p.elegida
              ? `Esta foto está en ${f.otras_tomas} ${f.otras_tomas === 1 ? 'versión más' : 'versiones más'} y ahí sigue como está; revísalas también.`
              : `También va en ${f.otras_tomas} ${f.otras_tomas === 1 ? 'versión más' : 'versiones más'}: Correcta y Editada se marcan en todas las que revisas.`}
          </div>
        )}
        {f.revision?.estado === 'editada' && (
          <a href={original} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
            Ver original
          </a>
        )}
        {(p.revisable || p.quitable) && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
            {p.trabajando && <span className="spinner" />}
            {p.revisable &&
              (f.revision?.estado === 'correcta' ? (
                <button
                  type="button"
                  className="btn ok sm"
                  style={tactil}
                  aria-pressed="true"
                  disabled={p.ocupado || !p.marcaQuitable}
                  onClick={p.onQuitarMarca}
                  title={p.marcaQuitable ? 'Quitar la marca' : 'La toma ya está comprobada: reábrela para cambiar la marca'}
                >
                  <Ic i={Check} />
                  Correcta
                </button>
              ) : (
                <button type="button" className="btn ghost sm" style={tactil} aria-pressed="false" disabled={p.ocupado || p.elegida} onClick={p.onCorrecta}>
                  <Ic i={Check} />
                  Correcta
                </button>
              ))}
            {p.revisable && !video && (
              <button
                type="button"
                className="btn ghost sm"
                style={tactil}
                disabled={p.ocupado || p.elegida}
                onClick={() => input.current?.click()}
                title="Subir la foto editada"
              >
                <Ic i={Upload} />
                {f.revision?.estado === 'editada' ? 'Otra editada' : 'Editada'}
              </button>
            )}
            {p.rechazable && (
              <label style={{ fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap', minHeight: p.telefono ? 44 : 32 }}>
                <input type="checkbox" checked={p.elegida} onChange={p.onElegir} disabled={p.ocupado} style={{ width: 'auto' }} />
                Rechazar
              </label>
            )}
            {p.quitable && (
              <button type="button" className="btn ghost sm" style={tactil} disabled={p.ocupado} onClick={p.onQuitarCaptura}>
                <Ic i={Trash2} />
                Quitar captura
              </button>
            )}
            <input
              ref={input}
              type="file"
              accept="image/*"
              hidden
              onChange={(ev) => {
                const a = ev.target.files?.[0];
                ev.target.value = '';
                if (a) p.onEditada(a);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
