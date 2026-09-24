// ============================================================
// src/lib/useNotificaciones.ts
// Hook de notificaciones. Alimenta dos cosas a la vez:
//   - la campana 🔔 de la barra superior (todas las notificaciones)
//   - el globito del botón 💬 de cada incidencia (solo evento='chat')
//
// La RLS filtra las notificaciones a las que le tocan al usuario, así que
// aquí no se vuelve a filtrar por correo.
//
// Vive en un hook (y no dentro de App.tsx como en el HTML) para que el
// intervalo de refresco exista UNA sola vez, aunque lo consuman varios
// componentes.
//
// IMPORTANTE: los errores NO se tragan. Una consulta bloqueada por RLS
// devuelve una lista vacía, que es indistinguible de "no hay nada nuevo".
// Guardar el error y mostrarlo es la diferencia entre un bug diagnosticable
// y una campana que simplemente nunca suena.
//
// SIN SEÑAL (modo sin señal, 24-sep-2026): con navigator.onLine === false
// no se sondea (cada intento eran ~7 s de reintentos de postgrest-js y un
// console.error por minuto); se reanuda al volver 'online'. Un error de red
// se muestra como "Sin conexión" y no como el "TypeError: Load failed"
// crudo. Y sin sesión real no se consulta: al volver la red hay hasta ~60 s
// en que auth-js aún no renueva el token, la consulta sale como anon y la
// RLS responde [] — la campana se vaciaba y, al regresar los avisos, App
// los tomaba por NUEVOS y recargaba las listas.
// ============================================================
import { useState, useEffect, useCallback } from 'react';
import { sb } from './supabase';
import { enLineaAhora, pareceSinRed } from './enLinea';
import type { Notificacion } from '../types/db';

/** Lo que ve la campana cuando la consulta falló por falta de red. */
const SIN_CONEXION = 'Sin conexión: los avisos se actualizan solos al volver la señal.';

/**
 * ¿Hay sesión de verdad? Sin ella la petición saldría con la llave anon y
 * la RLS contestaría una lista vacía que NO es cierta (ver arriba).
 */
async function haySesionReal(): Promise<boolean> {
  try {
    return !!(await sb.auth.getSession()).data.session;
  } catch {
    return false;
  }
}

/**
 * Cada cuánto se re-consultan las notificaciones, CON LA APP A LA VISTA.
 *
 * Eran 25 s sin pausa: con 300 usuarios, ~24 consultas por segundo
 * constantes aunque nadie estuviera mirando (auditoría, 24-sep-2026). Ahora
 * 60 s, y con la app oculta (otra pestaña, pantalla bloqueada, en segundo
 * plano) NO se consulta nada: al volver a primer plano se consulta de
 * inmediato, así que el usuario no ve la campana atrasada. El aviso
 * instantáneo lo sigue dando el push.
 */
const INTERVALO_MS = 60000;

/** Cuántas notificaciones pendientes se traen para la campana. */
const LIMITE = 60;

/** Tope del conteo de chats sin leer (solo alimenta los globitos 💬). */
const LIMITE_CHATS = 500;

/**
 * Las columnas que de verdad usan la campana y App. Antes era select('*'):
 * cada tick bajaba columnas que nadie pinta, multiplicado por 300 usuarios.
 */
const COLUMNAS = 'id,record_id,evento,mensaje,unidad_negocio,creado_en,leida';

/** ¿Misma lista? Evita re-pintar App (y hasta 1000 tarjetas) si nada cambió. */
function mismasNotifs(a: Notificacion[], b: Notificacion[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].leida !== b[i].leida) return false;
  }
  return true;
}

