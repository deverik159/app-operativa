-- ============================================================
-- rutas_combinadas — Biobox arma rutas con máquinas Impreso Y Digital
-- (Erik, 19-oct-2026). Re-ejecutable: todo es "or replace".
--
-- QUÉ CAMBIA
--   Una ruta puede tener tipo_medio = 'Combinada': acepta sitios de los
--   dos medios de su unidad. La app solo la ofrece en Biobox (botón
--   "Ambos" de Rutas de Operación). En Biobox ningún sitio tiene caras de
--   los dos medios (revisado el 19-oct-2026), así que cada máquina sigue
--   siendo de un solo medio; lo combinado es la RUTA.
--   tipo_medio es texto libre (sin check) y el UNIQUE(numero, unidad,
--   tipo_medio) deja a las combinadas su propia numeración: no se toca la
--   tabla. siguiente_numero_ruta(p_unidad, 'Combinada') ya sirve tal cual.
--
--   1) ruta_ubic_valida_segmento(): en una ruta Combinada basta con que el
--      sitio tenga caras de la UNIDAD de la ruta.
--   2) vw_rutas_con_coords: coordenadas y dirección de QTM de cualquier
--      medio de la unidad cuando la ruta es Combinada. Mismas columnas, en
--      el mismo orden (create or replace view lo exige).
--   3) guardar_paradas_ruta(): una Combinada acepta sitios de los dos
--      medios, y entre una Combinada y una Impreso/Digital de la MISMA
--      unidad un sitio sí se mueve (con la confirmación de siempre). Entre
--      unidades, o entre Impreso y Digital, sigue sin moverse desde aquí.
--   4) importar_rutas_capas() (KML y Excel de operación de Biobox): si
--      existe una ruta Combinada con el nombre de la capa, las máquinas van
--      a ella en vez de partirse en dos rutas gemelas Impreso/Digital.
--
-- El resto de cada función es el de producción del 19-oct-2026
-- (pg_get_functiondef); los cambios van marcados con
-- "CAMBIO (rutas combinadas, 19-oct-2026)".
-- ============================================================

set lock_timeout = '5s';


-- ══ PASO 1 — Trigger de segmento ══
create or replace function public.ruta_ubic_valida_segmento()
  returns trigger
  language plpgsql
as $function$
declare
  r_unidad text; r_tipo text;
  existe_match boolean;
begin
  select unidad_negocio, tipo_medio into r_unidad, r_tipo
    from rutas_monitoreo where id = new.ruta_id;

  -- ¿Hay al menos una cara de ese site_id con la unidad/tipo de la ruta?
  -- CAMBIO (rutas combinadas, 19-oct-2026): en una ruta Combinada vale
  -- cualquier medio de la unidad.
  select exists(
    select 1 from inventario
    where site_id = new.site_id
      and unidad_negocio = r_unidad
      and (r_tipo = 'Combinada' or tipo_medio = r_tipo)
  ) into existe_match;

  -- Si el site_id no está en inventario, se permite (queda sin coords, se revisa aparte).
  if not exists(select 1 from inventario where site_id = new.site_id) then
    return new;
  end if;

  if not existe_match then
    raise exception 'La ubicación % no tiene caras del segmento de la ruta (%/%)',
      new.site_id, r_unidad, r_tipo;
  end if;

  return new;
end $function$;


-- ══ PASO 2 — vw_rutas_con_coords ══
-- Hoy no tiene opciones (reloptions vacío, revisado el 19-oct-2026); igual
-- se leen y se vuelven a poner, como en la migración del 5-oct-2026.
do $mig$
declare
  v_opts text[];
begin
  select c.reloptions into v_opts
    from pg_class c
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
           ru.origen
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
           -- CAMBIO (rutas combinadas, 19-oct-2026)
           and (r.tipo_medio = 'Combinada' or i.tipo_medio = r.tipo_medio)
         group by i.site_id
      ) inv on true
      left join lateral (
        select i.direccion
          from inventario i
         where i.site_id = ru.site_id
           and i.unidad_negocio = r.unidad_negocio
           -- CAMBIO (rutas combinadas, 19-oct-2026)
           and (r.tipo_medio = 'Combinada' or i.tipo_medio = r.tipo_medio)
         order by i.vendor_face_id
         limit 1
      ) dq on true
  $vista$;

  if v_opts is not null and cardinality(v_opts) > 0 then
    execute format('alter view public.vw_rutas_con_coords set (%s)', array_to_string(v_opts, ', '));
  end if;
