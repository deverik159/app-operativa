-- ============================================================
-- checklist_biobox_peru — plantilla de revisión de máquinas de Biobox Perú
-- (Erik, 22-oct-2026).
--
-- Perú se trabaja igual que Biobox México (Erik, 21-oct-2026): sus usuarios
-- revisan sus máquinas desde Máquinas Biobox. La revisión busca la plantilla
-- por unidad y medio (RevisionModal) y, sin una de "Biobox Perú", decía
-- "No hay checklist configurado para Biobox Perú".
--
-- QUÉ HACE
--   Copia la plantilla Digital activa de Biobox México (todas las máquinas de
--   Perú son M5 Digital) como "Biobox Perú" / Digital, con todos sus puntos,
--   en el mismo orden y con los mismos flags (activo, crítico, foto). Dos
--   cambios, decididos por Erik (22-oct-2026):
--     · "El Teltonika está en línea" pasa a "El módem está en línea" (las
--       máquinas de Perú no llevan Teltonika), con incidencia sugerida
--       "Modem con fallas" del catálogo de Perú (área Op. Bio Box, M5) y su
--       ayuda acorde.
--     · La ayuda de "La máquina tiene energía" pierde la columna CFE y el
--       OXXO, que son de México.
--
--   Las causas (checklist_causas) no se copian: son por medio, mueble y
--   texto del punto, no por unidad, así que las de Digital ya aplican a los
--   puntos con el mismo texto. El punto del módem se queda sin lista de
--   causas (la de "El Teltonika está en línea" era de Arduino); ahí se
--   captura en texto libre y la incidencia sugerida hace el resto.
--
-- NO TOCA la plantilla de México ni sus puntos, ni las revisiones.
--
-- Re-ejecutable: si ya hay una plantilla Digital de Biobox Perú, no hace
-- nada (alguien pudo ajustarla después).
--
-- (31-oct-2026) Este archivo nunca se subió al repo: se recuperó tal cual de
-- supabase_migrations.schema_migrations.statements de producción.
-- ============================================================

set lock_timeout = '5s';

do $mig$
declare
  v_origen  bigint;
  v_n_orig  int;
  v_nueva   bigint;
  v_n       int;
begin
  if exists (
    select 1 from public.checklist_plantillas
     where unidad_negocio = 'Biobox Perú' and tipo_medio = 'Digital'
  ) then
    raise notice 'Ya existe la plantilla Digital de Biobox Perú: no se toca.';
    return;
  end if;

  -- La misma que vería una máquina Digital de México en RevisionModal.
  select id into v_origen
    from public.checklist_plantillas
   where unidad_negocio = 'Biobox' and tipo_medio = 'Digital' and activa
   order by id
   limit 1;
  if v_origen is null then
    raise exception 'No hay plantilla Digital activa de Biobox (México) que copiar.';
  end if;

  select count(*) into v_n_orig
    from public.checklist_puntos
   where plantilla_id = v_origen
     and texto = 'El Teltonika está en línea';
  if v_n_orig <> 1 then
    raise exception 'La plantilla % debía tener un punto "El Teltonika está en línea" y tiene %.', v_origen, v_n_orig;
  end if;

  select count(*) into v_n_orig
    from public.checklist_puntos
   where plantilla_id = v_origen
     and texto = 'La máquina tiene energía';
  if v_n_orig <> 1 then
    raise exception 'La plantilla % debía tener un punto "La máquina tiene energía" y tiene %.', v_origen, v_n_orig;
  end if;

  -- La incidencia sugerida debe existir en el catálogo de Perú, con el mismo
  -- empate que RevisionModal (unidad sin mayúsculas, detalle exacto, M5).
  if not exists (
    select 1 from public.catalogo_incidencias
     where unidad_negocio ilike 'Biobox Perú'
       and detalle = 'Modem con fallas'
       and tipo_mueble = 'M5'
  ) then
    raise exception 'El catálogo de Biobox Perú no tiene "Modem con fallas" para M5.';
  end if;

  insert into public.checklist_plantillas (nombre, unidad_negocio, tipo_medio, descripcion, activa)
  select nombre, 'Biobox Perú', tipo_medio, descripcion, true
    from public.checklist_plantillas
   where id = v_origen
  returning id into v_nueva;

  insert into public.checklist_puntos
    (plantilla_id, orden, grupo, texto, ayuda, incidencia_sugerida, exige_foto_anomalia, critico, activo)
  select v_nueva, p.orden, p.grupo,
         case when p.texto = 'El Teltonika está en línea'
              then 'El módem está en línea' else p.texto end,
         case p.texto
              when 'El Teltonika está en línea' then 'Si no reporta, levanta Modem con fallas.'
              when 'La máquina tiene energía'   then 'Si no tiene energía, anótalo en la nota.'
              else p.ayuda end,
         case when p.texto = 'El Teltonika está en línea'
              then 'Modem con fallas' else p.incidencia_sugerida end,
         p.exige_foto_anomalia, p.critico, p.activo
    from public.checklist_puntos p
   where p.plantilla_id = v_origen
   order by p.orden, p.id;
  get diagnostics v_n = row_count;

  select count(*) into v_n_orig from public.checklist_puntos where plantilla_id = v_origen;
  if v_n <> v_n_orig then
    raise exception 'Se copiaron % puntos de %.', v_n, v_n_orig;
  end if;
  if exists (
    select 1 from public.checklist_puntos
     where plantilla_id = v_nueva
       and (texto ilike '%teltonika%' or ayuda ilike '%teltonika%'
            or ayuda ilike '%CFE%' or ayuda ilike '%OXXO%')
  ) then
    raise exception 'La plantilla de Perú quedó con Teltonika, CFE u OXXO.';
  end if;

  raise notice 'Plantilla % de Biobox Perú con % puntos (copia de la %).', v_nueva, v_n, v_origen;
end $mig$;

-- Verificación (solo lectura):
--   select pl.id, pl.nombre, pl.unidad_negocio, pl.tipo_medio, pl.activa,
--          count(p.*) as puntos, count(p.*) filter (where p.activo) as activos
--     from checklist_plantillas pl left join checklist_puntos p on p.plantilla_id = pl.id
--    group by pl.id order by pl.id;
