-- 4-nov-2026 · Incidencias · La base solo acepta unidad, área y medio válidos en un folio.
-- Por qué: inc_ins_reportante solo revisaba el rol y captured_by; un folio creado por la API
-- con unidad "%", vacía o de OTRA unidad, o con un área o medio inventados, lo veían o editaban
-- validadores y coordinadores de todas las unidades (las reglas usaban la unidad como patrón
-- ilike) y disparaba avisos de más. Con los datos de hoy (26 folios, 2 reasignaciones) no se rechaza nada.
-- Lista de unidades confirmada por Erik el 4-nov-2026: las 4 que operan (sin Verde Vertical).
-- También: reasignaciones toma la unidad y el área de origen del folio, y destinatarios_notif
-- ya no se puede llamar desde la API (solo la usan los avisos de la base).

-- 1) Unidad: obligatoria y de la lista, escrita como en el inventario y en la app.
alter table public.incidencias drop constraint if exists incidencias_unidad_negocio_check;
alter table public.incidencias add constraint incidencias_unidad_negocio_check
  check (unidad_negocio is not null
         and unidad_negocio in ('Ecovallas', 'Biobox', 'Vía Verde', 'Biobox Perú'));

-- 2) Medio: vacío, Impreso o Digital (sale del inventario, no lo escribe el usuario).
alter table public.incidencias drop constraint if exists incidencias_medio_check;
alter table public.incidencias add constraint incidencias_medio_check
  check (medio is null or medio in ('Impreso', 'Digital'));

-- 3) Área contra el catálogo, unidad del capturista y unidad que no se cambia.
create or replace function public.inc_valida_datos()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_yo text := lower((select auth_email()));
begin
  -- Área responsable: obligatoria y escrita igual que en el catálogo. Solo se
  -- revisa al crear o al cambiarla, para no estorbar otros cambios del folio.
  if tg_op = 'INSERT' or new.area_responsable is distinct from old.area_responsable then
    if new.area_responsable is null
       or not exists (select 1 from catalogo_incidencias c where c.area = new.area_responsable) then
      raise exception 'Área responsable no válida: %', coalesce(new.area_responsable, '(vacía)')
        using errcode = '23514';
    end if;
  end if;
  -- Área asignada: vacía o del catálogo.
  if new.assigned_area is not null
     and (tg_op = 'INSERT' or new.assigned_area is distinct from old.assigned_area)
     and not exists (select 1 from catalogo_incidencias c where c.area = new.assigned_area) then
    raise exception 'Área asignada no válida: %', new.assigned_area using errcode = '23514';
  end if;

  -- Sin sesión de usuario (procesos internos de la base): sin regla de unidad.
  if v_yo is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Quien captura debe tener algún rol en esa unidad, o un rol sin unidad (= todas).
    -- El manager puede capturar en cualquiera.
    if not (select tiene_rol('manager'::app_role)) and not exists (
      select 1 from usuario_roles ur
       where lower(ur.usuario_email) = v_yo
         and (nullif(btrim(ur.unidad_negocio), '') is null
              or lower(btrim(ur.unidad_negocio)) = lower(new.unidad_negocio))
    ) then
      raise exception 'No tienes rol en la unidad %.', new.unidad_negocio using errcode = '42501';
    end if;
  elsif new.unidad_negocio is distinct from old.unidad_negocio
        and not (select tiene_rol('manager'::app_role)) then
    raise exception 'La unidad de un folio no se puede cambiar.' using errcode = '42501';
  end if;
  return new;
end
$$;

revoke execute on function public.inc_valida_datos() from public, anon, authenticated;

-- Sin "update of <columnas>": así también ve lo que cambie otro trigger BEFORE.
drop trigger if exists inc_valida_datos on public.incidencias;
create trigger inc_valida_datos
  before insert or update
  on public.incidencias
  for each row execute function public.inc_valida_datos();

