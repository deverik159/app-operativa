-- ============================================================
-- limpiar_todo.sql — BORRAR TODOS LOS DATOS DE PRUEBA para arrancar el
-- piloto con datos reales (Erik, 27-sep-2026; reemplaza la versión del
-- 31-ago). Sin fecha de corte: vacía TODO lo operativo que exista al
-- correrlo. Se corre en Supabase → SQL Editor, por pasos.
--
-- SE BORRA:
--   · incidencias con evidencias, reasignaciones y notificaciones
--   · chat: mensajes, adjuntos y lecturas (el "visto")
--   · revisiones de Biobox con respuestas y evidencias
--   · avance de pauta: tomas/comprobaciones y sus fotos
--   · bitácora VV: campañas, versiones de pauta, artes e historial
--   · asignaciones de rutas a monitoristas
--   · errores de la app registrados en pruebas
--   · los folios vuelven a empezar en 00001 (folio_counters)
--   · los archivos de todo lo anterior en Storage
--
-- NO SE TOCA: inventario (ni su historial de estatus), catalogo_incidencias,
-- arbol_digital, usuarios, usuario_roles, tecnicos, sla_*, rutas_monitoreo
-- y sus ubicaciones, checklists y sus causas, catorcenas,
-- nombres_pantallas, PAUTA IMPORTADA (pautas, qtm_pautas), vv_espacios,
-- push_suscripciones, las tablas heredadas sin uso, la base de Mario
-- (externo.*) ni sus fotos en Storage (carpeta fijacion-externa/).
--
-- POR QUÉ TRUNCATE Y NO DELETE (cambio contra la versión del 31-ago):
--   · no dispara triggers por fila: borrar ruta_asignaciones con DELETE
--     manda un push "Se te retiró la ruta" a cada monitorista, y borrar la
--     bitácora VV con DELETE truena (vv_log_pauta escribe historial de una
--     campaña que se está borrando);
--   · es instantáneo y no deja filas muertas que limpiar;
--   · va SIN cascade: si alguna tabla que se conserva apuntara con llave
--     foránea a una de las que se vacían, truena y no borra NADA (el PASO 1
--     lo avisa antes, sección 4).
--   · NO reinicia los ids internos (sí los folios): una pestaña vieja que
--     quedara abierta en una PC escribe por id, y con ids reiniciados
--     tocaría filas reales con el mismo número (revisión, 27-sep-2026).
--
-- ANTES DE EMPEZAR (una hora antes, a hora muerta):
--   1) En CADA equipo donde se probó: se abre la app CON SEÑAL con CADA
--      cuenta que capturó ahí, y en cada navegador o app instalada donde se
--      usó (en iPhone, Safari y la app de inicio guardan aparte). Se espera
--      a que se vaya el aviso de envíos pendientes (o Reintentar) y lo que
--      no salga se quita con Descartar. Un reporte de prueba que se quede
--      en una cola se manda solo DESPUÉS de limpiar y revive con folio y
--      push reales. Cerrar sesión NO basta: la cola espera a su cuenta. Un
--      equipo que no se pueda revisar: borrar los datos del sitio o
--      reinstalar la app.
--   2) Nadie captura, valida ni repara hasta el aviso de "listo". Se cierra
--      la app en los teléfonos (quitarla de recientes) y se cierran o
--      recargan TODAS las pestañas abiertas en PC (Comercial, coordinadores,
--      validadores): Bitácora VV y Pauta no se recargan solas.
--
-- LOS PASOS:
--   1) PASO 1 solo (lectura). Revisa: eso y nada más se borrará.
--   2) PASO 2: en su candado cambia 'NO' por 'BORRAR AAAA-MM-DD' con la
--      fecha de HOY (hora de México) y córrelo completo. Es UNA
--      transacción: o entra todo, o nada. El candado caduca solo: al día
--      siguiente ese texto ya no abre, aunque el SQL Editor lo guarde.
--   3) node scripts/limpiar-storage.mjs  (borra los archivos; ver abajo)
--   4) PASO 4 (lectura): todo debe quedar en cero.
--   5) PASO 5: tira la tabla puente. Luego regresa el candado a 'NO' o
--      borra este snippet del SQL Editor.
--   6) Después: cada tester abre la app con señal, toca ↻ en Incidencias
--      (debe verse vacía y sin aviso de copia) y, si Nueva ofrece
--      Recuperar un borrador, toca Descartar. Los primeros días, correr
--      revisar_tras_limpieza.sql (aparte, para no reabrir este archivo).
-- ============================================================


