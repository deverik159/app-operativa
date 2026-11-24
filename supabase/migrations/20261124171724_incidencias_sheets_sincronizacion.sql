-- ============================================================
-- Incidencias → Google Sheets por unidad (Erik, 24-nov-2026)
--
-- Sección: Incidencias. Cada folio se escribe en la pestaña «App» del
-- Sheets de su unidad, la «base general» (Incidencias EV Gral, con
-- impresas y digitales, y VV Gral; Biobox después). De ahí cada equipo
-- trae sus folios a su propio archivo con el botón «Actualizar»
-- (scripts/sheets/ActualizarIncidenciasApp.gs). Aquí vive el lado de la
-- base; la escritura en Google la hace la función de borde sync-sheets.
--
--   1. sheets_cola: un renglón por folio y unidad que falta escribir. Si
--      un folio cambia 5 veces antes de que corra la función, se escribe
--      una sola vez. `version` cambia con cada encolado: la función solo
--      quita de la cola lo que escribió, no lo que volvió a cambiar
--      mientras tanto.
--   2. Triggers que encolan: incidencias (alta, cambio, borrado y cambio
--      de unidad) y los reportes y contactos de la app Biobox (Correo y
--      Telefono de BB Gral). Nunca frenan la operación: si fallan, avisan
--      en el log y la incidencia se guarda igual.
--   3. vw_incidencias_sheets: qué va en cada encabezado. Las llaves son el
--      encabezado del Sheets sin acentos, espacios ni signos («Área
--      Responsable» → arearesponsable). `texto` se escribe como texto tal
--      cual; `dato` (fechas, tiempos y números) lo interpreta Sheets. Un
--      encabezado que no está aquí (Seguimiento, Ruta) no se toca nunca.
--      Ajustar una columna = create or replace de la vista, sin volver a
--      desplegar la función.
--   4. Funciones para sync-sheets (solo service_role): tomar un lote,
--      confirmar lo escrito y anotar el error de lo que falló.
--   5. disparar_sync_sheets() con cron cada 5 min, mismo patrón que la
--      limpieza del chat (secreto en el Vault). Con la cola vacía no
--      llama a nada. Cada domingo se vuelve a escribir todo (conciliación)
--      y el historial de estos cron se guarda 7 días.
--   6. sheets_url en app_config, sacada de push_url (sin el ref escrito).
--   7. Carga inicial: se encolan todos los folios que existen.
--
-- A qué archivo va cada unidad NO vive aquí (el repo es público): es el
-- secreto SHEETS_DESTINOS de la función. «Sistema de Incidencias» no es
-- destino (Erik, 24-nov-2026). Una unidad sin destino (hoy Biobox Perú)
-- se descarta de la cola sin escribir.
--
-- Orden para estrenarla: primero la función desplegada con sus secretos
-- y los archivos compartidos con la cuenta de servicio; luego esta
-- migración. Así la carga inicial sale en la primera corrida del cron.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Cola
-- ------------------------------------------------------------
create sequence if not exists public.sheets_cola_version_seq;

create table if not exists public.sheets_cola (
  record_id    text        not null,
  unidad       text        not null,
  folio        text,
  -- true: el folio se borró de la base o se cambió de unidad; hay que
  -- quitar su fila del Sheets de ESTA unidad.
  borrado      boolean     not null default false,
  version      bigint      not null default nextval('public.sheets_cola_version_seq'),
  encolado_en  timestamptz not null default now(),
  -- Mientras una corrida lo escribe, nadie más lo toma. Si la función
  -- muere a medias, a los 10 minutos se vuelve a tomar (una función de
  -- borde corre a lo más 150 s, o 400 s en plan de pago).
  tomado_hasta timestamptz,
  intentos     integer     not null default 0,
  ultimo_error text,
  primary key (record_id, unidad)
);

create index if not exists sheets_cola_encolado on public.sheets_cola (encolado_en);

