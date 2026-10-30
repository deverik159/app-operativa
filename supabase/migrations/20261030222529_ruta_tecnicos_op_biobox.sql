-- ============================================================
-- Técnico de Op. Bio Box por ruta + aviso de incidencias de su máquina
-- (Erik, 30-oct-2026)
--
-- Las rutas de Biobox ya llevan el nombre del técnico («Ruta Kevin»), pero
-- asignarlo como monitorista lo metía en Mis rutas y Pauta, que son de otra
-- área. Aquí la ruta se le asigna como TÉCNICO, aparte de los monitoristas:
--
--   1. ruta_tecnicos (ruta, correo): solo rutas de Biobox y solo técnicos
--      (rol reparacion, área Op. Bio Box) de esa unidad. Asignan el
--      coordinador de la unidad y el manager. Varios por ruta.
--   2. Aviso al técnico al asignarle o quitarle la ruta (evento ruta_tecnico).
--   3. Cuando una incidencia de una máquina Biobox queda en proceso con
--      Digital o TI, se avisa a los técnicos de la ruta de esa máquina
--      (evento maquina_incidencia) para que pase a revisarla. Si la máquina
--      no está en una ruta con técnico, a los coordinadores de Op. Bio Box de
--      la unidad. El aviso va sin record_id: el técnico no puede abrir una
--      incidencia de otra área; la ve en Máquinas Biobox (estado_maquina).
-- ============================================================

-- ── Quién puede asignar: manager, o coordinador de la unidad de la ruta ──
create or replace function public.ruta_tecnico_puede_editar(p_ruta_id bigint) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select tiene_rol('manager'::app_role) or exists (
    select 1
      from rutas_monitoreo r
      join usuario_roles ur on lower(btrim(ur.usuario_email)) = lower(auth_email())
     where r.id = p_ruta_id
       and ur.rol = 'coordinador'::app_role
       and (nullif(btrim(ur.unidad_negocio), '') is null
            or lower(btrim(ur.unidad_negocio)) = lower(btrim(r.unidad_negocio)))
       -- El coordinador de Op. Bio Box (o sin área), no el de Digital.
       and (nullif(btrim(ur.departamento), '') is null or btrim(ur.departamento) ilike 'op. bio box')
  )
$$;
revoke all on function public.ruta_tecnico_puede_editar(bigint) from public, anon;
grant execute on function public.ruta_tecnico_puede_editar(bigint) to authenticated;

-- ── 1. La tabla ──
create table public.ruta_tecnicos (
  id bigserial primary key,
  ruta_id bigint not null references public.rutas_monitoreo(id) on delete cascade,
  usuario_email text not null,
  asignado_por text,
  creado_en timestamptz not null default now(),
  constraint ruta_tecnicos_unico unique (ruta_id, usuario_email)
);
create index ruta_tecnicos_usuario on public.ruta_tecnicos (usuario_email);

alter table public.ruta_tecnicos enable row level security;
revoke all on table public.ruta_tecnicos from public, anon, authenticated;
grant select, delete on table public.ruta_tecnicos to authenticated;
-- Ni id ni asignado_por ni creado_en desde la app: los pone la base.
grant insert (ruta_id, usuario_email) on table public.ruta_tecnicos to authenticated;
revoke all on sequence public.ruta_tecnicos_id_seq from public, anon, authenticated;
grant usage on sequence public.ruta_tecnicos_id_seq to authenticated;

-- Leer, como ruta_asignaciones: cualquiera con sesión (Máquinas Biobox
-- necesita saber qué rutas son del técnico).
create policy rtec_sel on public.ruta_tecnicos for select to authenticated using (true);
create policy rtec_ins on public.ruta_tecnicos for insert to authenticated
  with check (ruta_tecnico_puede_editar(ruta_id));
create policy rtec_del on public.ruta_tecnicos for delete to authenticated
  using (ruta_tecnico_puede_editar(ruta_id));

-- Validación. Los BEFORE corren antes del WITH CHECK: quien no puede editar
-- pasa de largo y la política lo rechaza sin decirle nada de la persona
-- (misma lección que ruta_asig_valida_unidad, 5-oct-2026).
create or replace function public.ruta_tecnico_valida() returns trigger
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_email text := lower(btrim(coalesce(new.usuario_email, '')));
  v_unidad text;
