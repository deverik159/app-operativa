-- ============================================================
-- Inventario de Biobox Perú (Erik, 20-oct-2026).
--
-- Las máquinas de Perú no vienen de QTM sino de la base de la app Biobox
-- (solo por VPN). Las carga una tarea programada de Windows con
-- `sincronizar_biobox_peru(datos)`. Viven en una tabla aislada con su propio
-- historial, y de ahí pasan al inventario de la app con unidad
-- "Biobox Perú", M5, Digital (decisión de Erik: todas M5 digitales).
--
-- Lo que NO se debe romper: cada noche `faces-api-bridge` llama
-- `reemplazar_inventario(datos)` con todo lo de QTM, y esa función hacía
-- TRUNCATE de `inventario`: se habría llevado las de Perú y el historial las
-- habría anotado como "baja" cada noche. Aquí se cambia para que solo
-- reemplace lo de QTM; el script de QTM no cambia. Las dos cargas se
-- turnan con el mismo candado (pg_advisory_xact_lock).
--
-- Clave de cada máquina (la misma para sitio y cara, como las M5 de México):
--   BI-057  →  PE_LM_BB_IID_0057   (país PE, plaza LM = Lima, cara IID)
-- Nombre visible (site_legacy_id): "BI-057 · <referencia del lugar>".
--
-- Re-ejecutable.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Tabla aislada: una fila por máquina, como viene del origen.
-- ------------------------------------------------------------
create table if not exists public.biobox_peru_maquinas (
  biobox_id          text primary key,           -- 'BI-057' (machines.bioboxId)
  vendor_face_id     text not null unique,       -- 'PE_LM_BB_IID_0057'
  alias              text,
  enabled            boolean,                    -- 0 = apagada o desactivada
  is_operational     boolean,
  estatus_origen     text,                       -- machineStatuses.name (available, maintenance)
  -- Lo que dice la base de Biobox; en la app se cargan como M5 Digital
  -- (Erik, 20-oct-2026). Se guardan para poder corregir sin perder el dato.
  modelo_origen      text,
  tipo_origen        text,
  calle              text,
  numero             text,
  distrito           text,                       -- neighborhoods.name (Miraflores…)
  municipio          text,                       -- municipalities.name (Lima)
  estado             text,                       -- states.name (Lima)
  cp                 text,
  referencia         text,                       -- locationReferences
  latitud            numeric(10,7),
  longitud           numeric(10,7),
  creado_origen      timestamp,                  -- machines.createdAt (tal cual)
  actualizado_origen timestamp,                  -- machines.updatedAt (no cuenta como cambio)
  activa             boolean not null default true, -- sigue viniendo del origen
  visto_primera_vez  timestamptz not null default now(),
  visto_ultima_vez   timestamptz not null default now(),
  baja_en            timestamptz
);

comment on table public.biobox_peru_maquinas is
  'Máquinas de Biobox Perú tal como vienen de la base de la app Biobox. La llena sincronizar_biobox_peru(); de aquí pasan a inventario.';

create table if not exists public.biobox_peru_maquinas_historial (
  id             bigserial primary key,
  biobox_id      text not null,
  vendor_face_id text,
  evento         text not null check (evento in ('alta', 'baja', 'reactivada', 'cambio')),
  cambios        jsonb,                          -- {campo: [antes, después]} en 'cambio'
  detectado_en   timestamptz not null default now()
);

create index if not exists biobox_peru_hist_maquina_idx
  on public.biobox_peru_maquinas_historial (biobox_id, detectado_en desc);

alter table public.biobox_peru_maquinas enable row level security;
alter table public.biobox_peru_maquinas_historial enable row level security;

-- Solo se escriben con la función (security definer). Leer: el manager.
revoke all on public.biobox_peru_maquinas from anon, authenticated;
revoke all on public.biobox_peru_maquinas_historial from anon, authenticated;
revoke all on sequence public.biobox_peru_maquinas_historial_id_seq from anon, authenticated;
grant select on public.biobox_peru_maquinas to authenticated;
grant select on public.biobox_peru_maquinas_historial to authenticated;

drop policy if exists biobox_peru_maquinas_lectura on public.biobox_peru_maquinas;
create policy biobox_peru_maquinas_lectura on public.biobox_peru_maquinas
  for select to authenticated using (tiene_rol('manager'::app_role));

