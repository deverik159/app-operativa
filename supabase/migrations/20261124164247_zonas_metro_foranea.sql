-- ============================================================
-- zonas_metro_foranea — Metro (CM y EM) y Foránea (el resto de las plazas)
-- en Incidencias (Erik, 24-nov-2026).
--
-- Lo que pidió Erik: lo que se reporta fuera de CDMX y Edomex debe ir a un
-- validador y a unos técnicos propios, para que no se mezcle con lo de la
-- ciudad, pero sin dejar de verse todo junto (manager, coordinadores,
-- viewers e indicadores). Eligió:
--   · dos zonas: Metro y Foránea (no plaza por plaza);
--   · validador propio para las foráneas;
--   · solo Ecovallas y Biobox (Vía Verde es solo CDMX; Biobox Perú ya es
--     una unidad aparte).
--
-- Cómo queda:
--   1. `incidencias.zona` ('metro' | 'foranea'). La pone el trigger
--      inc_set_zona en cada alta y cambio, a partir de la clave
--      (MX_<plaza>_…) y, si no hay clave, de la plaza. Nadie la escribe a
--      mano: el trigger la recalcula siempre.
--   2. `usuario_roles.zona` (null = las dos, como `medio`). Hoy todos
--      quedan en null: nada cambia hasta que Erik ponga zonas en Usuarios.
--   3. La zona del rol filtra, igual que el medio:
--      · ver y editar (RLS inc_sel/upd_validador y inc_sel/upd_reparacion);
--      · los avisos (destinatarios_notif recibe p_zona; si nadie cubre la
--        zona, la cascada de siempre: coordinadores → managers);
--      · el chat (avisos a técnicos del área y al validador; las menciones
--        @área; quién puede escribir) y «Descartar como duplicada»;
--      · «Pasar a Op. Bio Box»;
--      · la bandeja de reportes de la app Biobox (ver y atender), con la
--        zona de la máquina del reporte (sin máquina = metro);
--      · las reasignaciones: un validador solo resuelve las de incidencias
--        que puede ver (antes, cualquier validador resolvía cualquiera).
--      Coordinador, manager, viewer y reportante no se tocan: ven todo lo
--      que ya veían.
--
-- Los cambios a las funciones existentes se hacen como PARCHES sobre la
-- versión viva de producción (pg_get_functiondef): cada parche dice el
-- texto exacto que cambia y cuántas veces debe aparecer. Si alguna función
-- cambió y el texto ya no está (o está otro número de veces), la migración
-- aborta completa y no se aplica nada.
--
-- Revisada por revisor-rls el 24-nov-2026 (se agregaron sus hallazgos:
-- menciones @área, bandeja app Biobox, reasignaciones, Op. Bio Box, grants
-- y lock_timeout).
-- ============================================================

-- Si alguien tiene incidencias ocupada mucho rato, mejor abortar que dejar
-- a todos esperando detrás del bloqueo de ALTER TABLE.
set local lock_timeout = '5s';

