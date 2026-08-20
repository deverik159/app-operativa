-- ============================================================
-- diagnostico_notificaciones.sql
-- Por qué no aparecen notificaciones. Correr en el SQL Editor de Supabase
-- y pegarme los resultados. Todas son SELECT: no modifican nada.
--
-- CLAVE PARA INTERPRETAR: el SQL Editor corre como superusuario y SE SALTA
-- la RLS. La app corre como `authenticated` y SÍ la respeta. Entonces:
--   · Si la query 2 devuelve filas pero la app no muestra nada → es RLS.
--   · Si la query 2 devuelve 0 filas → los triggers no están insertando.
-- Esas son las dos hipótesis y esto las separa.
-- ============================================================


-- 1) Columnas reales de `notificaciones`.
--    El frontend asume: id, evento, record_id, mensaje, unidad_negocio,
--    leida, creado_en. Si hay una columna de destinatario (correo, rol,
--    usuario_email...) que no conozco, aquí sale — y sería la explicación:
--    la RLS filtraría por ella y nadie coincidiría.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'notificaciones'
order by ordinal_position;


-- 2) ¿HAY FILAS? Total y desglose por evento.
--    Esta es la query que parte el diagnóstico en dos.
select evento, count(*) as n,
       min(creado_en) as mas_vieja,
       max(creado_en) as mas_reciente,
       count(*) filter (where not leida) as sin_leer
from notificaciones
group by evento
order by n desc;


-- 3) Las 15 más recientes, completas. Para ver a quién van dirigidas.
select *
from notificaciones
order by creado_en desc
limit 15;


-- 4) ¿Está prendida la RLS en notificaciones?
--    relrowsecurity = true y CERO políticas en la query 5 → nadie ve nada.
--    Ese es el escenario más probable.
select c.relname,
       c.relrowsecurity  as rls_activa,
       c.relforcerowsecurity as rls_forzada
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'notificaciones';


-- 5) Políticas de notificaciones. Si sale vacío y la query 4 dice
--    rls_activa = true, ahí está el problema.
select policyname, cmd, roles, qual as using_expr, with_check
from pg_policies
where schemaname = 'public' and tablename = 'notificaciones';


-- 6) ¿Los triggers están REALMENTE conectados a sus tablas?
--    Que exista la función notificar_incidencia() NO significa que haya un
--    CREATE TRIGGER que la dispare. Esto lista los triggers de verdad.
--    tgenabled: 'O' = habilitado, 'D' = DESHABILITADO.
select t.tgname          as trigger_name,
       c.relname         as tabla,
       p.proname         as funcion,
       t.tgenabled       as habilitado,
       pg_get_triggerdef(t.oid) as definicion
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc  p on p.oid = t.tgfoid
join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal
  and n.nspname = 'public'
order by c.relname, t.tgname;


-- 7) El código de las funciones de notificación.
--    Aquí se ve QUÉ columnas llenan y A QUIÉN dirigen cada notificación.
--    Es lo que me dice si el frontend está leyendo bien la tabla.
select p.proname,
       p.prosrc as codigo
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('notificar_incidencia','notificar_chat','notificar_tecnico',
                    'notificar_reasignacion','notificar_ruta')
order by p.proname;


-- 8) Permisos de tabla (aparte de RLS). Si `authenticated` no tiene SELECT,
--    la RLS ni siquiera llega a evaluarse.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'notificaciones'
order by grantee, privilege_type;
