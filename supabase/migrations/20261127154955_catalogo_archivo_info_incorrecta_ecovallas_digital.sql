-- ============================================================
-- 27-nov-2026 · Incidencias (catálogo)
-- Qué: «Archivo con información incorrecta» (Monitoreo) también para
--      Ecovallas Digital. Es la misma falla que la fila 270 (Ecovallas Fijas),
--      con los mismos valores; solo cambia el mueble.
-- Por qué: pedido de Erik (27-nov-2026). En una pantalla, Nueva incidencia
--      ofrece el árbol de Digital más las fallas de otras áreas del mueble
--      «Ecovallas Digital» (12-nov-2026), así que con esta fila sale ahí.
-- El id no tiene secuencia: se toma el siguiente al mayor (700 → 701).
-- Re-ejecutable: no la vuelve a insertar si ya existe para ese mueble.
-- ============================================================

insert into public.catalogo_incidencias
  (id, unidad_negocio, tipo_mueble, area, area_resp_code, detalle,
   origen, tipo, afectacion, impacto, sla)
select
  (select max(id) + 1 from public.catalogo_incidencias),
  c.unidad_negocio, 'Ecovallas Digital', c.area, c.area_resp_code, c.detalle,
  c.origen, c.tipo, c.afectacion, c.impacto, c.sla
from public.catalogo_incidencias c
where c.id = 270
  and not exists (
    select 1 from public.catalogo_incidencias x
    where lower(x.unidad_negocio) = lower(c.unidad_negocio)
      and x.tipo_mueble = 'Ecovallas Digital'
      and lower(x.detalle) = lower(c.detalle)
  );