-- Sin políticas: solo la leen y escriben las funciones de abajo y la
-- función de borde (service_role).
alter table public.sheets_cola enable row level security;
revoke all on table public.sheets_cola from public, anon, authenticated;
revoke all on sequence public.sheets_cola_version_seq from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Encolar
-- ------------------------------------------------------------
create or replace function public.sheets_encolar_uno(
  p_record_id text, p_unidad text, p_folio text, p_borrado boolean
)
returns void
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  insert into sheets_cola as c (record_id, unidad, folio, borrado)
  values (p_record_id, coalesce(nullif(btrim(p_unidad), ''), '(sin unidad)'), p_folio, p_borrado)
  on conflict (record_id, unidad) do update
     set folio        = excluded.folio,
         borrado      = excluded.borrado,
         version      = excluded.version,
         encolado_en  = now(),
         intentos     = 0,
         ultimo_error = null;
  -- tomado_hasta NO se suelta: si una corrida lo está escribiendo, la
  -- versión nueva espera a que termine (dos corridas a la vez agregarían
  -- dos veces un folio nuevo).
$function$;

revoke execute on function public.sheets_encolar_uno(text, text, text, boolean) from public, anon, authenticated;

create or replace function public.sheets_encolar_incidencia()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_op = 'DELETE' then
    perform sheets_encolar_uno(old.record_id, old.unidad_negocio, old.folio, true);
    return null;
  end if;

  -- Cambió de unidad (solo un manager puede): se quita del archivo viejo.
  if tg_op = 'UPDATE'
     and lower(coalesce(btrim(old.unidad_negocio), '')) <> lower(coalesce(btrim(new.unidad_negocio), '')) then
    perform sheets_encolar_uno(old.record_id, old.unidad_negocio, old.folio, true);
  end if;

  perform sheets_encolar_uno(new.record_id, new.unidad_negocio, new.folio, false);
  return null;
exception when others then
  -- El Sheets nunca frena una captura, validación o reparación.
  raise warning 'sheets_encolar_incidencia (%): %', tg_op, sqlerrm;
  return null;
end
$function$;

revoke execute on function public.sheets_encolar_incidencia() from public, anon, authenticated;

drop trigger if exists trg_sheets_encolar on public.incidencias;
create trigger trg_sheets_encolar
  after insert or delete on public.incidencias
  for each row execute function public.sheets_encolar_incidencia();

-- to_jsonb y no old.* : comparar filas pide un operador de igualdad por
-- columna, y una columna futura sin él (json, point, xml) haría fallar
-- TODO update de incidencias, porque el WHEN está fuera del exception de
-- la función (revisor-rls, 24-nov-2026).
drop trigger if exists trg_sheets_encolar_upd on public.incidencias;
create trigger trg_sheets_encolar_upd
  after update on public.incidencias
  for each row
  when (to_jsonb(old) is distinct from to_jsonb(new))
  execute function public.sheets_encolar_incidencia();

-- Reporte de la app Biobox que se liga, cambia de incidencia o se borra:
-- cambian sus Correo y Telefono.
create or replace function public.sheets_encolar_reporte_app()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ids text[];
begin
  if tg_op = 'UPDATE' then
    v_ids := array[new.record_id, old.record_id];
  elsif tg_op = 'DELETE' then
    -- Su contacto se va en cascada; cuando corre el trigger del contacto
    -- el reporte ya no se ve, así que se encola desde aquí.
    v_ids := array[old.record_id];
  else
    v_ids := array[new.record_id];
  end if;

  perform sheets_encolar_uno(i.record_id, i.unidad_negocio, i.folio, false)
     from incidencias i
    where i.record_id = any (v_ids);
  return null;
exception when others then
  raise warning 'sheets_encolar_reporte_app (%): %', tg_op, sqlerrm;
  return null;
end
$function$;

revoke execute on function public.sheets_encolar_reporte_app() from public, anon, authenticated;

drop trigger if exists trg_sheets_reporte_app on public.biobox_app_reportes;
create trigger trg_sheets_reporte_app
  after insert on public.biobox_app_reportes
  for each row
  when (new.record_id is not null)
  execute function public.sheets_encolar_reporte_app();

-- Solo cuando cambia la liga: la carga del Webadmin actualiza estas filas
-- a menudo (visto_en, estatus_core…) y eso no cambia el Sheets.
drop trigger if exists trg_sheets_reporte_app_upd on public.biobox_app_reportes;
create trigger trg_sheets_reporte_app_upd
  after update of record_id on public.biobox_app_reportes
  for each row
  when (old.record_id is distinct from new.record_id)
  execute function public.sheets_encolar_reporte_app();

drop trigger if exists trg_sheets_reporte_app_del on public.biobox_app_reportes;
create trigger trg_sheets_reporte_app_del
  after delete on public.biobox_app_reportes
  for each row
  when (old.record_id is not null)
  execute function public.sheets_encolar_reporte_app();

