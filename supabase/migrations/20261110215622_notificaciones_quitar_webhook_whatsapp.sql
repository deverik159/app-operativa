-- ============================================================
-- 10-nov-2026 · Plataforma (avisos) · Erik
-- Qué: quita el Database Webhook `notificaciones` de la tabla notificaciones,
--      que llamaba a la Edge Function `dynamic-worker` (enviar-whatsapp, Twilio)
--      con CADA aviso insertado.
-- Por qué: WhatsApp no se usa (Erik, 10-nov-2026). Solo un usuario tenía
--      teléfono (el propio Erik): 32 mensajes del 26-oct al 9-nov-2026, contra
--      ~8,000 llamadas a la función por nada. Además el trigger guardaba en sus
--      argumentos un JWT de servicio para llamarla. La función se borra aparte
--      en Supabase (Edge Functions), después de esta migración.
-- Qué NO cambia: el push (`trg_notificar_push` → enviar-push) sigue igual. La
--      columna `notificaciones.enviada_wa` se queda (solo histórico).
-- Re-ejecutable.
-- ============================================================

drop trigger if exists notificaciones on public.notificaciones;
