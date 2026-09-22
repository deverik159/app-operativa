-- ============================================================
-- bitacora_vv.sql — Bitácora de Vía Verde: campañas, pautas y versiones
-- Correr en Supabase → SQL Editor, EN DOS PARTES (ver nota del paso 1).
--
-- EL PROBLEMA (Erik, 22-sep-2026): la bitácora de VV vive en un Excel que
-- comercial llena a mano, hoja por campaña. Cuando el cliente pide un
-- cambio de versión todo viaja por correo; si el aviso no llega a tiempo,
-- salen versiones erróneas al aire y no hay forma de rastrear quién supo
-- qué y cuándo.
--
-- EL DISEÑO — cuatro tablas:
--   vv_espacios         → el inventario físico: 61 columnas + 4 pórticos.
--                         Catálogo estable; casi nunca cambia.
--   vv_campanas         → el encabezado de cada hoja del Excel: cliente,
--                         campaña, vendedor, administrador, fechas.
--   vv_pautas           → cada renglón vivo: espacio + versión + vigencia
--                         + horarios. Un cambio de versión NO edita la
--                         fila: cierra la vigencia y abre otra.
--   vv_pauta_historial  → lo escribe UN TRIGGER, no la app: cada alta,
--                         cambio y borrado queda firmado con quién y
--                         cuándo. Es la trazabilidad que el correo nunca
--                         dio. pauta_id va SIN foreign key a propósito:
--                         si tuviera FK con cascade, borrar una pauta
--                         borraría su propio rastro.
--
-- ROLES NUEVOS: 'comercial' (captura campañas y pide cambios de versión)
-- y 'pautas' (programa las versiones al aire). El flujo de notificaciones
-- entre ellos es la fase 2; este archivo deja lista la estructura.
-- ============================================================

-- ------------------------------------------------------------
-- PASO 1 — CORRER SOLO Y PRIMERO. Postgres no deja USAR un valor nuevo
-- de enum en la misma transacción que lo crea: si esto va junto con el
-- paso 2, truena con "unsafe use of new value".
-- ------------------------------------------------------------
alter type app_role add value if not exists 'comercial';
alter type app_role add value if not exists 'pautas';

-- ------------------------------------------------------------
-- PASO 2 — correr DESPUÉS del paso 1 (en otra ejecución).
-- ------------------------------------------------------------

-- 1) Catálogo de espacios ------------------------------------------------
create table if not exists vv_espacios (
  clave         text primary key,           -- '414', 'B52', 'POR_0008'
  tipo_espacio  text not null check (tipo_espacio in ('columna', 'portico')),
  tramo         text,                        -- CDMX / EDO MEX (columnas)
  tipo          text,                        -- A / B (columnas)
  sitio         text,                        -- San Antonio / San Ángel (pórticos)
  nombre        text,                        -- Norte / Sur (pórticos)
  activo        boolean not null default true
);

-- 2) Campañas (el encabezado de la hoja) ---------------------------------
create table if not exists vv_campanas (
  id            bigserial primary key,
  cliente       text not null,
  nombre        text not null,              -- nombre de la campaña
  vendedor      text,
  administrador text,
  quantum       text,                       -- folio Quantum (P537897)
  fecha_inicio  date not null,
  fecha_fin     date not null,
  mediamonitor  boolean not null default false,
  espec_tomas   text,                       -- especificaciones de tomas/testigos
  estatus       text not null default 'activa'
                check (estatus in ('activa', 'cerrada')),
  creada_por    text not null,
  creada_en     timestamptz not null default now(),
  check (fecha_fin >= fecha_inicio)
);

-- 3) Pautas (los renglones vivos) ----------------------------------------
create table if not exists vv_pautas (
  id            bigserial primary key,
  campana_id    bigint not null references vv_campanas(id) on delete cascade,
  espacio_clave text not null references vv_espacios(clave),
  tipo_venta    text not null default 'VENTA'
                check (tipo_venta in ('VENTA', 'BONUS')),
  version       text not null,
  inicio        date not null,
  fin           date not null,
  -- El formato exige cubrir el día completo; franjas parciales se escriben
  -- explícitas ('07:00 - 21:59HRS'), nunca se dejan vacías.
  horario_lv    text not null default '00:00 - 23:59HRS',
  horario_sd    text not null default '00:00 - 23:59HRS',
  testigos      boolean not null default false,
  observaciones text,
  estatus       text not null default 'por_programar'
                check (estatus in ('por_programar', 'programada', 'cerrada')),
  creada_por    text not null,
  creada_en     timestamptz not null default now(),
  check (fin >= inicio)
);