-- Contacto del usuario de la app que llega, cambia o se borra. Se borra
-- cuando el usuario quita su contacto en la app (sincronizar_biobox_app_
-- contactos): también debe salir del Sheets (revisor-rls, 24-nov-2026).
create or replace function public.sheets_encolar_contacto_app()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_reports bigint[];
begin
  if tg_op = 'DELETE' then
    v_reports := array[old.report_id];
  elsif tg_op = 'UPDATE' then
    v_reports := array[new.report_id, old.report_id];
  else
    v_reports := array[new.report_id];
  end if;

  perform sheets_encolar_uno(i.record_id, i.unidad_negocio, i.folio, false)
     from biobox_app_reportes r
     join incidencias i on i.record_id = r.record_id
    where r.report_id = any (v_reports);
  return null;
exception when others then
  raise warning 'sheets_encolar_contacto_app (%): %', tg_op, sqlerrm;
  return null;
end
$function$;

revoke execute on function public.sheets_encolar_contacto_app() from public, anon, authenticated;

drop trigger if exists trg_sheets_contacto_app on public.biobox_app_contactos;
create trigger trg_sheets_contacto_app
  after insert or delete on public.biobox_app_contactos
  for each row execute function public.sheets_encolar_contacto_app();

drop trigger if exists trg_sheets_contacto_app_upd on public.biobox_app_contactos;
create trigger trg_sheets_contacto_app_upd
  after update on public.biobox_app_contactos
  for each row
  when (old.correo         is distinct from new.correo
     or old.telefono       is distinct from new.telefono
     or old.report_id      is distinct from new.report_id)
  execute function public.sheets_encolar_contacto_app();

