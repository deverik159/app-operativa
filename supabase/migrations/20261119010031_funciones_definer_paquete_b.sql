-- ============================================================
-- funciones_definer_paquete_b — auditoría de las funciones SECURITY DEFINER,
-- paquete B: lo que necesitaba decisiones de Erik (Plataforma, 18-nov-2026).
--
-- DECISIONES (Erik, 18-nov-2026; detalle en la ficha de Plataforma):
-- · Tomas de pauta: solo monitorista, fijador o coordinador de Ecovallas (o
--   sin unidad), o manager, y solo de caras que estén en la pauta de esa
--   catorcena (registrar_toma y pev_ins). Hoy hay 0 tomas y 0 fotos de pauta.
-- · Coordinador por unidad: importar la pauta, sincronizar rutas desde ella,
--   importar rutas (Excel/KML) y escribir paradas directo, solo en su unidad.
--   Coordinador SIN unidad cuenta como de todas (hoy los 2 de Digital); el
--   manager, en todas. Hoy solo un coordinador de Ecovallas y el manager han
--   importado pauta; la app no escribe ruta_ubicaciones directo (todo pasa
--   por funciones definer).
-- · Incidencias por sitio (estado_maquina, estado_maquinas,
--   incidencias_de_sitios e incidencias_en_proceso_iguales): solo de las
--   unidades de quien consulta, de cualquier área. Rol sin unidad o
--   manager: todas.
-- · Chat y lista de usuarios: se quedan legibles para cualquiera con sesión
--   (decisión; sin cambio aquí).
--
-- SIN DECISIÓN DE NEGOCIO (no cambian lo que se ve):
-- · Nombre en el chat ("Visto por" y autor de mensajes): sale de la sesión
--   con la misma regla que la app (App.tsx: nombre de Google o la parte del
--   correo antes de la @). Coincide en el 100 % de lo guardado en los
--   últimos 7 días.
-- · importar_rutas ya no acepta origen 'pauta' del cliente: solo con la
--   marca app.sync_pauta que pone sincronizar_rutas_desde_pauta.
-- · guardar_revision toma unidad, nombre, dirección y cara del inventario
--   (en 301 de las 302 revisiones de hoy coinciden con lo que mandó el
--   teléfono; la otra cambió de nombre en inventario después).
--
-- Las 11 funciones se reescriben desde su texto de producción (md5 de
-- prosrc verificado el 18-nov-2026) con la cabecera idéntica a producción;
-- solo cambian las líneas marcadas "Paquete B". CREATE OR REPLACE conserva
-- los permisos.
--
-- Re-ejecutable.
-- ============================================================

-- 1) Ayudantes (SECURITY INVOKER: no suman al aviso del asesor) ----------

-- ¿Quien llama tiene alguno de esos roles en esa unidad? Un rol sin unidad
-- cuenta para todas; el manager, siempre. Invoker a propósito: ur_self_read
-- deja leer las filas propias, y dentro de una función definer corre como
-- dueño.
create or replace function public.rol_en_unidad(p_roles app_role[], p_unidad text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from usuario_roles ur
     where lower(ur.usuario_email) = lower(auth_email())
       and (ur.rol = 'manager'
            or (ur.rol = any (p_roles)
                and (nullif(btrim(ur.unidad_negocio), '') is null
                     or lower(btrim(ur.unidad_negocio)) = lower(btrim(p_unidad))))))
$$;

-- Unidades cuyas incidencias ve quien llama en las consultas por sitio:
-- null = todas (manager o algún rol sin unidad); '{}' = ninguna.
create or replace function public.unidades_que_veo()
returns text[]
language sql
stable
set search_path = public, pg_temp
as $$
  select case
           when bool_or(ur.rol = 'manager' or nullif(btrim(ur.unidad_negocio), '') is null) then null
           else coalesce(array_agg(distinct lower(btrim(ur.unidad_negocio))), '{}')
         end
    from usuario_roles ur
   where lower(ur.usuario_email) = lower(auth_email())
$$;

-- Nombre de quien llama con la misma regla que la app (App.tsx:
-- user_metadata.name o la parte del correo antes de la @). Sale del JWT: el
-- cliente no lo puede cambiar.
create or replace function public.nombre_de_sesion()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''),
                  split_part(lower(auth_email()), '@', 1))
$$;

-- 2) Autor de los mensajes del chat --------------------------------------

create or replace function public.msg_nombre_de_sesion()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Solo en inserciones directas por la API (current_user = authenticated;
  -- por eso es invoker). Las funciones definer, como inc_pasar_a_op_biobox,
  -- ponen su propio nombre y no se tocan.
  if current_user = 'authenticated'
     and lower(new.autor_email) = lower(auth_email()) then
    new.autor_nombre := coalesce(nombre_de_sesion(), new.autor_nombre);
  end if;
  return new;
end $$;

drop trigger if exists trg_msg_nombre_de_sesion on public.mensajes;
create trigger trg_msg_nombre_de_sesion
  before insert on public.mensajes
  for each row execute function public.msg_nombre_de_sesion();

