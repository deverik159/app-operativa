-- ============================================================
-- verificar_biobox.sql
-- Solo LECTURA. Comprueba que revisiones_schema.sql e
-- importar_rutas_capas.sql quedaron bien aplicados.
--
-- Vale la pena correrlo antes de importar el mapa: un archivo que se aplicó a
-- medias no avisa, y el síntoma aparece después, en la app, como un error
-- raro a media importación.
--
-- Cada bloque dice qué debe salir. Si algo no cuadra, vuelve a correr el SQL
-- correspondiente: los dos son idempotentes, se pueden repetir sin daño.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Las cinco tablas nuevas
-- ------------------------------------------------------------
-- Esperado: 5 filas, todas con rls = true.
select c.relname as tabla, c.relrowsecurity as rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'checklist_plantillas', 'checklist_puntos',
    'revisiones', 'revision_respuestas', 'revision_evidencias'
  )
order by c.relname;


-- ------------------------------------------------------------
-- 2. Las políticas de RLS
-- ------------------------------------------------------------
-- Esperado: al menos una por tabla, y en revision_respuestas deben verse
-- rev_resp_ins, rev_resp_sel y rev_resp_upd.
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'checklist_plantillas', 'checklist_puntos',
    'revisiones', 'revision_respuestas', 'revision_evidencias'
  )
order by tablename, policyname;


-- ------------------------------------------------------------
-- 3. El permiso acotado por columna en revision_respuestas
-- ------------------------------------------------------------
-- Esperado: UNA sola fila, `incidencia_record_id`.
--
-- Si salen varias columnas, el `revoke update` no corrió y cualquier sesión
-- puede reescribir una anomalía vieja. Si no sale ninguna, no se podrá sellar
-- la respuesta con su incidencia.
select column_name, privilege_type
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'revision_respuestas'
  and grantee = 'authenticated'
  and privilege_type = 'UPDATE'
order by column_name;


-- ------------------------------------------------------------
-- 4. La vista, con sus DOS campos de tipo de medio
-- ------------------------------------------------------------
-- Esperado: `tipo_medio` (el de la ruta) Y `medio` (el de la máquina).
-- Si falta `medio`, la app no sabrá qué checklist usar.
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'vw_revision_ubicaciones'
  and column_name in ('tipo_medio', 'medio', 'dias_sin_revision', 'navegable')
order by column_name;

-- Debe devolver 0 mientras no se importe el mapa. Que NO truene ya es
-- la comprobación: significa que la vista resuelve sus joins.
select count(*) as ubicaciones_biobox
from vw_revision_ubicaciones
where unidad_negocio = 'Biobox';


-- ------------------------------------------------------------
-- 5. Las funciones, y que no haya firmas duplicadas
-- ------------------------------------------------------------
-- Esperado:
--   guardar_revision(jsonb, jsonb)
--   importar_rutas_capas(text, jsonb, boolean, text[])   ← UNA sola
--
-- Si `importar_rutas_capas` sale DOS veces (una con `text, text, jsonb…`),
-- quedó la firma vieja y PostgREST no sabrá cuál llamar: responde
-- 300 Multiple Choices y la importación falla sin explicar por qué.
-- Se arregla corriendo otra vez importar_rutas_capas.sql completo.
select p.proname,
       pg_get_function_identity_arguments(p.oid) as argumentos
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('guardar_revision', 'importar_rutas_capas')
order by p.proname, argumentos;


-- ------------------------------------------------------------
-- 6. Los dos checklists sembrados
-- ------------------------------------------------------------
-- Esperado: 'Revisión de máquina impresa' con 17 puntos y
--           'Revisión de máquina digital' con 20.
select pl.id,
       pl.nombre,
       pl.tipo_medio,
       pl.activa,
       count(cp.id) filter (where cp.activo) as puntos_activos
from checklist_plantillas pl
left join checklist_puntos cp on cp.plantilla_id = pl.id
where pl.unidad_negocio = 'Biobox'
group by pl.id, pl.nombre, pl.tipo_medio, pl.activa
order by pl.tipo_medio;

-- El detalle, por si quieres revisarlos de una vez.
select pl.tipo_medio, cp.grupo, cp.orden, cp.texto, cp.critico,
       cp.incidencia_sugerida
from checklist_puntos cp
join checklist_plantillas pl on pl.id = cp.plantilla_id
where pl.unidad_negocio = 'Biobox' and cp.activo
order by pl.tipo_medio, cp.orden;


-- ------------------------------------------------------------
-- 7. Bucket de Storage
-- ------------------------------------------------------------
-- Las fotos de la revisión van al mismo bucket `evidencias` que ya usan
-- Incidencias y Pauta, en la subcarpeta `revisiones/`. Esperado: 1 fila.
select id, name, public
from storage.buckets
where id = 'evidencias';
