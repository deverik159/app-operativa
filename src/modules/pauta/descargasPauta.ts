// ============================================================
// src/modules/pauta/descargasPauta.ts
// Descargables de Indicadores de Pauta (Erik, 14-oct-2026):
//   · Excel del avance de la catorcena (resumen, por ruta, por campaña, por
//     monitorista y el detalle cara por cara).
//   · Comprobaciones de una campaña o de un día: en Excel (con ligas a cada
//     foto) y en PDF con las fotos, para mandarlas por correo.
//
// Todo se arma EN EL TELÉFONO: no hay servidor de reportes. Las librerías
// (xlsx y pdf-lib) se bajan solo al tocar el botón, para no cargarlas a
// quien solo abre Pauta. Las fotos se reducen antes de meterlas al PDF
// (lado mayor 1000 px, JPEG): las originales de un día completo harían un
// archivo que ningún correo acepta.
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

export type Evidencia = { url: string; tipo: string | null };

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
 * se subieron. En trozos: la lista de ids va en la URL.
 */
export async function evidenciasDe(
  anio: number,
  catorcena: number,
  ids: string[]
): Promise<Map<string, Evidencia[]>> {
  const m = new Map<string, Evidencia[]>();
  const unicos = [...new Set(ids)];
  for (let i = 0; i < unicos.length; i += 80) {
    const trozo = unicos.slice(i, i + 80);
    const { data, error } = await sb
      .from('pauta_evidencias')
      .select('vendor_face_id,url,tipo,creado_en')
      .eq('anio', anio)
      .eq('catorcena', catorcena)
      .in('vendor_face_id', trozo)
      // Las de una toma regresada no van al cliente (14-oct-2026).
      .is('regresada_en', null)
      .order('creado_en');
    if (error) throw new Error('No se pudieron leer las fotos: ' + error.message);
    for (const r of (data as { vendor_face_id: string; url: string; tipo: string | null }[]) || []) {
      m.set(r.vendor_face_id, [...(m.get(r.vendor_face_id) || []), { url: r.url, tipo: r.tipo }]);
    }
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

// ------------------------------------------------------------
// PDF con fotos
// ------------------------------------------------------------

/** Foto reducida a JPEG, o null si no se pudo bajar o leer. */
async function fotoReducida(url: string, lado = 1000): Promise<{ bytes: ArrayBuffer; w: number; h: number } | null> {
  try {
    const r = await fetch(url, { cache: 'force-cache' });
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob());
    const k = Math.min(1, lado / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob: Blob | null = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.72));
    if (!blob) return null;
    return { bytes: await blob.arrayBuffer(), w, h };
  } catch {
    return null;
  }
}

/**
 * Lo que Helvetica de pdf-lib puede escribir (WinAnsi): acentos y ñ sí,
 * emojis y flechas no. Lo demás se cambia por un espacio para que el PDF
 * no truene por un carácter raro del archivo de pauta.
 */
function texto(s: string | null | undefined): string {
  return (s || '').replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”…•€]/g, ' ');
}

