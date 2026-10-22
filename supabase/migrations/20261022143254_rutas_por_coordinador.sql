-- ============================================================
-- rutas_por_coordinador — cada coordinador con sus propias rutas, eliminar
-- rutas e importar reemplazando (Erik, 22-oct-2026).
--
-- DECISIONES DE ERIK (22-oct-2026)
--   · Cada coordinador ve, arma, importa y borra SOLO sus rutas; el manager
--     ve todas (filtro por coordinador en la pantalla). Numeración propia
--     por coordinador: Marco y Ricardo pueden tener cada uno su Ruta 1.
--   · Las rutas que ya existían se reparten por unidad: Biobox a Luis Rojas;
--     Ecovallas y Vía Verde a Marco Anaya.
--   · Un sitio vive en UNA ruta (UNIQUE(site_id), no cambia). Si el archivo
--     o el armado de un coordinador trae un sitio que está en una ruta de
--     OTRO coordinador, se omite y se avisa: no se toca la ruta ajena.
--   · Importar el Excel de rutas REEMPLAZA las rutas del coordinador en esa
--     unidad y medio: las que no vienen en el archivo se borran y las
--     paradas que no vienen salen. Después se siguen pudiendo editar,
--     desactivar y eliminar como siempre.
--   · Se pueden eliminar rutas (también las de Ecovallas Impreso).
--
-- QUÉ CAMBIA
--   1) rutas_monitoreo.coordinador_email (dueño, en minúsculas). Default:
--      quien la crea. UNIQUE(numero, unidad, medio) pasa a
--      UNIQUE(numero, unidad, medio, coordinador).
--   2) RLS de rutas_monitoreo: insertar, editar y borrar solo el dueño o el
--      manager. Leer sigue abierto (Mis rutas, Pauta y Máquinas Biobox leen
--      rutas de otros); la separación de la pantalla de Rutas es por filtro.
--   3) vw_rutas_resumen y vw_rutas_con_coords: el dueño y su nombre al FINAL.
--   4) Funciones nuevas: dueno_rutas(), nombre_coordinador(), eliminar_ruta(),
--      rutas_contexto().
--   5) siguiente_numero_ruta, guardar_paradas_ruta, importar_rutas e
--      importar_rutas_capas: por dueño. importar_rutas y importar_rutas_capas
--      cambian de firma (parámetros nuevos con default), así que se borran y
--      se crean de nuevo; Sincronizar rutas (Pauta) las sigue llamando igual.
--
-- QUÉ NO CAMBIA
--   · Sincronizar rutas desde la pauta (origen 'pauta', solo en Ecovallas
--     Impreso): usa la ruta MÁS ANTIGUA con ese número aunque sea de otro
--     coordinador y no aplica la regla de "sitio de otro coordinador". La
--     pauta manda en Ecovallas Impreso, la corra quien la corra.
--   · El reemplazo no toca las rutas 900+ (EDOMEX 901, PLAZA 902: foráneas
--     de la pauta).
--   · Riesgo conocido (revisor-rls): las políticas de ruta_ubicaciones siguen
--     abiertas a cualquier coordinador, y ordenar_rutas_unidad reordena las
--     rutas de toda la unidad. La pantalla no lo permite; la base no lo
--     impide.
--   · ruta_asignaciones (asignar monitoristas, también desde Pauta) y
--     ruta_ubicaciones: mismas políticas.
--   · Biobox (KML y Excel de operación): "quitar faltantes" sigue igual, pero
--     solo sobre las rutas del dueño. No borra rutas completas.
--
-- El resto de cada función es el de producción del 22-oct-2026
-- (pg_get_functiondef); los cambios van marcados con
-- "CAMBIO (rutas por coordinador, 22-oct-2026)".
-- ============================================================

set lock_timeout = '5s';


-- ══ PASO 1 — Dueño de cada ruta ══
alter table public.rutas_monitoreo add column if not exists coordinador_email text;

-- Reparto de las rutas que ya existen. Por NOMBRE y rol, no por correo: este
-- archivo vive en un repositorio público.
do $$
declare
  v_luis  text;
  v_marco text;
  v_n     int;
begin
  select count(distinct lower(ur.usuario_email)), min(lower(ur.usuario_email))
    into v_n, v_luis
    from usuario_roles ur
    join usuarios u on lower(u.email) = lower(ur.usuario_email)
   where ur.rol = 'coordinador'::app_role
     and ur.unidad_negocio = 'Biobox'
     and u.nombre = 'Luis Rojas';
  if v_n <> 1 then
    raise exception 'No encontré a UN solo coordinador de Biobox llamado Luis Rojas (hay %).', v_n;
  end if;

  select count(distinct lower(ur.usuario_email)), min(lower(ur.usuario_email))
    into v_n, v_marco
    from usuario_roles ur
    join usuarios u on lower(u.email) = lower(ur.usuario_email)
   where ur.rol = 'coordinador'::app_role
     and ur.unidad_negocio = 'Ecovallas'
     and u.nombre = 'Marco Anaya';
  if v_n <> 1 then
    raise exception 'No encontré a UN solo coordinador de Ecovallas llamado Marco Anaya (hay %).', v_n;
  end if;

  update public.rutas_monitoreo
     set coordinador_email = case when unidad_negocio = 'Biobox' then v_luis else v_marco end
   where coordinador_email is null;
