-- ============================================================
-- avisos_medio_y_area — dos correcciones a los avisos de Incidencias
-- (Erik, 8-oct-2026). Re-ejecutable, en un solo bloque transaccional.
--
-- 1) EL MEDIO DEL VALIDADOR. destinatarios_notif no miraba usuario_roles.medio:
--    un validador de solo Impreso recibía el aviso (campana y push) de las
--    capturas, reparaciones, reenvíos y solicitudes de reasignación de
--    Digital, que luego no podía abrir porque la RLS sí filtra por medio.
--    Ahora destinatarios_notif recibe un cuarto parámetro opcional, p_medio,
--    con la misma regla que la RLS y que el chat: medio vacío (en el rol o
--    en la incidencia) = ambos. Si ningún validador cubre ese medio, sigue
--    la cascada de siempre: coordinadores de la unidad → managers.
--    La firma de 3 parámetros se quita y la nueva trae p_medio por omisión
--    null: cualquier llamada de 3 argumentos sigue funcionando igual.
--
-- 2) AVISOS DE ÁREA SIN TÉCNICO. notificar_area_asignada y
--    notificar_reasignacion_aprobada, si nadie tenía el área, avisaban a
--    TODOS los técnicos de la unidad, que tampoco la pueden abrir (la RLS
--    filtra por área). Ahora usan destinatarios_notif, como los demás
--    avisos: técnicos del área → coordinadores de la unidad → managers.
--
-- De paso, notificar_area_asignada, notificar_reasignacion_aprobada,
-- notificar_chat y notificar_push quedan con search_path fijo (lo marcaba
-- el asesor de Supabase en funciones security definer). No cambia lo que
-- hacen: todo lo que usan está en public o va con su esquema.
--
-- Nada más cambia: mensajes, eventos y quién recibe cada aviso cuando sí
-- hay alguien del rol/área/medio quedan igual. La foto de los avisos
-- (supabase/referencia/avisos_incidencias.sql) se actualiza en el mismo
-- commit.
-- ============================================================

-- ── 1. destinatarios_notif con medio ────────────────────────────────────
drop function if exists public.destinatarios_notif(app_role, text, text);

create or replace function public.destinatarios_notif(
  p_rol app_role,
  p_unidad text,
  p_area text,
  p_medio text default null
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
  select array_agg(distinct lower(ur.usuario_email)) into v
  from usuario_roles ur
  where ur.rol = p_rol
    and (ur.unidad_negocio is null or ur.unidad_negocio ilike p_unidad)
    and (p_area is null
         or ur.departamento is null
         or ur.departamento ilike p_area)
    and (p_medio is null
         or ur.medio is null
         or ur.medio ilike p_medio);

  -- 2) Respaldo: coordinadores de la unidad.
  if v is null or array_length(v, 1) is null then
    select array_agg(distinct lower(ur.usuario_email)) into v
    from usuario_roles ur
    where ur.rol = 'coordinador'::app_role
      and (ur.unidad_negocio is null or ur.unidad_negocio ilike p_unidad);
  end if;

  -- 3) Última red: managers.
  if v is null or array_length(v, 1) is null then
    select array_agg(distinct lower(ur.usuario_email)) into v
    from usuario_roles ur
    where ur.rol = 'manager'::app_role;
  end if;

  return query select unnest(coalesce(v, '{}'::text[]));
end $function$;