-- 3) registrar_toma -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.registrar_toma(p_catorcena integer, p_vendor_face_id text, p_anio integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_previa timestamptz;
  v_sitio record;
  v_anio int := coalesce(p_anio, anio_de_catorcena(p_catorcena));
  v_revisor text;
  v_pendientes int;
  v_msg text;
  v_quien text := split_part(lower(auth_email()), '@', 1);
  u record;
  v_id bigint;
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;
  -- Paquete B (Erik, 18-nov-2026): solo monitorista, fijador o coordinador
  -- de Ecovallas (o sin unidad), o manager. El analista sigue siendo solo de
  -- revisión. Y solo caras que estén en la pauta de esa catorcena.
  if not rol_en_unidad(array['monitorista', 'fijador', 'coordinador']::app_role[], 'Ecovallas') then
    raise exception 'Solo monitorista, fijador o coordinador de Ecovallas registran tomas de pauta.';
  end if;
  if not exists (select 1 from pautas
                  where anio = v_anio and catorcena = p_catorcena
                    and vendor_face_id = p_vendor_face_id) then
    raise exception 'Esa cara no está en la pauta de la Cat-% · %.', p_catorcena, coalesce(v_anio::text, '(sin año)');
  end if;

  -- ¿Ya había toma vigente? Entonces esto es evidencia extra, no una toma
  -- nueva, y no se re-avisa al analista.
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
    -- Tras un rechazo de fotos sueltas, si el monitorista vuelve a entregar
    -- sin subir nada nuevo (las que quedan ya estaban revisadas como buenas),
    -- la toma no debe quedar atorada: se comprueba a nombre del analista que
    -- las revisó, y no hace falta avisar (revisor-rls, 22-oct-2026). Solo con
    -- toma NUEVA: con toma vigente no se re-evalúa, para que un borrado de
    -- fotos nunca cierre una toma sin el analista (Erik, 24-oct-2026).
    select r.revisado_por into v_revisor
      from pauta_revision_fotos r
      join pauta_evidencias e on e.id = r.evidencia_id
     where e.anio = v_anio and e.catorcena = p_catorcena and e.vendor_face_id = p_vendor_face_id
       and e.regresada_en is null and r.estado in ('correcta', 'editada')
     order by r.revisado_en desc
     limit 1;
    if v_revisor is not null
       and pauta_comprobar_si_revisada(v_anio, p_catorcena, p_vendor_face_id, v_revisor) then
      return;
    end if;

    select site_id, cara into v_sitio
    from pautas
    where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id
    limit 1;

    -- Tomas entregadas y sin comprobar de la catorcena (incluye esta).
    select count(*) into v_pendientes
      from pauta_monitoreo m
     where m.anio = v_anio and m.catorcena = p_catorcena
       and m.fecha_toma is not null and m.fecha_comprobacion is null;

    -- Desde el 22-oct-2026 la revisa el analista (antes, el coordinador).
    -- Desde el 23-oct-2026 lo hace en Comprobaciones › Tomas de Pauta.
    if v_pendientes <= 1 then
      v_msg := 'Toma por revisar: ' ||
               coalesce(v_sitio.site_id, p_vendor_face_id) ||
               coalesce(' cara ' || v_sitio.cara, '') ||
               ' (Cat-' || p_catorcena || ' · ' || v_anio || '), registrada por ' || v_quien ||
               '. Revísala en Comprobaciones, pestaña Tomas de Pauta.';
    else
      v_msg := v_pendientes || ' tomas por revisar en Cat-' || p_catorcena || ' · ' || v_anio ||
               '; la última: ' || coalesce(v_sitio.site_id, p_vendor_face_id) ||
               coalesce(' cara ' || v_sitio.cara, '') || ', por ' || v_quien ||
               '. Revísalas en Comprobaciones, pestaña Tomas de Pauta.';
    end if;

    for u in
      select distinct lower(usuario_email) as email
      from usuario_roles
      where rol = 'analista'
        and (unidad_negocio is null or unidad_negocio ilike 'Ecovallas')
    loop
      -- Quien registra no se auto-avisa.
      if u.email = lower(auth_email()) then
        continue;
      end if;
      -- Juntar por hora (24-oct-2026): si ya tiene un aviso de este tipo,
      -- de esta misma catorcena, sin leer y de la última hora, se le cambia
      -- el texto (sin push nuevo); si no, se inserta uno (con push). El
      -- candado evita que dos tomas al mismo tiempo le inserten dos avisos
      -- (revisor-rls, 24-oct-2026).
      perform pg_advisory_xact_lock(hashtext('pauta_revision_aviso'), hashtext(u.email));
      select n.id into v_id
        from notificaciones n
       where lower(n.para_email) = u.email and n.evento = 'pauta_revision'
         and not n.leida and n.creado_en > now() - interval '1 hour'
         and n.mensaje like '%Cat-' || p_catorcena || ' · ' || v_anio || '%'
       order by n.creado_en desc
       limit 1;
      if v_id is not null then
        update notificaciones set mensaje = v_msg where id = v_id;
      else
        insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
        values (null, u.email, 'pauta_revision', v_msg, 'Ecovallas');
      end if;
      v_id := null;
    end loop;
  end if;
end;
$function$;

-- 4) importar_pauta -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.importar_pauta(p_catorcena integer, p_etiqueta text, p_filas jsonb, p_anio integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_borradas   int := 0;
  v_insertadas int := 0;
  v_email      text := lower(coalesce(auth_email(), ''));
  v_conservado int := 0;
  v_anio       int;
begin
  -- 1) Permiso. Se usan las funciones existentes del proyecto.
  -- Paquete B (Erik, 18-nov-2026): la pauta es de Ecovallas; coordinador de
  -- Ecovallas o sin unidad, o manager.
  if not rol_en_unidad(array['coordinador']::app_role[], 'Ecovallas') then
    raise exception 'No tienes permiso para importar la pauta (se requiere coordinador de Ecovallas o manager).';
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