create index if not exists vv_pautas_campana_idx on vv_pautas (campana_id);
create index if not exists vv_pautas_espacio_idx on vv_pautas (espacio_clave, inicio, fin);

-- 4) Historial (lo escribe el trigger, nunca la app) ----------------------
create table if not exists vv_pauta_historial (
  id          bigserial primary key,
  pauta_id    bigint not null,              -- sin FK: sobrevive al borrado
  campana_id  bigint not null references vv_campanas(id) on delete cascade,
  accion      text not null,                -- creada | editada | eliminada
  detalle     text,
  hecho_por   text not null,
  hecho_en    timestamptz not null default now()
);

create index if not exists vv_hist_campana_idx on vv_pauta_historial (campana_id, hecho_en desc);

-- ------------------------------------------------------------
-- Trigger de historial: cada movimiento en vv_pautas se firma solo.
-- SECURITY DEFINER porque el historial no tiene política de INSERT para
-- usuarios: nadie puede inventarse trazabilidad a mano.
-- ------------------------------------------------------------
create or replace function vv_log_pauta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quien   text := coalesce(auth_email(), 'sistema');
  v_detalle text;
begin
  if tg_op = 'INSERT' then
    insert into vv_pauta_historial (pauta_id, campana_id, accion, detalle, hecho_por)
    values (new.id, new.campana_id, 'creada',
            new.espacio_clave || ' · ' || new.version || ' · '
              || new.inicio || ' → ' || new.fin || ' · ' || new.tipo_venta,
            v_quien);
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into vv_pauta_historial (pauta_id, campana_id, accion, detalle, hecho_por)
    values (old.id, old.campana_id, 'eliminada',
            old.espacio_clave || ' · ' || old.version || ' · '
              || old.inicio || ' → ' || old.fin,
            v_quien);
    return old;
  end if;

  -- UPDATE: solo lo que de verdad cambió, en una línea legible.
  v_detalle := old.espacio_clave;
  if new.version is distinct from old.version then
    v_detalle := v_detalle || ' · versión: ' || old.version || ' → ' || new.version;
  end if;
  if new.inicio is distinct from old.inicio or new.fin is distinct from old.fin then
    v_detalle := v_detalle || ' · vigencia: ' || old.inicio || '–' || old.fin
                 || ' → ' || new.inicio || '–' || new.fin;
  end if;
  if new.estatus is distinct from old.estatus then
    v_detalle := v_detalle || ' · estatus: ' || old.estatus || ' → ' || new.estatus;
  end if;
  if new.horario_lv is distinct from old.horario_lv
     or new.horario_sd is distinct from old.horario_sd then
    v_detalle := v_detalle || ' · horario: ' || new.horario_lv || ' / ' || new.horario_sd;
  end if;
  if new.tipo_venta is distinct from old.tipo_venta then
    v_detalle := v_detalle || ' · ' || old.tipo_venta || ' → ' || new.tipo_venta;
  end if;
  if new.observaciones is distinct from old.observaciones then
    v_detalle := v_detalle || ' · observaciones actualizadas';
  end if;

  -- Si no cambió nada visible (p. ej. un update redundante), no se anota.
  if v_detalle <> old.espacio_clave then
    insert into vv_pauta_historial (pauta_id, campana_id, accion, detalle, hecho_por)
    values (new.id, new.campana_id, 'editada', v_detalle, v_quien);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_vv_log_pauta on vv_pautas;
create trigger trg_vv_log_pauta
  after insert or update or delete on vv_pautas
  for each row execute function vv_log_pauta();

