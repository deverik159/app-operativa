-- ============================================================
-- incidencias_cerrada_en — la hora en que se cerró cada incidencia
-- (Erik, 8-oct-2026, para el indicador "Tiempo por etapa"). Re-ejecutable.
--
-- Por qué: la base guardaba cuándo se reportó (fecha_reporte), se validó
-- (validator_at) y se reparó (repaired_at), pero no cuándo el validador
-- aprobó la reparación y la cerró. Sin eso no se puede medir la etapa
-- "reparación → cierre".
--
-- Qué hace, en este orden:
--   1. Agrega la columna cerrada_en.
--   2. Rellena las que ya están cerradas con la hora de su aviso de cierre
--      (notificaciones.evento = 'cierre', que el trigger trg_notificar crea
--      en el mismo instante en que la incidencia pasa a 'cerrada'). Al
--      8-oct-2026 las 33 cerradas tenían ese aviso. Va ANTES del trigger
--      del paso 3, que de otro modo no dejaría escribir la columna.
--   3. Crea el trigger inc_marca_cierre: la base pone la hora al pasar a
--      'cerrada' y la quita si alguna vez sale de 'cerrada'. Fuera de esa
--      transición la columna no se mueve: la app no la puede escribir
--      (lo que mide indicadores lo escribe la base, como rechazos_reparacion).
-- ============================================================
alter table public.incidencias add column if not exists cerrada_en timestamptz;

update public.incidencias i
set cerrada_en = c.primera
from (
  select record_id, min(creado_en) as primera
  from public.notificaciones
  where evento = 'cierre' and record_id is not null
  group by record_id
) c
where c.record_id = i.record_id
  and i.estatus = 'cerrada'
  and i.cerrada_en is null;

create or replace function public.inc_marca_cierre()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.estatus = 'cerrada' and old.estatus is distinct from 'cerrada' then
    new.cerrada_en := now();
  elsif new.estatus is distinct from 'cerrada' then
    new.cerrada_en := null;
  else
    -- Sigue cerrada: la hora no se toca, la mande quien la mande.
    new.cerrada_en := old.cerrada_en;
  end if;
  return new;
end $$;

drop trigger if exists inc_marca_cierre on public.incidencias;
create trigger inc_marca_cierre
  before update on public.incidencias
  for each row execute function public.inc_marca_cierre();

-- Verificar: cerradas = con_hora.
select count(*) filter (where estatus = 'cerrada') as cerradas,
       count(*) filter (where estatus = 'cerrada' and cerrada_en is not null) as con_hora
from public.incidencias;
