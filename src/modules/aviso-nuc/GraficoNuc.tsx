// ============================================================
// src/modules/aviso-nuc/GraficoNuc.tsx
// Gráfico del historial de una máquina o pantalla (Erik, 4-nov-2026): día
// por día, cuánto tiempo estuvo fuera de línea y cuántas veces se cayó, en
// el rango de fechas que se elija (30 días por omisión).
//
// Una sola medida en el eje (horas fuera de línea, 0 a 24 h): las veces que
// se cayó van como etiqueta «×N» en los días con más de una caída, en la
// ventanita al tocar la barra y en la tabla de abajo. Nada de doble eje.
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import { sb } from '../../lib/supabase';
import { colorTono } from '../../lib/tonos';
import { diaCdmx, inicioDiaCdmx } from '../../lib/fechasCdmx';
import { diaSiguiente, diasFueraDeLinea, duracionTexto, type AvisoNuc, type DiaNuc } from '../../lib/avisoNuc';

type Tramo = Pick<AvisoNuc, 'id' | 'abierto_en' | 'cerrado_en'>;

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** '2026-11-04' → '4 nov'. */
const corto = (dia: string) => `${Number(dia.slice(8, 10))} ${MESES[Number(dia.slice(5, 7)) - 1] || ''}`;

/** `n` días antes de 'YYYY-MM-DD'. */
function diasAntes(dia: string, n: number): string {
  return new Date(Date.parse(dia + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
}

// Medidas del dibujo (viewBox; se escala al ancho de la ventana).
// Cerca del ancho real de la ventana (≈480 px), para que el texto del eje no
// se encoja de más; en el celular baja a ≈0.7.
const ANCHO = 480;
const ALTO = 170;
const IZQ = 44;
const DER = 8;
const ARRIBA = 18;
const ABAJO = 24;
const MARCAS_H = [0, 6, 12, 18, 24];

function GraficoNuc({ siteId }: { siteId: string }) {
  const hoy = diaCdmx(new Date());
  const [desde, setDesde] = useState(() => diasAntes(hoy, 29));
  const [hasta, setHasta] = useState(hoy);
  const [tramos, setTramos] = useState<Tramo[] | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<number | null>(null);

  const ini = inicioDiaCdmx(desde);
  const fin = inicioDiaCdmx(hasta);
  const rangoMal = ini === null || fin === null || hasta < desde;
  const largo = !rangoMal && (Date.parse(hasta) - Date.parse(desde)) / 86400000 >= 400;

  useEffect(() => {
    if (rangoMal || largo || ini === null) return;
    let vivo = true;
    setTramos(null);
    setErr('');
    setSel(null);
    const finIso = new Date(inicioDiaCdmx(diaSiguiente(hasta)) ?? (fin as number) + 86400000).toISOString();
    const iniIso = new Date(ini).toISOString();
    // Los avisos que tocan el rango: abiertos antes de que termine y cerrados
    // (o sin cerrar) después de que empieza.
    void sb.from('nuc_avisos').select('id,abierto_en,cerrado_en').eq('site_id', siteId)
      .lt('abierto_en', finIso).or(`cerrado_en.is.null,cerrado_en.gte.${iniIso}`)
      .order('abierto_en').limit(2000)
      .then(({ data, error }) => {
        if (!vivo) return;
        if (error) { setErr('No se pudo cargar el historial: ' + error.message); setTramos([]); return; }
        setTramos((data || []) as Tramo[]);
      });
    return () => { vivo = false; };
  }, [siteId, desde, hasta, rangoMal, largo, ini, fin]);

  const dias: DiaNuc[] = useMemo(
    () => (tramos && !rangoMal ? diasFueraDeLinea(tramos, desde, hasta) : []),
    [tramos, desde, hasta, rangoMal]
  );
  const total = dias.reduce((s, d) => s + d.minutos, 0);
  const caidas = dias.reduce((s, d) => s + d.caidas, 0);
  const conCaida = dias.filter((d) => d.minutos > 0 || d.caidas > 0);

  const rojo = colorTono('rojo');
  const n = dias.length || 1;
  const paso = (ANCHO - IZQ - DER) / n;
  const anchoBarra = Math.max(1, paso - 2); // 2 px de aire entre barras
  const altoUtil = ALTO - ARRIBA - ABAJO;
  const y = (min: number) => ARRIBA + altoUtil * (1 - min / 1440);
  // Fechas del eje: primera, última y unas cuantas en medio, sin enciman.
  const cadaCuanto = Math.max(1, Math.ceil(n / 5));

  const rapido = (diasAtras: number) => { setHasta(hoy); setDesde(diasAntes(hoy, diasAtras - 1)); };

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Días fuera de línea</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>Desde{' '}
          <input type="date" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} style={{ fontSize: 16 }} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>Hasta{' '}
          <input type="date" value={hasta} min={desde} max={hoy} onChange={(e) => setHasta(e.target.value)} style={{ fontSize: 16 }} />
        </label>
        {[7, 30, 90].map((d) => (
          <button key={d} type="button" className="btn ghost sm" onClick={() => rapido(d)}>{d} días</button>
        ))}
      </div>

      {rangoMal && <div className="err" role="alert">Revisa las fechas: «Desde» debe ser antes de «Hasta».</div>}
      {largo && <div className="err" role="alert">El rango es muy largo: elige menos de 400 días.</div>}
      {err && <div className="err" role="alert">{err}</div>}
      {!rangoMal && !largo && !tramos && <p style={{ fontSize: 13 }}>Cargando…</p>}

      {!rangoMal && !largo && tramos && !err && <>
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          {caidas
            ? <>Se cayó <b>{caidas} {caidas === 1 ? 'vez' : 'veces'}</b> · <b>{duracionTexto(total)}</b> fuera de línea en {conCaida.length} {conCaida.length === 1 ? 'día' : 'días'}</>
            : total ? <>Fuera de línea <b>{duracionTexto(total)}</b> (venía de antes del rango)</>
            : 'Sin caídas en este rango.'}
        </div>
        <div style={{ position: 'relative' }} onMouseLeave={() => setSel(null)}>
          <svg viewBox={`0 0 ${ANCHO} ${ALTO}`} width="100%" role="img"
            aria-label={`Horas fuera de línea por día, del ${corto(desde)} al ${corto(hasta)}: ${caidas} caídas, ${duracionTexto(total)} en total.`}
            style={{ display: 'block', overflow: 'visible' }}>
            {MARCAS_H.map((h) => (
              <g key={h}>
                <line x1={IZQ} x2={ANCHO - DER} y1={y(h * 60)} y2={y(h * 60)} stroke="var(--line)" strokeWidth={1} strokeDasharray={h ? '2 3' : undefined} />
                <text x={IZQ - 6} y={y(h * 60) + 4} textAnchor="end" fontSize={16} fill="var(--muted)">{h} h</text>
              </g>
            ))}
            {dias.map((d, i) => {
              const x = IZQ + i * paso + 1;
              // Una caída muy corta igual se ve: mínimo 2 px.
              const alto = d.minutos > 0 || d.caidas > 0 ? Math.max(2, altoUtil * (d.minutos / 1440)) : 0;
              const top = ARRIBA + altoUtil - alto;
              const r = Math.min(4, anchoBarra / 2, alto);
              return (
                <g key={d.dia}>
                  {alto > 0 && <path
                    d={`M${x},${top + alto} V${top + r} Q${x},${top} ${x + r},${top} H${x + anchoBarra - r} Q${x + anchoBarra},${top} ${x + anchoBarra},${top + r} V${top + alto} Z`}
                    fill={rojo} opacity={sel === null || sel === i ? 1 : 0.55} />}
                  {d.caidas > 1 && <text x={x + anchoBarra / 2} y={top - 4} textAnchor="middle" fontSize={16} fill="var(--txt)">×{d.caidas}</text>}
                  {(i % cadaCuanto === 0 || i === dias.length - 1) && (
                    <text x={x + anchoBarra / 2} y={ALTO - 6} textAnchor="middle" fontSize={16} fill="var(--muted)">{corto(d.dia)}</text>
                  )}
                  {/* Zona de toque: toda la columna, más grande que la barra. */}
                  <rect x={IZQ + i * paso} y={ARRIBA} width={paso} height={altoUtil} fill="transparent"
                    onMouseEnter={() => setSel(i)} onClick={() => setSel(i)} style={{ cursor: 'pointer' }} />
                </g>
              );
            })}
          </svg>
          {sel !== null && dias[sel] && (
            <div role="status" style={{
              position: 'absolute', top: 0,
              left: `${Math.min(70, Math.max(0, ((IZQ + sel * paso) / ANCHO) * 100 - 10))}%`,
              background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8,
              padding: '6px 9px', fontSize: 12, pointerEvents: 'none', boxShadow: '0 4px 14px rgba(0,0,0,.25)',
            }}>
              <b>{corto(dias[sel].dia)}</b><br />
              {duracionTexto(dias[sel].minutos)} fuera de línea<br />
              {dias[sel].caidas} {dias[sel].caidas === 1 ? 'caída' : 'caídas'}
            </div>
          )}
        </div>

        {conCaida.length > 0 && <table style={{ width: '100%', fontSize: 12, marginTop: 8, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
              <th style={{ fontWeight: 500, padding: '3px 4px' }}>Día</th>
              <th style={{ fontWeight: 500, padding: '3px 4px' }}>Fuera de línea</th>
              <th style={{ fontWeight: 500, padding: '3px 4px', textAlign: 'right' }}>Veces</th>
            </tr>
          </thead>
          <tbody>
            {conCaida.slice().reverse().map((d) => (
              <tr key={d.dia} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: '3px 4px' }}>{corto(d.dia)} {d.dia.slice(0, 4)}</td>
                <td style={{ padding: '3px 4px' }}>{duracionTexto(d.minutos)}</td>
                <td style={{ padding: '3px 4px', textAlign: 'right' }}>{d.caidas}</td>
              </tr>
            ))}
          </tbody>
        </table>}
      </>}
    </div>
  );
}

export default GraficoNuc;
