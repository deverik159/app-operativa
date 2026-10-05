-- ============================================================
-- rutas_armado_visitas — Rutas de Monitoreo automatizado (Erik, 5-oct-2026).
-- Re-ejecutable: "if not exists", "or replace", "drop … if exists" y el
-- respaldo de datos protegido con una guarda (corre UNA vez).
--
-- QUÉ HABILITA
--   1) "+ Nueva ruta" se arma desde el inventario en la app:
--      guardar_paradas_ruta() guarda la lista de sitios de UNA ruta en el
--      orden elegido, en una sola transacción, y AVISA (sin mover nada) si
--      un sitio ya está en otra ruta; solo lo mueve con confirmación
--      (p_mover = true). siguiente_numero_ruta() sugiere el número.
--      Ecovallas Impreso NO se arma aquí: ahí manda la pauta (Pauta →
--      Sincronizar rutas), y la función lo rechaza con mensaje.
--   2) Dirección elegida al importar: nadie la corrige en campo. Quien
--      importa el Excel de rutas escoge, por sitio, si se queda la de QTM
--      (inventario, viva: si QTM la corrige, se ve sola) o la del archivo.
--      Se guarda en ruta_ubicaciones.direccion_fuente y la vista
--      vw_rutas_con_coords ya entrega la dirección elegida en `direccion`.
--      (Erik, 5-oct-2026) Excepción de INCIDENCIAS, no de la vista: en
--      Ecovallas Impreso la incidencia nueva lleva la de QTM
--      (`direccion_qtm`) aunque la parada esté en 'archivo', porque esa
--      dirección es la de la pauta, cambia cada catorcena y nadie la
--      eligió. La app decide con ruta_unidad/ruta_tipo; la vista no cambia.
--   3) ruta_visitas: el monitorista marca "visité este sitio" desde Mis
--      rutas (foto, GPS si se puede y la hora del teléfono). La llave
--      cliente_id la genera el teléfono: la cola sin señal puede reenviar
--      sin duplicar. (Erik, 5-oct-2026) Una visita marcada sin señal se
--      ACEPTA si se hizo mientras la ruta era suya, aunque al llegar ya se
--      la hayan quitado: ruta_asignaciones_historial + puede_registrar_visita
--      (PASO 9b).
--   4) Asignar monitoristas (Rutas y Pauta, misma tabla ruta_asignaciones):
--      (Erik, 5-oct-2026) solo a monitoristas que TIENEN la unidad de la
--      ruta. La lista sale de usuarios_asignables_ruta(p_ruta_id) y un
--      trigger BEFORE INSERT lo hace cumplir también para Pauta (PASO 10c).
--   5) KML / Excel de Biobox con "quitar faltantes" ya no borra las paradas
--      armadas en la app (origen = 'app'), ni las cuenta como sobrantes
--      (PASO 5).
--
-- DE DÓNDE SALE EL CÓDIGO: importar_rutas, importar_rutas_capas,
-- sincronizar_rutas_desde_pauta y vw_rutas_con_coords se copiaron de
-- producción (pg_get_functiondef / pg_get_viewdef, diagnostico_rutas.sql,
-- 5-oct-2026). Conservan TODO su comportamiento salvo lo que se anota en
-- cada una con "CAMBIO (rutas, 5-oct-2026)".
--
-- STORAGE (fotos de visita en 'evidencias/rutas/<site_id>/…'): NO hace
-- falta política nueva. La foto de la base del 29-sep
-- (docs/infraestructura/inspeccion-2026-09-29.json) trae ev_obj_upload =
-- INSERT para authenticated con check bucket_id = 'evidencias', SIN límite
-- de carpeta; el monitorista ya sube ahí sus fotos de Pauta. La app sube
-- con upsert apagado (lib/storage.ts), así que tampoco pide UPDATE. La
-- verificación de abajo lista las políticas vigentes por si cambiaron.
-- ============================================================

-- Los alter table toman candado sobre ruta_ubicaciones: si algo la tiene
-- ocupada, mejor fallar en 5 s y volver a correr que congelar Rutas.
set lock_timeout = '5s';


-- ══ PASO 1 — El trigger de segmento solo revisa lo que puede romperlo ══
-- ruta_ubic_valida_segmento() exige que el sitio tenga caras de la
-- unidad/medio de su ruta. Corría en CUALQUIER update, así que cambiar la
-- secuencia o la fuente de la dirección de un sitio cuyo inventario se
-- movió después (QTM reescribe inventario cada noche) tronaba — y con él
-- el respaldo del PASO 2, "Ordenar por cercanía" y el guardado de la ruta.
-- Ahora solo revisa cuando cambia la RUTA o el SITIO, que es lo único que
-- puede crear una mezcla. Los upsert de importación (insert … on conflict
-- do update set ruta_id = …) se siguen validando: el BEFORE INSERT revisa
-- la fila propuesta y el UPDATE trae ruta_id en su SET. La función no
-- cambia.
drop trigger if exists trg_ruta_ubic_segmento on public.ruta_ubicaciones;
create trigger trg_ruta_ubic_segmento
  before insert or update of ruta_id, site_id on public.ruta_ubicaciones
  for each row execute function public.ruta_ubic_valida_segmento();


-- ══ PASO 2 — Columnas nuevas de ruta_ubicaciones ══
-- direccion_fuente: qué dirección se queda para el sitio.
--   'qtm'     → inventario.direccion, en vivo (default).
--   'archivo' → direccion_archivo (la del Excel de rutas o de la pauta).
-- RESPALDO: hoy Rutas enseña direccion_archivo; los sitios que la tienen
-- quedan en 'archivo' para que NADIE vea cambiar lo que hoy ve. Va dentro
-- de la guarda: si se volviera a correr después, pisaría lo que alguien ya
-- eligió (QTM) al importar.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'ruta_ubicaciones'
       and column_name = 'direccion_fuente'
  ) then
    alter table public.ruta_ubicaciones
      add column direccion_fuente text not null default 'qtm'
        constraint ruta_ubic_direccion_fuente_chk
        check (direccion_fuente in ('qtm', 'archivo'));

    update public.ruta_ubicaciones
       set direccion_fuente = 'archivo'
     where nullif(btrim(direccion_archivo), '') is not null;
  end if;
end $$;

