-- ============================================================
-- pauta_vistas_invoker — vw_pauta_ruta y vw_pauta_resumen con
-- security_invoker (pendiente técnico de Pauta, 24-oct-2026).
--
-- POR QUÉ. revisor-rls lo vio el 20-oct-2026: sin invoker, una vista corre
-- con los permisos de su dueño y se salta cualquier política por rol o
-- unidad que se ponga después en pautas, pauta_monitoreo o pauta_evidencias.
-- Hoy no cambia nada de lo que ve nadie: las tablas base dejan leer a
-- cualquiera con sesión (pauta_sel, pmon_sel, pev_sel, lectura_autenticados
-- en inventario y ruta_ubic_sel), y vw_pauta_resumen lee de vw_pauta_ruta.
-- Verificado en producción el 24-oct-2026: reloptions null en las dos;
-- vw_pauta_riesgo_retiro y vw_pautas_por_fijar ya lo tienen.
--
-- QUÉ CAMBIA. Solo la opción y los permisos de escritura, que una vista no
-- debe tener (igual que 20261020170737_pauta_riesgo_retiro_invoker). Mismas
-- columnas, sin recrear. Re-ejecutable.
-- ============================================================

alter view public.vw_pauta_ruta set (security_invoker = on);
alter view public.vw_pauta_resumen set (security_invoker = on);

revoke insert, update, delete, truncate, references, trigger
  on public.vw_pauta_ruta from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger
  on public.vw_pauta_resumen from authenticated, anon;