-- ── 1. Zona de una clave ────────────────────────────────────────────────
-- Mismo criterio en src/lib/zona.ts (zonaDeClave).
create or replace function public.zona_de_clave(p_unidad text, p_clave text, p_plaza text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when lower(btrim(coalesce(p_unidad, ''))) not in ('ecovallas', 'biobox') then 'metro'
    -- MX_CM_EV_3244 → CM. Con clave manda la clave.
    when upper(split_part(btrim(coalesce(p_clave, '')), '_', 2)) <> '' then
      case when upper(split_part(btrim(p_clave), '_', 2)) in ('CM', 'EM')
           then 'metro' else 'foranea' end
    -- Sin clave: la plaza que se copió del inventario (inventario.estado).
    when nullif(btrim(coalesce(p_plaza, '')), '') is null then 'metro'
    when lower(btrim(p_plaza)) in ('ciudad de méxico', 'méxico', 'estado de méxico') then 'metro'
    else 'foranea'
  end
$$;

revoke all on function public.zona_de_clave(text, text, text) from public, anon;
grant execute on function public.zona_de_clave(text, text, text) to authenticated, service_role;

comment on function public.zona_de_clave(text, text, text) is
  'Metro (CM, EM) o foránea, de la clave MX_<plaza>_… o, sin clave, de la plaza. Solo Ecovallas y Biobox; lo demás es metro (24-nov-2026).';

-- ── 2. Columnas ─────────────────────────────────────────────────────────
alter table public.usuario_roles
  add column if not exists zona text;
alter table public.usuario_roles
  drop constraint if exists usuario_roles_zona_chk;
alter table public.usuario_roles
  add constraint usuario_roles_zona_chk check (zona is null or zona in ('metro', 'foranea'));
comment on column public.usuario_roles.zona is
  'Zona que cubre el rol (validador y técnicos): metro, foranea o null = las dos (24-nov-2026).';

alter table public.incidencias
  add column if not exists zona text not null default 'metro';
alter table public.incidencias
  drop constraint if exists incidencias_zona_chk;
alter table public.incidencias
  add constraint incidencias_zona_chk check (zona in ('metro', 'foranea'));
comment on column public.incidencias.zona is
  'Metro (CM, EM) o foranea. La calcula el trigger inc_set_zona (24-nov-2026).';

-- Las que ya existen. Sin los triggers de usuario: esto no es un cambio de
-- la incidencia (no debe avisar, ni pasar por el blindaje, ni el historial).
alter table public.incidencias disable trigger user;
update public.incidencias i
   set zona = public.zona_de_clave(i.unidad_negocio, i.clave_medio, i.plaza)
 where i.zona is distinct from public.zona_de_clave(i.unidad_negocio, i.clave_medio, i.plaza);
alter table public.incidencias enable trigger user;

create or replace function public.inc_set_zona()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.zona := public.zona_de_clave(new.unidad_negocio, new.clave_medio, new.plaza);
  return new;
end
$$;

drop trigger if exists inc_set_zona on public.incidencias;
create trigger inc_set_zona
  before insert or update on public.incidencias
  for each row execute function public.inc_set_zona();

revoke all on function public.inc_set_zona() from public, anon, authenticated;

-- ── 3. ¿Alguno de mis roles cubre esta unidad y zona? ──────────────────
-- Para los técnicos (las políticas de reparación ya resuelven el área con
-- mis_areas_por_unidad; esto solo agrega la zona) y el chat.
create or replace function public.mi_zona_cubre(p_rol app_role, p_unidad text, p_zona text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from usuario_roles ur
     where lower(ur.usuario_email) = lower((select auth_email()))
       and ur.rol = p_rol
       and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad))
       and (ur.zona is null or ur.zona = p_zona)
  )
$$;

revoke all on function public.mi_zona_cubre(app_role, text, text) from public, anon;
grant execute on function public.mi_zona_cubre(app_role, text, text) to authenticated, service_role;

-- ── 4. destinatarios_notif con zona ─────────────────────────────────────
-- Igual que antes más p_zona (null = no filtra). Las llamadas de 3 o 4
-- argumentos siguen funcionando igual.
drop function if exists public.destinatarios_notif(app_role, text, text, text);