-- 5) sincronizar_rutas_desde_pauta ----------------------------------------

CREATE OR REPLACE FUNCTION public.sincronizar_rutas_desde_pauta(p_catorcena integer, p_anio integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_filas    jsonb;
  v_sitios   int;
  v_foraneos int;
  v_res      jsonb;
  v_anio     int := coalesce(p_anio, anio_de_catorcena(p_catorcena));
begin
  -- Paquete B (Erik, 18-nov-2026): coordinador de Ecovallas o sin unidad, o manager.
  if not rol_en_unidad(array['coordinador']::app_role[], 'Ecovallas') then
    raise exception 'Solo coordinador de Ecovallas o manager pueden sincronizar rutas.';
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
  -- Paquete B (18-nov-2026): importar_rutas solo acepta origen 'pauta' con
  -- esta marca de la transacción, que solo pone esta función.
  perform set_config('app.sync_pauta', 'on', true);
  v_res := importar_rutas('Ecovallas', 'Impreso', v_filas);
  perform set_config('app.sync_pauta', '', true);

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

-- 6) importar_rutas -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.importar_rutas(p_unidad text, p_tipo text, p_filas jsonb, p_reemplazar boolean DEFAULT false, p_coordinador text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- CAMBIO (rutas por coordinador, 22-oct-2026)
  v_dueno       text;
  v_sites_arch  text[] := '{}';
  v_nums_arch   integer[] := '{}';
  v_quitadas    integer := 0;
  v_borradas    jsonb := '[]'::jsonb;
  v_r           record;
begin
  -- Paquete B (Erik, 18-nov-2026): coordinador de esa unidad o sin unidad, o manager.
  if not rol_en_unidad(array['coordinador']::app_role[], p_unidad) then
    raise exception 'No tienes permiso para importar rutas de %.', coalesce(p_unidad, '(sin unidad)');
  end if;

  -- CAMBIO (rutas por coordinador, 22-oct-2026): de quién son las rutas.
  v_dueno := dueno_rutas(p_coordinador);
  if v_dueno is null then
    raise exception 'No se pudo saber de qué coordinador son las rutas.';
  end if;

  for fila in select * from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb))
  loop
    v_site := nullif(btrim(fila->>'site_id'), '');

    v_motivo := null;
    if v_site is null then
      v_motivo := 'La fila no trae clave del sitio.';
    elsif coalesce(fila->>'ruta', '') !~ '^\s*\d{1,6}\s*$' then
      v_motivo := 'La ruta viene vacía o no es un número.';
    end if;
    -- CAMBIO (rutas por coordinador, 22-oct-2026; revisor-rls): todo sitio
    -- que el archivo nombra queda protegido del reemplazo, aunque su fila se
    -- omita (p. ej. ruta "EDOMEX" escrita con letras).
    if v_site is not null then
      v_sites_arch := v_sites_arch || v_site;
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

    -- CAMBIO (rutas por coordinador, 22-oct-2026): las rutas que trae el
    -- archivo, para reemplazar al final (aunque la fila se omita después, su
    -- ruta no se borra: el archivo sí la nombra).
    if not (v_numero = any(v_nums_arch)) then
      v_nums_arch := v_nums_arch || v_numero;
    end if;

    v_dir := nullif(btrim(coalesce(fila->>'direccion', '')), '');
    v_fuente := lower(nullif(btrim(fila->>'fuente_direccion'), ''));
    if v_fuente is not null and v_fuente not in ('qtm', 'archivo') then
      v_fuente := null;
    end if;
    v_origen := lower(coalesce(nullif(btrim(fila->>'origen'), ''), 'archivo'));
    if v_origen not in ('archivo', 'capas', 'pauta', 'app') then
      v_origen := 'archivo';
    end if;
    -- CAMBIO (rutas por coordinador, 22-oct-2026; revisor-rls): el origen lo
    -- manda el cliente. 'pauta' (que se salta las reglas de mover) solo vale
    -- en Ecovallas Impreso, que es lo único que sincroniza la pauta.
    -- Paquete B (18-nov-2026): además, solo si lo llama la sincronización
    -- con la pauta (marca de la transacción); el cliente ya no lo puede pedir.
    if v_origen = 'pauta' and not (p_unidad = 'Ecovallas' and p_tipo = 'Impreso'
                                   and coalesce(current_setting('app.sync_pauta', true), '') = 'on') then
      v_origen := 'archivo';
    end if;

    -- Un Excel NO mueve un sitio que hoy vive en una ruta de OTRA unidad o
    -- medio (entre una Combinada y una Impreso/Digital de la misma unidad
    -- sí). Sincronizar (origen 'pauta') sí puede: la pauta manda.
    -- CAMBIO (rutas por coordinador, 22-oct-2026): ni un sitio que está en
    -- una ruta de OTRO coordinador (se omite y se avisa).
    if v_origen <> 'pauta' then
      select 'Ya está en la Ruta ' || r.numero
             || coalesce(' · ' || nullif(r.nombre, ''), '')
             || case
                  when r.coordinador_email is distinct from v_dueno
                    then ' de ' || nombre_coordinador(r.coordinador_email)
                         || '; es de otro coordinador y no se mueve.'
                  else ' de ' || r.unidad_negocio || ' ' || r.tipo_medio
                       || '; no se mueve entre unidades o medios.'
                end
        into v_motivo
        from ruta_ubicaciones ru
        join rutas_monitoreo r on r.id = ru.ruta_id
       where ru.site_id = v_site
         and (r.coordinador_email is distinct from v_dueno
              or r.unidad_negocio is distinct from p_unidad
              or (r.tipo_medio is distinct from p_tipo
                  and r.tipo_medio is distinct from 'Combinada'
                  and p_tipo is distinct from 'Combinada'))
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

    -- La ruta de este segmento.
    -- CAMBIO (rutas por coordinador, 22-oct-2026): la del dueño; la pauta
    -- usa la que tenga ese número aunque sea de otro coordinador, siempre la
    -- MÁS ANTIGUA (revisor-rls): si dos coordinadores tienen su Ruta 3 de
    -- Impreso, sincronizar no pasa los sitios de una a otra según quién lo
    -- corra.
    v_ruta_id := null;
    if v_origen = 'pauta' then
      select id into v_ruta_id
        from rutas_monitoreo
       where numero = v_numero and unidad_negocio = p_unidad and tipo_medio = p_tipo
       order by id
       limit 1;
    else
      select id into v_ruta_id
        from rutas_monitoreo
       where numero = v_numero and unidad_negocio = p_unidad and tipo_medio = p_tipo
         and coordinador_email = v_dueno
       limit 1;
    end if;

    if v_ruta_id is null then
      insert into rutas_monitoreo(numero, unidad_negocio, tipo_medio, color, coordinador_email)
        values (v_numero, p_unidad, p_tipo,
                (array['#ff5a3c','#4f8cff','#22c55e','#a78bfa','#f59e0b','#ec4899','#14b8a6','#f43f5e'])[1 + (v_numero % 8)],
                v_dueno)
        returning id into v_ruta_id;
      rutas_creadas := rutas_creadas + 1;
    end if;

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
        direccion_archivo = coalesce(excluded.direccion_archivo, ruta_ubicaciones.direccion_archivo),
        direccion_fuente = coalesce(v_fuente, ruta_ubicaciones.direccion_fuente),
        origen = excluded.origen,
        agregada_por = case when ruta_ubicaciones.ruta_id is distinct from excluded.ruta_id
                            then excluded.agregada_por
                            else ruta_ubicaciones.agregada_por end;
      insertadas := insertadas + 1;
    exception when others then
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

  -- CAMBIO (rutas por coordinador, 22-oct-2026): REEMPLAZAR (solo desde la
  -- pantalla de Rutas; Sincronizar no lo pide). Las rutas del dueño en esta
  -- unidad y medio quedan como el archivo: salen las paradas cuyo sitio no
  -- viene y se borran las rutas cuyo número no viene. Si no entró ninguna
  -- parada, no se borra nada (un archivo equivocado no vacía las rutas).
  if coalesce(p_reemplazar, false) then
    if insertadas = 0 then
      return jsonb_build_object(
        'rutas_creadas', rutas_creadas,
        'ubicaciones_procesadas', insertadas,
        'omitidas', omitidas,
        'omitidos_ejemplo', v_omitidos_ej,
        'reemplazo', jsonb_build_object(
          'hecho', false,
          'motivo', 'No entró ninguna parada del archivo: no se borró nada.'
        )
      );
    end if;

    -- Las 900+ (EDOMEX 901, PLAZA 902) son las foráneas de la pauta: el
    -- Excel no las borra ni les quita paradas (revisor-rls, 22-oct-2026).
    delete from ruta_ubicaciones ru
     using rutas_monitoreo r
     where ru.ruta_id = r.id
       and r.coordinador_email = v_dueno
       and r.unidad_negocio = p_unidad
       and r.tipo_medio = p_tipo
       and r.numero < 900
       and not (ru.site_id = any(v_sites_arch));
    get diagnostics v_quitadas = row_count;

    for v_r in
      select id, numero, nombre
        from rutas_monitoreo
       where coordinador_email = v_dueno
         and unidad_negocio = p_unidad
         and tipo_medio = p_tipo
         and numero < 900
         and not (numero = any(v_nums_arch))
       order by numero
    loop
      -- Igual que eliminar_ruta: asignaciones primero (aviso e historial) y
      -- revisiones.ruta_id, que no tiene ON DELETE, en nulo.
      delete from ruta_asignaciones where ruta_id = v_r.id;
      update revisiones set ruta_id = null where ruta_id = v_r.id;
      delete from rutas_monitoreo where id = v_r.id;
      v_borradas := v_borradas
        || jsonb_build_array(jsonb_build_object('numero', v_r.numero, 'nombre', v_r.nombre));
    end loop;
  end if;

  return jsonb_build_object(
    'rutas_creadas', rutas_creadas,
    'ubicaciones_procesadas', insertadas,
    'omitidas', omitidas,
    'omitidos_ejemplo', v_omitidos_ej,
    'reemplazo', case when coalesce(p_reemplazar, false) then jsonb_build_object(
                   'hecho', true,
                   'paradas_quitadas', v_quitadas,
                   'rutas_borradas', v_borradas
                 ) end
  );
