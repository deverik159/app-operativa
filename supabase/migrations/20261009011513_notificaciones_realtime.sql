-- ============================================================
-- notificaciones_realtime — la campana se entera al instante (Erik aprobó
-- la idea el 1-sep-2026; se hace el 8-oct-2026). Re-ejecutable.
--
-- Por qué: la campana consultaba la tabla cada 60 s con la app a la vista.
-- Con `notificaciones` en la publicación de Realtime, useNotificaciones.ts
-- se suscribe a los INSERT/UPDATE de SUS avisos (filtro
-- para_email=eq.<correo>, que Realtime aplica en el servidor) y recarga en
-- cuanto llega uno. El sondeo queda como red de seguridad cada 5 min, y
-- vuelve a 60 s si el canal se cae.
--
-- Seguridad: Realtime respeta la RLS de la tabla (notif_sel: cada quien ve
-- solo lo suyo), además del filtro. Todos los para_email están en
-- minúsculas (los triggers los guardan con lower()), así que el filtro por
-- igualdad los encuentra.
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notificaciones'
  ) then
    alter publication supabase_realtime add table public.notificaciones;
  end if;
end $$;

-- Verificar: una fila, public.notificaciones.
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime' and tablename = 'notificaciones';
