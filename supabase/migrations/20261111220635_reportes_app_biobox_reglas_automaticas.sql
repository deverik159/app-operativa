-- 11-nov-2026 · Reportes de la app Biobox: clasificación automática por motivo y palabras
--
-- Qué hace (decisiones de Erik del 11-nov-2026): todo reporte nuevo de la app
--   Biobox se clasifica solo según su motivo, o según palabras clave cuando es
--   «Otro» (texto libre), y pasa directo a su área como hoy los de puntos.
--
--   Falla App          → Problemas con mi cuenta, Abono de puntos, Canje de
--                        puntos y Código de barras: TI, «Fallas con la
--                        aplicación», directos, sin máquina; Atendido lo marca
--                        el técnico.
--                      → Detección del QR: Digital, «Falla en el proceso de
--                        reciclaje», pero NO directo: la app Biobox no manda la
--                        máquina, así que va a la validadora con la sugerencia.
--   Falla de máquina   → Interrupción del reciclaje, Compuerta atorada y
--                        Máquina fuera de servicio: Digital, «Falla en el
--                        proceso de reciclaje», directos CON su máquina;
--                        Atendido lo marca la validadora al cerrar.
--   Otro (palabras)    → llena / lleno / saturada: sugerencia «Recolección
--                        de reciclaje» para la validadora (no trae máquina).
--                      → puntos / mi cuenta / registro / código de barras /
--                        Spin / app…:
--                        TI directo, como los de puntos.
--                      → lo demás: a la validadora, sin sugerencia.
--
--   Sin duplicados: un reporte directo de una máquina que ya tiene una
--   incidencia abierta con la misma falla se LIGA a ella, no crea otra.
--
--   La sugerencia (y su etiqueta) queda guardada en el reporte
--   (biobox_app_reportes.sugerencia_detalle) para que la app la preseleccione
--   también en «Otro». Las palabras viven en biobox_app_palabras (las edita el
--   manager, como las equivalencias) y se comparan sin acentos ni mayúsculas.
--
--   Biobox Perú sigue en pausa: sus filas nuevas entran apagadas.
--   Solo aplica a lo que el usuario reporte DESPUÉS de aplicar esta migración
--   (biobox_app_sync_estado.reglas_desde = hora de aplicarla; Erik,
--   11-nov-2026): ni los que ya están por clasificar ni los que, aun
--   reportados antes, entren en una carga posterior (red caída, VPN). Así la
--   puesta en marcha no le carga trabajo de golpe a las áreas.
--
--   Candado: solo procede si sincronizar_biobox_app_reportes es la vigente
--   (20261110175711) o ya es la de esta migración.

set local lock_timeout = '5s';

do $$
declare
  v text;
begin
  select md5(replace(prosrc, E'\r', '')) into v from pg_proc
   where oid = 'public.sincronizar_biobox_app_reportes(jsonb, boolean)'::regprocedure;
  if v is distinct from '681740fc37aa74607e0ea0a583913eea' and v is distinct from '599dcae719a0aa90f6d295f4b904bdf1' then
    raise exception 'sincronizar_biobox_app_reportes cambió en producción (md5 %); revisar antes de aplicar.', v;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. La sugerencia guardada en el reporte.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.biobox_app_reportes add column if not exists sugerencia_detalle text;

-- Desde cuándo aplican las reglas (hora del reporte en el Core, comparada en
-- UTC). Se fija al aplicar; si se vuelve a correr, se respeta la que ya había.
alter table public.biobox_app_sync_estado add column if not exists reglas_desde timestamptz;
insert into public.biobox_app_sync_estado (id, reglas_desde) values (1, now())
on conflict (id) do update
   set reglas_desde = coalesce(biobox_app_sync_estado.reglas_desde, excluded.reglas_desde);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Palabras clave para «Otro» (texto libre).
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.biobox_app_palabras (
  id               bigint generated always as identity primary key,
  unidad_negocio   text    not null check (unidad_negocio in ('Biobox', 'Biobox Perú')),
  patron           text    not null,           -- expresión regular, sin acentos y en minúsculas
  catalogo_detalle text    not null,           -- catalogo_incidencias.detalle
  etiqueta         text,
  directo_al_area  boolean not null default false,
  marca_atendido   text    not null default 'validador'
                   check (marca_atendido in ('validador', 'tecnico')),
  prioridad        integer not null default 100,  -- la más baja gana
  activo           boolean not null default true,
  actualizado_en   timestamptz not null default now(),
  unique (unidad_negocio, patron)
);

