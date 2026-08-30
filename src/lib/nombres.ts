// ============================================================
// src/lib/nombres.ts
// Traduce correos a nombres de persona para los indicadores.
//
// POR QUÉ HACE FALTA: los KPIs guardaban `repaired_by_email`, así que el
// ranking de "quién repara más" salía con correos. En una junta, una barra
// que dice "lorenzo.dulce@gpovallas.com" no se lee: se descifra.
//
// DE DÓNDE SALEN LOS NOMBRES: de dos tablas, porque quien repara no siempre
// es un técnico del padrón.
//   `usuarios`  — todo el que tiene cuenta.
//   `tecnicos`  — el padrón de campo, que a veces trae el nombre mejor
//                 escrito y a veces gente sin cuenta.
// Se cargan las dos y `usuarios` gana en caso de choque, porque es la que se
// mantiene desde la app.
//
// FALLA BLANDA A PROPÓSITO: si alguna consulta la corta la RLS —hoy no se ha
// verificado que un `viewer` pueda leer `usuarios`— NO se rompe el panel ni
// se deja la barra vacía. Se cae al usuario del correo, que es exactamente lo
// que se mostraba antes. Peor caso: sigue igual que hoy. Nunca peor.
// ============================================================
import { sb } from './supabase';

/** correo en minúsculas → nombre para mostrar. */
export type MapaNombres = Record<string, string>;

/**
 * Convierte "lorenzo.dulce@gpovallas.com" en "Lorenzo Dulce".
 * Es el respaldo cuando no hay fila en ninguna de las dos tablas.
 */
export function nombreDesdeCorreo(correo: string): string {
  const usuario = (correo || '').split('@')[0];
  if (!usuario) return correo || '—';
  return usuario
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}

/** Nombre de un correo, con respaldo. Acepta null para no obligar a checar. */
export function nombreDe(mapa: MapaNombres, correo: string | null): string {
  if (!correo) return '—';
  return mapa[correo.toLowerCase()] || nombreDesdeCorreo(correo);
}

/**
 * Carga el mapa. Nunca lanza: un panel de indicadores no debe caerse porque
 * una tabla de catálogo no se pudo leer.
 */
export async function cargarNombres(): Promise<MapaNombres> {
  const mapa: MapaNombres = {};
  try {
    const [{ data: tec }, { data: usr }] = await Promise.all([
      sb.from('tecnicos').select('nombre,email'),
      sb.from('usuarios').select('nombre,email'),
    ]);
    // Primero técnicos, luego usuarios: así `usuarios` pisa y gana.
    (tec as { nombre: string | null; email: string | null }[] | null)?.forEach(
      (r) => {
        if (r.email && r.nombre) mapa[r.email.toLowerCase()] = r.nombre.trim();
      }
    );
    (usr as { nombre: string | null; email: string | null }[] | null)?.forEach(
      (r) => {
        if (r.email && r.nombre) mapa[r.email.toLowerCase()] = r.nombre.trim();
      }
    );
  } catch {
    // Se devuelve lo que se haya alcanzado a llenar. `nombreDe` completa.
  }
  return mapa;
}