end $mig$;

revoke all on public.vw_rutas_con_coords from anon;
grant select on public.vw_rutas_con_coords to authenticated;


-- ══ PASO 3 — guardar_paradas_ruta ══
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
  select id, numero, nombre, unidad_negocio, tipo_medio
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
           -- CAMBIO (rutas combinadas, 19-oct-2026): Combinada acepta los
           -- dos medios de su unidad.
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

  -- 1b) (revisión, 5-oct-2026) Un sitio que HOY vive en una ruta de OTRO
  --     segmento (otra unidad o medio) no se mueve desde aquí. Caso real:
  --     un site_id con caras Digital e Impreso de Ecovallas; armar la ruta
  --     Digital lo sacaba de su ruta de Pauta, Pauta quedaba apuntando a la
  --     ruta equivocada y el siguiente "Sincronizar rutas" lo regresaba sin
  --     avisar (el sitio brincaba entre las dos). Se rechaza con motivo.
  --     CAMBIO (rutas combinadas, 19-oct-2026): entre una Combinada y una
  --     Impreso/Digital de la MISMA unidad sí se mueve (con confirmación).
  select coalesce(jsonb_agg(jsonb_build_object(
           'site_id', ru.site_id,
           'motivo', 'Ya está en la Ruta ' || r.numero
                     || coalesce(' · ' || nullif(r.nombre, ''), '')
                     || ' de ' || r.unidad_negocio || ' ' || r.tipo_medio
                     || case when lower(r.unidad_negocio) = 'ecovallas' and lower(r.tipo_medio) = 'impreso'
                          then ' (la manda la pauta)' else '' end
                     || '; no se mueve entre unidades o medios.'
         ) order by ru.site_id), '[]'::jsonb),
         coalesce(array_agg(ru.site_id), '{}'::text[])
    into v_otro_seg, v_fuera
    from ruta_ubicaciones ru
    join rutas_monitoreo r on r.id = ru.ruta_id
   where ru.site_id = any(v_final)
     and ru.ruta_id <> p_ruta_id
     and (r.unidad_negocio is distinct from v_ruta.unidad_negocio
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

  -- 2) ¿Alguno vive en otra ruta? (Un sitio está en UNA sola ruta:
  --    UNIQUE(site_id).) Después del 1b solo quedan rutas del MISMO
  --    segmento (o una Combinada de la misma unidad); unidad y medio van
  --    para que la pantalla no tenga que suponerlo.
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
    -- a) Las de ESTA ruta que ya no vienen.
    delete from ruta_ubicaciones
     where ruta_id = p_ruta_id
       and not (site_id = any(v_final));
    get diagnostics v_quitadas = row_count;

    -- b) Las que ya estaban aquí: solo su lugar.
    update ruta_ubicaciones ru
       set secuencia = f.n::int
      from unnest(v_final) with ordinality as f(s, n)
     where ru.site_id = f.s
       and ru.ruta_id = p_ruta_id;

    -- c) Las de otras rutas: se mueven (la dirección elegida viaja con el
    --    sitio).
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

    -- d) Las nuevas.
    insert into ruta_ubicaciones (ruta_id, site_id, secuencia, origen, agregada_por, direccion_fuente)
    select p_ruta_id, f.s, f.n::int, 'app', v_email, 'qtm'
      from unnest(v_final) with ordinality as f(s, n)
     where not exists (select 1 from ruta_ubicaciones ru where ru.site_id = f.s);
    get diagnostics v_nuevas = row_count;

    -- e) (QA, 5-oct-2026) La ruta de la que salió un sitio quedaba con un
    --    hueco (1, 2, 4…) y el monitorista veía "parada 4" de 3. Se
    --    renumeran 1..n en su mismo orden. El trigger de segmento ya no
    --    corre al cambiar solo la secuencia (PASO 1).
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
    -- Otra persona metió el mismo sitio en otra ruta entre la revisión y
    -- el guardado. No se guarda nada; al reintentar sale el aviso normal.
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


