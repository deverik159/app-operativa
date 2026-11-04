-- ============================================================
-- 4-nov-2026 · Incidencias (chat)
-- Qué: menciones con @ en el chat, como en Discord: a una persona (@Juan) o a
--      toda un área (@Digital, todos sus técnicos), de la misma unidad.
-- Por qué: feedback de los usuarios (Erik, 4-nov-2026). Una incidencia que
--      nadie atiende se mueve antes si se puede llamar a alguien de otra
--      área. Hasta hoy el chat solo avisaba a los de la incidencia (quien
--      reportó, el técnico asignado, los técnicos del área, quien ya escribió
--      y el validador en su cancha), y alguien de otra área no podía ni verla.
-- Cómo:
--   1) `mensajes.menciones` (jsonb): lo que el autor eligió en la lista del @.
--      Solo viaja cuando hay menciones; la base lo valida, no se confía en él.
--   2) `chat_menciones`: quién quedó mencionado en cada folio. Lo escribe solo
--      el trigger notificar_chat; el mencionado queda como participante del
--      hilo: ve el folio, escribe y recibe los mensajes hasta que se cierre
--      (igual que quien ya escribió, 30-oct-2026).
--   3) `chat_mencionables()`: la lista para elegir (personas y áreas de la
--      unidad de la incidencia). usuario_roles no se deja leer a cualquiera.
--   4) notificar_chat: el mencionado recibe "📣 Te mencionaron" en vez del
--      aviso normal; sigue siendo evento 'chat' (pestaña Mensajes, globito
--      del 💬, el push abre el chat) y no hay que redesplegar enviar-push.
-- Re-ejecutable.
-- ============================================================

-- 1) Lo que eligió el autor: [{"tipo":"persona","email":…,"nombre":…},
--    {"tipo":"area","area":…,"nombre":…}]. La app lo usa también para
--    resaltar los @ dentro de la burbuja.
alter table public.mensajes
  add column if not exists menciones jsonb;

-- 2) Quién quedó mencionado en cada folio (uno por persona y folio).
create table if not exists public.chat_menciones (
  id             bigserial primary key,
  record_id      text not null,
  email          text not null check (email = lower(email)),
  -- El área por la que llegó (@Digital); null = mención directa.
  por_area       text,
  -- El primer mensaje que lo mencionó en este folio. set null y no cascade:
  -- borrar ese mensaje no le quita el acceso al mencionado (revisor-rls).
  mensaje_id     bigint references public.mensajes(id) on delete set null,
  mencionado_por text,
  creado_en      timestamptz not null default now(),
  unique (record_id, email)
);
create index if not exists idx_chat_menciones_email
  on public.chat_menciones (email);

alter table public.chat_menciones enable row level security;

-- Leer, como mensajes (msg_sel). Escribir, solo el trigger (security definer).
drop policy if exists chat_menc_sel on public.chat_menciones;
create policy chat_menc_sel on public.chat_menciones
  for select
  to authenticated
  using ((select auth_email()) is not null);

revoke insert, update, delete, truncate on public.chat_menciones from anon, authenticated;
revoke all on public.chat_menciones from anon;
grant select on public.chat_menciones to authenticated;
revoke all on sequence public.chat_menciones_id_seq from anon, authenticated;

-- 3) Ver la incidencia: quien escribió en su chat O quien fue mencionado,
--    mientras no esté cerrada. Lo demás, igual que el 30-oct-2026.
drop policy if exists inc_sel_participante_chat on public.incidencias;
create policy inc_sel_participante_chat on public.incidencias
  for select
  to authenticated
  using (
    estatus not in ('cerrada'::estatus_incidencia, 'no_reparado'::estatus_incidencia)
    and exists (
      select 1
      from public.usuario_roles ur
      where lower(ur.usuario_email) = lower((select auth_email()))
    )
    and (
      exists (
        select 1
        from public.mensajes m
        where m.record_id = incidencias.record_id
          and lower(m.autor_email) = lower((select auth_email()))
      )
      or exists (
        select 1
        from public.chat_menciones cm
        where cm.record_id = incidencias.record_id
          and cm.email = lower((select auth_email()))
      )
    )
  );