begin
  if auth_email() is not null and not ruta_tecnico_puede_editar(new.ruta_id) then
    return new;
  end if;
  new.usuario_email := v_email;
  new.asignado_por := lower(auth_email());
  new.creado_en := now();
  if v_email = '' then
    raise exception 'Falta el correo del técnico.' using errcode = 'check_violation';
  end if;
  select r.unidad_negocio into v_unidad from rutas_monitoreo r where r.id = new.ruta_id;
  if v_unidad is null or btrim(v_unidad) !~* '^biobox' then
    raise exception 'Solo las rutas de Biobox llevan técnico de Op. Bio Box.' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from usuario_roles ur
     where lower(btrim(ur.usuario_email)) = v_email
       and ur.rol = 'reparacion'::app_role
       and btrim(ur.departamento) ilike 'op. bio box'
       and (nullif(btrim(ur.unidad_negocio), '') is null
            or lower(btrim(ur.unidad_negocio)) = lower(btrim(v_unidad)))
  ) then
    raise exception 'Esa persona no es técnico de Op. Bio Box de %.', v_unidad using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke all on function public.ruta_tecnico_valida() from public, anon, authenticated;
create trigger trg_ruta_tecnico_valida before insert on public.ruta_tecnicos
  for each row execute function public.ruta_tecnico_valida();

-- Quiénes se pueden asignar a una ruta (para la pestaña de Rutas).
create or replace function public.tecnicos_asignables_ruta(p_ruta_id bigint)
returns table(email text, nombre text)
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select s.correo,
         coalesce((select max(nullif(btrim(u.nombre), '')) from usuarios u where lower(btrim(u.email)) = s.correo),
                  split_part(s.correo, '@', 1)) as nombre
    from (
      select distinct lower(btrim(ur.usuario_email)) as correo
        from usuario_roles ur
        join rutas_monitoreo r on r.id = p_ruta_id
       where ruta_tecnico_puede_editar(p_ruta_id)
         and ur.rol = 'reparacion'::app_role
         and btrim(ur.departamento) ilike 'op. bio box'
         and nullif(btrim(ur.usuario_email), '') is not null
         and (nullif(btrim(ur.unidad_negocio), '') is null
              or lower(btrim(ur.unidad_negocio)) = lower(btrim(r.unidad_negocio)))
    ) s
   order by 2, 1
$$;
revoke all on function public.tecnicos_asignables_ruta(bigint) from public, anon;
grant execute on function public.tecnicos_asignables_ruta(bigint) to authenticated;

-- ── 2. Aviso al asignar o quitar ──
create or replace function public.notificar_ruta_tecnico() returns trigger
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  r record;
  v_email text := lower(coalesce(new.usuario_email, old.usuario_email));
  msg text;
begin
  select numero, nombre, unidad_negocio into r
    from rutas_monitoreo where id = coalesce(new.ruta_id, old.ruta_id);
  if not found then return coalesce(new, old); end if;
  -- Sin número cuando hay nombre: las gemelas Digital/Impreso tienen el mismo
  -- nombre pero a veces distinto número, y así salen con el mismo texto.
  msg := case when tg_op = 'INSERT' then 'Se te asignó ' else 'Se te retiró ' end
         || coalesce(nullif(btrim(r.nombre), ''), 'la ruta ' || r.numero)
         || case when tg_op = 'INSERT'
                 then ' como técnico de Op. Bio Box. Sus máquinas te salen primero en Máquinas Biobox.'
                 else ' como técnico de Op. Bio Box.' end;
  -- La ruta Digital y su gemela Impreso se asignan juntas: un solo aviso.
  if not exists (
    select 1 from notificaciones n
     where lower(n.para_email) = v_email and n.evento = 'ruta_tecnico'
       and n.mensaje = msg and n.creado_en > now() - interval '30 seconds'
  ) then
    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
    values (null, v_email, 'ruta_tecnico', msg, r.unidad_negocio);
  end if;
  return coalesce(new, old);
