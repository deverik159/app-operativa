-- ============================================================
-- importar_plano_vv: p_slots no cambia los slots de espacios INACTIVOS
-- (pendiente de la revisión adversarial del 19-oct-2026). Re-ejecutable.
--
-- QUÉ CAMBIA (solo el ajuste de slots del final; tres líneas)
--   1. El update de vv_espacios lleva «and e.activo». Las líneas del plano
--      ya exigían espacios activos (si no, la importación entera se
--      rechaza), pero las claves de p_slots no se validaban: llamando la
--      función directo por la API se podían cambiar los slots de un
--      espacio dado de baja (la 646 o las de EDO MEX). La pantalla ya los
--      filtraba (DisponibilidadVV.tsx, ImportarPlano); ahora también la
--      base. Una clave inactiva en p_slots se ignora sin error, como ya
--      pasaba con las inexistentes.
--   2. (Lo encontró revisor-rls, 19-oct-2026) Un valor de p_slots que no
--      es número ("abc", null, 12.0) se volvía null y, si el espacio no
--      traía líneas, dejaba la columna en 24 slots: least(24, null) da 24
--      en Postgres; y si tenía algo al aire, la bajaba a lo ocupado. Ahora
--      esa clave se ignora del todo, también en la lista de espacios cuyo
--      «sigue al aire» se mira. El patrón es [0-9] y no \d, que en
--      Postgres acepta dígitos no ASCII («٣») y luego el cast truena.
--      La app nunca manda eso.
--
-- QUÉ NO CAMBIA
--   Todo lo demás es idéntico a 20261020035922_vv_ocupacion.sql (cuerpo
--   en producción comprobado con md5 de prosrc el 19-oct-2026): mismos
--   parámetros, SECURITY DEFINER, search_path, candado, validaciones,
--   permisos y grants. ajustar_slots_vv no se toca: ya exige activo.
-- ============================================================

set lock_timeout = '5s';