-- 4) Escribir en el chat: las mismas reglas del 30-oct-2026, más el
--    mencionado en ese folio.
drop policy if exists msg_ins on public.mensajes;
create policy msg_ins on public.mensajes
  for insert
  to authenticated
  with check (
    lower(autor_email) = lower((select auth_email()))
    and exists (
      select 1
      from public.incidencias i
      where i.record_id = mensajes.record_id
        and i.estatus <> 'cerrada'::estatus_incidencia
        and (
          (select tiene_rol('manager'::app_role))
          or lower(i.captured_by) = lower((select auth_email()))
          or ((select tiene_rol('validador'::app_role))
              and i.unidad_negocio in (select mis_unidades()))
          or ((select tiene_rol('reparacion'::app_role))
              and (i.area_responsable in (select mis_departamentos())
                   or i.assigned_area in (select mis_departamentos())))
          or exists (
            select 1
            from public.mensajes previo
            where previo.record_id = i.record_id
              and lower(previo.autor_email) = lower((select auth_email()))
          )
          or exists (
            select 1
            from public.chat_menciones cm
            where cm.record_id = i.record_id
              and cm.email = lower((select auth_email()))
          )
        )
    )
  );

-- 5) La lista del @: personas con algún rol (menos Consulta) y áreas con
--    técnicos, de la unidad de la incidencia (o sin unidad, como el manager).
--    security definer porque usuario_roles solo se deja leer a uno mismo.
--    Por eso mismo no puede usar la RLS de incidencias del que llama: solo la
--    pide quien tiene un rol en esa unidad (o sin unidad), quien capturó el
--    folio o quien fue mencionado en él (revisor-rls y revisión de seguridad,
--    4-nov-2026). Sin eso, cualquiera veía qué rol y área tiene cada quien.
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
      and (
        exists (
          select 1 from usuario_roles yo
          where lower(yo.usuario_email) = lower((select auth_email()))
            and (yo.unidad_negocio is null
                 or i.unidad_negocio is null
                 or yo.unidad_negocio ilike i.unidad_negocio)
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
           or inc.unidad_negocio is null
           or ur.unidad_negocio ilike inc.unidad_negocio)
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

-- 6) El aviso. Igual que antes, más:
--    - las menciones del mensaje se validan aquí (misma unidad, rol vigente,
--      área con técnicos; máximo 20) y se guardan en chat_menciones;
--    - el mencionado recibe "📣 Te mencionaron" (o "a tu área") en lugar del
--      aviso normal de ese mensaje;
--    - los mencionados antes en el folio reciben los mensajes que sigan.
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

  -- Menciones de este mensaje (solo si la app las mandó).
  if jsonb_typeof(new.menciones) = 'array' then
    with pedidas as (
      select e->>'tipo' as tipo,
             lower(trim(e->>'email')) as email,
             trim(e->>'area') as area
      from jsonb_array_elements(new.menciones) with ordinality as x(e, n)
      where x.n <= 20
    ),
    validas as (
      -- @persona: con algún rol (menos Consulta) en la unidad.
      select p.email, null::text as por_area
      from pedidas p
      where p.tipo = 'persona'
        and exists (
          select 1 from usuario_roles ur
          where lower(ur.usuario_email) = p.email
            and ur.rol <> 'viewer'::app_role
            and (ur.unidad_negocio is null
                 or inc.unidad_negocio is null
                 or ur.unidad_negocio ilike inc.unidad_negocio)
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
            or inc.unidad_negocio is null
            or ur.unidad_negocio ilike inc.unidad_negocio)
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

-- 7) Al editar un mensaje (15 min) tampoco se mueven sus menciones: avisos y
--    acceso solo nacen al insertar, y el resaltado de la burbuja debe decir
--    a quién se avisó de verdad (revisor-rls). Cuerpo idéntico al de
--    producción (md5 sin CR 0277dbbe9dd0b63ceafd63f768a12880) más esa línea.
create or replace function public.msg_marca_edicion()
returns trigger
language plpgsql
as $$
begin
  if new.texto is distinct from old.texto then
    new.texto_original := coalesce(old.texto_original, old.texto);
    new.editado_en := now();
  else
    new.texto_original := old.texto_original;
    new.editado_en := old.editado_en;
  end if;
  -- Nada más se mueve: ni autor, ni fecha, ni de qué incidencia es.
  new.record_id := old.record_id;
  new.autor_email := old.autor_email;
  new.autor_nombre := old.autor_nombre;
  new.creado_en := old.creado_en;
  -- Ni a quién mencionó (4-nov-2026).
  new.menciones := old.menciones;
  -- Ni a qué mensaje responde… salvo el null de la llave foránea: su
  -- `on delete set null` llega como un UPDATE que también pasa por este
  -- trigger, y si se le regresara el id viejo la respuesta quedaría
  -- apuntando a un mensaje borrado (sin revisión posterior: la llave "no
  -- cambió"). Ese UPDATE corre DENTRO del trigger de la llave, así que aquí
  -- la profundidad es 2 o más; un PATCH directo por la API es 1 y no puede
  -- quitar la cita sin dejar rastro.
  if new.responde_a is not null or pg_trigger_depth() < 2 then
    new.responde_a := old.responde_a;
  end if;
  return new;
end
$$;
