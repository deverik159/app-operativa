// ============================================================
// src/modules/comprobaciones/ArmarPautaVV.tsx
// Armar · Vía Verde desde Pauta VV y el plano (23-oct-2026).
//
// POR QUÉ. En Vía Verde las campañas ya viven en la app (vv_campanas,
// vv_pautas) y lo que comercial no capturó está en el plano (vv_ocupacion).
// El Supervisor no puede leer esas tablas directo (llegarían vacías y la
// foto completa retiraría todo), así que se piden con comp_fuente_pauta_vv.
// Reglas que NO se negocian:
//   · si la RPC falla, no se arma nada;
//   · desdePautaVV compara con los totales: si algo llegó incompleto
//     regresa `errores` y tampoco se carga;
//   · la carga es la FOTO COMPLETA del periodo y del medio (p_completa =
//     true): lo de Pauta VV o del plano que ya no viene se retira. Por eso
//     la previa enseña las retiradas antes de confirmar.
// ============================================================

import { useState } from 'react';
import { AVISO_PLANO_OTRO_MES, desdePautaVV, type ResultadoPautaVV } from '../../lib/bitacoraComp';
import { leerFuentePautaVV, textoFallaComp, type FuentePautaVV } from '../../lib/comprobacionesApi';
import type { PropsArmar } from './tiposComp';
import { fmt, sitiosDe, type EntradaMedio } from './ArmarComun';
import { Caja, ListaPlegable, PreviaCarga, TablaContrato } from './ArmarCarga';

type Lectura = { fuente: FuentePautaVV; res: ResultadoPautaVV };

export default function ArmarPautaVV({ ctx }: { ctx: PropsArmar }) {
  const [lectura, setLectura] = useState<Lectura | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [err, setErr] = useState('');
  const [previa, setPrevia] = useState(0);
  const ocupado = ctx.ocupado != null;

  const leer = async () => {
    setErr('');
    setLectura(null);
    setLeyendo(true);
    const r = await leerFuentePautaVV(ctx.periodo.inicio, ctx.periodo.fin);
    setLeyendo(false);
    if (!r.ok) {
      setErr('No se pudo leer Pauta VV; no se armó nada. ' + textoFallaComp(r));
      return;
    }
    const f = r.data;
    const res = desdePautaVV(
      f.campanas,
      f.pautas,
      f.ocupacion,
      { tipo: ctx.periodo.tipo, anio: ctx.periodo.anio, numero: ctx.periodo.numero, inicio: ctx.periodo.inicio, fin: ctx.periodo.fin },
      {
        totales: { campanas: f.totales?.campanas, pautas: f.totales?.pautas, ocupacion: f.totales?.ocupacion },
        espaciosVV: f.espacios,
      }
    );
    setLectura({ fuente: f, res });
  };

  const res = lectura?.res;
  const entradas: EntradaMedio[] = res
    ? (['Columna', 'Pórtico'] as const).map((m) => ({ medio: m, campanas: res.porMedio[m] })).filter((e) => e.campanas.length > 0)
    : [];
  const vacios = res && !res.errores.length ? (['Columna', 'Pórtico'] as const).filter((m) => !res.porMedio[m].length) : [];
  const totalCampanas = entradas.reduce((a, e) => a + e.campanas.length, 0);
  const totalSitios = entradas.reduce((a, e) => a + sitiosDe(e.campanas), 0);

  if (previa && res && !res.errores.length)
    return (
      <PreviaCarga
        key={previa}
        ctx={ctx}
        entradas={entradas}
        // Foto completa: retira lo de Pauta VV y del plano que ya no viene (R1).
        completa={true}
        onVolver={(cargado) => {
          setPrevia(0);
          if (cargado) setLectura(null);
        }}
      />
    );

  return (
    <div>
      <p className="phint">
        Arma {ctx.periodo.etiqueta} con lo que ya está en Pauta VV y, para lo que no esté ahí, el plano. Cuenta como la foto
        completa del mes: lo de Pauta VV o del plano que ya no venga se retira (lo trabajado no se borra).
      </p>
      {err && <div className="err">{err}</div>}
      <button type="button" className="btn" disabled={leyendo || ocupado} onClick={leer} style={{ marginBottom: 14 }}>
        {leyendo ? 'Leyendo Pauta VV…' : lectura ? 'Leer de nuevo' : `Leer Pauta VV de ${ctx.periodo.etiqueta}`}
      </button>

      {lectura && res && (
        <>
          {res.avisos
            .filter((a) => a.startsWith(AVISO_PLANO_OTRO_MES))
            .map((a) => (
              <div key={a} className="banner">
                {a}
              </div>
            ))}
          <Caja titulo="Lo que llegó de Pauta VV y el plano">
            <div style={{ color: 'var(--muted)' }}>
              <b style={{ color: 'var(--txt)' }}>{fmt(lectura.fuente.campanas.length)}</b> campañas ·{' '}
              <b style={{ color: 'var(--txt)' }}>{fmt(lectura.fuente.pautas.length)}</b> pautas ·{' '}
              <b style={{ color: 'var(--txt)' }}>{fmt(lectura.fuente.ocupacion.length)}</b> líneas del plano
              {lectura.fuente.plano_mes ? ` (plano de ${lectura.fuente.plano_mes})` : ' (sin plano para el mes)'}
              <br />
              Arma: {(['Columna', 'Pórtico'] as const).map((m) => `${m} ${fmt(res.porMedio[m].length)} campañas · ${fmt(sitiosDe(res.porMedio[m]))} sitios`).join(' — ')}
            </div>
            <ListaPlegable tono="warn" abierta={res.avisos.length <= 4} titulo={`${fmt(res.avisos.length)} aviso(s)`} items={res.avisos} />
          </Caja>
          {res.errores.length > 0 && (
            <div className="err">
              <b>No se carga nada:</b>
              {res.errores.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}
          {vacios.length > 0 && entradas.length > 0 && (
            <div className="banner">
              {vacios.join(' y ')}: no hay campañas en Pauta VV ni en el plano para {ctx.periodo.etiqueta}; lo ya cargado de ese
              medio no se toca.
            </div>
          )}
          {!res.errores.length && totalCampanas === 0 && (
            <div className="empty">Pauta VV y el plano no traen campañas para {ctx.periodo.etiqueta}.</div>
          )}
          {!res.errores.length && totalCampanas > 0 && (
            <>
              <h3 style={{ fontSize: 15, margin: '6px 0 8px' }}>
                Lo que se armó: {fmt(totalCampanas)} campañas-versión · {fmt(totalSitios)} sitios
              </h3>
              <TablaContrato entradas={entradas} mostrarMedio />
              <button type="button" className="btn" disabled={ocupado} onClick={() => setPrevia((n) => n + 1)}>
                Revisar contra la base
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
