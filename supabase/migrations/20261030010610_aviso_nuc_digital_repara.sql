-- ============================================================
-- aviso_nuc_digital_repara — 30-oct-2026 · Biobox (módulo Aviso NUC)
--
-- Qué cambia: Digital revisa y repara el NUC a distancia y es quien lo
-- vuelve a poner en línea; el técnico de Op. Bio Box solo se entera (Erik,
-- 29-oct-2026: «el mismo técnico de Digital es quien revisa y repara el NUC
-- y avisa de vuelta al técnico de Biobox que el NUC ya está en línea»).
--
-- Flujo nuevo (solo Digital mueve el aviso):
--   fuera_linea → Digital lo levanta (push a los técnicos de la unidad).
--   en_revision → Digital lo está revisando («Estoy revisándolo»).
--   en_linea    → Digital lo repara y lo pone en línea (push a los técnicos).
--
-- Se va lo que suponía que el técnico revisaba: el estado por_confirmar, el
-- regreso «sigue fuera de línea» y las funciones nuc_aviso_revisado y
-- nuc_aviso_confirmar. Las tablas se crearon en 20261029234311_aviso_nuc y
-- nunca tuvieron filas (verificado antes de aplicar), así que se quitan sus
-- columnas sin respaldo. nuc_aviso_tomar pasa a ser de Digital y el aviso
-- de nuc_aviso_abrir ya no le pide al técnico que lo tome.
--
-- Re-ejecutable.
-- ============================================================

-- ------------------------------------------------------------
-- 0) Candado: las columnas del técnico se borran sin respaldo, así que si
--    alguien alcanzó a crear un aviso antes de aplicar esto, se detiene
--    todo. Solo mira mientras exista nota_tecnico: re-ejecutable.
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'nuc_avisos' and column_name = 'nota_tecnico')
     and exists (select 1 from public.nuc_avisos) then
    raise exception 'nuc_avisos ya tiene filas: revisar antes de borrar columnas.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1) Funciones que ya no van (antes que las columnas que usan)
-- ------------------------------------------------------------
drop function if exists public.nuc_aviso_revisado(bigint, text);
drop function if exists public.nuc_aviso_confirmar(bigint, boolean, text);

-- ------------------------------------------------------------
-- 2) Tablas: tres estados y sin columnas del técnico
-- ------------------------------------------------------------
alter table public.nuc_avisos drop constraint if exists nuc_avisos_estado_check;
alter table public.nuc_avisos add constraint nuc_avisos_estado_check
  check (estado in ('fuera_linea', 'en_revision', 'en_linea'));

alter table public.nuc_avisos
  drop column if exists nota_tecnico,
  drop column if exists revisado_por,
  drop column if exists revisado_en,
  drop column if exists veces_reabierto;

comment on column public.nuc_avisos.tomado_por is
  'Quién de Digital lo está revisando (en_revision).';
comment on column public.nuc_avisos.nota_cierre is
  'Qué hizo Digital para ponerlo en línea; viaja en el aviso al técnico.';
comment on table public.nuc_avisos is
  'Avisos de NUC fuera de línea en máquinas Biobox: Digital los levanta, revisa y pone en línea; Op. Bio Box se entera. Solo se escriben con nuc_aviso_*().';

alter table public.nuc_avisos_eventos drop constraint if exists nuc_avisos_eventos_accion_check;
alter table public.nuc_avisos_eventos add constraint nuc_avisos_eventos_accion_check
  check (accion in ('abierto', 'tomado', 'en_linea'));
alter table public.nuc_avisos_eventos drop constraint if exists nuc_avisos_eventos_estado_check;
alter table public.nuc_avisos_eventos add constraint nuc_avisos_eventos_estado_check
  check (estado in ('fuera_linea', 'en_revision', 'en_linea'));

-- ------------------------------------------------------------
-- 3) Abrir: igual que antes, pero el aviso ya no le pide al técnico que
--    lo tome; solo le informa.
-- ------------------------------------------------------------
create or replace function public.nuc_aviso_abrir(p_site_id text, p_nota text default null)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_yo text := lower(auth_email());
  v_inv record;
  v_id bigint;
  v_nota text := nullif(left(trim(coalesce(p_nota, '')), 500), '');
