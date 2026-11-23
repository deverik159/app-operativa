-- ============================================================
-- 23-nov-2026 · Incidencias · Catálogo
-- Qué: una falla nueva de Op. Bio Box en el catálogo de BioBox (México),
--      una fila por mueble (M4, M4 URBANA, M4-R2, M5, M5 OXXO):
--        · «Falla física en proceso de reciclaje»
--      Datos de Erik (23-nov-2026), con los nombres de columna de la tabla:
--        origen = Externo · tipo = Imponderable · afectacion = Usuario ·
--        impacto = Alto · area = Op. Bio Box · area_resp_code = OPB ·
--        sla = null.
--      Unidad escrita «BioBox» y código OPB, como «Recolección de reciclaje»
--      (la app busca la unidad con ilike).
-- Por qué: Erik la pidió para reportar en Biobox la parte física del
--      reciclaje, que atiende Op. Bio Box. «Falla en el proceso de
--      reciclaje» (Digital) no cambia, ni las palabras de la app Biobox ni
--      el checklist, que siguen apuntando a esa. No se agrega a BioBox Perú
--      (no se pidió).
-- Efectos: solo agrega 5 filas; nada existente cambia.
-- Re-ejecutable: cada fila entra solo si no existe ya la misma
--      unidad + mueble + falla. `id` no tiene secuencia: se numera después
--      del máximo actual.
-- ============================================================

insert into public.catalogo_incidencias
  (id, unidad_negocio, tipo_mueble, origen, tipo, detalle, afectacion,
   area, impacto, sla, area_resp_code)
select (select coalesce(max(id), 0) from public.catalogo_incidencias)
         + row_number() over (order by m.orden),
       'BioBox', m.mueble, 'Externo', 'Imponderable',
       'Falla física en proceso de reciclaje', 'Usuario',
       'Op. Bio Box', 'Alto', null, 'OPB'
  from (values (1, 'M4'), (2, 'M4 URBANA'), (3, 'M4-R2'),
               (4, 'M5'), (5, 'M5 OXXO')) as m(orden, mueble)
 where not exists (
         select 1
           from public.catalogo_incidencias c
          where lower(btrim(c.unidad_negocio)) = 'biobox'
            and lower(btrim(c.tipo_mueble)) = lower(m.mueble)
            and lower(btrim(c.detalle)) = 'falla física en proceso de reciclaje'
       );
