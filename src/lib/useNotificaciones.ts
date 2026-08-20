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
// ============================================================
import { useState, useEffect, useCallback } from 'react';
import { sb } from './supabase';
import type { Notificacion } from '../types/db';

/** Cada cuánto se re-consultan las notificaciones. */
const INTERVALO_MS = 25000;

/** Cuántas notificaciones se traen para la campana. */
const LIMITE = 60;

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
  recargar: () => void;
};

export function useNotificaciones(): UseNotificaciones {
  const [notifs, setNotifs] = useState<Notificacion[]>([]);
  const [chatCounts, setChatCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState('');

  const cargarNotifs = useCallback(async () => {
    const { data, error: err } = await sb
      .from('notificaciones')
      .select('*')
      .order('creado_en', { ascending: false })
      .limit(LIMITE);
    if (err) {
      setError('notificaciones: ' + err.message);
      console.error('[notificaciones] fallo al consultar:', err);
      return;
    }
    setError('');
    setNotifs((data as Notificacion[]) || []);
  }, []);

  const cargarChats = useCallback(async () => {
    // Solo se necesitan los record_id: se cuentan en el cliente.
    const { data, error: err } = await sb
      .from('notificaciones')
      .select('record_id')
      .eq('evento', 'chat')
      .eq('leida', false);
    if (err) {
      console.error('[notificaciones] fallo al contar chats:', err);
      return;
    }
    const m: Record<string, number> = {};
    ((data as { record_id: string | null }[]) || []).forEach((r) => {
      if (r.record_id) m[r.record_id] = (m[r.record_id] || 0) + 1;
    });
    setChatCounts(m);
  }, []);

  const recargar = useCallback(() => {
    cargarNotifs();
    cargarChats();
  }, [cargarNotifs, cargarChats]);

  useEffect(() => {
    recargar();
    const t = setInterval(recargar, INTERVALO_MS);
    return () => clearInterval(t);
  }, [recargar]);

  const marcarLeida = useCallback(async (id: number) => {
    const { error: err } = await sb
      .from('notificaciones')
      .update({ leida: true })
      .eq('id', id);
    if (err) {
      // Si no se puede marcar leída, la campana mentiría al apagarse.
      setError('No se pudo marcar como leída: ' + err.message);
      return;
    }
    setNotifs((prev) =>
      prev.map((n) => (n.id === id ? { ...n, leida: true } : n))
    );
  }, []);

  const marcarTodas = useCallback(async () => {
    const ids = notifs.filter((n) => !n.leida).map((n) => n.id);
    if (!ids.length) return;
    const { error: err } = await sb
      .from('notificaciones')
      .update({ leida: true })
      .in('id', ids);
    if (err) {
      setError('No se pudieron marcar como leídas: ' + err.message);
      return;
    }
    setNotifs((prev) => prev.map((n) => ({ ...n, leida: true })));
  }, [notifs]);

  const marcarChatLeido = useCallback(
    async (recordId: string) => {
      // Optimista: el globito se apaga antes de que responda la base.
      setChatCounts((c) => {
        const n = { ...c };
        delete n[recordId];
        return n;
      });
      const { error: err } = await sb
        .from('notificaciones')
        .update({ leida: true })
        .eq('evento', 'chat')
        .eq('record_id', recordId)
        .eq('leida', false);
      if (err) console.error('[notificaciones] fallo al marcar chat:', err);
      setTimeout(cargarNotifs, 300);
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
    recargar,
  };
}
