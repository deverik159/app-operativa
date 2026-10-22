// ============================================================
// src/modules/pauta/descargasPauta.ts
// Descargables de Indicadores de Pauta (Erik, 14-oct-2026):
//   · Excel del avance de la catorcena (resumen, por ruta, por campaña, por
//     monitorista y el detalle cara por cara).
//   · Comprobaciones de una campaña o de un día, en Excel con una liga a
//     cada foto. El PDF con fotos se quitó el 22-oct-2026 (Erik: no se
//     necesita; el analista baja las fotos en ZIP).
//
// Todo se arma EN EL TELÉFONO: no hay servidor de reportes. La librería de
// Excel se baja solo al tocar el botón, para no cargarla a quien solo abre
// Pauta.
// ============================================================
import { sb } from '../../lib/supabase';
import { cargarXlsx } from '../../lib/xlsxDiferido';
import { fechaHoraCdmx } from '../../lib/fechasCdmx';
import { nombreDe, type MapaNombres } from '../../lib/nombres';
import {
  estadoCara,
  esRegresada,
  diaDeToma,
  etiquetaDia,
  nombreRuta,
  type Avance,
  type FilaIndicador,
} from '../../lib/indicadoresPauta';

/** Lo que las descargas leen de cada cara (fila de vw_pauta_ruta). */
export type FilaDescarga = FilaIndicador & {
  direccion: string | null;
  comprobacion_por: string | null;
  estatus?: string | null;
  fotos?: number;
};

/** `editada`: la liga es la versión que subió el analista (20-oct-2026). */
export type Evidencia = { url: string; tipo: string | null; editada?: boolean };

/** Encabezado común: qué catorcena y para quién. */
export type Contexto = {
  /** "Cat-16 · 2026" */
  catorcena: string;
  anio: number;
  numero: number;
  nombres: MapaNombres;
};

const ESTADO_TXT = { COMPROBADA: 'Comprobada', TOMADA: 'Tomada (por comprobar)', PENDIENTE: 'Pendiente' };