drop policy if exists biobox_peru_hist_lectura on public.biobox_peru_maquinas_historial;
create policy biobox_peru_hist_lectura on public.biobox_peru_maquinas_historial
  for select to authenticated using (tiene_rol('manager'::app_role));

-- ------------------------------------------------------------
-- 2) Las máquinas de Perú como filas de inventario.
-- ------------------------------------------------------------
create or replace function public.refrescar_inventario_biobox_peru()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  n int;
begin
  delete from inventario i
   where exists (select 1 from biobox_peru_maquinas p where p.vendor_face_id = i.vendor_face_id);

  insert into inventario (
    vendor_face_id, site_id, direccion, municipio, tipo_medio, estado,
    longitud, latitud, unidad_negocio, tipo_mueble, categoria, cara, site_legacy_id,
    face_status, fuera_servicio_motivo, fuera_servicio_notas, fecha_retiro
  )
  select
    p.vendor_face_id,
    p.vendor_face_id,                               -- una cara por sitio, como las M5 de México
    upper(nullif(concat_ws(', ',
      nullif(trim(concat_ws(' ', nullif(trim(p.calle), ''), nullif(trim(p.numero), ''))), ''),
      nullif(trim(p.distrito), '')), '')),
    nullif(trim(p.distrito), ''),                   -- el distrito hace de alcaldía
    'Digital',
    coalesce(nullif(trim(p.estado), ''), 'Lima'),   -- de aquí sale la plaza de la incidencia
    p.longitud,
    p.latitud,
    'Biobox Perú',
    'M5',
    'Máquina Reciclaje',
    'IID',
    p.biobox_id || coalesce(' · ' || nullif(upper(trim(p.referencia)), ''), ''),
    case when coalesce(p.enabled, false) and coalesce(p.is_operational, false)
              and lower(coalesce(p.estatus_origen, '')) = 'available'
         then 'Active' else 'Out Of Service' end,
    case when not coalesce(p.enabled, false) then 'Desactivada'
         when not coalesce(p.is_operational, false) then 'No operativa'
         when lower(coalesce(p.estatus_origen, '')) <> 'available' then 'En mantenimiento'
    end,
    null,
    null
  from biobox_peru_maquinas p
  where p.activa;

  get diagnostics n = row_count;
  return n;
end
$function$;

revoke all on function public.refrescar_inventario_biobox_peru() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3) Carga de Perú (la llama la tarea programada con la llave de servicio).
--    datos: [{biobox_id, alias, enabled, is_operational, estatus, modelo,
--             tipo, calle, numero, distrito, municipio, estado, cp,
--             referencia, latitud, longitud, creado_en, actualizado_en}]
-- ------------------------------------------------------------
create or replace function public.sincronizar_biobox_peru(datos jsonb, p_forzar boolean default false)
returns jsonb
language plpgsql
security definer
-- pg_temp al final y explícito: la tabla temporal de abajo no puede tapar
-- (ni ser tapada por) una tabla de public.
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_jwt_rol     text;
  n_recibidas   int;
  n_validas     int;
  n_activas     int;
  v_rechazadas  jsonb;
  v_duplicadas  jsonb;
  v_altas       jsonb;
  v_reactivadas jsonb;
  v_bajas       jsonb;
  n_cambios     int := 0;
  n_inventario  int;
