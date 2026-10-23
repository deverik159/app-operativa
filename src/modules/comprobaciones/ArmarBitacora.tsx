// ============================================================
// src/modules/comprobaciones/ArmarBitacora.tsx
// Armar · Bitácora comercial (Ecovallas Digital y Biobox; también lee la
// de Vía Verde). 23-oct-2026.
//
// POR QUÉ. Erik: el área comercial le comparte a Victor la BITÁCORA (una
// hoja por campaña) y de ahí salen las campañas del periodo. Los libros
// reales pesan 67-103 MB por las imágenes: se leen SOLO las celdas
// (leerLibroLigero quita imágenes y dibujos antes de SheetJS) y se enseña
// el avance. Se pueden subir varios archivos (una «ampliación» llega en
// otro libro). Lo que dice el lector (hojas saltadas, avisos, claves
// corregidas, sin inventario) se enseña ANTES de la previa de la base.
// ============================================================

import { useMemo, useRef, useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import Ic from '../../components/Ic';
import { esErrorDeChunk } from '../../lib/cargaDiferida';
import { leerBitacora, type PlanSugerido, type ResultadoBitacora } from '../../lib/bitacoraComp';
import { mediosDe } from '../../lib/comprobacionesApi';
import { errorLectorEnEspanol } from '../../lib/importadorComp';
import type { MedioComp } from '../../lib/comprobaciones';
import type { PropsArmar } from './tiposComp';
import { fmt, leerLibroLigero, sitiosDe, type EntradaMedio, type EstadoInventario, type PasoLectura } from './ArmarComun';
import { Caja, ListaPlegable, PreviaCarga, TablaContrato } from './ArmarCarga';

type ArchivoLeido = {
  id: number;
  nombre: string;
  mb: number;
  quitadoMB: number;
  porMedio: { medio: MedioComp; r: ResultadoBitacora }[];
  sinInventario: boolean;
};

const PASO_TEXTO: Record<PasoLectura, string> = {
  archivo: 'abriendo el archivo',
  imagenes: 'quitando imágenes',
  hojas: 'leyendo las hojas',
};

const ESTADO_HOJA: Record<string, string> = {
  oculta: 'oculta',
  sin_tabla: 'sin tabla de pautas',
  vacia: 'vacía',
};

export default function ArmarBitacora({ ctx, inventario }: { ctx: PropsArmar; inventario: EstadoInventario }) {
  const [archivos, setArchivos] = useState<ArchivoLeido[]>([]);
  const [progreso, setProgreso] = useState('');
  const [err, setErr] = useState('');
  const [previa, setPrevia] = useState(0);
  const sigId = useRef(1);
  const medios = mediosDe(ctx.unidad);
  const ocupado = ctx.ocupado != null;
  const leyendo = progreso !== '';

  const abrir = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const lista = [...(e.target.files ?? [])];
    e.target.value = '';
    if (!lista.length) return;
    setErr('');
    setProgreso('Leyendo el inventario…');
    const inv = await inventario.asegurar();
    const invBit = inv?.map((c) => ({ clave: c.vendor_face_id, tipo_medio: c.tipo_medio })) ?? null;
    const errores: string[] = [];
    for (let i = 0; i < lista.length; i++) {
      const f = lista[i];
      const mb = f.size / 1e6;
      const pre = `«${f.name}»${lista.length > 1 ? ` (${i + 1} de ${lista.length})` : ''} · ${mb.toFixed(0)} MB`;
      try {
        const { hojas, quitadoMB } = await leerLibroLigero(f, (p) => setProgreso(`${pre}: ${PASO_TEXTO[p]}…`));
        setProgreso(`${pre}: interpretando ${hojas.length} hojas…`);
        await new Promise((r) => setTimeout(r, 30));
        const porMedio = medios.map((medio) => ({
          medio,
          r: leerBitacora(
            { hojas },
            {
              unidad: ctx.unidad,
              medio,
              archivo: f.name,
              periodo: { inicio: ctx.periodo.inicio, fin: ctx.periodo.fin },
              catorcena: ctx.periodo.tipo === 'catorcena' ? ctx.periodo.numero : null,
              inventario: invBit,
            }
          ),
        }));
        const id = sigId.current++;
        // El mismo archivo otra vez reemplaza al anterior (no se suma dos veces).
        setArchivos((a) => [...a.filter((x) => x.nombre !== f.name), { id, nombre: f.name, mb, quitadoMB, porMedio, sinInventario: !invBit }]);
      } catch (ex) {
        console.warn('[comprobaciones] lector de Excel:', ex);
        errores.push(
          esErrorDeChunk(ex)
            ? 'No se pudo descargar el lector de Excel. Revisa tu señal e inténtalo de nuevo (si sigue, recarga la app).'
            : `No se pudo leer «${f.name}»: ${errorLectorEnEspanol(ex)}.`
        );
      }
    }
    setProgreso('');
    setErr(errores.join(' '));
  };

  const entradas: EntradaMedio[] = useMemo(
    () =>
      medios
        .map((m) => ({
          medio: m,
          campanas: archivos.flatMap((a) => a.porMedio.find((x) => x.medio === m)?.r.campanas ?? []),
        }))
        .filter((e) => e.campanas.length > 0),
    [archivos, medios]
  );
  const sugeridos = useMemo(() => {
    const s: Record<string, PlanSugerido> = {};
    for (const a of archivos) for (const x of a.porMedio) Object.assign(s, x.r.planesSugeridos);
    return s;
  }, [archivos]);
  const totalCampanas = entradas.reduce((a, e) => a + e.campanas.length, 0);
  const totalSitios = entradas.reduce((a, e) => a + sitiosDe(e.campanas), 0);

  if (previa)
    return (
      <PreviaCarga
        key={previa}
        ctx={ctx}
        entradas={entradas}
        completa={null}
        planesSugeridos={sugeridos}
        onVolver={(cargado) => {
          setPrevia(0);
          if (cargado) setArchivos([]);
        }}
      />
    );

  return (
    <div>
      <p className="phint">
        Sube la bitácora que comparte el área comercial (uno o varios .xlsx; una ampliación puede venir en otro archivo). Se
        leen solo las celdas: las imágenes no se cargan, aunque el archivo pese 100 MB. Solo entra lo que toca{' '}
        <b>{ctx.periodo.etiqueta}</b>.
      </p>
      {err && <div className="err">{err}</div>}
      {inventario.error && (
        <div className="banner">{inventario.error}. Las claves no se revisarán contra el inventario (la base sí lo hace en la previa).</div>
      )}
      <div className="field">
        <label htmlFor="comp-bitacora">Bitácora (.xlsx)</label>
        <input
          id="comp-bitacora"
          type="file"
          multiple
          accept=".xlsx,.xlsm,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          onChange={abrir}
          disabled={leyendo || ocupado}
        />
        {leyendo && (
          <div role="status" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            <span className="spinner" />
            {progreso}
          </div>
        )}
      </div>

      {archivos.map((a) => {
        const base = a.porMedio[0]?.r;
        if (!base) return null;
        const leidas = base.hojas.filter((h) => h.estado === 'leida');
        const saltadas = base.hojas.filter((h) => h.estado !== 'leida');
        const avisos = [...new Set(a.porMedio.flatMap((x) => x.r.avisos))];
        const descartadas = a.porMedio[0].r.descartadas.map(
          (d) => `${d.hoja}, fila ${d.fila}: ${d.motivo}${d.valor ? ` («${d.valor}»)` : ''}`
        );
        const corregidas = base.clavesCorregidas.map((c) => `${c.hoja}, fila ${c.fila}: ${c.original} → ${c.clave}`);
        const sinInv = [...new Map(a.porMedio.flatMap((x) => x.r.sinInventario).map((s) => [s.clave, s])).values()].map(
          (s) => `${s.clave} (${s.hoja}, fila ${s.filas.join(', ')})`
        );
        const campanas = a.porMedio.reduce((n, x) => n + x.r.campanas.length, 0);
        const sitios = a.porMedio.reduce((n, x) => n + sitiosDe(x.r.campanas), 0);
        return (
          <Caja
            key={a.id}
            titulo={
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Ic i={FileSpreadsheet} />
                <span style={{ overflowWrap: 'anywhere' }}>{a.nombre}</span>
                <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                  {a.mb.toFixed(0)} MB{a.quitadoMB >= 1 ? ` (${a.quitadoMB.toFixed(0)} MB de imágenes sin leer)` : ''}
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ marginLeft: 'auto' }}
                  disabled={ocupado}
                  onClick={() => setArchivos((xs) => xs.filter((x) => x.id !== a.id))}
                >
                  Quitar
                </button>
              </span>
            }
          >
            <div style={{ color: 'var(--muted)' }}>
              <b style={{ color: 'var(--txt)' }}>{fmt(leidas.length)}</b> hojas leídas de {fmt(base.hojas.length)} ·{' '}
              <b style={{ color: 'var(--txt)' }}>{fmt(campanas)}</b> campañas-versión ·{' '}
              <b style={{ color: 'var(--txt)' }}>{fmt(sitios)}</b> sitios
              {ctx.unidad !== 'Vía Verde' &&
                base.otroMedio.length > 0 &&
                ` · ${base.otroMedio.map((o) => `${fmt(o.sitios)} de ${o.medio}`).join(', ')} no entran`}
              {a.sinInventario && (
                <>
                  <br />
                  <span style={{ color: 'var(--warn)' }}>⚠ Leído sin inventario: las claves se revisan en la previa.</span>
                </>
              )}
            </div>
            {campanas === 0 && (
              <div className="err" style={{ marginTop: 8 }}>
                Este archivo no trae campañas de {ctx.periodo.etiqueta}. ¿Es la bitácora correcta y el periodo correcto?
              </div>
            )}
            <ListaPlegable
              tono="warn"
              abierta={avisos.length > 0 && avisos.length <= 4}
              titulo={`${fmt(avisos.length)} aviso(s) del lector`}
              items={avisos}
            />
            <ListaPlegable
              titulo={`${fmt(saltadas.length)} hoja(s) saltadas`}
              items={saltadas.map((h) => `${h.nombre}: ${ESTADO_HOJA[h.estado] ?? h.estado}`)}
            />
            <ListaPlegable tono="warn" titulo={`${fmt(descartadas.length)} renglón(es) que no entran`} items={descartadas} />
            <ListaPlegable titulo={`${fmt(corregidas.length)} clave(s) corregidas`} items={corregidas} />
            <ListaPlegable tono="warn" titulo={`${fmt(sinInv.length)} clave(s) que no están en el inventario`} items={sinInv} />
          </Caja>
        );
      })}

      {totalCampanas > 0 && (
        <>
          <h3 style={{ fontSize: 15, margin: '6px 0 8px' }}>
            Lo que se leyó: {fmt(totalCampanas)} campañas-versión · {fmt(totalSitios)} sitios
          </h3>
          <TablaContrato entradas={entradas} sugeridos={Object.keys(sugeridos).length ? sugeridos : null} mostrarMedio={entradas.length > 1} />
          <button type="button" className="btn" disabled={ocupado || leyendo} onClick={() => setPrevia((n) => n + 1)}>
            Revisar contra la base
          </button>
        </>
      )}
    </div>
  );
}
