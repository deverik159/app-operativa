-- ============================================================
-- Aviso al área nueva cuando una Corrección cambia el área de una
-- incidencia que ya está En proceso (Erik, 16-oct-2026).
--
-- Antes: el Validador corregía la falla, el área responsable cambiaba (y el
-- SLA de reparación se reiniciaba, trigger set_sla), pero nadie recibía
-- aviso: el área nueva solo la encontraba si abría Mis pendientes.
--
-- Ahora: los técnicos del área nueva reciben "Incidencia asignada a tu área"
-- (evento 'asignacion', el mismo título que al validar), con la cascada de
-- siempre (destinatarios_notif: técnicos → coordinadores → managers).
--
-- No se dispara:
--   - en una reasignación aprobada (reasignacion_pendiente true → false):
--     esa ya avisa con notificar_reasignacion_aprobada;
--   - si la incidencia trae assigned_area: el área que repara es esa y no
--     cambió;
--   - fuera de En proceso: antes de validar, el aviso sale al validar
--     (notificar_incidencia) y ya con el área corregida.
-- Al área anterior no se le avisa (decisión de Erik).
-- Re-ejecutable.
-- ============================================================

create or replace function public.notificar_correccion_area()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  msg text;
begin
  if old.estatus = 'en_proceso'
     and new.estatus = 'en_proceso'
     and new.area_responsable is distinct from old.area_responsable
     and new.area_responsable is not null
     and new.assigned_area is null
     and not (coalesce(old.reasignacion_pendiente, false)
              and not coalesce(new.reasignacion_pendiente, false)) then

    msg := 'Incidencia corregida a tu área (' || new.area_responsable ||
           '), antes de ' || coalesce(old.area_responsable, '—') || ': ' ||
           coalesce(new.folio, '') || ' · ' ||
           coalesce(new.nombre_incidencia, '');

    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      select new.record_id, d, 'asignacion', msg, new.unidad_negocio
      from destinatarios_notif('reparacion'::app_role, new.unidad_negocio, new.area_responsable) d;

  end if;
  return new;
end
$function$;

drop trigger if exists trg_notificar_correccion_area on public.incidencias;
create trigger trg_notificar_correccion_area
  after update on public.incidencias
  for each row execute function notificar_correccion_area();
