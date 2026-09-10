-- ============================================================
-- SLA de validación de incidencias
--
-- Dos relojes globales, configurables por Manager:
--   reporte    → desde fecha_reporte hasta validar la incidencia.
--   reparacion → desde sla_validacion_inicio hasta aprobar/rechazar reparación.
--
-- Ambos arrancan en 20 minutos. Es seguro ejecutar el archivo más de una vez.
-- ============================================================

create table if not exists public.sla_validacion (
  etapa text primary key check (etapa in ('reporte', 'reparacion')),
  minutos integer not null check (minutos between 1 and 1440),
  actualizado_en timestamptz not null default now()
);

insert into public.sla_validacion (etapa, minutos)
values ('reporte', 20), ('reparacion', 20)
on conflict (etapa) do nothing;

alter table public.sla_validacion enable row level security;

drop policy if exists sla_val_sel on public.sla_validacion;
create policy sla_val_sel on public.sla_validacion
  for select to authenticated
  using (auth_email() is not null);

drop policy if exists sla_val_upd on public.sla_validacion;
create policy sla_val_upd on public.sla_validacion
  for update to authenticated
  using (tiene_rol('manager'::app_role))
  with check (tiene_rol('manager'::app_role));

-- Permite que un manager recupere una fila borrada por accidente mediante
-- upsert desde la app; no autoriza a otros roles a crear configuración.
drop policy if exists sla_val_ins on public.sla_validacion;
create policy sla_val_ins on public.sla_validacion
  for insert to authenticated
  with check (tiene_rol('manager'::app_role));

-- Verificación: deben verse exactamente las dos filas en 20 minutos.
select etapa, minutos, actualizado_en
from public.sla_validacion
order by etapa;
