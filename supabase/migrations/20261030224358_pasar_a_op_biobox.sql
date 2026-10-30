-- ============================================================
-- «Pasar a Op. Bio Box» (Erik, 30-oct-2026)
--
-- Cuando Digital o TI no pueden reparar a distancia una incidencia de una
-- máquina Biobox, la pasan DIRECTO a Op. Bio Box (sin validador). Solo cambia
-- el área y avisa al técnico de la ruta de esa máquina; después sigue el
-- flujo normal (repara, el validador aprueba, se cierra).
--
--   1. inc_pasar_a_op_biobox(p_record_id, p_motivo): revisa que quien llama
--      sea técnico del área que la tiene (o manager), que sea de Biobox, en
--      proceso, con Digital o TI y sin reasignación pendiente. Deja el motivo
--      en el chat de la incidencia (antes de mover el área, para que lo vea
--      quien ya la seguía), cambia el área y avisa (evento asignacion, con
--      record_id: ya es de su área y la puede abrir) a los técnicos de la ruta
--      de la máquina; sin técnico de ruta, a los coordinadores de Op. Bio Box
--      de la unidad; si tampoco, a los managers.
--   2. notificar_correccion_area no avisa en este paso (bandera de la
--      transacción app.paso_op_biobox): si no, el cambio de área le llegaba
--      a los 17 técnicos de Op. Bio Box.
-- ============================================================

-- 2. Copia de producción (pg_get_functiondef, 30-oct-2026); el CAMBIO es la
--    última condición del if.
create or replace function public.notificar_correccion_area()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  msg text;
begin
  if old.estatus = 'en_proceso'
     and new.estatus = 'en_proceso'
     and new.area_responsable is distinct from old.area_responsable
     and new.area_responsable is not null
     and new.assigned_area is null
     and not (coalesce(old.reasignacion_pendiente, false)
              and not coalesce(new.reasignacion_pendiente, false))
     -- CAMBIO (30-oct-2026): «Pasar a Op. Bio Box» avisa solo al técnico de la ruta.
     and coalesce(current_setting('app.paso_op_biobox', true), '') <> 'on' then

    msg := 'Incidencia corregida a tu área (' || new.area_responsable ||
           '), antes de ' || coalesce(old.area_responsable, '—') || ': ' ||
           coalesce(new.folio, '') || ' · ' ||
           coalesce(new.nombre_incidencia, '');

    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      select new.record_id, d, 'asignacion', msg, new.unidad_negocio
      from destinatarios_notif('reparacion'::app_role, new.unidad_negocio, new.area_responsable) d;

  end if;
  return new;
end
$function$;

