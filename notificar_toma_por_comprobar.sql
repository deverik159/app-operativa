-- ============================================================
-- notificar_toma_por_comprobar.sql — la toma nueva avisa al coordinador
-- Correr en Supabase → SQL Editor.
--
-- EL HUECO (Erik, 22-sep-2026): el monitorista registra su toma y queda
-- "por comprobar"… pero el coordinador no se entera hasta que abre Pauta.
-- El ciclo ya avisa en las otras dos direcciones (ruta asignada → push al
-- monitorista; toma regresada → push al monitorista); faltaba esta.
--
-- QUÉ HACE: registrar_toma, cuando la toma es NUEVA (no al agregar más
-- evidencia a una ya registrada), notifica a los COORDINADORES con el
-- evento 'pauta_revision'. Los managers reciben su copia solos, por el
-- trigger trg_replicar_a_managers — aquí no se les inserta nada.
-- El título del push ("Toma por comprobar") ya quedó desplegado en
-- enviar-push.
-- ============================================================

create or replace function registrar_toma(
  p_catorcena int,
  p_vendor_face_id text
)
returns void
language plpgsql
security definer
as $$
declare
  v_previa timestamptz;
  v_sitio record;
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;

  -- ¿Ya había toma vigente? Entonces esto es evidencia extra, no una toma
  -- nueva, y no se re-avisa al coordinador.
  select fecha_toma into v_previa
  from pauta_monitoreo
  where catorcena = p_catorcena and vendor_face_id = p_vendor_face_id;

  insert into pauta_monitoreo (catorcena, vendor_face_id, fecha_toma, toma_por)
  values (p_catorcena, p_vendor_face_id, now(), lower(auth_email()))
  on conflict (catorcena, vendor_face_id) do update
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
    select site_id, cara into v_sitio
    from pautas
    where catorcena = p_catorcena and vendor_face_id = p_vendor_face_id
    limit 1;

    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
    select null, u.email, 'pauta_revision',
           'Toma por comprobar: ' ||
             coalesce(v_sitio.site_id, p_vendor_face_id) ||
             coalesce(' cara ' || v_sitio.cara, '') ||
             ' (catorcena ' || p_catorcena || '), registrada por ' ||
             split_part(lower(auth_email()), '@', 1) ||
             '. Revísala en Pauta y Monitoreo.',
           'Ecovallas'
    from (
      select distinct lower(usuario_email) as email
      from usuario_roles
      where rol = 'coordinador'
        and (unidad_negocio is null or unidad_negocio ilike 'Ecovallas')
    ) u
    -- Si el coordinador registrara una toma él mismo, no se auto-avisa.
    where u.email <> lower(auth_email());
  end if;
end;
$$;

-- Verificación: registra una toma nueva desde la app y corre esto — debe
-- salir una fila por coordinador (y la réplica del manager).
select para_email, evento, left(mensaje, 70) as mensaje, creado_en
from notificaciones
where evento = 'pauta_revision'
order by creado_en desc
limit 10;
