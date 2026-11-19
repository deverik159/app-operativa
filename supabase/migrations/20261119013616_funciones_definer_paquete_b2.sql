-- ============================================================
-- funciones_definer_paquete_b2 — dos huecos que dejó el paquete B
-- (20261119010031), encontrados por la revisión de seguridad del commit
-- (Plataforma, 18-nov-2026; Erik autorizó prepararlo).
--
-- 1) nombre_de_sesion leía auth.jwt()->'user_metadata'->>'name', y el
--    usuario puede cambiar su propio user_metadata (supabase.auth.updateUser).
--    El nombre en "Visto por" y en los mensajes seguía siendo falsificable
--    (no empeoró: antes lo mandaba el cliente). Ahora sale del nombre de su
--    identidad de Google (auth.identities.identity_data, que solo actualiza
--    Supabase Auth al entrar con Google) o, si no tiene, de la parte del
--    correo antes de la @.
--    Hoy no cambia lo que se ve: los 50 usuarios con nombre entran con
--    Google y en los 50 coincide con user_metadata; los 22 de correo no
--    tienen nombre.
--    Pasa a SECURITY DEFINER para leer auth.identities: el asesor sube 1.
--    Solo devuelve el nombre de quien llama, así que no expone nada.
--
-- 2) rutas_monitoreo: rutas_ins, rutas_upd y rutas_del solo revisaban que la
--    ruta fuera del coordinador, no la unidad. Un coordinador de Biobox podía
--    crear (o mover) una ruta suya "de Ecovallas" y llenarla con sitios de
--    Ecovallas sin ruta. Ahora también exigen ser coordinador de la unidad de
--    la ruta (o sin unidad), con rol_en_unidad, igual que las paradas.
--    Hoy solo toca las 5 rutas de Vía Verde Digital del coordinador de
--    Ecovallas (tampoco podrá armarlas ni eliminarlas, por el punto 3):
--    Erik decidió aplicarlo sin esperar a darle el rol coordinador de Vía
--    Verde (18-nov-2026); hasta tenerlo, esas 5 rutas solo las toca el manager.
--    La pantalla de Rutas (RutasView) escribe esta tabla directo.
--
-- Agregado tras revisor-rls (18-nov-2026):
-- 3) guardar_paradas_ruta y eliminar_ruta (definer, se saltan la RLS) solo
--    pedían ser dueño de la ruta: también exigen la unidad. Texto de
--    producción (md5 verificado) con cabecera idéntica; solo cambia el
--    bloque marcado "Paquete B2".
-- 4) ruta_ubic_ins/upd/del (paquete B) miraban la unidad pero no el dueño:
--    un coordinador podía mover paradas de las rutas de otro de su misma
--    unidad por la API. Ahora también exigen ser el dueño (o manager). La
--    app no escribe esa tabla directo.
-- 5) rutas_monitoreo.unidad_negocio solo acepta las unidades válidas (con
--    espacios o mayúsculas distintas, la ruta desaparecía de los filtros).
--
-- Nota sobre el nombre: identity_data no se cambia con updateUser, pero sí
-- se actualiza con el perfil de Google al entrar. Las 50 cuentas de Google
-- son corporativas, así que ese nombre lo controla la administración de la
-- cuenta de Google de la empresa. Se filtra además por el correo de la
-- sesión, por si algún día se activa ligar identidades a mano.
--
-- Re-ejecutable.
-- ============================================================

-- 1) Nombre de la sesión desde la identidad de Google ---------------------

create or replace function public.nombre_de_sesion()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select nullif(btrim(i.identity_data ->> 'name'), '')
       from auth.identities i
      where i.user_id = auth.uid()
        and i.provider = 'google'
        and i.email = lower(auth_email())
      order by i.updated_at desc nulls last
      limit 1),
    split_part(lower(auth_email()), '@', 1))
$$;

-- El trigger de mensajes (invoker) la llama con el rol authenticated.
revoke execute on function public.nombre_de_sesion() from public, anon;
grant  execute on function public.nombre_de_sesion() to authenticated, service_role;