end $$;

alter table public.rutas_monitoreo
  alter column coordinador_email set default lower(auth_email()),
  alter column coordinador_email set not null;

-- La numeración es por coordinador.
alter table public.rutas_monitoreo
  drop constraint if exists rutas_monitoreo_numero_unidad_negocio_tipo_medio_key;
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'rutas_monitoreo_numero_segmento_coord_key'
                    and conrelid = 'public.rutas_monitoreo'::regclass) then
    alter table public.rutas_monitoreo
      add constraint rutas_monitoreo_numero_segmento_coord_key
      unique (numero, unidad_negocio, tipo_medio, coordinador_email);
  end if;
end $$;

-- Siempre en minúsculas (la app y las funciones comparan así).
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'rutas_monitoreo_coordinador_minusculas_chk'
                    and conrelid = 'public.rutas_monitoreo'::regclass) then
    alter table public.rutas_monitoreo
      add constraint rutas_monitoreo_coordinador_minusculas_chk
      check (coordinador_email = lower(btrim(coordinador_email)) and coordinador_email <> '');
  end if;
end $$;

create index if not exists idx_rutas_coordinador
  on public.rutas_monitoreo (coordinador_email, unidad_negocio, tipo_medio);


-- ══ PASO 2 — Permisos de escritura: el dueño o el manager ══
alter policy rutas_ins on public.rutas_monitoreo
  with check (
    tiene_rol('manager'::app_role)
    or (tiene_rol('coordinador'::app_role) and coordinador_email = lower(auth_email()))
  );
alter policy rutas_upd on public.rutas_monitoreo
  using (
    tiene_rol('manager'::app_role)
    or (tiene_rol('coordinador'::app_role) and coordinador_email = lower(auth_email()))
  )
  with check (
    tiene_rol('manager'::app_role)
    or (tiene_rol('coordinador'::app_role) and coordinador_email = lower(auth_email()))
  );
alter policy rutas_del on public.rutas_monitoreo
  using (
    tiene_rol('manager'::app_role)
    or (tiene_rol('coordinador'::app_role) and coordinador_email = lower(auth_email()))
  );


-- ══ PASO 3 — Funciones de apoyo ══

-- Con qué dueño trabaja quien llama. Sin p_coordinador (o el suyo), él mismo.
-- Solo el manager puede trabajar las rutas de otro coordinador.
create or replace function public.dueno_rutas(p_coordinador text default null)
  returns text
  language plpgsql
  stable
  set search_path to 'public', 'pg_temp'
as $function$
declare
  v_email text := lower(auth_email());
  v_pedido text := lower(nullif(btrim(p_coordinador), ''));
begin
  if v_pedido is null or v_pedido = v_email then
    return v_email;
  end if;
  if tiene_rol('manager'::app_role) then
    return v_pedido;
  end if;
  raise exception 'Solo el manager puede trabajar las rutas de otro coordinador.';
end $function$;

-- Nombre para los avisos ("es de Ricardo Maldonado"). Solo la usan las
-- funciones SECURITY DEFINER de abajo: no se expone a la app.
create or replace function public.nombre_coordinador(p_email text)
  returns text
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    (select nullif(btrim(u.nombre), '') from usuarios u
      where lower(u.email) = lower(p_email) order by u.id limit 1),
    split_part(coalesce(p_email, '(sin dueño)'), '@', 1)
  )
$function$;
revoke all on function public.nombre_coordinador(text) from public, anon, authenticated;


-- ══ PASO 4 — Vistas con el dueño (columnas nuevas AL FINAL) ══
do $mig$
declare
  v_opts text[];
