// ============================================================
// src/lib/ubicacionMaquina.ts
// Los datos de ubicación que toma una incidencia al elegirle máquina:
// los mismos que el alta copia de la cara del inventario (NuevaInc).
//
// Lo usan quien repara una reportada sin máquina (RepararModal, desde el
// 28-sep-2026) y el validador o el manager que se la pone antes de que la
// reparen (AsignarMaquinaModal, Erik, 17-nov-2026). Sin supabase: se prueba
// en tests/ubicacionMaquina.test.mjs.
// ============================================================
import type { Incidencia, InventarioItem } from '../types/db';

export type CaraMaquina = Pick<
  InventarioItem,
  'site_id' | 'vendor_face_id' | 'direccion' | 'municipio' | 'estado' | 'tipo_medio' | 'tipo_mueble' | 'site_legacy_id'
>;

export function ubicacionDeMaquina(
  cara: CaraMaquina,
  direccionSitio?: string | null
): Pick<
  Incidencia,
  'clave_sitio' | 'clave_medio' | 'direccion' | 'municipio' | 'plaza' | 'medio' | 'tipo_mueble' | 'nombre_biobox'
> {
  return {
    clave_sitio: cara.site_id,
    clave_medio: cara.vendor_face_id,
    direccion: cara.direccion ?? direccionSitio ?? null,
    municipio: cara.municipio ?? null,
    plaza: cara.estado ?? null,
    medio: cara.tipo_medio ?? null,
    tipo_mueble: cara.tipo_mueble ?? null,
    nombre_biobox: cara.site_legacy_id || null,
  };
}