create or replace function public.importar_plano_vv(
  p_mes    text,
  p_lineas jsonb,
  p_slots  jsonb default '{}'::jsonb
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
declare
  v_email    text := auth_email();
  v_borradas int  := 0;
  v_nuevas   int  := 0;
  v_slots    int  := 0;
  v_faltan   text[];
  v_mala     text;
begin
  if v_email is null
     or not (tiene_rol('comercial'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo comercial o manager importan el plano de Vía Verde.'
      using errcode = '42501';
  end if;
  if p_mes is null or p_mes !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Mes del plano inválido: %', coalesce(p_mes, '(vacío)');
  end if;
  if p_lineas is null or jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then
    raise exception 'El plano no trae líneas.';
  end if;
  if p_slots is not null and jsonb_typeof(p_slots) <> 'object' then
    raise exception 'p_slots debe ser un objeto {clave: slots}.';
  end if;

  -- Una importación a la vez, de cualquier mes: todas tocan vv_espacios.
  perform pg_advisory_xact_lock(hashtext('importar_plano_vv'));

  -- Antes de borrar nada: la primera línea mala, con su fila del Excel.
  -- (Días 0-6, horas 0-23, negociación y estatus los frenan los checks.)
  select coalesce(l->>'fila', 'línea ' || i) into v_mala
    from jsonb_array_elements(p_lineas) with ordinality t(l, i)
   where jsonb_typeof(l) <> 'object'
      or coalesce(l->>'slot', '') !~ '^([1-9]|1[0-9]|2[0-4])$'
      or not pg_input_is_valid(coalesce(l->>'inicio', ''), 'date')
      or not pg_input_is_valid(coalesce(l->>'fin', ''), 'date')
      or jsonb_typeof(l->'horas') is distinct from 'array'
      -- (case: jsonb_array_length truena si no es arreglo y el OR no tiene orden)
      or case when jsonb_typeof(l->'horas') = 'array'
              then jsonb_array_length(l->'horas') = 0 else false end
      or coalesce(btrim(l->>'campana'), '') = ''
      or (l ? 'dias' and jsonb_typeof(l->'dias') not in ('array', 'null'))
   limit 1;
  if v_mala is not null then
    raise exception 'El plano trae una línea inválida (fila %): revisa slot, fechas u horario.', v_mala;
  end if;

  select array_agg(distinct coalesce(l->>'espacio', '(sin espacio)')
                   order by coalesce(l->>'espacio', '(sin espacio)')) into v_faltan
    from jsonb_array_elements(p_lineas) l
   where not exists (select 1 from vv_espacios e
                      where e.clave = l->>'espacio' and e.activo);
  if v_faltan is not null then
    raise exception 'Espacios que no están activos en el catálogo: %',
      array_to_string(v_faltan, ', ');
  end if;

  -- Reemplaza el plano de ese mes; lo capturado en la app no se toca.
  delete from vv_ocupacion where origen = 'plano' and plano_mes = p_mes;
  get diagnostics v_borradas = row_count;

  insert into vv_ocupacion
    (espacio_clave, slot, campana, negociacion, convencional, inicio, fin,
     dias, horas, estatus, reservada_hasta, origen, plano_mes, creada_por)
  select l->>'espacio',
         (l->>'slot')::smallint,
         btrim(l->>'campana'),
         coalesce(l->>'negociacion', 'VENTA'),
         coalesce((l->>'convencional')::boolean, false),
         (l->>'inicio')::date,
         (l->>'fin')::date,
         -- [] y null significan lo mismo (todos los días): se guarda null.
         case when jsonb_typeof(l->'dias') = 'array'
              then nullif(array(select (d)::smallint from jsonb_array_elements_text(l->'dias') d),
                          '{}'::smallint[])
         end,
         array(select (h)::smallint from jsonb_array_elements_text(l->'horas') h),
         coalesce(l->>'estatus', 'vendida'),
         null,           -- las apartadas del plano no vencen (Erik, 19-oct-2026)
         'plano',
         p_mes,
         v_email
    from jsonb_array_elements(p_lineas) l;
  get diagnostics v_nuevas = row_count;

  -- Slots de cada espacio del plano: lo mayor entre lo que dice el plano
  -- (p_slots, con renglones vacíos), el slot más alto de sus líneas y el
  -- de lo que SIGUE AL AIRE de otros meses o de la app (importar noviembre
  -- no debe achicar una columna que octubre usa hasta fin de mes); nunca
  -- menos del estándar de 8 ni más de 24. Solo los cambia el plano MÁS
  -- RECIENTE: reimportar un mes viejo no debe achicar la capacidad de hoy.
  -- (Fase 2: las reservas de la app deben tomar este mismo candado.)
  if p_mes >= coalesce((select max(plano_mes) from vv_ocupacion
                         where origen = 'plano' and plano_mes <> p_mes), p_mes) then
    update vv_espacios e
       set slots = s.n
      from (select k, greatest(8, least(24, max(n))) as n
              from (select l->>'espacio' as k, (l->>'slot')::int as n
                      from jsonb_array_elements(p_lineas) l
                    union all
                    select key, value::int
                      from jsonb_each_text(coalesce(p_slots, '{}'::jsonb))
                     where value ~ '^[0-9]{1,2}$'   -- lo que no es número se ignora
                    union all
                    select o.espacio_clave, o.slot
                      from vv_ocupacion o
                     where (o.origen = 'app' or o.fin >= current_date)
                       and o.espacio_clave in (
                             select l->>'espacio' from jsonb_array_elements(p_lineas) l
                             union
                             select key from jsonb_each_text(coalesce(p_slots, '{}'::jsonb))
                              where value ~ '^[0-9]{1,2}$')) x
             group by k) s
     where e.clave = s.k
       and e.activo   -- p_slots no cambia espacios inactivos (llamada directa por la API)
       and e.slots is distinct from s.n;
    get diagnostics v_slots = row_count;
  end if;

  return jsonb_build_object(
    'mes', p_mes,
    'borradas', v_borradas,
    'nuevas', v_nuevas,
    'slots_cambiados', v_slots
  );
end;
$function$;

revoke all on function public.importar_plano_vv(text, jsonb, jsonb) from public, anon;
grant execute on function public.importar_plano_vv(text, jsonb, jsonb) to authenticated, service_role;
