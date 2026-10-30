-- ============================================================
-- aviso_nuc — 29-oct-2026 · Biobox (módulo Aviso NUC)
--
-- Qué hace: Digital avisa que el NUC de una máquina Biobox está fuera de
-- línea y el técnico de Op. Bio Box de esa unidad lo revisa. Cada máquina
-- tiene a lo más UN aviso abierto, que pasa por:
--
--   fuera_linea  → Digital lo levanta (aviso push a los técnicos).
--   en_revision  → un técnico lo toma («Tomar aviso»).
--   por_confirmar→ el técnico dice qué hizo (aviso push a quien lo levantó).
--   en_linea     → Digital confirma que ya responde (cierra el aviso).
--
-- Si Digital ve que sigue caída, el aviso regresa a fuera_linea, sin
-- técnico, y se vuelve a avisar a los técnicos. Solo Digital dice si la
-- máquina está fuera de línea o en línea (Erik, 29-oct-2026).
--
-- Decisiones de Erik (29-oct-2026):
--   - Módulo aparte de Incidencias (un NUC caído es un estado que va y
--     viene; no lleva foto, validador ni folio).
--   - «Digital» = cualquier técnico (rol reparacion) con área Digital, de
--     cualquier unidad: hoy nadie con unidad Biobox tiene área Digital.
--   - Digital lo marca a mano; la base Core de Biobox queda para después.
--   - Entran Biobox y Biobox Perú (Perú aún no tiene técnicos de Op. Bio
--     Box: sus avisos van a sus coordinadores o a los managers).
--   - Entran todas las máquinas, digitales e impresas: todas tienen NUC.
--   - Cualquier técnico de Op. Bio Box de la unidad puede decir «Ya lo
--     revisé» aunque el aviso lo haya tomado un compañero (para cubrirse);
--     queda registrado quién lo revisó.
--
-- PERMISOS. Las dos tablas solo se leen por RLS; nadie escribe directo.
-- Todo cambio pasa por las 4 funciones security definer de abajo, que
-- revisan quién llama y el estado actual con la fila bloqueada (dos
-- técnicos que tocan «Tomar» a la vez: gana uno y el otro ve quién).
-- Los avisos los inserta la base (trg_notificar_push manda el push).
--
-- Re-ejecutable.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Tablas
-- ------------------------------------------------------------
create table if not exists public.nuc_avisos (
  id              bigserial primary key,
  site_id         text not null,
  unidad_negocio  text not null,
  -- Copia del nombre visible al abrir (site_legacy_id o site_id), para que
  -- el historial se lea aunque el inventario cambie esa noche.
  maquina         text,
  estado          text not null default 'fuera_linea'
                  check (estado in ('fuera_linea', 'en_revision', 'por_confirmar', 'en_linea')),
  nota_digital    text,
  abierto_por     text not null,
  abierto_en      timestamptz not null default now(),
  tomado_por      text,
  tomado_en       timestamptz,
  nota_tecnico    text,
  revisado_por    text,
  revisado_en     timestamptz,
  cerrado_por     text,
  cerrado_en      timestamptz,
  nota_cierre     text,
  veces_reabierto integer not null default 0,
  actualizado_en  timestamptz not null default now()
);

comment on table public.nuc_avisos is
  'Avisos de NUC fuera de línea en máquinas Biobox: Digital los levanta y confirma; Op. Bio Box los revisa. Solo se escriben con nuc_aviso_*().';

-- Una máquina, un aviso abierto.
create unique index if not exists nuc_avisos_uno_abierto
  on public.nuc_avisos (site_id) where estado <> 'en_linea';
create index if not exists nuc_avisos_unidad_estado
  on public.nuc_avisos (unidad_negocio, estado);

create table if not exists public.nuc_avisos_eventos (
  id        bigserial primary key,
  aviso_id  bigint not null references public.nuc_avisos(id) on delete cascade,
  accion    text not null
            check (accion in ('abierto', 'tomado', 'revisado', 'sigue_fuera', 'en_linea')),
  estado    text not null,
  por       text not null,
  en        timestamptz not null default now(),
  nota      text
);
create index if not exists nuc_avisos_eventos_aviso
  on public.nuc_avisos_eventos (aviso_id, en);

