// ============================================================
// src/components/EnviosPendientes.tsx
// Aviso global de reportes que no han salido del teléfono.
//
// POR QUÉ (auditoría primer mes, 24-sep-2026): sin señal, el reporte queda
// en la cola del teléfono (lib/envios.ts) en vez de perderse. Este aviso es
// la mitad visible de esa cola: dice cuántos hay, los reintenta solo y deja
// descartarlos. Vive en el armazón (App) para verse desde cualquier pestaña.
//
// Cuándo se intenta enviar: al montar, al volver la red ('online'), al
// volver a primer plano (visibilitychange) y cada ~2 min mientras haya
// pendientes y la pestaña esté visible. Con la pestaña oculta no: en iOS
// el trabajo en segundo plano se congela y solo gastaría batería. Se
// intenta aunque el navegador diga que no hay red: en algunos Android lo
// dice en falso, y sin red de verdad el intento falla al instante
// (revisión primer mes, 24-sep-2026; ver procesarPendientes).
//
// Si el teléfono no tiene IndexedDB no truena nada: la cola vive en memoria
// y el aviso solo aparece si hay algo que avisar.
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  descartarEnvio,
  listarPendientes,
  procesarPendientes,
  registrarEmailActivo,
  suscribirEnvios,
  type ResumenPendiente,
} from '../lib/envios';

/** Reintento periódico mientras haya pendientes. */
const CADA_MS = 2 * 60 * 1000;

/** "14:05" si es de hoy; "22 sep. 14:05" si no. */
function hora(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const h = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? h
    : `${d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })} ${h}`;
}

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

