-- ============================================================
-- Aviso NUC: el coordinador de Digital también marca
-- (Erik, 10-nov-2026 · sección Aviso NUC)
--
-- Hasta hoy solo el manager y el técnico (reparacion) con área Digital
-- podían marcar fuera de línea, sitio apagado y «Ya está en línea». Erik
-- pidió que el coordinador también pueda, y eligió «solo los de Digital»:
-- el coordinador con área Digital, con la misma regla que el técnico de
-- Digital (de cualquier unidad, actúa en todas). Hoy hay 3 coordinadores
-- con área Digital; 2 ya eran técnicos de Digital, así que solo gana los
-- botones 1 (fila sin unidad).
--
-- nuc_es_digital() la usan nuc_aviso_abrir, nuc_aviso_apagado,
-- nuc_aviso_en_linea y nuc_puede_ver: el coordinador de Digital de una
-- unidad también vería el tablero de todas, como el técnico de Digital.
-- Hoy nadie gana visibilidad (los 3 ya veían todas). Los avisos que recibe
-- cada quien (nuc_avisar_tecnicos) no cambian.
--
-- Igual que la vigente (md5 de prosrc 15e94caaf308d9f8e315d8bcd9515848)
-- salvo el rol: 'reparacion' → 'reparacion' o 'coordinador'. CREATE OR
-- REPLACE conserva los permisos (solo postgres y service_role la ejecutan
-- directo; las funciones de arriba la llaman como SECURITY DEFINER).
--
-- En la pantalla, lo mismo: esDigitalNuc en src/lib/avisoNuc.ts.
-- ORDEN: puede ir antes que el frontend (la app de hoy no le ofrece los
-- botones al coordinador; solo dejaría de rechazarlo la base).
-- ============================================================

create or replace function public.nuc_es_digital()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select tiene_rol('manager'::app_role)
      or exists (
           select 1 from usuario_roles ur
            where lower(ur.usuario_email) = lower(auth_email())
              -- CAMBIO (10-nov-2026): también el coordinador de Digital.
              and ur.rol in ('reparacion'::app_role, 'coordinador'::app_role)
              and trim(ur.departamento) ilike 'digital');
$function$;