comment on table public.nuc_avisos_eventos is
  'Historial de cada aviso de NUC: quién lo abrió, tomó, revisó, regresó o cerró y cuándo.';

alter table public.nuc_avisos enable row level security;
alter table public.nuc_avisos_eventos enable row level security;

-- Sin escrituras directas: solo las funciones de abajo.
revoke all on public.nuc_avisos, public.nuc_avisos_eventos from anon, authenticated;
revoke all on sequence public.nuc_avisos_id_seq, public.nuc_avisos_eventos_id_seq from anon, authenticated;
grant select on public.nuc_avisos, public.nuc_avisos_eventos to authenticated;

-- ------------------------------------------------------------
-- 2) Quién es quién
-- ------------------------------------------------------------
-- Digital: técnico (reparacion) con área Digital de cualquier unidad, o
-- el manager.
create or replace function public.nuc_es_digital()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select tiene_rol('manager'::app_role)
      or exists (
           select 1 from usuario_roles ur
            where lower(ur.usuario_email) = lower(auth_email())
              and ur.rol = 'reparacion'::app_role
              and trim(ur.departamento) ilike 'digital');
$function$;

-- Técnico de la máquina: técnico de Op. Bio Box de esa unidad, el
-- coordinador de esa unidad (sin área u Op. Bio Box) o el manager. Una fila
-- sin unidad cuenta para todas.
create or replace function public.nuc_es_tecnico(p_unidad text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select tiene_rol('manager'::app_role)
      or exists (
           select 1 from usuario_roles ur
            where lower(ur.usuario_email) = lower(auth_email())
              and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad))
              and (
                    (ur.rol = 'reparacion'::app_role and trim(ur.departamento) ilike 'op. bio box')
                 or (ur.rol = 'coordinador'::app_role
                     and (ur.departamento is null or trim(ur.departamento) ilike 'op. bio box'))
              ));
$function$;

-- Quién ve los avisos de una unidad: Digital, el técnico o coordinador de
-- Op. Bio Box de la unidad, el coordinador de la unidad (cualquier área) y
-- Consulta (viewer).
create or replace function public.nuc_puede_ver(p_unidad text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select nuc_es_digital()
      or nuc_es_tecnico(p_unidad)
      or tiene_rol('viewer'::app_role)
      or exists (
           select 1 from usuario_roles ur
            where lower(ur.usuario_email) = lower(auth_email())
              and ur.rol = 'coordinador'::app_role
              and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad)));
$function$;

-- Solo nuc_puede_ver la usa una política (corre como quien consulta); las
-- otras dos solo las llaman las funciones de este archivo, como su dueño.
revoke all on function public.nuc_es_digital() from public, anon, authenticated;
revoke all on function public.nuc_es_tecnico(text) from public, anon, authenticated;
revoke all on function public.nuc_puede_ver(text) from public, anon;
grant execute on function public.nuc_puede_ver(text) to authenticated;

drop policy if exists nuc_avisos_sel on public.nuc_avisos;
create policy nuc_avisos_sel on public.nuc_avisos
  for select to authenticated
  using ((select nuc_puede_ver(unidad_negocio)));

drop policy if exists nuc_avisos_eventos_sel on public.nuc_avisos_eventos;
create policy nuc_avisos_eventos_sel on public.nuc_avisos_eventos
  for select to authenticated
  using (exists (
    select 1 from public.nuc_avisos a
     where a.id = nuc_avisos_eventos.aviso_id
       and (select nuc_puede_ver(a.unidad_negocio))));