-- ══ PASO 4 — importar_rutas_capas (KML y Excel de operación de Biobox) ══
create or replace function public.importar_rutas_capas(p_unidad text, p_capas jsonb, p_quitar_faltantes boolean default false, p_conservar text[] default '{}'::text[])
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
  v_email       text := lower(auth_email());
  -- Paleta fija: mismo orden de capas → mismos colores en cada importación.
  v_paleta text[] := array[
    '#4f8cff', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa',
    '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6',
    '#8b5cf6', '#eab308'
  ];
  v_i int := 0;
begin
  -- 1) Permiso. Mismas funciones que el resto del proyecto.
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'No tienes permiso para importar rutas (se requiere coordinador o manager).';
  end if;

  if p_unidad is null then
    raise exception 'Falta la unidad de negocio.';
  end if;
  if p_capas is null or jsonb_array_length(p_capas) = 0 then
    raise exception 'El archivo no trae capas con marcadores.';
  end if;

  -- 2) Capa por capa
  for v_capa in select * from jsonb_array_elements(p_capas)
  loop
    v_i := v_i + 1;
    v_nombre := nullif(trim(v_capa->>'nombre'), '');
    if v_nombre is null then
      v_nombre := 'Capa ' || v_i;
    end if;

    -- 3) Paradas de la capa. La ruta se resuelve DENTRO del ciclo, porque
    --    depende del tipo de medio de cada máquina (ver el encabezado).
    for v_parada in select * from jsonb_array_elements(coalesce(v_capa->'paradas', '[]'::jsonb))
    loop
      v_site := nullif(trim(v_parada->>'site_id'), '');
      if v_site is null then
        v_omitidas := v_omitidas + 1;
        continue;
      end if;

      -- El tipo de medio se toma de INVENTARIO, no de lo que mande el
      -- frontend: es la única fuente que el trigger va a aceptar. De paso
      -- comprueba que la máquina exista en esta unidad; si no, se omite la
      -- fila y se sigue, en vez de abortar la importación completa por una
      -- máquina mal empatada.
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

      -- La ruta de ESTE segmento. Se busca por nombre (sin distinguir
      -- mayúsculas ni espacios de más: en el mapa se escribe a mano) y se
      -- reutiliza su número y color. Renumerar en cada importación dejaría
      -- el histórico de revisiones apuntando a rutas que cambiaron de
      -- identidad.
      -- CAMBIO (rutas combinadas, 19-oct-2026): si hay una ruta Combinada
      -- con ese nombre, gana: las máquinas de los dos medios van juntas a
      -- ella en vez de partirse en gemelas Impreso/Digital.
      select id, numero, color
        into v_ruta_id, v_numero, v_color
      from rutas_monitoreo
      where unidad_negocio = p_unidad
        and (tipo_medio = v_tipo or tipo_medio = 'Combinada')
        and lower(regexp_replace(coalesce(nombre, ''), '\s+', ' ', 'g')) =
            lower(regexp_replace(v_nombre, '\s+', ' ', 'g'))
      order by (tipo_medio = 'Combinada') desc, id
      limit 1;

      if v_ruta_id is null then
        insert into rutas_monitoreo (
          numero, nombre, color, unidad_negocio, tipo_medio, descripcion, activa
        )
        select
          coalesce(max(numero), 0) + 1,
          v_nombre,
          v_paleta[1 + (v_i - 1) % array_length(v_paleta, 1)],
          p_unidad,
          v_tipo,
          'Importada del mapa de My Maps',
          true
        from rutas_monitoreo
        where unidad_negocio = p_unidad and tipo_medio = v_tipo
        returning id into v_ruta_id;

        v_rutas_new := v_rutas_new + 1;
      end if;

      -- Una máquina vive en UNA ruta: ruta_ubicaciones tiene UNIQUE(site_id).
      -- Si ya estaba en otra, se mueve y se cuenta, porque mover máquinas
      -- entre rutas es justo lo que hace la gente al reorganizar el mapa.
      if exists (
        select 1 from ruta_ubicaciones
        where site_id = v_site and ruta_id <> v_ruta_id
      ) then
        v_movidas := v_movidas + 1;
      end if;

      -- CAMBIO (rutas, 5-oct-2026): origen y agregada_por.
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

  -- 4) Limpieza opcional: máquinas que están en rutas de esta UNIDAD pero
  --    ya no aparecen en el mapa. Alcanza a los dos tipos de medio, porque
  --    el mapa es la lista completa de la unidad, no de un segmento.
  --    "Faltante" = no estaba en el mapa. Se protege tanto lo insertado
  --    (v_sites_vistos) como lo que el mapa traía pero no se importó
  --    (p_conservar).
  --
  --    OJO: si el arreglo protegido quedara vacío, el `not (x = any('{}'))`
  --    es TRUE para todas las filas y esto borraría el segmento completo. De
  --    ahí el guard.
  --    CAMBIO (rutas, 5-oct-2026): las paradas con origen = 'app' no se
  --    borran ni se cuentan (ver el encabezado del PASO). `is distinct
  --    from`: las de antes (origen nulo) siguen como hoy.
  v_protegidos := v_sites_vistos || coalesce(p_conservar, '{}');

  if array_length(v_protegidos, 1) is null then
    v_quitadas := 0;
  elsif p_quitar_faltantes then
    delete from ruta_ubicaciones ru
    using rutas_monitoreo r
    where ru.ruta_id = r.id
      and r.unidad_negocio = p_unidad
      and not (ru.site_id = any(v_protegidos))
      and ru.origen is distinct from 'app';
    get diagnostics v_quitadas = row_count;
  else
    select count(*)
      into v_quitadas
    from ruta_ubicaciones ru
    join rutas_monitoreo r on r.id = ru.ruta_id
    where r.unidad_negocio = p_unidad
      and not (ru.site_id = any(v_protegidos))
      and ru.origen is distinct from 'app';
  end if;

  return jsonb_build_object(
    'rutas_creadas',      v_rutas_new,
    'rutas_usadas',       coalesce(array_length(v_rutas_usadas, 1), 0),
    'ubicaciones',        v_ubics,
    'movidas_de_ruta',    v_movidas,
    'omitidas',           v_omitidas,
    'omitidos_ejemplo',   to_jsonb(v_omitidos_ej),
    -- Si p_quitar_faltantes fue false, esto es un AVISO: cuántas sobran.
    -- (Sin contar las armadas en la app: esas nunca se quitan.)
    'sobrantes',          v_quitadas,
    'sobrantes_borradas', p_quitar_faltantes
  );
