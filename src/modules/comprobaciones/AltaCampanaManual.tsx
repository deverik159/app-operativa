// ============================================================
// src/modules/comprobaciones/AltaCampanaManual.tsx
// Armar · Alta manual de una campaña-versión (23-oct-2026).
//
// POR QUÉ. Lo que no viene en la bitácora ni en Pauta VV (sobre todo
// Biobox) lo da de alta el Supervisor: campaña, versión, fechas y sitios
// escogidos por modelo, por ruta o en lista. armarAlta (bitacoraComp.ts)
// valida lo mismo que la base para avisar ANTES de llamar; luego pasa por
// la misma previa y carga que las otras fuentes (fuente 'manual', que
// nunca retira nada).
// Biobox y Ecovallas Digital corren 24 horas: no se pide horario y se
// enseña «24 HORAS». En Vía Verde sí (L-V y S-D), y una Columna puede ser
// FULL (la meta sale de los minutos).
// ============================================================

import { useMemo, useState } from 'react';
import { armarAlta, type CampanaContrato } from '../../lib/bitacoraComp';
import { HORARIO_24H, esMedio24h, type MedioComp } from '../../lib/comprobaciones';
import { mediosDe } from '../../lib/comprobacionesApi';
import type { PropsArmar } from './tiposComp';
import type { EstadoInventario } from './ArmarComun';
import { ListaPlegable, PreviaCarga } from './ArmarCarga';
import AltaCampanaSitios from './AltaCampanaSitios';

type Form = {
  medio: MedioComp;
  campana: string;
  version: string;
  cliente: string;
  vendedor: string;
  inicio: string;
  fin: string;
  tipoVenta: '' | 'VENTA' | 'BONUS';
  arte: '' | 'NUEVO' | 'REPITE';
  especificacion: string;
  analista: string;
  horarioLv: string;
  horarioSd: string;
  esFull: boolean;
  fullMinutos: string;
  sitios: string[];
};

