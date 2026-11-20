-- ============================================================
-- 20-nov-2026 · Incidencias / Biobox · Palabras clave y checklist
-- Qué: las fallas nuevas de TI «SIM sin datos» y «SIM desactivado»
--      (catálogo de BioBox, migración 20261120201121) se conectan a:
--   1. Palabras clave de los reportes de la app BioBox escritos en «Otro»
--      (biobox_app_palabras), solo Biobox México:
--        · «sim»/«sims»/«chip» con «desactiv…», «suspend…» o «de baja», en
--          cualquier orden → SIM desactivado (prioridad 14);
--        · «sim»/«sims» a secas → SIM sin datos (prioridad 15).
--      «chip» a secas NO cuenta (Erik, 20-nov-2026): atraparía el chip de la
--      tarjeta o del celular del usuario («mi tarjeta tiene chip y no la
--      lee» es de la aplicación). Tampoco «chips»: «bolsa de chips».
--      Ganan a «Puntos o aplicación» (20) y pierden con «Máquina llena» (10).
--      Van directo a TI y la marca de atendido la pone el técnico.
--   2. Regla automática (biobox_app_auto): estas dos fallas, si el reporte
--      no trae máquina, NO entran directo: quedan «Por clasificar» con la
--      sugerencia y la validadora les pone la máquina, igual que «Falla en
--      el proceso de reciclaje» (17-nov-2026). Hoy los 60 reportes «Otro»
--      de Biobox llegan sin máquina; sin esto TI recibiría «SIM sin datos»
--      como Sin máquina y sin revisar duplicados. Con máquina: directo a TI.
--      Solo cambia la condición de la validadora; el resto de la función es
--      idéntico a 20261117185239.
--   3. Causas del checklist de la revisión de Biobox (checklist_causas),
--      bajo «El Teltonika está en línea» (grupo «Energía y conexión»),
--      medio Ambas, para las familias M4, M4-R2 y M5 (la app cuenta
--      M4 URBANA como M4 y M5 OXXO como M5). Prioridad Alta y levantan la
--      incidencia de TI, como la otra causa de ese punto.
-- Por qué: Erik (20-nov-2026) pidió que los reportes con «sim» se
--      clasifiquen solos y que el checklist sugiera estas fallas; eligió el
--      punto del Teltonika, «sim» a secas → SIM sin datos, directo a TI y,
--      sin máquina, por la validadora.
-- Fuera a propósito: Biobox Perú (su catálogo no tiene estas fallas, sus
--      palabras están en pausa y su checklist usa «El módem está en línea»).
-- Efectos: agrega filas y cambia una condición de biobox_app_auto. Las
--      palabras aplican a reportes que lleguen después de reglas_desde
--      (11-nov-2026), igual que las existentes.
-- Re-ejecutable: palabras con on conflict (unidad, patrón) do nothing;
--      causas solo si no existe ya el mismo punto + causa + mueble; la
--      función con create or replace.
-- Candado: solo procede si biobox_app_auto es la vigente (20261117185239)
--      o ya es la de esta migración.
-- ============================================================

set local lock_timeout = '5s';

do $$
declare
  v text;
begin
  select md5(replace(prosrc, E'\r', '')) into v from pg_proc
   where oid = 'public.biobox_app_auto(bigint)'::regprocedure;
  if v is distinct from 'f67424ea3ed4b575136bbd9028c1f4f8' and v is distinct from '08468f5fc8fddcf36b1fbf3e4d5c65a0' then
    raise exception 'biobox_app_auto cambió en producción (md5 %); revisar antes de aplicar.', v;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Palabras clave (el trigger biobox_app_palabras_valida exige que la falla
--    exista en el catálogo de la unidad y que el patrón sea válido).
-- ─────────────────────────────────────────────────────────────────────────
insert into public.biobox_app_palabras
  (unidad_negocio, patron, catalogo_detalle, etiqueta, directo_al_area,
   marca_atendido, prioridad, activo)
values
  ('Biobox',
   '\m(sims?|chip)\M.*\m(desactiv\w*|suspend\w*|de baja)\M|\m(desactiv\w*|suspend\w*|de baja)\M.*\m(sims?|chip)\M',
   'SIM desactivado', 'SIM desactivado', true, 'tecnico', 14, true),
  ('Biobox',
   '\msims?\M',
   'SIM sin datos', 'SIM sin datos', true, 'tecnico', 15, true)
on conflict (unidad_negocio, patron) do nothing;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Regla automática: SIM sin máquina → validadora.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.biobox_app_auto(p_report_id bigint)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r        biobox_app_reportes%rowtype;
  v_det    text;
  v_etq    text;
  v_dir    boolean;
  v_marca  text;
  v_falla  jsonb;
  v_clave  text;
  v_dup    text;
  v_rec    text;
  v_desde  timestamptz;
