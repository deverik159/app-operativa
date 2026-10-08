-- ============================================================
-- avisos_incidencias.sql — FOTO de los avisos de Incidencias tal como
-- están en producción al 8-oct-2026 (leídos con pg_get_functiondef),
-- actualizada con la migración 20261008224848_avisos_medio_y_area.
--
-- QUÉ ES: la copia en el repo de las funciones y triggers que llenan la
-- tabla `notificaciones` (la campana) y mandan el push. Hasta hoy, cuatro
-- de ellas solo existían en la base: notificar_incidencia (captura,
-- asignación, reparado, cierre, rechazo, reenvío), notificar_tecnico,
-- notificar_reasignacion y destinatarios_notif. Las otras cuatro tenían
-- archivo suelto en la raíz, pero de fechas distintas; aquí va la versión
-- vigente de las ocho.
--
-- QUÉ NO ES: no es una migración y NO hay que correrlo. Está en
-- supabase/referencia/ y no en supabase/migrations/ a propósito. Si se
-- cambia un aviso, se hace con una migración nueva y se actualiza esta
-- foto. Correrlo tal cual dejaría la base igual que estaba el 8-oct-2026
-- (sirve para reconstruir un entorno, p. ej. staging).
--
-- Mapa (evento → quién lo recibe):
--   incidencias INSERT por_validar ........ captura → validadores de la unidad
--   incidencias INSERT en_proceso ......... asignacion → técnicos del área (auto-ruteo Digital)
--   estatus → en_proceso .................. asignacion → técnicos del área
--   reparado → en_proceso ................. reabierta → quien capturó
--   estatus → reparado .................... reparado → validadores; reparado_reportante → quien capturó
--   estatus → cerrada ..................... cierre → quien capturó
--   estatus → rechazada ................... rechazada → quien capturó
--   rechazada → por_validar ............... captura → validadores (reenvío)
--   asignado_tecnico_email cambia ......... asignacion_tecnico → ese técnico
--   assigned_area cambia .................. asignacion_area → técnicos de esa área
--   reasignación aprobada (incidencias) ... reasignacion → técnicos del área nueva
--   reasignaciones INSERT Solicitada ...... reasignacion → validadores (menos quien pidió)
--   reasignaciones Aprobada/Rechazada ..... reasignacion → quien pidió
--   mensajes INSERT ....................... chat → participantes (ver notificar_chat)
--   notificaciones INSERT ................. push al teléfono (función enviar-push)
--
-- Cascada de destinatarios_notif: el rol que toca (con su unidad, área y,
-- para el validador, su medio) → si no hay nadie, los coordinadores de la
-- unidad → si tampoco, los managers. Todos los avisos a validadores y a
-- técnicos de un área pasan por ella. Un técnico SIN área cuenta como de
-- todas las áreas: recibe los avisos de áreas que nadie más tiene.
-- ============================================================


-- ── destinatarios_notif: a quién avisar (con respaldo) ──────────────────
-- Desde el 9-oct-2026 (UTC) lleva p_medio; la firma vieja de 3 parámetros se quitó.
DROP FUNCTION IF EXISTS public.destinatarios_notif(app_role, text, text);
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


-- ── notificar_incidencia: captura, asignación, reparado, cierre, rechazo ─
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

DROP TRIGGER IF EXISTS trg_notificar ON public.incidencias;
CREATE TRIGGER trg_notificar AFTER INSERT OR UPDATE ON public.incidencias FOR EACH ROW EXECUTE FUNCTION notificar_incidencia();


-- ── notificar_tecnico: técnico asignado por nombre ──────────────────────
CREATE OR REPLACE FUNCTION public.notificar_tecnico()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.asignado_tecnico_email is not null
     and new.asignado_tecnico_email is distinct from old.asignado_tecnico_email then
    insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
    values (new.record_id, lower(new.asignado_tecnico_email), 'asignacion_tecnico',
      'Se te asignó: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'')||' ('||coalesce(new.clave_sitio,'')||')',
      new.unidad_negocio);
  end if;
  return new;
end $function$;

DROP TRIGGER IF EXISTS trg_notificar_tecnico ON public.incidencias;
CREATE TRIGGER trg_notificar_tecnico AFTER UPDATE ON public.incidencias FOR EACH ROW EXECUTE FUNCTION notificar_tecnico();


-- ── notificar_area_asignada: la incidencia se dirige a otra área ────────
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

DROP TRIGGER IF EXISTS trg_notificar_area_asignada ON public.incidencias;
CREATE TRIGGER trg_notificar_area_asignada AFTER UPDATE ON public.incidencias FOR EACH ROW EXECUTE FUNCTION notificar_area_asignada();


-- ── notificar_reasignacion_aprobada: el área nueva recibe la incidencia ──
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

DROP TRIGGER IF EXISTS trg_notificar_reasignacion_aprobada ON public.incidencias;
CREATE TRIGGER trg_notificar_reasignacion_aprobada BEFORE UPDATE ON public.incidencias FOR EACH ROW EXECUTE FUNCTION notificar_reasignacion_aprobada();


-- ── notificar_reasignacion: solicitud y resolución ──────────────────────
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

DROP TRIGGER IF EXISTS trg_notificar_reasignacion ON public.reasignaciones;
CREATE TRIGGER trg_notificar_reasignacion AFTER INSERT OR UPDATE ON public.reasignaciones FOR EACH ROW EXECUTE FUNCTION notificar_reasignacion();


-- ── notificar_chat: mensajes del chat ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.notificar_chat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare inc record; msg text;
begin
  select * into inc from incidencias where record_id = new.record_id;
  if not found then return new; end if;
  msg := 'Nuevo mensaje en '||coalesce(inc.folio,'')||': '||left(coalesce(new.texto,''),80);
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
  where r.e <> lower(coalesce(new.autor_email, ''));
  return new;
end
$function$;

DROP TRIGGER IF EXISTS trg_notificar_chat ON public.mensajes;
CREATE TRIGGER trg_notificar_chat AFTER INSERT ON public.mensajes FOR EACH ROW EXECUTE FUNCTION notificar_chat();


-- ── notificar_push: cada aviso de la campana sale como push ─────────────
-- El secreto NO está aquí: vive en el Vault (push_secret_vault.sql).
CREATE OR REPLACE FUNCTION public.notificar_push()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_url    text := 'https://qztxpcfbbbmvgmtjnlxg.supabase.co/functions/v1/enviar-push';
  v_secret text;
begin
  -- El secreto vive en el Vault (ver push_secret_vault.sql). Esta función
  -- es security definer: puede leerlo; el rol authenticated, no.
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'push_secret';

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', v_secret
    ),
    body    := jsonb_build_object(
      'id',             new.id,
      'para_email',     new.para_email,
      'evento',         new.evento,
      'mensaje',        new.mensaje,
      'record_id',      new.record_id,
      'unidad_negocio', new.unidad_negocio
    )
  );
  return new;
end;
$function$;

DROP TRIGGER IF EXISTS trg_notificar_push ON public.notificaciones;
CREATE TRIGGER trg_notificar_push AFTER INSERT ON public.notificaciones FOR EACH ROW EXECUTE FUNCTION notificar_push();
