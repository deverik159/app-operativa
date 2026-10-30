// ============================================================
// src/modules/biobox/VisitaMaquinaModal.tsx
// "Visita rápida" a una máquina Biobox (29-oct-2026).
//
// Lo pidieron los técnicos en la capacitación del 29-oct-2026: dejar
// constancia de que pasaron y la máquina funciona, sin llenar el checklist
// completo cada vez. Lo que se registra, y por qué así:
//   · HORA: la del toque en "Visita rápida" (cuando abre este modal).
//   · ¿FUNCIONA? Sí / No. Si no, una nota de qué tiene (obligatoria) y el
//     botón para revisarla a fondo y levantar la incidencia.
//   · FOTO obligatoria: la evidencia de que sí fue.
//   · GPS si se puede: se pide solo al abrir; el GPS del teléfono no
//     necesita internet. Si está a más de LEJOS_M de la máquina, NO se
//     bloquea (sin señal la visita se perdería): pide escribir por qué y el
//     coordinador lo ve. La base guarda la distancia con su propio cálculo.
// Guardar NO espera a la red: la visita queda en el teléfono (lib/visitas.ts,
// la misma cola de Mis rutas) y se manda sola.
// ============================================================
import { MapPin, Satellite } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import SubirArchivos from '../../components/SubirArchivos';
import { explicarErrorGps } from '../../lib/plataforma';
import { vigilarRender } from '../../lib/vigia';
import { marcarVisita } from '../../lib/visitas';
import { distanciaAMaquina, estaLejos, LEJOS_M } from '../../lib/visitaMaquina';
import type { MaquinaBiobox } from '../../lib/maquinasBiobox';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';

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

