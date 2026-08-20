-- ============================================================
-- importar_pauta.sql
-- Carga una catorcena completa desde el Excel de pauta.
--
-- COMPORTAMIENTO AL REIMPORTAR: reemplaza la catorcena.
-- Borra todo lo que había de esa catorcena en `pautas` y carga el archivo
-- nuevo. Es predecible: lo que ves en el Excel es lo que queda en la base.
--
-- Lo que NO borra: `pauta_monitoreo`. Ahí vive el trabajo de campo (fechas
-- de toma y comprobación registradas en la app) y se conserva íntegro. Ese
-- es justamente el motivo de tener dos tablas.
--
-- security definer: la RPC escribe con permisos elevados, pero valida el rol
-- con `tiene_rol` ANTES de tocar nada.
--
-- Aplicar después de pauta_schema.sql.
-- ============================================================

create or replace function importar_pauta(
  p_catorcena int,
  p_etiqueta  text,
  p_filas     jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_borradas   int := 0;
  v_insertadas int := 0;
  v_email      text := lower(coalesce(auth_email(), ''));
  v_conservado int := 0;
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

  -- 2) Cuánto avance de campo hay ya registrado para esta catorcena.
  --    Se informa de vuelta para que quien importa vea que NO se perdió.
  select count(*) into v_conservado
  from pauta_monitoreo where catorcena = p_catorcena;

  -- 3) Reemplazo: fuera lo viejo de ESTA catorcena. Las demás no se tocan.
  delete from pautas where catorcena = p_catorcena;
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
    catorcena, etiqueta, site_id, vendor_face_id, clave, cara,
    direccion, id_estado, estado, id_medio, medio,
    ruta_clave, ruta_numero, secuencia,
    contract_number, orden_fijacion, campana, version, campana_anterior,
    estatus, corte, sales_person, espec_fijacion, espec_toma,
    fecha_fijacion, fecha_toma_archivo, fecha_comprobacion_archivo,
    fecha_modificacion, observaciones_campo, observaciones_analista,
    detalle_observaciones, comentarios, importado_por
  )
  select
    p_catorcena, p_etiqueta, site_id, vendor_face_id, clave, cara,
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
    'etiqueta', p_etiqueta,
    'recibidas', jsonb_array_length(p_filas),
    'borradas', v_borradas,
    'insertadas', v_insertadas,
    'duplicadas_omitidas', jsonb_array_length(p_filas) - v_insertadas,
    'avance_conservado', v_conservado,
    'campanas', (select count(distinct campana) from pautas where catorcena = p_catorcena),
    'sitios',   (select count(distinct site_id) from pautas where catorcena = p_catorcena),
    'sin_coordenadas', (
      select count(*) from vw_pauta_ruta
      where catorcena = p_catorcena and not navegable
    ),
    'foraneas_sin_ruta', (
      select count(*) from pautas
      where catorcena = p_catorcena and ruta_numero is null
    )
  );
end;
$$;


-- ============================================================
-- registrar_toma / registrar_comprobacion
-- Las llama la app cuando el monitorista actúa en campo.
-- Escriben en pauta_monitoreo, que NO se borra al reimportar.
-- ============================================================

create or replace function registrar_toma(
  p_catorcena int,
  p_vendor_face_id text
)
returns void
language plpgsql
security definer
as $$
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;
  insert into pauta_monitoreo (catorcena, vendor_face_id, fecha_toma, toma_por)
  values (p_catorcena, p_vendor_face_id, now(), lower(auth_email()))
  on conflict (catorcena, vendor_face_id) do update
    -- No se pisa una toma anterior: la primera es la que cuenta como
    -- "cuándo estuvo ahí". Reescribirla borraría el dato real.
    set fecha_toma = coalesce(pauta_monitoreo.fecha_toma, excluded.fecha_toma),
        toma_por   = coalesce(pauta_monitoreo.toma_por,   excluded.toma_por),
        actualizado_en = now();
end;
$$;

create or replace function registrar_comprobacion(
  p_catorcena int,
  p_vendor_face_id text
)
returns void
language plpgsql
security definer
as $$
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;
  insert into pauta_monitoreo (
    catorcena, vendor_face_id, fecha_comprobacion, comprobacion_por)
  values (p_catorcena, p_vendor_face_id, now(), lower(auth_email()))
  on conflict (catorcena, vendor_face_id) do update
    set fecha_comprobacion = now(),
        comprobacion_por   = lower(auth_email()),
        actualizado_en     = now();
end;
$$;