create or replace function public.biobox_app_palabras_valida()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not exists (
    select 1 from catalogo_incidencias c
     where lower(btrim(c.unidad_negocio)) = lower(new.unidad_negocio)
       and c.detalle = new.catalogo_detalle
  ) then
    raise exception 'La falla «%» no existe en el catálogo de %.', new.catalogo_detalle, new.unidad_negocio
      using errcode = '23514';
  end if;
  begin
    perform '' ~ new.patron;
  exception when others then
    raise exception 'La expresión «%» no es válida.', new.patron using errcode = '23514';
  end;
  new.etiqueta := nullif(btrim(new.etiqueta), '');
  new.actualizado_en := now();
  return new;
end $function$;
revoke all on function public.biobox_app_palabras_valida() from public, anon, authenticated;

drop trigger if exists biobox_app_palabras_valida on public.biobox_app_palabras;
create trigger biobox_app_palabras_valida
  before insert or update on public.biobox_app_palabras
  for each row execute function public.biobox_app_palabras_valida();

alter table public.biobox_app_palabras enable row level security;
revoke all on public.biobox_app_palabras from public, anon, authenticated;
grant select, insert, update, delete on public.biobox_app_palabras to authenticated;

drop policy if exists biobox_app_palabras_sel on public.biobox_app_palabras;
create policy biobox_app_palabras_sel on public.biobox_app_palabras
  for select to authenticated
  using ((select auth_email()) is not null);

drop policy if exists biobox_app_palabras_manager on public.biobox_app_palabras;
create policy biobox_app_palabras_manager on public.biobox_app_palabras
  for all to authenticated
  using ((select tiene_rol('manager'::app_role)))
  with check ((select tiene_rol('manager'::app_role)));

-- Prioridad: «llena» gana a «puntos» («la máquina está llena y no me dio
-- puntos» es de recolección). Perú entra apagado (en pausa).
insert into public.biobox_app_palabras
  (unidad_negocio, patron, catalogo_detalle, etiqueta, directo_al_area, marca_atendido, prioridad, activo)
select u.unidad, p.patron, p.detalle, p.etiqueta, p.directo, p.marca, p.prioridad, u.activo
from (values ('Biobox', true), ('Biobox Perú', false)) as u(unidad, activo)
cross join (values
  ('\m(llen[oa]s?|saturad[oa]s?)\M',
     'Recolección de reciclaje', 'Máquina llena', false, 'validador', 10),
  ('\m(puntos?|mi cuenta|registr\w*|codigos? de barras|spin|aplicacion|app|sesion|canje\w*|canjear|abon\w*|tarjeta|monedero)\M',
     'Fallas con la aplicación', 'Puntos o aplicación', true, 'tecnico', 20)
) as p(patron, detalle, etiqueta, directo, marca, prioridad)
on conflict (unidad_negocio, patron) do nothing;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Equivalencias por motivo (caseId de Biobox), tabla de Erik del 11-nov.
--    Biobox Perú: mismas filas, apagadas (en pausa).
-- ─────────────────────────────────────────────────────────────────────────
insert into public.biobox_app_equivalencias
  (unidad_negocio, caso_id, motivo, catalogo_detalle, etiqueta, directo_al_area, marca_atendido, activo)
