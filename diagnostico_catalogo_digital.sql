-- ============================================================
-- diagnostico_catalogo_digital.sql — ¿por qué el desplegable digital
-- no enseña lo que debería?
-- Correr en Supabase → SQL Editor y pegar los resultados. Solo lectura.
--
-- LO QUE LA APP HACE HOY (para validar contra estos datos):
--   1. Pide catalogo_incidencias con unidad_negocio = la unidad elegida
--      (ilike exacto: ignora mayúsculas pero NO acentos ni texto extra).
--   2. De ahí toma las filas con area = 'Digital' (trim + minúsculas).
--   3. Las une con arbol_digital.incidencia (completo, sin filtro).
-- Si un valor de la base no empata con esas reglas, la fila no sale.
-- ============================================================

-- 1) ¿Cómo están escritas las unidades en el catálogo, y cuántas filas
--    tiene cada una? (aquí se ve si dice 'Vía Verde', 'Via Verde', 'VV'…)
select coalesce(unidad_negocio, '(null)') as unidad, count(*) as filas
from catalogo_incidencias
group by 1
order by 2 desc;

-- 2) ¿Cómo están escritas las áreas? (aquí se ve si es 'Digital',
--    'DIGITAL', 'Digital ' con espacio, 'SRD'…)
select coalesce(area, '(null)') as area, count(*) as filas
from catalogo_incidencias
group by 1
order by 2 desc;

-- 3) Las filas DIGITALES por unidad, como las buscaría la app.
select unidad_negocio, area, tipo_mueble, detalle
from catalogo_incidencias
where trim(lower(area)) = 'digital'
order by unidad_negocio, detalle;

-- 4) Las últimas filas dadas de alta (los ids son secuenciales): aquí
--    debe aparecer la incidencia nueva, con su unidad y área EXACTAS.
select id, detalle, area, unidad_negocio, tipo_mueble
from catalogo_incidencias
order by id desc
limit 15;

-- 5) El árbol de Digital: qué columnas tiene (¿trae unidad de negocio?)
--    y cuántas filas son.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'arbol_digital'
order by ordinal_position;

select count(*) as filas_arbol from arbol_digital;