-- ------------------------------------------------------------
-- 3. Qué va en cada encabezado
-- ------------------------------------------------------------
-- security_invoker: la vista no abre nada por sí sola; además nadie más
-- que service_role la puede leer (lleva contactos de MKT y de la app).
create or replace view public.vw_incidencias_sheets
with (security_invoker = on) as
select
  i.record_id,
  i.folio,
  i.unidad_negocio,
  -- Texto: se escribe tal cual (la función lo protege para que Sheets no
  -- lo convierta en fecha, número o fórmula).
  jsonb_build_object(
    'folio',                 i.folio,
    'unidad',                i.unidad_negocio,
    -- La cara de la clave de medio, como caraLabel de la app y como la
    -- escribe la hoja de Ecovallas Fijas: MX_CM_EV_LUM_11_3318 → «11»,
    -- MX_EM_EV_MGV_1-2_0009 → «1 a 2». Vía Verde (5 partes) queda vacía.
    'cara',                  case when array_length(string_to_array(i.clave_medio, '_'), 1) >= 6
                                  then nullif(replace(ltrim(split_part(i.clave_medio, '_', 5), '0'), '-', ' a '), '')
                             end,
    -- MKT anota por dónde le llegó la solicitud; lo demás entró por la app.
    'viadereporte',          coalesce(nullif(btrim(i.via_reporte), ''), 'App'),
    'campana',               nullif(btrim(i.campania), ''),
    -- BB Gral: «BB 110» sale de la clave MX_CM_BB_MED_0110 (por confirmar
    -- con Erik). Sin máquina queda vacío.
    'id',                    case when lower(i.unidad_negocio) = 'biobox' and i.clave_sitio ~ '_[0-9]+$'
                                  then 'BB ' || coalesce(nullif(ltrim(substring(i.clave_sitio from '_([0-9]+)$'), '0'), ''), '0')
                             end,
    'nombre',                coalesce(nullif(btrim(i.nombre_biobox), ''), i.direccion),
    'clavedesitio',          i.clave_sitio,
    'clavedemedio',          i.clave_medio,
    'nomenclatura',          i.clave_medio,
    'direccion',             i.direccion,
    'alcaldia',              i.municipio,
    'alcaldiamunicipio',     i.municipio,
    -- VV Gral escribe la plaza como CDMX / EDO MEX.
    'plaza',                 case when lower(i.unidad_negocio) = 'vía verde'
                                  then case i.plaza when 'Ciudad de México' then 'CDMX'
                                                    when 'México' then 'EDO MEX'
                                                    else i.plaza end
                                  else i.plaza end,
    'lado',                  case when lower(i.unidad_negocio) = 'vía verde'
                                  then upper(coalesce(nullif(btrim(i.lado), ''), 'N/A'))
                                  else i.lado end,
    'areareportante',        i.area_reportante,
    'incidencia',            i.nombre_incidencia,
    'detalledeincidencia',   i.observaciones,
    'detalledelaincidencia', i.observaciones,
    -- El área que repara: la reasignada si hubo reasignación.
    'arearesponsable',       coalesce(nullif(btrim(i.assigned_area), ''), i.area_responsable),
    'detallereparacion',     coalesce(nullif(btrim(i.detalle_reparacion), ''), nullif(btrim(i.solucion), '')),
    'detalledereparacion',   coalesce(nullif(btrim(i.detalle_reparacion), ''), nullif(btrim(i.solucion), '')),
    -- estatus_inicial de la tabla está vacío (era de la app anterior): lo
    -- que llega de la app Biobox nace validado y lo de fuera de horario
    -- entra directo al área.
    'estatusinicial',        case when i.area_reportante = 'App Biobox'
                                    or coalesce(i.requiere_prevalidacion, false)
                                  then 'En proceso' else 'Por validar' end,
    -- Con las palabras de las hojas Gral: «Reparado» es el cierre.
    'estatusfinal',          case i.estatus::text
                               when 'reportado'   then 'Reportado'
                               when 'por_validar' then 'Por validar'
                               when 'rechazada'   then 'Devuelta'
                               when 'en_proceso'  then 'En proceso'
                               when 'reparado'    then 'Reparado por aprobar'
                               when 'cerrada'     then 'Reparado'
                               when 'no_reparado' then 'No reparado'
                               when 'duplicada'   then 'Duplicada'
                               else i.estatus::text
                             end,
    -- La incidencia no guarda la afectación: sale del catálogo (BB la
    -- llama Clasificación).
    'afectacion',            cat.afectacion,
    'clasificacion',         cat.afectacion,
    'niveldeincidencia',     nullif(btrim(i.nivel), ''),
    'origendeincidencia',    i.origen,
    'origenincidencia',      i.origen,
    'causa',                 i.tipo,
    'tipoafectacion',        case when lower(i.unidad_negocio) = 'biobox' then 'Mueble' end,
    'tipodemaquina',         i.tipo_mueble,
    'negocio',               case lower(i.unidad_negocio)
                               when 'biobox'    then 'Maquinas'
                               when 'ecovallas' then case when i.medio = 'Digital' then 'Digitales ' else 'Fijas ' end
                                                     || extract(year from t.dia)::int
                               when 'vía verde' then 'VV ' || extract(year from t.dia)::int
                               else i.unidad_negocio
                             end,
    'trimestre',             'Q' || extract(quarter from t.dia)::int,
    -- MKT lo captura en la incidencia; el de la app Biobox llega aparte
    -- (Erik, 24-nov-2026: se llenan todos).
    'correo',                coalesce(nullif(btrim(i.contacto_correo), ''), app.correo),
    'telefono',              coalesce(nullif(btrim(i.contacto_telefono), ''), app.telefono)
  ) as texto,
  -- Fechas (día de CDMX, AAAA-MM-DD), tiempos y números: Sheets los
  -- convierte con el formato de la hoja.
  jsonb_build_object(
    'fechareporte',          to_char(t.dia, 'YYYY-MM-DD'),
    'fechadereparacion',     to_char(t.dia_rep, 'YYYY-MM-DD'),
    'fechareparacion',       to_char(t.dia_rep, 'YYYY-MM-DD'),
    'horareporte',           to_char(i.fecha_reporte at time zone 'America/Mexico_City', 'HH24:MI'),
    'horadereparacion',      to_char(i.repaired_at   at time zone 'America/Mexico_City', 'HH24:MI'),
    'catorcena',             i.catorcena,
    -- El domingo que cierra la semana del reporte, como en las hojas Gral.
    'fechames',              to_char(date_trunc('week', t.dia)::date + 6, 'YYYY-MM-DD'),
    'semana',                case when i.semana ~ '^[0-9]+$' then i.semana::int end,
    -- Del reporte a la reparación, reloj corrido.
    'tiempo',                case when t.seg is not null then
                               floor(t.seg / 3600)::bigint || ':'
                               || lpad(floor(mod(t.seg, 3600) / 60)::int::text, 2, '0') || ':'
                               || lpad(floor(mod(t.seg, 60))::int::text, 2, '0')
                             end,
    'tiempohoras',           round(t.seg / 3600, 2)
  ) as dato
