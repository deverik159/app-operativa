-- Limpieza de tablas viejas, paso 1 (13-oct-2026). Sin uso en app ni en base
-- (revisado: código, funciones, vistas, llaves foráneas y permisos).
-- bitacoras (módulo Bitácora descartado), causas_raiz (Digital usa arbol_digital),
-- equipos y miembros_equipo (sin uso), respaldo_asignacion_tecnico (respaldo del
-- 27-ago de incidencias ya borradas), mantenimientos y refacciones (módulo
-- Mantenimiento Biobox descartado) y _limpieza_paths (sobrante de la limpieza de agosto).
-- Respaldo en la PC de Erik (JSON + CSV). Sin CASCADE: si algo dependiera, falla.
drop trigger if exists trg_notificar_mant on public.mantenimientos;
drop function if exists public.notificar_mantenimiento();

drop table public.miembros_equipo;
drop table public.equipos;
drop table public.bitacoras;
drop table public.causas_raiz;
drop table public.respaldo_asignacion_tecnico;
drop table public.mantenimientos;
drop table public.refacciones;
drop table public._limpieza_paths;