begin
  select c.reloptions into v_opts from pg_class c
   where c.oid = to_regclass('public.vw_rutas_resumen');

  execute $vista$
    create or replace view public.vw_rutas_resumen as
    select r.id,
           r.numero,
           r.nombre,
           r.color,
           r.unidad_negocio,
           r.tipo_medio,
           r.activa,
           count(ru.id) as total_ubicaciones,
           count(*) filter (where ru.estatus_archivo = 'RETIRADA') as retiradas,
           count(*) filter (where ru.estatus_archivo = 'INHABILITADA') as inhabilitadas,
           -- CAMBIO (rutas por coordinador, 22-oct-2026)
           r.coordinador_email,
           coalesce((select nullif(btrim(u.nombre), '') from usuarios u
                      where lower(u.email) = r.coordinador_email order by u.id limit 1),
                    split_part(r.coordinador_email, '@', 1)) as coordinador_nombre
      from rutas_monitoreo r
      left join ruta_ubicaciones ru on ru.ruta_id = r.id
     group by r.id, r.numero, r.nombre, r.color, r.unidad_negocio, r.tipo_medio, r.activa,
              r.coordinador_email
     order by r.numero
  $vista$;

  if v_opts is not null and cardinality(v_opts) > 0 then
    execute format('alter view public.vw_rutas_resumen set (%s)', array_to_string(v_opts, ', '));
  end if;

  select c.reloptions into v_opts from pg_class c
   where c.oid = to_regclass('public.vw_rutas_con_coords');

  execute $vista$
    create or replace view public.vw_rutas_con_coords as
    select ru.id as ubicacion_id,
           ru.ruta_id,
           r.numero as ruta_numero,
           r.nombre as ruta_nombre,
           r.color as ruta_color,
           r.unidad_negocio as ruta_unidad,
           r.tipo_medio as ruta_tipo,
           r.activa as ruta_activa,
           ru.site_id,
           ru.secuencia,
           ru.estatus_archivo,
           ru.vallas_archivo,
           ru.direccion_archivo,
           inv.caras_reales,
           inv.latitud,
           inv.longitud,
           inv.municipio,
           inv.site_id is null as sin_match_inventario,
           dq.direccion as direccion_qtm,
           ru.direccion_fuente,
           case
             when ru.direccion_fuente = 'archivo'
                  and nullif(btrim(ru.direccion_archivo), '') is not null
               then ru.direccion_archivo
             else dq.direccion
           end as direccion,
           ru.origen,
           -- CAMBIO (rutas por coordinador, 22-oct-2026)
           r.coordinador_email as ruta_coordinador,
           coalesce((select nullif(btrim(u.nombre), '') from usuarios u
                      where lower(u.email) = r.coordinador_email order by u.id limit 1),
                    split_part(r.coordinador_email, '@', 1)) as ruta_coordinador_nombre
      from ruta_ubicaciones ru
      join rutas_monitoreo r on r.id = ru.ruta_id
      left join lateral (
        select i.site_id,
               count(*) as caras_reales,
               min(i.latitud) as latitud,
               min(i.longitud) as longitud,
               min(i.municipio) as municipio
          from inventario i
         where i.site_id = ru.site_id
           and i.unidad_negocio = r.unidad_negocio
           and (r.tipo_medio = 'Combinada' or i.tipo_medio = r.tipo_medio)
         group by i.site_id
      ) inv on true
      left join lateral (
        select i.direccion
          from inventario i
         where i.site_id = ru.site_id
           and i.unidad_negocio = r.unidad_negocio
           and (r.tipo_medio = 'Combinada' or i.tipo_medio = r.tipo_medio)
         order by i.vendor_face_id
         limit 1
      ) dq on true
  $vista$;

  if v_opts is not null and cardinality(v_opts) > 0 then
    execute format('alter view public.vw_rutas_con_coords set (%s)', array_to_string(v_opts, ', '));
  end if;
end $mig$;

revoke all on public.vw_rutas_resumen, public.vw_rutas_con_coords from anon;
grant select on public.vw_rutas_resumen, public.vw_rutas_con_coords to authenticated;


-- ══ PASO 5 — siguiente_numero_ruta, por dueño ══
drop function if exists public.siguiente_numero_ruta(text, text);
create or replace function public.siguiente_numero_ruta(p_unidad text, p_tipo text, p_coordinador text default null)
  returns integer
  language sql
  stable
  set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(max(numero), 0) + 1
    from rutas_monitoreo
   where unidad_negocio = p_unidad
     and tipo_medio = p_tipo
     and numero < 900
     -- CAMBIO (rutas por coordinador, 22-oct-2026)
     and coordinador_email = dueno_rutas(p_coordinador)
$function$;


-- ══ PASO 6 — guardar_paradas_ruta: solo el dueño; sitios ajenos fuera ══
create or replace function public.guardar_paradas_ruta(p_ruta_id bigint, p_site_ids text[], p_mover boolean default false)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
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