end $function$;

-- 7) importar_rutas_capas -------------------------------------------------

CREATE OR REPLACE FUNCTION public.importar_rutas_capas(p_unidad text, p_capas jsonb, p_quitar_faltantes boolean DEFAULT false, p_conservar text[] DEFAULT '{}'::text[], p_coordinador text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_gemelas     jsonb := '[]'::jsonb;
  v_email       text := lower(auth_email());
  -- CAMBIO (rutas por coordinador, 22-oct-2026)
  v_dueno       text;
  v_ajeno       text;
  v_paleta text[] := array[
    '#4f8cff', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa',
    '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6',
    '#8b5cf6', '#eab308'
  ];
  v_i int := 0;
begin
  -- Paquete B (Erik, 18-nov-2026): coordinador de esa unidad o sin unidad, o manager.
  if not rol_en_unidad(array['coordinador']::app_role[], p_unidad) then
    raise exception 'No tienes permiso para importar rutas de % (se requiere coordinador de esa unidad o manager).', coalesce(p_unidad, '(sin unidad)');
  end if;

  if p_unidad is null then
    raise exception 'Falta la unidad de negocio.';
  end if;
  if p_capas is null or jsonb_array_length(p_capas) = 0 then
    raise exception 'El archivo no trae capas con marcadores.';
  end if;

  -- CAMBIO (rutas por coordinador, 22-oct-2026)
  v_dueno := dueno_rutas(p_coordinador);
  if v_dueno is null then
    raise exception 'No se pudo saber de qué coordinador son las rutas.';
  end if;

  for v_capa in select * from jsonb_array_elements(p_capas)
  loop
    v_i := v_i + 1;
    v_nombre := nullif(trim(v_capa->>'nombre'), '');
    if v_nombre is null then
      v_nombre := 'Capa ' || v_i;
    end if;

    for v_parada in select * from jsonb_array_elements(coalesce(v_capa->'paradas', '[]'::jsonb))
    loop
      v_site := nullif(trim(v_parada->>'site_id'), '');
      if v_site is null then
        v_omitidas := v_omitidas + 1;
        continue;
      end if;

      v_tipo := null;
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

      -- CAMBIO (rutas por coordinador, 22-oct-2026): una máquina que está en
      -- una ruta de OTRO coordinador no se mueve: se omite y se avisa.
      v_ajeno := null;
      select nombre_coordinador(r.coordinador_email)
        into v_ajeno
        from ruta_ubicaciones ru
        join rutas_monitoreo r on r.id = ru.ruta_id
       where ru.site_id = v_site
         and r.coordinador_email is distinct from v_dueno
       limit 1;
      if v_ajeno is not null then
        v_omitidas := v_omitidas + 1;
        -- Se protege igual que lo que no se importó: no es un faltante.
        v_sites_vistos := v_sites_vistos || v_site;
        if array_length(v_omitidos_ej, 1) is null or array_length(v_omitidos_ej, 1) < 8 then
          v_omitidos_ej := v_omitidos_ej || (v_site || ' (en una ruta de ' || v_ajeno || ')');
        end if;
        continue;
      end if;

      -- La ruta: por nombre, la Combinada gana.
      -- CAMBIO (rutas por coordinador, 22-oct-2026): solo entre las del dueño.
      v_ruta_id := null;
      select id, numero, color
        into v_ruta_id, v_numero, v_color
      from rutas_monitoreo
      where unidad_negocio = p_unidad
        and coordinador_email = v_dueno
        and (tipo_medio = v_tipo or tipo_medio = 'Combinada')
        and lower(regexp_replace(coalesce(nombre, ''), '\s+', ' ', 'g')) =
            lower(regexp_replace(v_nombre, '\s+', ' ', 'g'))
      order by (tipo_medio = 'Combinada') desc, id
      limit 1;

      if v_ruta_id is null then
        insert into rutas_monitoreo (
          numero, nombre, color, unidad_negocio, tipo_medio, descripcion, activa, coordinador_email
        )
        -- CAMBIO (rutas por coordinador, 22-oct-2026): numeración del dueño,
        -- sin contar las 900+ reservadas.
        select
          coalesce(max(numero) filter (where numero < 900), 0) + 1,
          v_nombre,
          v_paleta[1 + (v_i - 1) % array_length(v_paleta, 1)],
          p_unidad,
          v_tipo,
          'Importada del mapa de My Maps',
          true,
          v_dueno
        from rutas_monitoreo
        where unidad_negocio = p_unidad and tipo_medio = v_tipo
          and coordinador_email = v_dueno
        returning id into v_ruta_id;

        v_rutas_new := v_rutas_new + 1;
      end if;

      if exists (
        select 1 from ruta_ubicaciones
        where site_id = v_site and ruta_id <> v_ruta_id
      ) then
        v_movidas := v_movidas + 1;
      end if;

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

  -- Limpieza opcional de faltantes (las armadas en la app nunca).
  -- CAMBIO (rutas por coordinador, 22-oct-2026): solo en las rutas del dueño.
  v_protegidos := v_sites_vistos || coalesce(p_conservar, '{}');

  if array_length(v_protegidos, 1) is null then
    v_quitadas := 0;
  elsif p_quitar_faltantes then
    delete from ruta_ubicaciones ru
    using rutas_monitoreo r
    where ru.ruta_id = r.id
      and r.unidad_negocio = p_unidad
      and r.coordinador_email = v_dueno
      and not (ru.site_id = any(v_protegidos))
      and ru.origen is distinct from 'app';
    get diagnostics v_quitadas = row_count;
  else
    select count(*)
      into v_quitadas
    from ruta_ubicaciones ru
    join rutas_monitoreo r on r.id = ru.ruta_id
    where r.unidad_negocio = p_unidad
      and r.coordinador_email = v_dueno
      and not (ru.site_id = any(v_protegidos))
      and ru.origen is distinct from 'app';
  end if;

  -- Aviso de gemelas vacías (20-oct-2026).
  -- CAMBIO (rutas por coordinador, 22-oct-2026): solo las del dueño.
  select coalesce(jsonb_agg(jsonb_build_object(
           'ruta_id',      g.id,
           'numero',       g.numero,
           'tipo',         g.tipo_medio,
           'nombre',       g.nombre,
           'activa',       g.activa,
           'monitoristas', (select count(*) from ruta_asignaciones a where a.ruta_id = g.id)
         ) order by g.nombre, g.tipo_medio, g.numero), '[]'::jsonb)
    into v_gemelas
    from rutas_monitoreo g
   where g.unidad_negocio = p_unidad
     and g.coordinador_email = v_dueno
     and g.tipo_medio in ('Impreso', 'Digital')
     and nullif(btrim(g.nombre), '') is not null
     and not exists (select 1 from ruta_ubicaciones ru where ru.ruta_id = g.id)
     and exists (
       select 1 from rutas_monitoreo c
        where c.unidad_negocio = g.unidad_negocio
          and c.coordinador_email = g.coordinador_email
          and c.tipo_medio = 'Combinada'
          and lower(regexp_replace(coalesce(c.nombre, ''), '\s+', ' ', 'g')) =
              lower(regexp_replace(coalesce(g.nombre, ''), '\s+', ' ', 'g'))
     );

  return jsonb_build_object(
    'rutas_creadas',      v_rutas_new,
    'rutas_usadas',       coalesce(array_length(v_rutas_usadas, 1), 0),
    'ubicaciones',        v_ubics,
    'movidas_de_ruta',    v_movidas,
    'omitidas',           v_omitidas,
    'omitidos_ejemplo',   to_jsonb(v_omitidos_ej),
    'sobrantes',          v_quitadas,
    'sobrantes_borradas', p_quitar_faltantes,
    'gemelas_vacias',     v_gemelas
  );
end $function$;

-- 8a) estado_maquina ------------------------------------------------------

