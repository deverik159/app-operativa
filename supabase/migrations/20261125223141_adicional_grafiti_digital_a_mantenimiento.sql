-- ============================================================
-- adicional_grafiti_digital_a_mantenimiento (Erik, 25-nov-2026)
--
-- «Adicional con grafiti» en Ecovallas Digital (pantallas) iba a Digital;
-- Erik: es de Mantenimiento, como en Ecovallas Fijas. Erik eligió pasarla
-- a Mantenimiento (no quitarla): en las pantallas sigue apareciendo, pero
-- ya no le llega a Digital.
--
--   1. Catálogo: la fila de Ecovallas Digital pasa a Mantenimiento (MANT).
--      Nivel, origen, tipo y afectación ya son iguales a los de Fijas.
--   2. Las 2 por validar que ya la traían con Digital (EVD00045 y
--      EVD00047) pasan a Mantenimiento. Siguen por validar; no hay aviso
--      a técnicos (notificar_correccion_area solo avisa en proceso). Su
--      historial registra «área corregida Digital → Mantenimiento» sin autor
--      (la migración no tiene sesión); la pantalla lo muestra así.
--
-- Candado: si no son exactamente 1 fila del catálogo y 2 incidencias, no
-- se aplica nada.
-- ============================================================

do $$
declare
  n int;
begin
  update public.catalogo_incidencias
     set area = 'Mantenimiento',
         area_resp_code = 'MANT'
   where unidad_negocio = 'Ecovallas'
     and tipo_mueble = 'Ecovallas Digital'
     and detalle = 'Adicional con grafiti'
     and area = 'Digital';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'Catálogo: se esperaba 1 fila de «Adicional con grafiti» de Digital y hay %.', n;
  end if;

  update public.incidencias
     set area_responsable = 'Mantenimiento'
   where unidad_negocio = 'Ecovallas'
     and nombre_incidencia = 'Adicional con grafiti'
     and area_responsable = 'Digital'
     and estatus = 'por_validar'
     and assigned_area is null
     and folio in ('EVD00045', 'EVD00047');
  get diagnostics n = row_count;
  if n <> 2 then
    raise exception 'Incidencias: se esperaban EVD00045 y EVD00047 por validar con Digital y hay %.', n;
  end if;

  -- Revisor-rls: si mientras tanto se capturó otra, que no se quede en
  -- Digital sin que nadie lo note.
  if exists (select 1 from public.incidencias
              where unidad_negocio = 'Ecovallas'
                and nombre_incidencia = 'Adicional con grafiti'
                and coalesce(assigned_area, area_responsable) = 'Digital'
                and estatus not in ('cerrada', 'no_reparado', 'duplicada')) then
    raise exception 'Quedó una «Adicional con grafiti» de Digital sin pasar; revisa antes de aplicar.';
  end if;
end
$$;
