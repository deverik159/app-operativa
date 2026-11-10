-- 10-nov-2026 · Reportes de la app Biobox: también entran los Atendidos viejos
--
-- Qué hace (decisión de Erik del 10-nov-2026): sincronizar_biobox_app_reportes
--   guarda TODOS los reportes que manda el monitor, también los que ya estaban
--   en «Atendido» (estatus 3) cuando se hizo la primera carga (reportId <= el
--   corte, 369). Hasta hoy esos se ignoraban: la primera carga solo trajo los
--   Abiertos y En atención (decisión del 9-nov-2026, que esta reemplaza).
-- Por qué: para contar cuántas veces falla la misma máquina por el mismo
--   motivo en 30, 60 o 90 días, aunque lo haya reportado otro usuario y
--   aunque el Webadmin ya lo haya atendido. Al 10-nov-2026 entran 270 (otros 13 ya estaban) de la
--   copia local del monitor.
-- Cómo entran: decision = 'atendido_en_webadmin' (igual que un Atendido nuevo
--   hoy). No llegan a «Por clasificar», no crean incidencia, no mandan avisos
--   (el único trigger, trg_notificar_webadmin_atendido, es de incidencias) y
--   la bandeja los enseña en un filtro aparte. Sin datos de contacto: la
--   función sigue ignorando nombre, teléfono y correo.
-- Lo que cambia del cuerpo vigente (20261109195133):
--   · se quita el filtro de la primera carga en el paso b) y el resultado suma
--     'historicos' (Kiro, 10-nov-2026);
--   · hora de «Atendido» (atendido_core_en): vacía si el reporte LLEGA ya
--     Atendido (Biobox no dice cuándo se atendió) y solo se pone cuando pasa
--     a 3 mientras lo vigilamos. Antes se ponía la hora de la carga y habría
--     falseado cualquier «tiempo hasta Atendido» de ~270 reportes (revisión de
--     Claude, 10-nov-2026). Al final se limpian los que ya entraron así.
--   · un reporte en «atendido_en_webadmin» que Biobox REABRE (vuelve a 1 o
--     2) regresa a «Por clasificar» (revisor-rls, 10-nov-2026).
--   Candado: solo se aplica si el cuerpo en producción es el de 20261109195133
--   o ya es el de esta migración (re-ejecutable).

set local lock_timeout = '5s';

do $$
declare
  v text;
begin
  select md5(replace(prosrc, E'\r', '')) into v from pg_proc
   where oid = 'public.sincronizar_biobox_app_reportes(jsonb, boolean)'::regprocedure;
  if v is distinct from '0810133e304fb11979c3dee843335942' and v is distinct from '681740fc37aa74607e0ea0a583913eea' then
    raise exception 'sincronizar_biobox_app_reportes cambió en producción (md5 %); revisar antes de aplicar.', v;
  end if;
end;
$$;

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
  v_dup        jsonb;
  v_res        jsonb;
  nv           record;
  v_rec        text;
  v_falla      jsonb;
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
    select x.*, q.catalogo_detalle, q.etiqueta, q.directo_al_area, q.marca_atendido
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

    -- Directo al área (puntos → TI): nace la incidencia sin pasar por la
    -- validadora. Sin sesión de usuario, inc_valida_datos no aplica la regla
    -- de unidad; el área sí se revisa.
    v_rec := null;
    v_falla := null;
    if nv.directo_al_area and coalesce(nv.estatus, 1) in (1, 2) then
      -- Primero la fila del catálogo y DESPUÉS la incidencia: con la función
      -- dentro del SELECT, Postgres podía evaluarla en cada fila (una por
      -- mueble) antes del LIMIT y crear varias incidencias.
      select jsonb_build_object('detalle', c.detalle, 'area', c.area, 'impacto', c.impacto,
                                'origen', c.origen, 'tipo', c.tipo)
        into v_falla
        from catalogo_incidencias c
       where lower(btrim(c.unidad_negocio)) = lower(nv.unidad)
         and c.detalle = nv.catalogo_detalle
       order by c.id
       limit 1;
      if v_falla is not null then
        v_rec := biobox_app_crear_incidencia(
                   nv.report_id, v_falla, biobox_app_clave_inventario(nv.codigo, nv.unidad), null, null);
      end if;
      if v_rec is not null then
        update biobox_app_reportes
           set decision = 'directo', record_id = v_rec, decidido_en = now()
         where report_id = nv.report_id;
        n_directos := n_directos + 1;
      end if;
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
    'directos', n_directos, 'ausentes', n_ausentes, 'avisos_retirados', n_atendidos,
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

-- Los que entraron ya Atendidos desde el 9-nov-2026 recibieron como hora de
-- «Atendido» la de su propia carga (misma now() que primera_vez): se vacía.
-- Los que pasaron a Atendido mientras los vigilábamos conservan su hora.
update public.biobox_app_reportes
   set atendido_core_en = null
 where atendido_core_en is not null
   and atendido_core_en = primera_vez;