export default function AltaCampanaManual({ ctx, inventario }: { ctx: PropsArmar; inventario: EstadoInventario }) {
  const medios = mediosDe(ctx.unidad);
  const vacio = (medio: MedioComp): Form => ({
    medio,
    campana: '',
    version: '',
    cliente: '',
    vendedor: '',
    inicio: ctx.periodo.inicio,
    fin: ctx.periodo.fin,
    tipoVenta: 'VENTA',
    arte: '',
    especificacion: '',
    analista: '',
    horarioLv: '',
    horarioSd: '',
    esFull: false,
    fullMinutos: '',
    sitios: [],
  });
  const [f, setF] = useState<Form>(() => vacio(medios[0]));
  const [errores, setErrores] = useState<string[]>([]);
  const [listo, setListo] = useState<{ campana: CampanaContrato; avisos: string[] } | null>(null);
  const [previa, setPrevia] = useState(0);
  const ocupado = ctx.ocupado != null;
  const es24 = esMedio24h(f.medio);
  const analistas = useMemo(() => ctx.equipo.filter((m) => m.rol === 'analista' && m.asignable), [ctx.equipo]);
  const pon = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const revisar = () => {
    const inv = inventario.caras ? inventario.caras.map((c) => c.vendor_face_id) : null;
    const r = armarAlta({
      unidad: ctx.unidad,
      medio: f.medio,
      campana: f.campana,
      version: f.version,
      cliente: f.cliente,
      vendedor: f.vendedor,
      especificacion: f.especificacion,
      arte: f.arte || null,
      inicio: f.inicio || null,
      fin: f.fin || null,
      horario_lv: es24 ? null : f.horarioLv,
      horario_sd: es24 ? null : f.horarioSd,
      tipo_venta: f.tipoVenta || null,
      es_full: f.medio === 'Columna' && f.esFull,
      full_minutos: f.esFull && f.fullMinutos ? Number(f.fullMinutos) : null,
      analista_email: f.analista || null,
      sitios: f.sitios,
      inventario: inv,
    });
    const extra: string[] = [];
    if (f.inicio && f.inicio > ctx.periodo.fin) extra.push(`La campaña empieza después de ${ctx.periodo.etiqueta}.`);
    if (f.fin && f.fin < ctx.periodo.inicio) extra.push(`La campaña termina antes de ${ctx.periodo.etiqueta}.`);
    if (!r.campana || extra.length) {
      setErrores([...r.errores, ...extra]);
      setListo(null);
      return;
    }
    setErrores([]);
    setListo({ campana: r.campana, avisos: r.avisos });
    setPrevia((n) => n + 1);
  };

  if (previa && listo)
    return (
      <div>
        {listo.avisos.length > 0 && (
          <div className="banner">
            {listo.avisos.slice(0, 4).map((a, i) => (
              <div key={i}>{a}</div>
            ))}
            {listo.avisos.length > 4 && <ListaPlegable titulo={`+${listo.avisos.length - 4} más`} items={listo.avisos.slice(4)} />}
          </div>
        )}
        <PreviaCarga
          key={previa}
          ctx={ctx}
          entradas={[{ medio: f.medio, campanas: [listo.campana] }]}
          completa={null}
          onVolver={(cargado) => {
            setPrevia(0);
            if (cargado) {
              setListo(null);
              // Se queda el medio y las fechas: lo usual es dar de alta varias seguidas.
              setF((x) => ({ ...vacio(x.medio), inicio: x.inicio, fin: x.fin }));
            }
          }}
        />
      </div>
    );

  return (
    <div>
      <p className="phint">
        Para lo que no viene en la bitácora{ctx.unidad === 'Vía Verde' ? ' ni en Pauta VV' : ''}. Una campaña con varias
        versiones se da de alta una vez por versión.
      </p>
      {errores.length > 0 && (
        <div className="err">
          {errores.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}
      {medios.length > 1 && (
        <div className="field">
          <label>Medio</label>
          <div className="rt-chips rt-segmento" role="group" aria-label="Medio">
            {medios.map((m) => (
              <button
                key={m}
                type="button"
                className={'rt-chip' + (f.medio === m ? ' on' : '')}
                aria-pressed={f.medio === m}
                disabled={ocupado}
                onClick={() => m !== f.medio && setF((x) => ({ ...x, medio: m, sitios: [], esFull: false }))}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="row2">
        <div className="field">
          <label htmlFor="alta-campana">Campaña *</label>
          <input id="alta-campana" value={f.campana} onChange={(e) => pon('campana', e.target.value)} disabled={ocupado} />
        </div>
        <div className="field">
          <label htmlFor="alta-version">Versión</label>
          <input
            id="alta-version"
            value={f.version}
            placeholder="V1 (vacío si no tiene)"
            onChange={(e) => pon('version', e.target.value)}
            disabled={ocupado}
          />
        </div>
      </div>
      <div className="row2">
        <div className="field">
          <label htmlFor="alta-cliente">Cliente</label>
          <input id="alta-cliente" value={f.cliente} onChange={(e) => pon('cliente', e.target.value)} disabled={ocupado} />
        </div>
        <div className="field">
          <label htmlFor="alta-vendedor">Vendedor</label>
          <input id="alta-vendedor" value={f.vendedor} onChange={(e) => pon('vendedor', e.target.value)} disabled={ocupado} />
        </div>
      </div>
      <div className="row2">
        <div className="field">
          <label htmlFor="alta-inicio">Inicio</label>
          <input id="alta-inicio" type="date" value={f.inicio} onChange={(e) => pon('inicio', e.target.value)} disabled={ocupado} />
        </div>
        <div className="field">
          <label htmlFor="alta-fin">Fin</label>
          <input id="alta-fin" type="date" value={f.fin} onChange={(e) => pon('fin', e.target.value)} disabled={ocupado} />
        </div>
      </div>
      <div className="row2">
        <div className="field">
          <label htmlFor="alta-venta">Tipo</label>
          <select id="alta-venta" value={f.tipoVenta} onChange={(e) => pon('tipoVenta', e.target.value as Form['tipoVenta'])} disabled={ocupado}>
            <option value="VENTA">Venta</option>
            <option value="BONUS">Bonus</option>
            <option value="">Sin dato</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="alta-arte">Arte</label>
          <select id="alta-arte" value={f.arte} onChange={(e) => pon('arte', e.target.value as Form['arte'])} disabled={ocupado}>
            <option value="">Sin dato</option>
            <option value="NUEVO">Nuevo</option>
            <option value="REPITE">Repite</option>
          </select>
        </div>
      </div>
      {es24 ? (
        <div className="field">
          <label>Horario</label>
          <div style={{ fontSize: 13 }}>
            <b>{HORARIO_24H}</b> <span style={{ color: 'var(--muted)' }}>(corre todo el día, sin franjas)</span>
          </div>
        </div>
      ) : (
        <div className="row2">
          <div className="field">
            <label htmlFor="alta-hlv">Horario lunes a viernes</label>
            <input
              id="alta-hlv"
              value={f.horarioLv}
              placeholder="06:00 A 10:00 / 18:00 A 22:00"
              onChange={(e) => pon('horarioLv', e.target.value)}
              disabled={ocupado}
            />
          </div>
          <div className="field">
            <label htmlFor="alta-hsd">Horario sábado y domingo</label>
            <input id="alta-hsd" value={f.horarioSd} onChange={(e) => pon('horarioSd', e.target.value)} disabled={ocupado} />
          </div>
        </div>
      )}
      {f.medio === 'Columna' && (
        <div className="row2">
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 13 }}>
            <input type="checkbox" checked={f.esFull} onChange={(e) => pon('esFull', e.target.checked)} disabled={ocupado} />
            Es FULL (todas las columnas)
          </label>
          {f.esFull && (
            <div className="field">
              <label htmlFor="alta-min">Minutos del FULL</label>
              <input
                id="alta-min"
                type="number"
                min={1}
                inputMode="numeric"
                value={f.fullMinutos}
                onChange={(e) => pon('fullMinutos', e.target.value)}
                disabled={ocupado}
              />
            </div>
          )}
        </div>
      )}
      <div className="row2">
        <div className="field">
          <label htmlFor="alta-analista">Analista (propuesta)</label>
          <select id="alta-analista" value={f.analista} onChange={(e) => pon('analista', e.target.value)} disabled={ocupado}>
            <option value="">Sin analista</option>
            {analistas.map((a) => (
              <option key={a.email} value={a.email}>
                {ctx.nombreDe(a.email)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="alta-espec">Especificación de tomas</label>
          <input
            id="alta-espec"
            value={f.especificacion}
            placeholder="FOTOS DEL 1 AL 5…"
            onChange={(e) => pon('especificacion', e.target.value)}
            disabled={ocupado}
          />
        </div>
      </div>

      <h3 style={{ fontSize: 15, margin: '8px 0 8px' }}>Sitios</h3>
      <AltaCampanaSitios
        ctx={ctx}
        medio={f.medio}
        inventario={inventario}
        seleccion={f.sitios}
        onCambio={(s) => pon('sitios', s)}
        disabled={ocupado}
      />

      <div style={{ marginTop: 16 }}>
        <button type="button" className="btn" disabled={ocupado || !f.campana.trim()} onClick={revisar}>
          Revisar contra la base
        </button>
      </div>
    </div>
  );
}