-- ------------------------------------------------------------
-- 3) Avisos a los técnicos (con cascada)
-- ------------------------------------------------------------
-- Técnicos de Op. Bio Box de la unidad; si no hay, coordinadores de la
-- unidad; si tampoco, los managers. Misma cascada que los avisos de área
-- sin técnico de Incidencias (8-oct-2026). Solo la llaman las funciones
-- de este archivo.
create or replace function public.nuc_avisar_tecnicos(p_unidad text, p_evento text, p_msg text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_para text[];
begin
  select array_agg(distinct lower(ur.usuario_email)) into v_para
    from usuario_roles ur
   where ur.rol = 'reparacion'::app_role
     and trim(ur.departamento) ilike 'op. bio box'
     and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad));
  if v_para is null then
    select array_agg(distinct lower(ur.usuario_email)) into v_para
      from usuario_roles ur
     where ur.rol = 'coordinador'::app_role
       and lower(ur.unidad_negocio) = lower(p_unidad)
       and (ur.departamento is null or trim(ur.departamento) ilike 'op. bio box');
  end if;
  if v_para is null then
    select array_agg(distinct lower(ur.usuario_email)) into v_para
      from usuario_roles ur
     where ur.rol = 'manager'::app_role;
  end if;
  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  select null, e, p_evento, p_msg, p_unidad
    from unnest(coalesce(v_para, '{}'::text[])) e
   where e is distinct from lower(auth_email());
end;
$function$;

revoke all on function public.nuc_avisar_tecnicos(text, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4) Acciones
-- ------------------------------------------------------------

-- Digital levanta el aviso de una máquina Biobox.
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
    '. Tómalo en Aviso NUC.');
  return v_id;
end;
$function$;

-- El técnico toma el aviso: fuera_linea → en_revision.
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
  select * into v_a from nuc_avisos where id = p_id for update;
  if v_a.id is null then
    raise exception 'El aviso ya no existe.';
  end if;
  if v_yo is null or not nuc_es_tecnico(v_a.unidad_negocio) then
    raise exception 'Solo el técnico de Op. Bio Box de % puede tomar este aviso.', v_a.unidad_negocio using errcode = '42501';
  end if;
  -- Doble toque del mismo técnico: ya es suyo, no es error.
  if v_a.estado = 'en_revision' and v_a.tomado_por = v_yo then
    return;
  end if;
  if v_a.estado <> 'fuera_linea' then
    raise exception 'Este aviso ya lo tomó %.', coalesce(v_a.tomado_por, 'otra persona');
  end if;

  update nuc_avisos
     set estado = 'en_revision', tomado_por = v_yo, tomado_en = now(), actualizado_en = now()
   where id = p_id;
  insert into nuc_avisos_eventos(aviso_id, accion, estado, por)
  values (p_id, 'tomado', 'en_revision', v_yo);
end;
$function$;

-- El técnico dice qué hizo: → por_confirmar, y le avisa a quien lo levantó.
create or replace function public.nuc_aviso_revisado(p_id bigint, p_nota text)
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
  select * into v_a from nuc_avisos where id = p_id for update;
  if v_a.id is null then
    raise exception 'El aviso ya no existe.';
  end if;
  if v_yo is null or not nuc_es_tecnico(v_a.unidad_negocio) then
    raise exception 'Solo el técnico de Op. Bio Box de % puede revisar este aviso.', v_a.unidad_negocio using errcode = '42501';
  end if;
  if v_a.estado not in ('fuera_linea', 'en_revision') then
    raise exception 'Este aviso ya no está en revisión.';
  end if;
  if v_nota is null or length(v_nota) < 3 then
    raise exception 'Escribe qué encontraste o qué hiciste.';
  end if;

  update nuc_avisos
     set estado = 'por_confirmar',
         tomado_por = coalesce(tomado_por, v_yo),
         tomado_en = coalesce(tomado_en, now()),
         nota_tecnico = v_nota, revisado_por = v_yo, revisado_en = now(),
         actualizado_en = now()
   where id = p_id;
  insert into nuc_avisos_eventos(aviso_id, accion, estado, por, nota)
  values (p_id, 'revisado', 'por_confirmar', v_yo, v_nota);

  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  values (null, v_a.abierto_por, 'nuc_por_confirmar',
          'El técnico revisó el NUC de ' || coalesce(v_a.maquina, v_a.site_id) || ': ' || v_nota ||
          '. Confirma en Aviso NUC si ya está en línea.',
          v_a.unidad_negocio);
