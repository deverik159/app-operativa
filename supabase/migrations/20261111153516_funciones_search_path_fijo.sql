-- ============================================================
-- funciones_search_path_fijo — search_path fijo en 16 funciones
-- (Plataforma, blindaje RLS, 11-nov-2026).
--
-- POR QUÉ. El asesor de seguridad de Supabase marca 17 funciones con
-- function_search_path_mutable: no fijan su search_path y resuelven nombres
-- con el de quien las llama. En una SECURITY DEFINER eso deja abierta la
-- puerta a que alguien haga que la función use un objeto falso con el mismo
-- nombre. El riesgo real hoy es bajo (authenticated y anon no pueden crear
-- objetos en public), pero 6 de ellas son SECURITY DEFINER y el arreglo es
-- mecánico.
--
-- CONVENCIÓN. `public, pg_temp`, la misma que ya tienen 134 funciones del
-- proyecto (104 solas y 30 con lock_timeout); otras 50 tienen solo
-- `public`. Revisado el cuerpo de las 16 en producción: solo usan tablas y
-- funciones de public y funciones de pg_catalog (now, coalesce, translate,
-- split_part, pg_trigger_depth…); ninguna usa extensiones (uuid-ossp,
-- pgcrypto, pg_net viven en `extensions`/`net` y aquí no se llaman).
-- ordenar_ruta_por_cercania crea y lee la temporal `_pts`: con pg_temp al
-- final se sigue encontrando (no hay `_pts` en public).
--
-- QUÉ SE QUEDA FUERA. auth_email() (la 17ª) se deja SIN search_path a
-- propósito: es SQL, STABLE y no SECURITY DEFINER, y la usan 87 políticas,
-- muchas sin envolver en (select …). Hoy Postgres la "inlinea" (la
-- sustituye por su cuerpo); una función con SET no se inlinea y cada
-- llamada pagaría guardar y restaurar el search_path, por fila. Su cuerpo
-- solo usa auth.jwt() (calificada), current_setting y operadores de json,
-- todos de pg_catalog, que siempre se busca primero. El asesor la seguirá
-- marcando.
--
-- QUÉ CAMBIA. Solo la configuración de cada función: mismo cuerpo, mismos
-- permisos, mismo dueño. `alter function … set` se puede correr dos veces.
-- ============================================================

-- SECURITY DEFINER (las que importan)
alter function public.contrato_en_mi_cuadrilla(text)          set search_path = public, pg_temp;
alter function public.pauta_en_mi_cuadrilla(bigint)           set search_path = public, pg_temp;
alter function public.soy_integrante(bigint)                  set search_path = public, pg_temp;
alter function public.usuarios_asignables()                   set search_path = public, pg_temp;
alter function public.ordenar_ruta_por_cercania(bigint)       set search_path = public, pg_temp;
alter function public.ordenar_rutas_unidad(text)              set search_path = public, pg_temp;

-- Triggers
alter function public.cuadrilla_touch()                       set search_path = public, pg_temp;
alter function public.fijacion_set_denorm()                   set search_path = public, pg_temp;
alter function public.inc_cuenta_rechazo()                    set search_path = public, pg_temp;
alter function public.msg_marca_edicion()                     set search_path = public, pg_temp;
alter function public.set_sla()                               set search_path = public, pg_temp;

-- Auxiliares
alter function public.a_fecha(text)                           set search_path = public, pg_temp;
alter function public.derivar_plaza(text)                     set search_path = public, pg_temp;
alter function public.estatus_cara_en(text, timestamp with time zone) set search_path = public, pg_temp;
alter function public.folio_prefijo(text, text, text)         set search_path = public, pg_temp;
alter function public.unaccent_inmutable(text)                set search_path = public, pg_temp;

-- Verificar: proconfig = {"search_path=public, pg_temp"} en las 16 y
-- auth_email() sin proconfig; el asesor baja de 17 a 1.
