// ============================================================
// src/modules/comprobaciones/DescargarExcel.tsx
// Supervisor · Excel: los tres archivos de siempre, ARMADOS por la app
// (rediseño de Erik, 23-oct-2026: «que Victor desde la app construya ese
// excel que hoy se usa y cuesta tiempo»). Por cada medio de la unidad
// (Vía Verde: columnas y pórticos van en archivos distintos, como hoy):
//   1. Asignación de clientes, con su COMPROBACIÓN DIARIA (vw_comp_diaria)
//      y la ESPECIFICACIÓN DE TOMAS;
//   2. Formato general (vw_comp_tomas, sin las quitadas);
//   3. lo de los monitoristas: en Ecovallas Digital UN archivo compartido
//      con una columna por persona (como hoy) o uno por persona; en Biobox
//      y Vía Verde uno por monitorista y turno. Solo lo que falta tomar.
//
// Los archivos los arma excelComp.ts (puro y probado) con el mapeo de las
// vistas que pide la integración: venta ← meta, ejecutivo ← administrador,
// ruta ← ruta_numero, horario ← horario_texto («24 HORAS» en Ecovallas
// Digital y Biobox), estado <> 'cancelada'. La librería de Excel se baja
// solo al descargar (cargarXlsx). Cada descarga relee la base: el Excel es
// una foto del momento, no se arma con lo que quedó en pantalla.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import type { WorkBook } from 'xlsx';
import { Download, FileSpreadsheet } from 'lucide-react';
import Ic from '../../components/Ic';
import { ETIQUETA_UNIDAD_COMP, compararNatural, type MedioComp } from '../../lib/comprobaciones';
import {
  aLibroXlsx,
  armarArchivosMonitoristas,
  armarAsignacion,
  armarFormatoGeneral,
  campanasExcelDeVista,
  SIN_MONITORISTA_EXCEL,
  tomaParaCampo,
  tomasExcelDeVista,
  type LibroExcel,
  type PeriodoExcel,
  type TomaExcel,
  type XlsxMinimo,
} from '../../lib/excelComp';
import {
  leerCampanas,
  leerDiaria,
  leerMonitoristas,
  leerTomas,
  mediosDe,
  nombresPorCorreo,
  textoFallaComp,
  type VwCampana,
} from '../../lib/comprobacionesApi';
import { cargarXlsx } from '../../lib/xlsxDiferido';
import { vigilarRender } from '../../lib/vigia';
import type { PropsPestanaComp } from './tiposComp';

const ETIQUETA_MEDIO: Record<MedioComp, string> = {
  Pantalla: 'Ecovallas Digital',
  Máquina: 'Biobox',
  Columna: 'Vía Verde · columnas',
  Pórtico: 'Vía Verde · pórticos',
};

type Orden = 'vendedor' | 'analista' | 'campana';
type FormatoMon = 'como_hoy' | 'por_persona';

/** Los archivos de monitoristas ya armados, para bajarlos uno por uno. */
type ArchivosMon = {
  medio: MedioComp;
  libros: { libro: LibroExcel; renglones: number; sinMonitorista: boolean }[];
};

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Renglones de datos de un libro (el encabezado está en la fila 4). */
const renglonesDe = (l: LibroExcel) => Math.max(0, (l.hojas[0]?.filas.length ?? 4) - 4);

/**
 * Escribe los libros con SheetJS. Varios seguidos con una pausa: Safari
 * (iPhone) se salta descargas disparadas en el mismo instante.
 */
async function bajarLibros(libros: LibroExcel[]): Promise<string | null> {
  let XLSX: typeof import('xlsx');
  try {
    XLSX = await cargarXlsx();
  } catch {
    return 'No se pudo preparar el Excel. Revisa tu conexión e inténtalo de nuevo.';
  }
  try {
    for (let i = 0; i < libros.length; i++) {
      if (i) await pausa(700);
      const wb = aLibroXlsx(libros[i], XLSX as unknown as XlsxMinimo) as WorkBook;
      XLSX.writeFile(wb, libros[i].nombreArchivo);
    }
  } catch (e) {
    return 'No se pudo guardar el archivo: ' + (e instanceof Error ? e.message : String(e));
  }
  return null;
}

