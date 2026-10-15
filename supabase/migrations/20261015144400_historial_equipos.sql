-- ============================================================
-- historial_equipos — trazabilidad de los equipos que se cambian en Digital
-- (Erik, 15-oct-2026). Re-ejecutable.
--
-- Qué se quiere: cuando un técnico de Digital repara cambiando un equipo con
-- número de serie (NUC, equipo de red, tarjeta receptora, módulo LED, UPS,
-- POE), dejar escrito qué equipo salió y cuál entró, para saber dónde está
-- cada equipo y cuánto duró. Se consulta en la entrada "Equipos" del menú.
--
-- 1. arbol_digital.equipo — QUÉ soluciones piden el historial y de qué tipo
--    de equipo. null = no lo pide. Se marca aquí para las 7 soluciones de
--    cambio de equipo con serie; después se prende o apaga por solución sin
--    tocar código. Cargar el árbol con UPSERT sin esta columna la conserva.
--
-- 2. incidencias.cambio_equipo (jsonb) — el cambio, escrito JUNTO con la
--    reparación en el mismo UPDATE (así también funciona sin señal: viaja en
--    la cola con la reparación). Forma:
--      { "tipo": "NUC", "fecha": "2026-10-15",
--        "sale":  { "serie": "...", "inventario": "...", "obs": "..." },
--        "entra": { "serie": "...", "inventario": "...", "obs": "..." } }
--    Una sola fecha: la del cambio (ese día sale uno y entra el otro). Cuánto
--    duró cada equipo lo calcula la app con el cambio anterior en la misma
--    pantalla. El tipo se copia aquí para que el registro no dependa de que
--    el árbol cambie después.
--
-- 3. inc_blindaje_reparacion — cambio_equipo es un campo de la reparación:
--    solo lo escribe el técnico del área y unidad (o el manager), igual que
--    diagnóstico, causa y solución.
-- ============================================================
alter table public.arbol_digital add column if not exists equipo text;

update public.arbol_digital
set equipo = case solucion
  when 'Cambio de NUC' then 'NUC'
  when 'Cambio de Equipo de Red' then 'Equipo de red'
  when 'Cambio de Tarjeta' then 'Tarjeta receptora'
  when 'Cambio de Tarjeta Receptora' then 'Tarjeta receptora'
  when 'Cambio de Módulo LED' then 'Módulo LED'
  when 'Cambio de UPS' then 'UPS'
  when 'Reemplazo de POE' then 'POE'
end
where equipo is null
  and solucion in ('Cambio de NUC', 'Cambio de Equipo de Red', 'Cambio de Tarjeta',
                   'Cambio de Tarjeta Receptora', 'Cambio de Módulo LED',
                   'Cambio de UPS', 'Reemplazo de POE');

alter table public.incidencias add column if not exists cambio_equipo jsonb;

create or replace function public.inc_blindaje_reparacion()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  em text := lower(coalesce(auth_email(), ''));
begin
  if em = '' then
    return new;
  end if;

  if not (
       (new.estatus = 'reparado' and old.estatus is distinct from 'reparado')
    or new.diagnostico         is distinct from old.diagnostico
    or new.detalle_reparacion  is distinct from old.detalle_reparacion
    or new.causa_raiz          is distinct from old.causa_raiz
    or new.solucion            is distinct from old.solucion
    or new.incidencia_srd      is distinct from old.incidencia_srd
    or new.arbol_digital_id    is distinct from old.arbol_digital_id
    or new.repaired_by_email   is distinct from old.repaired_by_email
    or new.repaired_at         is distinct from old.repaired_at
    or new.fecha_reparacion    is distinct from old.fecha_reparacion
    -- Historial del equipo cambiado (15-oct-2026): parte de la reparación.
    or new.cambio_equipo       is distinct from old.cambio_equipo
  ) then
    return new;
  end if;

  if exists (
    select 1 from usuario_roles ur
    where lower(ur.usuario_email) = em
      and (
        ur.rol = 'manager'
        or (
          ur.rol = 'reparacion'
          and ur.departamento is not null
          and (ur.departamento = old.area_responsable or ur.departamento = old.assigned_area)
          and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(old.unidad_negocio))
        )
      )
  ) then
    return new;
  end if;

  raise exception 'Solo el técnico del área % puede registrar la reparación de %',
    coalesce(old.area_responsable, '(sin área)'), coalesce(old.folio, old.record_id)
    using errcode = '42501';
end $function$;

-- Verificar: 7 soluciones marcadas (en las filas del árbol que las usan) y
-- las dos columnas nuevas.
select solucion, equipo, count(*) as filas
from public.arbol_digital
where equipo is not null
group by 1, 2
order by 2, 1;