-- origen: por dónde entró la parada. Nulo en las de antes (no se sabe).
--   'archivo' (Excel de rutas), 'capas' (mapa KML / Excel de Biobox),
--   'pauta' (Sincronizar rutas), 'app' (armada en "+ Nueva ruta").
-- agregada_por: quién la puso en SU ruta actual (correo en minúsculas).
alter table public.ruta_ubicaciones
  add column if not exists origen text
    constraint ruta_ubic_origen_chk
    check (origen in ('archivo', 'capas', 'pauta', 'app')),
  add column if not exists agregada_por text;

-- Si authenticated tuviera permisos por columna (y no de tabla completa),
-- sin esto las columnas nuevas darían "permission denied" al leerlas. La
-- RLS sigue mandando: solo coordinador/manager actualizan.
grant select (direccion_fuente, origen, agregada_por) on public.ruta_ubicaciones to authenticated;
grant update (direccion_fuente) on public.ruta_ubicaciones to authenticated;


-- ══ PASO 3 — vw_rutas_con_coords con la dirección elegida ══
-- `create or replace view` exige las columnas actuales con su nombre, tipo
-- y posición: las nuevas van AL FINAL (ver pauta_evidencias.sql).
--   direccion_qtm    → inventario.direccion de la primera cara del sitio
--                      (por vendor_face_id, como vw_revision_ubicaciones)
--                      DENTRO del segmento de la ruta.
--   direccion_fuente → la elección guardada.
--   direccion        → LA que se enseña y la que llevan las incidencias:
--                      la del archivo si se eligió 'archivo' y no está
--                      vacía; si no, la de QTM. (Erik, 5-oct-2026) En
--                      Ecovallas Impreso las incidencias toman
--                      direccion_qtm: lo decide la app con ruta_unidad y
--                      ruta_tipo, por eso la vista no cambia.
--   origen           → por dónde entró la parada.
-- (revisión, 5-oct-2026) `create or replace view` REEMPLAZA las opciones
-- de la vista (security_invoker, security_barrier…) aunque no traiga
-- ninguna: se leen antes y se vuelven a poner después; la verificación
-- final las enseña en 'vista_opciones'.
-- TODO EN UN SOLO BLOQUE (Erik, 5-oct-2026): la primera versión las
-- guardaba en una tabla temporal y las leía en otra sentencia, y el SQL
-- Editor de Supabase no siempre corre todo el script en la misma conexión
-- (42P01: la tabla temporal "no existe"). Dentro de un `do` no se pierde
-- nada entre sentencias.
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
           -- COLUMNAS NUEVAS (rutas, 5-oct-2026) — tienen que ir al final.
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
           and i.tipo_medio = r.tipo_medio
         group by i.site_id
      ) inv on true
      left join lateral (
        select i.direccion
          from inventario i
         where i.site_id = ru.site_id
           and i.unidad_negocio = r.unidad_negocio
           and i.tipo_medio = r.tipo_medio
         order by i.vendor_face_id
         limit 1
      ) dq on true
  $vista$;

  if v_opts is not null and cardinality(v_opts) > 0 then
    execute format('alter view public.vw_rutas_con_coords set (%s)', array_to_string(v_opts, ', '));
  end if;
end $mig$;

-- create or replace conserva los permisos; se repiten por si acaso
-- (prelanzamiento_300.sql: anon sin nada).
revoke all on public.vw_rutas_con_coords from anon;
grant select on public.vw_rutas_con_coords to authenticated;


-- ══ PASO 4 — importar_rutas (Excel de rutas y Sincronizar de Pauta) ══
-- Misma firma y mismo resultado de siempre, más:
--   · cada fila acepta 'fuente_direccion' ('qtm' | 'archivo', opcional) y
--     'origen' (opcional, default 'archivo'; un valor desconocido cuenta
--     como 'archivo', y una fuente desconocida como si no viniera).
--   · direccion_archivo solo se actualiza si la fila TRAE dirección: una
--     fila sin dirección ya no borra la que había.
--   · fuente: la de la fila si viene; si no, en fila NUEVA 'archivo' si
--     trae dirección y 'qtm' si no; en fila EXISTENTE se conserva.
--   · 'omitidos_ejemplo': hasta 8 [{site_id, motivo}]. Antes cualquier
--     error se tragaba como "omitida" sin decir cuál ni por qué.
--   · una fila sin clave o con ruta vacía/no numérica se OMITE (con su
--     motivo). Antes la ruta vacía tronaba la importación COMPLETA.
--   · (corrector, 5-oct-2026) un sitio que hoy está en una ruta de OTRA
--     unidad o medio se OMITE con su motivo (salvo Sincronizar, origen
--     'pauta'): igual que el armado, no se mueve entre segmentos.
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
              or r.tipo_medio is distinct from p_tipo)
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
  'omitidas, omitidos_ejemplo:[{site_id, motivo}]}. Ver la migración rutas_armado_visitas (5-oct-2026).';


