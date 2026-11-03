-- Viewer = Consulta (Erik, 3 y 10-nov-2026).
-- El rol viewer ("Consulta") mira los módulos de operación de SU unidad, sin
-- ninguna acción que escriba. Es para dirección y supervisión, en lugar de
-- darles manager. Decisiones de Erik del 10-nov-2026:
--   · la unidad se respeta en todo: rol y unidad de la MISMA fila (fila sin
--     unidad = todas). Antes tiene_rol('viewer') abría todas las unidades;
--   · no ve datos que no necesita: el GPS de las visitas de los monitoristas,
--     los nombres y correos de las cuadrillas ni del equipo de Comprobaciones,
--     ni los datos comerciales de Pauta VV. Por eso NO se le abren Pauta VV,
--     Comprobaciones ni ruta_visitas, y la vista de Fijación le manda vacíos
--     los nombres de la cuadrilla.
--
-- Solo cambia LECTURA, más un candado de escritura que faltaba
-- (marcar_fijacion_externa). Ninguna política de INSERT, UPDATE o DELETE
-- cambia y ninguna función que escriba acepta al viewer.

-- ── ¿Es consulta de esa unidad? ─────────────────────────────────────────────
-- Fila de viewer sin unidad = todas. Con p_medio (p. ej. 'impreso'), la fila
-- con medio debe empezar con ese texto; sin medio vale para ambos.
-- p_unidad null solo lo cumple el viewer sin unidad.
create or replace function public.viewer_de(p_unidad text, p_medio text default null)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from usuario_roles ur
     where lower(ur.usuario_email) = lower(auth_email())
       and ur.rol = 'viewer'::app_role
       and (nullif(btrim(ur.unidad_negocio), '') is null
            or lower(btrim(ur.unidad_negocio)) = lower(btrim(p_unidad)))
       and (p_medio is null or nullif(btrim(ur.medio), '') is null
            or btrim(ur.medio) ilike p_medio || '%')
  )
$function$;

-- ── Incidencias y sus reasignaciones: el viewer, solo las de su unidad ──────
alter policy inc_sel_manager_viewer on public.incidencias
  using (tiene_rol('manager'::app_role) or viewer_de(unidad_negocio));

alter policy reasign_sel on public.reasignaciones
  using (tiene_rol('manager'::app_role) or viewer_de(unidad_negocio)
         or (unidad_negocio in (select mis_unidades() as mis_unidades)));

-- ── Aviso NUC: el viewer, solo su unidad ─────────────────────────────────────
-- Igual que la vigente (4-nov-2026) salvo tiene_rol('viewer') → viewer_de.
create or replace function public.nuc_puede_ver(p_unidad text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select nuc_es_digital()
      or nuc_es_tecnico(p_unidad)
      or viewer_de(p_unidad)
      or exists (
           select 1 from usuario_roles ur
            where lower(ur.usuario_email) = lower(auth_email())
              and (
                    (ur.rol = 'coordinador'::app_role
                     and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad)))
                 or (ur.rol = 'validador'::app_role
                     and lower(ur.unidad_negocio) = lower(p_unidad)
                     -- CAMBIO (4-nov-2026): fuera de Biobox, solo el de
                     -- Digital o de todos los medios (no el de Impreso).
                     and (lower(p_unidad) in ('biobox', 'biobox perú')
                          or ur.medio is null or ur.medio ilike 'digital'))
              ))
      -- CAMBIO (4-nov-2026): los agregados a mano a esa unidad.
      or exists (
           select 1 from nuc_avisos_extra x
            where x.usuario_email = lower(auth_email())
              and lower(x.unidad_negocio) = lower(p_unidad));
$function$;

