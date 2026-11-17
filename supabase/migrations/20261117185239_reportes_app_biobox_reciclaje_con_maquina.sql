-- 17-nov-2026 · Reportes de la app Biobox: reciclaje sin máquina pasa por la validadora
--
-- Qué hace (Erik, 17-nov-2026): una «Falla en el proceso de reciclaje» de la
--   app Biobox nunca llega al técnico sin máquina; el técnico no tiene cómo
--   saber cuál es.
--   · Regla automática (biobox_app_auto): si la falla es de reciclaje y el
--     reporte no trae máquina (o su código no empata con el inventario), NO
--     entra directo: queda «Por clasificar» con la sugerencia, y la validadora
--     le pone la máquina al clasificar.
--   · Clasificar (clasificar_reporte_biobox_app): con esa falla, la máquina es
--     obligatoria (la app ya la pide; la base lo vuelve a revisar).
--   Solo esta falla: lo de la aplicación (TI: cuenta, abono, canje, código de
--   barras, «Otro» de puntos) sigue directo sin máquina, como decidió Erik.
--
--   Candado: solo procede si las dos funciones son las vigentes o ya son las
--   de esta migración.

set local lock_timeout = '5s';

do $$
declare
  v_auto text;
  v_clas text;
begin
  select md5(replace(prosrc, E'\r', '')) into v_auto from pg_proc
   where oid = 'public.biobox_app_auto(bigint)'::regprocedure;
  select md5(replace(prosrc, E'\r', '')) into v_clas from pg_proc
   where oid = 'public.clasificar_reporte_biobox_app(bigint, jsonb, text, text)'::regprocedure;
  if v_auto is distinct from 'dcaece3033749b5f4a2955ce5a34587f' and v_auto is distinct from 'f67424ea3ed4b575136bbd9028c1f4f8' then
    raise exception 'biobox_app_auto cambió en producción (md5 %); revisar antes de aplicar.', v_auto;
  end if;
  if v_clas is distinct from 'd5c0217281b914f297d89c7db2f83268' and v_clas is distinct from '35cd97997b02b62ea67de4917f9f1de8' then
    raise exception 'clasificar_reporte_biobox_app cambió en producción (md5 %); revisar antes de aplicar.', v_clas;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Regla automática: reciclaje sin máquina → validadora.
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

  -- Reciclaje sin máquina: pasa por la validadora, que le pone la máquina
  -- antes de que llegue al técnico (Erik, 17-nov-2026). Solo esta falla: lo de
  -- la aplicación (TI) sigue directo sin máquina.
  if not coalesce(v_dir, false)
     or (r.clave_inventario is null and lower(v_det) = lower('Falla en el proceso de reciclaje')) then
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
-- 2. Clasificar: con reciclaje, la máquina es obligatoria.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.clasificar_reporte_biobox_app(p_report_id bigint, p_falla jsonb, p_clave_medio text default null::text, p_observaciones text default null::text)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r       biobox_app_reportes%rowtype;
  v_yo    text;
  v_clave text;
  v_dup   text;
  v_rec   text;
  v_folio text;
  v_marca text;
begin
  select * into r from biobox_app_reportes where report_id = p_report_id for update;
  if not found then
    raise exception 'No existe el reporte % de la app Biobox.', p_report_id;
  end if;
  v_yo := biobox_app_exige_validador(r.unidad_negocio);
  if r.decision is not null then
    raise exception 'Este reporte ya se atendió (%).', r.decision using errcode = '23514';
  end if;

  v_clave := coalesce(nullif(btrim(p_clave_medio), ''), r.clave_inventario, 'SIN-MAQUINA');

  -- Reciclaje: el técnico necesita saber en qué máquina (Erik, 17-nov-2026).
  if v_clave = 'SIN-MAQUINA'
     and lower(btrim(p_falla ->> 'detalle')) = lower('Falla en el proceso de reciclaje') then
    raise exception 'Elige la máquina: una «Falla en el proceso de reciclaje» no puede llegar al técnico sin máquina.'
      using errcode = '23514';
  end if;

  if v_clave <> 'SIN-MAQUINA' then
    select i.folio into v_dup from incidencias i
     where i.clave_medio = v_clave
       and lower(i.nombre_incidencia) = lower(btrim(p_falla ->> 'detalle'))
       and i.estatus in ('por_validar', 'en_proceso', 'reparado', 'rechazada')
     order by i.creado_en desc
     limit 1;
    if v_dup is not null then
      raise exception 'DUPLICADO:%', v_dup using errcode = '23505';
    end if;
  end if;

  v_rec := biobox_app_crear_incidencia(p_report_id, p_falla, v_clave, v_yo, p_observaciones);

  select q.marca_atendido into v_marca from biobox_app_equivalencias q
   where q.unidad_negocio = r.unidad_negocio and q.caso_id = r.caso_id and q.activo;
  update biobox_app_reportes
     set decision = 'clasificado', record_id = v_rec, decidido_por = v_yo, decidido_en = now(),
         marca_atendido = coalesce(v_marca,
                                   case when lower(btrim(p_falla ->> 'area')) = 'ti'
                                        then 'tecnico' else 'validador' end)
   where report_id = p_report_id;

  select folio into v_folio from incidencias where record_id = v_rec;
  return v_folio;
end $function$;
revoke all on function public.clasificar_reporte_biobox_app(bigint, jsonb, text, text) from public, anon;
grant execute on function public.clasificar_reporte_biobox_app(bigint, jsonb, text, text) to authenticated, service_role;
