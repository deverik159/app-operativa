-- 9-nov-2026 · Reportes de la app Biobox: lectura solo para la bandeja
--
-- Qué hace: quita de la política de lectura de biobox_app_reportes la rama
--   «quien puede ver la incidencia ligada». Con ella, técnicos, participantes
--   del chat y mencionados leían el reporte completo, incluida la descripción
--   que escribió el usuario final (puede traer su teléfono o correo) y su foto.
--   Lo señaló la revisión de seguridad del commit 0dcdde5.
--
-- Quién lee después: la validadora de la unidad, los coordinadores de la
--   unidad o sin unidad, el manager (biobox_app_ve_bandeja) y Consulta
--   (viewer). Es lo mismo que abre la pestaña de la app; ninguna otra pantalla
--   leía esta tabla. El técnico sigue viendo en la incidencia el folio de la
--   app, el motivo y la etiqueta (van en sus observaciones).
--
-- Antes de encender el sync (la tabla está vacía al 9-nov-2026).

set local lock_timeout = '5s';

drop policy if exists biobox_app_reportes_sel on public.biobox_app_reportes;
create policy biobox_app_reportes_sel on public.biobox_app_reportes
  for select to authenticated
  using (
    (select biobox_app_ve_bandeja(biobox_app_reportes.unidad_negocio))
    or (select tiene_rol('viewer'::app_role))
  );
