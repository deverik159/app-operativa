-- ============================================================
-- 17-nov-2026 · Incidencias
-- Qué: historial de cambios de estatus, de área y de reasignaciones, con
--      fecha y quién. La tarjeta lo enseña bajo «Capturada», solo con lo
--      que pasó.
-- Por qué: Erik (17-nov-2026). La tarjeta solo decía cuándo se capturó. La
--      base guardaba validada, reparada, cerrada y no reparado, pero NO
--      cuándo se rechazó una reparación ni cuándo se devolvió al reportante,
--      y de lo que sí guardaba solo el último (un segundo rechazo pisa al
--      primero). Erik eligió el historial completo.
-- Cómo:
--   · incidencias_historial: una fila por evento. Solo la escriben los
--     triggers (SECURITY DEFINER, corren como dueño); nadie puede insertar,
--     cambiar ni borrar desde la API. Se lee si se ve la incidencia (la RLS
--     de incidencias se aplica dentro del exists).
--   · Triggers: en incidencias, cambios de estatus y de área (paso a Op.
--     Bio Box, corrección del validador) y el alta que nace validada; en
--     reasignaciones, solicitud y resolución. La hora es la del servidor
--     (now()). Si el registro fallara, se avisa en el log y NO se frena el
--     cambio: el historial es informativo.
--   · Relleno de lo que ya existe (reconstruido = true): validada,
--     reparada, cerrada, no reparado y reasignaciones (con la hora que
--     guardó el teléfono). Los rechazos y devoluciones de antes no tenían
--     fecha y no se inventan.
-- Revisada por revisor-rls (17-nov-2026); sus sugerencias van incluidas.
-- Re-ejecutable: if not exists / or replace; el relleno no duplica.
-- ============================================================

create table if not exists public.incidencias_historial (
  id            bigint generated always as identity primary key,
  record_id     text not null references public.incidencias(record_id) on delete cascade,
  evento        text not null,
  estatus_antes text,
  estatus_nuevo text,
  por_email     text,
  en            timestamptz not null default now(),
  detalle       text,
  reconstruido  boolean not null default false,
  -- Referencia estable del origen (reassign_id): evita duplicar al rellenar.
  ref           text
);

create index if not exists inc_hist_record_idx
  on public.incidencias_historial (record_id, en);
create unique index if not exists inc_hist_ref_evento_uq
  on public.incidencias_historial (ref, evento) where ref is not null;

alter table public.incidencias_historial enable row level security;

-- Solo lectura, y solo de lo que la persona ya ve.
drop policy if exists inc_hist_sel on public.incidencias_historial;
create policy inc_hist_sel on public.incidencias_historial
  for select
  to authenticated
  using (
    exists (
      select 1 from public.incidencias i
      where i.record_id = incidencias_historial.record_id
    )
  );

-- Nadie escribe por la API; solo los triggers.
revoke all on public.incidencias_historial from anon, authenticated, public;
revoke insert, update, delete, truncate on public.incidencias_historial from service_role;
grant select on public.incidencias_historial to authenticated;
revoke all on sequence public.incidencias_historial_id_seq from anon, authenticated, public;

-- ------------------------------------------------------------
-- 1) Cambios de estatus y de área de la incidencia.
-- ------------------------------------------------------------
create or replace function public.inc_registrar_historial()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_quien  text := lower(nullif(trim((select auth_email())), ''));
  v_evento text;
begin
  if tg_op = 'INSERT' then
    -- Nace ya validada (clasificada desde la app Biobox): se anota.
    insert into incidencias_historial (record_id, evento, estatus_nuevo, por_email, en)
    values (new.record_id, 'validada', new.estatus::text,
            coalesce(lower(nullif(trim(new.validator_email), '')), v_quien), now());
    return null;
  end if;

  if new.estatus is distinct from old.estatus then
    v_evento := case
      when new.estatus = 'en_proceso' and old.estatus in ('por_validar', 'reportado') then 'validada'
      when new.estatus = 'en_proceso' and old.estatus = 'reparado'   then 'reparacion_rechazada'
      when new.estatus = 'en_proceso' and old.estatus in ('cerrada', 'no_reparado') then 'reabierta'
      -- El técnico descarta en la prevalidación (auto-ruteo): no es una
      -- devolución del validador.
      when new.estatus = 'rechazada'  and old.estatus = 'en_proceso' then 'descartada'
      when new.estatus = 'rechazada'                                 then 'devuelta'
      when new.estatus = 'por_validar' and old.estatus = 'rechazada' then 'corregida'
      when new.estatus = 'reparado'                                  then 'reparada'
      when new.estatus = 'cerrada'                                   then 'cerrada'
      when new.estatus = 'no_reparado'                               then 'no_reparado'
      else 'estatus'
    end;
    insert into incidencias_historial
      (record_id, evento, estatus_antes, estatus_nuevo, por_email, en, detalle)
    values
      (new.record_id, v_evento, old.estatus::text, new.estatus::text, v_quien, now(),
       -- Devolver, descartar y rechazar reparación guardan su motivo aquí.
       case when v_evento in ('reparacion_rechazada', 'devuelta', 'descartada')
            then nullif(trim(new.motivo_rechazo_reparacion), '') end);
  end if;

  -- Cambio de área fuera de una reasignación aprobada (esa la anota
  -- reasignaciones): «Pasar a Op. Bio Box» o la corrección del validador.
  if new.area_responsable is distinct from old.area_responsable
     and not (coalesce(old.reasignacion_pendiente, false)
              and not coalesce(new.reasignacion_pendiente, false)) then
    insert into incidencias_historial (record_id, evento, por_email, en, detalle)
    values (
      new.record_id,
      case when current_setting('app.paso_op_biobox', true) = 'on'
           then 'pasada_op_biobox' else 'area_corregida' end,
      v_quien,
      now(),
      nullif(concat_ws(' → ', nullif(trim(old.area_responsable), ''),
                              nullif(trim(new.area_responsable), '')), '')
    );
  end if;
  return null;
