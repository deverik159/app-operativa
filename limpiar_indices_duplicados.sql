-- ============================================================
-- limpiar_indices_duplicados.sql — quita índices que se pisan
-- Correr COMPLETO en Supabase → SQL Editor. Re-ejecutable.
--
-- POR QUÉ (24-sep-2026): prelanzamiento_300.sql creó índices con nombres
-- nuevos, y la verificación mostró que la base ya traía índices heredados
-- de la app vieja sobre las mismas columnas (idx_ev_record, idx_inc_estatus,
-- idx_msg_record…). Dos índices iguales no rompen nada, pero cada escritura
-- los mantiene a los dos.
--
-- Decide por la DEFINICIÓN real, no por el nombre, y solo toca pares donde
-- uno de los dos es de prelanzamiento_300.sql:
--   1. Duplicado EXACTO (mismas columnas, operadores, expresión y filtro):
--      se quita el NUEVO y se queda el heredado.
--   2. Heredado REDUNDANTE: sus columnas son el inicio de las de un índice
--      nuevo más completo (p. ej. (record_id) frente a (record_id,
--      creado_en)): se quita el HEREDADO, el nuevo sirve para lo mismo y más.
-- Nunca toca índices únicos, llaves primarias ni los que respaldan una
-- restricción. El resultado dice qué quitó y cómo quedó cada tabla.
-- ============================================================

set lock_timeout = '5s';

create temp table if not exists _indices_quitados (indice text, motivo text);
truncate _indices_quitados;

-- Índices creados por prelanzamiento_300.sql.
create temp table if not exists _indices_nuevos (nombre text primary key);
truncate _indices_nuevos;
insert into _indices_nuevos values
  ('notif_pendientes_idx'), ('notif_record_pend_idx'), ('inc_fecha_reporte_idx'),
  ('inc_estatus_idx'), ('inc_dup_idx'), ('evid_record_idx'), ('evid_tarjetas_idx'),
  ('msg_record_idx'), ('reas_record_idx'), ('reas_solicitadas_idx'),
  ('uroles_email_idx');

-- 1. Duplicados exactos: se quita el nuevo.
do $$
declare r record;
begin
  for r in
    select cn.relname as nuevo, cv.relname as viejo
    from pg_index n
    join pg_class cn on cn.oid = n.indexrelid
    join pg_namespace ns on ns.oid = cn.relnamespace and ns.nspname = 'public'
    join pg_index v on v.indrelid = n.indrelid and v.indexrelid <> n.indexrelid
    join pg_class cv on cv.oid = v.indexrelid
    where cn.relname in (select nombre from _indices_nuevos)
      and cv.relname not in (select nombre from _indices_nuevos)
      and v.indkey::text = n.indkey::text
      and v.indclass::text = n.indclass::text
      and coalesce(pg_get_expr(v.indexprs, v.indrelid), '') =
          coalesce(pg_get_expr(n.indexprs, n.indrelid), '')
      and coalesce(pg_get_expr(v.indpred, v.indrelid), '') =
          coalesce(pg_get_expr(n.indpred, n.indrelid), '')
      and not n.indisunique and not n.indisprimary
  loop
    execute format('drop index if exists public.%I', r.nuevo);
    insert into _indices_quitados values (r.nuevo, 'duplicado exacto de ' || r.viejo);
  end loop;
end $$;

-- 2. Heredados redundantes: sus columnas son el inicio de un índice nuevo.
-- Solo índices simples (sin expresiones ni filtro) y que no respalden nada.
do $$
declare r record;
begin
  for r in
    select distinct cv.relname as viejo, cn.relname as nuevo
    from pg_index n
    join pg_class cn on cn.oid = n.indexrelid
    join pg_namespace ns on ns.oid = cn.relnamespace and ns.nspname = 'public'
    join pg_index v on v.indrelid = n.indrelid and v.indexrelid <> n.indexrelid
    join pg_class cv on cv.oid = v.indexrelid
    where cn.relname in (select nombre from _indices_nuevos)
      and cv.relname not in (select nombre from _indices_nuevos)
      and n.indexprs is null and n.indpred is null
      and v.indexprs is null and v.indpred is null
      and not v.indisunique and not v.indisprimary
      and not exists (select 1 from pg_constraint c where c.conindid = v.indexrelid)
      and v.indnatts < n.indnatts
      -- las columnas del viejo son exactamente el inicio de las del nuevo
      and (string_to_array(n.indkey::text, ' '))[1:v.indnatts]
          = string_to_array(v.indkey::text, ' ')
      and (string_to_array(n.indclass::text, ' '))[1:v.indnatts]
          = string_to_array(v.indclass::text, ' ')
  loop
    -- Pudo quitarse ya en otra vuelta (dos nuevos lo cubrían).
    if to_regclass('public.' || quote_ident(r.viejo)) is not null then
      execute format('drop index if exists public.%I', r.viejo);
      insert into _indices_quitados values (r.viejo, 'redundante: lo cubre ' || r.nuevo);
    end if;
  end loop;
end $$;

-- Resultado: qué se quitó y cómo quedaron las tablas.
select jsonb_build_object(
  'quitados',
    (select coalesce(jsonb_agg(indice || ' — ' || motivo), '[]'::jsonb)
       from _indices_quitados),
  'quedan',
    (select coalesce(jsonb_agg(indexdef order by tablename, indexname), '[]'::jsonb)
       from pg_indexes
      where schemaname = 'public'
        and tablename in ('notificaciones', 'incidencias', 'evidencias',
                          'mensajes', 'reasignaciones', 'usuario_roles'))
) as resultado;
