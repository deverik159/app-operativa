-- ============================================================
-- 23-nov-2026 · Incidencias · «Descartar como duplicada» (2 de 2)
-- Qué (Erik, 23-nov-2026; caso EVD00040/EVD00041):
--   1. Columnas de rastro: duplicada_de (record_id de la original),
--      duplicada_folio, duplicada_por, duplicada_en.
--   2. inc_guarda_duplicada (trigger): a 'duplicada' solo se entra por la
--      función de abajo; salir de ahí solo lo hace un manager (y se limpian
--      las columnas); fuera de la función las columnas no se tocan.
--   3. inc_descartar_duplicada(record_id, folio_original, falla): el
--      validador de la unidad (o un manager) la marca duplicada de otra EN
--      PROCESO con la misma regla de lib/duplicados.ts (misma unidad + misma
--      cara + misma falla + mismo medio; Adicional/Puerta por sitio). Si se
--      pasa la falla, corrige y descarta en un paso (copia de la original la
--      falla, nivel, origen, tipo, área y lado). Los reportes de la app
--      Biobox que tenía pasan a apuntar a la original, sin cambiar cómo se
--      atendieron. Avisa SOLO al reportante.
--   4. Lo que trataba «cerrada/no_reparado» como terminal ahora también
--      «duplicada»: estado_maquina(s) (la máquina no la cuenta abierta),
--      puede_escribir_chat y políticas del chat (solo lectura),
--      inc_sel_participante_chat, datos_usuario_app_incidencia,
--      ligar_reporte_biobox_app (no se liga un reporte a una duplicada),
--      inc_registrar_historial (evento «duplicada» con el folio) y la purga
--      de adjuntos del chat: 30 días desde duplicada_en, como no_reparado.
-- Fuera a propósito: notificar_incidencia (no tiene rama para duplicada: no
--   avisa a nadie; el aviso al reportante lo pone la función) y
--   notificar_webadmin_atendido (solo actúa con cerrada o reparado).
-- Candado: solo procede si las 6 funciones que se reemplazan siguen como se
--   revisaron (md5 del 23-nov-2026) o ya son las de esta migración.
-- Re-ejecutable: add column if not exists, create or replace, drop/create de
--   trigger y alter policy.
-- ============================================================

set local lock_timeout = '5s';

do $$
declare
  r record;
  v_esperado text;
begin
  for r in
    select p.proname, md5(replace(p.prosrc, E'\r', '')) as m
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('estado_maquina', 'estado_maquinas', 'puede_escribir_chat',
                         'datos_usuario_app_incidencia', 'ligar_reporte_biobox_app',
                         'inc_registrar_historial')
  loop
    v_esperado := case r.proname
      when 'estado_maquina'               then '31acf278caec42363c02c88fa9fc9c9b'
      when 'estado_maquinas'              then '3e8e386cad949ecbc636e83a71ef222b'
      when 'puede_escribir_chat'          then '20022bf012f69ea1d791711332db5a3c'
      when 'datos_usuario_app_incidencia' then '63153028556097407a8fa424896b4555'
      when 'ligar_reporte_biobox_app'     then '829dec563690e1d47e301535d84933bd'
      when 'inc_registrar_historial'      then '02c2630a61e34c4c9fd5cb389d3936a6'
    end;
    -- Ya aplicada: el texto nuevo menciona 'duplicada'.
    if r.m is distinct from v_esperado
       and not exists (select 1 from pg_proc p2
                        where p2.pronamespace = 'public'::regnamespace
                          and p2.proname = r.proname and p2.prosrc like '%duplicada%') then
      raise exception '% cambió en producción (md5 %); revisar antes de aplicar.', r.proname, r.m;
    end if;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Columnas de rastro.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.incidencias
  add column if not exists duplicada_de    text references public.incidencias(record_id) on delete set null,
  add column if not exists duplicada_folio text,
  add column if not exists duplicada_por   text,
  add column if not exists duplicada_en    timestamptz;

