-- ============================================================
-- rol_monitorista.sql — el rol de quien recorre la ruta
-- Correr en Supabase → SQL Editor, EN DOS PARTES (ver nota del paso 1).
--
-- EL PROBLEMA (Erik, 21-sep-2026): no existía un rol para el monitorista,
-- así que se le daba 'reparacion' — y eso arrastra la bandeja de
-- reparación, los indicadores y funciones de técnico que no le tocan. El
-- trabajo de monitoreo y el de reparación deben estar separados.
--
-- EL ROL NUEVO: 'monitorista'. En la app ve SOLO Pauta y Monitoreo (su
-- ruta asignada se le pre-filtra), y desde ahí puede levantar reportes de
-- lo que vea mal (el flujo post-toma). No ve incidencias por reparar, ni
-- bandeja, ni indicadores.
--
-- QUÉ NECESITA EN LA BASE:
--   · El valor nuevo en el enum app_role (paso 1).
--   · Poder INSERTAR incidencias y evidencias propias (paso 2): las
--     tablas de pauta ya son por sesión y no necesitan nada.
-- ============================================================

-- ------------------------------------------------------------
-- PASO 1 — CORRER SOLO Y PRIMERO. Postgres no deja USAR un valor nuevo
-- de enum en la misma transacción que lo crea: si esto va junto con el
-- paso 2, truena con "unsafe use of new value".
-- ------------------------------------------------------------
alter type app_role add value if not exists 'monitorista';

-- ------------------------------------------------------------
-- PASO 2 — correr DESPUÉS del paso 1 (en otra ejecución).
-- Políticas ADITIVAS (en Postgres las permisivas se suman con OR): no se
-- toca ninguna política existente — cero riesgo de romper a los demás
-- roles. El monitorista captura reportes desde Pauta:
-- ------------------------------------------------------------

-- Insertar incidencias, solo firmadas por él mismo.
drop policy if exists inc_ins_monitorista on public.incidencias;
create policy inc_ins_monitorista on public.incidencias
  for insert to authenticated
  with check (
    tiene_rol('monitorista'::app_role)
    and lower(captured_by) = lower(auth_email())
  );

-- Leer SUS reportes: sin esto, el insert().select() de la app no puede
-- devolver la fila recién creada (RLS silenciosa) y saltaría el aviso de
-- "se guardaron 0 de N" en cada captura.
drop policy if exists inc_sel_monitorista on public.incidencias;
create policy inc_sel_monitorista on public.incidencias
  for select to authenticated
  using (
    tiene_rol('monitorista'::app_role)
    and lower(coalesce(captured_by, '')) = lower(auth_email())
  );

-- Evidencia del reporte, firmada por él mismo.
drop policy if exists ev_ins_monitorista on public.evidencias;
create policy ev_ins_monitorista on public.evidencias
  for insert to authenticated
  with check (
    tiene_rol('monitorista'::app_role)
    and lower(subido_por) = lower(auth_email())
  );

-- ------------------------------------------------------------
-- PASO 3 — verificación.
-- ------------------------------------------------------------
-- a) El enum ya trae el rol:
select unnest(enum_range(null::app_role)) as roles;

-- b) Da de alta a un monitorista desde Usuarios (o a mano):
--    insert into usuario_roles (usuario_email, rol, unidad_negocio)
--    values ('correo@gpovallas.com', 'monitorista', 'Ecovallas');
--    Al entrar debe ver SOLO "Pauta y Monitoreo".