-- ── 1b. notificar_incidencia: los avisos al validador llevan el medio ───
create or replace function public.notificar_incidencia()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare msg text;
begin
  if TG_OP = 'INSERT' then
    if new.estatus = 'por_validar' then
      msg := 'Nueva incidencia por validar: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'')||' ('||coalesce(new.unidad_negocio,'')||')';
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'captura', msg, new.unidad_negocio
        from destinatarios_notif('validador'::app_role, new.unidad_negocio, null, new.medio) d;

    elsif new.estatus = 'en_proceso' then
      msg := 'Incidencia directa a tu área ('||coalesce(new.area_responsable,'')||') para prevalidar y reparar: '||coalesce(new.folio,'');
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'asignacion', msg, new.unidad_negocio
        from destinatarios_notif('reparacion'::app_role, new.unidad_negocio, new.area_responsable) d;
    end if;
    return new;
  end if;

  if new.estatus is distinct from old.estatus then
    if new.estatus = 'en_proceso' then
      msg := 'Incidencia asignada al área '||coalesce(new.area_responsable,'')||': '||coalesce(new.folio,'');
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'asignacion', msg, new.unidad_negocio
        from destinatarios_notif('reparacion'::app_role, new.unidad_negocio, new.area_responsable) d;

      -- si viene de 'reparado', es un rechazo de reparación -> avisar al reportante
      if old.estatus = 'reparado' and new.captured_by is not null then
        insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        values (new.record_id, lower(new.captured_by), 'reabierta',
          'La reparación de tu incidencia fue rechazada y regresó al área para corregirse: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,''),
          new.unidad_negocio);
      end if;

    elsif new.estatus = 'reparado' then
      msg := 'Reparación por aprobar: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'');
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'reparado', msg, new.unidad_negocio
        from destinatarios_notif('validador'::app_role, new.unidad_negocio, null, new.medio) d;

      -- avisar al reportante que su incidencia fue reparada (en revisión)
      if new.captured_by is not null then
        insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        values (new.record_id, lower(new.captured_by), 'reparado_reportante',
          'Tu incidencia fue reparada y está en revisión: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,''),
          new.unidad_negocio);
      end if;

    elsif new.estatus = 'cerrada' then
      if new.captured_by is not null then
        msg := 'Tu incidencia fue cerrada: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'');
        insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
          values (new.record_id, lower(new.captured_by), 'cierre', msg, new.unidad_negocio);
      end if;

    -- El rechazo del validador: el reportante es el único que puede
    -- arreglarlo, así que es el único a quien tiene sentido avisarle.
    elsif new.estatus = 'rechazada' then
      if new.captured_by is not null then
        msg := 'Tu incidencia fue rechazada: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'')
               ||coalesce(' · Motivo: '||nullif(btrim(new.motivo_rechazo_reparacion),''), '');
        insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
          values (new.record_id, lower(new.captured_by), 'rechazada', msg, new.unidad_negocio);
      end if;

    -- El reenvío tras corregir. Solo cuando VIENE de 'rechazada': si llegara
    -- a `por_validar` desde otro lado sería una corrección administrativa, y
    -- avisar ahí solo sumaría ruido a la campana.
    elsif new.estatus = 'por_validar' and old.estatus = 'rechazada' then
      msg := 'Incidencia corregida y reenviada a validar: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'')||' ('||coalesce(new.unidad_negocio,'')||')';
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'captura', msg, new.unidad_negocio
        from destinatarios_notif('validador'::app_role, new.unidad_negocio, null, new.medio) d;
    end if;
  end if;
  return new;
end $function$;