-- 4) Las reglas comparan por igualdad sin mayúsculas, no como patrón (ilike).
alter policy inc_sel_validador on public.incidencias
  using (exists (
    select 1 from usuario_roles ur
     where lower(ur.usuario_email) = lower((select auth_email()))
       and ur.rol = 'validador'::app_role
       and lower(ur.unidad_negocio) = lower(incidencias.unidad_negocio)
       and (ur.medio is null or lower(ur.medio) = lower(incidencias.medio))));

alter policy inc_upd_validador on public.incidencias
  using (exists (
    select 1 from usuario_roles ur
     where lower(ur.usuario_email) = lower((select auth_email()))
       and ur.rol = 'validador'::app_role
       and lower(ur.unidad_negocio) = lower(incidencias.unidad_negocio)
       and (ur.medio is null or lower(ur.medio) = lower(incidencias.medio))))
  with check (exists (
    select 1 from usuario_roles ur
     where lower(ur.usuario_email) = lower((select auth_email()))
       and ur.rol = 'validador'::app_role
       and lower(ur.unidad_negocio) = lower(incidencias.unidad_negocio)
       and (ur.medio is null or lower(ur.medio) = lower(incidencias.medio))));

alter policy inc_sel_coordinador on public.incidencias
  using ((select tiene_rol('coordinador'::app_role)) and (
    not exists (
      select 1 from usuario_roles ur
       where lower(ur.usuario_email) = lower((select auth_email()))
         and ur.rol = 'coordinador'::app_role
         and ur.unidad_negocio is not null)
    or exists (
      select 1 from usuario_roles ur
       where lower(ur.usuario_email) = lower((select auth_email()))
         and ur.rol = 'coordinador'::app_role
         and lower(ur.unidad_negocio) = lower(incidencias.unidad_negocio)
         and (ur.departamento is null
              or lower(ur.departamento) = lower(incidencias.area_responsable)))));

alter policy msg_ins_coordinador on public.mensajes
  with check (
    lower(autor_email) = lower((select auth_email()))
    and (select tiene_rol('coordinador'::app_role))
    and exists (
      select 1 from incidencias i
       where i.record_id = mensajes.record_id
         and i.estatus <> 'cerrada'::estatus_incidencia
         and (
           not exists (
             select 1 from usuario_roles ur
              where lower(ur.usuario_email) = lower((select auth_email()))
                and ur.rol = 'coordinador'::app_role
                and ur.unidad_negocio is not null)
           or exists (
             select 1 from usuario_roles ur
              where lower(ur.usuario_email) = lower((select auth_email()))
                and ur.rol = 'coordinador'::app_role
                and lower(ur.unidad_negocio) = lower(i.unidad_negocio)
                and (ur.departamento is null
                     or lower(ur.departamento) = lower(i.area_responsable))))));

-- destinatarios_notif: igual que antes, con igualdad en vez de ilike.
create or replace function public.destinatarios_notif(p_rol app_role, p_unidad text, p_area text, p_medio text default null::text)
 returns setof text
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v text[];
begin
  -- 1) A quien le toca. `unidad_negocio is null` = todas las unidades;
  --    `departamento is null` = todas las áreas; `medio is null` (en el rol
  --    o en la incidencia) = ambos medios. El medio solo existe en el rol
  --    de validador; en los demás roles viene null y no filtra.
  --    CAMBIO (4-nov-2026): igualdad sin mayúsculas, no ilike (patrón).
  select array_agg(distinct lower(ur.usuario_email)) into v
  from usuario_roles ur
  where ur.rol = p_rol
    and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad))
    and (p_area is null
         or ur.departamento is null
         or lower(ur.departamento) = lower(p_area))
    and (p_medio is null
         or ur.medio is null
         or lower(ur.medio) = lower(p_medio));

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

