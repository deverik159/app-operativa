-- ============================================================
-- incidencias_de_sitios — las incidencias de los sitios de una pauta, para
-- el bloque "Incidencias de los sitios" de Indicadores de Pauta (Erik,
-- 14-oct-2026). Re-ejecutable. Aplicada en producción el 14-oct-2026.
--
-- POR QUÉ UNA FUNCIÓN y no una consulta a `incidencias`: la RLS de esa
-- tabla le enseña al monitorista solo lo de su área (o nada), y aquí tiene
-- que ver todo lo de los sitios de su ruta. Es el mismo criterio de
-- estado_maquina / estado_maquinas (security definer, solo con sesión, y
-- devuelve lo justo: qué es, en qué estatus, de qué área y cuánto lleva; ni
-- quién capturó, ni diagnósticos, ni causas).
--
-- QUÉ DEVUELVE, de los sitios que se le pasan:
--   · ABIERTAS: reportado, por_validar, en_proceso y rechazada ("Devuelta").
--     "reparado" ya no cuenta como abierta (decisión del 14-oct-2026).
--   · RESUELTAS EN EL PERIODO [p_desde, p_hasta] (días de CDMX): reparadas
--     (repaired_at) y cerradas (cerrada_en) dentro de la catorcena.
--   no_reparado no sale.
-- ============================================================
create or replace function public.incidencias_de_sitios(p_site_ids text[], p_desde date, p_hasta date)
returns table(
  record_id text,
  folio text,
  clave_sitio text,
  clave_medio text,
  nombre_incidencia text,
  nivel text,
  estatus text,
  area text,
  fecha_reporte timestamptz,
  horas_en_estatus numeric,
  repaired_at timestamptz,
  cerrada_en timestamptz,
  observaciones text,
  es_abierta boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if auth_email() is null then
    raise exception 'Hay que iniciar sesión.' using errcode = '42501';
  end if;
  if coalesce(array_length(p_site_ids, 1), 0) > 5000 then
    raise exception 'Demasiados sitios en una sola consulta.';
  end if;

  return query
  select
    i.record_id,
    i.folio,
    i.clave_sitio,
    i.clave_medio,
    i.nombre_incidencia,
    i.nivel::text,
    i.estatus::text,
    coalesce(i.assigned_area, i.area_responsable) as area,
    i.fecha_reporte,
    -- Los mismos relojes que estado_maquina.
    round(extract(epoch from (now() - case
      when i.estatus = 'en_proceso' then coalesce(i.validator_at, i.sla_reparacion_inicio, i.fecha_reporte)
      else i.fecha_reporte
    end)) / 3600.0, 1) as horas_en_estatus,
    i.repaired_at,
    i.cerrada_en,
    i.observaciones,
    (i.estatus in ('reportado', 'por_validar', 'en_proceso', 'rechazada')) as es_abierta
  from incidencias i
  where i.clave_sitio = any(p_site_ids)
    and (
      i.estatus in ('reportado', 'por_validar', 'en_proceso', 'rechazada')
      or (i.estatus = 'reparado'
          and (i.repaired_at at time zone 'America/Mexico_City')::date between p_desde and p_hasta)
      or (i.estatus = 'cerrada'
          and (i.cerrada_en at time zone 'America/Mexico_City')::date between p_desde and p_hasta)
    )
  order by
    (i.estatus in ('reportado', 'por_validar', 'en_proceso', 'rechazada')) desc,
    case i.estatus when 'en_proceso' then 1 when 'por_validar' then 2 when 'reportado' then 2 when 'rechazada' then 3 else 4 end,
    i.fecha_reporte;
end
$function$;

revoke all on function public.incidencias_de_sitios(text[], date, date) from public, anon;
grant execute on function public.incidencias_de_sitios(text[], date, date) to authenticated, service_role;

notify pgrst, 'reload schema';