end $function$;


-- ══ Verificación (solo lectura) ══
select jsonb_build_object(
  'trigger_acepta_combinada',
    (select position('Combinada' in p.prosrc) > 0 from pg_proc p
      where p.oid = to_regprocedure('public.ruta_ubic_valida_segmento()')),
  'guardar_acepta_combinada',
    (select position('Combinada' in p.prosrc) > 0 from pg_proc p
      where p.oid = to_regprocedure('public.guardar_paradas_ruta(bigint,text[],boolean)')),
  'capas_prefiere_combinada',
    (select position('Combinada' in p.prosrc) > 0 from pg_proc p
      where p.oid = to_regprocedure('public.importar_rutas_capas(text,jsonb,boolean,text[])')),
  'vista_acepta_combinada',
    position('Combinada' in pg_get_viewdef('public.vw_rutas_con_coords'::regclass)) > 0,
  'paradas_en_vista',
    (select count(*) from public.vw_rutas_con_coords),
  'paradas_con_coords',
    (select count(*) from public.vw_rutas_con_coords where latitud is not null),
  'rutas_por_segmento',
    (select jsonb_object_agg(s.k, s.n)
       from (select unidad_negocio || ' ' || tipo_medio as k, count(*) as n
               from public.rutas_monitoreo group by 1) s)
) as verificacion;