-- ------------------------------------------------------------
-- RLS. Lectura para comercial/pautas/manager (viewer no: la bitácora
-- trae datos comerciales); escritura de campañas y pautas para
-- comercial y manager. El rol pautas puede ACTUALIZAR pautas (marcar
-- programada); el historial es de solo lectura para todos.
-- ------------------------------------------------------------
alter table vv_espacios        enable row level security;
alter table vv_campanas        enable row level security;
alter table vv_pautas          enable row level security;
alter table vv_pauta_historial enable row level security;

grant select on vv_espacios to authenticated;
grant select, insert, update, delete on vv_campanas to authenticated;
grant select, insert, update, delete on vv_pautas to authenticated;
grant select on vv_pauta_historial to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- helper local del archivo para no repetir el trío en cada política
-- (no se crea función: son solo cuatro tablas)

drop policy if exists vve_sel on vv_espacios;
create policy vve_sel on vv_espacios for select to authenticated
  using (tiene_rol('comercial'::app_role) or tiene_rol('pautas'::app_role)
         or tiene_rol('manager'::app_role));

drop policy if exists vvc_sel on vv_campanas;
create policy vvc_sel on vv_campanas for select to authenticated
  using (tiene_rol('comercial'::app_role) or tiene_rol('pautas'::app_role)
         or tiene_rol('manager'::app_role));

drop policy if exists vvc_ins on vv_campanas;
create policy vvc_ins on vv_campanas for insert to authenticated
  with check ((tiene_rol('comercial'::app_role) or tiene_rol('manager'::app_role))
              and lower(creada_por) = lower(auth_email()));

drop policy if exists vvc_upd on vv_campanas;
create policy vvc_upd on vv_campanas for update to authenticated
  using (tiene_rol('comercial'::app_role) or tiene_rol('manager'::app_role));

-- Borrar una campaña completa (y su rastro, por el cascade del historial)
-- es cosa del manager: comercial cierra, no borra.
drop policy if exists vvc_del on vv_campanas;
create policy vvc_del on vv_campanas for delete to authenticated
  using (tiene_rol('manager'::app_role));

drop policy if exists vvp_sel on vv_pautas;
create policy vvp_sel on vv_pautas for select to authenticated
  using (tiene_rol('comercial'::app_role) or tiene_rol('pautas'::app_role)
         or tiene_rol('manager'::app_role));

drop policy if exists vvp_ins on vv_pautas;
create policy vvp_ins on vv_pautas for insert to authenticated
  with check ((tiene_rol('comercial'::app_role) or tiene_rol('manager'::app_role))
              and lower(creada_por) = lower(auth_email()));

-- pautas actualiza (marca programada); comercial edita lo capturado.
drop policy if exists vvp_upd on vv_pautas;
create policy vvp_upd on vv_pautas for update to authenticated
  using (tiene_rol('comercial'::app_role) or tiene_rol('pautas'::app_role)
         or tiene_rol('manager'::app_role));

drop policy if exists vvp_del on vv_pautas;
create policy vvp_del on vv_pautas for delete to authenticated
  using (tiene_rol('comercial'::app_role) or tiene_rol('manager'::app_role));

drop policy if exists vvh_sel on vv_pauta_historial;
create policy vvh_sel on vv_pauta_historial for select to authenticated
  using (tiene_rol('comercial'::app_role) or tiene_rol('pautas'::app_role)
         or tiene_rol('manager'::app_role));
-- Sin política de INSERT/UPDATE/DELETE: al historial solo escribe el trigger.