-- ══ PASO 5 — importar_rutas_capas (mapa KML / Excel de Biobox) ══
-- Idéntica, salvo que marca origen = 'capas' y agregada_por. No trae
-- direcciones: las nuevas nacen con direccion_fuente = 'qtm' (default).
-- (Erik, 5-oct-2026) "Quitar faltantes" NO borra las paradas con
-- origen = 'app' (armadas a mano en "+ Nueva ruta": el mapa no las conoce,
-- así que SIEMPRE serían "faltantes") y tampoco las cuenta en `sobrantes`.
-- Si el mapa SÍ trae una de ellas, se actualiza como siempre y pasa a
-- 'capas'.
create or replace function public.importar_rutas_capas(
  p_unidad text,
  p_capas jsonb,
  p_quitar_faltantes boolean default false,
  p_conservar text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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
      select id, numero, color
        into v_ruta_id, v_numero, v_color
      from rutas_monitoreo
      where unidad_negocio = p_unidad
        and tipo_medio = v_tipo
        and lower(regexp_replace(coalesce(nombre, ''), '\s+', ' ', 'g')) =
            lower(regexp_replace(v_nombre, '\s+', ' ', 'g'))
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


-- ══ PASO 6 — sincronizar_rutas_desde_pauta ══
-- Idéntica, salvo que cada fila va con origen = 'pauta'. La dirección se
-- queda como siempre (la del archivo de pauta: las filas nuevas con
-- dirección nacen en 'archivo'; las existentes conservan su elección).
create or replace function public.sincronizar_rutas_desde_pauta(p_catorcena integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_filas    jsonb;
  v_sitios   int;
  v_foraneos int;
  v_res      jsonb;
begin
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo coordinador o manager pueden sincronizar rutas.';
  end if;

  -- Un renglón por SITIO: la secuencia más chica de sus caras (todas
  -- traen la misma en el archivo, pero por si acaso), estatus ACTIVA
  -- (está en la pauta vigente) y la dirección del archivo.
  select jsonb_agg(fila), count(*)
    into v_filas, v_sitios
  from (
    select jsonb_build_object(
             'site_id',   site_id,
             'ruta',      (ruta_clave)::int,
             'secuencia', min(secuencia),
             'estatus',   'ACTIVA',
             'vallas',    null,
             'direccion', coalesce(max(direccion), ''),
             -- CAMBIO (rutas, 5-oct-2026): de dónde entró la parada.
             'origen',    'pauta'
           ) as fila
    from pautas
    where catorcena = p_catorcena
      and ruta_clave ~ '^\d+$'
    group by site_id, ruta_clave
  ) s;

  select count(distinct site_id) into v_foraneos
  from pautas
  where catorcena = p_catorcena
    and (ruta_clave is null or ruta_clave !~ '^\d+$');

  if v_sitios is null or v_sitios = 0 then
    raise exception 'La catorcena % no tiene sitios con ruta numérica.', p_catorcena;
  end if;

  -- El pipeline de siempre: crea rutas faltantes, actualiza secuencias y
  -- valida contra inventario. Pauta es Ecovallas Impreso.
  v_res := importar_rutas('Ecovallas', 'Impreso', v_filas);

  return v_res || jsonb_build_object(
    'sitios_en_pauta', v_sitios,
    'foraneos_omitidos', v_foraneos
  );
end;
$function$;


-- ══ PASO 7 — guardar_paradas_ruta: la ruta armada en la app ══
-- Recibe la lista COMPLETA de sitios de UNA ruta, en el orden elegido.
--   · Valida cada sitio NUEVO para la ruta contra inventario (misma unidad
--     y tipo de medio que la ruta: lo que exige el trigger). Los que ya
--     están en ESTA ruta se aceptan tal cual aunque QTM los haya movido
--     después: solo se reordenan, y rechazarlos los borraría sin querer.
--   · Si alguno está en OTRA ruta y p_mover = false: NO cambia nada y
--     regresa cuáles y de qué ruta salen, para pedir confirmación.
--   · Con p_mover = true (o sin conflictos), en UNA transacción: quita las
--     paradas de ESTA ruta que no vienen, mueve las de otras rutas, agrega
--     las nuevas, y la secuencia queda = posición (1..n).
--   · Ecovallas Impreso se rechaza: ahí manda la pauta.
-- `agregadas` cuenta las nuevas Y las movidas (todas entran a esta ruta).
create or replace function public.guardar_paradas_ruta(
  p_ruta_id bigint,
  p_site_ids text[],
  p_mover boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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
           exists (select 1 from inventario i
                    where i.site_id = e.site_id
                      and i.unidad_negocio = v_ruta.unidad_negocio
                      and i.tipo_medio = v_ruta.tipo_medio) as valido,
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
          or r.tipo_medio is distinct from v_ruta.tipo_medio);
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
  --    segmento; unidad y medio van para que la pantalla no tenga que
  --    suponerlo.
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

comment on function public.guardar_paradas_ruta(bigint, text[], boolean) is
  'Guarda la lista completa de sitios de una ruta en orden (secuencia = posición). Si hay sitios '
  'en otra ruta y p_mover=false no cambia nada y devuelve {ok:false, requiere_confirmar, en_otra_ruta}. '
  'Solo coordinador/manager; no Ecovallas Impreso. Migración rutas_armado_visitas (5-oct-2026).';


-- ══ PASO 8 — siguiente_numero_ruta: el número que se sugiere ══
-- max + 1 del segmento (unidad + medio), igual que importar_rutas_capas.
-- SECURITY INVOKER: rutas_monitoreo ya se lee con sesión (rutas_sel).
create or replace function public.siguiente_numero_ruta(p_unidad text, p_tipo text)
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $function$
  select coalesce(max(numero), 0) + 1
    from rutas_monitoreo
   where unidad_negocio = p_unidad
     and tipo_medio = p_tipo
$function$;


-- ══ PASO 9 — Permisos de las funciones ══
-- A PUBLIC ya no se le da EXECUTE por omisión (prelanzamiento_300.sql):
-- grant explícito a authenticated y service_role; nada para anon.
revoke all on function public.importar_rutas(text, text, jsonb) from public, anon;
grant execute on function public.importar_rutas(text, text, jsonb) to authenticated, service_role;
revoke all on function public.importar_rutas_capas(text, jsonb, boolean, text[]) from public, anon;
grant execute on function public.importar_rutas_capas(text, jsonb, boolean, text[]) to authenticated, service_role;
revoke all on function public.sincronizar_rutas_desde_pauta(integer) from public, anon;
grant execute on function public.sincronizar_rutas_desde_pauta(integer) to authenticated, service_role;
revoke all on function public.guardar_paradas_ruta(bigint, text[], boolean) from public, anon;
grant execute on function public.guardar_paradas_ruta(bigint, text[], boolean) to authenticated, service_role;
revoke all on function public.siguiente_numero_ruta(text, text) from public, anon;
grant execute on function public.siguiente_numero_ruta(text, text) to authenticated, service_role;


-- ══ PASO 9b — Historial de asignaciones (visitas sin señal) ══
-- (Erik, 5-oct-2026) El monitorista marca visitas sin señal; la cola las
-- manda horas después. Si en medio el coordinador le quitó la ruta, la
-- política de antes las rechazaba (42501) aunque la visita se hizo cuando
-- la ruta SÍ era suya. Ahora se acepta si visitado_en cae dentro de un
-- periodo en que la tuvo asignada:
--   · ruta_asignaciones_historial guarda cada asignación RETIRADA (desde
--     cuándo la tuvo y cuándo se la quitaron). La llena un trigger AFTER
--     DELETE en ruta_asignaciones; nadie escribe a mano.
--   · puede_registrar_visita(ruta, visitado_en) es lo que pregunta la
--     política rvis_ins (PASO 10).
-- Las que de verdad no proceden (nunca la tuvo, o la visita es de fuera
-- del periodo) siguen dando 42501, y la cola de la app las suelta y avisa
-- como hoy.
--
-- ruta_id SIN llave foránea a propósito: al borrar una ruta, el cascade
-- borra sus asignaciones y este trigger inserta su historial EN EL MISMO
-- comando; con llave foránea, el borrado de la ruta tronaría. Una ruta
-- borrada ya no recibe visitas (ruta_visitas.ruta_id queda en null), así
-- que esas filas solo sirven de bitácora.
create table if not exists public.ruta_asignaciones_historial (
  id            bigserial primary key,
  ruta_id       bigint not null,
  usuario_email text not null,
  asignado_por  text,
  -- creado_en de la asignación (puede venir nulo en filas muy viejas: se
  -- toma como "desde siempre", ver puede_registrar_visita).
  asignado_en   timestamptz,
  retirada_en   timestamptz not null default now(),
  retirada_por  text
);

create index if not exists ruta_asig_hist_ruta_usuario_idx
  on public.ruta_asignaciones_historial (ruta_id, lower(usuario_email), retirada_en desc);

alter table public.ruta_asignaciones_historial enable row level security;

-- Solo lectura, y solo coordinador/manager (es bitácora de gestión). El
-- monitorista no la necesita: su permiso lo revisa puede_registrar_visita,
-- que es SECURITY DEFINER.
drop policy if exists rahist_sel on public.ruta_asignaciones_historial;
create policy rahist_sel on public.ruta_asignaciones_historial
  for select to authenticated
  using (
    (select tiene_rol('coordinador'::app_role))
    or (select tiene_rol('manager'::app_role))
  );

revoke all on public.ruta_asignaciones_historial from public, anon;
revoke insert, update, delete, truncate on public.ruta_asignaciones_historial from authenticated;
grant select on public.ruta_asignaciones_historial to authenticated;
grant all on public.ruta_asignaciones_historial to service_role;
revoke all on sequence public.ruta_asignaciones_historial_id_seq from public, anon, authenticated;
grant usage, select on sequence public.ruta_asignaciones_historial_id_seq to service_role;

comment on table public.ruta_asignaciones_historial is
  'Asignaciones de ruta RETIRADAS (trigger AFTER DELETE en ruta_asignaciones). La usa '
  'puede_registrar_visita para aceptar visitas sin señal hechas cuando la ruta era del usuario. '
  'Solo lectura coordinador/manager. Migración rutas_armado_visitas (5-oct-2026).';

-- SECURITY DEFINER: corre como dueño de la tabla (sin RLS de por medio) y
-- el usuario que borra la asignación no necesita permiso de INSERT aquí.
create or replace function public.ruta_asig_guardar_historial()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  insert into ruta_asignaciones_historial
    (ruta_id, usuario_email, asignado_por, asignado_en, retirada_en, retirada_por)
  values
    (old.ruta_id, lower(btrim(old.usuario_email)), old.asignado_por, old.creado_en,
     now(), lower(auth_email()));
  return old;
end $function$;

drop trigger if exists trg_ruta_asig_historial on public.ruta_asignaciones;
create trigger trg_ruta_asig_historial
  after delete on public.ruta_asignaciones
  for each row execute function public.ruta_asig_guardar_historial();

-- ¿Puede el usuario de la sesión registrar una visita de esta ruta, hecha
-- a esta hora (la del teléfono)?
--   · coordinador/manager: siempre.
--   · monitorista: si la ruta es suya HOY (asignación vigente, sin importar
--     la hora: así funcionaba), o si lo fue cuando hizo la visita
--     (asignado_en <= visitado_en <= retirada_en en el historial).
-- SECURITY DEFINER para leer el historial (RLS solo coordinador/manager).
-- OJO: la hora es la del teléfono; con el reloj muy desfasado, una visita
-- hecha justo antes del retiro puede quedar fuera del periodo.
create or replace function public.puede_registrar_visita(p_ruta_id bigint, p_visitado_en timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select coalesce(
    tiene_rol('coordinador'::app_role)
    or tiene_rol('manager'::app_role)
    or (
      p_ruta_id is not null
      and tiene_rol('monitorista'::app_role)
      and (
        exists (
          select 1 from ruta_asignaciones ra
           where ra.ruta_id = p_ruta_id
             and lower(ra.usuario_email) = lower(auth_email())
        )
        or exists (
          select 1 from ruta_asignaciones_historial h
           where h.ruta_id = p_ruta_id
             and lower(h.usuario_email) = lower(auth_email())
             and p_visitado_en is not null
             and (h.asignado_en is null or h.asignado_en <= p_visitado_en)
             and p_visitado_en <= h.retirada_en
        )
      )
    ),
    false)
$function$;

comment on function public.puede_registrar_visita(bigint, timestamptz) is
  'Política rvis_ins: coordinador/manager siempre; monitorista si la ruta es suya hoy o lo era a la hora '
  'de la visita (ruta_asignaciones_historial). Migración rutas_armado_visitas (5-oct-2026).';

revoke all on function public.ruta_asig_guardar_historial() from public, anon;
grant execute on function public.ruta_asig_guardar_historial() to authenticated, service_role;
revoke all on function public.puede_registrar_visita(bigint, timestamptz) from public, anon;
grant execute on function public.puede_registrar_visita(bigint, timestamptz) to authenticated, service_role;


-- ══ PASO 10 — ruta_visitas: "visité este sitio" ══
-- Una fila por visita. Si un sitio se visita dos veces en la catorcena,
-- cuenta la última (eso lo resuelve quien lee: order by visitado_en desc).
--   cliente_id   → la llave la genera el teléfono al tocar "Marcar visita";
--                  la cola sin señal reenvía con la MISMA llave y el
--                  segundo intento choca con el unique (no duplica).
--   ruta_id      → on delete set null: borrar una ruta no borra el
--                  historial de visitas.
--   visitado_en  → la hora del teléfono al tocar (puede llegar horas
--                  después por la cola); registrado_en es la del servidor.
--   fotos        → [{path, url}] en el bucket evidencias,
--                  'rutas/<site_id>/<cliente_id>_<n>.<ext>'.
-- No se valida que el sitio siga en esa ruta: si el coordinador lo movió
-- mientras el monitorista estaba sin señal, la visita se pierde sin razón.
create table if not exists public.ruta_visitas (
  id            bigserial primary key,
  cliente_id    uuid not null unique,
  ruta_id       bigint references public.rutas_monitoreo (id) on delete set null,
  site_id       text not null,
  usuario_email text not null default lower(auth_email()),
  visitado_en   timestamptz not null,
  registrado_en timestamptz not null default now(),
  lat           double precision,
  lng           double precision,
  precision_m   real,
  fotos         jsonb not null default '[]'::jsonb
                  constraint ruta_visitas_fotos_arreglo check (jsonb_typeof(fotos) = 'array'),
  nota          text
);

create index if not exists ruta_visitas_ruta_idx
  on public.ruta_visitas (ruta_id, visitado_en desc);
create index if not exists ruta_visitas_site_idx
  on public.ruta_visitas (site_id, visitado_en desc);
-- Para "mis visitas" y para que la política de lectura no recorra todo.
create index if not exists ruta_visitas_usuario_idx
  on public.ruta_visitas (lower(usuario_email), visitado_en desc);

alter table public.ruta_visitas enable row level security;

-- Lectura: las propias, o todas si eres coordinador/manager (el avance
-- por catorcena).
drop policy if exists rvis_sel on public.ruta_visitas;
create policy rvis_sel on public.ruta_visitas
  for select to authenticated
  -- (revisión, 5-oct-2026) Los (select …) se evalúan UNA vez por consulta
  -- (initplan) y no en cada fila.
  using (
    lower(usuario_email) = (select lower(auth_email()))
    or (select tiene_rol('coordinador'::app_role))
    or (select tiene_rol('manager'::app_role))
  );

-- Alta: siempre a nombre propio; coordinador/manager, o el monitorista
-- en una ruta que tiene ASIGNADA. Sin update ni delete: una visita es un
-- hecho registrado.
-- CAMBIO (Erik, 5-oct-2026): "asignada" ahora también cuenta si lo estaba
-- a la hora de la visita (visitado_en), aunque al llegar por la cola ya se
-- la hayan quitado: puede_registrar_visita (PASO 9b).
drop policy if exists rvis_ins on public.ruta_visitas;
create policy rvis_ins on public.ruta_visitas
  for insert to authenticated
  with check (
    usuario_email = lower(auth_email())
    and public.puede_registrar_visita(ruta_visitas.ruta_id, ruta_visitas.visitado_en)
  );

revoke all on public.ruta_visitas from anon;
revoke update, delete, truncate on public.ruta_visitas from authenticated;
grant select, insert on public.ruta_visitas to authenticated;
grant all on public.ruta_visitas to service_role;
revoke all on sequence public.ruta_visitas_id_seq from anon;
grant usage, select on sequence public.ruta_visitas_id_seq to authenticated, service_role;

comment on table public.ruta_visitas is
  'Visitas de monitoreo por sitio (Mis rutas). cliente_id = llave idempotente del teléfono. '
  'Sin update/delete. Migración rutas_armado_visitas (5-oct-2026).';

-- ══ PASO 10b — El aviso de asignación dice DÓNDE está la ruta ══
-- CAMBIO (rutas, 5-oct-2026, integración): el aviso decía siempre "La
-- encuentras en Pauta y Monitoreo", pero desde hoy solo Ecovallas Impreso
-- vive en Pauta; las demás rutas el monitorista las ve en "Mis rutas".
-- Cuerpo copiado de ruta_asignaciones.sql (única definición en el repo);
-- solo cambia el texto del INSERT. Mismo trigger, mismo evento 'ruta'.
create or replace function public.notificar_ruta_asignada()
returns trigger
language plpgsql
security definer
-- (revisión, 5-oct-2026) La convención de prelanzamiento_300.sql: toda
-- SECURITY DEFINER fija su search_path.
set search_path = public, pg_temp
as $$
declare
  r record;
  msg text;
begin
  select numero, nombre, unidad_negocio, tipo_medio
    into r
    from rutas_monitoreo
   where id = coalesce(new.ruta_id, old.ruta_id);
  if not found then return coalesce(new, old); end if;

  if tg_op = 'INSERT' then
    msg := 'Se te asignó la ruta ' || r.numero ||
           coalesce(' · ' || nullif(r.nombre, ''), '') ||
           case
             when lower(r.unidad_negocio) = 'ecovallas' and lower(r.tipo_medio) = 'impreso'
               then '. La encuentras en Pauta y Monitoreo.'
             else '. La encuentras en Mis rutas.'
           end;
    -- (QA, 5-oct-2026) Biobox asigna la ruta Digital y su gemela Impreso
    -- de un golpe: mismo número y nombre, mismo texto. Un solo aviso.
    if not exists (
      select 1 from notificaciones n
       where lower(n.para_email) = lower(new.usuario_email)
         and n.evento = 'ruta'
         and n.mensaje = msg
         and n.creado_en > now() - interval '30 seconds'
    ) then
      insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      values (null, lower(new.usuario_email), 'ruta', msg, r.unidad_negocio);
    end if;
    return new;
  else
    msg := 'Se te retiró la ruta ' || r.numero ||
           coalesce(' · ' || nullif(r.nombre, ''), '') || '.';
    if not exists (
      select 1 from notificaciones n
       where lower(n.para_email) = lower(old.usuario_email)
         and n.evento = 'ruta'
         and n.mensaje = msg
         and n.creado_en > now() - interval '30 seconds'
    ) then
      insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      values (null, lower(old.usuario_email), 'ruta', msg, r.unidad_negocio);
    end if;
    return old;
  end if;
end
$$;


-- ══ PASO 10c — Asignar solo a monitoristas de la unidad de la ruta ══
-- (Erik, 5-oct-2026) Una ruta se le asigna solo a quien TIENE su unidad
-- como monitorista: una fila de usuario_roles con rol = 'monitorista' y
-- unidad_negocio vacía (= todas) o igual a la de la ruta, sin distinguir
-- mayúsculas ni espacios de más.
--   · usuarios_asignables_ruta(p_ruta_id): la lista para Rutas → Asignar.
--     Mismo permiso que usuarios_asignables() (solo coordinador/manager; a
--     los demás les regresa vacío) y solo correo y nombre.
--   · trg_ruta_asig_valida_unidad (BEFORE INSERT): la base lo hace cumplir
--     también para Pauta, que sigue listando con usuarios_asignables().
--     Solo INSERT: las asignaciones que ya existen NO se tocan ni se
--     revisan (la verificación del PASO 11 cuenta cuántas quedarían fuera,
--     para que Erik decida). Quitar una asignación tampoco se revisa.
--   · Si la MISMA asignación ya existe (misma ruta y mismo correo), no
--     revisa nada: deja que el unique responda 23505 ("ya estaba
--     asignada"), que Rutas y Pauta ya toman como éxito.
-- El mensaje se enseña tal cual en Rutas y en Pauta ("No se pudo asignar:
-- …"); no dice "duplicate" para que Pauta no lo confunda con el 23505.
create or replace function public.ruta_asig_valida_unidad()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_email  text := lower(btrim(coalesce(new.usuario_email, '')));
  v_ruta   record;
  v_nombre text;
  v_es_mon boolean;
  v_ruta_txt text;
  v_unidad text;
begin
  -- (corrector, 5-oct-2026) Los triggers BEFORE corren ANTES del WITH CHECK
  -- de la política ra_ins: sin esto, cualquier usuario con sesión podía
  -- mandar un correo cualquiera y leer en el mensaje su nombre, si es
  -- monitorista y de qué unidad (esta función lee usuarios y usuario_roles
  -- como dueño). Quien no es coordinador/manager pasa de largo y la
  -- política lo rechaza con 42501, sin detalles. service_role (sin correo
  -- de sesión) sí se valida.
  if auth_email() is not null
     and not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    return new;
  end if;

  -- (corrector, 5-oct-2026) La hora de la asignación la pone la base:
  -- pasa al historial como asignado_en y abre la ventana en que se aceptan
  -- visitas sin señal; un creado_en viejo mandado por API la agrandaría.
  new.creado_en := now();

  if v_email = '' then
    raise exception 'Falta el correo de la persona a la que se le asigna la ruta.'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from ruta_asignaciones ra
     where ra.ruta_id = new.ruta_id
       and ra.usuario_email = new.usuario_email
  ) then
    return new;
  end if;

  select r.numero, r.nombre, r.unidad_negocio
    into v_ruta
    from rutas_monitoreo r
   where r.id = new.ruta_id;
  if not found then
    -- La llave foránea da su propio error ("la ruta no existe").
    return new;
  end if;

  if exists (
    select 1 from usuario_roles ur
     where lower(ur.usuario_email) = v_email
       and ur.rol = 'monitorista'::app_role
       and (nullif(btrim(ur.unidad_negocio), '') is null
            or nullif(btrim(v_ruta.unidad_negocio), '') is null
            or lower(btrim(ur.unidad_negocio)) = lower(btrim(v_ruta.unidad_negocio)))
  ) then
    return new;
  end if;

  select coalesce(max(nullif(btrim(u.nombre), '')), v_email)
    into v_nombre
    from usuarios u
   where lower(u.email) = v_email;
  v_nombre := coalesce(v_nombre, v_email);

  select exists (
    select 1 from usuario_roles ur
     where lower(ur.usuario_email) = v_email
       and ur.rol = 'monitorista'::app_role
  ) into v_es_mon;

  v_ruta_txt := 'la Ruta ' || v_ruta.numero || coalesce(' · ' || nullif(btrim(v_ruta.nombre), ''), '');
  v_unidad := coalesce(nullif(btrim(v_ruta.unidad_negocio), ''), 'esta unidad');
  if v_es_mon then
    raise exception '% es monitorista, pero no de %: no se le puede asignar %. Agrégale esa unidad en Usuarios.',
      v_nombre, v_unidad, v_ruta_txt
      using errcode = 'check_violation';
  else
    raise exception '% no tiene el rol de monitorista: no se le puede asignar %. Dale ese rol con la unidad % en Usuarios.',
      v_nombre, v_ruta_txt, v_unidad
      using errcode = 'check_violation';
  end if;
end $function$;

drop trigger if exists trg_ruta_asig_valida_unidad on public.ruta_asignaciones;
create trigger trg_ruta_asig_valida_unidad
  before insert on public.ruta_asignaciones
  for each row execute function public.ruta_asig_valida_unidad();

-- La lista de Rutas → Asignar. Copia de usuarios_asignables()
-- (coordinador_solo_gestion.sql) con el filtro de unidad del trigger: lo
-- que la lista ofrece es exactamente lo que la base acepta. Una fila por
-- correo aunque tenga varias filas de rol.
-- (corrector, 5-oct-2026) Regresa (email, nombre), la MISMA forma que
-- usuarios_asignables(): la app usa una sola forma para las dos listas. El
-- drop va antes porque create or replace no deja cambiar las columnas de
-- salida (una versión de prueba regresaba "correo").
drop function if exists public.usuarios_asignables_ruta(bigint);
create or replace function public.usuarios_asignables_ruta(p_ruta_id bigint)
returns table (email text, nombre text)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select s.correo,
         coalesce(
           (select max(nullif(btrim(u.nombre), '')) from usuarios u
             where lower(u.email) = s.correo),
           split_part(s.correo, '@', 1)) as nombre
    from (
      select distinct lower(btrim(ur.usuario_email)) as correo
        from usuario_roles ur
        join rutas_monitoreo r on r.id = p_ruta_id
       where (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role))
         and ur.rol = 'monitorista'::app_role
         and nullif(btrim(ur.usuario_email), '') is not null
         and (nullif(btrim(ur.unidad_negocio), '') is null
              or nullif(btrim(r.unidad_negocio), '') is null
              or lower(btrim(ur.unidad_negocio)) = lower(btrim(r.unidad_negocio)))
    ) s
   order by 2, 1;
$function$;

comment on function public.usuarios_asignables_ruta(bigint) is
  'Monitoristas que se pueden asignar a la ruta (rol monitorista con unidad vacía o la de la ruta). '
  'Solo coordinador/manager; a los demás, vacío. Migración rutas_armado_visitas (5-oct-2026).';

revoke all on function public.ruta_asig_valida_unidad() from public, anon;
grant execute on function public.ruta_asig_valida_unidad() to authenticated, service_role;
revoke all on function public.usuarios_asignables_ruta(bigint) from public, anon;
grant execute on function public.usuarios_asignables_ruta(bigint) to authenticated, service_role;

reset lock_timeout;


-- ══ PASO 11 — Verificar ══
-- UNA sola consulta a propósito: el SQL Editor solo enseña el resultado de
-- la ÚLTIMA sentencia. Lo esperado:
--   columnas_ruta_ubicaciones = direccion_fuente text not null default 'qtm',
--     origen text, agregada_por text
--   archivo_marcado_qtm = 0 justo después de la primera corrida (los que
--     traen dirección de archivo quedaron en 'archivo')
--   vista_ultimas_columnas = [direccion_qtm, direccion_fuente, direccion,
--     origen] y vista_total_columnas = 22
--   trigger_segmento = "… BEFORE INSERT OR UPDATE OF ruta_id, site_id …"
--   funciones: las 5 existen; security_definer true salvo
--     siguiente_numero_ruta (false); anon false; authenticated true
--     (ordenar_ruta_por_cercania también: la usa "Ordenar por cercanía")
--     Las nuevas del 5-oct (tarde): puede_registrar_visita,
--     ruta_asig_guardar_historial, ruta_asig_valida_unidad y
--     usuarios_asignables_ruta, todas security_definer true y search_path
--     public, pg_temp
--   ruta_visitas: rls true, políticas rvis_ins (INSERT) y rvis_sel
--     (SELECT), authenticated solo INSERT y SELECT, anon 0, y
--     rvis_ins_usa_historial = true
--   asignaciones.triggers: trg_notificar_ruta_asignada (AFTER INSERT OR
--     DELETE), trg_ruta_asig_historial (AFTER DELETE) y
--     trg_ruta_asig_valida_unidad (BEFORE INSERT)
--   asignaciones.vigentes_fuera_de_unidad: asignaciones de HOY que el
--     trigger ya no aceptaría si se hicieran de nuevo. NO se tocan; si sale
--     > 0, el ejemplo dice quién y qué ruta, para corregir el rol en
--     Usuarios o quitarlas a mano.
--   historial: rls true, política rahist_sel (SELECT), authenticated solo
--     SELECT, anon 0
--   capas_respeta_app = true (importar_rutas_capas trae el filtro
--     origen 'app')
--   aviso_asignacion_dice_mis_rutas = true
--   asignables_ruta_regresa = "TABLE(email text, nombre text)" (la misma
--     forma que usuarios_asignables(); con "correo" la pantalla tronaba)
--   excel_no_mueve_entre_segmentos = true (importar_rutas omite el sitio
--     que hoy está en una ruta de otra unidad o medio)
--   trigger_unidad_solo_gestion = true (el trigger de unidad no le da
--     detalles a quien no es coordinador/manager)
--   storage_evidencias_insert: debe salir una política INSERT con
--     bucket_id = 'evidencias' para authenticated (ev_obj_upload)
--   humo: números de la vista y el número que se sugeriría por segmento;
--     monitoristas_por_unidad (cuántos ofrecería "Asignar" en cada unidad:
--     si una sale en 0, nadie puede recibir esas rutas) y paradas_app.
select jsonb_build_object(
  'columnas_ruta_ubicaciones',
    (select jsonb_object_agg(c.column_name,
              c.data_type
              || case when c.is_nullable = 'NO' then ' not null' else '' end
              || coalesce(' default ' || c.column_default, ''))
       from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'ruta_ubicaciones'
        and c.column_name in ('direccion_fuente', 'origen', 'agregada_por')),
  'paradas_por_fuente',
    (select jsonb_object_agg(s.f, s.n)
       from (select direccion_fuente as f, count(*) as n
               from public.ruta_ubicaciones group by 1) s),
  'archivo_marcado_qtm',
    (select count(*) from public.ruta_ubicaciones
      where nullif(btrim(direccion_archivo), '') is not null
        and direccion_fuente = 'qtm'),
  'vista_ultimas_columnas',
    (select jsonb_agg(x.attname order by x.attnum)
       from (select a.attname, a.attnum
               from pg_attribute a
              where a.attrelid = 'public.vw_rutas_con_coords'::regclass
                and a.attnum > 0 and not a.attisdropped
              order by a.attnum desc
              limit 4) x),
  'vista_opciones',
    (select to_jsonb(c.reloptions) from pg_class c
      where c.oid = 'public.vw_rutas_con_coords'::regclass),
  'vista_total_columnas',
    (select count(*) from pg_attribute a
      where a.attrelid = 'public.vw_rutas_con_coords'::regclass
        and a.attnum > 0 and not a.attisdropped),
  'trigger_segmento',
    (select pg_get_triggerdef(t.oid) from pg_trigger t
      where t.tgrelid = 'public.ruta_ubicaciones'::regclass
        and t.tgname = 'trg_ruta_ubic_segmento'),
  'funciones',
    (select jsonb_object_agg(f.firma, jsonb_build_object(
              'existe', p.oid is not null,
              'security_definer', p.prosecdef,
              'search_path', to_jsonb(p.proconfig),
              'anon', has_function_privilege('anon', p.oid, 'execute'),
              'authenticated', has_function_privilege('authenticated', p.oid, 'execute')))
       from unnest(array[
              'public.importar_rutas(text,text,jsonb)',
              'public.importar_rutas_capas(text,jsonb,boolean,text[])',
              'public.sincronizar_rutas_desde_pauta(integer)',
              'public.guardar_paradas_ruta(bigint,text[],boolean)',
              'public.siguiente_numero_ruta(text,text)',
              'public.ordenar_ruta_por_cercania(bigint)',
              'public.usuarios_asignables()',
              'public.usuarios_asignables_ruta(bigint)',
              'public.puede_registrar_visita(bigint,timestamptz)',
              'public.ruta_asig_guardar_historial()',
              'public.ruta_asig_valida_unidad()'
            ]) as f(firma)
       left join pg_proc p on p.oid = to_regprocedure(f.firma)),
  'ruta_visitas', jsonb_build_object(
    'rls',
      (select c.relrowsecurity from pg_class c where c.oid = 'public.ruta_visitas'::regclass),
    'politicas',
      (select coalesce(jsonb_agg(policyname || ' (' || cmd || ')' order by policyname), '[]'::jsonb)
         from pg_policies where schemaname = 'public' and tablename = 'ruta_visitas'),
    'permisos_authenticated',
      (select coalesce(jsonb_agg(privilege_type order by privilege_type), '[]'::jsonb)
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'ruta_visitas'
          and grantee = 'authenticated'),
    'permisos_anon',
      (select count(*) from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'ruta_visitas'
          and grantee = 'anon'),
    'indices',
      (select coalesce(jsonb_agg(indexname order by indexname), '[]'::jsonb)
         from pg_indexes where schemaname = 'public' and tablename = 'ruta_visitas'),
    'filas',
      (select count(*) from public.ruta_visitas),
    'rvis_ins_usa_historial',
      (select coalesce(bool_or(position('puede_registrar_visita' in coalesce(with_check, '')) > 0), false)
         from pg_policies
        where schemaname = 'public' and tablename = 'ruta_visitas' and policyname = 'rvis_ins')),
  'asignaciones', jsonb_build_object(
    'triggers',
      (select coalesce(jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgname), '[]'::jsonb)
         from pg_trigger t
        where t.tgrelid = 'public.ruta_asignaciones'::regclass
          and not t.tgisinternal),
    'vigentes_fuera_de_unidad',
      (select count(*)
         from public.ruta_asignaciones ra
         join public.rutas_monitoreo r on r.id = ra.ruta_id
        where not exists (
          select 1 from public.usuario_roles ur
           where lower(ur.usuario_email) = lower(btrim(ra.usuario_email))
             and ur.rol = 'monitorista'::app_role
             and (nullif(btrim(ur.unidad_negocio), '') is null
                  or nullif(btrim(r.unidad_negocio), '') is null
                  or lower(btrim(ur.unidad_negocio)) = lower(btrim(r.unidad_negocio))))),
    'vigentes_fuera_de_unidad_ejemplo',
      (select coalesce(jsonb_agg(x.t), '[]'::jsonb)
         from (select lower(ra.usuario_email) || ' → Ruta ' || r.numero || ' ' || r.unidad_negocio
                      || ' ' || r.tipo_medio as t
                 from public.ruta_asignaciones ra
                 join public.rutas_monitoreo r on r.id = ra.ruta_id
                where not exists (
                  select 1 from public.usuario_roles ur
                   where lower(ur.usuario_email) = lower(btrim(ra.usuario_email))
                     and ur.rol = 'monitorista'::app_role
                     and (nullif(btrim(ur.unidad_negocio), '') is null
                          or nullif(btrim(r.unidad_negocio), '') is null
                          or lower(btrim(ur.unidad_negocio)) = lower(btrim(r.unidad_negocio))))
                order by r.unidad_negocio, r.numero, 1
                limit 10) x)),
  'historial', jsonb_build_object(
    'rls',
      (select c.relrowsecurity from pg_class c
        where c.oid = 'public.ruta_asignaciones_historial'::regclass),
    'politicas',
      (select coalesce(jsonb_agg(policyname || ' (' || cmd || ')' order by policyname), '[]'::jsonb)
         from pg_policies where schemaname = 'public' and tablename = 'ruta_asignaciones_historial'),
    'permisos_authenticated',
      (select coalesce(jsonb_agg(privilege_type order by privilege_type), '[]'::jsonb)
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'ruta_asignaciones_historial'
          and grantee = 'authenticated'),
    'permisos_anon',
      (select count(*) from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'ruta_asignaciones_historial'
          and grantee = 'anon'),
    'filas',
      (select count(*) from public.ruta_asignaciones_historial)),
  'capas_respeta_app',
    (select position('is distinct from ''app''' in p.prosrc) > 0 from pg_proc p
      where p.oid = to_regprocedure('public.importar_rutas_capas(text,jsonb,boolean,text[])')),
  'aviso_asignacion_dice_mis_rutas',
    (select position('Mis rutas' in p.prosrc) > 0 from pg_proc p
      where p.oid = to_regprocedure('public.notificar_ruta_asignada()')),
  'asignables_ruta_regresa',
    pg_get_function_result(to_regprocedure('public.usuarios_asignables_ruta(bigint)')),
  'excel_no_mueve_entre_segmentos',
    (select position('no se mueve entre unidades o medios' in p.prosrc) > 0 from pg_proc p
      where p.oid = to_regprocedure('public.importar_rutas(text,text,jsonb)')),
  'trigger_unidad_solo_gestion',
    (select position('auth_email() is not null' in p.prosrc) > 0 from pg_proc p
      where p.oid = to_regprocedure('public.ruta_asig_valida_unidad()')),
  'storage_evidencias_insert',
    (select coalesce(jsonb_agg(policyname || ' ' || cmd || ' [' || array_to_string(roles, ',') || '] '
                               || coalesce(with_check, qual, '(sin condición)')
                               order by policyname), '[]'::jsonb)
       from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and cmd in ('INSERT', 'ALL')),
  'humo', jsonb_build_object(
    'paradas_en_vista',
      (select count(*) from public.vw_rutas_con_coords),
    'por_fuente_en_vista',
      (select jsonb_object_agg(s.f, s.n)
         from (select ruta_unidad || ' ' || ruta_tipo || ' · ' || direccion_fuente as f, count(*) as n
                 from public.vw_rutas_con_coords group by 1) s),
    'sin_direccion',
      (select count(*) from public.vw_rutas_con_coords where direccion is null),
    'qtm_y_archivo_difieren',
      (select count(*) from public.vw_rutas_con_coords
        where nullif(btrim(direccion_archivo), '') is not null
          and direccion_qtm is not null
          and upper(btrim(direccion_archivo)) <> upper(btrim(direccion_qtm))),
    'ejemplo',
      (select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb)
         from (select site_id, direccion_fuente, direccion_qtm, direccion_archivo, direccion
                 from public.vw_rutas_con_coords
                where direccion_qtm is not null
                order by ruta_unidad, ruta_numero, secuencia nulls last
                limit 3) e),
    -- Cuántos monitoristas ofrecería "Asignar" por unidad de ruta (lo
    -- mismo que filtra usuarios_asignables_ruta y el trigger).
    'monitoristas_por_unidad',
      (select jsonb_object_agg(u.unidad, (
                select count(distinct lower(ur.usuario_email))
                  from public.usuario_roles ur
                 where ur.rol = 'monitorista'::app_role
                   and (nullif(btrim(ur.unidad_negocio), '') is null
                        or lower(btrim(ur.unidad_negocio)) = lower(btrim(u.unidad)))))
         from (select distinct unidad_negocio as unidad from public.rutas_monitoreo
                where nullif(btrim(unidad_negocio), '') is not null) u),
    'paradas_app',
      (select count(*) from public.ruta_ubicaciones where origen = 'app'),
    'siguiente_numero',
      (select jsonb_object_agg(v.u || ' ' || v.t, public.siguiente_numero_ruta(v.u, v.t))
         from (values ('Ecovallas', 'Digital'), ('Biobox', 'Digital'),
                      ('Biobox', 'Impreso'), ('Vía Verde', 'Digital')) as v(u, t)))
) as verificacion;
