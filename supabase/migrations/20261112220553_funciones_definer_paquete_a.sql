-- ============================================================
-- funciones_definer_paquete_a — auditoría de las funciones SECURITY DEFINER,
-- paquete A: lo que no cambia nada para nadie (Plataforma, 12-nov-2026).
--
-- POR QUÉ. El asesor de Supabase marca 122 funciones SECURITY DEFINER que
-- cualquier usuario con sesión puede llamar por la API. El 12-nov-2026 tres
-- revisores (solo lectura) leyeron el código de todas en producción; el
-- detalle está en la ficha de Plataforma. Este paquete trae solo lo que no
-- requiere decisiones de negocio.
--
-- 1) Se quita EXECUTE a authenticated en 30 funciones que la app no llama
--    por la API. Todas tienen el permiso explícito (no viene de PUBLIC) y
--    service_role lo conserva.
--    · 23 triggers. Postgres revisa EXECUTE solo al CREAR el trigger, no al
--      dispararlo, así que siguen corriendo igual.
--    · comp_gestiona, comp_lee: solo las llaman otras funciones definer.
--    · ordenar_ruta_por_cercania (solo la llama ordenar_rutas_unidad, definer),
--      ordenar_rutas_unidad y contrato_en_mi_cuadrilla: nadie las usa desde
--      la app ni desde políticas.
--    · sincronizar_biobox_app_reportes, sincronizar_biobox_peru: las corre la
--      tarea de la PC con service_role.
--    Revisado en src/, supabase/functions/, pg_policy (también Storage),
--    vistas y cuerpos de funciones. reemplazar_inventario se queda fuera
--    hasta confirmar cómo la llama el sync nocturno.
--
-- 2) Comprobaciones: si una campaña abierta no tiene analista_email, la
--    condición "c.analista_email = yo.email" da NULL, `not (NULL)` es NULL y
--    la fila no cuenta como ajena / el `if not` no lanza: cualquier analista
--    de la unidad podía tocar sitios y tomas de esa campaña. Se envuelve en
--    coalesce(…, false). Afecta a comp_tomas_ajenas, comp_sitios_ajenos (y por
--    ellas a comp_cancelar_sitios, comp_restaurar_sitios, comp_marcar_sitios,
--    comp_agregar_tomas, comp_quitar_tomas, comp_editar_tomas) y a
--    comp_agregar_sitios. Mismo cuerpo salvo esa condición; md5 de prosrc
--    antes del cambio (sin CR): comp_tomas_ajenas 79d49c46…, comp_sitios_ajenos
--    d6e10a44…, comp_agregar_sitios 8ef19140…. Hoy no cambia nada: la única
--    campaña tiene analista.
--
-- Re-ejecutable: revoke y create or replace dan lo mismo dos veces.
-- ============================================================

-- 1) Sin EXECUTE para authenticated --------------------------------------

revoke execute on function public.inc_blindaje_reparacion()         from authenticated;
revoke execute on function public.inc_valida_apoyo()                from authenticated;
revoke execute on function public.msg_valida_respuesta()            from authenticated;
revoke execute on function public.notificar_apoyo_reparacion()      from authenticated;
revoke execute on function public.notificar_area_asignada()         from authenticated;
revoke execute on function public.notificar_chat()                  from authenticated;
revoke execute on function public.notificar_correccion_area()       from authenticated;
revoke execute on function public.notificar_incidencia()            from authenticated;
revoke execute on function public.notificar_push()                  from authenticated;
revoke execute on function public.notificar_reasignacion()          from authenticated;
revoke execute on function public.notificar_reasignacion_aprobada() from authenticated;
revoke execute on function public.notificar_ruta()                  from authenticated;
revoke execute on function public.notificar_ruta_asignada()         from authenticated;
revoke execute on function public.notificar_tecnico()               from authenticated;
revoke execute on function public.pauta_evid_no_tras_comprobar()    from authenticated;
revoke execute on function public.ruta_asig_guardar_historial()     from authenticated;
revoke execute on function public.ruta_asig_valida_unidad()         from authenticated;
revoke execute on function public.set_derivados()                   from authenticated;
revoke execute on function public.set_folio()                       from authenticated;
revoke execute on function public.validar_dominio_registro()        from authenticated;
revoke execute on function public.vv_log_pauta()                    from authenticated;
revoke execute on function public.vv_notificar_por_programar()      from authenticated;
revoke execute on function public.vv_notificar_programada()         from authenticated;

revoke execute on function public.comp_gestiona(text)                              from authenticated;
revoke execute on function public.comp_lee(text)                                   from authenticated;
revoke execute on function public.ordenar_ruta_por_cercania(bigint)                from authenticated;
revoke execute on function public.ordenar_rutas_unidad(text)                       from authenticated;
revoke execute on function public.contrato_en_mi_cuadrilla(text)                   from authenticated;
revoke execute on function public.sincronizar_biobox_app_reportes(jsonb, boolean)  from authenticated;
revoke execute on function public.sincronizar_biobox_peru(jsonb, boolean)          from authenticated;

-- 2) Comprobaciones: analista vacía ya no abre la puerta ------------------

CREATE OR REPLACE FUNCTION public.comp_tomas_ajenas(p_ids bigint[])
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with yo as (
    select lower(coalesce(auth_email(), '')) as email,
           array(select comp_mis_unidades(array['supervisor']::app_role[])) as gest,
           array(select u from unnest(array['Ecovallas', 'Biobox', 'Vía Verde']) u
                  where comp_es_analista_de(auth_email(), u)) as anal)
  select count(*)::int
    from comp_tomas t join comp_campanas c on c.id = t.campana_id, yo
   where t.id = any (p_ids)
     and (c.estatus <> 'abierta'
          or not coalesce(c.unidad = any (yo.gest)
                          or (c.analista_email = yo.email and c.unidad = any (yo.anal)), false))