-- Solo la llaman los avisos de la base (notificar_incidencia, notificar_reasignacion,
-- notificar_reasignacion_aprobada, notificar_area_asignada y notificar_correccion_area,
-- todas SECURITY DEFINER de postgres); la app no. Desde la API devolvía correos.
revoke execute on function public.destinatarios_notif(app_role, text, text, text)
  from public, anon, authenticated;

-- 5) reasignaciones: la unidad y el área de origen salen del folio; el área destino,
--    del catálogo. Así una solicitud por la API no avisa a validadores de otra unidad.
alter table public.reasignaciones drop constraint if exists reasignaciones_unidad_negocio_check;
alter table public.reasignaciones add constraint reasignaciones_unidad_negocio_check
  check (unidad_negocio is not null
         and unidad_negocio in ('Ecovallas', 'Biobox', 'Vía Verde', 'Biobox Perú'));

alter table public.reasignaciones drop constraint if exists reasignaciones_areas_check;
alter table public.reasignaciones add constraint reasignaciones_areas_check
  check (area_origen is not null and btrim(area_origen) <> '' and area_origen !~ '[%_\\]'
         and area_destino is not null and btrim(area_destino) <> '' and area_destino !~ '[%_\\]');

create or replace function public.reasign_valida_datos()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inc record;
begin
  if tg_op = 'UPDATE' then
    if new.record_id is distinct from old.record_id
       or new.unidad_negocio is distinct from old.unidad_negocio
       or new.area_origen is distinct from old.area_origen then
      raise exception 'La incidencia, la unidad y el área de origen de una reasignación no se cambian.'
        using errcode = '42501';
    end if;
  else
    select i.unidad_negocio, i.area_responsable, i.folio into v_inc
      from incidencias i where i.record_id = new.record_id;
    if not found then
      raise exception 'La incidencia de la reasignación no existe.' using errcode = '23503';
    end if;
    -- Lo mismo que manda la app (ReasignModal), pero tomado del folio.
    new.unidad_negocio := v_inc.unidad_negocio;
    new.area_origen := v_inc.area_responsable;
    new.folio := v_inc.folio;
  end if;

  if (tg_op = 'INSERT' or new.area_destino is distinct from old.area_destino)
     and not exists (select 1 from catalogo_incidencias c where c.area = new.area_destino) then
    raise exception 'Área destino no válida: %', coalesce(new.area_destino, '(vacía)')
      using errcode = '23514';
  end if;
  return new;
end
$$;

revoke execute on function public.reasign_valida_datos() from public, anon, authenticated;

drop trigger if exists reasign_valida_datos on public.reasignaciones;
create trigger reasign_valida_datos
  before insert or update
  on public.reasignaciones
  for each row execute function public.reasign_valida_datos();

-- notificar_chat: igual que en 20261104173854, salvo el aviso normal a técnicos y
-- validadores, que ahora compara unidad, área y medio por igualdad.
create or replace function public.notificar_chat()
 returns trigger
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  inc record;
  msg text;
  mencionados text[] := '{}';
