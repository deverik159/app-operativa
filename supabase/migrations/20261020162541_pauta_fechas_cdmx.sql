-- Pauta: "hoy" es el día de la Ciudad de México, no el de UTC (20-oct-2026).
--
-- La base corre en UTC: después de las 18:00 de México, `current_date` ya es
-- mañana. Pasaba en dos lugares de Pauta:
--   · vw_pauta_riesgo_retiro: días para el retiro y la ventana de 90 días.
--   · importar_pauta: el conteo "caras_con_retiro_programado" del resumen.
-- Mismo arreglo que set_derivados (20261008222226_derivados_dia_cdmx.sql).
--
-- `a_fecha` NO se toca: solo convierte el texto 'AAAA-MM-DD' que manda el
-- puente de QTM (sync_inventario_supabase.py) y no depende de "hoy".
--
-- Las dos se reemplazan con la misma firma y las mismas columnas, así que
-- conservan dueño y permisos.

-- Candado: importar_pauta debe seguir siendo la del 14-oct-2026. Si otra
-- sesión la cambió, no se pisa.
do $$
begin
  if (select md5(replace(prosrc, E'\r', ''))
        from pg_proc
       where oid = 'public.importar_pauta(integer, text, jsonb, integer)'::regprocedure)
     <> 'f3bfb4d049554dabda9d32684ca2a737' then
    raise exception 'importar_pauta cambió en producción desde el 14-oct-2026; revisar antes de aplicar.';
  end if;
end;
$$;

create or replace view public.vw_pauta_riesgo_retiro as
 select i.vendor_face_id,
    i.site_id,
    i.direccion,
    i.municipio,
    i.unidad_negocio,
    i.face_status,
    i.fecha_retiro,
    (i.fecha_retiro - (now() at time zone 'America/Mexico_City')::date) as dias_para_retiro,
    p.campana,
    p.catorcena,
    c.fecha_inicio,
    c.fecha_fin,
    (c.fecha_fin > i.fecha_retiro) as rebasa_el_retiro,
    p.anio
   from ((inventario i
     join pautas p on ((p.vendor_face_id = i.vendor_face_id)))
     join catorcenas c on (((c.anio = p.anio) and (c.numero = p.catorcena))))
  where ((i.fecha_retiro is not null)
    and (i.fecha_retiro >= (now() at time zone 'America/Mexico_City')::date)
    and (i.fecha_retiro <= ((now() at time zone 'America/Mexico_City')::date + 90)));

