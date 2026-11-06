-- 6-nov-2026 · Máquinas Biobox (sección biobox) · Erik.
-- Qué: Revisar y Visita rápida solo los pueden guardar el manager, los técnicos
-- y coordinadores de Op. Bio Box y los coordinadores de Biobox sin área; el
-- historial (revisiones, respuestas, evidencias, visitas y la vista del
-- módulo) lo leen ellos, cualquier coordinador (Avance de visitas en Rutas) y
-- Consulta de Biobox.
-- Por qué: una fila de rol sin unidad contaba como Biobox y un técnico de
-- Digital o TI «de todas las unidades» veía el módulo y podía guardar. Las
-- tablas de revisiones además dejaban leer y escribir a cualquier sesión.
-- Espejo en la app: abreMaquinasBiobox (src/lib/maquinasBiobox.ts).

-- 1) La regla, en una sola función. Rol, unidad y área de la MISMA fila.
create or replace function public.opera_maquinas_biobox()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from usuario_roles ur
     where lower(btrim(ur.usuario_email)) = lower((select auth_email()))
       and (
             ur.rol = 'manager'::app_role
          -- Técnico o coordinador de Op. Bio Box (área que solo existe en
          -- Biobox): de Biobox, Biobox Perú o sin unidad.
          or (ur.rol in ('reparacion'::app_role, 'coordinador'::app_role)
              and btrim(coalesce(ur.departamento, '')) ilike 'op. bio box'
              and (nullif(btrim(ur.unidad_negocio), '') is null
                   or btrim(ur.unidad_negocio) ilike 'biobox%'))
          -- Coordinador de Biobox sin área.
          or (ur.rol = 'coordinador'::app_role
              and nullif(btrim(ur.departamento), '') is null
              and btrim(coalesce(ur.unidad_negocio, '')) ilike 'biobox%')
           )
  )
$$;

revoke execute on function public.opera_maquinas_biobox() from public, anon;
grant execute on function public.opera_maquinas_biobox() to authenticated;

-- 2) Visita rápida: quién guarda (mvis_ins) y quién lee (mvis_sel y Rutas).
create or replace function public.maquina_visita_puede()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.opera_maquinas_biobox()
$$;

create or replace function public.maquina_visita_puede_leer()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.opera_maquinas_biobox()
      -- Cualquier coordinador: Rutas › Avance de visitas cuenta visitas y
      -- revisiones de sus rutas Biobox.
      or tiene_rol('coordinador'::app_role)
      or exists (
           select 1 from usuario_roles ur
            where lower(btrim(ur.usuario_email)) = lower((select auth_email()))
              and ur.rol = 'viewer'::app_role
              and (nullif(btrim(ur.unidad_negocio), '') is null
                   or btrim(ur.unidad_negocio) ilike 'biobox%')
         )
$$;

revoke execute on function public.maquina_visita_puede() from public, anon;
revoke execute on function public.maquina_visita_puede_leer() from public, anon;
grant execute on function public.maquina_visita_puede() to authenticated;
grant execute on function public.maquina_visita_puede_leer() to authenticated;

-- 3) Guardar una revisión (RPC SECURITY DEFINER: no pasa por la RLS, así que
--    la regla va adentro). El resto del cuerpo queda igual.
create or replace function public.guardar_revision(p_cabecera jsonb, p_respuestas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text := lower(coalesce(auth_email(), ''));
  v_id     bigint;
  v_ok     int := 0;
  v_anom   int := 0;
  v_na     int := 0;
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
    nullif(p_cabecera->>'vendor_face_id', ''),
    nullif(p_cabecera->>'unidad_negocio', ''),
    nullif(p_cabecera->>'nombre_maquina', ''),
    nullif(p_cabecera->>'direccion', ''),
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

revoke execute on function public.guardar_revision(jsonb, jsonb) from public, anon;
grant execute on function public.guardar_revision(jsonb, jsonb) to authenticated;

-- 4) Tablas de revisiones: antes bastaba tener sesión.
drop policy if exists revisiones_sel on public.revisiones;
create policy revisiones_sel on public.revisiones
  for select to authenticated
  using ((select public.maquina_visita_puede_leer()));

drop policy if exists rev_ins on public.revisiones;
create policy rev_ins on public.revisiones
  for insert to authenticated
  with check (
    lower(coalesce(revisado_por, '')) = lower((select auth_email()))
    and (select public.opera_maquinas_biobox())
  );