exception when others then
  -- El historial no debe frenar una reparación o una validación.
  raise warning 'inc_registrar_historial (%): %', new.record_id, sqlerrm;
  return null;
end
$$;

revoke execute on function public.inc_registrar_historial() from public, anon, authenticated;

drop trigger if exists trg_inc_historial on public.incidencias;
create trigger trg_inc_historial
  after update of estatus, area_responsable on public.incidencias
  for each row
  execute function public.inc_registrar_historial();

drop trigger if exists trg_inc_historial_alta on public.incidencias;
create trigger trg_inc_historial_alta
  after insert on public.incidencias
  for each row
  when (new.validator_at is not null)
  execute function public.inc_registrar_historial();

-- ------------------------------------------------------------
-- 2) Reasignaciones: solicitud y resolución.
-- ------------------------------------------------------------
create or replace function public.reasign_registrar_historial()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_evento text;
begin
  if tg_op = 'INSERT' then
    v_evento := 'reasignacion_solicitada';
  elsif new.estado is distinct from old.estado and new.estado in ('Aprobada', 'Rechazada') then
    v_evento := case new.estado when 'Aprobada' then 'reasignacion_aprobada'
                                else 'reasignacion_rechazada' end;
  else
    return null;
  end if;

  if new.record_id is null then
    return null;
  end if;

  insert into incidencias_historial (record_id, evento, por_email, en, detalle, ref)
  values (
    new.record_id,
    v_evento,
    lower(nullif(trim((select auth_email())), '')),
    now(),
    nullif(concat_ws(' → ', nullif(trim(new.area_origen), ''), nullif(trim(new.area_destino), '')), ''),
    new.reassign_id
  )
  on conflict (ref, evento) where ref is not null do nothing;
  return null;
exception when others then
  raise warning 'reasign_registrar_historial (%): %', new.record_id, sqlerrm;
  return null;
end
$$;

revoke execute on function public.reasign_registrar_historial() from public, anon, authenticated;

drop trigger if exists trg_reasign_historial on public.reasignaciones;
create trigger trg_reasign_historial
  after insert or update of estado on public.reasignaciones
  for each row
  execute function public.reasign_registrar_historial();

-- ------------------------------------------------------------
-- 3) Relleno con lo que ya existe (reconstruido = true).
-- ------------------------------------------------------------
-- Validada (las de auto-ruteo no tienen validator_at: no se inventa). La
-- hora del teléfono puede quedar segundos antes de la captura: se acota.
insert into incidencias_historial (record_id, evento, estatus_nuevo, por_email, en, reconstruido)
select i.record_id, 'validada', 'en_proceso', lower(i.validator_email),
       greatest(i.validator_at, i.creado_en), true
from incidencias i
where i.validator_at is not null
  and not exists (select 1 from incidencias_historial h
                  where h.record_id = i.record_id and h.evento = 'validada');

-- Reparada: la última reparación.
insert into incidencias_historial (record_id, evento, estatus_antes, estatus_nuevo, por_email, en, reconstruido)
select i.record_id, 'reparada', 'en_proceso', 'reparado', lower(i.repaired_by_email), i.repaired_at, true
from incidencias i
where i.repaired_at is not null
  and not exists (select 1 from incidencias_historial h
                  where h.record_id = i.record_id and h.evento = 'reparada');

-- Cerrada (quién aprobó la reparación no se guardaba).
insert into incidencias_historial (record_id, evento, estatus_antes, estatus_nuevo, en, reconstruido)
select i.record_id, 'cerrada', 'reparado', 'cerrada', i.cerrada_en, true
from incidencias i
where i.estatus = 'cerrada' and i.cerrada_en is not null
  and not exists (select 1 from incidencias_historial h
                  where h.record_id = i.record_id and h.evento = 'cerrada');

-- No reparado.
insert into incidencias_historial (record_id, evento, estatus_nuevo, en, reconstruido)
select i.record_id, 'no_reparado', 'no_reparado', i.no_reparado_en, true
from incidencias i
where i.estatus = 'no_reparado' and i.no_reparado_en is not null
  and not exists (select 1 from incidencias_historial h
                  where h.record_id = i.record_id and h.evento = 'no_reparado');

-- Reasignaciones: la solicitud y, si ya se resolvió, la resolución. La
-- referencia (reassign_id) evita duplicar si se corre otra vez.
insert into incidencias_historial (record_id, evento, por_email, en, detalle, reconstruido, ref)
select r.record_id, 'reasignacion_solicitada', lower(r.solicitado_por), r.fecha_solicitud,
       nullif(concat_ws(' → ', nullif(trim(r.area_origen), ''), nullif(trim(r.area_destino), '')), ''),
       true, r.reassign_id
from reasignaciones r
join incidencias i on i.record_id = r.record_id
where r.fecha_solicitud is not null
on conflict (ref, evento) where ref is not null do nothing;

insert into incidencias_historial (record_id, evento, por_email, en, detalle, reconstruido, ref)
select r.record_id,
       case r.estado when 'Aprobada' then 'reasignacion_aprobada' else 'reasignacion_rechazada' end,
       lower(r.resuelta_por), r.fecha_resolucion,
       nullif(concat_ws(' → ', nullif(trim(r.area_origen), ''), nullif(trim(r.area_destino), '')), ''),
       true, r.reassign_id
from reasignaciones r
join incidencias i on i.record_id = r.record_id
where r.estado in ('Aprobada', 'Rechazada') and r.fecha_resolucion is not null
on conflict (ref, evento) where ref is not null do nothing;
