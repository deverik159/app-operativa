-- ============================================================
-- Clasificación técnica de incidencias del área Digital
--
-- Conserva dos verdades en la misma incidencia:
--   nombre_incidencia  = lo que reportó el usuario (catálogo visible)
--   incidencia_srd     = la falla técnica que clasificó Digital
--   arbol_digital_id   = la fila exacta del árbol usada al reparar
--
-- Correr una vez en Supabase -> SQL Editor.
-- ============================================================

begin;

alter table public.incidencias
  add column if not exists incidencia_srd text;

-- Copia el tipo REAL de arbol_digital.id. Esto evita asumir si la llave fue
-- creada como integer, bigint o uuid en esta instalación.
do $$
declare
  tipo_id text;
begin
  select format_type(a.atttypid, a.atttypmod)
    into tipo_id
  from pg_attribute a
  where a.attrelid = 'public.arbol_digital'::regclass
    and a.attname = 'id'
    and not a.attisdropped;

  if tipo_id is null then
    raise exception 'No existe public.arbol_digital.id';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'incidencias'
      and column_name = 'arbol_digital_id'
  ) then
    execute format(
      'alter table public.incidencias add column arbol_digital_id %s',
      tipo_id
    );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.incidencias'::regclass
      and conname = 'incidencias_arbol_digital_id_fkey'
  ) then
    alter table public.incidencias
      add constraint incidencias_arbol_digital_id_fkey
      foreign key (arbol_digital_id)
      references public.arbol_digital(id)
      on update cascade
      on delete set null;
  end if;
end $$;

create index if not exists incidencias_incidencia_srd_idx
  on public.incidencias (incidencia_srd)
  where incidencia_srd is not null;

create index if not exists incidencias_arbol_digital_id_idx
  on public.incidencias (arbol_digital_id)
  where arbol_digital_id is not null;

comment on column public.incidencias.incidencia_srd is
  'Clasificación técnica elegida por Digital; nombre_incidencia conserva lo reportado.';
comment on column public.incidencias.arbol_digital_id is
  'Fila exacta de arbol_digital usada para clasificar causa, diagnóstico y solución.';

commit;

-- Verificación: deben aparecer las dos columnas y la llave foránea.
select c.column_name, c.data_type, c.is_nullable
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name = 'incidencias'
  and c.column_name in ('incidencia_srd', 'arbol_digital_id')
order by c.column_name;

select conname, pg_get_constraintdef(oid) as definicion
from pg_constraint
where conrelid = 'public.incidencias'::regclass
  and conname = 'incidencias_arbol_digital_id_fkey';
