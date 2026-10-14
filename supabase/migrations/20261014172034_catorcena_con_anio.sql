-- ============================================================
-- catorcena_con_anio — la catorcena pasa a ser NÚMERO + AÑO (Erik,
-- 14-oct-2026). Fase 1 de 3: solo la base, compatible con la app de hoy.
--
-- POR QUÉ: hasta hoy la catorcena era solo su número (1..26) en el
-- calendario, la pauta, las tomas, las fotos y las incidencias. La Cat-1 de
-- 2027 chocaría con la Cat-1 de 2026 (la llave del calendario es el número),
-- así que el calendario no se podía extender a 2027.
--
-- QUÉ HACE:
--   1. Columna `anio` en catorcenas, pautas, pauta_monitoreo,
--      pauta_evidencias e incidencias. Todo lo que existe hoy es de 2026
--      (el calendario solo tiene 2026), así que se llena con 2026 sin
--      reescribir filas: ADD COLUMN con valor por omisión no dispara los
--      triggers de incidencias (avisos, SLA, blindaje).
--   2. Llaves con año: el calendario es (anio, numero) y las llaves únicas
--      de pauta y tomas llevan el año. Índices con el año al frente.
--   3. anio_de_catorcena(numero, fecha): para quien NO manda el año (la
--      versión de la app que hoy está en los teléfonos), toma la catorcena
--      con ese número más cercana a la fecha. Mientras solo exista 2026 da
--      siempre 2026.
--   4. Triggers que llenan el año si no llega: pauta_evidencias la inserta
--      la app directo; en las demás es por si acaso.
--   5. Las 5 RPC de Pauta reciben `p_anio` OPCIONAL al final. Sin él, se
--      deduce con anio_de_catorcena(). Se borran y se vuelven a crear (con
--      dos versiones vivas, la llamada por nombre sería ambigua) y se
--      restituyen los permisos de hoy: solo authenticated y service_role.
--   6. Vistas de Pauta: unen por año también y lo exponen como columna
--      NUEVA AL FINAL (regla de Pauta: si no, la vista no se reemplaza).
--   7. set_derivados (incidencias): llena el año junto con la catorcena.
--
-- QUÉ NO HACE: no carga 2027 (fase 3, después de la app) ni cambia la app
-- (fase 2). Tampoco toca la vista de Fijación Externa (su catorcena es
-- texto de Mario y ya trae el año).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Columnas. `default 2026` llena lo existente; luego se quita el
--    default para que nada nuevo quede en 2026 por descuido.
-- ------------------------------------------------------------
alter table public.catorcenas       add column if not exists anio int not null default 2026;
alter table public.pautas           add column if not exists anio int not null default 2026;
alter table public.pauta_monitoreo  add column if not exists anio int not null default 2026;
alter table public.pauta_evidencias add column if not exists anio int not null default 2026;
-- En incidencias puede ir vacío, igual que `catorcena`.
alter table public.incidencias      add column if not exists anio int default 2026;

alter table public.catorcenas       alter column anio drop default;
alter table public.pautas           alter column anio drop default;
alter table public.pauta_monitoreo  alter column anio drop default;
alter table public.pauta_evidencias alter column anio drop default;
alter table public.incidencias      alter column anio drop default;

comment on column public.catorcenas.anio is
  'Año de la catorcena según el calendario oficial (no siempre el de sus fechas: la Cat-27 de 2025 terminó el 5-ene-2026).';

-- ------------------------------------------------------------
-- 2) Llaves e índices con año.
-- ------------------------------------------------------------
alter table public.catorcenas drop constraint if exists catorcenas_pkey;
alter table public.catorcenas add constraint catorcenas_pkey primary key (anio, numero);
-- Dos catorcenas no pueden empezar el mismo día.
alter table public.catorcenas drop constraint if exists catorcenas_fecha_inicio_key;
alter table public.catorcenas add constraint catorcenas_fecha_inicio_key unique (fecha_inicio);