/** Orden de las filas de la Asignación (excelComp las deja como llegan). */
function ordenar(cams: VwCampana[], orden: Orden, nombre: (e: string | null) => string): VwCampana[] {
  const k = (s: string | null | undefined) => (s || '').trim().toUpperCase();
  const camp = (a: VwCampana, b: VwCampana) =>
    k(a.campana).localeCompare(k(b.campana), 'es') || compararNatural(a.version, b.version) || a.id - b.id;
  const l = [...cams];
  if (orden === 'vendedor') l.sort((a, b) => k(a.vendedor).localeCompare(k(b.vendedor), 'es') || camp(a, b));
  else if (orden === 'analista')
    l.sort(
      (a, b) =>
        (a.analista_email ? 0 : 1) - (b.analista_email ? 0 : 1) ||
        k(nombre(a.analista_email)).localeCompare(k(nombre(b.analista_email)), 'es') ||
        camp(a, b)
    );
  else l.sort(camp);
  return l;
}

export default function DescargarExcel(props: PropsPestanaComp) {
  vigilarRender('DescargarExcel');
  const { unidad, periodo, campanas, equipo, telefono, avisar, cargando } = props;
  const medios = mediosDe(unidad);

  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [aviso, setAviso] = useState('');
  const [soloHabiles, setSoloHabiles] = useState(true);
  const [omitirRetiradas, setOmitirRetiradas] = useState(false);
  const [orden, setOrden] = useState<Orden>('vendedor');
  const [nota, setNota] = useState('');
  const [formatoEco, setFormatoEco] = useState<FormatoMon>('como_hoy');
  const [archivosMon, setArchivosMon] = useState<ArchivosMon | null>(null);

  // Otro periodo u otra unidad: lo armado ya no sirve.
  useEffect(() => {
    setArchivosMon(null);
    setErr('');
    setAviso('');
  }, [periodo.id, unidad]);

  // Nombres de los monitoristas (comp_monitoristas), una vez por unidad.
  const nombresMon = useRef<{ unidad: string; mapa: Map<string, string> } | null>(null);
  const leerNombresMon = async (): Promise<{ mapa: Map<string, string>; aviso: string }> => {
    if (nombresMon.current?.unidad === unidad) return { mapa: nombresMon.current.mapa, aviso: '' };
    const r = await leerMonitoristas(unidad);
    if (!r.ok)
      return {
        mapa: new Map(),
        aviso: 'No se pudo leer la lista de monitoristas (' + textoFallaComp(r) + '): los archivos van con el usuario del correo.',
      };
    const mapa = nombresPorCorreo(r.data);
    nombresMon.current = { unidad, mapa };
    return { mapa, aviso: '' };
  };

  const pex: PeriodoExcel = {
    tipo: periodo.tipo,
    anio: periodo.anio,
    numero: periodo.numero,
    inicio: periodo.inicio,
    fin: periodo.fin,
  };

  /** Corre una descarga; una a la vez. */
  const correrDescarga = async (clave: string, fn: () => Promise<string | null>) => {
    if (trabajando) return;
    setErr('');
    setAviso('');
    setTrabajando(clave);
    try {
      // Con el candado del módulo (revisión de pantallas, 23-oct-2026):
      // mientras se arma un Excel no se cambia de pestaña, unidad ni periodo.
      const e = await props.correr('Armando el Excel…', fn);
      if (e === undefined) setErr('Hay otra acción guardando. Espera a que termine.');
      else if (e) setErr(e);
    } finally {
      setTrabajando(null);
    }
  };

  /** vw_comp_tomas del medio (sin quitadas) → TomaExcel, con nombres. */
  const tomasDelMedio = async (medio: MedioComp): Promise<{ tomas: TomaExcel[] } | { error: string }> => {
    const [r, nm] = await Promise.all([leerTomas({ periodoId: periodo.id, unidad, medio }), leerNombresMon()]);
    if (!r.ok) return { error: 'No se pudieron leer los renglones: ' + textoFallaComp(r) };
    if (nm.aviso) setAviso(nm.aviso);
    return { tomas: tomasExcelDeVista(r.data, { nombres: nm.mapa }) };
  };

  const bajarAsignacion = (medio: MedioComp) =>
    correrDescarga('asig|' + medio, async () => {
      const [cams, diaria] = await Promise.all([
        leerCampanas({ periodoId: periodo.id, unidad, medio }),
        leerDiaria({ periodoId: periodo.id, unidad }),
      ]);
      if (!cams.ok) return 'No se pudieron leer las campañas: ' + textoFallaComp(cams);
      if (!diaria.ok) return 'No se pudo leer la comprobación diaria: ' + textoFallaComp(diaria);
      if (!cams.data.length) return `No hay campañas de ${ETIQUETA_MEDIO[medio]} en ${periodo.etiqueta}.`;
      // Sin el equipo (no se pudo leer) la columna Analista saldría con
      // correos: se pregunta antes (revisión de pantallas, 23-oct-2026).
      if (
        !equipo.length &&
        cams.data.some((c) => !!c.analista_email) &&
        !window.confirm(
          'No se pudo leer el equipo de la unidad: en la columna Analista saldrán correos en lugar de nombres. ¿Bajar la Asignación así? (Si no, toca ↻ y vuelve a intentar.)'
        )
      )
        return null;
      const nombres = nombresPorCorreo(equipo);
      const nombre = (e: string | null) => (e ? nombres.get(e.toLowerCase()) || e : '');
      const libro = armarAsignacion({
        medio,
        periodo: pex,
        campanas: campanasExcelDeVista(ordenar(cams.data, orden, nombre), { nombres }),
        marcas: diaria.data.filter((d) => d.medio === medio),
        soloHabiles,
        omitirRetiradas,
        notaEspecificacion: nota.trim() || null,
      });
      const e = await bajarLibros([libro]);
      if (!e) avisar(`✓ ${libro.nombreArchivo} · ${cams.data.length} campañas`);
      return e;
    });

  const bajarFormato = (medio: MedioComp) =>
    correrDescarga('fmt|' + medio, async () => {
      const r = await tomasDelMedio(medio);
      if ('error' in r) return r.error;
      if (!r.tomas.length)
        return `No hay renglones de ${ETIQUETA_MEDIO[medio]}: elige el plan de tomas de las campañas en la pestaña Campañas.`;
      const libro = armarFormatoGeneral({ medio, periodo: pex, tomas: r.tomas });
      const e = await bajarLibros([libro]);
      if (!e) avisar(`✓ ${libro.nombreArchivo} · ${r.tomas.length.toLocaleString('es-MX')} renglones`);
      return e;
    });

  const armarMonitoristas = (medio: MedioComp) =>
    correrDescarga('mon|' + medio, async () => {
      setArchivosMon(null);
      const r = await tomasDelMedio(medio);
      if ('error' in r) return r.error;
      const porTomar = r.tomas.filter(tomaParaCampo).length;
      if (!porTomar)
        return `No queda nada por tomar en ${ETIQUETA_MEDIO[medio]}: todo está tomado, quitado, cubierto por su sitio o en campañas cerradas.`;
      const libros = armarArchivosMonitoristas({
        medio,
        periodo: pex,
        tomas: r.tomas,
        formato: medio === 'Pantalla' ? formatoEco : 'como_hoy',
      });
      const lista = libros.map((libro) => ({
        libro,
        renglones: renglonesDe(libro),
        sinMonitorista: libro.nombreArchivo.includes(SIN_MONITORISTA_EXCEL),
      }));
      // Uno solo (el compartido de Ecovallas): se baja de una vez.
      if (lista.length === 1) {
        const e = await bajarLibros([lista[0].libro]);
        if (!e) avisar(`✓ ${lista[0].libro.nombreArchivo} · ${lista[0].renglones.toLocaleString('es-MX')} renglones`);
        return e;
      }
      setArchivosMon({ medio, libros: lista });
      return null;
    });

  const bajarUno = (libro: LibroExcel) =>
    correrDescarga('uno|' + libro.nombreArchivo, async () => {
      const e = await bajarLibros([libro]);
      if (!e) avisar(`✓ ${libro.nombreArchivo}`);
      return e;
    });

  const bajarTodos = (libros: LibroExcel[]) =>
    correrDescarga('todos', async () => {
      const e = await bajarLibros(libros);
      if (!e) avisar(`✓ ${libros.length} archivos`);
      return e;
    });

  // ---- Render -------------------------------------------------------------
  const ocupado = trabajando != null;
  const boton = (clave: string, titulo: string, detalle: string, onClick: () => void, deshabilitado: boolean) => (
    <button
      type="button"
      className="btn ghost"
      style={{ textAlign: 'left', display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', minHeight: 64 }}
      disabled={ocupado || deshabilitado}
      onClick={onClick}
    >
      {trabajando === clave ? (
        <span className="spinner" style={{ marginTop: 2 }} />
      ) : (
        <FileSpreadsheet size={20} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
      )}
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 700 }}>{trabajando === clave ? 'Armando…' : titulo}</span>
        <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', fontWeight: 400, marginTop: 2 }}>{detalle}</span>
      </span>
    </button>
  );

  return (
    <>
      <p className="phint">
        Los mismos Excel de siempre, armados con lo que hay en la app de {periodo.etiqueta}. Los números van como valores: si algo
        está mal, corrígelo en la app y vuelve a descargar.
      </p>

      <section className="rt-seccion">
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Opciones</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="pildora-check">
            <input type="checkbox" checked={soloHabiles} onChange={(e) => setSoloHabiles(e.target.checked)} />
            Comprobación diaria solo de lunes a viernes
          </label>
          <label className="pildora-check">
            <input type="checkbox" checked={omitirRetiradas} onChange={(e) => setOmitirRetiradas(e.target.checked)} />
            Sin campañas retiradas en la asignación
          </label>
          <div className="toolbar filtros-pildora" style={{ margin: 0 }}>
            <select
              aria-label="Orden de la asignación"
              value={orden}
              className={orden !== 'vendedor' ? 'on' : ''}
              onChange={(e) => setOrden(e.target.value as Orden)}
            >
              <option value="vendedor">Asignación por vendedor</option>
              <option value="analista">Asignación por analista</option>
              <option value="campana">Asignación por campaña</option>
            </select>
            {unidad === 'Ecovallas' && (
              <select
                aria-label="Archivo de monitoristas"
                value={formatoEco}
                className={formatoEco !== 'como_hoy' ? 'on' : ''}
                onChange={(e) => {
                  setFormatoEco(e.target.value as FormatoMon);
                  setArchivosMon(null);
                }}
              >
                <option value="como_hoy">Monitoristas: un archivo compartido</option>
                <option value="por_persona">Monitoristas: uno por persona</option>
              </select>
            )}
          </div>
        </div>
        <div className="field" style={{ margin: '10px 0 0' }}>
          <label htmlFor="xl-nota">Nota arriba de la especificación de tomas (opcional)</label>
          <input
            id="xl-nota"
            value={nota}
            placeholder="Ej. REVISAR LAS FECHAS DE ENTREGA DE CADA CAMPAÑA"
            onChange={(e) => setNota(e.target.value)}
          />
        </div>
      </section>

      {err && <div className="err">{err}</div>}
      {aviso && <div className="rt-aviso" style={{ marginBottom: 12 }}>{aviso}</div>}
      {cargando && (
        <div className="phint">
          <span className="spinner" />
          Leyendo las campañas…
        </div>
      )}

      {medios.map((medio) => {
        const cams = campanas.filter((c) => c.medio === medio);
        const retiradas = cams.filter((c) => c.retirada).length;
        const cerradas = cams.filter((c) => c.estatus === 'cerrada').length;
        const renglones = cams.reduce((a, c) => a + (c.tomas_total || 0), 0);
        const sinAnalista = cams.filter((c) => !c.analista_email && !c.retirada).length;
        const sinCampanas = !cargando && cams.length === 0;
        const mon = archivosMon?.medio === medio ? archivosMon : null;
        const compartido = medio === 'Pantalla' && formatoEco === 'como_hoy';
        return (
          <section key={medio} className="card" style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 800, fontSize: 15 }}>
              {medios.length > 1 ? ETIQUETA_MEDIO[medio] : ETIQUETA_UNIDAD_COMP[unidad]} · {periodo.etiqueta}
            </div>
            <div className="phint" style={{ margin: '3px 0 10px' }}>
              {cams.length} campaña{cams.length === 1 ? '' : 's'}
              {cerradas ? ` · ${cerradas} cerrada${cerradas === 1 ? '' : 's'}` : ''}
              {retiradas ? ` · ${retiradas} retirada${retiradas === 1 ? '' : 's'}` : ''}
              {sinAnalista ? ` · ${sinAnalista} sin analista` : ''} · {renglones.toLocaleString('es-MX')} renglones en el
              Formato general
            </div>
            <div
              style={{
                display: 'grid',
                gap: 8,
                gridTemplateColumns: telefono ? 'minmax(0,1fr)' : 'repeat(3, minmax(0,1fr))',
              }}
            >
              {boton(
                'asig|' + medio,
                'Asignación de clientes',
                'Una fila por campaña-versión con DISEÑADOR, venta, % y ESTATUS; más la comprobación diaria y la especificación de tomas.',
                () => bajarAsignacion(medio),
                sinCampanas
              )}
              {boton(
                'fmt|' + medio,
                'Formato general',
                'Un renglón por día × sitio × campaña, con horario, observaciones, MONITORISTA y ESTATUS.',
                () => bajarFormato(medio),
                sinCampanas || renglones === 0
              )}
              {boton(
                'mon|' + medio,
                compartido ? 'Monitoristas (compartido)' : 'Monitoristas',
                compartido
                  ? 'Un archivo con una columna por monitorista para anotar el día de la toma. Solo lo que falta tomar.'
                  : 'Un archivo por monitorista (y turno) para anotar. Solo lo que falta tomar.',
                () => armarMonitoristas(medio),
                sinCampanas || renglones === 0
              )}
            </div>
            {sinCampanas && (
              <div className="phint" style={{ margin: '8px 0 0' }}>
                Sin campañas de {ETIQUETA_MEDIO[medio]} en este periodo.
              </div>
            )}
            {/* Por qué están grises (revisión de pantallas, 23-oct-2026). */}
            {!sinCampanas && !cargando && renglones === 0 && (
              <div className="phint" style={{ margin: '8px 0 0' }}>
                Sin renglones todavía: aplica el plan de tomas en Armar o en Campañas → Plan de tomas. Sin plan no hay Formato
                general ni archivos de monitoristas.
              </div>
            )}

            {mon && (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                  <b style={{ fontSize: 13, marginRight: 'auto' }}>
                    {mon.libros.length} archivos de monitoristas
                  </b>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={ocupado}
                    onClick={() => bajarTodos(mon.libros.map((x) => x.libro))}
                  >
                    {trabajando === 'todos' ? <span className="spinner" /> : <Ic i={Download} />}
                    Descargar todos
                  </button>
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {mon.libros.map((x) => (
                    <div
                      key={x.libro.nombreArchivo}
                      className="rt-fila"
                      style={{ cursor: 'default', alignItems: 'center' }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="rt-fila-tit">
                          {x.libro.hojas[0]?.nombre ?? x.libro.nombreArchivo}
                        </div>
                        <div className="rt-fila-sub">
                          {x.renglones.toLocaleString('es-MX')} renglón{x.renglones === 1 ? '' : 'es'}
                          {x.sinMonitorista ? ' · reparte estas tomas en la pestaña Formato' : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={ocupado}
                        aria-label={`Descargar ${x.libro.nombreArchivo}`}
                        onClick={() => bajarUno(x.libro)}
                      >
                        {trabajando === 'uno|' + x.libro.nombreArchivo ? <span className="spinner" /> : <Ic i={Download} />}
                        Descargar
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
