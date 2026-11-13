// ============================================================
// src/lib/marcarActividad.ts
// Avisa a la base que la persona está usando la app (pestaña Actividad de
// Usuarios, 13-nov-2026): al abrir y cada 15 minutos mientras la app está
// a la vista. La base guarda solo el día y la primera y la última hora
// (`marcar_actividad`, migración 20261113180726); ni ubicación ni pantallas.
// Sin red o con error no pasa nada: es un dato de apoyo, no estorba.
// ============================================================
import { sb } from './supabase';

const CADA_MS = 15 * 60 * 1000;

/** Arranca las marcas; devuelve con qué detenerlas. */
export function iniciarMarcaActividad(): () => void {
  let ultima = 0;

  const marcar = () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - ultima < CADA_MS) return;
    ultima = Date.now();
    // Si falla, lo vuelve a intentar en la siguiente vuelta de 15 minutos.
    sb.rpc('marcar_actividad').then(
      () => {},
      () => {}
    );
  };

  marcar();
  const reloj = window.setInterval(marcar, 60 * 1000);
  document.addEventListener('visibilitychange', marcar);
  return () => {
    window.clearInterval(reloj);
    document.removeEventListener('visibilitychange', marcar);
  };
}