export async function pdfComprobaciones(
  titulo: string,
  subtitulo: string,
  filas: FilaDescarga[],
  evid: Map<string, Evidencia[]>,
  ctx: Contexto,
  avisar: (hechas: number, total: number) => void
): Promise<Blob> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle(texto(`Comprobación · ${titulo} · ${ctx.catorcena}`));
  const fuente = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);
  const gris = rgb(0.38, 0.38, 0.38);

  const ANCHO = 595.28;
  const ALTO = 841.89;
  const M = 36;
  const UTIL = ANCHO - 2 * M;
  let pagina = pdf.addPage([ANCHO, ALTO]);
  let y = ALTO - M;

  const nuevaPagina = () => {
    pagina = pdf.addPage([ANCHO, ALTO]);
    y = ALTO - M;
  };
  /** Escribe partiendo en renglones; regresa la altura usada. */
  const escribir = (s: string, tam: number, f = fuente, color = rgb(0, 0, 0)) => {
    const palabras = texto(s).split(/\s+/).filter(Boolean);
    let linea = '';
    const lineas: string[] = [];
    for (const p of palabras) {
      const prueba = linea ? linea + ' ' + p : p;
      if (f.widthOfTextAtSize(prueba, tam) > UTIL && linea) {
        lineas.push(linea);
        linea = p;
      } else linea = prueba;
    }
    if (linea) lineas.push(linea);
    for (const l of lineas) {
      if (y - tam < M) nuevaPagina();
      y -= tam + 3;
      pagina.drawText(l, { x: M, y, size: tam, font: f, color });
    }
  };

  // Portada breve, arriba de la primera cara.
  escribir('Comprobación de campaña', 18, negrita);
  escribir(titulo, 14, negrita);
  escribir(subtitulo, 11, fuente, gris);
  escribir(
    `${ctx.catorcena} · ${filas.length} ${filas.length === 1 ? 'cara' : 'caras'} · generado el ${fechaHoraCdmx(new Date().toISOString())}`,
    10,
    fuente,
    gris
  );
  y -= 10;

  // Fotos de todas las caras, de 4 en 4 para no saturar la señal del teléfono.
  const urls = filas.flatMap((f) =>
    (evid.get(f.vendor_face_id) || []).filter((e) => e.tipo !== 'video').map((e) => e.url)
  );
  const fotos = new Map<string, Awaited<ReturnType<typeof fotoReducida>>>();
  let hechas = 0;
  avisar(0, urls.length);
  for (let i = 0; i < urls.length; i += 4) {
    const lote = urls.slice(i, i + 4);
    const r = await Promise.all(lote.map((u) => fotoReducida(u)));
    lote.forEach((u, k) => fotos.set(u, r[k]));
    hechas += lote.length;
    avisar(hechas, urls.length);
  }

  const GAP = 10;
  const COL = (UTIL - GAP) / 2;
  const ALTO_MAX = 230;
  for (const f of filas) {
    const evs = evid.get(f.vendor_face_id) || [];
    const imgs = evs.filter((e) => e.tipo !== 'video');
    // Que el encabezado de la cara no quede solo al pie de la página: con
    // fotos, que quepa también su primer renglón.
    if (y < M + 70 + (imgs.length ? ALTO_MAX : 0)) nuevaPagina();
    pagina.drawLine({ start: { x: M, y: y - 2 }, end: { x: ANCHO - M, y: y - 2 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    y -= 8;
    escribir(`${f.site_id}${f.cara ? ' · cara ' + f.cara : ''} · ${nombreRuta(f.ruta_clave)}`, 12, negrita);
    if (f.direccion) escribir(f.direccion, 9, fuente, gris);
    escribir(
      `Tomada: ${fechaHoraCdmx(f.fecha_toma) || '—'}${f.toma_por ? ' por ' + nombreDe(ctx.nombres, f.toma_por) : ''}` +
        ` · Comprobada: ${fechaHoraCdmx(f.fecha_comprobacion) || '—'}${f.comprobacion_por ? ' por ' + nombreDe(ctx.nombres, f.comprobacion_por) : ''}`,
      9,
      fuente,
      gris
    );
    y -= 4;
    const videos = evs.length - imgs.length;
    // Fotos de dos en dos: se mide el renglón COMPLETO antes de dibujarlo,
    // para que la segunda no se salga de la página.
    const listas = imgs.map((e) => fotos.get(e.url)).filter((x): x is NonNullable<typeof x> => !!x);
    const fallidas = imgs.length - listas.length;
    for (let i = 0; i < listas.length; i += 2) {
      const par = listas.slice(i, i + 2).map((foto) => {
        const k = Math.min(COL / foto.w, ALTO_MAX / foto.h);
        return { foto, w: foto.w * k, h: foto.h * k };
      });
      const altoFila = Math.max(...par.map((p) => p.h));
      if (y - altoFila < M + 14) nuevaPagina();
      for (let c = 0; c < par.length; c++) {
        const img = await pdf.embedJpg(par[c].foto.bytes);
        pagina.drawImage(img, { x: M + c * (COL + GAP), y: y - par[c].h, width: par[c].w, height: par[c].h });
      }
      y -= altoFila + GAP;
    }
    if (fallidas)
      escribir(
        `${fallidas} foto(s) no se pudieron descargar; están en el Excel como liga.`,
        9,
        fuente,
        gris
      );
    if (videos) escribir(`${videos} video(s) en la app (no caben en el PDF).`, 9, fuente, gris);
    if (!evs.length) escribir('Sin fotos registradas.', 9, fuente, gris);
    y -= 6;
  }

  // Pie con número de página.
  const total = pdf.getPageCount();
  pdf.getPages().forEach((p, i) =>
    p.drawText(texto(`${ctx.catorcena} · ${titulo} · ${i + 1} de ${total}`), {
      x: M,
      y: 18,
      size: 8,
      font: fuente,
      color: gris,
    })
  );
  const bytes = await pdf.save();
  // Copia a un ArrayBuffer propio: el tipo de pdf-lib admite SharedArrayBuffer.
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' });
}