-- ══ PASO 7 — importar_rutas: por dueño y, desde la app, REEMPLAZANDO ══
-- Firma nueva (dos parámetros con default): se borra la de 3 para que la
-- llamada de sincronizar_rutas_desde_pauta (3 argumentos) no quede ambigua.
drop function if exists public.importar_rutas(text, text, jsonb);
create or replace function public.importar_rutas(
  p_unidad text,
  p_tipo text,
  p_filas jsonb,
  p_reemplazar boolean default false,
  p_coordinador text default null
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
declare
  fila          jsonb;
  v_ruta_id     bigint;
  v_numero      integer;
  v_site        text;
  v_dir         text;
  v_fuente      text;
  v_origen      text;
  v_motivo      text;
  v_email       text := lower(auth_email());
  v_omitidos_ej jsonb := '[]'::jsonb;
  insertadas    integer := 0;
  omitidas      integer := 0;
  rutas_creadas integer := 0;
  -- CAMBIO (rutas por coordinador, 22-oct-2026)
  v_dueno       text;
  v_sites_arch  text[] := '{}';
  v_nums_arch   integer[] := '{}';
  v_quitadas    integer := 0;
  v_borradas    jsonb := '[]'::jsonb;
  v_r           record;
begin
  -- Solo coordinador/admin pueden importar (patrón del sistema: tiene_rol)
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'No tienes permiso para importar rutas.';
  end if;

  -- CAMBIO (rutas por coordinador, 22-oct-2026): de quién son las rutas.
  v_dueno := dueno_rutas(p_coordinador);
  if v_dueno is null then
    raise exception 'No se pudo saber de qué coordinador son las rutas.';
  end if;

  for fila in select * from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb))
  loop
    v_site := nullif(btrim(fila->>'site_id'), '');

    v_motivo := null;
    if v_site is null then
      v_motivo := 'La fila no trae clave del sitio.';
    elsif coalesce(fila->>'ruta', '') !~ '^\s*\d{1,6}\s*$' then
      v_motivo := 'La ruta viene vacía o no es un número.';
    end if;
    -- CAMBIO (rutas por coordinador, 22-oct-2026; revisor-rls): todo sitio
    -- que el archivo nombra queda protegido del reemplazo, aunque su fila se
    -- omita (p. ej. ruta "EDOMEX" escrita con letras).
    if v_site is not null then
      v_sites_arch := v_sites_arch || v_site;
    end if;
    if v_motivo is not null then
      omitidas := omitidas + 1;
      if jsonb_array_length(v_omitidos_ej) < 8 then
        v_omitidos_ej := v_omitidos_ej
          || jsonb_build_array(jsonb_build_object('site_id', v_site, 'motivo', v_motivo));
      end if;
      continue;
    end if;

    v_numero := btrim(fila->>'ruta')::integer;

    -- CAMBIO (rutas por coordinador, 22-oct-2026): las rutas que trae el
    -- archivo, para reemplazar al final (aunque la fila se omita después, su
    -- ruta no se borra: el archivo sí la nombra).
    if not (v_numero = any(v_nums_arch)) then
      v_nums_arch := v_nums_arch || v_numero;
    end if;

    v_dir := nullif(btrim(coalesce(fila->>'direccion', '')), '');
    v_fuente := lower(nullif(btrim(fila->>'fuente_direccion'), ''));
    if v_fuente is not null and v_fuente not in ('qtm', 'archivo') then
      v_fuente := null;
    end if;
    v_origen := lower(coalesce(nullif(btrim(fila->>'origen'), ''), 'archivo'));
    if v_origen not in ('archivo', 'capas', 'pauta', 'app') then
      v_origen := 'archivo';
    end if;
    -- CAMBIO (rutas por coordinador, 22-oct-2026; revisor-rls): el origen lo
    -- manda el cliente. 'pauta' (que se salta las reglas de mover) solo vale
    -- en Ecovallas Impreso, que es lo único que sincroniza la pauta.
    if v_origen = 'pauta' and not (p_unidad = 'Ecovallas' and p_tipo = 'Impreso') then
      v_origen := 'archivo';
    end if;

    -- Un Excel NO mueve un sitio que hoy vive en una ruta de OTRA unidad o
    -- medio (entre una Combinada y una Impreso/Digital de la misma unidad
    -- sí). Sincronizar (origen 'pauta') sí puede: la pauta manda.
    -- CAMBIO (rutas por coordinador, 22-oct-2026): ni un sitio que está en
    -- una ruta de OTRO coordinador (se omite y se avisa).
    if v_origen <> 'pauta' then
      select 'Ya está en la Ruta ' || r.numero
             || coalesce(' · ' || nullif(r.nombre, ''), '')
             || case
                  when r.coordinador_email is distinct from v_dueno
                    then ' de ' || nombre_coordinador(r.coordinador_email)
                         || '; es de otro coordinador y no se mueve.'
                  else ' de ' || r.unidad_negocio || ' ' || r.tipo_medio
                       || '; no se mueve entre unidades o medios.'
                end
        into v_motivo
        from ruta_ubicaciones ru
        join rutas_monitoreo r on r.id = ru.ruta_id
       where ru.site_id = v_site
         and (r.coordinador_email is distinct from v_dueno
              or r.unidad_negocio is distinct from p_unidad
              or (r.tipo_medio is distinct from p_tipo
                  and r.tipo_medio is distinct from 'Combinada'
                  and p_tipo is distinct from 'Combinada'))
       limit 1;
      if v_motivo is not null then
        omitidas := omitidas + 1;
        if jsonb_array_length(v_omitidos_ej) < 8 then
          v_omitidos_ej := v_omitidos_ej
            || jsonb_build_array(jsonb_build_object('site_id', v_site, 'motivo', v_motivo));
        end if;
        continue;
      end if;
    end if;

    -- La ruta de este segmento.
    -- CAMBIO (rutas por coordinador, 22-oct-2026): la del dueño; la pauta
    -- usa la que tenga ese número aunque sea de otro coordinador, siempre la
    -- MÁS ANTIGUA (revisor-rls): si dos coordinadores tienen su Ruta 3 de
    -- Impreso, sincronizar no pasa los sitios de una a otra según quién lo
    -- corra.
    v_ruta_id := null;
    if v_origen = 'pauta' then
      select id into v_ruta_id
        from rutas_monitoreo
       where numero = v_numero and unidad_negocio = p_unidad and tipo_medio = p_tipo
       order by id
       limit 1;
    else
      select id into v_ruta_id
        from rutas_monitoreo
       where numero = v_numero and unidad_negocio = p_unidad and tipo_medio = p_tipo
         and coordinador_email = v_dueno
       limit 1;
    end if;

    if v_ruta_id is null then
      insert into rutas_monitoreo(numero, unidad_negocio, tipo_medio, color, coordinador_email)
        values (v_numero, p_unidad, p_tipo,
                (array['#ff5a3c','#4f8cff','#22c55e','#a78bfa','#f59e0b','#ec4899','#14b8a6','#f43f5e'])[1 + (v_numero % 8)],
                v_dueno)
        returning id into v_ruta_id;
      rutas_creadas := rutas_creadas + 1;
    end if;

    begin
      insert into ruta_ubicaciones(ruta_id, site_id, secuencia, estatus_archivo, vallas_archivo,
                                   direccion_archivo, direccion_fuente, origen, agregada_por)
        values (
          v_ruta_id,
          v_site,
          (fila->>'secuencia')::integer,
          fila->>'estatus',
          nullif(fila->>'vallas','')::integer,
          v_dir,
          coalesce(v_fuente, case when v_dir is not null then 'archivo' else 'qtm' end),
          v_origen,
          v_email
        )
      on conflict (site_id) do update set
        ruta_id = excluded.ruta_id,
        secuencia = excluded.secuencia,
        estatus_archivo = excluded.estatus_archivo,
        vallas_archivo = excluded.vallas_archivo,
        direccion_archivo = coalesce(excluded.direccion_archivo, ruta_ubicaciones.direccion_archivo),
        direccion_fuente = coalesce(v_fuente, ruta_ubicaciones.direccion_fuente),
        origen = excluded.origen,
        agregada_por = case when ruta_ubicaciones.ruta_id is distinct from excluded.ruta_id
                            then excluded.agregada_por
                            else ruta_ubicaciones.agregada_por end;
      insertadas := insertadas + 1;
    exception when others then
      omitidas := omitidas + 1;
      if jsonb_array_length(v_omitidos_ej) < 8 then
        v_motivo := case sqlstate
          when '22P02' then 'La secuencia o las vallas no son números.'
          when '22003' then 'La secuencia o las vallas están fuera de rango.'
          when '23502' then 'Falta un dato obligatorio.'
          else sqlerrm
        end;
        v_omitidos_ej := v_omitidos_ej
          || jsonb_build_array(jsonb_build_object('site_id', v_site, 'motivo', v_motivo));
      end if;
    end;
  end loop;

  -- CAMBIO (rutas por coordinador, 22-oct-2026): REEMPLAZAR (solo desde la
  -- pantalla de Rutas; Sincronizar no lo pide). Las rutas del dueño en esta
  -- unidad y medio quedan como el archivo: salen las paradas cuyo sitio no
  -- viene y se borran las rutas cuyo número no viene. Si no entró ninguna
  -- parada, no se borra nada (un archivo equivocado no vacía las rutas).
  if coalesce(p_reemplazar, false) then
    if insertadas = 0 then
      return jsonb_build_object(
        'rutas_creadas', rutas_creadas,
        'ubicaciones_procesadas', insertadas,
        'omitidas', omitidas,
        'omitidos_ejemplo', v_omitidos_ej,
        'reemplazo', jsonb_build_object(
          'hecho', false,
          'motivo', 'No entró ninguna parada del archivo: no se borró nada.'
        )
      );
    end if;

    -- Las 900+ (EDOMEX 901, PLAZA 902) son las foráneas de la pauta: el
    -- Excel no las borra ni les quita paradas (revisor-rls, 22-oct-2026).
    delete from ruta_ubicaciones ru
     using rutas_monitoreo r
     where ru.ruta_id = r.id
       and r.coordinador_email = v_dueno
       and r.unidad_negocio = p_unidad
       and r.tipo_medio = p_tipo
       and r.numero < 900
       and not (ru.site_id = any(v_sites_arch));
    get diagnostics v_quitadas = row_count;

    for v_r in
      select id, numero, nombre
        from rutas_monitoreo
       where coordinador_email = v_dueno
         and unidad_negocio = p_unidad
         and tipo_medio = p_tipo
         and numero < 900
         and not (numero = any(v_nums_arch))
       order by numero
    loop
      -- Igual que eliminar_ruta: asignaciones primero (aviso e historial) y
      -- revisiones.ruta_id, que no tiene ON DELETE, en nulo.
      delete from ruta_asignaciones where ruta_id = v_r.id;
      update revisiones set ruta_id = null where ruta_id = v_r.id;
      delete from rutas_monitoreo where id = v_r.id;
      v_borradas := v_borradas
        || jsonb_build_array(jsonb_build_object('numero', v_r.numero, 'nombre', v_r.nombre));
    end loop;
  end if;

  return jsonb_build_object(
    'rutas_creadas', rutas_creadas,
    'ubicaciones_procesadas', insertadas,
    'omitidas', omitidas,
    'omitidos_ejemplo', v_omitidos_ej,
    'reemplazo', case when coalesce(p_reemplazar, false) then jsonb_build_object(
                   'hecho', true,
                   'paradas_quitadas', v_quitadas,
                   'rutas_borradas', v_borradas
                 ) end
  );