end;
$function$;

-- Digital confirma: en línea (cierra) o sigue fuera (regresa a los técnicos).
-- «En línea» vale desde cualquier estado abierto (el NUC pudo volver solo);
-- «Sigue fuera» solo después de que el técnico dijo qué hizo.
create or replace function public.nuc_aviso_confirmar(p_id bigint, p_en_linea boolean, p_nota text default null)
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
    raise exception 'Solo Digital puede confirmar el estado del NUC.' using errcode = '42501';
  end if;
  select * into v_a from nuc_avisos where id = p_id for update;
  if v_a.id is null then
    raise exception 'El aviso ya no existe.';
  end if;
  if v_a.estado = 'en_linea' then
    raise exception 'Este aviso ya está cerrado.';
  end if;

  if p_en_linea then
    update nuc_avisos
       set estado = 'en_linea', cerrado_por = v_yo, cerrado_en = now(), nota_cierre = v_nota,
           actualizado_en = now()
     where id = p_id;
    insert into nuc_avisos_eventos(aviso_id, accion, estado, por, nota)
    values (p_id, 'en_linea', 'en_linea', v_yo, v_nota);
    if v_a.tomado_por is not null then
      if v_a.tomado_por <> v_yo then
        insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
        values (null, v_a.tomado_por, 'nuc_en_linea',
                'Digital confirmó que el NUC de ' || coalesce(v_a.maquina, v_a.site_id) || ' ya está en línea.',
                v_a.unidad_negocio);
      end if;
    else
      -- Volvió sola antes de que alguien la tomara: los técnicos que
      -- recibieron el aviso saben que ya no hace falta ir.
      perform nuc_avisar_tecnicos(
        v_a.unidad_negocio, 'nuc_en_linea',
        'El NUC de ' || coalesce(v_a.maquina, v_a.site_id) || ' volvió a estar en línea: ya no hace falta ir.');
    end if;
  else
    if v_a.estado <> 'por_confirmar' then
      raise exception 'Solo se puede regresar un aviso que el técnico ya revisó.';
    end if;
    update nuc_avisos
       set estado = 'fuera_linea', tomado_por = null, tomado_en = null,
           veces_reabierto = veces_reabierto + 1, actualizado_en = now()
     where id = p_id;
    insert into nuc_avisos_eventos(aviso_id, accion, estado, por, nota)
    values (p_id, 'sigue_fuera', 'fuera_linea', v_yo, v_nota);
    perform nuc_avisar_tecnicos(
      v_a.unidad_negocio, 'nuc_fuera_linea',
      'El NUC de ' || coalesce(v_a.maquina, v_a.site_id) || ' sigue fuera de línea' ||
      coalesce(': ' || v_nota, '') || '. Tómalo en Aviso NUC.');
  end if;
end;
$function$;

revoke all on function public.nuc_aviso_abrir(text, text) from public, anon;
revoke all on function public.nuc_aviso_tomar(bigint) from public, anon;
revoke all on function public.nuc_aviso_revisado(bigint, text) from public, anon;
revoke all on function public.nuc_aviso_confirmar(bigint, boolean, text) from public, anon;
grant execute on function public.nuc_aviso_abrir(text, text) to authenticated;
grant execute on function public.nuc_aviso_tomar(bigint) to authenticated;
grant execute on function public.nuc_aviso_revisado(bigint, text) to authenticated;
grant execute on function public.nuc_aviso_confirmar(bigint, boolean, text) to authenticated;

-- Verificar: 2 tablas con RLS, 2 políticas de lectura y 7 funciones.
select c.relname, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('nuc_avisos', 'nuc_avisos_eventos');
select tablename, policyname, cmd from pg_policies where tablename like 'nuc_avisos%';
select proname, prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and proname like 'nuc\_%' order by proname;
