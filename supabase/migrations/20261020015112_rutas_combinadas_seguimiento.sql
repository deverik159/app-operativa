-- ============================================================
-- rutas_combinadas_seguimiento — seguimiento de 20261019235423_rutas_combinadas
-- (hallazgos del revisor-rls del 19-oct-2026). Re-ejecutable: el check se
-- agrega solo si no existe y las funciones son "or replace".
--
-- QUÉ CAMBIA
--   1) CHECK rutas_monitoreo_tipo_medio_chk: tipo_medio solo puede ser
--      'Impreso', 'Digital' o 'Combinada', y 'Combinada' SOLO en Biobox.
--      Hasta hoy la regla vivía nada más en la pantalla (admiteCombinada()
--      en src/modules/rutas/rutasComun.ts): un insert directo o un importador
--      podían crear una Combinada en Ecovallas, donde 75 sitios tienen caras
--      Impreso y Digital, y reabrir el brinco de sitios entre las rutas de
--      Pauta y "Sincronizar rutas" que se corrigió el 5-oct-2026.
--      Se agrega NOT VALID y luego se valida. Al 20-oct-2026 (UTC) las 35
--      rutas lo cumplen (la única Combinada es la de prueba de Biobox).
--   2) importar_rutas (Excel por número y Sincronizar de Pauta): el paso 1b
--      queda igual que el de guardar_paradas_ruta: un sitio sí se mueve entre
--      una Combinada y una Impreso/Digital de la MISMA unidad. Hoy no cambia
--      nada en la práctica: el Excel genérico no se ofrece en Biobox y, con
--      el check del PASO 1, fuera de Biobox no puede haber Combinadas. Queda
--      alineado para que las dos funciones apliquen la misma regla.
--   3) ruta_ubic_valida_segmento(): set search_path = public, pg_temp (aviso
--      function_search_path_mutable del advisor). Mismo cuerpo, mismo dueño.
--   4) importar_rutas_capas (KML y Excel de operación de Biobox): devuelve
--      además 'gemelas_vacias': las rutas Impreso/Digital de la unidad que
--      tienen una Combinada con su mismo nombre y quedaron sin paradas, con
--      cuántos monitoristas siguen asignados. Solo informa; no borra ni
--      desasigna nada. La pantalla todavía no muestra esa llave (las llaves
--      que no conoce las ignora): va en un cambio de código aparte.
--
-- NO TOCA: vw_rutas_con_coords (sigue como SECURITY DEFINER; cambiarla a
-- invoker sí cambia qué ve cada rol), ni la parada de Ecovallas Impreso que
-- ya no cumple la regla del trigger (dato, no esquema).
--
-- El resto de cada función es el de producción del 20-oct-2026 (UTC),
-- comparado byte a byte con pg_get_functiondef; los cambios van marcados
-- con "CAMBIO (seguimiento combinadas, 20-oct-2026)".
-- ============================================================

set lock_timeout = '5s';


-- ══ PASO 1 — CHECK en rutas_monitoreo ══
-- Primero se comprueba con nombre y apellido: si alguna ruta no cumple, se
-- aborta aquí con la lista, en vez de fallar en el VALIDATE con un mensaje
-- genérico. Las dos columnas son NOT NULL, así que el check no deja huecos.
do $mig$
declare
  v_malas text;
begin
  select string_agg(format('id %s (%s %s)', id, unidad_negocio, tipo_medio), ', ' order by id)
    into v_malas
    from public.rutas_monitoreo
   where not (tipo_medio in ('Impreso', 'Digital')
              or (tipo_medio = 'Combinada' and unidad_negocio = 'Biobox'));
  if v_malas is not null then
    raise exception 'No se agrega el check: hay rutas que no lo cumplen: %', v_malas;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.rutas_monitoreo'::regclass
       and conname = 'rutas_monitoreo_tipo_medio_chk'
  ) then
    alter table public.rutas_monitoreo
      add constraint rutas_monitoreo_tipo_medio_chk
      check (tipo_medio in ('Impreso', 'Digital')
             or (tipo_medio = 'Combinada' and unidad_negocio = 'Biobox'))
      not valid;
  end if;
end $mig$;

-- Si ya estaba validado, esto no hace nada.
alter table public.rutas_monitoreo validate constraint rutas_monitoreo_tipo_medio_chk;

comment on constraint rutas_monitoreo_tipo_medio_chk on public.rutas_monitoreo is
  'tipo_medio: Impreso, Digital o Combinada; Combinada solo en Biobox (Erik, 19-oct-2026). '
  'Misma regla que admiteCombinada() en src/modules/rutas/rutasComun.ts.';


