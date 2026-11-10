-- Quién sube y quién borra fotos de evidencia (Erik, 10-nov-2026).
-- Hallazgo del revisor de permisos al revisar el Viewer: cualquier usuario con
-- sesión (incluido el viewer) podía, directo a la API,
--   · BORRAR archivos del bucket «evidencias»: fotos de reporte y reparación
--     de cualquier folio, adjuntos del chat, tomas de Pauta y revisiones;
--   · SUBIR archivos al bucket y CREAR filas en public.evidencias de cualquier
--     folio.
-- Ya existía para todos los roles. Esta migración deja a cada quien lo que la
-- app ya hace (mapa de llamadas del 10-nov-2026) y cierra lo demás.
--
-- Quién borra archivos legítimamente hoy:
--   · el DUEÑO de la foto (reportante y técnico en la galería y al reparar, el
--     monitorista en su cola, la analista sus editadas, limpiezas al fallar);
--   · el MANAGER, cualquiera (ya lo tenía);
--   · el VALIDADOR, fotos de los folios (carpeta = record_id) y de revisiones
--     de Biobox, desde la galería de Evidencia;
--   · el COORDINADOR, fotos de las tomas de Pauta (pauta/), al quitarlas;
--   · la limpieza del chat (Edge Function limpiar-chat) usa service_role y no
--     pasa por aquí.
-- Se conservan tal cual las protecciones vigentes: comp/ y comp-analista/ van
-- por ev_obj_del_comp (sin cambios); pauta-analista/, maquinas/ y nuc/ solo
-- dueño o manager; nuc/ además no si la foto cerró un aviso.

-- ¿Tiene algún rol que trabaja (cualquiera menos el viewer)? El viewer
-- (Consulta) y quien no tiene rol no suben ni registran evidencias.
create or replace function public.tiene_rol_operativo()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from usuario_roles ur
     where lower(ur.usuario_email) = lower(auth_email())
       and ur.rol <> 'viewer'::app_role
  )
$function$;

-- ── Borrar archivos ──────────────────────────────────────────────────────────
alter policy ev_obj_del on storage.objects
  using (
    bucket_id = 'evidencias'::text
    and name !~~ 'comp/%'::text
    and name !~~ 'comp-analista/%'::text
    and (
      -- dueño o manager: como antes en todas las carpetas
      owner_id = (select (auth.uid())::text)
      or (select tiene_rol('manager'::app_role))
      -- validador: fotos de folios y de revisiones. Lista de lo PERMITIDO
      -- (revisor-rls): la carpeta de un folio es su record_id, 8 hexadecimales
      -- (idCorto en src/lib/helpers.ts); una carpeta nueva queda cerrada
      -- hasta que se decida.
      or ((select tiene_rol('validador'::app_role))
          and (name ~ '^[0-9a-f]{8}/' or name ~~ 'revisiones/%'::text))
      -- coordinador: tomas de Pauta del monitorista
      or ((select tiene_rol('coordinador'::app_role)) and name ~~ 'pauta/%'::text)
    )
    -- la foto que cerró un aviso NUC no se borra (como antes)
    and (name !~~ 'nuc/%'::text or not nuc_foto_en_uso(name))
  );

-- ── Subir archivos ───────────────────────────────────────────────────────────
alter policy ev_obj_upload on storage.objects
  with check (bucket_id = 'evidencias'::text and (select tiene_rol_operativo()));

-- ── Crear filas de evidencia ─────────────────────────────────────────────────
-- Todas las altas de la app guardan subido_por = el correo de quien sube
-- (envios, acciones, galería, revisión Biobox, reportes Webadmin). La del
-- monitorista sigue además por ev_ins_monitorista, sin cambios.
alter policy ev_ins on public.evidencias
  with check ((select tiene_rol_operativo())
              and lower(subido_por) = lower((select auth_email())));