begin
  if v_yo is null or not nuc_es_digital() then
    raise exception 'Solo Digital puede marcar un NUC fuera de línea.' using errcode = '42501';
  end if;
  -- La máquina debe existir en el inventario de una unidad Biobox. Se
  -- prefiere la cara digital para el nombre visible.
  select i.site_id, i.unidad_negocio, coalesce(i.site_legacy_id, i.site_id) as maquina
    into v_inv
    from inventario i
   where i.site_id = p_site_id
     and (i.unidad_negocio ilike 'biobox' or i.unidad_negocio ilike 'biobox perú')
   order by (i.tipo_medio = 'Digital') desc nulls last, i.vendor_face_id
   limit 1;
  if not found then
    raise exception 'La máquina % no está en el inventario de Biobox.', p_site_id;
  end if;
  if exists (select 1 from nuc_avisos a where a.site_id = p_site_id and a.estado <> 'en_linea') then
    raise exception 'Esta máquina ya tiene un aviso abierto.' using errcode = '23505';
  end if;

  -- Dos personas a la vez: el índice único detiene a la segunda.
  begin
    insert into nuc_avisos(site_id, unidad_negocio, maquina, nota_digital, abierto_por)
    values (v_inv.site_id, v_inv.unidad_negocio, v_inv.maquina, v_nota, v_yo)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'Esta máquina ya tiene un aviso abierto.' using errcode = '23505';
  end;

  insert into nuc_avisos_eventos(aviso_id, accion, estado, por, nota)
  values (v_id, 'abierto', 'fuera_linea', v_yo, v_nota);

  perform nuc_avisar_tecnicos(
    v_inv.unidad_negocio, 'nuc_fuera_linea',
    'NUC fuera de línea en ' || v_inv.maquina || coalesce(': ' || v_nota, '') ||
    '. Digital lo atiende a distancia y te avisa cuando vuelva a estar en línea.');
  return v_id;
end;
$function$;

-- ------------------------------------------------------------
-- 4) Digital empieza a revisarlo: fuera_linea → en_revision.
--    Sin push: el técnico lo ve en el tablero.
-- ------------------------------------------------------------
create or replace function public.nuc_aviso_tomar(p_id bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_yo text := lower(auth_email());
  v_a nuc_avisos%rowtype;
begin
  if v_yo is null or not nuc_es_digital() then
    raise exception 'Solo Digital puede revisar el NUC.' using errcode = '42501';
  end if;
  select * into v_a from nuc_avisos where id = p_id for update;
  if v_a.id is null then
    raise exception 'El aviso ya no existe.';
  end if;
  -- Doble toque de la misma persona: ya es suyo, no es error.
  if v_a.estado = 'en_revision' and v_a.tomado_por = v_yo then
    return;
  end if;
  if v_a.estado = 'en_linea' then
    raise exception 'Este aviso ya está cerrado.';
  end if;
  if v_a.estado <> 'fuera_linea' then
    raise exception 'Este aviso ya lo está revisando %.', coalesce(v_a.tomado_por, 'otra persona');
  end if;

  update nuc_avisos
     set estado = 'en_revision', tomado_por = v_yo, tomado_en = now(), actualizado_en = now()
   where id = p_id;
  insert into nuc_avisos_eventos(aviso_id, accion, estado, por)
  values (p_id, 'tomado', 'en_revision', v_yo);
end;
$function$;

-- ------------------------------------------------------------
-- 5) Digital lo pone en línea (desde fuera_linea o en_revision) y les
--    avisa a los técnicos de la unidad, los mismos que recibieron el
--    «fuera de línea» (misma cascada).
-- ------------------------------------------------------------
create or replace function public.nuc_aviso_en_linea(p_id bigint, p_nota text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_yo text := lower(auth_email());
  v_a nuc_avisos%rowtype;
  v_nota text := nullif(left(trim(coalesce(p_nota, '')), 500), '');
begin
  if v_yo is null or not nuc_es_digital() then
    raise exception 'Solo Digital puede poner el NUC en línea.' using errcode = '42501';
  end if;
  select * into v_a from nuc_avisos where id = p_id for update;
  if v_a.id is null then
    raise exception 'El aviso ya no existe.';
  end if;
  if v_a.estado = 'en_linea' then
    raise exception 'Este aviso ya está cerrado.';
  end if;

  update nuc_avisos
     set estado = 'en_linea', cerrado_por = v_yo, cerrado_en = now(), nota_cierre = v_nota,
         actualizado_en = now()
   where id = p_id;
  insert into nuc_avisos_eventos(aviso_id, accion, estado, por, nota)
  values (p_id, 'en_linea', 'en_linea', v_yo, v_nota);

  perform nuc_avisar_tecnicos(
    v_a.unidad_negocio, 'nuc_en_linea',
    'El NUC de ' || coalesce(v_a.maquina, v_a.site_id) || ' ya está en línea' ||
    coalesce(': ' || v_nota, '') || '.');
end;
$function$;

revoke all on function public.nuc_aviso_abrir(text, text) from public, anon;
revoke all on function public.nuc_aviso_tomar(bigint) from public, anon;
revoke all on function public.nuc_aviso_en_linea(bigint, text) from public, anon;
grant execute on function public.nuc_aviso_abrir(text, text) to authenticated;
grant execute on function public.nuc_aviso_tomar(bigint) to authenticated;
grant execute on function public.nuc_aviso_en_linea(bigint, text) to authenticated;

-- Verificar: 6 funciones nuc_ (sin revisado ni confirmar) y los checks nuevos.
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and proname like 'nuc\_%' order by proname;
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid in ('public.nuc_avisos'::regclass, 'public.nuc_avisos_eventos'::regclass) and contype = 'c';