$function$;

CREATE OR REPLACE FUNCTION public.comp_sitios_ajenos(p_ids bigint[])
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with yo as (
    select lower(coalesce(auth_email(), '')) as email,
           array(select comp_mis_unidades(array['supervisor']::app_role[])) as gest,
           array(select u from unnest(array['Ecovallas', 'Biobox', 'Vía Verde']) u
                  where comp_es_analista_de(auth_email(), u)) as anal)
  select count(*)::int
    from comp_sitios s join comp_campanas c on c.id = s.campana_id, yo
   where s.id = any (p_ids)
     and (c.estatus <> 'abierta'
          or not coalesce(c.unidad = any (yo.gest)
                          or (c.analista_email = yo.email and c.unidad = any (yo.anal)), false))
$function$;

CREATE OR REPLACE FUNCTION public.comp_agregar_sitios(p_campana_id bigint, p_claves text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '3s'
AS $function$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  c comp_campanas%rowtype;
  v_gest boolean;
  v_malas text; v_total int; v_n int := 0; v_ids bigint[]; v_tom jsonb;
begin
  select * into c from comp_campanas where id = p_campana_id for update;
  if not found then
    raise exception 'La campaña ya no existe.';
  end if;
  v_gest := comp_gestiona(c.unidad);
  -- coalesce (12-nov-2026): con analista_email vacío la condición daba NULL
  -- y el `if not` no lanzaba.
  if not coalesce(v_gest or (c.analista_email = v_email and comp_es_analista_de(v_email, c.unidad)), false) then
    raise exception 'Solo la analista de la campaña o el Supervisor agrega sitios.';
  end if;
  if c.estatus <> 'abierta' then
    raise exception 'La campaña está cerrada.';
  end if;
  if c.retirada then
    raise exception 'La campaña está retirada: regrésala antes de agregarle sitios.';
  end if;
  -- FULL solo existe en Vía Verde (Erik, 23-oct-2026): un es_full en otra
  -- unidad (dato raro de una carga) no abre esta puerta a la analista.
  if not v_gest and not (c.es_full and c.unidad = 'Vía Verde') then
    raise exception 'La analista solo agrega sitios a una campaña FULL; en las demás, pídeselo al Supervisor.';
  end if;

  drop table if exists pg_temp.comp_add;
  create temp table comp_add on commit drop as
  select distinct k.clave, k.esp, i.vendor_face_id as inv_vfid, i.site_id,
         case
           when c.unidad = 'Vía Verde' then
             not (k.clave !~ '^MX_EM_' and ve.clave is not null and ve.activo
                  and coalesce(ve.tramo, '') not ilike 'EDO MEX%'
                  and ve.tipo_espacio = case c.medio when 'Columna' then 'columna' when 'Pórtico' then 'portico' end)
           else i.vendor_face_id is null
         end as mala,
         o.original
    from unnest(p_claves) as o(original)
    cross join lateral (
      select case when c.unidad <> 'Vía Verde' or comp_clave_sitio(o.original) ~ '^MX_'
                  then comp_clave_sitio(o.original)
                  when comp_clave_sitio(o.original) ~ '^POR_' then 'MX_CM_VV_' || comp_clave_sitio(o.original)
                  else 'MX_CM_VV_COL_' || comp_clave_sitio(o.original) end as clave) k0
    cross join lateral (
      select k0.clave, case when c.unidad = 'Vía Verde' then comp_espacio_vv(k0.clave) end as esp) k
    left join inventario i on i.vendor_face_id = k.clave and i.unidad_negocio = c.unidad
                          and (c.unidad <> 'Ecovallas' or i.tipo_medio = 'Digital')
    left join vv_espacios ve on c.unidad = 'Vía Verde' and ve.clave = k.esp
   where comp_clave_sitio(o.original) is not null;

  select count(distinct clave) into v_total from pg_temp.comp_add;
  if v_total = 0 then
    raise exception 'No escribiste claves.';
  end if;
  select string_agg(distinct original, ', ') into v_malas from pg_temp.comp_add where mala;
  if v_malas is not null then
    raise exception 'Estas claves no son sitios activos de %: %. No se agregó nada.', comp_etiqueta_unidad(c.unidad), v_malas;
  end if;

  with ins as (
    insert into comp_sitios (campana_id, unidad, sitio_clave, sitio_original, vendor_face_id, site_id,
                             espacio_vv, en_inventario, origen)
    select distinct on (a.clave) c.id, c.unidad, a.clave, btrim(a.original), a.inv_vfid, a.site_id,
           a.esp, a.inv_vfid is not null, 'app'
      from pg_temp.comp_add a order by a.clave
    on conflict (campana_id, sitio_clave) do nothing
    returning id)
  select count(*), array_agg(id order by id) into v_n, v_ids from ins;

  insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, sitio_ids, n, por)
  values ('agregar_sitios', c.unidad, c.periodo_id, array[c.id], v_ids, v_n, v_email);
  v_tom := comp_reaplicar_planes(array[c.id]);
  return jsonb_build_object('agregados', v_n, 'ya_estaban', v_total - v_n) || v_tom;
end $function$;

-- Verificar: las 30 sin EXECUTE para authenticated y con service_role; las 3
-- de Comprobaciones con coalesce y los mismos permisos; el asesor baja de
-- 122 a 92 en authenticated_security_definer_function_executable.
