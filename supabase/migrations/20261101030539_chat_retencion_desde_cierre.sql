-- ============================================================
-- Archivos del chat: 30 días desde el cierre, 60 en proceso (Erik, 31-oct-2026)
--
-- Erik decidió el 14-sep-2026 que los archivos del chat vivieran 30 días
-- (chat_retencion_30_dias.sql), pero en producción la vista volvió a la
-- regla original de 2 días: alguien corrió otra vez la definición de
-- chat_adjuntos.sql / chat_adjuntos_continuar.sql. No se notó porque la
-- limpieza nocturna no funcionó hasta el 31-oct-2026; la primera corrida
-- borró 2 archivos que con 30 días seguirían.
--
--   1. Incidencia cerrada: el archivo se borra 30 días DESPUÉS DEL CIERRE
--      (incidencias.cerrada_en existe desde el 9-oct-2026; en septiembre
--      se contaba desde la subida porque no había fecha de cierre). Si una
--      cerrada no tuviera fecha, se cuenta desde la subida.
--      Cualquier otro estatus: 60 días desde la subida.
--   2. La vista ya no la puede leer authenticated: era del dueño postgres
--      (se saltaba la RLS de chat_adjuntos e incidencias) y solo la usa
--      limpiar-chat con la service_role. La app no la consulta. Además pasa
--      a security_invoker; a service_role y postgres no les cambia nada.
-- ============================================================

-- 1. Mismas columnas y en el mismo orden (create or replace view no deja
--    cambiarlas); cambian el where y el texto de motivo.
create or replace view public.vw_chat_adjuntos_purgables
with (security_invoker = on) as
select a.id,
       a.record_id,
       a.path,
       a.creado_en,
       i.estatus,
       case
         when i.estatus = 'cerrada' then 'cerrada hace más de 30 días'
         else 'más de 60 días en proceso'
       end as motivo
from chat_adjuntos a
join incidencias i on i.record_id = a.record_id
where a.purgado_en is null
  and (
    (i.estatus = 'cerrada'
       and coalesce(i.cerrada_en, a.creado_en) < now() - interval '30 days')
    or (i.estatus is distinct from 'cerrada'
       and a.creado_en < now() - interval '60 days')
  );

-- 2. Solo la service_role (limpiar-chat) y el dueño.
revoke all on public.vw_chat_adjuntos_purgables from public, anon, authenticated;