begin
  select * into r from biobox_app_reportes where report_id = p_report_id for update;
  if not found or r.decision is not null or coalesce(r.estatus_core, 1) not in (1, 2) then
    return null;
  end if;

  -- Arranque (Erik, 11-nov-2026): solo lo que el usuario reportó DESPUÉS de
  -- encender las reglas; lo anterior lo clasifica la validadora, para que la
  -- puesta en marcha no le cargue trabajo de golpe a las áreas. La hora del
  -- Core viene en UTC como 'AAAA-MM-DD HH:MM:SS'; si no se entiende, no se toca.
  select reglas_desde into v_desde from biobox_app_sync_estado where id = 1;
  if v_desde is null
     or coalesce(r.fecha_reporte_core ~ '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}', false) is false then
    return null;
  end if;
  -- (Aparte: solo se convierte una fecha que ya pasó el patrón.)
  if (left(r.fecha_reporte_core, 19) || '+00')::timestamptz < v_desde then
    return null;
  end if;

  -- a) Por motivo.
  select q.catalogo_detalle, q.etiqueta, q.directo_al_area, q.marca_atendido
    into v_det, v_etq, v_dir, v_marca
    from biobox_app_equivalencias q
   where q.unidad_negocio = r.unidad_negocio and q.caso_id = r.caso_id and q.activo;

  -- b) «Otro»: por palabras, sin acentos ni mayúsculas; gana la prioridad más baja.
  if v_det is null and r.caso_id is null and nullif(btrim(r.descripcion), '') is not null then
    select p.catalogo_detalle, p.etiqueta, p.directo_al_area, p.marca_atendido
      into v_det, v_etq, v_dir, v_marca
      from biobox_app_palabras p
     where p.unidad_negocio = r.unidad_negocio and p.activo
       and unaccent_inmutable(lower(r.descripcion)) ~ p.patron
     order by p.prioridad, p.id
     limit 1;
  end if;

  if v_det is null then
    return null;
  end if;

  update biobox_app_reportes
     set sugerencia_detalle = v_det,
         etiqueta           = coalesce(r.etiqueta, v_etq),
         marca_atendido     = v_marca
   where report_id = p_report_id;

  -- Fallas de la máquina sin máquina: pasan por la validadora, que le pone la
  -- máquina antes de que llegue al técnico. Reciclaje (Erik, 17-nov-2026) y
  -- SIM (Erik, 20-nov-2026). Lo de la aplicación (TI) sigue directo sin máquina.
  if not coalesce(v_dir, false)
     or (r.clave_inventario is null
         and lower(v_det) in (lower('Falla en el proceso de reciclaje'),
                              lower('SIM sin datos'),
                              lower('SIM desactivado'))) then
    return 'sugerido';
  end if;

  -- Directo al área: la fila del catálogo de la unidad.
  select jsonb_build_object('detalle', c.detalle, 'area', c.area, 'impacto', c.impacto,
                            'origen', c.origen, 'tipo', c.tipo)
    into v_falla
    from catalogo_incidencias c
   where lower(btrim(c.unidad_negocio)) = lower(r.unidad_negocio)
     and c.detalle = v_det
   order by c.id
   limit 1;
  if v_falla is null then
    return 'sugerido';
  end if;

  -- Sin duplicados: misma máquina y misma falla abierta → se liga.
  v_clave := r.clave_inventario;
  if v_clave is not null then
    select i.record_id into v_dup
      from incidencias i
     where i.clave_medio = v_clave
       and lower(i.unidad_negocio) = lower(r.unidad_negocio)
       and lower(i.nombre_incidencia) = lower(v_det)
       and i.estatus in ('por_validar', 'en_proceso', 'reparado', 'rechazada')
     order by i.creado_en desc
     limit 1;
    if v_dup is not null then
      update biobox_app_reportes
         set decision = 'ligado', record_id = v_dup, decidido_en = now()
       where report_id = p_report_id;
      return 'ligado';
    end if;
  end if;

  v_rec := biobox_app_crear_incidencia(p_report_id, v_falla, v_clave, null, null);
  update biobox_app_reportes
     set decision = 'directo', record_id = v_rec, decidido_en = now()
   where report_id = p_report_id;
  return 'directo';
end $function$;
revoke all on function public.biobox_app_auto(bigint) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Causas del checklist.
-- ─────────────────────────────────────────────────────────────────────────
insert into public.checklist_causas
  (medio, tipo_mueble, grupo, punto_texto, causa, prioridad, genera_orden,
   incidencia_detalle)
select 'Ambas', m.mueble, 'Energía y conexión', 'El Teltonika está en línea',
       c.causa, 'Alta', true, c.causa
  from (values (1, 'SIM sin datos'), (2, 'SIM desactivado')) as c(orden, causa)
 cross join (values (1, 'M4'), (2, 'M4-R2'), (3, 'M5')) as m(orden, mueble)
 where not exists (
         select 1
           from public.checklist_causas x
          where x.punto_texto = 'El Teltonika está en línea'
            and lower(btrim(x.causa)) = lower(c.causa)
            and upper(btrim(x.tipo_mueble)) = m.mueble
       )
 order by c.orden, m.orden;
