-- ============================================================
-- 23-nov-2026 · Incidencias · Catálogo
-- Qué: una falla nueva de TI en el catálogo de BioBox (México), una fila
--      por mueble (M4, M4 URBANA, M4-R2, M5, M5 OXXO):
--        · «Falla en mecanismo»
--      Datos de Erik (23-nov-2026), con los nombres de columna de la tabla:
--        origen = Externo · tipo = Imponderable · afectacion = Usuario ·
--        impacto = Alto · area = TI · area_resp_code = TI · sla = null.
--      Unidad escrita «BioBox», como «SIM sin datos» (20261120201121) y las
--      demás fallas de TI de esa unidad (la app busca la unidad con ilike).
-- Por qué: Erik la pidió para poder reportarla al capturar una incidencia
--      de Biobox con área TI. No se agrega a BioBox Perú (no se pidió).
-- Efectos: solo agrega 5 filas; nada existente cambia. Hoy no hay ninguna
--      falla con «mecanismo» en el catálogo.
-- Re-ejecutable: cada fila entra solo si no existe ya la misma
--      unidad + mueble + falla. `id` no tiene secuencia: se numera después
--      del máximo actual.
-- ============================================================

insert into public.catalogo_incidencias
  (id, unidad_negocio, tipo_mueble, origen, tipo, detalle, afectacion,
   area, impacto, sla, area_resp_code)
select (select coalesce(max(id), 0) from public.catalogo_incidencias)
         + row_number() over (order by m.orden),
       'BioBox', m.mueble, 'Externo', 'Imponderable', 'Falla en mecanismo', 'Usuario',
       'TI', 'Alto', null, 'TI'
  from (values (1, 'M4'), (2, 'M4 URBANA'), (3, 'M4-R2'),
               (4, 'M5'), (5, 'M5 OXXO')) as m(orden, mueble)
 where not exists (
         select 1
           from public.catalogo_incidencias c
          where lower(btrim(c.unidad_negocio)) = 'biobox'
            and lower(btrim(c.tipo_mueble)) = lower(m.mueble)
            and lower(btrim(c.detalle)) = 'falla en mecanismo'
       );
