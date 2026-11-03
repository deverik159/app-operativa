-- ============================================================
-- Archivos del chat: «no reparado» también vive 30 días desde que se marcó
-- (Erik, 31-oct-2026). Re-ejecutable.
--
-- La retención del chat (20261101030539_chat_retencion_desde_cierre) borra
-- los archivos de una cerrada 30 días después de cerrada_en. «No reparado»
-- también es estado final, pero no guardaba fecha y caía en los 60 días.
-- No se reutiliza cerrada_en: el indicador "Tiempo por etapa" la usa para
-- medir reparación → cierre y una no reparada no debe entrar ahí.
--
--   1. Columna no_reparado_en.
--   2. inc_marca_cierre también la mantiene, con la misma regla que
--      cerrada_en: la base pone la hora al pasar a 'no_reparado', la quita
--      si sale y no se mueve mientras siga así. Al 31-oct-2026 no hay
--      ninguna no reparada: no hay nada que rellenar.
--      El trigger ahora corre también en INSERT: antes solo era de UPDATE y
--      quien insertara por la API podía mandar una cerrada_en (o
--      no_reparado_en) inventada y adelantar la purga del chat. Al insertar,
--      las dos las pone la base.
--   3. La vista de purga: no_reparado → 30 días desde no_reparado_en (o
--      desde la subida si no tuviera fecha). Lo demás no cambia.
-- ============================================================

-- 1.
alter table public.incidencias add column if not exists no_reparado_en timestamptz;

-- 2. Copia de producción (31-oct-2026) más el bloque de no_reparado_en.
create or replace function public.inc_marca_cierre()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  -- Al insertar, la hora la pone la base aunque el cliente mande otra.
  if tg_op = 'INSERT' then
    new.cerrada_en     := case when new.estatus = 'cerrada' then now() end;
    new.no_reparado_en := case when new.estatus = 'no_reparado' then now() end;
    return new;
  end if;

  if new.estatus = 'cerrada' and old.estatus is distinct from 'cerrada' then
    new.cerrada_en := now();
  elsif new.estatus is distinct from 'cerrada' then
    new.cerrada_en := null;
  else
    -- Sigue cerrada: la hora no se toca, la mande quien la mande.
    new.cerrada_en := old.cerrada_en;
  end if;

  -- Lo mismo para «no reparado» (retención del chat, 31-oct-2026).
  if new.estatus = 'no_reparado' and old.estatus is distinct from 'no_reparado' then
    new.no_reparado_en := now();
  elsif new.estatus is distinct from 'no_reparado' then
    new.no_reparado_en := null;
  else
    new.no_reparado_en := old.no_reparado_en;
  end if;
  return new;
end $function$;

drop trigger if exists inc_marca_cierre on public.incidencias;
create trigger inc_marca_cierre
  before insert or update on public.incidencias
  for each row execute function public.inc_marca_cierre();

-- 3. Copia de 20261101030539; el CAMBIO es la rama de no_reparado.
create or replace view public.vw_chat_adjuntos_purgables
with (security_invoker = on) as
select a.id,
       a.record_id,
       a.path,
       a.creado_en,
       i.estatus,
       case
         when i.estatus = 'cerrada' then 'cerrada hace más de 30 días'
         when i.estatus = 'no_reparado' then 'no reparado hace más de 30 días'
         else 'más de 60 días en proceso'
       end as motivo
from chat_adjuntos a
join incidencias i on i.record_id = a.record_id
where a.purgado_en is null
  and (
    (i.estatus = 'cerrada'
       and coalesce(i.cerrada_en, a.creado_en) < now() - interval '30 days')
    or (i.estatus = 'no_reparado'
       and coalesce(i.no_reparado_en, a.creado_en) < now() - interval '30 days')
    or ((i.estatus is null or i.estatus not in ('cerrada', 'no_reparado'))
       and a.creado_en < now() - interval '60 days')
  );

-- create or replace view conserva los grants; por si se corre suelto.
revoke all on public.vw_chat_adjuntos_purgables from public, anon, authenticated;