function textoMetros(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

function VisitaMaquinaModal({
  email,
  maquina,
  onClose,
  onGuardada,
  onRevisar,
}: {
  email: string;
  maquina: MaquinaBiobox;
  onClose: () => void;
  /** La visita quedó guardada (en el teléfono y, si hay señal, enviándose). */
  onGuardada: (aviso: string) => void;
  /** "Revisar a fondo": cierra esta y abre el checklist de la misma máquina. */
  onRevisar: () => void;
}) {
  vigilarRender('VisitaMaquinaModal');
  /** La hora se fija al tocar "Visita rápida" (montaje de este modal). */
  const [visitadoEn] = useState(() => new Date().toISOString());
  const [funciona, setFunciona] = useState<boolean | null>(null);
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
    // Solo al abrir: el toque en "Visita rápida" es el permiso del usuario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const distancia = gps.estado === 'listo' ? distanciaAMaquina({ lat: gps.lat, lng: gps.lng }, maquina) : null;
  const lejos = estaLejos(distancia, gps.estado === 'listo' ? gps.precision : null);
  const pideNota = funciona === false || lejos;
  const etiquetaNota =
    funciona === false && lejos
      ? 'Qué tiene la máquina y por qué estás lejos (obligatorio)'
      : funciona === false
        ? '¿Qué tiene? (obligatorio)'
        : lejos
          ? '¿Por qué marcas la visita lejos de la máquina? (obligatorio)'
          : 'Nota (opcional)';
  const faltaNota = pideNota && !nota.trim();
  const listo = funciona !== null && fotos.length > 0 && !faltaNota;
  const clave = maquina.site_legacy_id ? '#' + maquina.site_legacy_id : maquina.site_id;

  /** Un doble toque llega antes de que `guardando` deshabilite el botón. */
  const guardandoRef = useRef(false);
  const guardar = async () => {
    if (guardandoRef.current) return;
    if (funciona === null) return setErr('Indica si la máquina funciona.');
    if (!fotos.length) return setErr('La foto es obligatoria: toma al menos una de la máquina.');
    if (faltaNota) return setErr(funciona === false ? 'Escribe qué tiene la máquina.' : 'Escribe por qué estás lejos de la máquina.');
    setErr('');
    guardandoRef.current = true;
    setGuardando(true);
    const conGps = gps.estado === 'listo' ? gps : null;
    const r = await marcarVisita(email, {
      destino: 'maquina',
      funciona,
      ruta_id: null,
      site_id: maquina.site_id,
      resumen: `Visita rápida · ${maquina.site_id}`,
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
      `✓ Visita a ${maquina.site_id} guardada a las ${horaCorta(visitadoEn).replace(/\.$/, '')}` +
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
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="visita-maquina-titulo">
        <CerrarModal onClick={onClose} disabled={guardando} />
        <h2 id="visita-maquina-titulo" style={{ margin: '0 0 3px' }}>Visita rápida</h2>
        <p className="phint">
          <b>{clave}</b>
          {maquina.site_legacy_id && <> · {maquina.site_id}</>}
        </p>

        {err && <div className="err" role="alert">{err}</div>}

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
          <div><Ic i={MapPin} />{maquina.direccion || '(sin dirección)'}</div>
          <div style={{ color: 'var(--muted)' }}>
            🕒 Hora de la visita: <b style={{ color: 'var(--txt)' }}>{horaCorta(visitadoEn)}</b>
          </div>
          <div style={{ color: 'var(--muted)' }}>
            {gps.estado === 'buscando' && 'Buscando tu ubicación…'}
            {gps.estado === 'listo' && distancia == null && (
              <span style={{ color: 'var(--ok)' }}>
                <Ic i={Satellite} />Ubicación lista{gps.precision != null ? ` (±${gps.precision} m)` : ''}
              </span>
            )}
            {gps.estado === 'listo' && distancia != null && (
              <span style={{ color: lejos ? 'var(--warn)' : 'var(--ok)' }}>
                <Ic i={Satellite} />Estás a {textoMetros(distancia)} de la máquina
                {gps.precision != null ? ` (±${gps.precision} m)` : ''}
              </span>
            )}
          </div>
          {lejos && (
            <div style={{ color: 'var(--warn)', marginTop: 4 }}>
              Más de {LEJOS_M} m: la visita se guarda igual, pero escribe por qué. El coordinador la verá marcada
              «lejos».
              <div style={{ marginTop: 6 }}>
                <button type="button" className="btn ghost sm" onClick={pedirGps} disabled={guardando}>
                  Volver a ubicarme
                </button>
              </div>
            </div>
          )}
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
          <label id="visita-funciona">¿La máquina funciona?</label>
          <div role="group" aria-labelledby="visita-funciona" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button
              type="button"
              className={funciona === true ? 'btn' : 'btn ghost'}
              aria-pressed={funciona === true}
              onClick={() => setFunciona(true)}
              disabled={guardando}
            >
              ✓ Sí funciona
            </button>
            <button
              type="button"
              className={funciona === false ? 'btn danger' : 'btn ghost'}
              aria-pressed={funciona === false}
              onClick={() => setFunciona(false)}
              disabled={guardando}
            >
              ✕ No funciona
            </button>
          </div>
          {funciona === false && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Para levantar la incidencia,{' '}
              <button type="button" className="btn ghost sm" onClick={onRevisar} disabled={guardando}>
                revísala a fondo
              </button>{' '}
              (abre el checklist). Esta visita también puedes guardarla.
            </div>
          )}
        </div>

        <div className="field">
          <label>
            Foto de la máquina (obligatoria) —{' '}
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
            ayuda="Toma la foto de la máquina tal como está hoy."
          />
        </div>

        <div className="field">
          <label htmlFor="visita-nota">{etiquetaNota}</label>
          <textarea
            id="visita-nota"
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder={funciona === false ? 'Ej. pantalla apagada, no recibe envases…' : 'Ej. acceso cerrado, máquina tapada…'}
            disabled={guardando}
          />
        </div>

        <div className="modal-actions pie-fijo">
          <button type="button" className="btn ghost" onClick={onClose} disabled={guardando}>
            Cancelar
          </button>
          <button type="button" className="btn" onClick={guardar} disabled={guardando || !listo}>
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

export default VisitaMaquinaModal;