create or replace function public.destinatarios_notif(
  p_rol app_role,
  p_unidad text,
  p_area text,
  p_medio text default null,
  p_zona text default null
)
returns setof text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v text[];
begin
  -- 1) A quien le toca. `unidad_negocio is null` = todas las unidades;
  --    `departamento is null` = todas las áreas; `medio is null` (en el rol
  --    o en la incidencia) = ambos medios. El medio solo existe en el rol
  --    de validador; en los demás roles viene null y no filtra.
  --    CAMBIO (4-nov-2026): igualdad sin mayúsculas, no ilike (patrón).
  --    CAMBIO (24-nov-2026): `zona is null` = metro y foránea.
  select array_agg(distinct lower(ur.usuario_email)) into v
  from usuario_roles ur
  where ur.rol = p_rol
    and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad))
    and (p_area is null
         or ur.departamento is null
         or lower(ur.departamento) = lower(p_area))
    and (p_medio is null
         or ur.medio is null
         or lower(ur.medio) = lower(p_medio))
    and (p_zona is null
         or ur.zona is null
         or ur.zona = p_zona);

  -- 2) Respaldo: coordinadores de la unidad.
  if v is null or array_length(v, 1) is null then
    select array_agg(distinct lower(ur.usuario_email)) into v
    from usuario_roles ur
    where ur.rol = 'coordinador'::app_role
      and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad));
  end if;

  -- 3) Última red: managers.
  if v is null or array_length(v, 1) is null then
    select array_agg(distinct lower(ur.usuario_email)) into v
    from usuario_roles ur
    where ur.rol = 'manager'::app_role;
  end if;

  return query select unnest(coalesce(v, '{}'::text[]));
end $function$;

revoke all on function public.destinatarios_notif(app_role, text, text, text, text) from public, anon, authenticated;
grant execute on function public.destinatarios_notif(app_role, text, text, text, text) to service_role;