-- ══════════ PASO 1 — DIAGNÓSTICO (solo lectura, corre esto primero) ══════════
-- Secciones: 1 se borra · 2 no se toca · 3 Storage · 4 candado de llaves
-- (debe salir VACÍA; si sale algo, detente y revísalo) · 5 triggers de
-- TRUNCATE (informativo) · 6 folios actuales.
with
se_borra(orden, tabla) as (values
  (1, 'incidencias'), (2, 'evidencias'), (3, 'reasignaciones'), (4, 'notificaciones'),
  (5, 'mensajes'), (6, 'chat_adjuntos'), (7, 'chat_lecturas'),
  (8, 'revisiones'), (9, 'revision_respuestas'), (10, 'revision_evidencias'),
  (11, 'pauta_monitoreo'), (12, 'pauta_evidencias'),
  (13, 'vv_campanas'), (14, 'vv_pautas'), (15, 'vv_artes'), (16, 'vv_pauta_historial'),
  (17, 'ruta_asignaciones'), (18, 'errores_cliente')
),
se_queda(orden, tabla) as (values
  (1, 'inventario'), (2, 'inventario_estatus_historial'), (3, 'catalogo_incidencias'),
  (4, 'arbol_digital'), (5, 'usuarios'), (6, 'usuario_roles'), (7, 'tecnicos'),
  (8, 'rutas_monitoreo'), (9, 'ruta_ubicaciones'), (10, 'checklist_plantillas'),
  (11, 'checklist_puntos'), (12, 'checklist_causas'), (13, 'catorcenas'),
  (14, 'nombres_pantallas'), (15, 'pautas'), (16, 'qtm_pautas'), (17, 'vv_espacios'),
  (18, 'sla_areas'), (19, 'sla_validacion'), (20, 'push_suscripciones')
),
rel_borra as (
  select to_regclass('public.' || tabla) as rel from se_borra
  where to_regclass('public.' || tabla) is not null
)
select seccion, que, cuantas, nota from (

  -- 1 · Lo que se borra
  select '1 · SE BORRA' as seccion, b.orden as o, b.tabla as que,
         case when to_regclass('public.' || b.tabla) is null then '(no existe)'
              else (xpath('/row/c/text()', query_to_xml(
                     format('select count(*) as c from public.%I', b.tabla), false, true, '')))[1]::text
         end as cuantas,
         '' as nota
  from se_borra b

  union all
  -- 2 · Lo que NO se toca (referencia: debe quedar igual al terminar)
  select '2 · NO SE TOCA', q.orden, q.tabla,
         case when to_regclass('public.' || q.tabla) is null then '(no existe)'
              else (xpath('/row/c/text()', query_to_xml(
                     format('select count(*) as c from public.%I', q.tabla), false, true, '')))[1]::text
         end,
         ''
  from se_queda q

  union all
  -- 3 · Archivos de Storage por carpeta
  select '3 · STORAGE', 0,
         g.grupo, g.n::text,
         g.tamano || case when g.grupo like '%NO se toca%' then '' else ' · se borra' end
  from (
    select case
             when bucket_id <> 'evidencias' then 'otro bucket: ' || bucket_id || ' (NO se toca)'
             when name like 'fijacion-externa/%' then 'fijación externa, de Mario (NO se toca)'
             when name like 'bitacora-vv/%' then 'artes de la bitácora VV'
             when name like 'chat/%' then 'adjuntos del chat'
             when name like 'revisiones/%' then 'revisiones de Biobox'
             when name like 'pauta/%' then 'fotos de tomas de pauta'
             when name like '%/%' then 'incidencias (carpeta por record_id)'
             else 'sueltos en la raíz del bucket'
           end as grupo,
           count(*) as n,
           pg_size_pretty(sum(coalesce((metadata ->> 'size')::bigint, 0))) as tamano
    from storage.objects
    group by 1
  ) g

  union all
  -- 4 · Candado de llaves: tablas que se CONSERVAN y apuntan a una que se
  --     vacía. Debe salir vacía. Si sale algo, el PASO 2 truena sin borrar
  --     nada: detente y avísame.
  select '4 · CANDADO (debe salir vacía)', 0,
         c.conrelid::regclass::text || ' → ' || c.confrelid::regclass::text,
         c.conname,
         'Esta tabla se conserva y apunta a una que se vacía'
  from pg_constraint c
  where c.contype = 'f'
    and c.confrelid in (select rel from rel_borra)
    and c.conrelid not in (select rel from rel_borra)

  union all
  -- 5 · Triggers de TRUNCATE en las tablas que se vacían (lo normal: ninguno)
  select '5 · TRIGGERS DE TRUNCATE', 0,
         t.tgrelid::regclass::text || '.' || t.tgname,
         '', pg_get_triggerdef(t.oid)
  from pg_trigger t
  where not t.tgisinternal
    and (t.tgtype & 32) <> 0
    and t.tgrelid in (select rel from rel_borra)

  union all
  -- 6 · Folios: el próximo de cada prefijo (tras la limpieza, todos en 1)
  select '6 · FOLIOS', 0,
         'folio_counters',
         case when to_regclass('public.folio_counters') is null then '(no existe)'
              else coalesce((xpath('/row/v/text()', query_to_xml(
                     'select string_agg(prefijo || ''='' || next_seq, '', '' order by prefijo) as v
                        from public.folio_counters', false, true, '')))[1]::text, '(vacía)')
         end,
         'prefijo = siguiente número'

) r
order by seccion, o, que;


-- ══════════ PASO 2 — BORRADO (una transacción: o entra todo, o nada) ══════════
-- ⚠ CANDADO: para que corra, en la línea de set_config de abajo cambia
-- 'NO' por 'BORRAR AAAA-MM-DD' con la fecha de HOY en México (p. ej.
-- 'BORRAR 2026-09-27'). Darle "Run" a todo el archivo por error no borra
-- nada, y un snippet guardado con la fecha de ayer tampoco.
begin;

select set_config('gpo.confirmo_limpieza', 'NO', true);

do $$
declare
  esperado text := 'BORRAR ' || to_char(now() at time zone 'America/Mexico_City', 'YYYY-MM-DD');
begin
  if current_setting('gpo.confirmo_limpieza', true) is distinct from esperado then
    raise exception 'Candado puesto: revisa el PASO 1 y, en el PASO 2, cambia ''NO'' por ''%'' (la fecha de HOY). No se borró nada.', esperado;
  end if;
end $$;

-- Si alguien está usando la app, no se espera a que suelte: se cancela y
-- se vuelve a correr en un momento.
set local lock_timeout = '5s';

-- Tabla puente para el script de Storage (el SQL no puede borrar archivos:
-- trigger protect_delete). Todo el bucket MENOS las fotos de fijación
-- externa, que son de la base de Mario: ningún catálogo guarda archivos, y
-- las miniaturas mini/ y las fotos de reasignación (que solo guardan la
-- URL) caen solas por carpeta. Es tabla real y no temporal porque la lee el
-- script en otra sesión; con RLS y sin políticas nadie la ve desde la app.
drop table if exists public._limpieza_paths;
create table public._limpieza_paths (path text primary key);
insert into public._limpieza_paths (path)
select o.name
from storage.objects o
where o.bucket_id = 'evidencias'
  and o.name not like 'fijacion-externa/%';
alter table public._limpieza_paths enable row level security;
revoke all on public._limpieza_paths from anon, authenticated;

-- Vaciado: un solo TRUNCATE con todas las tablas que existan, SIN cascade.
do $$
declare
  lista text;
begin
  select string_agg(format('public.%I', t), ', ')
    into lista
  from unnest(array[
    'incidencias', 'evidencias', 'reasignaciones', 'notificaciones',
    'mensajes', 'chat_adjuntos', 'chat_lecturas',
    'revisiones', 'revision_respuestas', 'revision_evidencias',
    'pauta_monitoreo', 'pauta_evidencias',
    'vv_campanas', 'vv_pautas', 'vv_artes', 'vv_pauta_historial',
    'ruta_asignaciones', 'errores_cliente'
  ]) as t
  where to_regclass('public.' || t) is not null;

  if lista is null then
    raise exception 'No encontré ninguna de las tablas a vaciar: ¿es el proyecto correcto?';
  end if;
  execute 'truncate table ' || lista;
end $$;

-- Folios desde 00001 en todos los prefijos (EV, EVD, VV, BBM…): set_folio
-- toma el número de aquí.
do $$
begin
  if to_regclass('public.folio_counters') is not null then
    update public.folio_counters set next_seq = 1;
  end if;
end $$;

-- La hora de la limpieza queda en la base: revisar_tras_limpieza.sql la
-- lee sola para cazar reportes de prueba que revivan de alguna cola.
do $$
begin
  if to_regclass('public.app_config') is not null then
    insert into public.app_config (clave, valor, nota)
    values ('limpieza_piloto', now()::text,
            'Hora de limpiar_todo.sql: lo reportado antes es de prueba (revisar_tras_limpieza.sql).')
    on conflict (clave) do update set valor = excluded.valor, actualizado_en = now();
  end if;
end $$;

commit;

-- Que PostgREST vea la tabla puente nueva (la lee el script).
notify pgrst, 'reload schema';

select to_char(now() at time zone 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') as hora_de_la_limpieza_mexico,
       (select count(*) from public._limpieza_paths) as archivos_para_el_script;


-- ══════════ PASO 3 — ARCHIVOS DE STORAGE (en tu terminal) ══════════
-- Desde la carpeta del proyecto (instrucciones y candado dentro del script):
--   node scripts/limpiar-storage.mjs


-- ══════════ PASO 4 — VERIFICAR (solo lectura, después del script) ══════════
-- Todo debe dar 0 salvo lo marcado.
--   · Si solo "archivos que quedan" y "pendientes en la tabla puente" no
--     dan 0: vuelve a correr el script (retoma donde iba).
--   · Si alguna tabla o "archivos que quedan" no da 0 pero la tabla puente
--     sí: alguien mandó algo durante la limpieza. HOY mismo, antes del
--     "listo", vuelve a correr el PASO 2 completo y luego el script.
select que, cuantas, debe from (
  select 1 as o, t as que,
         case when to_regclass('public.' || t) is null then '(no existe)'
              else (xpath('/row/c/text()', query_to_xml(
                     format('select count(*) as c from public.%I', t), false, true, '')))[1]::text
         end as cuantas,
         '0' as debe
  from unnest(array[
    'incidencias', 'evidencias', 'reasignaciones', 'notificaciones',
    'mensajes', 'chat_adjuntos', 'chat_lecturas',
    'revisiones', 'revision_respuestas', 'revision_evidencias',
    'pauta_monitoreo', 'pauta_evidencias',
    'vv_campanas', 'vv_pautas', 'vv_artes', 'vv_pauta_historial',
    'ruta_asignaciones', 'errores_cliente'
  ]) as t
  union all
  select 2, 'folios que no están en 1',
         case when to_regclass('public.folio_counters') is null then '(no existe)'
              else (xpath('/row/c/text()', query_to_xml(
                     'select count(*) as c from public.folio_counters where next_seq <> 1',
                     false, true, '')))[1]::text
         end,
         '0'
  union all
  select 3, 'archivos que quedan en evidencias (sin fijación externa)',
         count(*)::text, '0'
  from storage.objects
  where bucket_id = 'evidencias' and name not like 'fijacion-externa/%'
  union all
  select 4, 'pendientes en la tabla puente',
         case when to_regclass('public._limpieza_paths') is null then '(ya no existe)'
              else (xpath('/row/c/text()', query_to_xml(
                     'select count(*) as c from public._limpieza_paths', false, true, '')))[1]::text
         end,
         '0'
  union all
  select 5, 'fotos de fijación externa (de Mario)', count(*)::text, 'igual que en el PASO 1'
  from storage.objects
  where bucket_id = 'evidencias' and name like 'fijacion-externa/%'
) v
order by o, que;


-- ══════════ PASO 5 — TIRAR LA TABLA PUENTE (cuando el PASO 4 salga bien) ══════════
-- No la tira si aún quedan archivos pendientes: sin ella el script ya no
-- sabría qué borrar. Después regresa el candado del PASO 2 a 'NO' o borra
-- este snippet del SQL Editor.
do $$
begin
  if to_regclass('public._limpieza_paths') is not null
     and exists (select 1 from public._limpieza_paths) then
    raise exception 'Aún hay archivos pendientes: corre node scripts/limpiar-storage.mjs antes de tirar la tabla puente.';
  end if;
  drop table if exists public._limpieza_paths;
end $$;

-- Los primeros días del piloto: revisar_tras_limpieza.sql (archivo aparte).
