-- ============================================================
-- pauta_registrar_toma_revision — registrar_toma: el analista es solo de
-- revisión y los avisos «Toma por revisar» se juntan por hora (Erik,
-- 24-oct-2026).
--
-- POR QUÉ.
--   1. Erik decidió el 24-oct-2026 que el analista «es solo de revisión».
--      registrar_toma no revisaba rol: cualquier sesión registraba, y
--      pev_ins dejaba subir fotos a cualquiera con sesión. Ahora quien SOLO
--      tiene fila de analista (sin monitorista, coordinador, fijador ni
--      manager) no registra ni sube fotos. Erik, Solicitudes y el equipo
--      de campo conservan sus otros roles y no cambian.
--   2. Pendiente técnico: un aviso por toma llenaba la campana del analista
--      (15 avisos pauta_revision en producción al 24-oct-2026). Ahora, por
--      analista, si ya tiene un aviso pauta_revision sin leer de la última
--      hora, se actualiza su texto con el total de tomas por revisar de la
--      catorcena y la última registrada; si no, se inserta uno nuevo (y ese
--      sí manda push por trg_notificar_push, que solo corre en INSERT). La
--      app recibe el UPDATE por realtime (useNotificaciones escucha INSERT y
--      UPDATE).
--
-- QUÉ CAMBIA. El cuerpo de registrar_toma (misma firma, security definer,
-- search_path y grants: create or replace los conserva) y la política
-- pev_ins. El resto del cuerpo es el vigente en producción
-- (20261023231645_pauta_aviso_tomas_en_comprobaciones; md5 verificado abajo).
-- Re-ejecutable una vez aplicada (el candado solo frena si en producción
-- hay un cuerpo distinto al esperado o al de esta migración).
-- ============================================================

do $$
declare
  v text;
begin
  select md5(replace(prosrc, E'\r', '')) into v from pg_proc
   where oid = 'public.registrar_toma(integer, text, integer)'::regprocedure;
  if v not in ('786b3253242e3584c358991af4d38c0c', '86abb3026d56a6d2e205fb315b9f5a8c') then
    raise exception 'registrar_toma cambió en producción; revisar antes de aplicar.';
  end if;
end;
$$;

create or replace function public.registrar_toma(p_catorcena integer, p_vendor_face_id text, p_anio integer default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  -- El analista es solo de revisión (Erik, 24-oct-2026): no registra tomas.
  -- Quien además es monitorista, coordinador, fijador o manager sí puede.
  if tiene_rol('analista'::app_role)
     and not (tiene_rol('monitorista'::app_role) or tiene_rol('coordinador'::app_role)
              or tiene_rol('fijador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'El analista es solo de revisión: no registra tomas.';
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

-- Subir fotos: tampoco quien solo es analista (Erik, 24-oct-2026). Antes:
-- auth_email() is not null.
drop policy if exists pev_ins on public.pauta_evidencias;
create policy pev_ins on public.pauta_evidencias for insert
  with check (
    auth_email() is not null
    and not (
      tiene_rol('analista'::app_role)
      and not (tiene_rol('monitorista'::app_role) or tiene_rol('coordinador'::app_role)
               or tiene_rol('fijador'::app_role) or tiene_rol('manager'::app_role))
    )
  );
