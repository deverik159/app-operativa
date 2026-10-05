-- ============================================================
-- diagnostico_rutas.sql — SOLO LECTURA (no cambia nada)
--
-- Para diseñar el armado de rutas desde el inventario y la dirección
-- corregida en campo (Erik, 5-oct-2026). Saca lo que NO está en el repo
-- (las funciones y vistas de rutas se crearon con .sql que nunca entraron a
-- git) y los valores reales del inventario para distinguir pantallas,
-- Biobox, columnas y pórticos.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar COMPLETO → Run.
-- Sale UNA tabla (seccion, nombre, detalle). Como trae el código completo
-- de varias funciones, no la copies a mano: usa el botón de exportar del
-- resultado → "Download CSV" (o "Copy as JSON") y pásame el archivo.
-- ============================================================

with
-- 1. Código de las funciones de rutas (y de la carga nocturna de QTM, para
--    confirmar si reemplaza el inventario completo).
funciones as (
  select 'funcion'::text as seccion,
         (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')::text as nombre,
         pg_get_functiondef(p.oid)::text as detalle
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname in ('importar_rutas', 'importar_rutas_capas', 'ruta_ubic_valida_segmento',
                       'ordenar_ruta_por_cercania', 'ordenar_rutas_unidad',
                       'sincronizar_rutas_desde_pauta', 'reemplazar_inventario')
),
-- 2. Vistas que alimentan Rutas, Pauta y Biobox (ahí iría la dirección corregida).
vistas as (
  select 'vista'::text, c.relname::text, pg_get_viewdef(c.oid, true)::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('v', 'm')
     and c.relname in ('vw_rutas_con_coords', 'vw_rutas_resumen', 'vw_pauta_ruta', 'vw_revision_ubicaciones')
),
-- 3. Triggers y políticas de las tablas de rutas.
disparadores as (
  select 'trigger'::text, (t.tgrelid::regclass::text || '.' || t.tgname)::text, pg_get_triggerdef(t.oid)::text
    from pg_trigger t
   where not t.tgisinternal
     and t.tgrelid::regclass::text in ('ruta_ubicaciones', 'rutas_monitoreo', 'ruta_asignaciones')
),
politicas as (
  select 'politica'::text, (tablename || '.' || policyname)::text,
         (cmd || ' | using: ' || coalesce(qual, '') || ' | check: ' || coalesce(with_check, ''))::text
    from pg_policies
   where schemaname = 'public'
     and tablename in ('rutas_monitoreo', 'ruta_ubicaciones', 'ruta_asignaciones')
),
-- 4. Cómo se reparte el inventario: con esto se decide qué es "pantalla",
--    "Biobox", "columna" y "pórtico" en el armado de rutas.
categorias as (
  select 'inventario'::text,
         (unidad_negocio || ' | medio: ' || coalesce(tipo_medio, '∅') || ' | mueble: ' ||
          coalesce(tipo_mueble, '∅') || ' | categoría: ' || coalesce(categoria, '∅'))::text,
         (count(*) || ' caras, ' || count(distinct site_id) || ' sitios, ' ||
          count(*) filter (where latitud is null or longitud is null
                              or latitud::text in ('0', '') or longitud::text in ('0', '')) ||
          ' caras sin coordenadas, ' ||
          count(*) filter (where coalesce(trim(direccion), '') = '') || ' caras sin dirección')::text
    from inventario
   group by unidad_negocio, tipo_medio, tipo_mueble, categoria
),
-- 5. Vía Verde sitio por sitio (columnas y pórticos van juntos en la misma
--    ruta: hay que ver si comparten tipo de medio).
via_verde as (
  select 'via_verde'::text, site_id::text,
         (string_agg(distinct coalesce(tipo_medio, '∅') || ' / ' || coalesce(tipo_mueble, '∅') ||
                     ' / ' || coalesce(categoria, '∅'), '; ') ||
          ' | ' || count(*) || ' caras | ' || coalesce(max(direccion), '(sin dirección)'))::text
    from inventario
   where unidad_negocio ilike 'v_a verde'
   group by site_id
),
-- 6. Rutas que ya existen por unidad y medio, y cuántas paradas no traen
--    dirección del archivo (las de Biobox salen "(sin dirección)").
rutas as (
  select 'rutas'::text, (r.unidad_negocio || ' | ' || r.tipo_medio)::text,
         (count(distinct r.id) || ' rutas, ' || count(u.id) || ' paradas, ' ||
          count(u.id) filter (where coalesce(trim(u.direccion_archivo), '') = '') ||
          ' paradas sin dirección de archivo, ' || count(distinct r.nombre) || ' nombres distintos')::text
    from rutas_monitoreo r
    left join ruta_ubicaciones u on u.ruta_id = r.id
   group by r.unidad_negocio, r.tipo_medio
),
-- 7. Asignaciones de monitoristas por unidad.
asignaciones as (
  select 'asignaciones'::text, (r.unidad_negocio || ' | ' || r.tipo_medio)::text,
         (count(a.id) || ' asignaciones en ' || count(distinct a.ruta_id) || ' rutas')::text
    from ruta_asignaciones a
    join rutas_monitoreo r on r.id = a.ruta_id
   group by r.unidad_negocio, r.tipo_medio
)
select * from funciones
union all select * from vistas
union all select * from disparadores
union all select * from politicas
union all select * from categorias
union all select * from via_verde
union all select * from rutas
union all select * from asignaciones
order by 1, 2;