-- ── Rutas de Operación: el viewer ve las rutas de todos los coordinadores ───
-- de SU unidad (como el manager: lista de coordinadores y filtro «Todos»),
-- solo si NO es coordinador: un coordinador que además sea viewer sigue
-- viendo las suyas, para que nunca cree o importe rutas a nombre de otro.
-- El avance de visitas (ruta_visitas, con GPS) no se le abre.
create or replace function public.rutas_contexto(p_unidad text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_email    text := lower(auth_email());
  v_manager  boolean := tiene_rol('manager'::app_role);
  v_coord    boolean := tiene_rol('coordinador'::app_role);
  v_consulta boolean := viewer_de(p_unidad) and not v_coord and not v_manager;
  v_lista    jsonb;
begin
  if not (v_coord or v_manager or v_consulta) then
    raise exception 'No tienes permiso para ver rutas de coordinadores.';
  end if;

  if v_manager or v_consulta then
    select coalesce(jsonb_agg(jsonb_build_object('email', e.email, 'nombre', nombre_coordinador(e.email))
                              order by nombre_coordinador(e.email)), '[]'::jsonb)
      into v_lista
      from (
        select distinct lower(ur.usuario_email) as email
          from usuario_roles ur
         where ur.rol = 'coordinador'::app_role
           and (nullif(btrim(ur.unidad_negocio), '') is null or ur.unidad_negocio = p_unidad)
        union
        select coordinador_email from rutas_monitoreo where unidad_negocio = p_unidad
      ) e;
  else
    v_lista := jsonb_build_array(jsonb_build_object('email', v_email, 'nombre', nombre_coordinador(v_email)));
  end if;

  return jsonb_build_object('yo', v_email, 'es_manager', v_manager, 've_todo', v_consulta,
                            'coordinadores', v_lista);
end $function$;

-- ── Fijación Externa (Ecovallas Impreso) ─────────────────────────────────────
-- El viewer de Ecovallas Impreso (o sin unidad) ve todas las órdenes, pero los
-- nombres de la cuadrilla y del supervisor le llegan vacíos. Quien ya los veía
-- (manager, coordinador, el operador de la cuadrilla) los sigue viendo igual.
-- Mismas columnas, mismo orden.
create or replace view public.vw_fijacion_externa as
 select e.id,
    case when (select tiene_rol('manager'::app_role)) or (select tiene_rol('coordinador'::app_role))
              or (lower(coalesce(e.operadores_cuadrilla, ''::text)) ~~ (('%'::text || lower(auth_email())) || '%'::text))
         then e.responsable_de_cuadrilla end as responsable_de_cuadrilla,
    case when (select tiene_rol('manager'::app_role)) or (select tiene_rol('coordinador'::app_role))
              or (lower(coalesce(e.operadores_cuadrilla, ''::text)) ~~ (('%'::text || lower(auth_email())) || '%'::text))
         then e.operadores_cuadrilla end as operadores_cuadrilla,
    e.clave,
    e.catorcena,
    e.producto,
    e.zona,
    e.asignacion,
    case when (select tiene_rol('manager'::app_role)) or (select tiene_rol('coordinador'::app_role))
              or (lower(coalesce(e.operadores_cuadrilla, ''::text)) ~~ (('%'::text || lower(auth_email())) || '%'::text))
         then e.supervisor end as supervisor,
    e.campana,
    e.version,
    e.direccion,
    e.estado,
    e.notas_observa,
    e.fecha_asignacion,
    e.fecha_limite,
    e.foto_tomada,
    e.foto_url,
    e.evidencia_url,
    i.latitud,
    i.longitud,
    i.municipio,
    (i.vendor_face_id is null) as sin_match_inventario,
    e.notas_motivo_bloqueo,
    e.blanqueo_limpieza,
    e.fecha_fijacion_real,
    e.fecha_terminado
   from (externo.fijacion e
     left join inventario i on ((i.vendor_face_id = e.clave)))
  where ((nullif(lower(coalesce(auth_email(), ''::text)), ''::text) is not null)
     and ((select tiene_rol('manager'::app_role)) or (select tiene_rol('coordinador'::app_role))
          or (select viewer_de('Ecovallas', 'impreso'))
          or (lower(coalesce(e.operadores_cuadrilla, ''::text)) ~~ (('%'::text || lower(auth_email())) || '%'::text))));

-- ── Candado que faltaba: marcar_fijacion_externa no revisaba quién la llama ──
-- (revisor-rls, 3-nov-2026). Era SECURITY DEFINER, ejecutable por cualquiera
-- con sesión y sin search_path fijo; con la vista abierta al viewer, tendría
-- los id para llamarla directo a la API. Ahora pide la regla de la vista SIN
-- el viewer: manager, coordinador o un operador de la cuadrilla de esa orden.
-- El cuerpo de la escritura no cambia.
create or replace function public.marcar_fijacion_externa(
  p_id uuid, p_fotos_json text, p_foto_tomada boolean, p_motivo text default null::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if nullif(lower(coalesce(auth_email(), '')), '') is null
     or not (tiene_rol('manager'::app_role) or tiene_rol('coordinador'::app_role)
             or exists (select 1 from externo.fijacion e
                         where e.id = p_id
                           and lower(coalesce(e.operadores_cuadrilla, '')) like '%' || lower(auth_email()) || '%')) then
    raise exception 'No tienes permiso para marcar esta orden.';
  end if;

  update externo.fijacion
  set estado = 'COMPLETO',
      fecha_fijacion_real = now()::text,
      foto_tomada = p_foto_tomada,
      foto_url = p_fotos_json,
      evidencia_url = p_fotos_json,
      notas_motivo_bloqueo = coalesce(p_motivo, notas_motivo_bloqueo)
  where id = p_id;
end $function$;

-- ── Revisión del 10-nov-2026 (revisor-rls): lo que aún abría al viewer ──────
-- Políticas viejas con tiene_rol('viewer') sin unidad: contratos comerciales
-- de QTM (cliente, vendedor, monto) y fijaciones (correos de quien fija). El
-- viewer no los necesita (Erik, 10-nov-2026); la app no lee estas tablas.
-- qtm_pautas sigue abierta a todos por qtm_pautas_sel (Pauta la usa).
alter policy fij_sel_mgr on public.fijaciones using (tiene_rol('manager'::app_role));
alter policy qtm_contr_sel_mgr on public.qtm_contratos using (tiene_rol('manager'::app_role));
alter policy qtm_pauta_sel_mgr on public.qtm_pautas using (tiene_rol('manager'::app_role));

-- Directorio del chat (nombre, correo y área de quienes tienen rol en la
-- unidad): el viewer no escribe en el chat, así que tampoco lo recibe.
-- Igual a la vigente salvo «yo.rol <> 'viewer'».
create or replace function public.chat_mencionables(p_record_id text)
 returns table(tipo text, clave text, nombre text, detalle text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with inc as (
    select i.unidad_negocio
    from incidencias i
    where i.record_id = p_record_id
      and (select auth_email()) is not null
      and nullif(trim(i.unidad_negocio), '') is not null
      and (
        exists (
          select 1 from usuario_roles yo
          where lower(yo.usuario_email) = lower((select auth_email()))
            and yo.rol <> 'viewer'::app_role
            and (yo.unidad_negocio is null
                 or lower(yo.unidad_negocio) = lower(i.unidad_negocio))
        )
        or lower(i.captured_by) = lower((select auth_email()))
        or exists (
          select 1 from chat_menciones cm
          where cm.record_id = i.record_id
            and cm.email = lower((select auth_email()))
        )
      )
  ),
  roles as (
    select lower(ur.usuario_email) as email, ur.rol, ur.departamento
    from usuario_roles ur, inc
    where ur.rol <> 'viewer'::app_role
      and (ur.unidad_negocio is null
           or lower(ur.unidad_negocio) = lower(inc.unidad_negocio))
  )
  select 'persona'::text,
         r.email,
         coalesce(max(nullif(trim(u.nombre), '')), r.email),
         string_agg(distinct coalesce(nullif(trim(r.departamento), ''), r.rol::text), ', ')
  from roles r
  left join usuarios u on lower(u.email) = r.email
  group by r.email
  union all
  select 'area'::text,
         trim(r.departamento),
         trim(r.departamento),
         count(distinct r.email)::text
  from roles r
  where r.rol = 'reparacion'::app_role
    and nullif(trim(r.departamento), '') is not null
  group by trim(r.departamento);
$function$;

-- Visitas a máquinas Biobox (GPS y correo del técnico): el viewer ya no las
-- lee, como las de los monitoristas (Erik, 10-nov-2026). Quedan quienes
-- registran visitas (maquina_visita_puede).
create or replace function public.maquina_visita_puede_leer()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select maquina_visita_puede()
$function$;