-- ══ PASO 2 — importar_rutas: paso 1b alineado con guardar_paradas_ruta ══
-- Cuerpo de producción (migración rutas_armado_visitas, 5-oct-2026) con un
-- solo cambio en el bloque "(corrector, 5-oct-2026)".
create or replace function public.importar_rutas(p_unidad text, p_tipo text, p_filas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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
begin
  -- Solo coordinador/admin pueden importar (patrón del sistema: tiene_rol)
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'No tienes permiso para importar rutas.';
  end if;

  -- Recorre cada fila del archivo
  for fila in select * from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb))
  loop
    v_site := nullif(btrim(fila->>'site_id'), '');

    -- CAMBIO (rutas, 5-oct-2026): una fila mala se omite con su motivo en
    -- vez de tronar toda la importación.
    v_motivo := null;
    if v_site is null then
      v_motivo := 'La fila no trae clave del sitio.';
    elsif coalesce(fila->>'ruta', '') !~ '^\s*\d{1,6}\s*$' then
      v_motivo := 'La ruta viene vacía o no es un número.';
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

    -- CAMBIO (rutas, 5-oct-2026): dirección elegida y origen.
    v_dir := nullif(btrim(coalesce(fila->>'direccion', '')), '');
    v_fuente := lower(nullif(btrim(fila->>'fuente_direccion'), ''));
    if v_fuente is not null and v_fuente not in ('qtm', 'archivo') then
      v_fuente := null;
    end if;
    v_origen := lower(coalesce(nullif(btrim(fila->>'origen'), ''), 'archivo'));
    if v_origen not in ('archivo', 'capas', 'pauta', 'app') then
      v_origen := 'archivo';
    end if;

    -- (corrector, 5-oct-2026) Un Excel NO mueve un sitio que hoy vive en
    -- una ruta de OTRA unidad o medio: misma regla que guardar_paradas_ruta
    -- (paso 1b). Caso real: site_id con caras Digital e Impreso de
    -- Ecovallas; el Excel de Digital lo sacaba de su ruta de Pauta y el
    -- siguiente "Sincronizar rutas" lo regresaba (brincaba entre las dos).
    -- Sincronizar (origen 'pauta') sí puede: la pauta manda en su segmento.
    -- CAMBIO (seguimiento combinadas, 20-oct-2026): igual que en
    -- guardar_paradas_ruta desde el 19-oct-2026, entre una Combinada y una
    -- Impreso/Digital de la MISMA unidad sí se mueve. Entre unidades, o
    -- entre Impreso y Digital, sigue sin moverse.
    if v_origen <> 'pauta' then
      select 'Ya está en la Ruta ' || r.numero
             || coalesce(' · ' || nullif(r.nombre, ''), '')
             || ' de ' || r.unidad_negocio || ' ' || r.tipo_medio
             || '; no se mueve entre unidades o medios.'
        into v_motivo
        from ruta_ubicaciones ru
        join rutas_monitoreo r on r.id = ru.ruta_id
       where ru.site_id = v_site
         and (r.unidad_negocio is distinct from p_unidad
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

    -- crea la ruta si no existe (para este segmento)
    select id into v_ruta_id
      from rutas_monitoreo
      where numero = v_numero and unidad_negocio = p_unidad and tipo_medio = p_tipo;

    if v_ruta_id is null then
      insert into rutas_monitoreo(numero, unidad_negocio, tipo_medio, color)
        values (v_numero, p_unidad, p_tipo,
                -- color por número de ruta (paleta que rota)
                (array['#ff5a3c','#4f8cff','#22c55e','#a78bfa','#f59e0b','#ec4899','#14b8a6','#f43f5e'])[1 + (v_numero % 8)])
        returning id into v_ruta_id;
      rutas_creadas := rutas_creadas + 1;
    end if;

    -- inserta/actualiza la ubicación (upsert por site_id)
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
        -- CAMBIO: una fila sin dirección ya no borra la que había.
        direccion_archivo = coalesce(excluded.direccion_archivo, ruta_ubicaciones.direccion_archivo),
        -- CAMBIO: la elección solo cambia si el archivo la trae.
        direccion_fuente = coalesce(v_fuente, ruta_ubicaciones.direccion_fuente),
        origen = excluded.origen,
        -- Quién la puso en su ruta ACTUAL: solo cambia si cambió de ruta.
        agregada_por = case when ruta_ubicaciones.ruta_id is distinct from excluded.ruta_id
                            then excluded.agregada_por
                            else ruta_ubicaciones.agregada_por end;
      insertadas := insertadas + 1;
    exception when others then
      -- si la salvaguarda de segmento la rechaza (u otro error), la cuenta
      -- como omitida — y ahora dice cuál y por qué.
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

  return jsonb_build_object(
    'rutas_creadas', rutas_creadas,
    'ubicaciones_procesadas', insertadas,
    'omitidas', omitidas,
    'omitidos_ejemplo', v_omitidos_ej
  );
end $function$;

comment on function public.importar_rutas(text, text, jsonb) is
  'Excel de rutas / Sincronizar de Pauta. Filas [{site_id, ruta, secuencia, estatus, vallas, '
  'direccion, fuente_direccion?, origen?}]. Devuelve {rutas_creadas, ubicaciones_procesadas, '
  'omitidas, omitidos_ejemplo:[{site_id, motivo}]}. Ver la migración rutas_armado_visitas (5-oct-2026); '
  'paso 1b alineado con guardar_paradas_ruta (Combinadas) en rutas_combinadas_seguimiento (20-oct-2026).';

-- create or replace conserva los permisos; se repiten para que queden a la
-- vista (mismos que hoy: authenticated y service_role, nada para anon).
revoke all on function public.importar_rutas(text, text, jsonb) from public, anon;
grant execute on function public.importar_rutas(text, text, jsonb) to authenticated, service_role;


-- ══ PASO 3 — ruta_ubic_valida_segmento(): search_path fijo ══
-- Función de trigger (no es SECURITY DEFINER). Solo usa tablas de public sin
-- esquema, así que fijarlo no cambia qué resuelve; quita el aviso del advisor.
alter function public.ruta_ubic_valida_segmento() set search_path = public, pg_temp;


-- ══ PASO 4 — importar_rutas_capas: aviso de gemelas vacías ══
-- Cuerpo de producción (migración rutas_combinadas, 19-oct-2026) más la
-- variable v_gemelas, el bloque 5) y la llave 'gemelas_vacias' del resultado.
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
  -- CAMBIO (seguimiento combinadas, 20-oct-2026)
  v_gemelas     jsonb := '[]'::jsonb;
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

  -- 5) CAMBIO (seguimiento combinadas, 20-oct-2026): aviso de gemelas vacías.
  --    Cuando una capa cae en una Combinada (paso 3), las rutas Impreso y
  --    Digital que tenían su mismo nombre se quedan sin paradas pero
  --    conservan a sus monitoristas, que verían una ruta vacía en Mis rutas
  --    (también las inactivas: Mis rutas las enseña con la marca "ruta
  --    inactiva"). Se informa cuáles son (mismo nombre que una Combinada de
  --    la unidad y 0 paradas) y cuántos monitoristas tiene cada una. Solo
  --    informa: no se borra ni se desasigna nada; eso lo decide el
  --    coordinador en la pantalla.
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
     and g.tipo_medio in ('Impreso', 'Digital')
     -- (revisor-rls, 20-oct-2026) Sin nombre no hay gemela: dos rutas sin
     -- nombre empatarían entre sí aunque no tengan nada que ver.
     and nullif(btrim(g.nombre), '') is not null
     and not exists (select 1 from ruta_ubicaciones ru where ru.ruta_id = g.id)
     and exists (
       select 1 from rutas_monitoreo c
        where c.unidad_negocio = g.unidad_negocio
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
    -- Si p_quitar_faltantes fue false, esto es un AVISO: cuántas sobran.
    -- (Sin contar las armadas en la app: esas nunca se quitan.)
    'sobrantes',          v_quitadas,
    'sobrantes_borradas', p_quitar_faltantes,
    -- CAMBIO (seguimiento combinadas, 20-oct-2026): [{ruta_id, numero, tipo,
    -- nombre, activa, monitoristas}]; vacío si no hay. La pantalla aún no lo
    -- muestra.
    'gemelas_vacias',     v_gemelas
  );