end
$$;
revoke all on function public.notificar_ruta_tecnico() from public, anon, authenticated;
create trigger trg_notificar_ruta_tecnico after insert or delete on public.ruta_tecnicos
  for each row execute function public.notificar_ruta_tecnico();

-- ── 3. Incidencia de una máquina Biobox con Digital o TI → técnico de la ruta ──
create or replace function public.notificar_maquina_otra_area() returns trigger
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_area text := btrim(coalesce(new.assigned_area, new.area_responsable, ''));
  v_para text[];
  v_rutas text;
  v_msg text;
begin
  if coalesce(btrim(new.unidad_negocio), '') !~* '^biobox' then return new; end if;
  if new.estatus is distinct from 'en_proceso' then return new; end if;
  if lower(v_area) not in ('digital', 'ti') then return new; end if;
  if nullif(btrim(new.clave_sitio), '') is null then return new; end if;
  -- Solo al llegar a en_proceso con esa área, no en cada cambio de la fila.
  if tg_op = 'UPDATE' and old.estatus = 'en_proceso'
     and lower(btrim(coalesce(old.assigned_area, old.area_responsable, ''))) = lower(v_area) then
    return new;
  end if;

  select array_agg(distinct lower(rt.usuario_email)),
         string_agg(distinct coalesce(nullif(btrim(r.nombre), ''), 'Ruta ' || r.numero), ', ')
    into v_para, v_rutas
    from ruta_ubicaciones ru
    join rutas_monitoreo r on r.id = ru.ruta_id and r.activa
    join ruta_tecnicos rt on rt.ruta_id = ru.ruta_id
   where ru.site_id = new.clave_sitio
     -- Solo si sigue siendo técnico de Op. Bio Box de la unidad.
     and exists (
       select 1 from usuario_roles ur
        where lower(btrim(ur.usuario_email)) = rt.usuario_email
          and ur.rol = 'reparacion'::app_role
          and btrim(ur.departamento) ilike 'op. bio box'
          and (nullif(btrim(ur.unidad_negocio), '') is null
               or lower(btrim(ur.unidad_negocio)) = lower(btrim(new.unidad_negocio))))
     -- Quien también es técnico del área que la atiende ya recibe su aviso.
     and not exists (
       select 1 from usuario_roles ur
        where lower(btrim(ur.usuario_email)) = rt.usuario_email
          and ur.rol = 'reparacion'::app_role
          and (nullif(btrim(ur.departamento), '') is null or btrim(ur.departamento) ilike v_area));
  if v_para is null then
    -- Sin técnico de ruta: los coordinadores de Op. Bio Box de la unidad.
    v_rutas := null;
    select array_agg(distinct lower(ur.usuario_email)) into v_para
      from usuario_roles ur
     where ur.rol = 'coordinador'::app_role
       and lower(btrim(ur.unidad_negocio)) = lower(btrim(new.unidad_negocio))
       and (ur.departamento is null or btrim(ur.departamento) ilike 'op. bio box');
  end if;
  if v_para is null then return new; end if;

  -- «Incidencia en proceso» y no «Se levantó»: también avisa si regresa a
  -- proceso (reparación rechazada) o cambia de Digital a TI.
  v_msg := 'Incidencia ' || coalesce(new.folio, '') || ' · ' || coalesce(new.nombre_incidencia, '')
           || ' en ' || new.clave_sitio || coalesce(' (' || v_rutas || ')', '')
           || '. La atiende ' || v_area || '; pasa a revisar la máquina.';
  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  select null, e, 'maquina_incidencia', v_msg, new.unidad_negocio
    from unnest(v_para) as e
   where e is distinct from lower(auth_email());
  return new;
end
$$;
revoke all on function public.notificar_maquina_otra_area() from public, anon, authenticated;
create trigger trg_notificar_maquina_otra_area
  after insert or update of estatus, area_responsable, assigned_area on public.incidencias
  for each row execute function public.notificar_maquina_otra_area();

-- ══ Verificación (solo lectura) ══
-- select has_table_privilege('authenticated', 'public.ruta_tecnicos', 'insert');
-- select * from tecnicos_asignables_ruta(<id de una ruta Biobox>);
