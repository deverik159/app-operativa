-- ============================================================
-- incidencias_lado_porticos.sql — el CHECK de `lado` aprende los pórticos
-- Correr en Supabase → SQL Editor (Erik, 2-sep-2026).
--
-- POR QUÉ: en Vía Verde hay 4 pórticos (0078, 008, 0092, 015) — pantallas
-- sobre un puente con orientación única, dan a un solo sentido del tráfico.
-- Ahí la "cara afectada" no se pregunta: la app la prellena con la
-- orientación fija del sitio ('Norte a Sur' o 'Sur a Norte'), pero el CHECK
-- actual de incidencias.lado solo acepta Norte/Sur/Ambas o NULL y rechazaría
-- el insert. Este script lo amplía a los cinco valores.
--
-- El mapa sitio → orientación vive en el frontend (PORTICOS_LADO_FIJO en
-- src/lib/constants.ts), igual que UNIDADES_CON_LADO: es decisión de
-- producto, no de esquema.
-- ============================================================

-- PASO 1 — VER el CHECK actual (nombre y definición), para saber qué se toca.
select con.conname, pg_get_constraintdef(con.oid) as definicion
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace ns on ns.oid = rel.relnamespace
where ns.nspname = 'public'
  and rel.relname = 'incidencias'
  and con.contype = 'c'
  and pg_get_constraintdef(con.oid) ilike '%lado%';

-- PASO 2 — REEMPLAZAR: tira el CHECK de `lado` (cualquiera sea su nombre)
-- y pone el nuevo con los cinco valores. Transacción: o entra todo, o nada.
begin;

do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'incidencias'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%lado%'
  loop
    execute format('alter table public.incidencias drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.incidencias
  add constraint incidencias_lado_check
  check (lado is null or lado in
    ('Norte', 'Sur', 'Ambas', 'Norte a Sur', 'Sur a Norte'));

commit;

-- PASO 3 — VERIFICAR: debe salir una sola fila con los cinco valores.
select con.conname, pg_get_constraintdef(con.oid) as definicion
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
where rel.relname = 'incidencias'
  and con.conname = 'incidencias_lado_check';