-- Corregir una revisión: quien opera el módulo, y además el manager, un
-- coordinador o el autor en las primeras 24 h (antes, cualquier coordinador
-- de cualquier área; revisor-rls). La app hoy no la usa.
drop policy if exists rev_upd on public.revisiones;
create policy rev_upd on public.revisiones
  for update to authenticated
  using (
    (select public.opera_maquinas_biobox())
    and ((select public.tiene_rol('manager'::app_role))
         or (select public.tiene_rol('coordinador'::app_role))
         or (lower(coalesce(revisado_por, '')) = lower((select auth_email()))
             and revisado_en > now() - interval '1 day'))
  )
  with check ((select public.opera_maquinas_biobox()));

drop policy if exists revision_respuestas_sel on public.revision_respuestas;
create policy revision_respuestas_sel on public.revision_respuestas
  for select to authenticated
  using ((select public.maquina_visita_puede_leer()));

drop policy if exists rev_resp_ins on public.revision_respuestas;
-- La app solo inserta respuestas por guardar_revision (definer); por la API,
-- solo en una revisión propia.
create policy rev_resp_ins on public.revision_respuestas
  for insert to authenticated
  with check (
    (select public.opera_maquinas_biobox())
    and exists (
      select 1 from public.revisiones rv
       where rv.id = revision_id
         and lower(coalesce(rv.revisado_por, '')) = lower((select auth_email()))
    )
  );

-- Sellar la respuesta con su incidencia (RevisionModal).
drop policy if exists rev_resp_upd on public.revision_respuestas;
create policy rev_resp_upd on public.revision_respuestas
  for update to authenticated
  using ((select public.opera_maquinas_biobox()))
  with check ((select public.opera_maquinas_biobox()));

drop policy if exists revision_evidencias_sel on public.revision_evidencias;
create policy revision_evidencias_sel on public.revision_evidencias
  for select to authenticated
  using ((select public.maquina_visita_puede_leer()));

drop policy if exists rev_ev_ins on public.revision_evidencias;
create policy rev_ev_ins on public.revision_evidencias
  for insert to authenticated
  with check (
    (select public.opera_maquinas_biobox())
    and lower(coalesce(subido_por, '')) = lower((select auth_email()))
  );

drop policy if exists rev_ev_del on public.revision_evidencias;
create policy rev_ev_del on public.revision_evidencias
  for delete to authenticated
  using (
    (select public.opera_maquinas_biobox())
    and (lower(coalesce(subido_por, '')) = lower((select auth_email()))
         or (select public.tiene_rol('coordinador'::app_role))
         or (select public.tiene_rol('manager'::app_role)))
  );

-- 5) La vista del módulo corre como su dueño (no pasa por la RLS de
--    revisiones): mismo filtro de lectura. Columnas sin cambio.
create or replace view public.vw_revision_ubicaciones as
 SELECT ru.id AS ubicacion_id,
    r.id AS ruta_id,
    r.numero AS ruta_numero,
    r.nombre AS ruta_nombre,
    r.color AS ruta_color,
    r.unidad_negocio,
    r.tipo_medio,
    r.activa AS ruta_activa,
    ru.site_id,
    ru.secuencia,
    inv.vendor_face_id,
    inv.site_legacy_id,
    inv.direccion,
    inv.municipio,
    inv.estado,
    inv.tipo_mueble,
    inv.medio,
    inv.latitud,
    inv.longitud,
    ((inv.latitud IS NOT NULL) AND (inv.longitud IS NOT NULL)) AS navegable,
    ult.id AS revision_id,
    ult.revisado_en AS ultima_revision,
    ult.revisado_por AS ultimo_revisor,
    ult.estado_maquina,
    ult.puntos_anomalia,
        CASE
            WHEN (ult.revisado_en IS NULL) THEN NULL::integer
            ELSE (floor((EXTRACT(epoch FROM (now() - ult.revisado_en)) / (86400)::numeric)))::integer
        END AS dias_sin_revision
   FROM (((ruta_ubicaciones ru
     JOIN rutas_monitoreo r ON ((r.id = ru.ruta_id)))
     LEFT JOIN LATERAL ( SELECT inventario.vendor_face_id,
            inventario.site_legacy_id,
            inventario.direccion,
            inventario.municipio,
            inventario.estado,
            inventario.tipo_mueble,
            inventario.tipo_medio AS medio,
            inventario.latitud,
            inventario.longitud
           FROM inventario
          WHERE (inventario.site_id = ru.site_id)
          ORDER BY inventario.vendor_face_id
         LIMIT 1) inv ON (true))
     LEFT JOIN LATERAL ( SELECT revisiones.id,
            revisiones.revisado_en,
            revisiones.revisado_por,
            revisiones.estado_maquina,
            revisiones.puntos_anomalia
           FROM revisiones
          WHERE (revisiones.site_id = ru.site_id)
          ORDER BY revisiones.revisado_en DESC
         LIMIT 1) ult ON (true))
  -- CAMBIO (6-nov-2026)
  WHERE (select public.maquina_visita_puede_leer());
