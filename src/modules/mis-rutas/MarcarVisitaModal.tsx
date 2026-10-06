// ============================================================
// src/modules/mis-rutas/MarcarVisitaModal.tsx
// "Marcar visita" de una parada de Mis rutas (rutas, 5-oct-2026).
//
// Lo que se registra, y por qué así:
//   · HORA: la del toque en "Marcar visita" (cuando abre este modal), no la
//     del Guardar ni la de cuando llegue la señal: es la hora en que el
//     monitorista estaba frente al sitio.
//   · FOTO obligatoria (una o varias): es la evidencia de que sí fue. Solo
//     fotos; SubirArchivos las comprime al elegirlas.
//   · GPS si se puede: se pide solo al abrir. Si el teléfono lo niega o no
//     contesta, la visita se guarda SIN coordenadas y se dice (no bloquea).
//   · Nota opcional.
// Guardar NO espera a la red: la visita queda en el teléfono (lib/visitas.ts)
// y se manda sola; la parada enseña ⏳ mientras tanto.
// ============================================================
import { MapPin, Satellite } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import SubirArchivos from '../../components/SubirArchivos';
import { explicarErrorGps } from '../../lib/plataforma';
import { vigilarRender } from '../../lib/vigia';
import { marcarVisita } from '../../lib/visitas';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';

export type ParadaVisita = {
  ruta_id: number;
  site_id: string;
  secuencia: number | null;
  direccion: string | null;
  /** "Ruta 3 · Nombre" para el encabezado y el aviso de la cola. */
  rutaTexto: string;
};

type Gps =
  | { estado: 'buscando' }
  | { estado: 'listo'; lat: number; lng: number; precision: number | null }
  | { estado: 'sin'; motivo: string };

/** Tope del GPS: más que esto y se guarda sin coordenadas. */
const TOPE_GPS_MS = 15000;

