-- ============================================================
-- rechazos_reparacion.sql — contador de reparaciones rechazadas
-- Correr en Supabase → SQL Editor, paso por paso.
--
-- QUÉ RESUELVE (Erik, sep-2026): cuando el validador rechaza una
-- reparación, la incidencia regresa a 'en_proceso' y no queda NINGÚN
-- rastro contable de que hubo un rechazo: `motivo_rechazo_reparacion`
-- se sobrescribe con cada rechazo nuevo, así que dos rechazos se ven
-- igual que uno. Sin ese dato no hay KPI de rechazos posible.
--
-- CÓMO: una columna-contador que incrementa un TRIGGER cada vez que el
-- estatus pasa de 'reparado' a 'en_proceso' — esa transición solo la
-- produce el rechazo del validador (la validación inicial va de
-- 'por_validar' a 'en_proceso', y el descarte de prevalidación va de
-- 'en_proceso' a 'rechazada'; ninguna de las dos entra aquí).
--
-- POR QUÉ UN TRIGGER Y NO EL FRONTEND: el contador es un dato de
-- auditoría. Si lo incrementara la app, cualquier cliente viejo, un
-- update manual en el SQL Editor o un flujo futuro que rechace por otro
-- camino dejarían el conteo mentiroso. El trigger ve TODOS los updates,
-- vengan de donde vengan, y además ignora lo que el cliente mande en la
-- columna: el conteo no se puede falsear desde fuera.
-- ============================================================

-- PASO 1 — La columna. NOT NULL con default 0: un contador nulo no
-- significa nada y obligaría a coalescear en cada consulta.
alter table public.incidencias
  add column if not exists rechazos_reparacion integer not null default 0;

comment on column public.incidencias.rechazos_reparacion is
  'Veces que el validador rechazó la reparación (reparado→en_proceso). '
  'Lo incrementa el trigger inc_cuenta_rechazo; no escribir a mano.';

-- PASO 2 — El trigger.
create or replace function public.inc_cuenta_rechazo()
returns trigger
language plpgsql
as $$
begin
  if old.estatus = 'reparado' and new.estatus = 'en_proceso' then
    -- Sobre OLD a propósito: se ignora cualquier valor que el cliente
    -- haya mandado en la columna. El conteo lo lleva la base, punto.
    new.rechazos_reparacion := coalesce(old.rechazos_reparacion, 0) + 1;
  else
    -- Fuera de la transición de rechazo, la columna no se mueve: ni el
    -- cliente ni un update descuidado pueden alterarla.
    new.rechazos_reparacion := coalesce(old.rechazos_reparacion, 0);
  end if;
  return new;
end;
$$;

drop trigger if exists inc_cuenta_rechazo on public.incidencias;
create trigger inc_cuenta_rechazo
  before update on public.incidencias
  for each row
  execute function public.inc_cuenta_rechazo();

-- PASO 3 — Verificar: debe existir la columna en 0 y el trigger vivo.
select count(*) as total,
       count(*) filter (where rechazos_reparacion > 0) as con_rechazos
from public.incidencias;

select tgname, pg_get_triggerdef(t.oid)
from pg_trigger t
where t.tgrelid = 'public.incidencias'::regclass
  and t.tgname = 'inc_cuenta_rechazo';

-- ------------------------------------------------------------
-- SOBRE EL PASADO: los rechazos anteriores a este script NO se pueden
-- reconstruir. `motivo_rechazo_reparacion` guarda solo el último texto y
-- además lo comparte el flujo de descartar prevalidación, así que usarlo
-- de proxy contaría descartes como rechazos. El contador arranca en 0 y
-- mide de hoy en adelante — mejor un KPI corto y honesto que uno largo
-- e inventado.
-- ------------------------------------------------------------
