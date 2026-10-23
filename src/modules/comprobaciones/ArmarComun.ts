// ============================================================
// src/modules/comprobaciones/ArmarComun.ts
// Piezas que comparten las fuentes de «Armar el periodo» (23-oct-2026):
// bitácora, Pauta VV, alta manual y «copiar del periodo anterior».
//
// POR QUÉ un archivo aparte: las cuatro acaban en lo mismo (una lista de
// CampanaContrato por medio que pasa por la previa y la carga) y necesitan
// las mismas conversiones y el mismo inventario. Aquí no se escribe nada en
// la base: las escrituras van por comprobacionesApi.ts desde la pantalla.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MedioComp, UnidadComp } from '../../lib/comprobaciones';
import { normTexto } from '../../lib/importadorComp';
import type { CampanaContrato, HojaBitacora, SitioContrato } from '../../lib/bitacoraComp';
import { hojaDeLibro } from '../../lib/bitacoraComp';
import {
  leerInventarioComp,
  textoFallaComp,
  type CaraInventario,
  type SitioComp,
  type VwCampana,
} from '../../lib/comprobacionesApi';
import { cargarXlsx } from '../../lib/xlsxDiferido';

/** Lo que va a UNA llamada de comp_cargar_campanas (Vía Verde: una por medio). */
export type EntradaMedio = { medio: MedioComp; campanas: CampanaContrato[] };

export const etiquetaCampana = (c: { campana: string; version?: string | null }) =>
  `${c.campana}${c.version ? ' / ' + c.version : ''}`;

export const sitiosDe = (cs: CampanaContrato[]) => cs.reduce((a, c) => a + (c.sitios?.length ?? 0), 0);

export const fmt = (n: number) => n.toLocaleString('es-MX');

/** '2026-10-05' → '5 oct'. */
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export function diaCorto(d: string | null | undefined): string {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return '—';
  return `${Number(d.slice(8, 10))} ${MESES[Number(d.slice(5, 7)) - 1]}`;
}
export const vigenciaTexto = (i: string | null | undefined, f: string | null | undefined) =>
  !i && !f ? 'todo el periodo' : `${diaCorto(i)} – ${diaCorto(f)}`;

/** Un elemento de las listas del reporte (texto u objeto) → texto corto. */
export function aTexto(x: unknown): string {
  if (x == null) return '';
  if (typeof x === 'string' || typeof x === 'number') return String(x);
  if (typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (typeof o.campana === 'string') {
      const base = etiquetaCampana({ campana: o.campana, version: typeof o.version === 'string' ? o.version : '' });
      return typeof o.sitio_clave === 'string' ? `${base}: ${o.sitio_clave}` : base;
    }
    if (typeof o.sitio_clave === 'string') return o.sitio_clave;
    return JSON.stringify(o);
  }
  return String(x);
}

export function trozos<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Deja que el navegador pinte el avance antes de un paso pesado. */
export const respirar = () => new Promise<void>((r) => setTimeout(r, 30));

// ------------------------------------------------------------
// Lectura ligera de un libro pesado (bitácoras de 67-103 MB por imágenes)
// ------------------------------------------------------------

/**
 * Partes del .xlsx que NO hacen falta para leer celdas: imágenes, dibujos,
 * objetos incrustados. Medido con las bitácoras reales (23-oct-2026): la de
 * Biobox (103 MB) tardaba 14 s en XLSX.read; sin estas partes son 21 MB de
 * XML y 1.2 s, y leerBitacora da EXACTAMENTE lo mismo (comparado en JSON
 * con la de Biobox y la de Ecovallas Digital).
 */
const PARTE_SOBRANTE = /^xl\/(media|drawings|embeddings|printerSettings|diagrams|charts)\//i;

export type PasoLectura = 'archivo' | 'imagenes' | 'hojas';

/**
 * Lee un .xlsx con SOLO lo necesario y lo regresa como HojaBitacora[] (desde
 * A1, con valores crudos y texto formateado, como pide leerBitacora). Si el
 * archivo no es un zip (.xls viejo), lo lee completo.
 */