drop index if exists public.pautas_llave_uk;
create unique index pautas_llave_uk on public.pautas
  (anio, catorcena, vendor_face_id, coalesce(contract_number, ''), coalesce(corte, ''));
drop index if exists public.pautas_catorcena_idx;
create index pautas_catorcena_idx on public.pautas (anio, catorcena);
drop index if exists public.pautas_campana_idx;
create index pautas_campana_idx on public.pautas (anio, catorcena, campana);
drop index if exists public.pautas_ruta_idx;
create index pautas_ruta_idx on public.pautas (anio, catorcena, ruta_numero);

alter table public.pauta_monitoreo drop constraint if exists pauta_monitoreo_catorcena_vendor_face_id_key;
alter table public.pauta_monitoreo drop constraint if exists pauta_monitoreo_anio_catorcena_vendor_face_id_key;
alter table public.pauta_monitoreo add constraint pauta_monitoreo_anio_catorcena_vendor_face_id_key
  unique (anio, catorcena, vendor_face_id);
drop index if exists public.pauta_monit_cat_idx;
create index pauta_monit_cat_idx on public.pauta_monitoreo (anio, catorcena);

drop index if exists public.pauta_ev_cara_idx;
create index pauta_ev_cara_idx on public.pauta_evidencias (anio, catorcena, vendor_face_id);

-- ------------------------------------------------------------
-- 3) Año de una catorcena cuando solo se sabe el número: la que tiene ese
--    número más cerca de la fecha (hoy en CDMX si no se da). Los años
--    quedan a ~364 días, así que no hay empate posible.
-- ------------------------------------------------------------
create or replace function public.anio_de_catorcena(p_numero int, p_fecha date default null)
returns int
language sql
stable
set search_path to 'public'
as $function$
  select c.anio
  from catorcenas c
  where c.numero = p_numero
  order by abs(c.fecha_inicio - coalesce(p_fecha, (now() at time zone 'America/Mexico_City')::date))
  limit 1
$function$;

-- ------------------------------------------------------------
-- 4) Triggers: si una fila llega sin año, se deduce.
-- ------------------------------------------------------------
create or replace function public.pauta_fija_anio()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if new.anio is null and new.catorcena is not null then
    new.anio := anio_de_catorcena(new.catorcena);
  end if;
  if new.anio is null then
    raise exception 'La catorcena % no está en el calendario.', new.catorcena;
  end if;
  return new;
end
$function$;

drop trigger if exists trg_pauta_fija_anio on public.pautas;
create trigger trg_pauta_fija_anio before insert on public.pautas
  for each row execute function public.pauta_fija_anio();
drop trigger if exists trg_pauta_fija_anio on public.pauta_monitoreo;
create trigger trg_pauta_fija_anio before insert on public.pauta_monitoreo
  for each row execute function public.pauta_fija_anio();
drop trigger if exists trg_pauta_fija_anio on public.pauta_evidencias;
create trigger trg_pauta_fija_anio before insert on public.pauta_evidencias
  for each row execute function public.pauta_fija_anio();

-- Incidencias: la catorcena y su año salen de la fecha del reporte (CDMX).
create or replace function public.set_derivados()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare d date;
begin
  d := coalesce(
    (new.fecha_reporte at time zone 'America/Mexico_City')::date,
    (now() at time zone 'America/Mexico_City')::date
  );
  if new.semana is null then
    new.semana := (floor((d - date '2026-01-05') / 7.0) + 1)::int::text;
  end if;
  if new.catorcena is null then
    select numero, anio into new.catorcena, new.anio from catorcenas
    where d between fecha_inicio and fecha_fin
    limit 1;
  end if;
  -- Si la catorcena llegó escrita pero sin año (14-oct-2026).
  if new.anio is null and new.catorcena is not null then
    new.anio := anio_de_catorcena(new.catorcena, d);
  end if;
  return new;
