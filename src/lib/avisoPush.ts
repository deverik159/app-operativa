// ============================================================
// src/lib/avisoPush.ts
// Cuándo y qué dice el aviso "activa los avisos" bajo la barra superior.
//
// Motivo (revisión del 9-nov-2026): 14 de las 33 personas que recibieron
// avisos en dos semanas no tenían ningún dispositivo con push; sus avisos
// (un tercio del total) solo se veían al abrir la app, y en campo eso se
// vivía como "las notificaciones llegan tarde". Otras 5 solo lo tenían en
// la computadora.
//
// Reglas:
//   - En el celular se insiste siempre que ESE teléfono no reciba avisos:
//     es el que la gente trae en campo.
//   - En la computadora solo si la persona no tiene NINGÚN dispositivo
//     activo; si ya los recibe en el celular, no se le molesta.
//   - "Ahora no" lo esconde un día en ese dispositivo.
//
// Sin dependencias (ni React ni Supabase) para probarla con node:test.
// ============================================================
import type { EstadoPush } from './push';

export type TipoAvisoPush = 'activar' | 'reactivar' | 'instalar' | 'bloqueado';

export type AvisoPush = {
  tipo: TipoAvisoPush;
  texto: string;
  boton: string;
};

/** Cuánto se esconde el aviso al tocar "Ahora no". */
export const POSPONER_MS = 24 * 60 * 60 * 1000;

export const CLAVE_POSPUESTO = 'aviso-push-pospuesto-hasta';

export function decidirAvisoPush(p: {
  estado: EstadoPush | null;
  /** Dispositivos de la persona que reciben push; null = no se sabe. */
  dispositivosActivos: number | null;
  esCelular: boolean;
  /** Hasta cuándo pidió "Ahora no" (epoch ms), o null. */
  pospuestoHasta: number | null;
  ahora: number;
}): AvisoPush | null {
  const { estado, dispositivosActivos, esCelular, pospuestoHasta, ahora } = p;
  if (estado === null || estado === 'activo' || estado === 'no-soportado') return null;
  if (pospuestoHasta !== null && ahora < pospuestoHasta) return null;

  if (!esCelular) {
    // Sin saber cuántos tiene (sin señal), no se acusa nada.
    if (dispositivosActivos !== 0) return null;
    const puedeAqui = estado === 'sin-permiso' || estado === 'caido';
    return {
      tipo: estado === 'caido' ? 'reactivar' : estado === 'bloqueado' ? 'bloqueado' : 'activar',
      texto:
        'No recibes avisos en ningún dispositivo: solo te enteras al abrir la app. ' +
        'Actívalos en tu celular' + (puedeAqui ? ' o aquí.' : '.'),
      boton: puedeAqui ? 'Activar aquí' : 'Ver cómo',
    };
  }

  switch (estado) {
    case 'caido':
      return {
        tipo: 'reactivar',
        texto:
          'Los avisos de este teléfono dejaron de llegar. Vuelve a activarlos ' +
          'para enterarte sin abrir la app.',
        boton: 'Reactivar avisos',
      };
    case 'requiere-instalar':
      return {
        tipo: 'instalar',
        texto:
          'Este iPhone no recibe avisos. Para recibirlos, agrega la app a tu ' +
          'pantalla de inicio.',
        boton: 'Cómo hacerlo',
      };
    case 'bloqueado':
      return {
        tipo: 'bloqueado',
        texto:
          'Los avisos están bloqueados en este teléfono: solo te enteras al ' +
          'abrir la app.',
        boton: 'Cómo desbloquear',
      };
    default:
      return {
        tipo: 'activar',
        texto: 'Este teléfono no recibe avisos: solo te enteras al abrir la app.',
        boton: 'Activar avisos',
      };
  }
}
