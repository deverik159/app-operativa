-- ============================================================
-- diagnostico_fijacion_externa.sql — radiografía de la tabla de Mario
-- Correr en Supabase → SQL Editor, paso por paso. SOLO LECTURA.
--
-- PARA QUÉ (Erik, sep-2026): rediseñar la tarjeta del módulo de
-- Fijación Externa. Hay que ver qué columnas trae la tabla importada
-- (externo.fijacion, vía postgres_fdw desde el AppSheet de Mario),
-- qué expone la vista vw_fijacion_externa, y con qué valores vienen —
-- porque el editor de Supabase enseña la vista "sin datos" y el módulo
-- sí pinta registros: casi seguro la vista filtra por auth.email()
-- (en el SQL Editor no hay sesión, así que el filtro deja todo fuera).
-- El PASO 4 lo confirma.
-- ============================================================

-- PASO 1 — Columnas REALES de la tabla externa (tipo por tipo).
-- Esto es la fuente de verdad de "qué datos tenemos de Mario".
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'externo' and table_name = 'fijacion'
order by ordinal_position;

-- PASO 2 — Definición de la vista: qué columnas expone, de dónde las
-- saca, y QUÉ FILTRA (aquí se ve si usa auth.email()/auth.jwt()).
select pg_get_viewdef('public.vw_fijacion_externa'::regclass, true);

-- PASO 3 — El servidor FDW y sus opciones (solo para tener el mapa
-- completo de la integración; no cambia nada).
select srvname, srvoptions from pg_foreign_server;

-- PASO 4 — Conteos DIRECTOS contra la tabla externa (el SQL Editor corre
-- como postgres y el FDW sí responde; si esto trae filas y el select a la
-- vista no, queda demostrado que el "sin datos" es el filtro por sesión).
select count(*) as total_tabla_externa from externo.fijacion;
select count(*) as total_vista from public.vw_fijacion_externa;

-- PASO 5 — Muestra cruda de la tabla externa: 15 filas completas.
-- De aquí sale la decisión de qué mostrar en la tarjeta nueva.
select * from externo.fijacion limit 15;

-- PASO 6 — Valores con los que vienen los campos "de catálogo": cuántos
-- distintos hay y cuáles son. Un campo con 2 valores es una pill; uno
-- con 400 es texto. (Si alguna columna no existe, borra esa línea —
-- los nombres exactos los dio el PASO 1.)
select 'estado' as campo, estado::text as valor, count(*) as n
  from externo.fijacion group by estado
union all
select 'producto', producto::text, count(*)
  from externo.fijacion group by producto
union all
select 'catorcena', catorcena::text, count(*)
  from externo.fijacion group by catorcena
union all
select 'zona', zona::text, count(*)
  from externo.fijacion group by zona
order by campo, n desc;

-- PASO 7 — Cuadrillas: cómo vienen armadas en la base de Mario.
-- Importa para separar las órdenes de trabajo por cuadrilla.
select responsable_de_cuadrilla,
       operadores_cuadrilla,
       count(*) as registros,
       count(*) filter (where estado = 'PENDIENTE') as pendientes
from externo.fijacion
group by responsable_de_cuadrilla, operadores_cuadrilla
order by registros desc
limit 30;

-- PASO 8 — Qué tan llenos vienen los campos (un campo 95% vacío no
-- merece lugar en la tarjeta). Ajusta nombres según el PASO 1.
select
  count(*) as total,
  count(campana)   as con_campana,
  count(version)   as con_version,
  count(producto)  as con_producto,
  count(zona)      as con_zona,
  count(municipio) as con_municipio,
  count(direccion) as con_direccion,
  count(catorcena) as con_catorcena
from externo.fijacion;