-- ------------------------------------------------------------
-- Seed del catálogo, tal cual la hoja Auxiliar de la bitácora de junio
-- (61 columnas) más los 4 pórticos comerciales. on conflict: correrlo dos
-- veces no duplica ni pisa nada.
-- ------------------------------------------------------------
insert into vv_espacios (clave, tipo_espacio, tramo, tipo) values
  ('414', 'columna', 'CDMX', 'A'), ('419', 'columna', 'CDMX', 'A'),
  ('440', 'columna', 'CDMX', 'A'), ('444', 'columna', 'CDMX', 'B'),
  ('448', 'columna', 'CDMX', 'B'), ('459', 'columna', 'CDMX', 'A'),
  ('465', 'columna', 'CDMX', 'A'), ('478', 'columna', 'CDMX', 'A'),
  ('491', 'columna', 'CDMX', 'A'), ('505', 'columna', 'CDMX', 'B'),
  ('509', 'columna', 'CDMX', 'A'), ('519', 'columna', 'CDMX', 'A'),
  ('529', 'columna', 'CDMX', 'A'), ('542', 'columna', 'CDMX', 'A'),
  ('552', 'columna', 'CDMX', 'A'), ('571', 'columna', 'CDMX', 'A'),
  ('576', 'columna', 'CDMX', 'A'), ('588', 'columna', 'CDMX', 'A'),
  ('594', 'columna', 'CDMX', 'A'), ('606', 'columna', 'CDMX', 'A'),
  ('620', 'columna', 'CDMX', 'A'), ('628', 'columna', 'CDMX', 'A'),
  ('639', 'columna', 'CDMX', 'A'), ('641', 'columna', 'CDMX', 'A'),
  ('646', 'columna', 'CDMX', 'A'), ('651', 'columna', 'CDMX', 'A'),
  ('656', 'columna', 'CDMX', 'B'), ('661', 'columna', 'CDMX', 'A'),
  ('665', 'columna', 'CDMX', 'A'), ('669', 'columna', 'CDMX', 'A'),
  ('679', 'columna', 'CDMX', 'B'), ('689', 'columna', 'CDMX', 'A'),
  ('706', 'columna', 'CDMX', 'A'), ('715', 'columna', 'CDMX', 'A'),
  ('735', 'columna', 'CDMX', 'A'), ('748', 'columna', 'CDMX', 'A'),
  ('756', 'columna', 'CDMX', 'B'), ('767', 'columna', 'CDMX', 'B'),
  ('778', 'columna', 'CDMX', 'B'), ('791', 'columna', 'CDMX', 'A'),
  ('802', 'columna', 'CDMX', 'A'), ('811', 'columna', 'CDMX', 'B'),
  ('820', 'columna', 'CDMX', 'A'), ('829', 'columna', 'CDMX', 'B'),
  ('840', 'columna', 'CDMX', 'A'), ('856', 'columna', 'CDMX', 'B'),
  ('863', 'columna', 'CDMX', 'B'), ('867', 'columna', 'CDMX', 'B'),
  ('877', 'columna', 'CDMX', 'A'), ('881', 'columna', 'CDMX', 'A'),
  ('897', 'columna', 'CDMX', 'B'),
  ('B52', 'columna', 'EDO MEX', 'B'), ('B56', 'columna', 'EDO MEX', 'A'),
  ('B06', 'columna', 'EDO MEX', 'A'), ('A09', 'columna', 'EDO MEX', 'A'),
  ('B18', 'columna', 'EDO MEX', 'A'), ('A20', 'columna', 'EDO MEX', 'A'),
  ('A26', 'columna', 'EDO MEX', 'A'), ('B29', 'columna', 'EDO MEX', 'A'),
  ('A34', 'columna', 'EDO MEX', 'B'), ('B40', 'columna', 'EDO MEX', 'A')
on conflict (clave) do nothing;

insert into vv_espacios (clave, tipo_espacio, sitio, nombre) values
  ('POR_0008', 'portico', 'San Antonio', 'Norte'),
  ('POR_0015', 'portico', 'San Antonio', 'Sur'),
  ('POR_0078', 'portico', 'San Ángel',   'Norte'),
  ('POR_0092', 'portico', 'San Ángel',   'Sur')
on conflict (clave) do nothing;

-- ------------------------------------------------------------
-- PASO 3 — verificación.
-- ------------------------------------------------------------
-- a) El enum trae los roles nuevos:
select unnest(enum_range(null::app_role)) as roles;

-- b) El catálogo quedó completo (debe dar 61 columnas y 4 pórticos):
select tipo_espacio, count(*) from vv_espacios group by tipo_espacio;

-- c) Las políticas están puestas:
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public' and tablename like 'vv\_%'
order by tablename, policyname;