CREATE OR REPLACE FUNCTION public.estado_maquina(p_site_id text)
 RETURNS TABLE(record_id text, folio text, nombre_incidencia text, nivel text, estatus text, area text, clave_medio text, fecha_reporte timestamp with time zone, horas_en_estatus numeric, es_de_mi_area boolean, observaciones text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- Paquete B (18-nov-2026): unidades de quien consulta; null = todas.
  v_unid text[] := unidades_que_veo();
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
    -- Mismo criterio que usa la RLS (área en la unidad del folio, 12-nov-2026),
    -- así que no puede contradecirla.
    mi_area_en_unidad(coalesce(i.assigned_area, i.area_responsable), i.unidad_negocio) as es_de_mi_area,
    -- La observación de quien la reportó: es lo que la vuelve reconocible en
    -- campo ("no enciende desde la lluvia del lunes"). Antes iban nombres de
    -- a quién preguntarle; Erik los quitó: la conversación es con el ÁREA.
    i.observaciones
  from incidencias i
  where i.clave_sitio = p_site_id
    -- Paquete B (Erik, 18-nov-2026): solo incidencias de las unidades de
    -- quien consulta, de cualquier área. Rol sin unidad o manager: todas.
    and (v_unid is null or lower(btrim(i.unidad_negocio)) = any (v_unid))
    -- `reparado` fuera desde el 14-oct-2026: ya se arregló, solo falta validarla.
    and i.estatus not in ('cerrada', 'no_reparado', 'reparado')
  order by
    -- Lo detenido primero, y dentro de eso lo más viejo. Es el orden en que
    -- el operador tiene que actuar, no el orden en que se capturaron.
    case i.estatus when 'en_proceso' then 1 else 2 end,
    i.fecha_reporte;
end
$function$;

-- 8b) estado_maquinas -----------------------------------------------------

