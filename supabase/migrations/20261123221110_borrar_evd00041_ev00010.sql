-- ============================================================
-- 23-nov-2026 · Incidencias · Se borran EVD00041 y EV00010
-- Qué (Erik, 23-nov-2026: «borra la EVD41 y de paso la EV00010, con todo y
--      sus archivos, chat y demás»):
--   · EVD00041 (Ecovallas, MX_CM_EV_3576, «Estructura con grafiti», Digital,
--     en proceso): duplicada de EVD00040, misma cara y misma falla; se
--     corrigió a grafiti cuando la otra ya estaba en proceso (de ahí la regla
--     nueva en Corrección del validador, commit 184b960).
--   · EV00010 (Ecovallas, MX_EM_EV_0005, «Faldón con grafiti»,
--     Mantenimiento, en proceso).
--   Se borran sus filas de: notificaciones, chat_menciones, chat_lecturas,
--   chat_adjuntos (no tienen llave a incidencias; las dos de chat sí a
--   mensajes, por eso van antes) y la incidencia; mensajes,
--   evidencias e incidencias_historial se van en cascada. No tienen
--   reasignaciones, revisiones de Biobox ni reportes de la app Biobox.
-- Archivos: NO se borran aquí. La base no deja borrar archivos con SQL
--   (storage.protect_delete): solo quitaría el registro y el archivo quedaría
--   huérfano. Se borran aparte desde el almacenamiento (bucket «evidencias»,
--   carpetas 1e99dda1/, 56c0abb0/ y chat/1e99dda1/: 8 archivos con
--   miniaturas).
-- Contadores de folio: no se tocan (EVD sigue en 42, EV en 44): no se
--   reusa un folio que ya salió en avisos y chats.
-- Candado: solo procede si los dos folios siguen siendo esos record_id, con
--   esa falla y esa máquina, en proceso y sin reasignaciones (revisor-rls).
-- ============================================================

set local lock_timeout = '5s';

do $$
declare
  n int;
begin
  -- Se bloquean las dos filas: un aviso o mensaje nuevo espera a que esto
  -- termine (y luego falla), en vez de quedar colgado.
  perform 1 from incidencias where record_id in ('56c0abb0', '1e99dda1') for update;
  select count(*) into n from incidencias
   where estatus = 'en_proceso'
     and ((folio = 'EVD00041' and record_id = '56c0abb0' and clave_sitio = 'MX_CM_EV_3576'
           and nombre_incidencia = 'Estructura con grafiti')
       or (folio = 'EV00010' and record_id = '1e99dda1' and clave_sitio = 'MX_EM_EV_0005'
           and nombre_incidencia = 'Faldón con grafiti'));
  if n <> 2 then
    raise exception 'EVD00041 / EV00010 ya no son las esperadas (% de 2): revisar antes.', n;
  end if;
  if exists (select 1 from reasignaciones where record_id in ('56c0abb0', '1e99dda1')) then
    raise exception 'Ya tienen reasignaciones: revisar antes.';
  end if;
end;
$$;

delete from public.notificaciones where record_id in ('56c0abb0', '1e99dda1');
delete from public.chat_menciones where record_id in ('56c0abb0', '1e99dda1');
delete from public.chat_lecturas  where record_id in ('56c0abb0', '1e99dda1');
delete from public.chat_adjuntos  where record_id in ('56c0abb0', '1e99dda1');

delete from public.incidencias
 where (folio = 'EVD00041' and record_id = '56c0abb0')
    or (folio = 'EV00010'  and record_id = '1e99dda1');