-- ── 5. Bandeja de la app Biobox con zona ────────────────────────────────
-- Versiones de 2 argumentos (sin default, para no chocar con las de 1). Las
-- de 1 se quitan después de los parches, cuando ya nadie las usa.
create or replace function public.biobox_app_exige_validador(p_unidad text, p_zona text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_yo text := lower((select auth_email()));
begin
  if v_yo is null then
    raise exception 'Sin sesión.' using errcode = '42501';
  end if;
  if not (select tiene_rol('manager'::app_role)) and not exists (
    select 1 from usuario_roles ur
     where lower(ur.usuario_email) = v_yo
       and ur.rol = 'validador'::app_role
       and lower(btrim(ur.unidad_negocio)) = lower(p_unidad)
       -- Zona (24-nov-2026): la del reporte; null = no filtra.
       and (ur.zona is null or p_zona is null or ur.zona = p_zona)
  ) then
    raise exception 'Solo la validadora de % (o el manager) atiende esta bandeja.', p_unidad
      using errcode = '42501';
  end if;
  return v_yo;
end
$$;

revoke all on function public.biobox_app_exige_validador(text, text) from public, anon, authenticated;
grant execute on function public.biobox_app_exige_validador(text, text) to service_role;

create or replace function public.biobox_app_ve_bandeja(p_unidad text, p_zona text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (select tiene_rol('manager'::app_role))
      or exists (
        select 1 from usuario_roles ur
         where lower(ur.usuario_email) = lower((select auth_email()))
           and (
             -- Validador DE esa unidad (como inc_sel_validador) y de esa
             -- zona (24-nov-2026).
             (ur.rol = 'validador'::app_role
              and lower(btrim(ur.unidad_negocio)) = lower(p_unidad)
              and (ur.zona is null or p_zona is null or ur.zona = p_zona))
             -- Coordinador y Consulta: de esa unidad o sin unidad (= todas).
             or (ur.rol in ('coordinador'::app_role, 'viewer'::app_role)
                 and (nullif(btrim(ur.unidad_negocio), '') is null
                      or lower(btrim(ur.unidad_negocio)) = lower(p_unidad)))
             -- Técnico de TI, solo consulta: de esa unidad o sin unidad, y
             -- de su zona.
             or (ur.rol = 'reparacion'::app_role
                 and lower(btrim(ur.departamento)) = 'ti'
                 and (nullif(btrim(ur.unidad_negocio), '') is null
                      or lower(btrim(ur.unidad_negocio)) = lower(p_unidad))
                 and (ur.zona is null or p_zona is null or ur.zona = p_zona))
           )
      );
$$;

revoke all on function public.biobox_app_ve_bandeja(text, text) from public, anon;
grant execute on function public.biobox_app_ve_bandeja(text, text) to authenticated, service_role;

alter policy biobox_app_reportes_sel on public.biobox_app_reportes
  using ((select biobox_app_ve_bandeja(
            biobox_app_reportes.unidad_negocio,
            zona_de_clave(biobox_app_reportes.unidad_negocio, biobox_app_reportes.clave_inventario, null))));

-- ── 6. Parches a las funciones vivas ────────────────────────────────────
do $parches$
declare
  f      record;
  p      record;
  v_def  text;
  v_hay  int;
begin
  create temp table _parches (
    orden int, fn text, viejo text, nuevo text, veces int
  ) on commit drop;

  insert into _parches values
  -- Avisos de validador y técnicos: pasan la zona de la incidencia.
  (1, 'notificar_incidencia',
      'null, new.medio) d',
      'null, new.medio, new.zona) d', 3),
  (2, 'notificar_incidencia',
      '''reparacion''::app_role, new.unidad_negocio, new.area_responsable) d',
      '''reparacion''::app_role, new.unidad_negocio, new.area_responsable, null, new.zona) d', 2),
  (1, 'notificar_area_asignada',
      '''reparacion''::app_role, new.unidad_negocio, new.assigned_area) d',
      '''reparacion''::app_role, new.unidad_negocio, new.assigned_area, null, new.zona) d', 1),
  (1, 'notificar_correccion_area',
      '''reparacion''::app_role, new.unidad_negocio, new.area_responsable) d',
      '''reparacion''::app_role, new.unidad_negocio, new.area_responsable, null, new.zona) d', 1),
  (1, 'notificar_reasignacion_aprobada',
      '''reparacion''::app_role, new.unidad_negocio, new.area_responsable) d',
      '''reparacion''::app_role, new.unidad_negocio, new.area_responsable, null, new.zona) d', 1),
  (1, 'notificar_webadmin_atendido',
      'null, new.medio) d',
      'null, new.medio, new.zona) d', 1),
  -- La solicitud de reasignación no guarda medio ni zona: de su incidencia.
  (1, 'notificar_reasignacion',
      'declare msg text; v_medio text;',
      'declare msg text; v_medio text; v_zona text;', 1),
  (2, 'notificar_reasignacion',
      'select i.medio into v_medio from incidencias i',
      'select i.medio, i.zona into v_medio, v_zona from incidencias i', 1),
  (3, 'notificar_reasignacion',
      'null, v_medio) d',
      'null, v_medio, v_zona) d', 1),
  -- Chat: los técnicos del área y el validador, solo de su zona.
  (1, 'notificar_chat',
      'or lower(trim(ur.departamento)) = lower(trim(area_efectiva)))',
      'or lower(trim(ur.departamento)) = lower(trim(area_efectiva)))
                  and (ur.zona is null or ur.zona = inc.zona)', 1),
  (2, 'notificar_chat',
      'or lower(ur.medio) = lower(inc.medio))',
      'or lower(ur.medio) = lower(inc.medio))
                  and (ur.zona is null or ur.zona = inc.zona)', 1),
  -- @área: solo los técnicos del área de esa zona (la mención les abre la
  -- incidencia por inc_sel_participante_chat). @persona no: es explícita.
  (3, 'notificar_chat',
      'and lower(trim(ur.departamento)) = lower(p.area)',
      'and lower(trim(ur.departamento)) = lower(p.area)
       and (ur.zona is null or ur.zona = inc.zona)', 1),
  -- Que un técnico de la otra zona que contestó no calle el aviso al área.
  (4, 'notificar_chat',
      'and lower(trim(ur.departamento)) = lower(trim(area_efectiva))',
      'and lower(trim(ur.departamento)) = lower(trim(area_efectiva))
     and (ur.zona is null or ur.zona = inc.zona)', 1),
  -- «Pasar a Op. Bio Box»: el técnico del área, de esa zona; y el técnico
  -- de la ruta que recibe el aviso, también.
  (1, 'inc_pasar_a_op_biobox',
      'and btrim(ur.departamento) ilike v_area',
      'and btrim(ur.departamento) ilike v_area
       and (ur.zona is null or ur.zona = v_i.zona)', 1),
  (2, 'inc_pasar_a_op_biobox',
      'and btrim(ur.departamento) ilike ''op. bio box''',
      'and btrim(ur.departamento) ilike ''op. bio box''
          and (ur.zona is null or ur.zona = v_i.zona)', 1),
  -- Bandeja de la app Biobox: la validadora de la zona de la máquina.
  (1, 'clasificar_reporte_biobox_app',
      'biobox_app_exige_validador(r.unidad_negocio)',
      'biobox_app_exige_validador(r.unidad_negocio, zona_de_clave(r.unidad_negocio, r.clave_inventario, null))', 1),
  (1, 'ligar_reporte_biobox_app',
      'biobox_app_exige_validador(r.unidad_negocio)',
      'biobox_app_exige_validador(r.unidad_negocio, zona_de_clave(r.unidad_negocio, r.clave_inventario, null))', 1),
  (1, 'descartar_reporte_biobox_app',
      'biobox_app_exige_validador(r.unidad_negocio)',
      'biobox_app_exige_validador(r.unidad_negocio, zona_de_clave(r.unidad_negocio, r.clave_inventario, null))', 1),
  -- Quién puede escribir en el chat.
  (1, 'puede_escribir_chat',
      'or ((select tiene_rol(''validador'')) and i.unidad_negocio in (select mis_unidades()))',
      'or ((select tiene_rol(''validador'')) and i.unidad_negocio in (select mis_unidades())
            and mi_zona_cubre(''validador''::app_role, i.unidad_negocio, i.zona))', 1),
  (2, 'puede_escribir_chat',
      'or mi_area_en_unidad(i.assigned_area, i.unidad_negocio)))',
      'or mi_area_en_unidad(i.assigned_area, i.unidad_negocio))
            and mi_zona_cubre(''reparacion''::app_role, i.unidad_negocio, i.zona))', 1),
  (3, 'puede_escribir_chat',
      'and ur.departamento = ''Op. Bio Box''',
      'and ur.departamento = ''Op. Bio Box''
                and (ur.zona is null or ur.zona = i.zona)', 1),
  -- «Descartar como duplicada»: el validador de esa zona.
  (1, 'inc_descartar_duplicada',
      'and (ur.medio is null or lower(ur.medio) = lower(d.medio)))) then',
      'and (ur.medio is null or lower(ur.medio) = lower(d.medio))
                        and (ur.zona is null or ur.zona = d.zona))) then', 1);

  for f in select distinct fn from _parches loop
    select pg_get_functiondef(x.oid) into v_def
      from pg_proc x join pg_namespace n on n.oid = x.pronamespace
     where n.nspname = 'public' and x.proname = f.fn;
    if v_def is null then
      raise exception 'No existe public.%', f.fn;
    end if;
    if (select count(*) from pg_proc x join pg_namespace n on n.oid = x.pronamespace
         where n.nspname = 'public' and x.proname = f.fn) <> 1 then
      raise exception 'public.% tiene más de una versión: revisar antes de aplicar.', f.fn;
    end if;

    for p in select * from _parches where fn = f.fn order by orden loop
      v_hay := (length(v_def) - length(replace(v_def, p.viejo, ''))) / length(p.viejo);
      if v_hay <> p.veces then
        raise exception 'public.%: el texto «%» aparece % vez(es), se esperaban %. Cambió en producción; revisar.',
          f.fn, p.viejo, v_hay, p.veces;
      end if;
      v_def := replace(v_def, p.viejo, p.nuevo);
    end loop;

    execute v_def;
  end loop;
end
$parches$;

-- Las de 1 argumento ya no las usa nadie (la app no las llama por RPC).
drop function if exists public.biobox_app_exige_validador(text);
drop function if exists public.biobox_app_ve_bandeja(text);

-- ── 7. Reasignaciones ───────────────────────────────────────────────────
-- Antes: cualquier validador resolvía cualquier reasignación, de cualquier
-- unidad. Ahora solo las de incidencias que puede ver (la subconsulta corre
-- con su RLS: hereda unidad, medio y zona). El manager, igual.
alter policy reasign_upd_manager on public.reasignaciones
  using (tiene_rol('manager'::app_role)
         or (tiene_rol('validador'::app_role)
             and exists (select 1 from public.incidencias i
                          where i.record_id = reasignaciones.record_id)));

-- ── 8. Políticas de incidencias ─────────────────────────────────────────
do $politicas$
declare
  v_medio constant text := '((ur.medio IS NULL) OR (lower(ur.medio) = lower(incidencias.medio)))';
  v_zona  constant text := '((ur.medio IS NULL) OR (lower(ur.medio) = lower(incidencias.medio))) AND ((ur.zona IS NULL) OR (ur.zona = incidencias.zona))';
  q text;
  c text;
  n int;
begin
  -- Validador: la zona va en la MISMA fila de usuario_roles que la unidad y
  -- el medio (un validador puede tener filas distintas por unidad).
  select qual into q from pg_policies
   where schemaname = 'public' and tablename = 'incidencias' and policyname = 'inc_sel_validador';
  n := (length(coalesce(q, '')) - length(replace(coalesce(q, ''), v_medio, ''))) / length(v_medio);
  if n <> 1 then
    raise exception 'inc_sel_validador cambió (medio aparece % veces).', n;
  end if;
  execute format('alter policy inc_sel_validador on public.incidencias using (%s)',
                 replace(q, v_medio, v_zona));

  select qual, with_check into q, c from pg_policies
   where schemaname = 'public' and tablename = 'incidencias' and policyname = 'inc_upd_validador';
  n := (length(coalesce(q, '')) - length(replace(coalesce(q, ''), v_medio, ''))) / length(v_medio);
  if n <> 1 then
    raise exception 'inc_upd_validador (using) cambió (medio aparece % veces).', n;
  end if;
  n := (length(coalesce(c, '')) - length(replace(coalesce(c, ''), v_medio, ''))) / length(v_medio);
  if n <> 1 then
    raise exception 'inc_upd_validador (with check) cambió (medio aparece % veces).', n;
  end if;
  execute format('alter policy inc_upd_validador on public.incidencias using (%s) with check (%s)',
                 replace(q, v_medio, v_zona), replace(c, v_medio, v_zona));

  -- Técnicos: lo de siempre Y que alguno de sus roles de reparación cubra
  -- la zona de la incidencia en esa unidad.
  select qual, with_check into q, c from pg_policies
   where schemaname = 'public' and tablename = 'incidencias' and policyname = 'inc_sel_reparacion';
  if q is null or c is not null or q like '%mi_zona_cubre%' then
    raise exception 'inc_sel_reparacion no es la esperada.';
  end if;
  execute format('alter policy inc_sel_reparacion on public.incidencias using ((%s) AND mi_zona_cubre(''reparacion''::app_role, unidad_negocio, zona))', q);

  select qual, with_check into q, c from pg_policies
   where schemaname = 'public' and tablename = 'incidencias' and policyname = 'inc_upd_reparacion';
  if q is null or c is not null or q like '%mi_zona_cubre%' then
    raise exception 'inc_upd_reparacion no es la esperada.';
  end if;
  execute format('alter policy inc_upd_reparacion on public.incidencias using ((%s) AND mi_zona_cubre(''reparacion''::app_role, unidad_negocio, zona))', q);
end
$politicas$;
