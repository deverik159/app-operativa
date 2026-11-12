-- ============================================================
-- 12-nov-2026 · Incidencias (permisos)
-- Qué: el área de una persona vale solo en la unidad del rol que la trae.
--      Afecta a quien ve por área de reporte (inc_sel_reportante), a quien ve
--      y repara por área de reparación (inc_sel_reparacion, inc_upd_reparacion)
--      y a quién puede escribir en el chat como técnico (msg_ins).
-- Por qué: las cuatro usaban mis_departamentos(), que junta los departamentos
--      de TODOS los roles sin su unidad. Caso Irving (coordinador de Biobox,
--      reportante Biobox/Operaciones): veía los folios de Ecovallas con
--      área de reporte "Operaciones". Al 12-nov eran unas 23 personas viendo
--      folios de una unidad donde no tienen ningún rol, y técnicos de Digital
--      de una sola unidad (p. ej. Vía Verde) viendo y pudiendo reparar la
--      Digital de Biobox y Ecovallas. Erik eligió corregir las dos (reporte y
--      reparación) el 12-nov-2026.
-- Regla nueva: el área X cuenta en el folio de la unidad U si la persona tiene
--      una fila de usuario_roles (cualquier rol, como antes) con departamento
--      X y unidad U o sin unidad ("todas"). Igualdad exacta del departamento,
--      como el IN de antes; la unidad sin mayúsculas, como el resto de las
--      políticas.
-- No cambia: quien capturó el folio lo sigue viendo; manager, viewer,
--      validador y coordinador tienen sus propias políticas; los roles en
--      "todas" siguen viendo todas las unidades; las menciones del chat (el @
--      ya exige rol en la unidad del folio, y el mencionado ve el folio por
--      inc_sel_participante_chat). La app ya calculaba reparaEn con la unidad
--      (IncidenciasView), así que solo deja de ver lo que no podía atender.
-- También: estado_maquina (panel de la máquina) marca "es de mi área" con la
--      misma regla, para no contar como tuyas fallas que ya no puedes abrir.
--      Mismo cuerpo salvo esa expresión.
-- tiene_rol y auth_email van en (select …) para calcularse una vez por
--      consulta y no por fila (mismo significado).
-- Re-ejecutable (create or replace / drop policy if exists).
-- ============================================================

-- ¿Tengo el área p_area en la unidad p_unidad? Solo responde sobre la
-- persona con sesión. SECURITY DEFINER para leer usuario_roles sin pasar
-- por su RLS dentro de las políticas (igual que mis_departamentos).
create or replace function public.mi_area_en_unidad(p_area text, p_unidad text)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select p_area is not null
     and exists (
       select 1
       from usuario_roles ur
       where lower(ur.usuario_email) = lower((select auth_email()))
         and ur.departamento = p_area
         -- Unidad vacía = "todas", como viewer_de (revisor-rls, 12-nov).
         and (nullif(btrim(ur.unidad_negocio), '') is null
              or lower(btrim(ur.unidad_negocio)) = lower(btrim(p_unidad)))
     );
$$;

revoke execute on function public.mi_area_en_unidad(text, text) from public, anon;
grant execute on function public.mi_area_en_unidad(text, text) to authenticated;

-- 1) Ver por área de reporte.
drop policy if exists inc_sel_reportante on public.incidencias;
create policy inc_sel_reportante on public.incidencias
  for select
  using (
    (select tiene_rol('reportante'::app_role))
    and (
      lower(captured_by) = lower((select auth_email()))
      or mi_area_en_unidad(area_reportante, unidad_negocio)
    )
  );

-- 2) Ver por área de reparación. El caso "técnico sin ningún departamento ve
--    todo" se conserva tal cual (al 12-nov no hay ninguno).
drop policy if exists inc_sel_reparacion on public.incidencias;
create policy inc_sel_reparacion on public.incidencias
  for select
  using (
    (select tiene_rol('reparacion'::app_role))
    and (
      not exists (select 1 from mis_departamentos())
      or mi_area_en_unidad(area_responsable, unidad_negocio)
      or mi_area_en_unidad(assigned_area, unidad_negocio)
    )
  );

-- 3) Reparar. Sin WITH CHECK, como antes: la fila nueva se revisa con la
--    misma condición (no se puede mover un folio a otra unidad o área ajena).
drop policy if exists inc_upd_reparacion on public.incidencias;
create policy inc_upd_reparacion on public.incidencias
  for update
  using (
    (select tiene_rol('reparacion'::app_role))
    and (
      mi_area_en_unidad(area_responsable, unidad_negocio)
      or mi_area_en_unidad(assigned_area, unidad_negocio)
    )
  );

-- 4) Escribir en el chat. Igual que antes salvo la rama del técnico.
drop policy if exists msg_ins on public.mensajes;
create policy msg_ins on public.mensajes
  for insert
  to authenticated
  with check (
    lower(autor_email) = lower((select auth_email()))
    and exists (
      select 1
      from incidencias i
      where i.record_id = mensajes.record_id
        and i.estatus <> 'cerrada'::estatus_incidencia
        and (
          (select tiene_rol('manager'::app_role))
          or lower(i.captured_by) = lower((select auth_email()))
          or ((select tiene_rol('validador'::app_role))
              and i.unidad_negocio in (select mis_unidades()))
          or ((select tiene_rol('reparacion'::app_role))
              and (mi_area_en_unidad(i.area_responsable, i.unidad_negocio)
                   or mi_area_en_unidad(i.assigned_area, i.unidad_negocio)))
          or exists (
            select 1 from mensajes previo
            where previo.record_id = i.record_id
              and lower(previo.autor_email) = lower((select auth_email()))
          )
          or exists (
            select 1 from chat_menciones cm
            where cm.record_id = i.record_id
              and cm.email = lower((select auth_email()))
          )
        )
    )
  );

-- 5) Panel de la máquina: "es de mi área" con la misma regla. Cuerpo copiado
--    de producción (pg_get_functiondef, 12-nov-2026); solo cambia la
--    expresión de es_de_mi_area. Grants sin cambio (create or replace los
--    conserva).
CREATE OR REPLACE FUNCTION public.estado_maquina(p_site_id text)
 RETURNS TABLE(record_id text, folio text, nombre_incidencia text, nivel text, estatus text, area text, clave_medio text, fecha_reporte timestamp with time zone, horas_en_estatus numeric, es_de_mi_area boolean, observaciones text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- `reparado` fuera desde el 14-oct-2026: ya se arregló, solo falta validarla.
    and i.estatus not in ('cerrada', 'no_reparado', 'reparado')
  order by
    -- Lo detenido primero, y dentro de eso lo más viejo. Es el orden en que
    -- el operador tiene que actuar, no el orden en que se capturaron.
    case i.estatus when 'en_proceso' then 1 else 2 end,
    i.fecha_reporte;
end
$function$;
