-- ============================================================
-- 20-nov-2026 · Incidencias · Catálogo
-- Qué: dos fallas nuevas de TI en el catálogo de BioBox (México), una fila
--      por mueble (M4, M4 URBANA, M4-R2, M5, M5 OXXO):
--        · «SIM sin datos»
--        · «SIM desactivado»
--      Datos de Erik (20-nov-2026), con los nombres de columna de la tabla:
--        origen = Interno · tipo = Imponderable · afectacion = Cliente ·
--        impacto = Alto · area = TI · area_resp_code = TI · sla = null.
--      Unidad escrita «BioBox», como «Fallas con la aplicación» y las demás
--      fallas de TI de esa unidad (la app busca la unidad con ilike).
-- Por qué: Erik las pidió para poder reportarlas al capturar una incidencia
--      de Biobox con área TI. No se agregan a BioBox Perú (no se pidió).
-- Efectos: solo agrega 10 filas; nada existente cambia.
-- Re-ejecutable: cada fila entra solo si no existe ya la misma
--      unidad + mueble + falla. `id` no tiene secuencia: se numera después
--      del máximo actual.
-- ============================================================

insert into public.catalogo_incidencias
  (id, unidad_negocio, tipo_mueble, origen, tipo, detalle, afectacion,
   area, impacto, sla, area_resp_code)
select (select coalesce(max(id), 0) from public.catalogo_incidencias)
         + row_number() over (order by n.orden, m.orden),
       'BioBox', m.mueble, 'Interno', 'Imponderable', n.detalle, 'Cliente',
       'TI', 'Alto', null, 'TI'
  from (values (1, 'SIM sin datos'), (2, 'SIM desactivado')) as n(orden, detalle)
 cross join (values (1, 'M4'), (2, 'M4 URBANA'), (3, 'M4-R2'),
                    (4, 'M5'), (5, 'M5 OXXO')) as m(orden, mueble)
 where not exists (
         select 1
           from public.catalogo_incidencias c
          where lower(btrim(c.unidad_negocio)) = 'biobox'
            and lower(btrim(c.tipo_mueble)) = lower(m.mueble)
            and lower(btrim(c.detalle)) = lower(n.detalle)
       );