begin
  select * into inc from incidencias where record_id = new.record_id;
  if not found then return new; end if;
  msg := 'Nuevo mensaje en '||coalesce(inc.folio,'')||': '||left(coalesce(new.texto,''),80);

  -- Menciones de este mensaje (solo si la app las mandó y el folio tiene
  -- unidad: sin ella no hay "misma unidad" contra la cual validar).
  if jsonb_typeof(new.menciones) = 'array'
     and nullif(trim(inc.unidad_negocio), '') is not null then
    with pedidas as (
      select e->>'tipo' as tipo,
             lower(trim(e->>'email')) as email,
             trim(e->>'area') as area
      from jsonb_array_elements(new.menciones) with ordinality as x(e, n)
      where x.n <= 20
    ),
    validas as (
      -- @persona: con algún rol (menos Consulta) en la unidad, o sin unidad.
      select p.email, null::text as por_area
      from pedidas p
      where p.tipo = 'persona'
        and exists (
          select 1 from usuario_roles ur
          where lower(ur.usuario_email) = p.email
            and ur.rol <> 'viewer'::app_role
            and (ur.unidad_negocio is null
                 or lower(ur.unidad_negocio) = lower(inc.unidad_negocio))
        )
      union all
      -- @área: sus técnicos de la unidad. Igualdad y no ilike: el área llega
      -- del cliente y "%" mencionaría a todos los técnicos (revisor-rls).
      select lower(ur.usuario_email), p.area
      from pedidas p
      join usuario_roles ur
        on ur.rol = 'reparacion'::app_role
       and lower(trim(ur.departamento)) = lower(p.area)
       and (ur.unidad_negocio is null
            or lower(ur.unidad_negocio) = lower(inc.unidad_negocio))
      where p.tipo = 'area'
        and coalesce(p.area, '') <> ''
    ),
    -- Uno por persona; si llegó directo y por área, cuenta lo directo.
    unicas as (
      select distinct on (v.email) v.email, v.por_area
      from validas v
      where v.email is not null
        and v.email <> lower(coalesce(new.autor_email, ''))
      order by v.email, (v.por_area is not null)
    ),
    -- Un CTE que escribe corre completo aunque nadie lea su resultado.
    guardadas as (
      insert into chat_menciones (record_id, email, por_area, mensaje_id, mencionado_por)
      select new.record_id, u.email, u.por_area, new.id, lower(new.autor_email)
      from unicas u
      on conflict (record_id, email) do nothing
    ),
    avisos as (
      insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      select new.record_id, u.email, 'chat',
             'Nuevo mensaje en '||coalesce(inc.folio,'')||': 📣 '||
             case when u.por_area is null then 'Te mencionaron'
                  else 'Mencionaron a '||u.por_area end||
             ' — '||left(coalesce(new.texto,''),70),
             inc.unidad_negocio
      from unicas u
      returning para_email
    )
    select coalesce(array_agg(para_email), '{}') into mencionados
    from avisos;
  end if;

  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  select new.record_id, r.e, 'chat', msg, inc.unidad_negocio
  from (
    select distinct lower(x) e from (
      select inc.captured_by            as x
      union all select inc.asignado_tecnico_email
      -- Los participantes del hilo: quien ya escribió aquí espera la
      -- respuesta, sea cual sea su rol.
      union all select m.autor_email
                from mensajes m
                where m.record_id = new.record_id
      -- Quien fue mencionado antes en este folio (4-nov-2026).
      union all select cm.email
                from chat_menciones cm
                where cm.record_id = new.record_id
      -- Los técnicos del área efectiva.
      -- CAMBIO (4-nov-2026): igualdad sin mayúsculas, no ilike (patrón).
      union all select ur.usuario_email
                from usuario_roles ur
                where ur.rol = 'reparacion'
                  and (ur.unidad_negocio is null
                       or inc.unidad_negocio is null
                       or lower(ur.unidad_negocio) = lower(inc.unidad_negocio))
                  and (ur.departamento is null
                       or lower(ur.departamento) = lower(coalesce(inc.assigned_area, inc.area_responsable)))
      -- El validador, SOLO mientras la incidencia está en su cancha.
      union all select ur.usuario_email
                from usuario_roles ur
                where ur.rol = 'validador'
                  and (inc.estatus in ('por_validar', 'reparado')
                       or coalesce(inc.reasignacion_pendiente, false))
                  and (ur.unidad_negocio is null
                       or inc.unidad_negocio is null
                       or lower(ur.unidad_negocio) = lower(inc.unidad_negocio))
                  and (ur.medio is null
                       or inc.medio is null
                       or lower(ur.medio) = lower(inc.medio))
    ) s where x is not null
  ) r
  where r.e <> lower(coalesce(new.autor_email, ''))
    -- Ya les llegó el aviso de la mención: no dos por el mismo mensaje.
    and r.e <> all (mencionados);
  return new;
end
$function$;