end $function$;
revoke all on function public.importar_rutas(text, text, jsonb, boolean, text) from public, anon;
grant execute on function public.importar_rutas(text, text, jsonb, boolean, text) to authenticated, service_role;


-- ══ PASO 8 — importar_rutas_capas (KML y Excel de operación de Biobox) ══
drop function if exists public.importar_rutas_capas(text, jsonb, boolean, text[]);
create or replace function public.importar_rutas_capas(
  p_unidad text,
  p_capas jsonb,
  p_quitar_faltantes boolean default false,
  p_conservar text[] default '{}'::text[],
  p_coordinador text default null
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
declare
  v_capa        jsonb;
  v_parada      jsonb;
  v_nombre      text;
  v_ruta_id     bigint;
  v_numero      int;
  v_color       text;
  v_site        text;
  v_tipo        text;
  v_rutas_new   int := 0;
  v_rutas_usadas bigint[] := '{}';
  v_ubics       int := 0;
  v_omitidas    int := 0;
  v_movidas     int := 0;
  v_quitadas    int := 0;
  v_omitidos_ej text[] := '{}';
  v_sites_vistos text[] := '{}';
  v_protegidos  text[] := '{}';
  v_gemelas     jsonb := '[]'::jsonb;
  v_email       text := lower(auth_email());
  -- CAMBIO (rutas por coordinador, 22-oct-2026)
  v_dueno       text;
  v_ajeno       text;
  v_paleta text[] := array[
    '#4f8cff', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa',
    '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6',
    '#8b5cf6', '#eab308'
  ];
  v_i int := 0;
begin
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'No tienes permiso para importar rutas (se requiere coordinador o manager).';
  end if;

  if p_unidad is null then
    raise exception 'Falta la unidad de negocio.';
  end if;
  if p_capas is null or jsonb_array_length(p_capas) = 0 then
    raise exception 'El archivo no trae capas con marcadores.';
  end if;

  -- CAMBIO (rutas por coordinador, 22-oct-2026)
  v_dueno := dueno_rutas(p_coordinador);
  if v_dueno is null then
    raise exception 'No se pudo saber de qué coordinador son las rutas.';
  end if;

  for v_capa in select * from jsonb_array_elements(p_capas)
  loop
    v_i := v_i + 1;
    v_nombre := nullif(trim(v_capa->>'nombre'), '');
    if v_nombre is null then
      v_nombre := 'Capa ' || v_i;
    end if;

    for v_parada in select * from jsonb_array_elements(coalesce(v_capa->'paradas', '[]'::jsonb))
    loop
      v_site := nullif(trim(v_parada->>'site_id'), '');
      if v_site is null then
        v_omitidas := v_omitidas + 1;
        continue;
      end if;

      v_tipo := null;
      select tipo_medio into v_tipo
      from inventario
      where site_id = v_site and unidad_negocio = p_unidad
      limit 1;

      if v_tipo is null then
        v_omitidas := v_omitidas + 1;
        if array_length(v_omitidos_ej, 1) is null or array_length(v_omitidos_ej, 1) < 8 then
          v_omitidos_ej := v_omitidos_ej || v_site;
        end if;
        continue;
      end if;

      -- CAMBIO (rutas por coordinador, 22-oct-2026): una máquina que está en
      -- una ruta de OTRO coordinador no se mueve: se omite y se avisa.
      v_ajeno := null;
      select nombre_coordinador(r.coordinador_email)
        into v_ajeno
        from ruta_ubicaciones ru
        join rutas_monitoreo r on r.id = ru.ruta_id
       where ru.site_id = v_site
         and r.coordinador_email is distinct from v_dueno
       limit 1;
      if v_ajeno is not null then
        v_omitidas := v_omitidas + 1;
        -- Se protege igual que lo que no se importó: no es un faltante.
        v_sites_vistos := v_sites_vistos || v_site;
        if array_length(v_omitidos_ej, 1) is null or array_length(v_omitidos_ej, 1) < 8 then
          v_omitidos_ej := v_omitidos_ej || (v_site || ' (en una ruta de ' || v_ajeno || ')');
        end if;
        continue;
      end if;

      -- La ruta: por nombre, la Combinada gana.
      -- CAMBIO (rutas por coordinador, 22-oct-2026): solo entre las del dueño.
      v_ruta_id := null;
      select id, numero, color
        into v_ruta_id, v_numero, v_color
      from rutas_monitoreo
      where unidad_negocio = p_unidad
        and coordinador_email = v_dueno
        and (tipo_medio = v_tipo or tipo_medio = 'Combinada')
        and lower(regexp_replace(coalesce(nombre, ''), '\s+', ' ', 'g')) =
            lower(regexp_replace(v_nombre, '\s+', ' ', 'g'))
      order by (tipo_medio = 'Combinada') desc, id
      limit 1;

      if v_ruta_id is null then
        insert into rutas_monitoreo (
          numero, nombre, color, unidad_negocio, tipo_medio, descripcion, activa, coordinador_email
        )
        -- CAMBIO (rutas por coordinador, 22-oct-2026): numeración del dueño,
        -- sin contar las 900+ reservadas.
        select
          coalesce(max(numero) filter (where numero < 900), 0) + 1,
          v_nombre,
          v_paleta[1 + (v_i - 1) % array_length(v_paleta, 1)],
          p_unidad,
          v_tipo,
          'Importada del mapa de My Maps',
          true,
          v_dueno
        from rutas_monitoreo
        where unidad_negocio = p_unidad and tipo_medio = v_tipo
          and coordinador_email = v_dueno
        returning id into v_ruta_id;

        v_rutas_new := v_rutas_new + 1;
      end if;

      if exists (
        select 1 from ruta_ubicaciones
        where site_id = v_site and ruta_id <> v_ruta_id
      ) then
        v_movidas := v_movidas + 1;
      end if;

      insert into ruta_ubicaciones (ruta_id, site_id, secuencia, origen, agregada_por)
      values (v_ruta_id, v_site, nullif(v_parada->>'secuencia', '')::int, 'capas', v_email)
      on conflict (site_id) do update
        set ruta_id   = excluded.ruta_id,
            secuencia = excluded.secuencia,
            origen    = 'capas',
            agregada_por = case when ruta_ubicaciones.ruta_id is distinct from excluded.ruta_id
                                then excluded.agregada_por
                                else ruta_ubicaciones.agregada_por end;

      v_ubics := v_ubics + 1;
      v_sites_vistos := v_sites_vistos || v_site;
      if not (v_ruta_id = any(v_rutas_usadas)) then
        v_rutas_usadas := v_rutas_usadas || v_ruta_id;
      end if;
    end loop;
  end loop;

  -- Limpieza opcional de faltantes (las armadas en la app nunca).
  -- CAMBIO (rutas por coordinador, 22-oct-2026): solo en las rutas del dueño.
  v_protegidos := v_sites_vistos || coalesce(p_conservar, '{}');

  if array_length(v_protegidos, 1) is null then
    v_quitadas := 0;
  elsif p_quitar_faltantes then
    delete from ruta_ubicaciones ru
    using rutas_monitoreo r
    where ru.ruta_id = r.id
      and r.unidad_negocio = p_unidad
      and r.coordinador_email = v_dueno
      and not (ru.site_id = any(v_protegidos))
      and ru.origen is distinct from 'app';
    get diagnostics v_quitadas = row_count;
  else
    select count(*)
      into v_quitadas
    from ruta_ubicaciones ru
    join rutas_monitoreo r on r.id = ru.ruta_id
    where r.unidad_negocio = p_unidad
      and r.coordinador_email = v_dueno
      and not (ru.site_id = any(v_protegidos))
      and ru.origen is distinct from 'app';
  end if;

  -- Aviso de gemelas vacías (20-oct-2026).
  -- CAMBIO (rutas por coordinador, 22-oct-2026): solo las del dueño.
  select coalesce(jsonb_agg(jsonb_build_object(
           'ruta_id',      g.id,
           'numero',       g.numero,
           'tipo',         g.tipo_medio,
           'nombre',       g.nombre,
           'activa',       g.activa,
           'monitoristas', (select count(*) from ruta_asignaciones a where a.ruta_id = g.id)
         ) order by g.nombre, g.tipo_medio, g.numero), '[]'::jsonb)
    into v_gemelas
    from rutas_monitoreo g
   where g.unidad_negocio = p_unidad
     and g.coordinador_email = v_dueno
     and g.tipo_medio in ('Impreso', 'Digital')
     and nullif(btrim(g.nombre), '') is not null
     and not exists (select 1 from ruta_ubicaciones ru where ru.ruta_id = g.id)
     and exists (
       select 1 from rutas_monitoreo c
        where c.unidad_negocio = g.unidad_negocio
          and c.coordinador_email = g.coordinador_email
          and c.tipo_medio = 'Combinada'
          and lower(regexp_replace(coalesce(c.nombre, ''), '\s+', ' ', 'g')) =
              lower(regexp_replace(coalesce(g.nombre, ''), '\s+', ' ', 'g'))
     );

  return jsonb_build_object(
    'rutas_creadas',      v_rutas_new,
    'rutas_usadas',       coalesce(array_length(v_rutas_usadas, 1), 0),
    'ubicaciones',        v_ubics,
    'movidas_de_ruta',    v_movidas,
    'omitidas',           v_omitidas,
    'omitidos_ejemplo',   to_jsonb(v_omitidos_ej),
    'sobrantes',          v_quitadas,
    'sobrantes_borradas', p_quitar_faltantes,
    'gemelas_vacias',     v_gemelas
  );
end $function$;
revoke all on function public.importar_rutas_capas(text, jsonb, boolean, text[], text) from public, anon;
grant execute on function public.importar_rutas_capas(text, jsonb, boolean, text[], text) to authenticated, service_role;


-- ══ PASO 9 — eliminar_ruta ══
-- Borra una ruta completa: sus paradas y asignaciones se van con ella (ON
-- DELETE CASCADE; el aviso "se te retiró la ruta" les llega a sus
-- monitoristas), las visitas se conservan sin ruta (ON DELETE SET NULL) y
-- las revisiones de Biobox también (aquí se les quita la ruta: su llave no
-- tiene ON DELETE). Con p_solo_contar = true solo dice qué se perdería.
create or replace function public.eliminar_ruta(p_ruta_id bigint, p_solo_contar boolean default false)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
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
revoke all on function public.eliminar_ruta(bigint, boolean) from public, anon;
grant execute on function public.eliminar_ruta(bigint, boolean) to authenticated, service_role;


-- ══ PASO 10 — rutas_contexto: quién soy y qué coordinadores puedo ver ══
-- El manager recibe los coordinadores de la unidad (los que tienen el rol y
-- los dueños de rutas que ya existen); un coordinador, solo a sí mismo.
create or replace function public.rutas_contexto(p_unidad text)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
declare
  v_email   text := lower(auth_email());
  v_manager boolean := tiene_rol('manager'::app_role);
  v_lista   jsonb;
begin
  if not (tiene_rol('coordinador'::app_role) or v_manager) then
    raise exception 'No tienes permiso para ver rutas de coordinadores.';
  end if;

  if v_manager then
    select coalesce(jsonb_agg(jsonb_build_object('email', e.email, 'nombre', nombre_coordinador(e.email))
                              order by nombre_coordinador(e.email)), '[]'::jsonb)
      into v_lista
      from (
        select distinct lower(ur.usuario_email) as email
          from usuario_roles ur
         where ur.rol = 'coordinador'::app_role
           and (nullif(btrim(ur.unidad_negocio), '') is null or ur.unidad_negocio = p_unidad)
        union
        select coordinador_email from rutas_monitoreo where unidad_negocio = p_unidad
      ) e;
  else
    v_lista := jsonb_build_array(jsonb_build_object('email', v_email, 'nombre', nombre_coordinador(v_email)));
  end if;

  return jsonb_build_object('yo', v_email, 'es_manager', v_manager, 'coordinadores', v_lista);
end $function$;
revoke all on function public.rutas_contexto(text) from public, anon;
grant execute on function public.rutas_contexto(text) to authenticated, service_role;

revoke all on function public.dueno_rutas(text) from public, anon;
grant execute on function public.dueno_rutas(text) to authenticated, service_role;
revoke all on function public.siguiente_numero_ruta(text, text, text) from public, anon;
grant execute on function public.siguiente_numero_ruta(text, text, text) to authenticated, service_role;


-- ══ Verificación (solo lectura) ══
select jsonb_build_object(
  'rutas_sin_dueno', (select count(*) from public.rutas_monitoreo where coordinador_email is null),
  'rutas_por_dueno', (select jsonb_object_agg(k, n) from (
       select unidad_negocio || ' · ' || public.nombre_coordinador(coordinador_email) as k, count(*) as n
         from public.rutas_monitoreo group by 1) s),
  'paradas_en_vista', (select count(*) from public.vw_rutas_con_coords),
  'unique_nuevo', exists (select 1 from pg_constraint where conname = 'rutas_monitoreo_numero_segmento_coord_key'),
  'unique_viejo', exists (select 1 from pg_constraint where conname = 'rutas_monitoreo_numero_unidad_negocio_tipo_medio_key'),
  'importar_rutas_firmas', (select jsonb_agg(pg_get_function_identity_arguments(p.oid)) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'importar_rutas'),
  'capas_firmas', (select jsonb_agg(pg_get_function_identity_arguments(p.oid)) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'importar_rutas_capas'),
  'siguiente_firmas', (select jsonb_agg(pg_get_function_identity_arguments(p.oid)) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'siguiente_numero_ruta')
) as verificacion;