end $function$;

-- ------------------------------------------------------------
-- 5) Vistas (columna `anio` nueva, al final).
-- ------------------------------------------------------------
create or replace view public.vw_pauta_ruta as
 select p.id,
    p.catorcena,
    p.etiqueta,
    p.site_id,
    p.vendor_face_id,
    p.cara,
    p.direccion,
    p.estado,
    p.medio,
    p.ruta_clave,
    p.ruta_numero,
    p.secuencia,
    p.campana,
    p.version,
    p.campana_anterior,
    p.estatus,
    p.corte,
    p.contract_number,
    p.orden_fijacion,
    p.fecha_fijacion,
    m.fecha_toma,
    m.toma_por,
    m.fecha_comprobacion,
    m.comprobacion_por,
    p.fecha_toma_archivo,
    p.fecha_comprobacion_archivo,
        case
            when (m.fecha_comprobacion is not null) then 'COMPROBADA'::text
            when (m.fecha_toma is not null) then 'TOMADA'::text
            else 'PENDIENTE'::text
        end as avance,
    inv.latitud,
    inv.longitud,
    ((inv.latitud is not null) and (inv.longitud is not null)) as navegable,
    ru.ruta_id as ruta_monitoreo_id,
    coalesce(ev.n, (0)::bigint) as fotos,
    p.espec_toma,
    m.rechazo_motivo,
    m.rechazada_por,
    p.anio
   from ((((pautas p
     left join pauta_monitoreo m on (((m.anio = p.anio) and (m.catorcena = p.catorcena) and (m.vendor_face_id = p.vendor_face_id))))
     left join lateral ( select inventario.latitud,
            inventario.longitud
           from inventario
          where (inventario.vendor_face_id = p.vendor_face_id)
         limit 1) inv on (true))
     left join ruta_ubicaciones ru on ((ru.site_id = p.site_id)))
     left join lateral ( select count(*) as n
           from pauta_evidencias e
          where ((e.anio = p.anio) and (e.catorcena = p.catorcena) and (e.vendor_face_id = p.vendor_face_id))) ev on (true));

create or replace view public.vw_pauta_resumen as
 select catorcena,
    ruta_clave,
    campana,
    count(*) as caras,
    count(distinct site_id) as sitios,
    count(*) filter (where (estatus = 'NUEVO'::text)) as nuevas,
    count(*) filter (where (estatus = 'REPITE'::text)) as repiten,
    count(*) filter (where (avance = 'PENDIENTE'::text)) as pendientes,
    count(*) filter (where (avance = 'TOMADA'::text)) as tomadas,
    count(*) filter (where (avance = 'COMPROBADA'::text)) as comprobadas,
    count(*) filter (where (not navegable)) as sin_coordenadas,
    anio
   from vw_pauta_ruta
  group by anio, catorcena, ruta_clave, campana;

-- El CURRENT_DATE en UTC de esta vista es otro pendiente (fechas de la base
-- en UTC); aquí solo se agrega el año.
create or replace view public.vw_pauta_riesgo_retiro as
 select i.vendor_face_id,
    i.site_id,
    i.direccion,
    i.municipio,
    i.unidad_negocio,
    i.face_status,
    i.fecha_retiro,
    (i.fecha_retiro - current_date) as dias_para_retiro,
    p.campana,
    p.catorcena,
    c.fecha_inicio,
    c.fecha_fin,
    (c.fecha_fin > i.fecha_retiro) as rebasa_el_retiro,
    p.anio
   from ((inventario i
     join pautas p on ((p.vendor_face_id = i.vendor_face_id)))
     join catorcenas c on (((c.anio = p.anio) and (c.numero = p.catorcena))))
  where ((i.fecha_retiro is not null) and (i.fecha_retiro >= current_date) and (i.fecha_retiro <= (current_date + 90)));