function mismosConteos(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

export type UseNotificaciones = {
  notifs: Notificacion[];
  noLeidas: number;
  /** record_id → cuántos mensajes de chat sin leer tiene. */
  chatCounts: Record<string, number>;
  /** Mensaje de error de la última consulta, o '' si todo bien. */
  error: string;
  marcarLeida: (id: number) => Promise<void>;
  marcarTodas: () => Promise<void>;
  /** Al abrir el chat de una incidencia: apaga su globito. */
  marcarChatLeido: (recordId: string) => Promise<void>;
  /**
   * Al ACCIONAR una incidencia (validar, reparar, rechazar, decidir una
   * reasignación): sus avisos pendientes ya no avisan nada — se marcan
   * leídos solos para que la campana no siga diciendo que hay algo por
   * hacer cuando la acción ya se hizo. El chat NO se toca: sus mensajes
   * se marcan al abrir el chat, no al resolver la incidencia.
   */
  marcarDeRegistro: (recordId: string) => Promise<void>;
  recargar: () => void;
};

export function useNotificaciones(): UseNotificaciones {
  const [notifs, setNotifs] = useState<Notificacion[]>([]);
  const [chatCounts, setChatCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState('');

  const cargarNotifs = useCallback(async () => {
    // Sin sesión real se conserva lo que ya se ve (ver cabecera).
    if (!(await haySesionReal())) return;
    const { data, error: err, status } = await sb
      .from('notificaciones')
      .select(COLUMNAS)
      .eq('leida', false)
      .order('creado_en', { ascending: false })
      .limit(LIMITE);
    if (err) {
      if (pareceSinRed(err, status)) {
        setError(SIN_CONEXION);
        return;
      }
      setError('notificaciones: ' + err.message);
      console.error('[notificaciones] fallo al consultar:', err);
      return;
    }
    setError('');
    const nuevas = (data as Notificacion[]) || [];
    setNotifs((prev) => (mismasNotifs(prev, nuevas) ? prev : nuevas));
  }, []);

  const cargarChats = useCallback(async () => {
    if (!(await haySesionReal())) return;
    // Solo se necesitan los record_id: se cuentan en el cliente.
    const { data, error: err, status } = await sb
      .from('notificaciones')
      .select('record_id')
      .eq('evento', 'chat')
      .eq('leida', false)
      .limit(LIMITE_CHATS);
    if (err) {
      // Sin red se conservan los globitos que ya había; no es un fallo.
      if (!pareceSinRed(err, status)) console.error('[notificaciones] fallo al contar chats:', err);
      return;
    }
    const m: Record<string, number> = {};
    ((data as { record_id: string | null }[]) || []).forEach((r) => {
      if (r.record_id) m[r.record_id] = (m[r.record_id] || 0) + 1;
    });
    setChatCounts((prev) => (mismosConteos(prev, m) ? prev : m));
  }, []);

  const recargar = useCallback(() => {
    cargarNotifs();
    cargarChats();
  }, [cargarNotifs, cargarChats]);

  useEffect(() => {
    let t: ReturnType<typeof setInterval> | null = null;
    const arrancar = () => {
      if (t) return;
      recargar();
      t = setInterval(recargar, INTERVALO_MS);
    };
    const detener = () => {
      if (t) clearInterval(t);
      t = null;
    };
    // Se sondea solo a la vista Y con señal; al volver cualquiera de las
    // dos se consulta de inmediato (modo sin señal, 24-sep-2026).
    const revisar = () =>
      document.visibilityState === 'visible' && enLineaAhora() ? arrancar() : detener();

    revisar();
    document.addEventListener('visibilitychange', revisar);
    window.addEventListener('online', revisar);
    window.addEventListener('offline', revisar);
    return () => {
      detener();
      document.removeEventListener('visibilitychange', revisar);
      window.removeEventListener('online', revisar);
      window.removeEventListener('offline', revisar);
    };
  }, [recargar]);

  const marcarLeida = useCallback(async (id: number) => {
    const { error: err, status } = await sb
      .from('notificaciones')
      .update({ leida: true })
      .eq('id', id);
    if (err) {
      // Si no se puede marcar leída, la campana mentiría al apagarse.
      setError(
        pareceSinRed(err, status)
          ? 'Sin conexión: no se pudo marcar como leída.'
          : 'No se pudo marcar como leída: ' + err.message
      );
      return;
    }
    // La campana es una bandeja de pendientes: al atender una entrada deja
    // de pertenecer a la lista, igual que su contador.
    setNotifs((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const marcarTodas = useCallback(async () => {
    const ids = notifs.filter((n) => !n.leida).map((n) => n.id);
    if (!ids.length) return;
    const { error: err, status } = await sb
      .from('notificaciones')
      .update({ leida: true })
      .in('id', ids);
    if (err) {
      setError(
        pareceSinRed(err, status)
          ? 'Sin conexión: no se pudieron marcar como leídas.'
          : 'No se pudieron marcar como leídas: ' + err.message
      );
      return;
    }
    setNotifs([]);
  }, [notifs]);

  const marcarChatLeido = useCallback(
    async (recordId: string) => {
      // Optimista: el globito se apaga antes de que responda la base.
      setChatCounts((c) => {
        const n = { ...c };
        delete n[recordId];
        return n;
      });
      setNotifs((prev) =>
        prev.filter((n) => n.evento !== 'chat' || n.record_id !== recordId)
      );
      const { error: err } = await sb
        .from('notificaciones')
        .update({ leida: true })
        .eq('evento', 'chat')
        .eq('record_id', recordId)
        .eq('leida', false);
      if (err) {
        console.error('[notificaciones] fallo al marcar chat:', err);
        // La recarga restituye la entrada si la base no aceptó el cambio.
        cargarNotifs();
        cargarChats();
      }
    },
    [cargarNotifs, cargarChats]
  );

  const marcarDeRegistro = useCallback(
    async (recordId: string) => {
      if (!recordId) return;
      // Optimista, igual que el chat: la campana se limpia de inmediato y la
      // recarga restituye la entrada si la base no aceptó el cambio. La RLS
      // acota el update a las notificaciones del propio usuario.
      setNotifs((prev) =>
        prev.filter((n) => n.evento === 'chat' || n.record_id !== recordId)
      );
      const { error: err } = await sb
        .from('notificaciones')
        .update({ leida: true })
        .eq('record_id', recordId)
        .neq('evento', 'chat')
        .eq('leida', false);
      if (err) {
        console.error('[notificaciones] fallo al marcar registro:', err);
        cargarNotifs();
      }
    },
    [cargarNotifs]
  );

  const noLeidas = notifs.filter((n) => !n.leida).length;

  return {
    notifs,
    noLeidas,
    chatCounts,
    error,
    marcarLeida,
    marcarTodas,
    marcarChatLeido,
    marcarDeRegistro,
    recargar,
  };
}