CREATE OR REPLACE FUNCTION public.estado_maquinas(p_site_ids text[])
 RETURNS TABLE(site_id text, abiertas integer, en_proceso integer, por_validar integer, horas_peor numeric, areas text, hay_critica boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- Paquete B (18-nov-2026): unidades de quien consulta; null = todas.
  v_unid text[] := unidades_que_veo();
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
    -- Paquete B (Erik, 18-nov-2026): solo incidencias de las unidades de
    -- quien consulta, de cualquier área. Rol sin unidad o manager: todas.
    and (v_unid is null or lower(btrim(i.unidad_negocio)) = any (v_unid))
    -- `reparado` fuera desde el 14-oct-2026: ya se arregló, solo falta validarla.
    and i.estatus not in ('cerrada', 'no_reparado', 'reparado')
  group by i.clave_sitio;
end
$function$;

-- 8c) incidencias_de_sitios -----------------------------------------------

CREATE OR REPLACE FUNCTION public.incidencias_de_sitios(p_site_ids text[], p_desde date, p_hasta date)
 RETURNS TABLE(record_id text, folio text, clave_sitio text, clave_medio text, nombre_incidencia text, nivel text, estatus text, area text, fecha_reporte timestamp with time zone, horas_en_estatus numeric, repaired_at timestamp with time zone, cerrada_en timestamp with time zone, observaciones text, es_abierta boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- Paquete B (18-nov-2026): unidades de quien consulta; null = todas.
  v_unid text[] := unidades_que_veo();
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
    -- Paquete B (Erik, 18-nov-2026): solo incidencias de las unidades de
    -- quien consulta, de cualquier área. Rol sin unidad o manager: todas.
    and (v_unid is null or lower(btrim(i.unidad_negocio)) = any (v_unid))
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

-- 8d) incidencias_en_proceso_iguales --------------------------------------

