-- ============================================================
-- reparado_no_cuenta_abierta — una incidencia en `reparado` ya no cuenta
-- como abierta (Erik, 14-oct-2026). Re-ejecutable.
--
-- `reparado` = el técnico ya la arregló y solo falta que el validador lo
-- confirme. En Pauta salía igual en "N incidencias abiertas" del sitio, y el
-- monitorista la veía como algo pendiente en campo. Erik decidió que deje de
-- contar en TODA la app: Pauta, Máquinas Biobox (distintivo de la lista y
-- panel arriba del checklist) y la regla de duplicados de la revisión Biobox,
-- que usan estas dos funciones. `rechazada` (en pantalla "Devuelta") SÍ sigue
-- contando: todavía la tiene que corregir el reportante.
--
-- Solo cambia el filtro de estatus de las dos funciones; columnas, permisos
-- y orden se quedan igual. La regla de duplicados general
-- (incidencias_en_proceso_iguales) ya solo miraba `en_proceso`.
-- ============================================================
create or replace function public.estado_maquinas(p_site_ids text[])
returns table(site_id text, abiertas integer, en_proceso integer, por_validar integer, horas_peor numeric, areas text, hay_critica boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    -- `reparado` fuera desde el 14-oct-2026: ya se arregló, solo falta validarla.
    and i.estatus not in ('cerrada', 'no_reparado', 'reparado')
  group by i.clave_sitio;
end
$function$;

create or replace function public.estado_maquina(p_site_id text)
returns table(record_id text, folio text, nombre_incidencia text, nivel text, estatus text, area text, clave_medio text, fecha_reporte timestamp with time zone, horas_en_estatus numeric, es_de_mi_area boolean, observaciones text)
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    -- Mismo criterio que usa la RLS, así que no puede contradecirla.
    (coalesce(i.assigned_area, i.area_responsable)
       in (select mis_departamentos())) as es_de_mi_area,
    -- La observación de quien la reportó: es lo que la vuelve reconocible en
    -- campo ("no enciende desde la lluvia del lunes"). Antes iban nombres de
    -- a quién preguntarle; Erik los quitó: la conversación es con el ÁREA.
    i.observaciones
  from incidencias i
  where i.clave_sitio = p_site_id
    -- `reparado` fuera desde el 14-oct-2026: ya se arregló, solo falta validarla.
    and i.estatus not in ('cerrada', 'no_reparado', 'reparado')
  order by
    -- Lo detenido primero, y dentro de eso lo más viejo. Es el orden en que
    -- el operador tiene que actuar, no el orden en que se capturaron.
    case i.estatus when 'en_proceso' then 1 else 2 end,
    i.fecha_reporte;
end
$function$;