select u.unidad, e.caso_id, e.motivo, e.detalle, e.etiqueta, e.directo, e.marca, u.activo
from (values ('Biobox', true), ('Biobox Perú', false)) as u(unidad, activo)
cross join (values
  (1, 'Problemas con mi cuenta',                       'Fallas con la aplicación',         'Problemas con mi cuenta',        true,  'tecnico'),
  (2, 'Abono de puntos',                               'Fallas con la aplicación',         'Error de abono de punto',        true,  'tecnico'),
  (3, 'Canjeo de puntos',                              'Fallas con la aplicación',         'Error en el canjeo de puntos',   true,  'tecnico'),
  (4, 'Detección del QR de la máquina',                'Falla en el proceso de reciclaje', 'Detección del QR',               false, 'validador'),
  (5, 'Detección del código de barras del producto',   'Fallas con la aplicación',         'Error en el canjeo de puntos',   true,  'tecnico'),
  (6, 'Interrupción en el proceso de reciclaje',       'Falla en el proceso de reciclaje', 'Interrupción del reciclaje',     true,  'validador'),
  (7, 'Compuerta atorada',                             'Falla en el proceso de reciclaje', 'Compuerta con fallas',           true,  'validador'),
  (8, 'Máquina fuera de servicio',                     'Falla en el proceso de reciclaje', 'Máquina fuera de servicio',      true,  'validador')
) as e(caso_id, motivo, detalle, etiqueta, directo, marca)
on conflict (unidad_negocio, caso_id) do update
   set motivo           = excluded.motivo,
       catalogo_detalle = excluded.catalogo_detalle,
       etiqueta         = excluded.etiqueta,
       directo_al_area  = excluded.directo_al_area,
       marca_atendido   = excluded.marca_atendido,
       -- Si ya existía, se respeta si está encendida o apagada (Perú en
       -- pausa, o una que el manager apagó); las nuevas entran como dice arriba.
       activo           = biobox_app_equivalencias.activo;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. La regla automática de un reporte (uso interno del sync).
--    Devuelve 'directo', 'ligado', 'sugerido' o null (sin regla).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.biobox_app_auto(p_report_id bigint)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r        biobox_app_reportes%rowtype;
  v_det    text;
  v_etq    text;
  v_dir    boolean;
  v_marca  text;
  v_falla  jsonb;
  v_clave  text;
  v_dup    text;
  v_rec    text;
  v_desde  timestamptz;
begin
  select * into r from biobox_app_reportes where report_id = p_report_id for update;
  if not found or r.decision is not null or coalesce(r.estatus_core, 1) not in (1, 2) then
    return null;
  end if;

  -- Arranque (Erik, 11-nov-2026): solo lo que el usuario reportó DESPUÉS de
  -- encender las reglas; lo anterior lo clasifica la validadora, para que la
  -- puesta en marcha no le cargue trabajo de golpe a las áreas. La hora del
  -- Core viene en UTC como 'AAAA-MM-DD HH:MM:SS'; si no se entiende, no se toca.
  select reglas_desde into v_desde from biobox_app_sync_estado where id = 1;
  if v_desde is null
     or coalesce(r.fecha_reporte_core ~ '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}', false) is false then
    return null;
  end if;
  -- (Aparte: solo se convierte una fecha que ya pasó el patrón.)
  if (left(r.fecha_reporte_core, 19) || '+00')::timestamptz < v_desde then
    return null;
  end if;

  -- a) Por motivo.
  select q.catalogo_detalle, q.etiqueta, q.directo_al_area, q.marca_atendido
    into v_det, v_etq, v_dir, v_marca
    from biobox_app_equivalencias q
   where q.unidad_negocio = r.unidad_negocio and q.caso_id = r.caso_id and q.activo;

  -- b) «Otro»: por palabras, sin acentos ni mayúsculas; gana la prioridad más baja.
  if v_det is null and r.caso_id is null and nullif(btrim(r.descripcion), '') is not null then
    select p.catalogo_detalle, p.etiqueta, p.directo_al_area, p.marca_atendido
      into v_det, v_etq, v_dir, v_marca
      from biobox_app_palabras p
     where p.unidad_negocio = r.unidad_negocio and p.activo
       and unaccent_inmutable(lower(r.descripcion)) ~ p.patron
     order by p.prioridad, p.id
     limit 1;
  end if;

  if v_det is null then
    return null;
  end if;

  update biobox_app_reportes
     set sugerencia_detalle = v_det,
         etiqueta           = coalesce(r.etiqueta, v_etq),
         marca_atendido     = v_marca
   where report_id = p_report_id;

  if not coalesce(v_dir, false) then
    return 'sugerido';
  end if;

  -- Directo al área: la fila del catálogo de la unidad.
  select jsonb_build_object('detalle', c.detalle, 'area', c.area, 'impacto', c.impacto,
                            'origen', c.origen, 'tipo', c.tipo)
    into v_falla
    from catalogo_incidencias c
   where lower(btrim(c.unidad_negocio)) = lower(r.unidad_negocio)
     and c.detalle = v_det
   order by c.id
   limit 1;
  if v_falla is null then
    return 'sugerido';
  end if;

  -- Sin duplicados: misma máquina y misma falla abierta → se liga.
  v_clave := r.clave_inventario;
  if v_clave is not null then
    select i.record_id into v_dup
      from incidencias i
     where i.clave_medio = v_clave
       and lower(i.unidad_negocio) = lower(r.unidad_negocio)
       and lower(i.nombre_incidencia) = lower(v_det)
       and i.estatus in ('por_validar', 'en_proceso', 'reparado', 'rechazada')
     order by i.creado_en desc
     limit 1;
    if v_dup is not null then
      update biobox_app_reportes
         set decision = 'ligado', record_id = v_dup, decidido_en = now()
       where report_id = p_report_id;
      return 'ligado';
    end if;
  end if;

  v_rec := biobox_app_crear_incidencia(p_report_id, v_falla, v_clave, null, null);
  update biobox_app_reportes
     set decision = 'directo', record_id = v_rec, decidido_en = now()
   where report_id = p_report_id;
  return 'directo';