CREATE OR REPLACE FUNCTION public.incidencias_en_proceso_iguales(p_caras text[], p_sitios text[], p_nombres text[])
 RETURNS TABLE(folio text, nombre_incidencia text, clave_medio text, clave_sitio text, lado text, unidad_negocio text, medio text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  -- Paquete B (18-nov-2026): unidades de quien consulta; null = todas.
  v_unid text[] := unidades_que_veo();
begin
  if auth_email() is null then
    raise exception 'Hay que iniciar sesión.' using errcode = '42501';
  end if;

  return query
  select i.folio, i.nombre_incidencia, i.clave_medio, i.clave_sitio, i.lado,
         i.unidad_negocio, i.medio
  from incidencias i
  where i.estatus = 'en_proceso'
    -- Paquete B (Erik, 18-nov-2026): solo incidencias de las unidades de
    -- quien consulta, de cualquier área. Rol sin unidad o manager: todas.
    and (v_unid is null or lower(btrim(i.unidad_negocio)) = any (v_unid))
    and i.nombre_incidencia = any(coalesce(p_nombres, '{}'))
    and (i.clave_medio = any(coalesce(p_caras, '{}'))
         or i.clave_sitio = any(coalesce(p_sitios, '{}')))
  limit 1000;
end $$;

-- 9) marcar_chat_leido ----------------------------------------------------

CREATE OR REPLACE FUNCTION public.marcar_chat_leido(p_record_id text, p_ultimo_id bigint, p_nombre text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  v_email text := lower(auth_email());
begin
  if v_email is null or p_record_id is null or p_ultimo_id is null then
    return;
  end if;
  -- Solo ids reales de ese hilo: no se puede "adelantar" la lectura.
  if not exists (
    select 1 from public.mensajes
    where id = p_ultimo_id and record_id = p_record_id
  ) then
    return;
  end if;
  insert into public.chat_lecturas
    (record_id, usuario_email, usuario_nombre, ultimo_id, visto_en)
  -- Paquete B (18-nov-2026): el nombre sale de la sesión, no del cliente.
  -- p_nombre se queda en la firma para no romper la app; se ignora.
  values (p_record_id, v_email, nombre_de_sesion(), p_ultimo_id, now())
  on conflict (record_id, usuario_email) do update
    -- greatest: una pestaña vieja que marca tarde no regresa la lectura.
    set ultimo_id = greatest(public.chat_lecturas.ultimo_id, excluded.ultimo_id),
        visto_en = now(),
        usuario_nombre = coalesce(excluded.usuario_nombre,
                                  public.chat_lecturas.usuario_nombre);
end $$;

-- 10) guardar_revision ----------------------------------------------------