comment on column public.incidencias.duplicada_de is
  'Duplicada de esta incidencia (record_id), puesta por inc_descartar_duplicada (23-nov-2026).';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Guardián.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.inc_guarda_duplicada()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Migraciones y procesos del servidor (sin sesión), o la función de
  -- descarte: pasan.
  if (select auth_email()) is null
     or current_setting('app.descarte_duplicada', true) = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.estatus = 'duplicada' then
      raise exception 'Una incidencia nueva no puede nacer duplicada.' using errcode = '42501';
    end if;
    new.duplicada_de := null;
    new.duplicada_folio := null;
    new.duplicada_por := null;
    new.duplicada_en := null;
    return new;
  end if;

  if new.estatus = 'duplicada' and old.estatus is distinct from 'duplicada' then
    raise exception 'Para marcarla duplicada usa «Descartar como duplicada».' using errcode = '42501';
  end if;

  if old.estatus = 'duplicada' and new.estatus is distinct from 'duplicada' then
    if not (select tiene_rol('manager'::app_role)) then
      raise exception 'Solo un manager puede sacar una incidencia de «Duplicada».' using errcode = '42501';
    end if;
    new.duplicada_de := null;
    new.duplicada_folio := null;
    new.duplicada_por := null;
    new.duplicada_en := null;
    return new;
  end if;

  -- duplicada_de puede quedar en null por el «on delete set null» de su
  -- llave (se borró la original): eso sí se deja pasar.
  if new.duplicada_de is not null then
    new.duplicada_de := old.duplicada_de;
  end if;
  new.duplicada_folio := old.duplicada_folio;
  new.duplicada_por := old.duplicada_por;
  new.duplicada_en := old.duplicada_en;
  return new;
end $function$;

revoke execute on function public.inc_guarda_duplicada() from public, anon, authenticated;

drop trigger if exists inc_guarda_duplicada on public.incidencias;
create trigger inc_guarda_duplicada
  before insert or update on public.incidencias
  for each row execute function public.inc_guarda_duplicada();