-- ── 1c. notificar_reasignacion: la solicitud va a validadores del medio ──
create or replace function public.notificar_reasignacion()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare msg text; v_medio text;
begin
  -- ── Solicitud nueva → validadores de la unidad (y del medio) ──
  if TG_OP = 'INSERT' and new.estado = 'Solicitada' then
    -- La solicitud no guarda el medio: se toma de su incidencia.
    select i.medio into v_medio from incidencias i where i.record_id = new.record_id;
    msg := 'Solicitud de reasignación: '||coalesce(new.folio, new.record_id)
         ||' · '||coalesce(new.area_origen, '—')||' → '||coalesce(new.area_destino, '—')
         ||coalesce(' · Motivo: '||nullif(btrim(new.motivo), ''), '');
    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      select new.record_id, d, 'reasignacion', msg, new.unidad_negocio
      from destinatarios_notif('validador'::app_role, new.unidad_negocio, null, v_medio) d
      -- Que el propio solicitante no reciba el aviso de su solicitud: pasa
      -- cuando quien pide es manager y la cascada lo alcanza.
      where lower(d) is distinct from lower(coalesce(new.solicitado_por, ''));
    return new;
  end if;

  -- ── Resolución → el solicitante ──
  if TG_OP = 'UPDATE'
     and new.estado is distinct from old.estado
     and new.estado in ('Aprobada', 'Rechazada')
     and new.solicitado_por is not null
  then
    msg := case when new.estado = 'Aprobada'
             then 'Tu reasignación fue APROBADA: '||coalesce(new.folio, new.record_id)
                ||' pasa a '||coalesce(new.area_destino, '—')
             else 'Tu reasignación fue RECHAZADA: '||coalesce(new.folio, new.record_id)
                ||' se queda en '||coalesce(new.area_origen, '—')
           end
         ||coalesce(' · '||nullif(btrim(new.comentario), ''), '');
    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      values (new.record_id, lower(new.solicitado_por), 'reasignacion',
              msg, new.unidad_negocio);
  end if;
  return new;
end $function$;

-- ── 2a. notificar_area_asignada: sin técnico del área → cascada ─────────
create or replace function public.notificar_area_asignada()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  msg text;
begin
  if new.assigned_area is distinct from old.assigned_area
     and new.assigned_area is not null then

    msg := 'Incidencia dirigida a tu área (' || new.assigned_area ||
           ') para reparar: ' || coalesce(new.folio, '') || ' · ' ||
           coalesce(new.nombre_incidencia, '');

    -- Técnicos del área; si no hay, coordinadores de la unidad y después
    -- managers (antes: todos los técnicos de la unidad, que no la pueden
    -- abrir porque la RLS filtra por área).
    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      select new.record_id, d, 'asignacion_area', msg, new.unidad_negocio
      from destinatarios_notif('reparacion'::app_role, new.unidad_negocio, new.assigned_area) d;

    if new.asignado_tecnico_email is not null then
      insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      values (new.record_id, lower(new.asignado_tecnico_email), 'asignacion_area',
              msg, new.unidad_negocio)
      on conflict do nothing;
    end if;

  end if;
  return new;
end
$function$;

-- ── 2b. notificar_reasignacion_aprobada: sin técnico del área → cascada ──
-- Es BEFORE UPDATE porque además rellena `reasignada_de`.
create or replace function public.notificar_reasignacion_aprobada()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  msg text;
begin
  if coalesce(old.reasignacion_pendiente, false)
     and not coalesce(new.reasignacion_pendiente, false)
     and new.area_responsable is distinct from old.area_responsable
     and new.area_responsable is not null then

    if new.reasignada_de is null then
      new.reasignada_de := old.area_responsable;
    end if;

    msg := 'Incidencia reasignada a tu área (' || new.area_responsable ||
           '), antes de ' || coalesce(old.area_responsable, '—') || ': ' ||
           coalesce(new.folio, '') || ' · ' ||
           coalesce(new.nombre_incidencia, '');

    -- Técnicos del área nueva; si no hay, coordinadores y después managers.
    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      select new.record_id, d, 'reasignacion', msg, new.unidad_negocio
      from destinatarios_notif('reparacion'::app_role, new.unidad_negocio, new.area_responsable) d;

  end if;
  return new;
end
$function$;

-- ── De paso: search_path fijo en las dos que quedan ─────────────────────
alter function public.notificar_chat() set search_path to 'public';
alter function public.notificar_push() set search_path to 'public';

-- Verificar: 7 filas, todas con search_path=public; destinatarios_notif con 4 parámetros.
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proconfig
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('destinatarios_notif', 'notificar_incidencia', 'notificar_reasignacion',
                    'notificar_area_asignada', 'notificar_reasignacion_aprobada',
                    'notificar_chat', 'notificar_push')
order by 1;