-- ------------------------------------------------------------
-- 6) RPC de Pauta con `p_anio` opcional al final.
-- ------------------------------------------------------------
drop function if exists public.importar_pauta(integer, text, jsonb);
drop function if exists public.importar_pauta(integer, text, jsonb, integer);
create function public.importar_pauta(p_catorcena integer, p_etiqueta text, p_filas jsonb, p_anio integer default null)
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
        and ii.fecha_retiro >= current_date
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

drop function if exists public.sincronizar_rutas_desde_pauta(integer);
drop function if exists public.sincronizar_rutas_desde_pauta(integer, integer);
create function public.sincronizar_rutas_desde_pauta(p_catorcena integer, p_anio integer default null)
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
    where anio = v_anio and catorcena = p_catorcena
      and ruta_clave ~ '^\d+$'
    group by site_id, ruta_clave
  ) s;

  select count(distinct site_id) into v_foraneos
  from pautas
  where anio = v_anio and catorcena = p_catorcena
    and (ruta_clave is null or ruta_clave !~ '^\d+$');

  if v_sitios is null or v_sitios = 0 then
    raise exception 'La catorcena % de % no tiene sitios con ruta numérica.', p_catorcena, coalesce(v_anio::text, '(sin año)');
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

drop function if exists public.registrar_toma(integer, text);
drop function if exists public.registrar_toma(integer, text, integer);
create function public.registrar_toma(p_catorcena integer, p_vendor_face_id text, p_anio integer default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_previa timestamptz;
  v_sitio record;
  v_anio int := coalesce(p_anio, anio_de_catorcena(p_catorcena));
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;

  -- ¿Ya había toma vigente? Entonces esto es evidencia extra, no una toma
  -- nueva, y no se re-avisa al coordinador.
  select fecha_toma into v_previa
  from pauta_monitoreo
  where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id;

  insert into pauta_monitoreo (anio, catorcena, vendor_face_id, fecha_toma, toma_por)
  values (v_anio, p_catorcena, p_vendor_face_id, now(), lower(auth_email()))
  on conflict (anio, catorcena, vendor_face_id) do update
    -- No se pisa una toma anterior VIGENTE; tras un rechazo fecha_toma es
    -- null y la toma nueva entra, limpiando el motivo del regreso.
    set fecha_toma = coalesce(pauta_monitoreo.fecha_toma, excluded.fecha_toma),
        toma_por   = coalesce(pauta_monitoreo.toma_por,   excluded.toma_por),
        rechazo_motivo = case
          when pauta_monitoreo.fecha_toma is null then null
          else pauta_monitoreo.rechazo_motivo end,
        rechazada_por = case
          when pauta_monitoreo.fecha_toma is null then null
          else pauta_monitoreo.rechazada_por end,
        fecha_rechazo = case
          when pauta_monitoreo.fecha_toma is null then null
          else pauta_monitoreo.fecha_rechazo end,
        actualizado_en = now();

  if v_previa is null then
    select site_id, cara into v_sitio
    from pautas
    where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id
    limit 1;

    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
    select null, u.email, 'pauta_revision',
           'Toma por comprobar: ' ||
             coalesce(v_sitio.site_id, p_vendor_face_id) ||
             coalesce(' cara ' || v_sitio.cara, '') ||
             ' (Cat-' || p_catorcena || ' · ' || v_anio || '), registrada por ' ||
             split_part(lower(auth_email()), '@', 1) ||
             '. Revísala en Pauta y Monitoreo.',
           'Ecovallas'
    from (
      select distinct lower(usuario_email) as email
      from usuario_roles
      where rol = 'coordinador'
        and (unidad_negocio is null or unidad_negocio ilike 'Ecovallas')
    ) u
    -- Si el coordinador registrara una toma él mismo, no se auto-avisa.
    where u.email <> lower(auth_email());
  end if;
end;
$function$;

drop function if exists public.registrar_comprobacion(integer, text);
drop function if exists public.registrar_comprobacion(integer, text, integer);
create function public.registrar_comprobacion(p_catorcena integer, p_vendor_face_id text, p_anio integer default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_anio int := coalesce(p_anio, anio_de_catorcena(p_catorcena));
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo el coordinador puede comprobar una toma.';
  end if;
  insert into pauta_monitoreo (
    anio, catorcena, vendor_face_id, fecha_comprobacion, comprobacion_por)
  values (v_anio, p_catorcena, p_vendor_face_id, now(), lower(auth_email()))
  on conflict (anio, catorcena, vendor_face_id) do update
    set fecha_comprobacion = now(),
        comprobacion_por   = lower(auth_email()),
        actualizado_en     = now();
end;
$function$;

drop function if exists public.rechazar_toma(integer, text, text);
drop function if exists public.rechazar_toma(integer, text, text, integer);
create function public.rechazar_toma(p_catorcena integer, p_vendor_face_id text, p_motivo text, p_anio integer default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_toma_por text;
  v_sitio record;
  v_anio int := coalesce(p_anio, anio_de_catorcena(p_catorcena));
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo el coordinador puede regresar una toma.';
  end if;
  if coalesce(trim(p_motivo), '') = '' then
    raise exception 'Escribe el motivo del regreso.';
  end if;

  select toma_por into v_toma_por
  from pauta_monitoreo
  where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id;
  if v_toma_por is null then
    raise exception 'Esa cara no tiene toma registrada.';
  end if;

  -- La toma se anula (debe repetirse) pero el rastro queda. Las fotos NO
  -- se tocan: el coordinador puede borrar las malas desde el visor (la
  -- política de pauta_evidencias ya se lo permite) y el monitorista sube
  -- las de reposición.
  update pauta_monitoreo
     set fecha_toma     = null,
         toma_por       = null,
         rechazo_motivo = trim(p_motivo),
         rechazada_por  = lower(auth_email()),
         fecha_rechazo  = now(),
         actualizado_en = now()
   where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id;

  -- Para el mensaje: qué sitio y cara son, en palabras del monitorista.
  select site_id, cara into v_sitio
  from pautas
  where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id
  limit 1;

  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  values (
    null,
    lower(v_toma_por),
    'pauta_toma',
    'El coordinador regresó tu toma de ' ||
      coalesce(v_sitio.site_id, p_vendor_face_id) ||
      coalesce(' cara ' || v_sitio.cara, '') ||
      ' (Cat-' || p_catorcena || ' · ' || v_anio || '): "' || trim(p_motivo) ||
      '". Vuelve a tomarla.',
    'Ecovallas'
  );
end;
$function$;

-- ------------------------------------------------------------
-- 7) Permisos de las RPC recreadas: los mismos de antes (authenticated y
--    service_role; ni anon ni public).
-- ------------------------------------------------------------
revoke all on function public.importar_pauta(integer, text, jsonb, integer) from public, anon;
revoke all on function public.sincronizar_rutas_desde_pauta(integer, integer) from public, anon;
revoke all on function public.registrar_toma(integer, text, integer) from public, anon;
revoke all on function public.registrar_comprobacion(integer, text, integer) from public, anon;
revoke all on function public.rechazar_toma(integer, text, text, integer) from public, anon;
grant execute on function public.importar_pauta(integer, text, jsonb, integer) to authenticated, service_role;
grant execute on function public.sincronizar_rutas_desde_pauta(integer, integer) to authenticated, service_role;
grant execute on function public.registrar_toma(integer, text, integer) to authenticated, service_role;
grant execute on function public.registrar_comprobacion(integer, text, integer) to authenticated, service_role;
grant execute on function public.rechazar_toma(integer, text, text, integer) to authenticated, service_role;

-- Que la API vea las firmas nuevas de inmediato.
notify pgrst, 'reload schema';
