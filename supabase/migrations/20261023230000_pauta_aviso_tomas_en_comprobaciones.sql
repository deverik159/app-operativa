-- ============================================================
-- pauta_aviso_tomas_en_comprobaciones — el aviso «Toma por revisar» lleva
-- a Comprobaciones (Erik, 23-oct-2026).
--
-- POR QUÉ. La pestaña donde el analista revisa, rechaza y regresa las tomas
-- del monitorista se mudó de Pauta y Monitoreo («Analista») a Comprobaciones
-- («Tomas de Pauta»). El texto del aviso que genera registrar_toma todavía
-- decía «Revísala en Pauta y Monitoreo, pestaña Analista», una pestaña que
-- ya no existe (revisión 3, pauta-y-avisos-3).
--
-- QUÉ CAMBIA. Solo esa frase del mensaje. El resto de registrar_toma es el
-- cuerpo vigente en producción, copiado tal cual de
-- 20261022142950_pauta_revision_analista.sql (md5 del cuerpo en producción
-- = el del archivo, verificado el 23-oct-2026): misma firma, security
-- definer, search_path y grants (create or replace los conserva).
-- Re-ejecutable.
-- ============================================================

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
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
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
    -- las revisó, y no hace falta avisar (revisor-rls, 22-oct-2026).
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

    -- Desde el 22-oct-2026 la revisa el analista (antes, el coordinador).
    -- Desde el 23-oct-2026 lo hace en Comprobaciones › Tomas de Pauta.
    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
    select null, u.email, 'pauta_revision',
           'Toma por revisar: ' ||
             coalesce(v_sitio.site_id, p_vendor_face_id) ||
             coalesce(' cara ' || v_sitio.cara, '') ||
             ' (Cat-' || p_catorcena || ' · ' || v_anio || '), registrada por ' ||
             split_part(lower(auth_email()), '@', 1) ||
             '. Revísala en Comprobaciones, pestaña Tomas de Pauta.',
           'Ecovallas'
    from (
      select distinct lower(usuario_email) as email
      from usuario_roles
      where rol = 'analista'
        and (unidad_negocio is null or unidad_negocio ilike 'Ecovallas')
    ) u
    -- Quien registra no se auto-avisa.
    where u.email <> lower(auth_email());
  end if;
end;
$function$;