-- 2) Rutas: además de ser suya, de una unidad donde es coordinador ---------

alter policy rutas_ins on public.rutas_monitoreo
  with check (tiene_rol('manager'::app_role)
              or (tiene_rol('coordinador'::app_role)
                  and coordinador_email = lower(auth_email())
                  and rol_en_unidad(array['coordinador']::app_role[], unidad_negocio)));

alter policy rutas_upd on public.rutas_monitoreo
  using (tiene_rol('manager'::app_role)
         or (tiene_rol('coordinador'::app_role)
             and coordinador_email = lower(auth_email())
             and rol_en_unidad(array['coordinador']::app_role[], unidad_negocio)))
  with check (tiene_rol('manager'::app_role)
              or (tiene_rol('coordinador'::app_role)
                  and coordinador_email = lower(auth_email())
                  and rol_en_unidad(array['coordinador']::app_role[], unidad_negocio)));

alter policy rutas_del on public.rutas_monitoreo
  using (tiene_rol('manager'::app_role)
         or (tiene_rol('coordinador'::app_role)
             and coordinador_email = lower(auth_email())
             and rol_en_unidad(array['coordinador']::app_role[], unidad_negocio)));

-- 3) Funciones de rutas: también la unidad --------------------------------

CREATE OR REPLACE FUNCTION public.eliminar_ruta(p_ruta_id bigint, p_solo_contar boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_ruta     record;
  v_email    text := lower(auth_email());
  v_paradas  int;
  v_asig     int;
  v_visitas  int;
  v_rev      int;
begin
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'No tienes permiso para eliminar rutas (se requiere coordinador o manager).';
  end if;

  select id, numero, nombre, unidad_negocio, tipo_medio, coordinador_email
    into v_ruta
    from rutas_monitoreo
   where id = p_ruta_id
     for update;
  if not found then
    raise exception 'La ruta ya no existe. Recarga la pantalla.';
  end if;

  if not tiene_rol('manager'::app_role) and v_ruta.coordinador_email is distinct from v_email then
    raise exception 'Esta ruta es de otro coordinador: no la puedes eliminar.';
  end if;

  -- Paquete B2 (18-nov-2026): además de ser suya, de una unidad donde es
  -- coordinador (o sin unidad); el manager, siempre.
  if not rol_en_unidad(array['coordinador']::app_role[], v_ruta.unidad_negocio) then
    raise exception 'No eres coordinador de %: no puedes eliminar sus rutas.', v_ruta.unidad_negocio;
  end if;

  select count(*) into v_paradas from ruta_ubicaciones where ruta_id = p_ruta_id;
  select count(*) into v_asig from ruta_asignaciones where ruta_id = p_ruta_id;
  select count(*) into v_visitas from ruta_visitas where ruta_id = p_ruta_id;
  select count(*) into v_rev from revisiones where ruta_id = p_ruta_id;

  if not coalesce(p_solo_contar, false) then
    -- Las asignaciones van primero y aparte: con la ruta todavía en su lugar,
    -- el aviso "se te retiró la ruta" y el historial de asignaciones
    -- encuentran su número y nombre (en el borrado en cascada ya no está).
    delete from ruta_asignaciones where ruta_id = p_ruta_id;
    update revisiones set ruta_id = null where ruta_id = p_ruta_id;
    delete from rutas_monitoreo where id = p_ruta_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'eliminada', not coalesce(p_solo_contar, false),
    'numero', v_ruta.numero,
    'nombre', v_ruta.nombre,
    'paradas', v_paradas,
    'monitoristas', v_asig,
    'visitas', v_visitas,
    'revisiones', v_rev
  );
end $function$;