/** Baja un Blob como archivo. En iPhone abre la vista previa con "Compartir". */
export function bajarArchivo(blob: Blob, nombre: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safari necesita el enlace vivo un momento después del clic.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * Evidencias de esas caras en esa catorcena, por cara y en el orden en que
 * se subieron. En trozos: la lista de ids va en la URL. Si el analista subió
 * una versión editada de una foto, va esa en su lugar (20-oct-2026).
 */
export async function evidenciasDe(
  anio: number,
  catorcena: number,
  ids: string[]
): Promise<Map<string, Evidencia[]>> {
  const filas: { id: number; vendor_face_id: string; url: string; tipo: string | null }[] = [];
  const unicos = [...new Set(ids)];
  for (let i = 0; i < unicos.length; i += 80) {
    const trozo = unicos.slice(i, i + 80);
    const { data, error } = await sb
      .from('pauta_evidencias')
      .select('id,vendor_face_id,url,tipo,creado_en')
      .eq('anio', anio)
      .eq('catorcena', catorcena)
      .in('vendor_face_id', trozo)
      // Las de una toma regresada no van al cliente (14-oct-2026).
      .is('regresada_en', null)
      .order('creado_en');
    if (error) throw new Error('No se pudieron leer las fotos: ' + error.message);
    filas.push(...((data as typeof filas) || []));
  }
  const editadas = await editadasDe(filas.map((f) => f.id));
  const m = new Map<string, Evidencia[]>();
  for (const r of filas) {
    const ed = editadas.get(r.id);
    const ev: Evidencia = ed ? { url: ed, tipo: r.tipo, editada: true } : { url: r.url, tipo: r.tipo };
    m.set(r.vendor_face_id, [...(m.get(r.vendor_face_id) || []), ev]);
  }
  return m;
}

/** Liga de la versión editada por el analista, por id de evidencia. */
async function editadasDe(idsEvidencia: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  for (let i = 0; i < idsEvidencia.length; i += 150) {
    const { data, error } = await sb
      .from('pauta_revision_fotos')
      .select('evidencia_id,editada_url')
      .eq('estado', 'editada')
      .in('evidencia_id', idsEvidencia.slice(i, i + 150));
    if (error) throw new Error('No se pudieron leer las fotos editadas: ' + error.message);
    for (const r of (data as { evidencia_id: number; editada_url: string }[]) || []) m.set(r.evidencia_id, r.editada_url);
  }
  return m;
}

// ------------------------------------------------------------
// Excel
// ------------------------------------------------------------

export async function excelAvance(avance: Avance, filas: FilaDescarga[], ctx: Contexto): Promise<Blob> {
  const XLSX = await cargarXlsx();
  const wb = XLSX.utils.book_new();
  const t = avance.total;
  const resumen = [
    { Concepto: 'Catorcena', Valor: ctx.catorcena },
    { Concepto: 'Generado', Valor: fechaHoraCdmx(new Date().toISOString()) },
    { Concepto: 'Sitios', Valor: t.sitios },
    { Concepto: 'Caras', Valor: t.caras },
    { Concepto: 'Pendientes', Valor: t.pendientes },
    { Concepto: 'De ellas, regresadas', Valor: t.regresadas },
    { Concepto: 'Tomadas por comprobar', Valor: t.tomadas },
    { Concepto: 'Comprobadas', Valor: t.comprobadas },
    { Concepto: '% comprobado', Valor: t.pct },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumen), 'Resumen');
  const fila = (c: Avance['total']) => ({
    Sitios: c.sitios,
    Caras: c.caras,
    Pendientes: c.pendientes,
    Regresadas: c.regresadas,
    Tomadas: c.tomadas,
    Comprobadas: c.comprobadas,
    '% comprobado': c.pct,
  });
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(avance.porRuta.map((r) => ({ Ruta: nombreRuta(r.ruta), ...fila(r) }))),
    'Por ruta'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(avance.porCampana.map((c) => ({ Campaña: c.campana, ...fila(c) }))),
    'Por campaña'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      avance.porMonitorista.map((m) => ({
        Monitorista: nombreDe(ctx.nombres, m.correo),
        Correo: m.correo,
        'Tomas registradas': m.tomas,
        'De ellas, comprobadas': m.comprobadas,
        Sitios: m.sitios,
      }))
    ),
    'Por monitorista'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      filas.map((f) => ({
        Ruta: nombreRuta(f.ruta_clave),
        Sitio: f.site_id,
        Cara: f.cara || '',
        'Vendor Face ID': f.vendor_face_id,
        Campaña: f.campana || '',
        Estatus: f.estatus || '',
        Avance: ESTADO_TXT[estadoCara(f)] + (esRegresada(f) ? ' (regresada)' : ''),
        'Motivo del regreso': esRegresada(f) ? f.rechazo_motivo || '' : '',
        'Tomada por': f.toma_por ? nombreDe(ctx.nombres, f.toma_por) : '',
        'Fecha de toma': fechaHoraCdmx(f.fecha_toma),
        'Comprobada por': f.comprobacion_por ? nombreDe(ctx.nombres, f.comprobacion_por) : '',
        'Fecha de comprobación': fechaHoraCdmx(f.fecha_comprobacion),
        Fotos: f.fotos ?? '',
        Dirección: f.direccion || '',
      }))
    ),
    'Detalle'
  );
  return new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export async function excelComprobaciones(
  titulo: string,
  filas: FilaDescarga[],
  evid: Map<string, Evidencia[]>,
  ctx: Contexto
): Promise<Blob> {
  const XLSX = await cargarXlsx();
  const maxFotos = Math.max(0, ...filas.map((f) => (evid.get(f.vendor_face_id) || []).length));
  const datos = filas.map((f) => {
    const r: Record<string, string> = {
      Campaña: f.campana || '',
      'Día de toma': etiquetaDia(diaDeToma(f)),
      Ruta: nombreRuta(f.ruta_clave),
      Sitio: f.site_id,
      Cara: f.cara || '',
      'Vendor Face ID': f.vendor_face_id,
      Dirección: f.direccion || '',
      'Tomada por': f.toma_por ? nombreDe(ctx.nombres, f.toma_por) : '',
      'Fecha de toma': fechaHoraCdmx(f.fecha_toma),
      'Comprobada por': f.comprobacion_por ? nombreDe(ctx.nombres, f.comprobacion_por) : '',
      'Fecha de comprobación': fechaHoraCdmx(f.fecha_comprobacion),
    };
    (evid.get(f.vendor_face_id) || []).forEach((e, i) => {
      r[`Evidencia ${i + 1}`] = e.url;
    });
    return r;
  });
  const enc = [
    'Campaña', 'Día de toma', 'Ruta', 'Sitio', 'Cara', 'Vendor Face ID', 'Dirección', 'Tomada por',
    'Fecha de toma', 'Comprobada por', 'Fecha de comprobación',
    ...Array.from({ length: maxFotos }, (_, i) => `Evidencia ${i + 1}`),
  ];
  const ws = XLSX.utils.json_to_sheet(datos, { header: enc });
  // Las fotos como liga que se abre con un clic (no solo el texto).
  const col0 = enc.indexOf('Evidencia 1');
  if (col0 >= 0)
    datos.forEach((_, i) => {
      for (let c = col0; c < enc.length; c++) {
        const celda = ws[XLSX.utils.encode_cell({ r: i + 1, c })];
        if (celda && celda.v) celda.l = { Target: String(celda.v), Tooltip: 'Abrir evidencia' };
      }
    });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Comprobaciones');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { Concepto: 'Comprobación', Valor: titulo },
      { Concepto: 'Catorcena', Valor: ctx.catorcena },
      { Concepto: 'Caras', Valor: String(filas.length) },
      { Concepto: 'Generado', Valor: fechaHoraCdmx(new Date().toISOString()) },
    ]),
    'Datos'
  );
  return new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