begin
  v_jwt_rol := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if session_user not in ('postgres', 'supabase_admin')
     and v_jwt_rol <> 'service_role'
     and not tiene_rol('manager'::app_role)
  then
    raise exception 'No tienes permiso para cargar el inventario de Biobox Perú (se requiere manager o el proceso de sincronización).';
  end if;

  -- Se turna con reemplazar_inventario: las dos tocan `inventario`.
  perform pg_advisory_xact_lock(hashtext('inventario'));

  n_recibidas := jsonb_array_length(coalesce(datos, '[]'::jsonb));
  if n_recibidas = 0 then
    raise exception 'ABORTADO: no llegó ninguna máquina de Perú.';
  end if;

  drop table if exists pg_temp._peru_entrantes;
  create temp table _peru_entrantes on commit drop as
  -- BI-57 y BI-057 son la misma máquina: se guarda siempre BI-057.
  select case when f.num is null then upper(trim(f.biobox_id))
              else 'BI-' || lpad(f.num::int::text, greatest(3, length(f.num::int::text)), '0') end as biobox_id,
         case when f.num is null then null
              else 'PE_LM_BB_IID_' || lpad(f.num::int::text, 4, '0') end as vendor_face_id,
         nullif(trim(f.alias), '') as alias,
         f.enabled, f.is_operational,
         nullif(trim(f.estatus), '') as estatus_origen,
         nullif(trim(f.modelo), '') as modelo_origen,
         nullif(trim(f.tipo), '') as tipo_origen,
         nullif(trim(f.calle), '') as calle,
         nullif(trim(f.numero), '') as numero,
         nullif(trim(f.distrito), '') as distrito,
         nullif(trim(f.municipio), '') as municipio,
         nullif(trim(f.estado), '') as estado,
         nullif(trim(f.cp), '') as cp,
         nullif(trim(f.referencia), '') as referencia,
         round(f.latitud, 7)::numeric(10,7) as latitud,
         round(f.longitud, 7)::numeric(10,7) as longitud,
         f.creado_en as creado_origen,
         f.actualizado_en as actualizado_origen
  from (
    select r.*, substring(upper(trim(r.biobox_id)) from '^BI-([0-9]{1,4})$') as num
    from jsonb_to_recordset(datos) as r (
      biobox_id text, alias text, enabled boolean, is_operational boolean,
      estatus text, modelo text, tipo text, calle text, numero text,
      distrito text, municipio text, estado text, cp text, referencia text,
      latitud numeric, longitud numeric, creado_en timestamp, actualizado_en timestamp
    )
  ) f;

  -- Un id que no sea BI-<número> no se puede convertir en clave: se reporta.
  select jsonb_agg(coalesce(biobox_id, '(vacío)')) into v_rechazadas
    from _peru_entrantes where vendor_face_id is null;
  delete from _peru_entrantes where vendor_face_id is null;
  -- Sin esto, un cambio de formato (o un campo mal nombrado en el script)
  -- daría de baja todas las máquinas sin avisar.
  if not exists (select 1 from _peru_entrantes) then
    raise exception 'ABORTADO: ninguna máquina válida (rechazadas: %).', v_rechazadas;
  end if;
  if v_rechazadas is not null and not coalesce(p_forzar, false) then
    raise exception 'ABORTADO: ids que no son BI-<número>: %. Corrige el origen o carga con p_forzar.', v_rechazadas;
  end if;

  -- Dos filas con la misma clave (BI-57 y BI-057) = datos que no cuadran.
  select jsonb_agg(vendor_face_id) into v_duplicadas from (
    select vendor_face_id from _peru_entrantes group by 1 having count(*) > 1) d;
  if v_duplicadas is not null then
    raise exception 'ABORTADO: máquinas repetidas en la carga: %', v_duplicadas;
  end if;

  select count(*) into n_validas from _peru_entrantes;
  select count(*) into n_activas from biobox_peru_maquinas where activa;

  -- Guarda contra una consulta incompleta: no dar de baja de golpe más del
  -- 20 % de lo activo. Con p_forzar (manager) se acepta a propósito.
  if not coalesce(p_forzar, false) and n_activas >= 10 and n_validas < ceil(n_activas * 0.8) then
    raise exception 'ABORTADO: llegaron % máquinas válidas y hay % activas. No se dan de baja de golpe; revisa la consulta o carga con p_forzar.',
      n_validas, n_activas;
  end if;

  -- Una clave de Perú no puede chocar con una de QTM.
  if exists (
    select 1 from _peru_entrantes e
    join inventario i on i.vendor_face_id = e.vendor_face_id
    where not exists (select 1 from biobox_peru_maquinas p where p.vendor_face_id = i.vendor_face_id)
  ) then
    raise exception 'ABORTADO: una clave de Perú ya existe en el inventario de QTM.';
  end if;

  -- Historial: altas, reactivadas, bajas y cambios de lo que importa
  -- (no updatedAt, que la máquina toca casi a diario).
  with ins as (
    insert into biobox_peru_maquinas_historial (biobox_id, vendor_face_id, evento)
    select e.biobox_id, e.vendor_face_id, 'alta'
    from _peru_entrantes e
    where not exists (select 1 from biobox_peru_maquinas p where p.biobox_id = e.biobox_id)
    returning biobox_id)
  select jsonb_agg(biobox_id) into v_altas from ins;

  with ins as (
    insert into biobox_peru_maquinas_historial (biobox_id, vendor_face_id, evento)
    select e.biobox_id, e.vendor_face_id, 'reactivada'
    from _peru_entrantes e
    join biobox_peru_maquinas p on p.biobox_id = e.biobox_id
    where not p.activa
    returning biobox_id)
  select jsonb_agg(biobox_id) into v_reactivadas from ins;

  with ins as (
    insert into biobox_peru_maquinas_historial (biobox_id, vendor_face_id, evento)
    select p.biobox_id, p.vendor_face_id, 'baja'
    from biobox_peru_maquinas p
    where p.activa
      and not exists (select 1 from _peru_entrantes e where e.biobox_id = p.biobox_id)
    returning biobox_id)
  select jsonb_agg(biobox_id) into v_bajas from ins;

  with comp as (
    select e.biobox_id, e.vendor_face_id,
           jsonb_build_object(
             'alias', p.alias, 'enabled', p.enabled, 'is_operational', p.is_operational,
             'estatus', p.estatus_origen, 'modelo', p.modelo_origen, 'tipo', p.tipo_origen,
             'calle', p.calle, 'numero', p.numero, 'distrito', p.distrito,
             'municipio', p.municipio, 'estado', p.estado, 'cp', p.cp,
             'referencia', p.referencia, 'latitud', p.latitud, 'longitud', p.longitud) as a,
           jsonb_build_object(
             'alias', e.alias, 'enabled', e.enabled, 'is_operational', e.is_operational,
             'estatus', e.estatus_origen, 'modelo', e.modelo_origen, 'tipo', e.tipo_origen,
             'calle', e.calle, 'numero', e.numero, 'distrito', e.distrito,
             'municipio', e.municipio, 'estado', e.estado, 'cp', e.cp,
             'referencia', e.referencia, 'latitud', e.latitud, 'longitud', e.longitud) as d
    from _peru_entrantes e
    join biobox_peru_maquinas p on p.biobox_id = e.biobox_id
    where p.activa
  ),
  dif as (
    select c.biobox_id, c.vendor_face_id,
           (select jsonb_object_agg(k, jsonb_build_array(c.a -> k, c.d -> k))
              from jsonb_object_keys(c.d) k
             where (c.a -> k) is distinct from (c.d -> k)) as cambios
    from comp c
  )
  insert into biobox_peru_maquinas_historial (biobox_id, vendor_face_id, evento, cambios)
  select biobox_id, vendor_face_id, 'cambio', cambios from dif where cambios is not null;
  get diagnostics n_cambios = row_count;

  -- La tabla aislada queda igual que el origen.
  insert into biobox_peru_maquinas as p (
    biobox_id, vendor_face_id, alias, enabled, is_operational, estatus_origen,
    modelo_origen, tipo_origen, calle, numero, distrito, municipio, estado, cp,
    referencia, latitud, longitud, creado_origen, actualizado_origen)
  select biobox_id, vendor_face_id, alias, enabled, is_operational, estatus_origen,
         modelo_origen, tipo_origen, calle, numero, distrito, municipio, estado, cp,
         referencia, latitud, longitud, creado_origen, actualizado_origen
  from _peru_entrantes
  on conflict (biobox_id) do update set
    vendor_face_id = excluded.vendor_face_id, alias = excluded.alias,
    enabled = excluded.enabled, is_operational = excluded.is_operational,
    estatus_origen = excluded.estatus_origen, modelo_origen = excluded.modelo_origen,
    tipo_origen = excluded.tipo_origen, calle = excluded.calle, numero = excluded.numero,
    distrito = excluded.distrito, municipio = excluded.municipio, estado = excluded.estado,
    cp = excluded.cp, referencia = excluded.referencia, latitud = excluded.latitud,
    longitud = excluded.longitud, creado_origen = excluded.creado_origen,
    actualizado_origen = excluded.actualizado_origen,
    activa = true, visto_ultima_vez = now(), baja_en = null;

  update biobox_peru_maquinas p set activa = false, baja_en = now()
   where p.activa
     and not exists (select 1 from _peru_entrantes e where e.biobox_id = p.biobox_id);

  n_inventario := refrescar_inventario_biobox_peru();

  return jsonb_build_object(
    'ok', true,
    'recibidas', n_recibidas,
    'validas', n_validas,
    'rechazadas', coalesce(v_rechazadas, '[]'::jsonb),
    'altas', coalesce(v_altas, '[]'::jsonb),
    'reactivadas', coalesce(v_reactivadas, '[]'::jsonb),
    'bajas', coalesce(v_bajas, '[]'::jsonb),
    'cambios', n_cambios,
    'en_inventario', n_inventario
  );