CREATE OR REPLACE FUNCTION public.guardar_paradas_ruta(p_ruta_id bigint, p_site_ids text[], p_mover boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_ruta       record;
  v_email      text := lower(auth_email());
  v_final      text[];
  v_rechazadas jsonb;
  v_otro_seg   jsonb;
  v_fuera      text[];
  v_origenes   bigint[];
  v_conflictos jsonb;
  v_movidas    jsonb;
  v_nuevas     int := 0;
  v_movidas_n  int := 0;
  v_quitadas   int := 0;
  v_total      int := 0;
begin
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'No tienes permiso para armar rutas (se requiere coordinador o manager).';
  end if;

  if p_ruta_id is null then
    raise exception 'Falta la ruta.';
  end if;
  if coalesce(cardinality(p_site_ids), 0) > 2000 then
    raise exception 'Son demasiados sitios para una sola ruta (máximo 2000).';
  end if;

  -- for update: dos coordinadores guardando la MISMA ruta a la vez se
  -- forman, en vez de mezclar sus listas.
  select id, numero, nombre, unidad_negocio, tipo_medio, coordinador_email
    into v_ruta
    from rutas_monitoreo
   where id = p_ruta_id
     for update;
  if not found then
    raise exception 'La ruta ya no existe. Recarga la pantalla.';
  end if;

  if lower(v_ruta.unidad_negocio) = 'ecovallas' and lower(v_ruta.tipo_medio) = 'impreso' then
    raise exception 'Las rutas de Ecovallas Impreso salen de la pauta: usa Pauta → Sincronizar rutas.';
  end if;

  -- CAMBIO (rutas por coordinador, 22-oct-2026): solo el dueño o el manager.
  if not tiene_rol('manager'::app_role) and v_ruta.coordinador_email is distinct from v_email then
    raise exception 'Esta ruta es de otro coordinador: no la puedes modificar.';
  end if;

  -- Paquete B2 (18-nov-2026): además de ser suya, de una unidad donde es
  -- coordinador (o sin unidad); el manager, siempre.
  if not rol_en_unidad(array['coordinador']::app_role[], v_ruta.unidad_negocio) then
    raise exception 'No eres coordinador de %: no puedes modificar sus rutas.', v_ruta.unidad_negocio;
  end if;

  -- 1) Lista limpia (sin vacíos ni repetidos, en el orden en que llegó) y
  --    qué pasa con cada sitio.
  with entrada as (
    select btrim(u.s) as site_id, min(u.o) as pos
      from unnest(coalesce(p_site_ids, '{}'::text[])) with ordinality as u(s, o)
     where nullif(btrim(u.s), '') is not null
     group by btrim(u.s)
  ),
  clasif as (
    select e.site_id,
           e.pos,
           exists (select 1 from ruta_ubicaciones ru
                    where ru.site_id = e.site_id and ru.ruta_id = p_ruta_id) as ya_aqui,
           exists (select 1 from inventario i
                    where i.site_id = e.site_id
                      and i.unidad_negocio = v_ruta.unidad_negocio
                      and (v_ruta.tipo_medio = 'Combinada' or i.tipo_medio = v_ruta.tipo_medio)) as valido,
           exists (select 1 from inventario i
                    where i.site_id = e.site_id) as en_inventario
      from entrada e
  )
  select
    coalesce(array_agg(c.site_id order by c.pos) filter (where c.ya_aqui or c.valido), '{}'::text[]),
    coalesce(jsonb_agg(jsonb_build_object(
               'site_id', c.site_id,
               'motivo', case
                 when not c.en_inventario then 'No está en el inventario de QTM.'
                 else 'Es de otra unidad o tipo de medio; esta ruta es '
                      || v_ruta.unidad_negocio || ' ' || v_ruta.tipo_medio || '.'
               end) order by c.pos)
             filter (where not (c.ya_aqui or c.valido)), '[]'::jsonb)
    into v_final, v_rechazadas
    from clasif c;

  -- 1b) Un sitio que HOY vive en una ruta de OTRO segmento (otra unidad o
  --     medio) no se mueve desde aquí; entre una Combinada y una
  --     Impreso/Digital de la misma unidad sí.
  --     CAMBIO (rutas por coordinador, 22-oct-2026): tampoco se mueve un
  --     sitio que está en una ruta de OTRO coordinador (Erik: se omite y se
  --     avisa).
  select coalesce(jsonb_agg(jsonb_build_object(
           'site_id', ru.site_id,
           'motivo', 'Ya está en la Ruta ' || r.numero
                     || coalesce(' · ' || nullif(r.nombre, ''), '')
                     || case
                          when r.coordinador_email is distinct from v_ruta.coordinador_email
                            then ' de ' || nombre_coordinador(r.coordinador_email)
                                 || '; es de otro coordinador y no se mueve.'
                          else ' de ' || r.unidad_negocio || ' ' || r.tipo_medio
                               || case when lower(r.unidad_negocio) = 'ecovallas' and lower(r.tipo_medio) = 'impreso'
                                    then ' (la manda la pauta)' else '' end
                               || '; no se mueve entre unidades o medios.'
                        end
         ) order by ru.site_id), '[]'::jsonb),
         coalesce(array_agg(ru.site_id), '{}'::text[])
    into v_otro_seg, v_fuera
    from ruta_ubicaciones ru
    join rutas_monitoreo r on r.id = ru.ruta_id
   where ru.site_id = any(v_final)
     and ru.ruta_id <> p_ruta_id
     and (r.coordinador_email is distinct from v_ruta.coordinador_email
          or r.unidad_negocio is distinct from v_ruta.unidad_negocio
          or (r.tipo_medio is distinct from v_ruta.tipo_medio
              and r.tipo_medio is distinct from 'Combinada'
              and v_ruta.tipo_medio is distinct from 'Combinada'));
  if cardinality(v_fuera) > 0 then
    v_final := array(
      select f.s from unnest(v_final) with ordinality as f(s, n)
       where not (f.s = any(v_fuera))
       order by f.n);
    v_rechazadas := v_rechazadas || v_otro_seg;
  end if;

  -- Una lista vacía (o toda rechazada) NO vacía la ruta: casi siempre es
  -- un error de pantalla, no una decisión. Para quitar todo, se borra la
  -- ruta.
  if cardinality(v_final) = 0 then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'No hay sitios válidos para guardar en esta ruta.',
      'rechazadas', v_rechazadas
    );
  end if;

  -- 2) ¿Alguno vive en otra ruta? Después del 1b solo quedan rutas del MISMO
  --    dueño y segmento (o una Combinada de la misma unidad).
  select coalesce(jsonb_agg(jsonb_build_object(
           'site_id', ru.site_id,
           'ruta_id', r.id,
           'ruta_numero', r.numero,
           'ruta_nombre', r.nombre,
           'ruta_unidad', r.unidad_negocio,
           'ruta_tipo', r.tipo_medio
         ) order by r.numero, ru.site_id), '[]'::jsonb)
    into v_conflictos
    from ruta_ubicaciones ru
    join rutas_monitoreo r on r.id = ru.ruta_id
   where ru.site_id = any(v_final)
     and ru.ruta_id <> p_ruta_id;

  if jsonb_array_length(v_conflictos) > 0 and not coalesce(p_mover, false) then
    return jsonb_build_object(
      'ok', false,
      'requiere_confirmar', true,
      'en_otra_ruta', v_conflictos,
      'rechazadas', v_rechazadas
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'site_id', x->>'site_id',
           'ruta_origen_id', (x->>'ruta_id')::bigint,
           'ruta_origen_numero', (x->>'ruta_numero')::int
         )), '[]'::jsonb)
    into v_movidas
    from jsonb_array_elements(v_conflictos) x;

  -- 3) Escribir. Todo o nada: la función es UNA transacción.
  begin
    delete from ruta_ubicaciones
     where ruta_id = p_ruta_id
       and not (site_id = any(v_final));
    get diagnostics v_quitadas = row_count;

    update ruta_ubicaciones ru
       set secuencia = f.n::int
      from unnest(v_final) with ordinality as f(s, n)
     where ru.site_id = f.s
       and ru.ruta_id = p_ruta_id;

    update ruta_ubicaciones ru
       set ruta_id = p_ruta_id,
           secuencia = f.n::int,
           origen = 'app',
           agregada_por = v_email,
           agregada_en = now()
      from unnest(v_final) with ordinality as f(s, n)
     where ru.site_id = f.s
       and ru.ruta_id <> p_ruta_id;
    get diagnostics v_movidas_n = row_count;

    insert into ruta_ubicaciones (ruta_id, site_id, secuencia, origen, agregada_por, direccion_fuente)
    select p_ruta_id, f.s, f.n::int, 'app', v_email, 'qtm'
      from unnest(v_final) with ordinality as f(s, n)
     where not exists (select 1 from ruta_ubicaciones ru where ru.site_id = f.s);
    get diagnostics v_nuevas = row_count;

    select coalesce(array_agg(distinct (x->>'ruta_id')::bigint), '{}'::bigint[])
      into v_origenes
      from jsonb_array_elements(v_conflictos) x;
    if cardinality(v_origenes) > 0 then
      update ruta_ubicaciones ru
         set secuencia = o.n::int
        from (select id,
                     row_number() over (partition by ruta_id
                                        order by secuencia nulls last, id) as n
                from ruta_ubicaciones
               where ruta_id = any(v_origenes)) o
       where ru.id = o.id
         and ru.secuencia is distinct from o.n::int;
    end if;
  exception when unique_violation then
    raise exception 'Otra persona movió uno de estos sitios al mismo tiempo. Vuelve a guardar.';
  end;

  select count(*) into v_total from ruta_ubicaciones where ruta_id = p_ruta_id;

  return jsonb_build_object(
    'ok', true,
    'total', v_total,
    'agregadas', v_nuevas + v_movidas_n,
    'quitadas', v_quitadas,
    'movidas', v_movidas,
    'rechazadas', v_rechazadas
  );
