-- ============================================================
-- diagnostico_qtm_campanias.sql — SOLO LECTURA
--
-- Para cargar la campaña pautada en Nueva incidencia (Ecovallas): el
-- desplegable debe ofrecer, POR CARA, la campaña de la catorcena actual
-- y las vecinas (una antes y una después). La fuente es qtm_contratos /
-- qtm_pautas (lo que QTM actualiza), no la tabla `pautas` del Excel.
-- Este script enseña la forma de esas tablas para construir encima.
--
-- Correr en Supabase → SQL Editor y pegar los resultados.
-- ============================================================

-- 1) Columnas de las dos tablas.
select table_name, ordinal_position, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('qtm_pautas', 'qtm_contratos')
order by table_name, ordinal_position;

-- 2) Muestra de qtm_pautas (las más recientes).
select * from public.qtm_pautas
order by 1 desc
limit 8;

-- 3) Muestra de qtm_contratos.
select * from public.qtm_contratos
order by 1 desc
limit 8;

-- 4) ¿Cómo viene la catorcena en qtm_pautas y cuántas filas hay por cada una?
--    (Si la columna no se llama `catorcena`, este paso fallará: dime el
--    nombre real que salga en el paso 1 y lo ajusto.)
select catorcena, count(*) as filas
from public.qtm_pautas
group by catorcena
order by catorcena desc
limit 10;

-- 5) La catorcena de HOY según el calendario, con su anterior y siguiente.
with actual as (
  select numero from public.catorcenas
  where current_date between fecha_inicio::date and fecha_fin::date
  limit 1
)
select c.numero, c.fecha_inicio, c.fecha_fin, c.cat_texto
from public.catorcenas c, actual a
where c.numero between a.numero - 1 and a.numero + 1
order by c.numero;

-- 6) ¿Una cara de Ecovallas con pauta, como ejemplo de punta a punta?
--    (Ajusta el vendor_face_id si quieres ver una cara concreta.)
select p.*
from public.qtm_pautas p
join public.inventario i on i.vendor_face_id = p.vendor_face_id
where i.unidad_negocio = 'Ecovallas'
order by 1 desc
limit 8;

-- 7) RLS de las dos tablas: ¿el rol reportante puede LEERLAS desde la app?
select tablename, policyname, cmd, roles, qual as using_expr
from pg_policies
where schemaname = 'public'
  and tablename in ('qtm_pautas', 'qtm_contratos');

select relname, relrowsecurity as rls_activa
from pg_class
where relname in ('qtm_pautas', 'qtm_contratos');