export async function leerLibroLigero(
  archivo: File,
  aviso: (paso: PasoLectura) => void
): Promise<{ hojas: HojaBitacora[]; quitadoMB: number }> {
  aviso('archivo');
  await respirar();
  const buf = new Uint8Array(await archivo.arrayBuffer());
  const [XLSX, fflate] = await Promise.all([cargarXlsx(), import('fflate')]);
  let datos: Uint8Array = buf;
  let quitadoMB = 0;
  aviso('imagenes');
  await respirar();
  try {
    const partes = fflate.unzipSync(buf, { filter: (f) => !PARTE_SOBRANTE.test(f.name) });
    if (partes['xl/workbook.xml']) {
      datos = fflate.zipSync(partes, { level: 0 });
      quitadoMB = Math.max(0, (buf.length - datos.length) / 1e6);
    }
  } catch {
    // No es zip (.xls) o viene raro: que SheetJS lo intente con todo.
    datos = buf;
  }
  aviso('hojas');
  await respirar();
  const wb = XLSX.read(datos, { type: 'array', cellStyles: false, cellHTML: false, cellFormula: false, bookVBA: false });
  const ocultas = wb.Workbook?.Sheets ?? [];
  const hojas = wb.SheetNames.map((n, i) => hojaDeLibro(XLSX.utils, wb.Sheets[n], n, !!ocultas[i]?.Hidden));
  return { hojas, quitadoMB };
}

// ------------------------------------------------------------
// Inventario de la unidad (lo comparten la bitácora y el alta manual)
// ------------------------------------------------------------

export type EstadoInventario = {
  caras: CaraInventario[] | null;
  error: string;
  leyendo: boolean;
  /** Lee (una vez) y regresa las caras, o null si falló. */
  asegurar: () => Promise<CaraInventario[] | null>;
};

export function useInventarioComp(unidad: UnidadComp): EstadoInventario {
  const [caras, setCaras] = useState<CaraInventario[] | null>(null);
  const [error, setError] = useState('');
  const [leyendo, setLeyendo] = useState(false);
  const promesa = useRef<Promise<CaraInventario[] | null> | null>(null);
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);
  const asegurar = useCallback(() => {
    if (!promesa.current) {
      setLeyendo(true);
      promesa.current = leerInventarioComp(unidad).then((r) => {
        if (vivo.current) setLeyendo(false);
        if (!r.ok) {
          // Se olvida para que el siguiente intento vuelva a pedirlo.
          promesa.current = null;
          if (vivo.current) setError('No se pudo leer el inventario: ' + textoFallaComp(r));
          return null;
        }
        if (vivo.current) {
          setError('');
          setCaras(r.data);
        }
        return r.data;
      });
    }
    return promesa.current;
  }, [unidad]);
  return { caras, error, leyendo, asegurar };
}

/** ¿La cara corresponde al medio que se arma? (Ecovallas: solo pantallas digitales.) */
export function caraDelMedio(c: CaraInventario, unidad: UnidadComp, medio: MedioComp): boolean {
  if (unidad === 'Ecovallas') return normTexto(c.tipo_medio) === 'DIGITAL';
  if (unidad === 'Vía Verde') return medio === 'Pórtico' ? /_POR_/.test(c.vendor_face_id) : /_COL_/.test(c.vendor_face_id);
  return true;
}

export const caraActiva = (c: CaraInventario) => !c.face_status || /^active$/i.test(c.face_status.trim());

// ------------------------------------------------------------
// De lo ya cargado a una entrada del contrato («copiar del periodo anterior»)
// ------------------------------------------------------------

export function contratoDeVista(c: VwCampana, sitios: SitioComp[]): CampanaContrato {
  const ss: SitioContrato[] = sitios.map((s) => ({
    sitio_clave: s.sitio_clave,
    sitio_original: s.sitio_original ?? s.sitio_clave,
    espacio_vv: s.espacio_vv,
    inicio: s.inicio,
    fin: s.fin,
    horario_lv: s.horario_lv,
    horario_sd: s.horario_sd,
    tipo_venta: s.tipo_venta,
    testigos: s.testigos,
    observaciones: s.observaciones,
  }));
  return {
    fuente: c.fuente,
    origen_ref: c.origen_ref,
    cliente: c.cliente,
    campana: c.campana,
    version: c.version,
    vendedor: c.vendedor,
    administrador: c.administrador,
    quantum: c.quantum,
    mediamonitor: c.mediamonitor,
    especificacion: c.especificacion,
    arte: c.arte,
    inicio: c.inicio,
    fin: c.fin,
    es_full: c.es_full,
    full_minutos: c.full_minutos,
    analista_email: c.analista_email,
    sitios: ss,
  };
}

/** Agrupa por medio, en el orden de la unidad (Columna antes que Pórtico). */
export function porMedio(medios: MedioComp[], lista: { medio: MedioComp; campana: CampanaContrato }[]): EntradaMedio[] {
  return medios
    .map((m) => ({ medio: m, campanas: lista.filter((x) => x.medio === m).map((x) => x.campana) }))
    .filter((e) => e.campanas.length > 0);
}