function EnviosPendientes({
  email,
  onEnviado,
}: {
  email: string;
  onEnviado: () => void;
}) {
  const [lista, setLista] = useState<ResumenPendiente[]>([]);
  const [abierto, setAbierto] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  /** Avisos de la última vuelta (omitidos por duplicado, etc.): una vez. */
  const [mensajes, setMensajes] = useState<string[]>([]);
  // App pasa una flecha nueva en cada render: con ref no se re-suscribe todo.
  const onEnviadoRef = useRef(onEnviado);
  onEnviadoRef.current = onEnviado;
  const hayPendientesRef = useRef(false);

  // El borrador del alta usa este correo de respaldo cuando auth-js no da
  // la sesión a tiempo (sin red y con el token vencido).
  useEffect(() => {
    registrarEmailActivo(email);
  }, [email]);

  const refrescar = useCallback(async () => {
    try {
      const l = await listarPendientes(email);
      hayPendientesRef.current = l.length > 0;
      setLista(l);
    } catch {
      /* el aviso nunca debe romper la app */
    }
  }, [email]);

  const procesar = useCallback(
    async () => {
      if (!email) return;
      setTrabajando(true);
      try {
        const r = await procesarPendientes(email);
        if (r.mensajes.length) setMensajes((m) => [...m, ...r.mensajes]);
        // Salió al menos uno (o ya existe su incidencia): que App recargue
        // las listas, como con ↻.
        if (r.terminados > 0 || r.conFilasNuevas > 0) onEnviadoRef.current();
      } catch {
        /* se reintenta en la siguiente vuelta */
      } finally {
        setTrabajando(false);
        refrescar();
      }
    },
    [email, refrescar]
  );

  // Cambios en la cola (de esta pestaña o de otra). Con un respiro: cada
  // foto subida avisa, y no hace falta releer la cola por cada una.
  useEffect(() => {
    let t: number | undefined;
    const quitar = suscribirEnvios(() => {
      window.clearTimeout(t);
      t = window.setTimeout(refrescar, 250);
    });
    refrescar();
    return () => {
      quitar();
      window.clearTimeout(t);
    };
  }, [refrescar]);

  // Los disparadores del reintento automático.
  useEffect(() => {
    if (!email) return;
    procesar();
    const alVolverRed = () => procesar();
    const alVerse = () => {
      if (document.visibilityState === 'visible') procesar();
    };
    window.addEventListener('online', alVolverRed);
    document.addEventListener('visibilitychange', alVerse);
    const reloj = window.setInterval(() => {
      if (hayPendientesRef.current && document.visibilityState === 'visible') procesar();
    }, CADA_MS);
    return () => {
      window.removeEventListener('online', alVolverRed);
      document.removeEventListener('visibilitychange', alVerse);
      window.clearInterval(reloj);
    };
  }, [email, procesar]);

  const descartar = async (p: ResumenPendiente) => {
    const texto = p.filasCreadas
      ? `La incidencia de ${p.sitio} YA existe en el sistema: solo se descartarán ` +
        `${plural(p.archivosPendientes, 'foto o video que faltaba', 'fotos o videos que faltaban')} ` +
        'por subir.\n\n¿Descartarlos?'
      : `¿Descartar el reporte de ${p.sitio}?\n\nSe borra de este teléfono y NO se enviará.`;
    if (!confirm(texto)) return;
    const r = await descartarEnvio(p.id);
    if (r === 'ocupado')
      alert('Ese reporte se está enviando en este momento. Espera a que termine e intenta de nuevo.');
    refrescar();
  };

  if (!lista.length && !mensajes.length) return null;

  const n = lista.length;
  const soloFotos = n > 0 && lista.every((p) => p.filasCreadas);
  const titulo = soloFotos
    ? `📤 Fotos de ${plural(n, 'reporte', 'reportes')} sin subir`
    : `📤 ${plural(n, 'reporte', 'reportes')} sin enviar`;
  const enRiesgo = lista.some((p) => p.soloMemoria || p.fueraDelTelefono > 0);

  return (
    <div className="banner" style={{ margin: '10px 16px 0' }} role="status">
      {mensajes.map((m, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            marginBottom: 6,
            color: 'var(--warn)',
          }}
        >
          <span style={{ minWidth: 0 }}>{m}</span>
          <button
            type="button"
            className="btn ghost sm"
            aria-label="Cerrar aviso"
            onClick={() => setMensajes((ms) => ms.filter((_, j) => j !== i))}
            style={{ flexShrink: 0 }}
          >
            ✕
          </button>
        </div>
      ))}

      {n > 0 && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ flex: '1 1 220px', minWidth: 0 }}>
              <b>{titulo}</b> ·{' '}
              {trabajando ? 'enviando…' : 'se reintenta solo al volver la señal'}
            </span>
            <button
              type="button"
              className="btn sm"
              disabled={trabajando}
              onClick={() => procesar()}
            >
              {trabajando && <span className="spinner" />} Reintentar ahora
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setAbierto((a) => !a)}
              aria-expanded={abierto}
            >
              {abierto ? 'Ocultar' : 'Ver detalle'}
            </button>
          </div>
          {enRiesgo && (
            <div style={{ marginTop: 6, color: 'var(--warn)' }}>
              ⚠️ Parte de esto no cupo en el teléfono: no cierres la app hasta que se envíe.
            </div>
          )}

          {abierto &&
            lista.map((p) => (
              <div
                key={p.id}
                style={{
                  borderTop: '1px solid #26344d',
                  marginTop: 8,
                  paddingTop: 8,
                  display: 'flex',
                  gap: 10,
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                }}
              >
                {/* minWidth:0: una clave de sitio larga encoge en vez de
                    empujar el botón fuera del aviso. */}
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <div style={{ fontWeight: 700 }}>{p.sitio}</div>
                  <div>
                    {plural(p.partidas, 'partida', 'partidas')} ·{' '}
                    {plural(p.filas, 'cara', 'caras')} · {hora(p.creado_en)}
                    {p.enviando && ' · enviando…'}
                  </div>
                  {p.filasCreadas && (
                    <div>
                      La incidencia ya se creó; faltan{' '}
                      {plural(p.archivosPendientes, 'archivo', 'archivos')}.
                    </div>
                  )}
                  {p.soloMemoria && (
                    <div style={{ color: 'var(--warn)' }}>
                      No se pudo guardar en el teléfono: si cierras la app, se pierde.
                    </div>
                  )}
                  {!p.soloMemoria && p.fueraDelTelefono > 0 && (
                    <div style={{ color: 'var(--warn)' }}>
                      {plural(p.fueraDelTelefono, 'archivo no cupo', 'archivos no cupieron')} en
                      el teléfono: si cierras la app, habrá que subirlos de nuevo.
                    </div>
                  )}
                  {p.ultimoError && (
                    <div style={{ opacity: 0.75 }}>Último intento: {p.ultimoError}</div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={p.enviando || trabajando}
                  onClick={() => descartar(p)}
                  style={{ flexShrink: 0 }}
                >
                  Descartar
                </button>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

export default EnviosPendientes;