end
$function$;

revoke all on function public.sincronizar_biobox_peru(jsonb, boolean) from public, anon;
grant execute on function public.sincronizar_biobox_peru(jsonb, boolean) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4) reemplazar_inventario: igual que antes, pero solo reemplaza lo de QTM.
--    Las filas de Perú (las que están en biobox_peru_maquinas) no se borran,
--    no cuentan como "baja" en el historial ni como huérfanas.
-- ------------------------------------------------------------
create or replace function public.reemplazar_inventario(datos jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  n_recibidas int;
  n_actuales  int;
  n_final     int;
  n_peru      int;
  umbral_min  int := 100;
  huerfanas   jsonb;
  n_huerfanas int;
  n_hist      int := 0;
  v_jwt_rol   text;
begin
  v_jwt_rol := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');

  if session_user not in ('postgres', 'supabase_admin')
     and v_jwt_rol <> 'service_role'
     and not tiene_rol('manager'::app_role)
  then
    raise exception 'No tienes permiso para reemplazar el inventario (se requiere manager o el proceso de sincronización).';
  end if;

  -- Se turna con sincronizar_biobox_peru: las dos tocan `inventario`.
  perform pg_advisory_xact_lock(hashtext('inventario'));

  n_recibidas := jsonb_array_length(coalesce(datos, '[]'::jsonb));
  select count(*) into n_actuales
    from inventario i
   where not exists (select 1 from biobox_peru_maquinas p where p.vendor_face_id = i.vendor_face_id);

  if n_recibidas < umbral_min then
    raise exception 'ABORTADO: llegaron % filas (< umbral %). No se reemplaza el inventario para evitar pérdida de datos.',
      n_recibidas, umbral_min;
  end if;

  with entrantes as (
    select f.vendor_face_id, f.site_id, f.site_legacy_id,
           f.face_status, f.fuera_servicio_motivo,
           f.fuera_servicio_notas, a_fecha(f.fecha_retiro) as fecha_retiro
    from jsonb_to_recordset(datos) as f (
      vendor_face_id        text,
      site_id               text,
      site_legacy_id        text,
      face_status           text,
      fuera_servicio_motivo text,
      fuera_servicio_notas  text,
      fecha_retiro          text
    )
    where f.vendor_face_id is not null
      and not exists (select 1 from biobox_peru_maquinas p where p.vendor_face_id = f.vendor_face_id)
  ),
  de_qtm as (
    select i.* from inventario i
    where not exists (select 1 from biobox_peru_maquinas p where p.vendor_face_id = i.vendor_face_id)
  ),
  cambios as (
    select coalesce(e.vendor_face_id, i.vendor_face_id) as vendor_face_id,
           coalesce(e.site_id, i.site_id)               as site_id,
           coalesce(e.site_legacy_id, i.site_legacy_id) as site_legacy_id,
           case when i.vendor_face_id is null then 'alta'
                when e.vendor_face_id is null then 'baja'
                else 'cambio' end as evento,
           i.face_status            as status_anterior,
           e.face_status            as status_nuevo,
           i.fuera_servicio_motivo  as motivo_anterior,
           e.fuera_servicio_motivo  as motivo_nuevo,
           i.fuera_servicio_notas   as notas_anterior,
           e.fuera_servicio_notas   as notas_nuevas,
           i.fecha_retiro           as retiro_anterior,
           e.fecha_retiro           as retiro_nuevo
    from de_qtm i
    full outer join entrantes e on e.vendor_face_id = i.vendor_face_id
    where
      i.vendor_face_id is null
      or e.vendor_face_id is null
      or i.face_status           is distinct from e.face_status
      or i.fuera_servicio_motivo is distinct from e.fuera_servicio_motivo
      -- Aquí es donde QTM escribe la razón de verdad. Sin esta línea, un
      -- cambio de motivo pasaba sin registrarse.
      or i.fuera_servicio_notas  is distinct from e.fuera_servicio_notas
      or i.fecha_retiro          is distinct from e.fecha_retiro
  )
  insert into inventario_estatus_historial (
    vendor_face_id, site_id, site_legacy_id, evento,
    status_anterior, status_nuevo, motivo_anterior, motivo_nuevo,
    notas_anterior, notas_nuevas, retiro_anterior, retiro_nuevo)
  select vendor_face_id, site_id, site_legacy_id, evento,
         status_anterior, status_nuevo, motivo_anterior, motivo_nuevo,
         notas_anterior, notas_nuevas, retiro_anterior, retiro_nuevo
  from cambios;

  get diagnostics n_hist = row_count;

  with entrantes as (
    select f.vendor_face_id
    from jsonb_to_recordset(datos) as f(vendor_face_id text)
    where f.vendor_face_id is not null
  ),
  con_trabajo as (
    select i.vendor_face_id
    from inventario i
    where i.vendor_face_id not in (select vendor_face_id from entrantes)
      and not exists (select 1 from biobox_peru_maquinas p where p.vendor_face_id = i.vendor_face_id)
      and (
        exists (select 1 from qtm_pautas p where p.vendor_face_id = i.vendor_face_id)
        or exists (
          select 1 from fijaciones fj
          join qtm_pautas p2 on p2.selected_face_id = fj.selected_face_id
          where p2.vendor_face_id = i.vendor_face_id)
      )
  )
  select jsonb_agg(vendor_face_id), count(*) into huerfanas, n_huerfanas from con_trabajo;

  -- Antes: truncate table inventario. Ahora solo lo de QTM: las de Perú se
  -- quedan (las mantiene sincronizar_biobox_peru).
  delete from inventario i
   where not exists (select 1 from biobox_peru_maquinas p where p.vendor_face_id = i.vendor_face_id);

  insert into inventario (
    vendor_face_id, site_id, direccion, municipio, tipo_medio, estado,
    longitud, latitud, unidad_negocio, tipo_mueble, categoria, cara, site_legacy_id,
    face_status, fuera_servicio_motivo, fuera_servicio_notas, fecha_retiro
  )
  select
    f.vendor_face_id, f.site_id, f.direccion, f.municipio, f.tipo_medio, f.estado,
    f.longitud, f.latitud, f.unidad_negocio, f.tipo_mueble, f.categoria, f.cara, f.site_legacy_id,
    f.face_status, f.fuera_servicio_motivo, f.fuera_servicio_notas, a_fecha(f.fecha_retiro)
  from jsonb_to_recordset(datos) as f (
    vendor_face_id text, site_id text, direccion text, municipio text,
    tipo_medio text, estado text, longitud double precision, latitud double precision,
    unidad_negocio text, tipo_mueble text, categoria text, cara text, site_legacy_id text,
    face_status text, fuera_servicio_motivo text, fuera_servicio_notas text,
    fecha_retiro text
  )
  where f.vendor_face_id is not null
    and not exists (select 1 from biobox_peru_maquinas p where p.vendor_face_id = f.vendor_face_id);

  select count(*) into n_final from inventario;
  select count(*) into n_peru
    from inventario i
   where exists (select 1 from biobox_peru_maquinas p where p.vendor_face_id = i.vendor_face_id);

  return jsonb_build_object(
    'ok', true,
    'recibidas', n_recibidas,
    'antes', n_actuales,
    'despues', n_final - n_peru,
    'peru_conservadas', n_peru,
    'cambios_registrados', n_hist,
    'huerfanas_con_trabajo', coalesce(n_huerfanas, 0),
    'huerfanas_ids', coalesce(huerfanas, '[]'::jsonb)
  );
end;
$function$;