end $function$;
revoke all on function public.biobox_app_auto(bigint) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. La carga llama a la regla automática para cada reporte nuevo.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.sincronizar_biobox_app_reportes(datos jsonb, p_forzar boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_jwt_rol    text;
  v_corte      bigint;
  v_primera    boolean;
  n_recibidos  int;
  n_presentes  int;
  n_nuevos     int := 0;
  n_cambios    int := 0;
  n_ausentes   int := 0;
  n_directos   int := 0;
  n_atendidos  int := 0;
  n_historicos int := 0;
  n_ligados    int := 0;
  v_auto       text;
  v_dup        jsonb;
  v_res        jsonb;
  nv           record;
begin
  v_jwt_rol := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if session_user not in ('postgres', 'supabase_admin')
     and v_jwt_rol <> 'service_role'
     and not tiene_rol('manager'::app_role)
  then
    raise exception 'No tienes permiso para cargar los reportes de la app Biobox (se requiere manager o el proceso de sincronización).';
  end if;

  perform pg_advisory_xact_lock(hashtext('biobox_app_reportes'));

  n_recibidos := jsonb_array_length(coalesce(datos, '[]'::jsonb));
  if n_recibidos = 0 then
    raise exception 'ABORTADO: no llegó ningún reporte (una lectura fallida no es «cero reportes»).';
  end if;
  if n_recibidos > 20000 then
    raise exception 'ABORTADO: llegaron % reportes; el tope es 20,000.', n_recibidos;
  end if;

  drop table if exists pg_temp._bar_entrantes;
  create temp table _bar_entrantes on commit drop as
  select (x ->> 'reportId')::bigint                         as report_id,
         nullif(btrim(x ->> 'folio'), '')                   as folio,
         nullif(btrim(x ->> 'fecha_reporte'), '')           as fecha,
         nullif(x ->> 'caseId', '')::int                    as caso_id,
         nullif(btrim(x ->> 'motivo_reportado'), '')        as motivo,
         nullif(btrim(x ->> 'tipo_incidencia'), '')         as tipo,
         left(nullif(btrim(x ->> 'descripcion_usuario'), ''), 4000) as descripcion,
         nullif(x ->> 'statusId', '')::smallint             as estatus,
         nullif(btrim(x ->> 'estatus'), '')                 as estatus_nombre,
         nullif(upper(btrim(x ->> 'codigo_maquina')), '')   as codigo,
         nullif(btrim(x ->> 'maquina'), '')                 as nombre_maquina,
         nullif(btrim(x ->> 'pais_usuario'), '')            as pais,
         nullif(btrim(x ->> 'evidencia_imagen'), '')        as evidencia
    from jsonb_array_elements(datos) x;

  if exists (select 1 from _bar_entrantes where report_id is null) then
    raise exception 'ABORTADO: hay reportes sin reportId.';
  end if;
  select jsonb_agg(report_id) into v_dup from (
    select report_id from _bar_entrantes group by report_id having count(*) > 1 limit 20) d;
  if v_dup is not null then
    raise exception 'ABORTADO: reportes repetidos en la carga: %', v_dup;
  end if;

  -- Unidad: por la máquina (BI- = Perú, MX_ = México) y, sin máquina, por el
  -- país del usuario.
  alter table _bar_entrantes add column unidad text;
  update _bar_entrantes set unidad = case
    when codigo ~ '^BI-'                    then 'Biobox Perú'
    when codigo ~ '^MX_'                    then 'Biobox'
    when lower(coalesce(pais, '')) like 'per%' then 'Biobox Perú'
    else 'Biobox' end
  -- `where true`: por la API, Supabase rechaza un UPDATE sin WHERE
  -- (safeupdate), aunque sea sobre una tabla temporal.
  where true;

  select count(*) into n_presentes from biobox_app_reportes where presente;
  if not p_forzar and n_presentes >= 10 and n_recibidos < n_presentes * 0.8 then
    raise exception 'ABORTADO: llegaron % reportes y hay % presentes. Revisa la consulta o carga con p_forzar.',
      n_recibidos, n_presentes;
  end if;

  insert into biobox_app_sync_estado (id) values (1) on conflict (id) do nothing;
  select corte_report_id into v_corte from biobox_app_sync_estado where id = 1 for update;
  v_primera := v_corte is null;
  if v_primera then
    select max(report_id) into v_corte from _bar_entrantes;
    update biobox_app_sync_estado
       set corte_report_id = v_corte, primera_carga = now()
     where id = 1;
  end if;

  -- a) Los que ya teníamos: estatus de Biobox y datos al día. Los cambios de
  --    estatus se cuentan ANTES (RETURNING ya ve el valor nuevo).
  select count(*) into n_cambios
    from biobox_app_reportes r join _bar_entrantes t on t.report_id = r.report_id
   where r.estatus_core is distinct from t.estatus;

  update biobox_app_reportes r
       set folio_app           = t.folio,
           caso_id             = t.caso_id,
           motivo              = t.motivo,
           tipo                = t.tipo,
           descripcion         = t.descripcion,
           codigo_maquina      = t.codigo,
           nombre_maquina      = t.nombre_maquina,
           clave_inventario    = coalesce(biobox_app_clave_inventario(t.codigo, r.unidad_negocio), r.clave_inventario),
           evidencia_url       = t.evidencia,
           fecha_reporte_core  = t.fecha,
           pais                = t.pais,
           estatus_core_nombre = t.estatus_nombre,
           estatus_core        = t.estatus,
           estatus_cambio_en   = case when r.estatus_core is distinct from t.estatus
                                      then now() else r.estatus_cambio_en end,
           -- Hora de «Atendido»: solo si pasa a 3 mientras lo vigilamos. Si
           -- ya era 3 se queda la que tenía, aunque sea vacía (llegó ya
           -- Atendido y no sabemos cuándo; revisión de Claude, 10-nov-2026).
           atendido_core_en    = case when t.estatus = 3 then
                                   case when r.estatus_core = 3 then r.atendido_core_en else now() end
                                 end,
           -- Pendiente que el Webadmin ya atendió: no se le pide nada a la validadora.
           -- Si Biobox lo REABRE (vuelve a 1 o 2), regresa a «Por clasificar»
           -- para que la validadora lo vea (revisor-rls, 10-nov-2026).
           decision            = case when r.decision is null and t.estatus = 3
                                        then 'atendido_en_webadmin'
                                      when r.decision = 'atendido_en_webadmin' and t.estatus in (1, 2)
                                        then null
                                      else r.decision end,
           presente            = true,
           visto_en            = now()
      from _bar_entrantes t
     where t.report_id = r.report_id;

  -- b) Los nuevos: TODO lo que no tengamos, también los Atendidos viejos
  --    (Erik, 10-nov-2026: sirven para contar cuántas veces falla la misma
  --    máquina por el mismo motivo). Un Atendido entra como
  --    'atendido_en_webadmin': no pide clasificar, no crea incidencia y no
  --    avisa a nadie (directo_al_area solo aplica a estatus 1 y 2).
  for nv in
    select x.*, q.etiqueta, q.marca_atendido
      from _bar_entrantes x
      left join biobox_app_equivalencias q
        on q.unidad_negocio = x.unidad and q.caso_id = x.caso_id and q.activo
     where not exists (select 1 from biobox_app_reportes r where r.report_id = x.report_id)
     order by x.report_id
  loop
    insert into biobox_app_reportes (
      report_id, folio_app, unidad_negocio, pais, caso_id, motivo, tipo, descripcion,
      codigo_maquina, nombre_maquina, clave_inventario, evidencia_url, fecha_reporte_core,
      estatus_core, estatus_core_nombre, etiqueta, estatus_cambio_en, atendido_core_en,
      decision, marca_atendido)
    values (
      nv.report_id, nv.folio, nv.unidad, nv.pais, nv.caso_id, nv.motivo, nv.tipo, nv.descripcion,
      nv.codigo, nv.nombre_maquina, biobox_app_clave_inventario(nv.codigo, nv.unidad), nv.evidencia,
      nv.fecha, nv.estatus, nv.estatus_nombre, nv.etiqueta, now(),
      -- Llega ya Atendido: no sabemos cuándo se atendió (Biobox no lo manda);
      -- vacía, para no falsear métricas de «tiempo hasta Atendido».
      null,
      case when nv.estatus = 3 then 'atendido_en_webadmin' end,
      nv.marca_atendido);
    n_nuevos := n_nuevos + 1;
    if nv.estatus = 3 and nv.report_id <= v_corte then
      n_historicos := n_historicos + 1;
    end if;

    -- Reglas automáticas (Erik, 11-nov-2026): equivalencia por motivo o,
    -- en «Otro», palabras clave. Directo al área (con la máquina; si ya hay
    -- una incidencia abierta igual en esa máquina, se liga) o sugerencia
    -- para la validadora. Solo con estatus 1 o 2 (ver biobox_app_auto).
    v_auto := biobox_app_auto(nv.report_id);
    if v_auto = 'directo' then n_directos := n_directos + 1;
    elsif v_auto = 'ligado' then n_ligados := n_ligados + 1;
    end if;
  end loop;

  -- c) Los que ya no vienen: ausentes, nunca cerrados.
  with aus as (
    update biobox_app_reportes r set presente = false
     where r.presente
       and not exists (select 1 from _bar_entrantes e where e.report_id = r.report_id)
    returning 1
  )
  select count(*) into n_ausentes from aus;

  -- d) El aviso «marca Atendido» se retira cuando ya no queda ningún reporte
  --    de esa incidencia sin Atendido en el Webadmin.
  with hechos as (
    update notificaciones n set leida = true
     where n.evento = 'webadmin_atendido' and not coalesce(n.leida, false)
       and not exists (
         select 1 from biobox_app_reportes r
          where r.record_id = n.record_id
            and r.decision in ('clasificado', 'ligado', 'directo')
            and coalesce(r.estatus_core, 0) <> 3)
    returning 1
  )
  select count(*) into n_atendidos from hechos;

  v_res := jsonb_build_object(
    'recibidos', n_recibidos, 'nuevos', n_nuevos, 'cambios_estatus', n_cambios,
    'directos', n_directos, 'ligados', n_ligados, 'ausentes', n_ausentes, 'avisos_retirados', n_atendidos,
    'historicos', n_historicos,
    'primera_carga', v_primera, 'corte_report_id', v_corte,
    'pendientes', (select count(*) from biobox_app_reportes where decision is null));
  update biobox_app_sync_estado
     set ultima_carga = now(), ultimo_resultado = v_res
   where id = 1;
  return v_res;
end $function$;
revoke all on function public.sincronizar_biobox_app_reportes(jsonb, boolean) from public, anon;
grant execute on function public.sincronizar_biobox_app_reportes(jsonb, boolean) to authenticated, service_role;