function horaCorta(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function MarcarVisitaModal({
  email,
  parada,
  onClose,
  onGuardada,
}: {
  email: string;
  parada: ParadaVisita;
  onClose: () => void;
  /** La visita quedó guardada (en el teléfono y, si hay señal, enviándose). */
  onGuardada: (aviso: string) => void;
}) {
  // Dentro del ErrorBoundary de App: un ciclo de renders se vuelve error del
  // módulo y no app pasmada (ver lib/vigia.ts).
  vigilarRender('MarcarVisitaModal');
  /** La hora se fija al tocar "Marcar visita" (montaje de este modal). */
  const [visitadoEn] = useState(() => new Date().toISOString());
  const [fotos, setFotos] = useState<File[]>([]);
  const [nota, setNota] = useState('');
  const [gps, setGps] = useState<Gps>({ estado: 'buscando' });
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState('');
  const montado = useRef(true);
  /** Consecutivo del GPS: una respuesta de un pedido viejo no pisa la nueva. */
  const gpsSeq = useRef(0);

  const pedirGps = () => {
    const seq = ++gpsSeq.current;
    setGps({ estado: 'buscando' });
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGps({ estado: 'sin', motivo: 'Este teléfono no da la ubicación al navegador.' });
      return;
    }
    // Tope propio además del de getCurrentPosition: hay iPhone donde ni
    // contesta ni falla.
    const reloj = window.setTimeout(() => {
      if (!montado.current || seq !== gpsSeq.current) return;
      gpsSeq.current++;
      setGps({ estado: 'sin', motivo: 'El GPS no respondió a tiempo.' });
    }, TOPE_GPS_MS + 2000);
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          window.clearTimeout(reloj);
          if (!montado.current || seq !== gpsSeq.current) return;
          setGps({
            estado: 'listo',
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            precision: Number.isFinite(p.coords.accuracy) ? Math.round(p.coords.accuracy) : null,
          });
        },
        (e) => {
          window.clearTimeout(reloj);
          if (!montado.current || seq !== gpsSeq.current) return;
          setGps({ estado: 'sin', motivo: explicarErrorGps(e) });
        },
        { enableHighAccuracy: true, timeout: TOPE_GPS_MS, maximumAge: 30000 }
      );
    } catch {
      window.clearTimeout(reloj);
      setGps({ estado: 'sin', motivo: 'No se pudo pedir la ubicación.' });
    }
  };

  useEffect(() => {
    montado.current = true;
    pedirGps();
    return () => {
      montado.current = false;
      gpsSeq.current++;
    };
    // Solo al abrir: el toque en "Marcar visita" es el permiso del usuario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** (rutas, 5-oct-2026, revisión) Un doble toque en el mismo cuadro llega
   *  antes de que `guardando` deshabilite el botón: sin este ref salían dos
   *  visitas con dos cliente_id distintos. */
  const guardandoRef = useRef(false);
  const guardar = async () => {
    if (guardandoRef.current) return;
    if (!fotos.length) {
      setErr('La foto es obligatoria: toma al menos una del sitio.');
      return;
    }
    setErr('');
    guardandoRef.current = true;
    setGuardando(true);
    const conGps = gps.estado === 'listo' ? gps : null;
    const r = await marcarVisita(email, {
      ruta_id: parada.ruta_id,
      site_id: parada.site_id,
      resumen: `${parada.rutaTexto}${parada.secuencia != null ? ` · parada ${parada.secuencia}` : ''} · ${parada.site_id}`,
      visitado_en: visitadoEn,
      lat: conGps ? conGps.lat : null,
      lng: conGps ? conGps.lng : null,
      precision_m: conGps ? conGps.precision : null,
      nota: nota.trim() || null,
      fotos,
    }).catch((e: unknown) => ({ tipo: 'error' as const, mensaje: (e as Error)?.message || String(e) }));
    guardandoRef.current = false;
    if (!montado.current) return;
    setGuardando(false);
    if (r.tipo === 'error') {
      setErr('No se guardó la visita: ' + r.mensaje);
      return;
    }
    onGuardada(
      `✓ Visita a ${parada.site_id} guardada a las ${horaCorta(visitadoEn).replace(/\.$/, '')}` +
        (conGps ? '' : ' (sin ubicación GPS)') +
        (r.enTelefono
          ? '. Se envía sola; si no hay señal, al volver la red.'
          : '. No cupo en el teléfono: no cierres la app hasta que se envíe.')
    );
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        // Un roce en el fondo no cierra mientras se guarda en el teléfono.
        if ((e.target as HTMLElement).className === 'overlay' && !guardando) onClose();
      }}
    >
      <div className="modal">
        <CerrarModal onClick={onClose} disabled={guardando} />
        <h2 style={{ margin: '0 0 3px' }}>Marcar visita</h2>
        <p className="phint">
          {parada.rutaTexto}
          {parada.secuencia != null && ` · parada ${parada.secuencia}`} · <b>{parada.site_id}</b>
        </p>

        {err && <div className="err">{err}</div>}

        <div
          style={{
            background: 'var(--panel2)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '10px 12px',
            marginBottom: 14,
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <div><Ic i={MapPin} />{parada.direccion || '(sin dirección)'}</div>
          <div style={{ color: 'var(--muted)' }}>
            🕒 Hora de la visita: <b style={{ color: 'var(--txt)' }}>{horaCorta(visitadoEn)}</b>
          </div>
          <div style={{ color: 'var(--muted)' }}>
            {gps.estado === 'buscando' && 'Buscando tu ubicación…'}
            {gps.estado === 'listo' && (
              <span style={{ color: 'var(--ok)' }}>
                <Ic i={Satellite} />Ubicación lista{gps.precision != null ? ` (±${gps.precision} m)` : ''}
              </span>
            )}
          </div>
          {gps.estado === 'sin' && (
            <div style={{ color: 'var(--warn)', whiteSpace: 'pre-line', marginTop: 4 }}>
              <Ic i={Satellite} />Sin ubicación: {gps.motivo}
              {'\n'}La visita se guarda sin coordenadas.
              <div style={{ marginTop: 6 }}>
                <button type="button" className="btn ghost sm" onClick={pedirGps} disabled={guardando}>
                  Reintentar ubicación
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="field">
          <label>
            Fotos del sitio (obligatoria) —{' '}
            {fotos.length ? (
              <span style={{ color: 'var(--ok)' }}>✓ {fotos.length}</span>
            ) : (
              <span style={{ color: 'var(--accent-txt)' }}>falta al menos una</span>
            )}
          </label>
          <SubirArchivos
            accept="image/*"
            archivos={fotos}
            onFiles={(fs) => setFotos((prev) => [...prev, ...fs])}
            onQuitar={(i) => setFotos((prev) => prev.filter((_, j) => j !== i))}
            disabled={guardando}
            ayuda="Toma la foto del sitio tal como está hoy. Puedes agregar varias."
          />
        </div>

        <div className="field">
          <label>Nota (opcional)</label>
          <textarea
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Ej. sitio tapado por un árbol, acceso cerrado…"
            disabled={guardando}
          />
        </div>

        <div className="modal-actions pie-fijo">
          <button type="button" className="btn ghost" onClick={onClose} disabled={guardando}>
            Cancelar
          </button>
          <button type="button" className="btn" onClick={guardar} disabled={guardando || !fotos.length}>
            {guardando ? (
              <>
                <span className="spinner" /> Guardando…
              </>
            ) : (
              '✓ Guardar visita'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default MarcarVisitaModal;
