-- ============================================================
-- apoyo_reparacion_op_biobox — 29-oct-2026 · Incidencias (reparación)
--
-- Qué hace: al reparar una incidencia de Op. Bio Box en la unidad Biobox, el
-- técnico puede registrar a UN técnico de Op. Bio Box que lo apoyó. Quien
-- apoyó recibe un aviso y cuenta en Indicadores («Quién apoya más»).
--
-- Decisiones de Erik (29-oct-2026): solo Op. Bio Box de Biobox (no Biobox
-- Perú ni otras áreas), opcional, uno solo, tarjeta aparte en Indicadores
-- («Quién repara más» no cambia) y aviso al que apoyó.
--
-- Piezas:
--   1. Columna incidencias.apoyo_reparacion_email (correo en minúsculas).
--   2. inc_blindaje_reparacion: la columna es parte de la reparación; solo
--      el técnico del área (o el manager) la escribe. Mismo cuerpo que en
--      producción + una línea.
--   3. inc_valida_apoyo (BEFORE): si el correo no es de un técnico de Op.
--      Bio Box de Biobox, si es el mismo que reparó o si la incidencia no es
--      de Op. Bio Box de Biobox, la columna queda en null. No rechaza la
--      fila: una lista vieja en un teléfono sin señal no debe tumbar la
--      reparación entera, que es lo importante. Tampoco hay aviso a un
--      correo cualquiera.
--   4. tecnicos_apoyo_op_biobox(): la lista para la ventana. Un técnico no
--      puede leer los roles de los demás (ur_self_read), así que va en una
--      función security definer que devuelve solo correo y nombre, y solo a
--      técnicos de Op. Bio Box de Biobox o al manager.
--   5. notificar_apoyo_reparacion (AFTER): aviso 'apoyo_reparacion' al que
--      apoyó cuando la reparación se registra (o cambia quién apoyó).
-- Re-ejecutable.
-- ============================================================

-- 1) Columna -------------------------------------------------
alter table public.incidencias
  add column if not exists apoyo_reparacion_email text;

comment on column public.incidencias.apoyo_reparacion_email is
  'Técnico de Op. Bio Box (Biobox) que apoyó la reparación, en minúsculas. Lo valida inc_valida_apoyo (29-oct-2026).';

-- 2) Blindaje: la columna nueva cuenta como parte de la reparación ---------
create or replace function public.inc_blindaje_reparacion()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  em text := lower(coalesce(auth_email(), ''));
begin
  if em = '' then
    return new;
  end if;

  if not (
       (new.estatus = 'reparado' and old.estatus is distinct from 'reparado')
    or new.diagnostico         is distinct from old.diagnostico
    or new.detalle_reparacion  is distinct from old.detalle_reparacion
    or new.causa_raiz          is distinct from old.causa_raiz
    or new.solucion            is distinct from old.solucion
    or new.incidencia_srd      is distinct from old.incidencia_srd
    or new.arbol_digital_id    is distinct from old.arbol_digital_id
    or new.repaired_by_email   is distinct from old.repaired_by_email
    or new.repaired_at         is distinct from old.repaired_at
    or new.fecha_reparacion    is distinct from old.fecha_reparacion
    -- Historial del equipo cambiado (15-oct-2026): parte de la reparación.
    or new.cambio_equipo       is distinct from old.cambio_equipo
    -- Técnico que apoyó (Op. Bio Box, 29-oct-2026): parte de la reparación.
    or new.apoyo_reparacion_email is distinct from old.apoyo_reparacion_email
  ) then
    return new;
  end if;

  if exists (
    select 1 from usuario_roles ur
    where lower(ur.usuario_email) = em
      and (
        ur.rol = 'manager'
        or (
          ur.rol = 'reparacion'
          and ur.departamento is not null
          and (ur.departamento = old.area_responsable or ur.departamento = old.assigned_area)
          and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(old.unidad_negocio))
        )
      )
  ) then
    return new;
  end if;

  raise exception 'Solo el técnico del área % puede registrar la reparación de %',
    coalesce(old.area_responsable, '(sin área)'), coalesce(old.folio, old.record_id)
    using errcode = '42501';
end $function$;

-- 3) Validación del técnico que apoyó ----------------------------------------
-- ¿Ese correo es de un técnico de Op. Bio Box de la unidad Biobox? Unidad
-- vacía en el rol = todas (regla de la casa). Departamento con el nombre
-- EXACTO del catálogo, como el blindaje.
create or replace function public.es_tecnico_op_biobox(p_email text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from usuario_roles ur
    where lower(btrim(ur.usuario_email)) = lower(btrim(coalesce(p_email, '')))
      and ur.rol = 'reparacion'::app_role
      and ur.departamento = 'Op. Bio Box'
      and (ur.unidad_negocio is null or lower(btrim(ur.unidad_negocio)) = 'biobox')
  );
