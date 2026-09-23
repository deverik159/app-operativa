-- ============================================================
-- bitacora_vv_notificaciones.sql — fase 2: el flujo que mata el correo
-- Correr una vez en Supabase → SQL Editor. Re-ejecutable.
--
-- EL CICLO (Erik, 22-sep-2026): comercial captura o cambia una versión →
-- push/campana al rol PAUTAS ("hay versión por programar") → pautas la
-- marca programada → push/campana a QUIEN LA CAPTURÓ, para que el admin
-- comercial avise al cliente. Nada de correos.
--
-- DISEÑO:
--   · Triggers POR SENTENCIA con tablas de transición: un alta de 30
--     espacios es UNA notificación por persona, no 30. Se agrupa por
--     campaña + versión.
--   · Anti-ruido: la captura por espacio (SAMS) guarda periodo por
--     periodo; si a la misma persona ya se le avisó de esa campaña en los
--     últimos 15 minutos, no se le repite (la campana ya la tiene).
--   · Los managers NO se insertan aquí: su copia la pone el trigger
--     trg_replicar_a_managers, como en todo el sistema.
--   · Eventos nuevos: 'vv_version' (por programar) y 'vv_programada'.
--     El clic aterriza en Bitácora VV (?ir=bitacora — sw.js y App.tsx).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Alta de pautas → aviso al rol pautas
-- ------------------------------------------------------------
create or replace function vv_notificar_por_programar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := lower(coalesce(auth_email(), ''));
  g record;
begin
  for g in
    select n.campana_id, n.version,
           min(n.inicio) as desde, max(n.fin) as hasta, count(*) as espacios,
           c.nombre as campana
    from nuevas n
    join vv_campanas c on c.id = n.campana_id
    where n.estatus = 'por_programar'
    group by n.campana_id, n.version, c.nombre
  loop
    insert into notificaciones (record_id, para_email, evento, mensaje, unidad_negocio)
    select null, u.email, 'vv_version',
           g.campana || ': versión "' || g.version || '" por programar — ' ||
             g.espacios || ' espacio' || case when g.espacios = 1 then '' else 's' end ||
             ', del ' || to_char(g.desde, 'DD/MM') || ' al ' || to_char(g.hasta, 'DD/MM') ||
             '. Revísala en Bitácora VV.',
           'Vía Verde'
    from (
      select distinct lower(usuario_email) as email
      from usuario_roles
      where rol = 'pautas'
    ) u
    where u.email <> v_actor
      -- Anti-ruido: la captura periodo-por-periodo de la misma campaña no
      -- re-avisa a quien ya tiene el aviso fresco en la campana.
      and not exists (
        select 1 from notificaciones nn
        where nn.para_email = u.email
          and nn.evento = 'vv_version'
          and nn.mensaje like g.campana || ':%'
          and nn.creado_en > now() - interval '15 minutes'
      );
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_vv_por_programar on vv_pautas;
create trigger trg_vv_por_programar
  after insert on vv_pautas
  referencing new table as nuevas
  for each statement execute function vv_notificar_por_programar();

-- ------------------------------------------------------------
-- 2) Pautas marca "programada" → aviso a quien capturó
-- ------------------------------------------------------------
create or replace function vv_notificar_programada()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := lower(coalesce(auth_email(), ''));
  g record;
begin
  for g in
    select n.campana_id, n.version, count(*) as espacios,
           c.nombre as campana,
           array_agg(distinct lower(n.creada_por)) as capturistas
    from nuevas n
    join viejas o on o.id = n.id
    join vv_campanas c on c.id = n.campana_id
    where n.estatus = 'programada' and o.estatus = 'por_programar'
    group by n.campana_id, n.version, c.nombre
  loop
    insert into notificaciones (record_id, para_email, evento, mensaje, unidad_negocio)
    select null, e.email, 'vv_programada',
           g.campana || ': la versión "' || g.version || '" ya quedó programada (' ||
             g.espacios || ' espacio' || case when g.espacios = 1 then '' else 's' end ||
             '). Ya puedes avisar al cliente.',
           'Vía Verde'
    from unnest(g.capturistas) as e(email)
    where e.email <> v_actor;
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_vv_programada on vv_pautas;
create trigger trg_vv_programada
  after update on vv_pautas
  referencing old table as viejas new table as nuevas
  for each statement execute function vv_notificar_programada();

-- ------------------------------------------------------------
-- Verificación: da de alta una pauta desde la app y corre esto — debe
-- salir UNA fila por usuario con rol pautas (más la réplica del manager).
-- ------------------------------------------------------------
select para_email, evento, left(mensaje, 80) as mensaje, creado_en
from notificaciones
where evento in ('vv_version', 'vv_programada')
order by creado_en desc
limit 10;