end $function$;

-- 4) Paradas: además de la unidad, el dueño de la ruta (o manager) ---------

alter policy ruta_ubic_ins on public.ruta_ubicaciones
  with check (exists (select 1 from rutas_monitoreo r
                       where r.id = ruta_ubicaciones.ruta_id
                         and (r.coordinador_email = lower(auth_email()) or tiene_rol('manager'::app_role))
                         and rol_en_unidad(array['coordinador']::app_role[], r.unidad_negocio)));
alter policy ruta_ubic_upd on public.ruta_ubicaciones
  using (exists (select 1 from rutas_monitoreo r
                  where r.id = ruta_ubicaciones.ruta_id
                    and (r.coordinador_email = lower(auth_email()) or tiene_rol('manager'::app_role))
                    and rol_en_unidad(array['coordinador']::app_role[], r.unidad_negocio)))
  with check (exists (select 1 from rutas_monitoreo r
                       where r.id = ruta_ubicaciones.ruta_id
                         and (r.coordinador_email = lower(auth_email()) or tiene_rol('manager'::app_role))
                         and rol_en_unidad(array['coordinador']::app_role[], r.unidad_negocio)));
alter policy ruta_ubic_del on public.ruta_ubicaciones
  using (exists (select 1 from rutas_monitoreo r
                  where r.id = ruta_ubicaciones.ruta_id
                    and (r.coordinador_email = lower(auth_email()) or tiene_rol('manager'::app_role))
                    and rol_en_unidad(array['coordinador']::app_role[], r.unidad_negocio)));

-- 5) Unidad de la ruta: solo valores válidos ------------------------------
-- (Sin Biobox Perú: está en pausa y la pantalla de Rutas no la ofrece.)

alter table public.rutas_monitoreo drop constraint if exists rutas_monitoreo_unidad_chk;
alter table public.rutas_monitoreo
  add constraint rutas_monitoreo_unidad_chk
  check (unidad_negocio in ('Ecovallas', 'Biobox', 'Vía Verde'));

-- Verificar:
-- · simulando la sesión de un usuario de Google, nombre_de_sesion() da su
--   nombre de Google; con uno de correo, la parte antes de la @ (72 de 72
--   iguales a hoy);
-- · un coordinador de Biobox no puede insertar una ruta de Ecovallas a su
--   nombre (begin … rollback); uno de Ecovallas sí en Ecovallas;
-- · eliminar_ruta y guardar_paradas_ruta coinciden por md5 con este archivo;
-- · el asesor sube de 95 a 96.