-- ─────────────────────────────────────────────────────────────────────────
-- 3. La acción.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.inc_descartar_duplicada(
  p_record_id text,
  p_folio_original text,
  p_nombre_incidencia text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_yo    text := lower(nullif(btrim((select auth_email())), ''));
  d       incidencias%rowtype;
  o       incidencias%rowtype;
  v_n     int;
  v_elem  boolean;
  v_falla text;
  v_lado  text;
begin
  if v_yo is null then
    raise exception 'Hay que iniciar sesión.' using errcode = '42501';
  end if;

  select * into d from incidencias where record_id = p_record_id for update;
  if not found then
    raise exception 'No existe la incidencia.' using errcode = '22023';
  end if;

  -- Mismo criterio que inc_upd_validador: validador de la unidad (y del
  -- medio, si lo tiene acotado), o manager.
  if not ((select tiene_rol('manager'::app_role))
          or exists (select 1 from usuario_roles ur
                      where lower(ur.usuario_email) = v_yo
                        and ur.rol = 'validador'::app_role
                        and nullif(btrim(ur.unidad_negocio), '') is not null
                        and lower(btrim(ur.unidad_negocio)) = lower(btrim(d.unidad_negocio))
                        and (ur.medio is null or lower(ur.medio) = lower(d.medio)))) then
    raise exception 'Solo el validador de % puede descartarla como duplicada.', d.unidad_negocio
      using errcode = '42501';
  end if;

  if d.estatus not in ('por_validar', 'en_proceso', 'rechazada') then
    raise exception 'La % está «%»: solo se descarta una por validar, en proceso o devuelta.', d.folio, d.estatus
      using errcode = '23514';
  end if;
  if coalesce(d.reasignacion_pendiente, false) then
    raise exception 'La % tiene una reasignación pendiente: resuélvela primero.', d.folio
      using errcode = '23514';
  end if;

  select count(*) into v_n from incidencias
   where folio = p_folio_original and record_id <> d.record_id
     and lower(btrim(unidad_negocio)) = lower(btrim(d.unidad_negocio))
     and estatus = 'en_proceso';
  if v_n <> 1 then
    raise exception 'No encontré la % en proceso en %.', p_folio_original, d.unidad_negocio
      using errcode = '22023';
  end if;
  select * into o from incidencias
   where folio = p_folio_original and record_id <> d.record_id
     and lower(btrim(unidad_negocio)) = lower(btrim(d.unidad_negocio))
     and estatus = 'en_proceso'
   for update;
  if not found then
    raise exception 'La % ya no está en proceso.', p_folio_original using errcode = '22023';
  end if;

  -- Con corrección: la falla nueva tiene que ser la de la original.
  v_falla := coalesce(nullif(btrim(p_nombre_incidencia), ''), d.nombre_incidencia);
  if v_falla is distinct from o.nombre_incidencia then
    raise exception 'La % es «%», no «%».', o.folio, o.nombre_incidencia, v_falla
      using errcode = '22023';
  end if;
  -- Entra o sale del Adicional o la Puerta: el lado lo sigue (como
  -- ladoAlReclasificar en la pantalla).
  v_lado := case
    when v_falla is distinct from d.nombre_incidencia
         and (o.lado in ('Adicional', 'Puerta') or d.lado in ('Adicional', 'Puerta'))
      then o.lado
    else d.lado
  end;

  -- La regla de lib/duplicados.ts.
  v_elem := v_lado in ('Adicional', 'Puerta')
            and d.clave_sitio is not null and d.clave_sitio <> 'SIN-MAQUINA';
  if not (
    lower(btrim(d.unidad_negocio)) = lower(btrim(o.unidad_negocio))
    and case
      when v_elem then
        o.clave_sitio = d.clave_sitio
        and (o.medio is null or d.medio is null or o.medio = d.medio)
      else
        d.clave_medio is not null and o.clave_medio = d.clave_medio
        and coalesce(o.medio, '') = coalesce(d.medio, '')
    end
  ) then
    raise exception 'La % no es de la misma cara (o medio) que la %: no es duplicada.', d.folio, o.folio
      using errcode = '22023';
  end if;

  perform set_config('app.descarte_duplicada', 'on', true);
  update incidencias
     set estatus = 'duplicada',
         duplicada_de = o.record_id,
         duplicada_folio = o.folio,
         duplicada_por = v_yo,
         duplicada_en = now(),
         nombre_incidencia = o.nombre_incidencia,
         nivel = case when v_falla is distinct from d.nombre_incidencia then o.nivel else nivel end,
         origen = case when v_falla is distinct from d.nombre_incidencia then o.origen else origen end,
         tipo = case when v_falla is distinct from d.nombre_incidencia then o.tipo else tipo end,
         area_responsable = case when v_falla is distinct from d.nombre_incidencia
                                 then o.area_responsable else area_responsable end,
         lado = v_lado
   where record_id = d.record_id;
  perform set_config('app.descarte_duplicada', 'off', true);

  -- Los reportes de la app Biobox que tenía pasan a la original.
  -- Solo cambia a qué incidencia apuntan: se conserva cómo se atendieron
  -- (directo, clasificado o ligado), quién y cuándo, y su marca de atendido,
  -- para no alterar los indicadores de la app Biobox (revisor-rls).
  update biobox_app_reportes
     set record_id = o.record_id
   where record_id = d.record_id
     and decision in ('clasificado', 'ligado', 'directo');

  -- Aviso solo al reportante (si no es quien la descarta).
  if d.captured_by is not null and lower(d.captured_by) <> v_yo then
    insert into notificaciones (record_id, para_email, evento, mensaje, unidad_negocio)
    values (d.record_id, lower(d.captured_by), 'duplicada',
            'Tu incidencia ' || coalesce(d.folio, '') || ' · ' || coalesce(o.nombre_incidencia, '')
            || ' quedó como duplicada de ' || coalesce(o.folio, '')
            || ', que ya está en proceso. No tienes que hacer nada; sus fotos y su chat se conservan.',
            d.unidad_negocio);
  end if;

  return (select jsonb_build_object(
            'estatus', i.estatus, 'duplicada_de', i.duplicada_de,
            'duplicada_folio', i.duplicada_folio, 'duplicada_por', i.duplicada_por,
            'duplicada_en', i.duplicada_en, 'nombre_incidencia', i.nombre_incidencia,
            'nivel', i.nivel, 'origen', i.origen, 'tipo', i.tipo,
            'area_responsable', i.area_responsable, 'lado', i.lado)
            from incidencias i where i.record_id = d.record_id);
end $function$;

revoke all on function public.inc_descartar_duplicada(text, text, text) from public, anon;
grant execute on function public.inc_descartar_duplicada(text, text, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Lo terminal también incluye 'duplicada'.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estado_maquina(p_site_id text)
 RETURNS TABLE(record_id text, folio text, nombre_incidencia text, nivel text, estatus text, area text, clave_medio text, fecha_reporte timestamp with time zone, horas_en_estatus numeric, es_de_mi_area boolean, observaciones text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- Paquete B (18-nov-2026): unidades de quien consulta; null = todas.
  v_unid text[] := unidades_que_veo();
begin
  if auth_email() is null then
    raise exception 'Hay que iniciar sesión.';
  end if;

  return query
  select
    i.record_id,
    i.folio,
    i.nombre_incidencia,
    i.nivel::text,
    i.estatus::text,
    coalesce(i.assigned_area, i.area_responsable) as area,
    i.clave_medio,
    i.fecha_reporte,
    -- Cuánto lleva en el estatus donde está. Son relojes distintos según el
    -- estatus, y mezclarlos daría un número que no significa nada:
    --   en_proceso → desde que se validó (o desde que entró, si fue auto)
    --   los demás  → desde que se capturó
    round(extract(epoch from (now() - case
      when i.estatus = 'en_proceso' then coalesce(i.validator_at, i.sla_reparacion_inicio, i.fecha_reporte)
      else i.fecha_reporte
    end)) / 3600.0, 1) as horas_en_estatus,
    -- Para que la pantalla pueda decir "te toca" contra "es de Digital".
    -- Mismo criterio que usa la RLS (área en la unidad del folio, 12-nov-2026),
    -- así que no puede contradecirla.
    mi_area_en_unidad(coalesce(i.assigned_area, i.area_responsable), i.unidad_negocio) as es_de_mi_area,
    -- La observación de quien la reportó: es lo que la vuelve reconocible en
    -- campo ("no enciende desde la lluvia del lunes"). Antes iban nombres de
    -- a quién preguntarle; Erik los quitó: la conversación es con el ÁREA.
    i.observaciones
  from incidencias i
  where i.clave_sitio = p_site_id
    -- Paquete B (Erik, 18-nov-2026): solo incidencias de las unidades de
    -- quien consulta, de cualquier área. Rol sin unidad o manager: todas.
    and (v_unid is null or lower(btrim(i.unidad_negocio)) = any (v_unid))
    -- `reparado` fuera desde el 14-oct-2026: ya se arregló, solo falta validarla.
    -- `duplicada` (23-nov-2026): la que cuenta es la original.
    and i.estatus not in ('cerrada', 'no_reparado', 'reparado', 'duplicada')
  order by
    -- Lo detenido primero, y dentro de eso lo más viejo. Es el orden en que
    -- el operador tiene que actuar, no el orden en que se capturaron.
    case i.estatus when 'en_proceso' then 1 else 2 end,
    i.fecha_reporte;
end
$function$;

CREATE OR REPLACE FUNCTION public.estado_maquinas(p_site_ids text[])
 RETURNS TABLE(site_id text, abiertas integer, en_proceso integer, por_validar integer, horas_peor numeric, areas text, hay_critica boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- Paquete B (18-nov-2026): unidades de quien consulta; null = todas.
  v_unid text[] := unidades_que_veo();
begin
  if auth_email() is null then
    raise exception 'Hay que iniciar sesión.';
  end if;

  return query
  select
    i.clave_sitio,
    count(*)::int,
    count(*) filter (where i.estatus = 'en_proceso')::int,
    count(*) filter (where i.estatus = 'por_validar')::int,
    max(round(extract(epoch from (now() - case
      when i.estatus = 'en_proceso' then coalesce(i.validator_at, i.sla_reparacion_inicio, i.fecha_reporte)
      else i.fecha_reporte
    end)) / 3600.0, 1)),
    string_agg(distinct coalesce(i.assigned_area, i.area_responsable), ' · '),
    bool_or(i.nivel = 'Alto')
  from incidencias i
  where i.clave_sitio = any(p_site_ids)
    -- Paquete B (Erik, 18-nov-2026): solo incidencias de las unidades de
    -- quien consulta, de cualquier área. Rol sin unidad o manager: todas.
    and (v_unid is null or lower(btrim(i.unidad_negocio)) = any (v_unid))
    -- `reparado` fuera desde el 14-oct-2026: ya se arregló, solo falta validarla.
    -- `duplicada` (23-nov-2026): la que cuenta es la original.
    and i.estatus not in ('cerrada', 'no_reparado', 'reparado', 'duplicada')
  group by i.clave_sitio;
end
$function$;

CREATE OR REPLACE FUNCTION public.puede_escribir_chat(p_record_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1
    from incidencias i
    where i.record_id = p_record_id
      -- `duplicada` (23-nov-2026): su chat queda de solo lectura, como cerrada.
      and i.estatus not in ('cerrada', 'duplicada')
      and (
        (select tiene_rol('manager'))
        or lower(i.captured_by) = lower((select auth_email()))
        or ((select tiene_rol('validador')) and i.unidad_negocio in (select mis_unidades()))
        or ((select tiene_rol('reparacion'))
            and (mi_area_en_unidad(i.area_responsable, i.unidad_negocio)
                 or mi_area_en_unidad(i.assigned_area, i.unidad_negocio)))
        -- NUEVO (17-nov-2026): técnico de Op. Bio Box, en cualquier
        -- incidencia de Biobox que pueda ver.
        or (lower(btrim(i.unidad_negocio)) = 'biobox'
            and exists (
              select 1 from usuario_roles ur
              where lower(ur.usuario_email) = lower((select auth_email()))
                and ur.rol = 'reparacion'
                and ur.departamento = 'Op. Bio Box'
                and (nullif(btrim(ur.unidad_negocio), '') is null
                     or lower(btrim(ur.unidad_negocio)) = lower(btrim(i.unidad_negocio)))))
        or exists (
          select 1 from mensajes previo
          where previo.record_id = i.record_id
            and lower(previo.autor_email) = lower((select auth_email())))
        or exists (
          select 1 from chat_menciones cm
          where cm.record_id = i.record_id
            and cm.email = lower((select auth_email())))
        -- Antes msg_ins_coordinador (misma condición).
        or ((select tiene_rol('coordinador'))
            and (not exists (
                   select 1 from usuario_roles ur
                   where lower(ur.usuario_email) = lower((select auth_email()))
                     and ur.rol = 'coordinador'
                     and ur.unidad_negocio is not null)
                 or exists (
                   select 1 from usuario_roles ur
                   where lower(ur.usuario_email) = lower((select auth_email()))
                     and ur.rol = 'coordinador'
                     and lower(ur.unidad_negocio) = lower(i.unidad_negocio)
                     and (ur.departamento is null
                          or lower(ur.departamento) = lower(i.area_responsable)))))
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public.datos_usuario_app_incidencia(p_record_id text)
 RETURNS TABLE(folio_app text, motivo text, descripcion text, correo text, telefono text, medio_contacto text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_unidad  text;
  v_area    text;
  v_estatus text;
begin
  if p_record_id is null then
    return;
  end if;

  select i.unidad_negocio,
         coalesce(nullif(btrim(i.assigned_area), ''), i.area_responsable),
         i.estatus::text
    into v_unidad, v_area, v_estatus
    from incidencias i
   where i.record_id = p_record_id;
  if not found then
    return;
  end if;

  if not (
    (select tiene_rol('manager'::app_role))
    or exists (
      select 1 from usuario_roles ur
       where lower(ur.usuario_email) = lower((select auth_email()))
         and (
           (ur.rol = 'validador'::app_role
            and lower(btrim(ur.unidad_negocio)) = lower(btrim(v_unidad)))
           or (ur.rol = 'coordinador'::app_role
               and (nullif(btrim(ur.unidad_negocio), '') is null
                    or lower(btrim(ur.unidad_negocio)) = lower(btrim(v_unidad))))
           -- Técnico de TI, solo mientras la atiende: hoy en TI y abierta.
           or (ur.rol = 'reparacion'::app_role
               and lower(btrim(ur.departamento)) = 'ti'
               and lower(btrim(coalesce(v_area, ''))) = 'ti'
               and v_estatus not in ('cerrada', 'no_reparado', 'duplicada')
               and (nullif(btrim(ur.unidad_negocio), '') is null
                    or lower(btrim(ur.unidad_negocio)) = lower(btrim(v_unidad))))
         )
    )
  ) then
    return;
  end if;

  return query
  select r.folio_app, r.motivo, r.descripcion, c.correo, c.telefono, c.medio_contacto
    from biobox_app_reportes r
    left join biobox_app_contactos c on c.report_id = r.report_id
   where r.record_id = p_record_id
   order by r.report_id;
end
$function$;

CREATE OR REPLACE FUNCTION public.ligar_reporte_biobox_app(p_report_id bigint, p_record_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r      biobox_app_reportes%rowtype;
  i      incidencias%rowtype;
  v_yo   text;
  v_marca text;
begin
  select * into r from biobox_app_reportes where report_id = p_report_id for update;
  if not found then
    raise exception 'No existe el reporte % de la app Biobox.', p_report_id;
  end if;
  v_yo := biobox_app_exige_validador(r.unidad_negocio);
  if r.decision is not null then
    raise exception 'Este reporte ya se atendió (%).', r.decision using errcode = '23514';
  end if;
  select * into i from incidencias where record_id = p_record_id;
  if not found or lower(i.unidad_negocio) <> lower(r.unidad_negocio) then
    raise exception 'La incidencia no existe o es de otra unidad.' using errcode = '23514';
  end if;
  if i.estatus in ('cerrada', 'no_reparado') then
    raise exception 'La incidencia % ya está cerrada: clasifica el reporte como nuevo.', i.folio
      using errcode = '23514';
  end if;
  -- `duplicada` (23-nov-2026): el reporte va con la original.
  if i.estatus = 'duplicada' then
    raise exception 'La incidencia % es duplicada de %: liga el reporte a %.',
      i.folio, coalesce(i.duplicada_folio, 'otra'), coalesce(i.duplicada_folio, 'la original')
      using errcode = '23514';
  end if;

  select q.marca_atendido into v_marca from biobox_app_equivalencias q
   where q.unidad_negocio = r.unidad_negocio and q.caso_id = r.caso_id and q.activo;
  update biobox_app_reportes
     set decision = 'ligado', record_id = i.record_id, decidido_por = v_yo, decidido_en = now(),
         marca_atendido = coalesce(v_marca,
                                   case when lower(coalesce(i.assigned_area, i.area_responsable)) = 'ti'
                                        then 'tecnico' else 'validador' end)
   where report_id = p_report_id;
  return i.folio;
end $function$;

CREATE OR REPLACE FUNCTION public.inc_registrar_historial()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_quien  text := lower(nullif(trim((select auth_email())), ''));
  v_evento text;
begin
  if tg_op = 'INSERT' then
    -- Nace ya validada (clasificada desde la app Biobox): se anota.
    insert into incidencias_historial (record_id, evento, estatus_nuevo, por_email, en)
    values (new.record_id, 'validada', new.estatus::text,
            coalesce(lower(nullif(trim(new.validator_email), '')), v_quien), now());
    return null;
  end if;

  if new.estatus is distinct from old.estatus then
    v_evento := case
      when new.estatus = 'en_proceso' and old.estatus in ('por_validar', 'reportado') then 'validada'
      when new.estatus = 'en_proceso' and old.estatus = 'reparado'   then 'reparacion_rechazada'
      when new.estatus = 'en_proceso' and old.estatus in ('cerrada', 'no_reparado', 'duplicada') then 'reabierta'
      -- El técnico descarta en la prevalidación (auto-ruteo): no es una
      -- devolución del validador.
      when new.estatus = 'rechazada'  and old.estatus = 'en_proceso' then 'descartada'
      when new.estatus = 'rechazada'                                 then 'devuelta'
      when new.estatus = 'por_validar' and old.estatus = 'rechazada' then 'corregida'
      when new.estatus = 'reparado'                                  then 'reparada'
      when new.estatus = 'cerrada'                                   then 'cerrada'
      when new.estatus = 'no_reparado'                               then 'no_reparado'
      -- Descartar como duplicada (23-nov-2026): el detalle lleva el folio.
      when new.estatus = 'duplicada'                                 then 'duplicada'
      else 'estatus'
    end;
    insert into incidencias_historial
      (record_id, evento, estatus_antes, estatus_nuevo, por_email, en, detalle)
    values
      (new.record_id, v_evento, old.estatus::text, new.estatus::text, v_quien, now(),
       -- Devolver, descartar y rechazar reparación guardan su motivo aquí.
       case when v_evento in ('reparacion_rechazada', 'devuelta', 'descartada')
            then nullif(trim(new.motivo_rechazo_reparacion), '')
            when v_evento = 'duplicada' then new.duplicada_folio end);
  end if;

  -- NUEVO (18-nov-2026): el área prevalidó lo que entró fuera de horario.
  -- Solo si de verdad requería prevalidación: la columna se puede escribir
  -- por la API en otras, y ahí no es una prevalidación del área.
  if coalesce(new.requiere_prevalidacion, false)
     and coalesce(new.prevalidada, false) and not coalesce(old.prevalidada, false) then
    insert into incidencias_historial (record_id, evento, estatus_nuevo, por_email, en)
    values (new.record_id, 'prevalidada', new.estatus::text, v_quien, now());
  end if;

  -- Cambio de área fuera de una reasignación aprobada (esa la anota
  -- reasignaciones): «Pasar a Op. Bio Box» o la corrección del validador.
  if new.area_responsable is distinct from old.area_responsable
     and not (coalesce(old.reasignacion_pendiente, false)
              and not coalesce(new.reasignacion_pendiente, false)) then
    insert into incidencias_historial (record_id, evento, por_email, en, detalle)
    values (
      new.record_id,
      case when current_setting('app.paso_op_biobox', true) = 'on'
           then 'pasada_op_biobox' else 'area_corregida' end,
      v_quien,
      now(),
      nullif(concat_ws(' → ', nullif(trim(old.area_responsable), ''),
                              nullif(trim(new.area_responsable), '')), '')
    );
  end if;
  return null;
exception when others then
  -- El historial no debe frenar una reparación, validación o prevalidación.
  raise warning 'inc_registrar_historial (%): %', new.record_id, sqlerrm;
  return null;
end
$function$;

-- Políticas del chat: duplicada = solo lectura, como cerrada.
alter policy msg_upd_autor on public.mensajes
  using ((lower(COALESCE(autor_email, ''::text)) = lower(COALESCE(auth_email(), ''::text)))
         AND (creado_en > (now() - '00:15:00'::interval))
         AND (EXISTS (SELECT 1 FROM incidencias i
                       WHERE i.record_id = mensajes.record_id
                         AND i.estatus <> ALL (ARRAY['cerrada'::estatus_incidencia, 'duplicada'::estatus_incidencia]))));

alter policy chat_adj_ins on public.chat_adjuntos
  with check ((lower(subido_por) = lower(auth_email()))
              AND (EXISTS (SELECT 1 FROM mensajes m
                            WHERE m.id = chat_adjuntos.mensaje_id
                              AND m.record_id = chat_adjuntos.record_id
                              AND lower(m.autor_email) = lower(auth_email())))
              AND (EXISTS (SELECT 1 FROM incidencias i
                            WHERE i.record_id = chat_adjuntos.record_id
                              AND i.estatus <> ALL (ARRAY['cerrada'::estatus_incidencia, 'duplicada'::estatus_incidencia]))));

alter policy inc_sel_participante_chat on public.incidencias
  using ((estatus <> ALL (ARRAY['cerrada'::estatus_incidencia, 'no_reparado'::estatus_incidencia, 'duplicada'::estatus_incidencia]))
         AND (EXISTS (SELECT 1 FROM usuario_roles ur
                       WHERE lower(ur.usuario_email) = lower((SELECT auth_email() AS auth_email))))
         AND ((EXISTS (SELECT 1 FROM mensajes m
                        WHERE m.record_id = incidencias.record_id
                          AND lower(m.autor_email) = lower((SELECT auth_email() AS auth_email))))
              OR (EXISTS (SELECT 1 FROM chat_menciones cm
                           WHERE cm.record_id = incidencias.record_id
                             AND cm.email = lower((SELECT auth_email() AS auth_email))))));

-- Purga de adjuntos del chat: duplicada a los 30 días, como no_reparado.
create or replace view public.vw_chat_adjuntos_purgables with (security_invoker = on) as
 SELECT a.id,
    a.record_id,
    a.path,
    a.creado_en,
    i.estatus,
        CASE
            WHEN i.estatus = 'cerrada'::estatus_incidencia THEN 'cerrada hace más de 30 días'::text
            WHEN i.estatus = 'no_reparado'::estatus_incidencia THEN 'no reparado hace más de 30 días'::text
            WHEN i.estatus = 'duplicada'::estatus_incidencia THEN 'duplicada hace más de 30 días'::text
            ELSE 'más de 60 días en proceso'::text
        END AS motivo
   FROM chat_adjuntos a
     JOIN incidencias i ON i.record_id = a.record_id
  WHERE a.purgado_en IS NULL AND (i.estatus = 'cerrada'::estatus_incidencia AND COALESCE(i.cerrada_en, a.creado_en) < (now() - '30 days'::interval)
     OR i.estatus = 'no_reparado'::estatus_incidencia AND COALESCE(i.no_reparado_en, a.creado_en) < (now() - '30 days'::interval)
     OR i.estatus = 'duplicada'::estatus_incidencia AND COALESCE(i.duplicada_en, a.creado_en) < (now() - '30 days'::interval)
     OR (i.estatus IS NULL OR (i.estatus <> ALL (ARRAY['cerrada'::estatus_incidencia, 'no_reparado'::estatus_incidencia, 'duplicada'::estatus_incidencia]))) AND a.creado_en < (now() - '60 days'::interval));
