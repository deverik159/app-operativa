-- ============================================================
-- vistas_invoker_rutas_biobox — 4 vistas pasan a security_invoker
-- (Plataforma, blindaje RLS, 10-nov-2026).
--
-- POR QUÉ. El asesor de seguridad de Supabase marca 5 vistas como
-- security_definer_view (nivel ERROR): son de postgres y sin
-- security_invoker, así que corren con los permisos de su dueño y se saltan
-- cualquier política que se ponga después en sus tablas. Mismo arreglo que
-- 20261020170737_pauta_riesgo_retiro_invoker y 20261024064321_pauta_vistas_invoker.
--
-- HOY NO CAMBIA LO QUE VE NADIE (revisado en producción el 10-nov-2026):
--   · vw_rutas_resumen y vw_rutas_con_coords leen rutas_monitoreo y
--     ruta_ubicaciones (SELECT "true"), inventario y usuarios
--     (auth_email() is not null): a cualquiera con sesión le dan lo mismo
--     con o sin invoker.
--   · vw_revision_ubicaciones ya filtra con maquina_visita_puede_leer(), la
--     misma condición de revisiones_sel; las demás tablas son de lectura
--     para cualquiera con sesión.
--   · vw_caras_fuera_servicio solo lee inventario. La app no la usa.
--   Conteos de antes (simulando manager, coordinador, reparación Biobox,
--   viewer, comercial y validador): caras 448, resumen 39, coords 767 para
--   todos; revisión 767 o 0 según maquina_visita_puede_leer().
--
-- QUÉ SE QUEDA COMO ESTÁ. vw_fijacion_externa sigue siendo definer A
-- PROPÓSITO: lee externo.fijacion (la base de Mario), y authenticated no
-- tiene permiso sobre el esquema externo; la vista es la puerta y filtra
-- por dentro (manager, coordinador, viewer de Ecovallas impreso o correo en
-- operadores_cuadrilla). Con invoker, Fijación Externa dejaría de cargar.
-- La recreó hoy 20261110221613_viewer_consulta.
--
-- QUÉ CAMBIA. Solo la opción y los permisos de escritura, que una vista no
-- debe tener (vw_caras_fuera_servicio tenía insert/update/delete/truncate
-- para authenticated; en PG17 también se quita maintain). Mismas columnas,
-- sin recrear. Re-ejecutable.
--
-- RENDIMIENTO (revisor-rls, 10-nov-2026, medido con EXPLAIN ANALYZE).
-- Con invoker, la subconsulta del nombre del coordinador pasa por la RLS de
-- usuarios; usr_sel y usr_write (ALL, también aplica al leer) no estaban
-- envueltas en (select …) y se evaluaban por fila: 62 usuarios × 767
-- paradas. vw_rutas_con_coords pasaba de 1.0 s a 2.2 s. Envueltas, la
-- subconsulta vuelve a 0.054 ms por fila. Misma semántica; inventario se
-- envuelve igual por consistencia. Además, inventario no tenía índice por
-- site_id y los dos laterales de coords hacían un seq scan por parada (casi
-- todo el segundo que tarda hoy).
--
-- OJO PARA EL FUTURO: un `create or replace view` sin `with
-- (security_invoker = on)` le borra la opción y la vista vuelve a ser
-- definer (lección del 5-oct-2026, rutas_armado_visitas).
-- ============================================================

-- 1) Políticas envueltas en (select …): misma condición, se evalúa una vez.
alter policy usr_sel on public.usuarios
  using ((select auth_email()) is not null);
alter policy usr_write on public.usuarios
  using ((select tiene_rol('manager'::app_role)))
  with check ((select tiene_rol('manager'::app_role)));
alter policy lectura_autenticados on public.inventario
  using ((select auth_email()) is not null);

-- 2) Índice para los laterales por sitio.
create index if not exists inventario_site_id_idx on public.inventario (site_id);

-- 3) Las vistas respetan la RLS de quien consulta.
alter view public.vw_rutas_resumen        set (security_invoker = on);
alter view public.vw_rutas_con_coords     set (security_invoker = on);
alter view public.vw_revision_ubicaciones set (security_invoker = on);
alter view public.vw_caras_fuera_servicio set (security_invoker = on);

-- 4) Sin permisos de escritura ni de mantenimiento sobre las vistas.
revoke insert, update, delete, truncate, references, trigger, maintain
  on public.vw_rutas_resumen        from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger, maintain
  on public.vw_rutas_con_coords     from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger, maintain
  on public.vw_revision_ubicaciones from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger, maintain
  on public.vw_caras_fuera_servicio from authenticated, anon;

-- Verificar: reloptions = {security_invoker=on} en las 4, authenticated
-- solo SELECT (r), políticas de usuarios e inventario con (select …), el
-- índice creado, y los mismos conteos por usuario de arriba.