from public.incidencias i
cross join lateral (
  select
    (i.fecha_reporte at time zone 'America/Mexico_City')::date as dia,
    (i.repaired_at   at time zone 'America/Mexico_City')::date as dia_rep,
    -- Sin reparar queda vacío (greatest ignora el null y daría 0).
    case when i.repaired_at is not null and i.fecha_reporte is not null
         then greatest(extract(epoch from (i.repaired_at - i.fecha_reporte)), 0)
    end as seg
) t
left join lateral (
  -- La que tenga afectación, primero la del mismo mueble. Hay filas del
  -- catálogo con la afectación vacía cuando otro mueble con la misma falla
  -- sí la tiene (8 folios de Biobox el 24-nov-2026), y ninguna falla tiene
  -- dos afectaciones distintas. Las del árbol Digital que no están en el
  -- catálogo quedan vacías.
  select c.afectacion
    from public.catalogo_incidencias c
   where lower(c.unidad_negocio) = lower(i.unidad_negocio)
     and c.detalle = i.nombre_incidencia
   order by (c.afectacion is null), (c.tipo_mueble is not distinct from i.tipo_mueble) desc, c.id
   limit 1
) cat on true
left join lateral (
  -- Igual que contactos_app_biobox: un correo junto a SU teléfono cuando
  -- la incidencia tiene varios reportes.
  select string_agg(coalesce(ct.correo, '—'),   ' / ' order by ct.report_id) as correo,
         string_agg(coalesce(ct.telefono, '—'), ' / ' order by ct.report_id) as telefono
    from public.biobox_app_reportes r
    join public.biobox_app_contactos ct on ct.report_id = r.report_id
   where r.record_id = i.record_id
) app on true;

revoke all on table public.vw_incidencias_sheets from public, anon, authenticated;
grant select on table public.vw_incidencias_sheets to service_role;

-- ------------------------------------------------------------
-- 4. Funciones para sync-sheets (solo service_role)
-- ------------------------------------------------------------
create or replace function public.sheets_tomar_lote(p_limite integer default 500)
returns table (record_id text, unidad text, folio text, borrado boolean, version bigint, intentos integer)
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with elegidos as (
    select c.record_id, c.unidad
      from sheets_cola c
     where c.tomado_hasta is null or c.tomado_hasta < now()
     order by c.encolado_en
     limit greatest(1, least(coalesce(p_limite, 500), 2000))
     for update skip locked
  )
  update sheets_cola c
     set tomado_hasta = now() + interval '10 minutes',
         intentos     = c.intentos + 1
    from elegidos e
   where c.record_id = e.record_id and c.unidad = e.unidad
  returning c.record_id, c.unidad, c.folio, c.borrado, c.version, c.intentos;
$function$;

-- Quita de la cola lo que Google confirmó, solo si no volvió a cambiar.
create or replace function public.sheets_confirmar(
  p_record_ids text[], p_unidades text[], p_versiones bigint[]
)
returns integer
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with x as (
    delete from sheets_cola c
     using unnest(p_record_ids, p_unidades, p_versiones) as u(record_id, unidad, version)
     where c.record_id = u.record_id
       and c.unidad    = u.unidad
       and c.version   = u.version
    returning 1
  )
  select count(*)::int from x;
$function$;

-- Anota el error y espera más cada vez: 5, 10, 15… hasta 60 minutos.
create or replace function public.sheets_fallo(
  p_record_ids text[], p_unidades text[], p_error text
)
returns integer
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with x as (
    update sheets_cola c
       set ultimo_error = left(p_error, 500),
           tomado_hasta = now() + least(greatest(c.intentos, 1), 12) * interval '5 minutes'
      from unnest(p_record_ids, p_unidades) as u(record_id, unidad)
     where c.record_id = u.record_id
       and c.unidad    = u.unidad
    returning 1
  )
  select count(*)::int from x;
$function$;

