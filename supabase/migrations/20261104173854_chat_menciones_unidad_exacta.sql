-- ============================================================
-- 4-nov-2026 · Incidencias (chat)
-- Qué: las menciones con @ comparan la unidad por igualdad, no con ilike, y
--      un folio sin unidad no admite menciones.
-- Por qué: revisión de seguridad del commit 83adcba (chat_menciones). La
--      unidad de la incidencia se usaba como PATRÓN (`ur.unidad_negocio ilike
--      inc.unidad_negocio`), y la base no impide crear desde la API un folio
--      con unidad "%" o vacía. En ese folio, quien lo capturó podía mencionar
--      a usuarios de cualquier unidad (push y acceso a ese folio) y la lista
--      del @ le enseñaba el rol y el área de todos. Con los datos reales
--      ("Biobox", "Vía Verde", "Ecovallas" en roles e incidencias) la igualdad
--      sin mayúsculas da exactamente lo mismo que antes.
-- Qué NO cambia: los usuarios sin unidad (manager y roles "todas") se siguen
--      pudiendo mencionar y siguen pidiendo la lista en cualquier folio; el
--      aviso normal del chat (sin mención) queda igual que antes.
-- Re-ejecutable.
-- ============================================================

-- 1) La lista del @. Igual que en 20261104162839_chat_menciones, salvo:
--    - folio sin unidad: no hay lista;
--    - unidad por igualdad (sin mayúsculas) en vez de ilike.
create or replace function public.chat_mencionables(p_record_id text)
returns table (tipo text, clave text, nombre text, detalle text)
language sql
stable
security definer
set search_path = public
as $$
  with inc as (
    select i.unidad_negocio
    from incidencias i
    where i.record_id = p_record_id
      and (select auth_email()) is not null
      and nullif(trim(i.unidad_negocio), '') is not null
      and (
        exists (
          select 1 from usuario_roles yo
          where lower(yo.usuario_email) = lower((select auth_email()))
            and (yo.unidad_negocio is null
                 or lower(yo.unidad_negocio) = lower(i.unidad_negocio))
        )
        or lower(i.captured_by) = lower((select auth_email()))
        or exists (
          select 1 from chat_menciones cm
          where cm.record_id = i.record_id
            and cm.email = lower((select auth_email()))
        )
      )
  ),
  roles as (
    select lower(ur.usuario_email) as email, ur.rol, ur.departamento
    from usuario_roles ur, inc
    where ur.rol <> 'viewer'::app_role
      and (ur.unidad_negocio is null
           or lower(ur.unidad_negocio) = lower(inc.unidad_negocio))
  )
  select 'persona'::text,
         r.email,
         coalesce(max(nullif(trim(u.nombre), '')), r.email),
         string_agg(distinct coalesce(nullif(trim(r.departamento), ''), r.rol::text), ', ')
  from roles r
  left join usuarios u on lower(u.email) = r.email
  group by r.email
  union all
  select 'area'::text,
         trim(r.departamento),
         trim(r.departamento),
         count(distinct r.email)::text
  from roles r
  where r.rol = 'reparacion'::app_role
    and nullif(trim(r.departamento), '') is not null
  group by trim(r.departamento);
$$;

revoke execute on function public.chat_mencionables(text) from public, anon;
grant execute on function public.chat_mencionables(text) to authenticated;

-- 2) El aviso. Igual que en 20261104162839_chat_menciones, salvo que el
--    bloque de menciones solo corre si el folio tiene unidad, y la compara
--    por igualdad. Lo de abajo (aviso normal) no cambia ni una línea.
create or replace function public.notificar_chat()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
      union all select ur.usuario_email
                from usuario_roles ur
                where ur.rol = 'reparacion'
                  and (ur.unidad_negocio is null
                       or inc.unidad_negocio is null
                       or ur.unidad_negocio ilike inc.unidad_negocio)
                  and (ur.departamento is null
                       or ur.departamento ilike coalesce(inc.assigned_area, inc.area_responsable))
      -- El validador, SOLO mientras la incidencia está en su cancha.
      union all select ur.usuario_email
                from usuario_roles ur
                where ur.rol = 'validador'
                  and (inc.estatus in ('por_validar', 'reparado')
                       or coalesce(inc.reasignacion_pendiente, false))
                  and (ur.unidad_negocio is null
                       or inc.unidad_negocio is null
                       or ur.unidad_negocio ilike inc.unidad_negocio)
                  and (ur.medio is null
                       or inc.medio is null
                       or ur.medio ilike inc.medio)
    ) s where x is not null
  ) r
  where r.e <> lower(coalesce(new.autor_email, ''))
    -- Ya les llegó el aviso de la mención: no dos por el mismo mensaje.
    and r.e <> all (mencionados);
  return new;
end
$$;
