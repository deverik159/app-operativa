-- 9-nov-2026 · Reportes de la app Biobox: la incidencia lleva la hora del usuario
--
-- Qué hace (decisión de Erik del 9-nov-2026): la incidencia que nace de un
--   reporte de la app Biobox (clasificada por la validadora o directa al área)
--   lleva como fecha_reporte la hora en que el usuario levantó el reporte, no
--   la hora en que entró a la app operativa. Con eso la semana, la catorcena,
--   «abiertas por antigüedad» y «reporte → validación» de Indicadores cuentan
--   desde que la persona tuvo el problema en la máquina.
--   El SLA de reparación NO cambia: lo arranca set_sla cuando la incidencia
--   llega al área (es lo justo para el técnico).
--
-- La fecha de Biobox es texto en UTC (la base Core trabaja en UTC: el monitor
--   registra session_timezone y system_timezone = UTC). Se lee como UTC y se
--   guarda como timestamptz; si no se puede leer, se usa la hora de ahora.
--
-- También corrige las incidencias que ya nacieron de un reporte (7 directas a
--   TI al 9-nov-2026: BB00001-BB00003 y BBP00001-BBP00004) y les recalcula
--   semana, catorcena y año con la misma regla que set_derivados (que solo
--   corre al insertar). Las ligadas no se tocan: ya existían y tienen su fecha.

set local lock_timeout = '5s';

-- Texto de Core ('2026-11-09 18:25:09', en UTC) → instante; null si no se puede leer.
create or replace function public.biobox_app_fecha_core(p_texto text)
returns timestamptz
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
begin
  if p_texto is null or btrim(p_texto) !~ '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?' then
    return null;
  end if;
  return (replace(left(btrim(p_texto), 19), 'T', ' ')::timestamp at time zone 'UTC');
exception when others then
  return null;
end $function$;
revoke all on function public.biobox_app_fecha_core(text) from public, anon, authenticated;

create or replace function public.biobox_app_crear_incidencia(
  p_report_id bigint, p_falla jsonb, p_clave text, p_validador text, p_obs text)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r    biobox_app_reportes%rowtype;
  inv  inventario%rowtype;
  cat  catalogo_incidencias%rowtype;
  v_id text;
  v_obs text;
  v_fecha timestamptz;
begin
  select * into r from biobox_app_reportes where report_id = p_report_id;
  if not found then
    raise exception 'No existe el reporte % de la app Biobox.', p_report_id;
  end if;
  if nullif(btrim(p_falla ->> 'detalle'), '') is null
     or nullif(btrim(p_falla ->> 'area'), '') is null then
    raise exception 'Falta la falla del catálogo (detalle y área).' using errcode = '23514';
  end if;
  -- Nivel, origen y tipo salen del catálogo DE LA UNIDAD, no de quien llama
  -- (revisor-rls, 9-nov-2026): inc_valida_datos solo revisa que el área exista
  -- en algún catálogo.
  select * into cat from catalogo_incidencias c
   where lower(btrim(c.unidad_negocio)) = lower(r.unidad_negocio)
     and c.detalle = btrim(p_falla ->> 'detalle')
     and c.area = btrim(p_falla ->> 'area')
   order by c.id
   limit 1;
  if not found then
    raise exception 'La falla «%» (%) no está en el catálogo de %.',
      btrim(p_falla ->> 'detalle'), btrim(p_falla ->> 'area'), r.unidad_negocio
      using errcode = '23514';
  end if;

  if p_clave is not null and p_clave <> 'SIN-MAQUINA' then
    select * into inv from inventario
     where vendor_face_id = p_clave and lower(unidad_negocio) = lower(r.unidad_negocio)
     limit 1;
    if not found then
      raise exception 'La máquina % no está en el inventario de %.', p_clave, r.unidad_negocio
        using errcode = '23514';
    end if;
  end if;

  -- Hora en que el usuario levantó el reporte en la app Biobox (Core en UTC),
  -- nunca en el futuro; si no se puede leer, la hora de ahora (Erik, 9-nov-2026).
  v_fecha := coalesce(least(biobox_app_fecha_core(r.fecha_reporte_core), now()), now());

  loop
    v_id := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    exit when not exists (select 1 from incidencias where record_id = v_id);
  end loop;

  -- Lo que escribió el usuario final NO se copia (puede traer su teléfono o
  -- correo): se queda en biobox_app_reportes, con su propia RLS.
  v_obs := 'App Biobox · reporte ' || coalesce(r.folio_app, r.report_id::text)
        || coalesce(' · ' || r.motivo, '')
        || coalesce(' · «' || r.etiqueta || '»', '')
        || coalesce(E'\n' || nullif(btrim(p_obs), ''), '');

  insert into incidencias (
    record_id, unidad_negocio, clave_sitio, clave_medio, direccion, municipio, plaza,
    medio, tipo_mueble, nombre_biobox, nombre_incidencia, area_responsable, nivel,
    origen, tipo, observaciones, area_reportante, captured_by, fecha_reporte,
    estatus, requiere_prevalidacion, validator_approved, validator_email, validator_at)
  values (
    v_id, r.unidad_negocio,
    case when inv.vendor_face_id is null then 'SIN-MAQUINA' else inv.site_id end,
    inv.vendor_face_id, inv.direccion, inv.municipio, inv.estado,
    inv.tipo_medio, inv.tipo_mueble, inv.site_legacy_id,
    cat.detalle, cat.area, nullif(btrim(cat.impacto), ''),
    nullif(btrim(cat.origen), ''), nullif(btrim(cat.tipo), ''),
    v_obs, 'App Biobox', null, v_fecha,
    'en_proceso', false,
    case when p_validador is not null then true end,
    p_validador,
    case when p_validador is not null then now() end);

  return v_id;
end $function$;
revoke all on function public.biobox_app_crear_incidencia(bigint, jsonb, text, text, text)
  from public, anon, authenticated;

-- Las que ya nacieron de un reporte: fecha del usuario y sus derivados.
with x as (
  select i.record_id,
         least(biobox_app_fecha_core(r.fecha_reporte_core), now()) as f
    from incidencias i
    join biobox_app_reportes r on r.record_id = i.record_id
   where r.decision in ('clasificado', 'directo')
     and i.area_reportante = 'App Biobox'
     -- Solo si la fecha de Core se puede leer: si no, se queda la que tiene
     -- (least() ignora los nulos y daría now()).
     and biobox_app_fecha_core(r.fecha_reporte_core) is not null
), y as (
  select x.record_id, x.f, (x.f at time zone 'America/Mexico_City')::date as d
    from x
)
update incidencias i
   set fecha_reporte = y.f,
       semana        = (floor((y.d - date '2026-01-05') / 7.0) + 1)::int::text,
       catorcena     = (select c.numero from catorcenas c
                         where y.d between c.fecha_inicio and c.fecha_fin limit 1),
       anio          = (select c.anio from catorcenas c
                         where y.d between c.fecha_inicio and c.fecha_fin limit 1)
  from y
 where i.record_id = y.record_id
   and i.fecha_reporte is distinct from y.f;
