-- ============================================================
-- primer_mes.sql — lo de base de datos del bloque "primer mes" de la
-- auditoría para abrir a 300 usuarios (24-sep-2026).
--
-- Correr COMPLETO en Supabase → SQL Editor. Es re-ejecutable: todo usa
-- create or replace / revoke / grant.
--
-- Lo que hace, por pasos:
--   1. fotos_tarjetas(): la foto de cada tarjeta de Incidencias, por
--      record_id, en UNA llamada que devuelve un jsonb.
--   2. Permisos: solo sesiones reales (authenticated) y el servidor.
--   3. Verificación.
--
-- POR QUÉ: las fotos de tarjeta salían de UNA consulta global a evidencias
-- con .limit(3000). Con volumen, las 3000 fotos más recientes se las comían
-- las incidencias nuevas y las tarjetas viejas se quedaban sin foto, sin
-- aviso. Ahora la app manda los record_id que tiene cargados (en lotes de
-- 400) y recibe la foto de cada uno. Devuelve UN jsonb (un escalar), así que
-- el tope de 1000 filas de PostgREST no le aplica.
--
-- Lo que NO toca: ningún dato, ninguna política de RLS, ningún índice. Usa
-- el que ya hay sobre evidencias(record_id) (idx_ev_record, heredado): cada
-- id son dos búsquedas por índice sobre las pocas fotos de esa incidencia.
--
-- ORDEN: se puede correr antes o después de publicar el frontend. Si la app
-- llega primero, cae a la consulta anterior (con aviso en la consola) hasta
-- que esta función exista.
-- ============================================================

set lock_timeout = '5s';


-- ══ PASO 1 — fotos_tarjetas(p_ids) ══
-- Devuelve { "<record_id>": { "reporte": url|null, "reparacion": url|null } }
-- solo para los record_id que tienen al menos una foto; los demás se omiten.
--
-- Semántica (la misma que tenía la app, ajuste de Erik ago-2026):
--   reporte    → la foto (tipo 'foto', etapa 'reporte') MÁS VIEJA: la
--                primera que se subió al reportar.
--   reparacion → la foto (tipo 'foto', etapa 'reparacion') MÁS RECIENTE: el
--                estado final del trabajo.
-- Desempate por id, y las que no traen creado_en van al final, para que el
-- resultado no cambie entre llamadas.
--
-- SECURITY INVOKER a propósito: corre con los permisos de quien la llama, así
-- que la RLS de evidencias le sigue aplicando. No abre nada que el usuario no
-- pudiera leer ya con un select directo.
--
-- Tope defensivo: se atienden a lo más 1000 ids por llamada (la app manda
-- lotes de 400). Es language sql, que no tiene RAISE: el excedente se
-- RECORTA. Solo protege a la base de una llamada abusiva por la API; la app
-- nunca llega ahí.
create or replace function public.fotos_tarjetas(p_ids text[])
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
           jsonb_object_agg(
             t.rid,
             jsonb_build_object('reporte', t.reporte, 'reparacion', t.reparacion)
           ),
           '{}'::jsonb
         )
  from (
    select ids.rid,
           (select e.url
              from public.evidencias e
             where e.record_id = ids.rid
               and e.tipo = 'foto'
               and e.etapa = 'reporte'
             order by e.creado_en asc nulls last, e.id asc
             limit 1) as reporte,
           (select e.url
              from public.evidencias e
             where e.record_id = ids.rid
               and e.tipo = 'foto'
               and e.etapa = 'reparacion'
             order by e.creado_en desc nulls last, e.id desc
             limit 1) as reparacion
      from (select distinct u.rid
              from unnest((p_ids)[1:1000]) as u(rid)
             where u.rid is not null and u.rid <> '') as ids
  ) t
  where t.reporte is not null or t.reparacion is not null
$$;

comment on function public.fotos_tarjetas(text[]) is
  'Fotos de tarjeta de Incidencias por record_id: {rid: {reporte, reparacion}}. '
  'reporte = la más vieja de la etapa reporte; reparacion = la más reciente. '
  'SECURITY INVOKER (aplica la RLS de evidencias). Máx. 1000 ids por llamada. '
  'Ver primer_mes.sql (24-sep-2026).';


-- ══ PASO 2 — Permisos ══
-- Las funciones nuevas ya no reciben EXECUTE para PUBLIC por omisión (se
-- revocó en prelanzamiento_300.sql, paso 4a), así que el grant a
-- authenticated tiene que ser EXPLÍCITO. El revoke va igual, por si esta
-- base se creó antes de ese cambio.
revoke all on function public.fotos_tarjetas(text[]) from public, anon;
grant execute on function public.fotos_tarjetas(text[]) to authenticated, service_role;


-- ══ PASO 3 — Verificar ══
-- UNA sola consulta a propósito: el SQL Editor solo enseña el resultado de
-- la ÚLTIMA sentencia, y verificaciones sueltas se perdían sin verse.
-- Lo esperado:
--   existe = true
--   security_invoker = true   (si sale false, la RLS NO estaría aplicando)
--   volatilidad = "stable"
--   puede_ejecutar = anon false, authenticated true, service_role true
--   prueba_vacia = {}  y  prueba_null = {}
--   prueba_recientes = un objeto con las fotos de hasta 5 incidencias
--     recientes (puede salir {} si ninguna trae foto). Aquí corre como el
--     dueño del SQL Editor, así que ve todo; en la app cada quien ve solo
--     lo que su RLS le deja.
select jsonb_build_object(
  'existe',
    to_regprocedure('public.fotos_tarjetas(text[])') is not null,
  'security_invoker',
    (select not p.prosecdef from pg_proc p
      where p.oid = to_regprocedure('public.fotos_tarjetas(text[])')),
  'volatilidad',
    (select case p.provolatile when 's' then 'stable'
                               when 'i' then 'immutable'
                               else 'volatile' end
       from pg_proc p
      where p.oid = to_regprocedure('public.fotos_tarjetas(text[])')),
  'puede_ejecutar',
    (select jsonb_object_agg(r.rol,
              has_function_privilege(r.rol::name, 'public.fotos_tarjetas(text[])', 'execute'))
       from unnest(array['anon', 'authenticated', 'service_role']) as r(rol)),
  'acl',
    (select to_jsonb(p.proacl::text[]) from pg_proc p
      where p.oid = to_regprocedure('public.fotos_tarjetas(text[])')),
  'prueba_vacia',
    public.fotos_tarjetas('{}'::text[]),
  'prueba_null',
    public.fotos_tarjetas(null),
  'prueba_recientes',
    public.fotos_tarjetas(array(
      select i.record_id::text from public.incidencias i
       order by i.fecha_reporte desc nulls last
       limit 5))
) as verificacion;