$function$;

revoke all on function public.es_tecnico_op_biobox(text) from public, anon, authenticated;

create or replace function public.inc_valida_apoyo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Al capturar no hay reparación: nunca nace con apoyo.
  if tg_op = 'INSERT' then
    new.apoyo_reparacion_email := null;
    return new;
  end if;

  -- Se revisa cuando cambia quién apoyó o quién reparó (que no queden en la
  -- misma persona). No en cada update: si al que apoyó le cambian el rol
  -- después, el registro de esa reparación se queda (revisor-rls).
  if new.apoyo_reparacion_email is null
     or (new.apoyo_reparacion_email is not distinct from old.apoyo_reparacion_email
         and new.repaired_by_email is not distinct from old.repaired_by_email) then
    return new;
  end if;

  new.apoyo_reparacion_email := nullif(lower(btrim(new.apoyo_reparacion_email)), '');

  if new.apoyo_reparacion_email is not null and (
       lower(btrim(coalesce(new.unidad_negocio, ''))) <> 'biobox'
    or coalesce(new.assigned_area, new.area_responsable) is distinct from 'Op. Bio Box'
    or new.apoyo_reparacion_email = lower(btrim(coalesce(new.repaired_by_email, '')))
    or not es_tecnico_op_biobox(new.apoyo_reparacion_email)
  ) then
    new.apoyo_reparacion_email := null;
  end if;

  return new;
end $function$;

drop trigger if exists inc_valida_apoyo on public.incidencias;
create trigger inc_valida_apoyo
  before insert or update on public.incidencias
  for each row execute function inc_valida_apoyo();

-- 4) Lista para la ventana «¿Te apoyó algún técnico?» -------------------------
create or replace function public.tecnicos_apoyo_op_biobox()
returns table (email text, nombre text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select distinct on (lower(btrim(ur.usuario_email)))
         lower(btrim(ur.usuario_email)) as email,
         coalesce(nullif(btrim(u.nombre), ''), split_part(lower(btrim(ur.usuario_email)), '@', 1)) as nombre
    from usuario_roles ur
    left join usuarios u on lower(btrim(u.email)) = lower(btrim(ur.usuario_email))
   where ur.rol = 'reparacion'::app_role
     and ur.departamento = 'Op. Bio Box'
     and (ur.unidad_negocio is null or lower(btrim(ur.unidad_negocio)) = 'biobox')
     and (tiene_rol('manager'::app_role) or es_tecnico_op_biobox(auth_email()))
   order by lower(btrim(ur.usuario_email));
$function$;

revoke all on function public.tecnicos_apoyo_op_biobox() from public, anon;
grant execute on function public.tecnicos_apoyo_op_biobox() to authenticated;

-- 5) Aviso al que apoyó ----------------------------------------------------
-- Sale cuando la reparación queda registrada con apoyo: al pasar a
-- 'reparado' (también la reparación nueva tras un rechazo), o si estando
-- reparada cambia quién apoyó. inc_valida_apoyo ya corrió (BEFORE), así
-- que el correo es de un técnico válido y no es el que reparó.
create or replace function public.notificar_apoyo_reparacion()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  quien text;
begin
  if new.estatus = 'reparado'
     and new.apoyo_reparacion_email is not null
     and (old.estatus is distinct from 'reparado'
          or new.apoyo_reparacion_email is distinct from old.apoyo_reparacion_email) then

    select coalesce(nullif(btrim(u.nombre), ''), split_part(lower(new.repaired_by_email), '@', 1))
      into quien
      from (select 1) x
      left join usuarios u on lower(btrim(u.email)) = lower(btrim(new.repaired_by_email))
     limit 1;

    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
    values (
      new.record_id,
      new.apoyo_reparacion_email,
      'apoyo_reparacion',
      'Te registraron como apoyo en la reparación de ' || coalesce(new.folio, '') ||
        ' · ' || coalesce(new.nombre_incidencia, '') ||
        coalesce(', con ' || nullif(quien, ''), ''),
      new.unidad_negocio
    );
  end if;
  return new;
end $function$;

drop trigger if exists trg_notificar_apoyo_reparacion on public.incidencias;
create trigger trg_notificar_apoyo_reparacion
  after update on public.incidencias
  for each row execute function notificar_apoyo_reparacion();