-- 1. El paso.
create or replace function public.inc_pasar_a_op_biobox(p_record_id text, p_motivo text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_yo text := lower(auth_email());
  v_i incidencias%rowtype;
  v_area text;
  v_motivo text := nullif(left(btrim(coalesce(p_motivo, '')), 300), '');
  v_nombre text;
  v_para text[];
  v_rutas text;
  v_msg text;
begin
  if v_yo is null then
    raise exception 'Hay que iniciar sesión.' using errcode = '42501';
  end if;

  select * into v_i from incidencias where record_id = p_record_id for update;
  if not found then
    raise exception 'La incidencia ya no existe.';
  end if;
  v_area := btrim(coalesce(v_i.assigned_area, v_i.area_responsable, ''));

  -- Quién: técnico del área que la tiene, de esa unidad, o el manager.
  if not (tiene_rol('manager'::app_role) or exists (
    select 1 from usuario_roles ur
     where lower(btrim(ur.usuario_email)) = v_yo
       and ur.rol = 'reparacion'::app_role
       and nullif(btrim(ur.departamento), '') is not null
       and btrim(ur.departamento) ilike v_area
       and (nullif(btrim(ur.unidad_negocio), '') is null
            or lower(btrim(ur.unidad_negocio)) = lower(btrim(v_i.unidad_negocio)))
  )) then
    raise exception 'Solo el técnico del área que la tiene puede pasarla a Op. Bio Box.' using errcode = '42501';
  end if;

  if coalesce(btrim(v_i.unidad_negocio), '') !~* '^biobox' then
    raise exception 'Solo las incidencias de máquinas Biobox se pasan a Op. Bio Box.' using errcode = '22023';
  end if;
  if v_i.estatus is distinct from 'en_proceso' then
    raise exception 'Solo se puede pasar una incidencia en proceso.' using errcode = '22023';
  end if;
  if lower(v_area) not in ('digital', 'ti') then
    raise exception 'Solo Digital o TI la pueden pasar a Op. Bio Box.' using errcode = '22023';
  end if;
  if coalesce(v_i.reasignacion_pendiente, false) then
    raise exception 'Tiene una reasignación pendiente: que el validador la resuelva primero.' using errcode = '22023';
  end if;
  if v_motivo is null then
    raise exception 'Escribe por qué no se pudo reparar a distancia.' using errcode = '22023';
  end if;

  -- Rastro en el chat ANTES de mover el área: su aviso va a quien ya la
  -- seguía (Digital/TI), no a todos los técnicos de Op. Bio Box.
  select max(nullif(btrim(u.nombre), '')) into v_nombre from usuarios u where lower(btrim(u.email)) = v_yo;
  insert into mensajes(record_id, autor_email, autor_nombre, texto)
  values (p_record_id, v_yo, coalesce(v_nombre, split_part(v_yo, '@', 1)),
          'Pasada de ' || v_area || ' a Op. Bio Box: ' || v_motivo);

  perform set_config('app.paso_op_biobox', 'on', true);
  update incidencias
     set area_responsable = 'Op. Bio Box', assigned_area = null, reasignada_de = v_area
   where record_id = p_record_id;
  perform set_config('app.paso_op_biobox', '', true);

  -- A quién: los técnicos de la ruta de la máquina (que sigan siendo de Op. Bio Box).
  select array_agg(distinct lower(rt.usuario_email)),
         string_agg(distinct coalesce(nullif(btrim(r.nombre), ''), 'Ruta ' || r.numero), ', ')
    into v_para, v_rutas
    from ruta_ubicaciones ru
    join rutas_monitoreo r on r.id = ru.ruta_id and r.activa
    join ruta_tecnicos rt on rt.ruta_id = ru.ruta_id
   where ru.site_id = v_i.clave_sitio
     and exists (
       select 1 from usuario_roles ur
        where lower(btrim(ur.usuario_email)) = rt.usuario_email
          and ur.rol = 'reparacion'::app_role
          and btrim(ur.departamento) ilike 'op. bio box'
          and (nullif(btrim(ur.unidad_negocio), '') is null
               or lower(btrim(ur.unidad_negocio)) = lower(btrim(v_i.unidad_negocio))));
  if v_para is null then
    v_rutas := null;
    select array_agg(distinct lower(ur.usuario_email)) into v_para
      from usuario_roles ur
     where ur.rol = 'coordinador'::app_role
       and lower(btrim(ur.unidad_negocio)) = lower(btrim(v_i.unidad_negocio))
       and (ur.departamento is null or btrim(ur.departamento) ilike 'op. bio box');
  end if;
  -- Última red: los managers (no los 17 técnicos de Op. Bio Box).
  if v_para is null then
    select array_agg(distinct lower(ur.usuario_email)) into v_para
      from usuario_roles ur where ur.rol = 'manager'::app_role;
  end if;

  v_msg := v_area || ' pasó a Op. Bio Box ' || coalesce(v_i.folio, '') || ' · '
           || coalesce(v_i.nombre_incidencia, '') || ' en ' || coalesce(v_i.clave_sitio, '(sin clave)')
           || coalesce(' (' || v_rutas || ')', '') || ': ' || v_motivo
           || case when v_rutas is null
                   then '. La ruta de esta máquina no tiene técnico: asígnala a quien la repare.'
                   else '. Te toca revisarla y repararla.' end;
  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  select p_record_id, e, 'asignacion', v_msg, v_i.unidad_negocio
    from unnest(coalesce(v_para, '{}'::text[])) as e
   where e is distinct from v_yo;
end
$function$;

revoke all on function public.inc_pasar_a_op_biobox(text, text) from public, anon;
grant execute on function public.inc_pasar_a_op_biobox(text, text) to authenticated;