create or replace function public.importar_pauta(p_catorcena integer, p_etiqueta text, p_filas jsonb, p_anio integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_borradas   int := 0;
  v_insertadas int := 0;
  v_email      text := lower(coalesce(auth_email(), ''));
  v_conservado int := 0;
  v_anio       int;
begin
  -- 1) Permiso. Se usan las funciones existentes del proyecto.
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'No tienes permiso para importar la pauta (se requiere coordinador o manager).';
  end if;

  if p_catorcena is null then
    raise exception 'Falta el número de catorcena.';
  end if;
  if p_filas is null or jsonb_array_length(p_filas) = 0 then
    raise exception 'El archivo no trae filas.';
  end if;

  -- Año (14-oct-2026): el que manda la app o, si no lo manda, la catorcena
  -- con ese número más cercana a hoy. Tiene que existir en el calendario.
  v_anio := coalesce(p_anio, anio_de_catorcena(p_catorcena));
  if v_anio is null or not exists (
    select 1 from catorcenas where anio = v_anio and numero = p_catorcena
  ) then
    raise exception 'La catorcena % de % no está en el calendario.', p_catorcena, coalesce(v_anio::text, '(sin año)');
  end if;

  -- 2) Cuánto avance de campo hay ya registrado para esta catorcena.
  --    Se informa de vuelta para que quien importa vea que NO se perdió.
  select count(*) into v_conservado
  from pauta_monitoreo where anio = v_anio and catorcena = p_catorcena;

  -- 3) Reemplazo: fuera lo viejo de ESTA catorcena. Las demás no se tocan.
  delete from pautas where anio = v_anio and catorcena = p_catorcena;
  get diagnostics v_borradas = row_count;

  -- 4) Carga.
  --    `distinct on` colapsa los duplicados exactos del archivo (la misma
  --    cara con el mismo contrato y corte aparece repetida hasta 12 veces).
  --    Sin esto, el índice único abortaría toda la importación por un error
  --    de captura del Excel.
  with filas as (
    select
      nullif(trim(x->>'site_id'),'')          as site_id,
      nullif(trim(x->>'vendor_face_id'),'')   as vendor_face_id,
      nullif(trim(x->>'clave'),'')            as clave,
      nullif(trim(x->>'cara'),'')             as cara,
      nullif(trim(x->>'direccion'),'')        as direccion,
      nullif(trim(x->>'id_estado'),'')        as id_estado,
      nullif(trim(x->>'estado'),'')           as estado,
      nullif(trim(x->>'id_medio'),'')         as id_medio,
      nullif(trim(x->>'medio'),'')            as medio,
      nullif(trim(x->>'ruta_clave'),'')       as ruta_clave,
      -- Solo se guarda como número si de verdad lo es. 'PLAZA' y 'EDOMEX'
      -- quedan en NULL: son plazas foráneas, no entran al recorrido.
      case when trim(coalesce(x->>'ruta_clave','')) ~ '^\d+$'
           then (trim(x->>'ruta_clave'))::int end as ruta_numero,
      case when trim(coalesce(x->>'secuencia','')) ~ '^\d+$'
           then (trim(x->>'secuencia'))::int end  as secuencia,
      nullif(trim(x->>'contract_number'),'')  as contract_number,
      nullif(trim(x->>'orden_fijacion'),'')   as orden_fijacion,
      nullif(trim(x->>'campana'),'')          as campana,
      nullif(trim(x->>'version'),'')          as version,
      nullif(trim(x->>'campana_anterior'),'') as campana_anterior,
      upper(nullif(trim(x->>'estatus'),''))   as estatus,
      nullif(trim(x->>'corte'),'')            as corte,
      nullif(trim(x->>'sales_person'),'')     as sales_person,
      nullif(trim(x->>'espec_fijacion'),'')   as espec_fijacion,
      nullif(trim(x->>'espec_toma'),'')       as espec_toma,
      -- Las fechas llegan como ISO (YYYY-MM-DD) desde el frontend.
      (nullif(trim(x->>'fecha_fijacion'),''))::date             as fecha_fijacion,
      (nullif(trim(x->>'fecha_toma'),''))::date                 as fecha_toma_archivo,
      (nullif(trim(x->>'fecha_comprobacion'),''))::date         as fecha_comprobacion_archivo,
      (nullif(trim(x->>'fecha_modificacion'),''))::date         as fecha_modificacion,
      nullif(trim(x->>'observaciones_campo'),'')     as observaciones_campo,
      nullif(trim(x->>'observaciones_analista'),'')  as observaciones_analista,
      nullif(trim(x->>'detalle_observaciones'),'')   as detalle_observaciones,
      nullif(trim(x->>'comentarios'),'')             as comentarios
    from jsonb_array_elements(p_filas) as x
  ),
  limpias as (
    select distinct on (vendor_face_id, coalesce(contract_number,''), coalesce(corte,''))
           *
    from filas
    -- Una fila sin cara no identifica nada: se descarta.
    where vendor_face_id is not null and site_id is not null
  )
  insert into pautas (
    anio, catorcena, etiqueta, site_id, vendor_face_id, clave, cara,
    direccion, id_estado, estado, id_medio, medio,
    ruta_clave, ruta_numero, secuencia,
    contract_number, orden_fijacion, campana, version, campana_anterior,
    estatus, corte, sales_person, espec_fijacion, espec_toma,
    fecha_fijacion, fecha_toma_archivo, fecha_comprobacion_archivo,
    fecha_modificacion, observaciones_campo, observaciones_analista,
    detalle_observaciones, comentarios, importado_por
  )
  select
    v_anio, p_catorcena, p_etiqueta, site_id, vendor_face_id, clave, cara,
    direccion, id_estado, estado, id_medio, medio,
    ruta_clave, ruta_numero, secuencia,
    contract_number, orden_fijacion, campana, version, campana_anterior,
    estatus, corte, sales_person, espec_fijacion, espec_toma,
    fecha_fijacion, fecha_toma_archivo, fecha_comprobacion_archivo,
    fecha_modificacion, observaciones_campo, observaciones_analista,
    detalle_observaciones, comentarios, v_email
  from limpias;

  get diagnostics v_insertadas = row_count;

  -- 5) Reporte de vuelta. Incluye cuántas caras quedaron sin coordenadas:
  --    es el dato que decide si el monitorista podrá navegar hacia ellas.
  return jsonb_build_object(
    'ok', true,
    'catorcena', p_catorcena,
    'anio', v_anio,
    'etiqueta', p_etiqueta,
    'recibidas', jsonb_array_length(p_filas),
    'borradas', v_borradas,
    'insertadas', v_insertadas,
    'duplicadas_omitidas', jsonb_array_length(p_filas) - v_insertadas,
    'avance_conservado', v_conservado,
    'campanas', (select count(distinct campana) from pautas where anio = v_anio and catorcena = p_catorcena),
    'sitios',   (select count(distinct site_id) from pautas where anio = v_anio and catorcena = p_catorcena),
    'sin_coordenadas', (
      select count(*) from vw_pauta_ruta
      where anio = v_anio and catorcena = p_catorcena and not navegable
    ),
    -- Riesgo de vender sobre inventario que no va a estar.
    'caras_fuera_servicio', (
      select count(*) from pautas pp
      join inventario ii on ii.vendor_face_id = pp.vendor_face_id
      where pp.anio = v_anio and pp.catorcena = p_catorcena
        and ii.face_status is distinct from 'Active'
    ),
    'caras_con_retiro_programado', (
      select count(*) from pautas pp
      join inventario ii on ii.vendor_face_id = pp.vendor_face_id
      where pp.anio = v_anio and pp.catorcena = p_catorcena
        and ii.fecha_retiro is not null
        -- "Hoy" en México: la base corre en UTC y después de las 18:00 ya sería mañana.
        and ii.fecha_retiro >= (now() at time zone 'America/Mexico_City')::date
    ),
    -- LA MÁS IMPORTANTE: la cara desaparece A MEDIA CAMPAÑA.
    'caras_que_rebasan_el_retiro', (
      select count(*) from pautas pp
      join inventario ii on ii.vendor_face_id = pp.vendor_face_id
      join catorcenas cc on cc.anio = pp.anio and cc.numero = pp.catorcena
      where pp.anio = v_anio and pp.catorcena = p_catorcena
        and ii.fecha_retiro is not null
        and cc.fecha_fin > ii.fecha_retiro
    ),
    'foraneas_sin_ruta', (
      select count(*) from pautas
      where anio = v_anio and catorcena = p_catorcena and ruta_numero is null
    )
  );
end;
$function$;

-- Verificar: las dos deben decir true.
-- select position('America/Mexico_City' in pg_get_viewdef('public.vw_pauta_riesgo_retiro'::regclass)) > 0 as vista,
--        position('America/Mexico_City' in pg_get_functiondef('public.importar_pauta(integer, text, jsonb, integer)'::regprocedure)) > 0
--          and position('current_date' in pg_get_functiondef('public.importar_pauta(integer, text, jsonb, integer)'::regprocedure)) = 0 as importar;