CREATE OR REPLACE FUNCTION public.guardar_revision(p_cabecera jsonb, p_respuestas jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
declare
  v_email  text := lower(coalesce(auth_email(), ''));
  v_id     bigint;
  v_ok     int := 0;
  v_anom   int := 0;
  v_na     int := 0;
  -- Paquete B (18-nov-2026): datos de la máquina tomados del inventario.
  v_unidad text;
  v_nombre text;
  v_dir    text;
  v_vfid   text;
begin
  if v_email = '' then
    raise exception 'Sesión no válida.';
  end if;
  -- CAMBIO (6-nov-2026): solo quien opera Máquinas Biobox.
  if not public.opera_maquinas_biobox() then
    raise exception 'No tienes permiso para revisar máquinas Biobox.';
  end if;
  if p_cabecera->>'site_id' is null then
    raise exception 'Falta la máquina (site_id).';
  end if;
  if p_respuestas is null or jsonb_array_length(p_respuestas) = 0 then
    raise exception 'La revisión no trae respuestas.';
  end if;

  -- Paquete B (18-nov-2026): unidad, nombre, dirección y cara salen del
  -- inventario, no de lo que manda el teléfono. Un ID viejo se busca por su
  -- equivalente vigente (el trigger site_id_vigente lo traduce después, al
  -- insertar; revisor-rls, 18-nov-2026).
  select i.unidad_negocio, nullif(i.site_legacy_id, ''), nullif(i.direccion, ''), i.vendor_face_id
    into v_unidad, v_nombre, v_dir, v_vfid
    from inventario i
   where i.unidad_negocio ilike 'biobox%'
     and (i.site_id = p_cabecera->>'site_id'
          or i.vendor_face_id = (select a.vendor_face_id from inventario_ids_anteriores a
                                  where a.id_anterior = p_cabecera->>'site_id' limit 1))
   order by (i.site_id = p_cabecera->>'site_id') desc, i.vendor_face_id
   limit 1;
  if not found then
    raise exception 'Esa máquina ya no está en el inventario de Biobox.';
  end if;

  select
    count(*) filter (where x->>'valor' = 'ok'),
    count(*) filter (where x->>'valor' = 'anomalia'),
    count(*) filter (where x->>'valor' = 'na')
  into v_ok, v_anom, v_na
  from jsonb_array_elements(p_respuestas) x;

  insert into revisiones (
    plantilla_id, site_id, vendor_face_id, unidad_negocio, nombre_maquina,
    direccion, ruta_id, revisado_por, revisado_en, lat, lng,
    estado_maquina, observaciones, puntos_ok, puntos_anomalia, puntos_na
  ) values (
    nullif(p_cabecera->>'plantilla_id', '')::bigint,
    p_cabecera->>'site_id',
    -- Paquete B: del inventario (antes, de p_cabecera).
    v_vfid,
    v_unidad,
    v_nombre,
    v_dir,
    nullif(p_cabecera->>'ruta_id', '')::bigint,
    v_email,
    now(),
    nullif(p_cabecera->>'lat', '')::double precision,
    nullif(p_cabecera->>'lng', '')::double precision,
    nullif(p_cabecera->>'estado_maquina', ''),
    nullif(p_cabecera->>'observaciones', ''),
    v_ok, v_anom, v_na
  )
  returning id into v_id;

  insert into revision_respuestas (
    revision_id, punto_id, punto_texto, grupo, orden, valor, nota
  )
  select
    v_id,
    nullif(x->>'punto_id', '')::bigint,
    coalesce(nullif(x->>'punto_texto', ''), '(sin texto)'),
    nullif(x->>'grupo', ''),
    nullif(x->>'orden', '')::int,
    x->>'valor',
    nullif(x->>'nota', '')
  from jsonb_array_elements(p_respuestas) x;

  return jsonb_build_object(
    'revision_id', v_id,
    'ok', v_ok,
    'anomalia', v_anom,
    'na', v_na
  );
end
$$;

-- 11) Políticas -----------------------------------------------------------

-- pautas: la pauta es de Ecovallas (antes: cualquier coordinador).
alter policy pauta_ins on public.pautas
  with check ((select rol_en_unidad(array['coordinador']::app_role[], 'Ecovallas')));
alter policy pauta_upd on public.pautas
  using ((select rol_en_unidad(array['coordinador']::app_role[], 'Ecovallas')));
alter policy pauta_del on public.pautas
  using ((select rol_en_unidad(array['coordinador']::app_role[], 'Ecovallas')));

-- ruta_ubicaciones: solo en rutas de la unidad del coordinador.
alter policy ruta_ubic_ins on public.ruta_ubicaciones
  with check (exists (select 1 from rutas_monitoreo r
                       where r.id = ruta_ubicaciones.ruta_id
                         and rol_en_unidad(array['coordinador']::app_role[], r.unidad_negocio)));
alter policy ruta_ubic_upd on public.ruta_ubicaciones
  using (exists (select 1 from rutas_monitoreo r
                  where r.id = ruta_ubicaciones.ruta_id
                    and rol_en_unidad(array['coordinador']::app_role[], r.unidad_negocio)))
  with check (exists (select 1 from rutas_monitoreo r
                       where r.id = ruta_ubicaciones.ruta_id
                         and rol_en_unidad(array['coordinador']::app_role[], r.unidad_negocio)));
alter policy ruta_ubic_del on public.ruta_ubicaciones
  using (exists (select 1 from rutas_monitoreo r
                  where r.id = ruta_ubicaciones.ruta_id
                    and rol_en_unidad(array['coordinador']::app_role[], r.unidad_negocio)));

-- pauta_evidencias: mismas reglas que registrar_toma (antes: cualquiera con
-- sesión que no fuera solo analista, de cualquier cara).
alter policy pev_ins on public.pauta_evidencias
  with check ((select rol_en_unidad(array['monitorista', 'fijador', 'coordinador']::app_role[], 'Ecovallas'))
              and exists (select 1 from pautas p
                           where p.anio = pauta_evidencias.anio
                             and p.catorcena = pauta_evidencias.catorcena
                             and p.vendor_face_id = pauta_evidencias.vendor_face_id));

-- 12) Permisos de los ayudantes -------------------------------------------

revoke execute on function public.rol_en_unidad(app_role[], text) from public, anon;
grant  execute on function public.rol_en_unidad(app_role[], text) to authenticated, service_role;
revoke execute on function public.unidades_que_veo() from public, anon;
grant  execute on function public.unidades_que_veo() to authenticated, service_role;
revoke execute on function public.nombre_de_sesion() from public, anon;
grant  execute on function public.nombre_de_sesion() to authenticated, service_role;
revoke execute on function public.msg_nombre_de_sesion() from public, anon, authenticated;

-- Verificar:
-- · las 11 funciones con la misma cabecera (search_path, volatilidad,
--   argumentos) y los mismos permisos que antes;
-- · simulando sesiones (begin; set local role authenticated; claims; …;
--   rollback): un coordinador de Biobox no importa la pauta ni rutas de
--   Ecovallas; uno de Ecovallas y uno de Digital sin unidad sí; una cuenta
--   reportante de una unidad ve por sitio solo incidencias de esa unidad;
-- · el asesor sigue en 92 (los ayudantes son invoker).
