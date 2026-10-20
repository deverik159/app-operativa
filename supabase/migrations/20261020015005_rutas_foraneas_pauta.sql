-- ============================================================
-- rutas_foraneas_pauta — EDOMEX y PLAZA también son rutas asignables
-- (Erik, 19-oct-2026). Re-ejecutable.
--
-- ANTES: "Sincronizar rutas" solo creaba las rutas numéricas del archivo de
-- pauta; las foráneas (EDOMEX, PLAZA) se saltaban y no se podían asignar a
-- un monitorista. Al elegir EDOMEX en Pauta y asignar, la app tomaba la
-- ruta del único sitio de EDOMEX que estaba en alguna ruta ("Pantallas", de
-- Ecovallas Digital) y asignaba esa (corregido en la app el mismo día).
--
-- AHORA: sincronizar_rutas_desde_pauta también manda EDOMEX y PLAZA al
-- pipeline de siempre (importar_rutas, Ecovallas Impreso). La tabla de
-- rutas pide un número, así que:
--   EDOMEX → Ruta 901, nombre "EDOMEX"
--   PLAZA  → Ruta 902, nombre "PLAZA"
-- En Pauta se siguen viendo por su clave del archivo. Una clave no numérica
-- que no sea esas dos (o una numérica de 900 en adelante) se omite y se
-- cuenta en foraneos_omitidos. Los números 900+ quedan RESERVADOS para las
-- foráneas: siguiente_numero_ruta ya no los cuenta (si no, "Nueva ruta" de
-- Impreso propondría la 903 en vez de la 11).
-- Como en las rutas numéricas, la pauta manda: un sitio mixto que vivía en
-- una ruta de otro medio pasa a la de Impreso (hoy: MX_EM_EV_0004, que
-- estaba en "Pantallas" de Digital, pasa a EDOMEX).
-- Lo demás de la función queda igual que en 20261014172034.
-- ============================================================
create or replace function public.sincronizar_rutas_desde_pauta(p_catorcena integer, p_anio integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_filas    jsonb;
  v_sitios   int;
  v_foraneos int;
  v_res      jsonb;
  v_anio     int := coalesce(p_anio, anio_de_catorcena(p_catorcena));
begin
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo coordinador o manager pueden sincronizar rutas.';
  end if;

  -- Un renglón por SITIO: la secuencia más chica de sus caras (todas
  -- traen la misma en el archivo, pero por si acaso), estatus ACTIVA
  -- (está en la pauta vigente) y la dirección del archivo.
  with base as (
    select site_id, secuencia, direccion,
           case
             -- case anidado: el cast solo corre si la clave es numérica
             when ruta_clave ~ '^\d{1,3}$' then case when ruta_clave::int < 900 then ruta_clave::int end
             when upper(btrim(ruta_clave)) = 'EDOMEX' then 901
             when upper(btrim(ruta_clave)) = 'PLAZA' then 902
           end as numero
    from pautas
    where anio = v_anio and catorcena = p_catorcena
  )
  select jsonb_agg(fila), count(*)
    into v_filas, v_sitios
  from (
    select jsonb_build_object(
             'site_id',   site_id,
             'ruta',      numero,
             'secuencia', min(secuencia),
             'estatus',   'ACTIVA',
             'vallas',    null,
             'direccion', coalesce(max(direccion), ''),
             -- CAMBIO (rutas, 5-oct-2026): de dónde entró la parada.
             'origen',    'pauta'
           ) as fila
    from base
    where numero is not null
    group by site_id, numero
  ) s;

  select count(distinct site_id) into v_foraneos
  from pautas
  where anio = v_anio and catorcena = p_catorcena
    and not (
      case when ruta_clave ~ '^\d{1,3}$' then ruta_clave::int < 900 else false end
      or upper(btrim(coalesce(ruta_clave, ''))) in ('EDOMEX', 'PLAZA')
    );

  if v_sitios is null or v_sitios = 0 then
    raise exception 'La catorcena % de % no tiene sitios con ruta.', p_catorcena, coalesce(v_anio::text, '(sin año)');
  end if;

  -- El pipeline de siempre: crea rutas faltantes, actualiza secuencias y
  -- valida contra inventario. Pauta es Ecovallas Impreso.
  v_res := importar_rutas('Ecovallas', 'Impreso', v_filas);

  -- Las foráneas se llaman por su clave (importar_rutas crea sin nombre).
  update rutas_monitoreo
     set nombre = case numero when 901 then 'EDOMEX' else 'PLAZA' end
   where unidad_negocio = 'Ecovallas' and tipo_medio = 'Impreso'
     and numero in (901, 902)
     and coalesce(btrim(nombre), '') = '';

  return v_res || jsonb_build_object(
    'sitios_en_pauta', v_sitios,
    'foraneos_omitidos', v_foraneos
  );
end;
$function$;

-- Mismos permisos que dejó 20261014172034 (create or replace los conserva;
-- se repiten por si la función se recreó en otro lado).
revoke all on function public.sincronizar_rutas_desde_pauta(integer, integer) from public, anon;
grant execute on function public.sincronizar_rutas_desde_pauta(integer, integer) to authenticated, service_role;

-- Número sugerido para una ruta nueva: sin contar las reservadas (900+).
create or replace function public.siguiente_numero_ruta(p_unidad text, p_tipo text)
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
$function$;