-- Volver a escribir todo (una unidad o todas), p. ej. si alguien borra la
-- pestaña «App» o cuando Biobox Perú tenga archivo. Se corre a mano en el
-- SQL Editor: select sheets_recargar('Biobox');
create or replace function public.sheets_recargar(p_unidad text default null)
returns integer
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with x as (
    insert into sheets_cola as c (record_id, unidad, folio, borrado)
    select i.record_id, coalesce(nullif(btrim(i.unidad_negocio), ''), '(sin unidad)'), i.folio, false
      from incidencias i
     where p_unidad is null or lower(i.unidad_negocio) = lower(p_unidad)
    -- intentos y ultimo_error se conservan: la conciliación del domingo no
    -- debe borrar la evidencia de un folio que lleva días fallando.
    on conflict (record_id, unidad) do update
       set folio = excluded.folio, borrado = false, version = excluded.version,
           encolado_en = now()
    returning 1
  )
  select count(*)::int from x;
$function$;

revoke execute on function public.sheets_tomar_lote(integer)                    from public, anon, authenticated;
revoke execute on function public.sheets_confirmar(text[], text[], bigint[])    from public, anon, authenticated;
revoke execute on function public.sheets_fallo(text[], text[], text)            from public, anon, authenticated;
revoke execute on function public.sheets_recargar(text)                         from public, anon, authenticated;
grant  execute on function public.sheets_tomar_lote(integer)                    to service_role;
grant  execute on function public.sheets_confirmar(text[], text[], bigint[])    to service_role;
grant  execute on function public.sheets_fallo(text[], text[], text)            to service_role;
grant  execute on function public.sheets_recargar(text)                         to service_role;

-- ------------------------------------------------------------
-- 5. Despertar la función cada 5 minutos
-- ------------------------------------------------------------
create or replace function public.disparar_sync_sheets()
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_url text; v_secret text; v_auth text; v_n int;
begin
  select count(*) into v_n
    from sheets_cola
   where tomado_hasta is null or tomado_hasta < now();
  if v_n = 0 then
    return;
  end if;

  select valor into v_url  from app_config where clave = 'sheets_url';
  select valor into v_auth from app_config where clave = 'push_auth';

  -- El mismo secreto que usan notificar_push y la limpieza del chat.
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'push_secret';

  if v_url is null or v_url !~ '^https://' then
    raise warning '[sheets] sheets_url sin configurar; % folios esperando', v_n;
    return;
  end if;

  if v_secret is null or v_secret = '' then
    raise warning '[sheets] push_secret no está en el Vault; % folios esperando', v_n;
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || coalesce(v_auth, ''),
      'x-push-secret', v_secret
    ),
    body    := jsonb_build_object('origen', 'cron', 'pendientes', v_n),
    -- La carga inicial (unos 300 folios) tarda más que los 5 s por omisión.
    timeout_milliseconds := 120000
  );
end
$function$;

revoke execute on function public.disparar_sync_sheets() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 6. URL de la función, sacada de la del push (sin escribir el ref)
-- ------------------------------------------------------------
insert into public.app_config (clave, valor, nota)
select 'sheets_url',
       regexp_replace(valor, '/enviar-push/?$', '/sync-sheets'),
       'Función que escribe los folios en Google Sheets (24-nov-2026).'
  from public.app_config
 where clave = 'push_url'
   and valor ~ '/enviar-push/?$'
on conflict (clave) do nothing;

-- cron.schedule con un nombre que ya existe lo actualiza.
select cron.schedule('sync-sheets', '*/5 * * * *', 'select public.disparar_sync_sheets();');

-- Conciliación semanal (domingo 3:00 UTC): todo se vuelve a escribir, por
-- si un encolado falló en silencio (los triggers no frenan la operación y
-- solo dejan un aviso en el log; revisor-rls, 24-nov-2026).
select cron.schedule('sync-sheets-semanal', '0 3 * * 0', 'select public.sheets_recargar();');

-- El cron de cada 5 min deja ~288 renglones al día en su historial: se
-- guardan 7 días, solo los de estas dos tareas.
select cron.schedule(
  'purgar-historial-sync-sheets',
  '50 8 * * *',
  $cron$delete from cron.job_run_details
         where jobid in (select jobid from cron.job where jobname in ('sync-sheets', 'sync-sheets-semanal'))
           and end_time < now() - interval '7 days'$cron$
);

-- ------------------------------------------------------------
-- 7. Carga inicial
-- ------------------------------------------------------------
insert into public.sheets_cola (record_id, unidad, folio, borrado)
select i.record_id, coalesce(nullif(btrim(i.unidad_negocio), ''), '(sin unidad)'), i.folio, false
  from public.incidencias i
on conflict (record_id, unidad) do nothing;