end $function$;

revoke all on function public.importar_rutas_capas(text, jsonb, boolean, text[]) from public, anon;
grant execute on function public.importar_rutas_capas(text, jsonb, boolean, text[]) to authenticated, service_role;


-- ══ Verificación (solo lectura) ══
select jsonb_build_object(
  'check_existe_y_validado',
    (select convalidated from pg_constraint
      where conrelid = 'public.rutas_monitoreo'::regclass
        and conname = 'rutas_monitoreo_tipo_medio_chk'),
  'importar_rutas_acepta_combinada',
    (select position('Combinada' in p.prosrc) > 0 from pg_proc p
      where p.oid = to_regprocedure('public.importar_rutas(text,text,jsonb)')),
  'trigger_con_search_path',
    (select p.proconfig from pg_proc p
      where p.oid = to_regprocedure('public.ruta_ubic_valida_segmento()')),
  'capas_informa_gemelas',
    (select position('gemelas_vacias' in p.prosrc) > 0 from pg_proc p
      where p.oid = to_regprocedure('public.importar_rutas_capas(text,jsonb,boolean,text[])')),
  'rutas_por_segmento',
    (select jsonb_object_agg(s.k, s.n)
       from (select unidad_negocio || ' ' || tipo_medio as k, count(*) as n
               from public.rutas_monitoreo group by 1) s),
  'gemelas_vacias_hoy',
    (select count(*)
       from public.rutas_monitoreo g
      where g.tipo_medio in ('Impreso', 'Digital')
        and nullif(btrim(g.nombre), '') is not null
        and not exists (select 1 from public.ruta_ubicaciones ru where ru.ruta_id = g.id)
        and exists (select 1 from public.rutas_monitoreo c
                     where c.unidad_negocio = g.unidad_negocio and c.tipo_medio = 'Combinada'
                       and lower(regexp_replace(coalesce(c.nombre, ''), '\s+', ' ', 'g')) =
                           lower(regexp_replace(coalesce(g.nombre, ''), '\s+', ' ', 'g'))))
) as verificacion;
