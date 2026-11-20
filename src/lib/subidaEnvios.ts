// ============================================================
// src/lib/subidaEnvios.ts
// Los textos de las fotos que suben solas después de guardar un reporte
// (20-nov-2026, Erik: al hacer varios reportes seguidos, «Guardando…»
// tardaba). Desde ese día la ventana de Nueva incidencia se cierra en cuanto
// se crean los folios y las fotos siguen subiendo desde la cola
// (lib/envios.ts). Aquí solo van los textos, sin red, para poder probarlos.
// ============================================================

/** Una subida en curso (lo que da `subidasEnCurso` de lib/envios). */
export type SubidaTexto = { folios: string[]; hechos: number; total: number };

/** Lo que terminó (lo que da `tomarLogrosEnvio` de lib/envios). */
export type LogroTexto = { folios: string[]; archivos: number; fallidos: number };

function fotos(n: number): string {
  return n === 1 ? '1 foto' : `${n} fotos`;
}

/** «BBMM00012», «BBMM00012 y BBMM00013», «4 incidencias». */
export function nombrarFolios(folios: string[]): string {
  const f = [...new Set(folios.filter(Boolean))];
  if (!f.length) return 'tu reporte';
  if (f.length === 1) return f[0];
  if (f.length === 2) return `${f[0]} y ${f[1]}`;
  return `${f.length} incidencias`;
}

/** «Subiendo fotos de BBMM00012 · 3 de 6». Vacío si no hay nada subiendo. */
export function textoSubida(subidas: SubidaTexto[]): string {
  if (!subidas.length) return '';
  const hechos = subidas.reduce((s, x) => s + x.hechos, 0);
  const total = subidas.reduce((s, x) => s + x.total, 0);
  const quien =
    subidas.length === 1 ? nombrarFolios(subidas[0].folios) : `${subidas.length} reportes`;
  return `Subiendo fotos de ${quien} · ${hechos} de ${total}`;
}

/**
 * «✓ BBMM00012 guardado con sus 6 fotos». Si alguna no subió, lo dice y el
 * motivo va en el aviso de arriba.
 */
export function textoLogroEnvio(logros: LogroTexto[]): string {
  if (!logros.length) return '';
  const folios = logros.flatMap((l) => l.folios);
  const archivos = logros.reduce((s, l) => s + l.archivos, 0);
  const fallidos = logros.reduce((s, l) => s + l.fallidos, 0);
  const quien = nombrarFolios(folios);
  const distintos = [...new Set(folios.filter(Boolean))].length;
  // «BBMM00012 y BBMM00013 guardados», pero «4 incidencias guardadas».
  const guardado = distintos > 2 ? 'guardadas' : distintos === 2 ? 'guardados' : 'guardado';
  if (fallidos) {
    const cuantas = fallidos === 1 ? '1 foto no se subió' : `${fallidos} fotos no se subieron`;
    return `✓ ${quien} ${guardado} · ${cuantas}, revisa el aviso`;
  }
  if (!archivos) return `✓ ${quien} ${guardado}`;
  return `✓ ${quien} ${guardado} con ${archivos === 1 ? 'su foto' : `sus ${fotos(archivos)}`}`;
}
