-- ============================================================
-- Incidencias → Google Sheets: la incidencia técnica de Digital
-- (Erik, 26-nov-2026)
--
-- Además de la falla que reporta el usuario («Pantalla en negro»), el
-- técnico de Digital elige la suya del árbol (arbol_digital →
-- incidencias.incidencia_srd: «NUC Pasmado», «Corte de Fibra Telmex»…).
-- La base general la trae en «Incidencia Digital»; el botón de Ecovallas
-- Digital la escribe en una columna propia al final (su columna de falla
-- usa las del usuario: su lista tiene 2 de las 73 técnicas, 26-nov-2026).
--
-- Solo agrega la llave 'incidenciadigital' a vw_incidencias_sheets; lo
-- demás es igual a 20261124171724. El trigger de cambios ya encola
-- cualquier cambio de la incidencia, también el de incidencia_srd.
-- ============================================================

-- security_invoker: la vista no abre nada por sí sola; además nadie más
-- que service_role la puede leer (lleva contactos de MKT y de la app).
create or replace view public.vw_incidencias_sheets
with (security_invoker = on) as
select
  i.record_id,
  i.folio,
  i.unidad_negocio,
  -- Texto: se escribe tal cual (la función lo protege para que Sheets no
  -- lo convierta en fecha, número o fórmula).
  jsonb_build_object(
    'folio',                 i.folio,
    'unidad',                i.unidad_negocio,
    -- La cara de la clave de medio, como caraLabel de la app y como la
    -- escribe la hoja de Ecovallas Fijas: MX_CM_EV_LUM_11_3318 → «11»,
    -- MX_EM_EV_MGV_1-2_0009 → «1 a 2». Vía Verde (5 partes) queda vacía.
    'cara',                  case when array_length(string_to_array(i.clave_medio, '_'), 1) >= 6
                                  then nullif(replace(ltrim(split_part(i.clave_medio, '_', 5), '0'), '-', ' a '), '')
                             end,
    -- MKT anota por dónde le llegó la solicitud; lo demás entró por la app.
    'viadereporte',          coalesce(nullif(btrim(i.via_reporte), ''), 'App'),
    'campana',               nullif(btrim(i.campania), ''),
    -- BB Gral: «BB 110» sale de la clave MX_CM_BB_MED_0110 (por confirmar
    -- con Erik). Sin máquina queda vacío.
    'id',                    case when lower(i.unidad_negocio) = 'biobox' and i.clave_sitio ~ '_[0-9]+$'
                                  then 'BB ' || coalesce(nullif(ltrim(substring(i.clave_sitio from '_([0-9]+)$'), '0'), ''), '0')
                             end,
    'nombre',                coalesce(nullif(btrim(i.nombre_biobox), ''), i.direccion),
    'clavedesitio',          i.clave_sitio,
    'clavedemedio',          i.clave_medio,
    'nomenclatura',          i.clave_medio,
    'direccion',             i.direccion,
    'alcaldia',              i.municipio,
    'alcaldiamunicipio',     i.municipio,
    -- VV Gral escribe la plaza como CDMX / EDO MEX.
    'plaza',                 case when lower(i.unidad_negocio) = 'vía verde'
                                  then case i.plaza when 'Ciudad de México' then 'CDMX'
                                                    when 'México' then 'EDO MEX'
                                                    else i.plaza end
                                  else i.plaza end,
    'lado',                  case when lower(i.unidad_negocio) = 'vía verde'
                                  then upper(coalesce(nullif(btrim(i.lado), ''), 'N/A'))
                                  else i.lado end,
    'areareportante',        i.area_reportante,
    'incidencia',            i.nombre_incidencia,
    -- La que eligió el técnico de Digital del árbol (vacía si no aplica).
    'incidenciadigital',     nullif(btrim(i.incidencia_srd), ''),
    'detalledeincidencia',   i.observaciones,
    'detalledelaincidencia', i.observaciones,
    -- El área que repara: la reasignada si hubo reasignación.
    'arearesponsable',       coalesce(nullif(btrim(i.assigned_area), ''), i.area_responsable),
    'detallereparacion',     coalesce(nullif(btrim(i.detalle_reparacion), ''), nullif(btrim(i.solucion), '')),
    'detalledereparacion',   coalesce(nullif(btrim(i.detalle_reparacion), ''), nullif(btrim(i.solucion), '')),
    -- estatus_inicial de la tabla está vacío (era de la app anterior): lo
    -- que llega de la app Biobox nace validado y lo de fuera de horario
    -- entra directo al área.
    'estatusinicial',        case when i.area_reportante = 'App Biobox'
                                    or coalesce(i.requiere_prevalidacion, false)
                                  then 'En proceso' else 'Por validar' end,
    -- Con las palabras de las hojas Gral: «Reparado» es el cierre.
    'estatusfinal',          case i.estatus::text
                               when 'reportado'   then 'Reportado'
                               when 'por_validar' then 'Por validar'
                               when 'rechazada'   then 'Devuelta'
                               when 'en_proceso'  then 'En proceso'
                               when 'reparado'    then 'Reparado por aprobar'
                               when 'cerrada'     then 'Reparado'
                               when 'no_reparado' then 'No reparado'
                               when 'duplicada'   then 'Duplicada'
                               else i.estatus::text
                             end,
    -- La incidencia no guarda la afectación: sale del catálogo (BB la
    -- llama Clasificación).
    'afectacion',            cat.afectacion,
    'clasificacion',         cat.afectacion,
    'niveldeincidencia',     nullif(btrim(i.nivel), ''),
    'origendeincidencia',    i.origen,
    'origenincidencia',      i.origen,
    'causa',                 i.tipo,
    'tipoafectacion',        case when lower(i.unidad_negocio) = 'biobox' then 'Mueble' end,
    'tipodemaquina',         i.tipo_mueble,
    'negocio',               case lower(i.unidad_negocio)
                               when 'biobox'    then 'Maquinas'
                               when 'ecovallas' then case when i.medio = 'Digital' then 'Digitales ' else 'Fijas ' end
                                                     || extract(year from t.dia)::int
                               when 'vía verde' then 'VV ' || extract(year from t.dia)::int
                               else i.unidad_negocio
                             end,
    'trimestre',             'Q' || extract(quarter from t.dia)::int,
    -- MKT lo captura en la incidencia; el de la app Biobox llega aparte
    -- (Erik, 24-nov-2026: se llenan todos).
    'correo',                coalesce(nullif(btrim(i.contacto_correo), ''), app.correo),
    'telefono',              coalesce(nullif(btrim(i.contacto_telefono), ''), app.telefono)
  ) as texto,
  -- Fechas (día de CDMX, AAAA-MM-DD), tiempos y números: Sheets los
  -- convierte con el formato de la hoja.
  jsonb_build_object(
    'fechareporte',          to_char(t.dia, 'YYYY-MM-DD'),
    'fechadereparacion',     to_char(t.dia_rep, 'YYYY-MM-DD'),
    'fechareparacion',       to_char(t.dia_rep, 'YYYY-MM-DD'),
    'horareporte',           to_char(i.fecha_reporte at time zone 'America/Mexico_City', 'HH24:MI'),
    'horadereparacion',      to_char(i.repaired_at   at time zone 'America/Mexico_City', 'HH24:MI'),
    'catorcena',             i.catorcena,
    -- El domingo que cierra la semana del reporte, como en las hojas Gral.
    'fechames',              to_char(date_trunc('week', t.dia)::date + 6, 'YYYY-MM-DD'),
    'semana',                case when i.semana ~ '^[0-9]+$' then i.semana::int end,
    -- Del reporte a la reparación, reloj corrido.
    'tiempo',                case when t.seg is not null then
                               floor(t.seg / 3600)::bigint || ':'
                               || lpad(floor(mod(t.seg, 3600) / 60)::int::text, 2, '0') || ':'
                               || lpad(floor(mod(t.seg, 60))::int::text, 2, '0')
                             end,
    'tiempohoras',           round(t.seg / 3600, 2)
  ) as dato
from public.incidencias i
cross join lateral (
  select
    (i.fecha_reporte at time zone 'America/Mexico_City')::date as dia,
    (i.repaired_at   at time zone 'America/Mexico_City')::date as dia_rep,
    -- Sin reparar queda vacío (greatest ignora el null y daría 0).
    case when i.repaired_at is not null and i.fecha_reporte is not null
         then greatest(extract(epoch from (i.repaired_at - i.fecha_reporte)), 0)
    end as seg
) t
left join lateral (
  -- La que tenga afectación, primero la del mismo mueble. Hay filas del
  -- catálogo con la afectación vacía cuando otro mueble con la misma falla
  -- sí la tiene (8 folios de Biobox el 24-nov-2026), y ninguna falla tiene
  -- dos afectaciones distintas. Las del árbol Digital que no están en el
  -- catálogo quedan vacías.
  select c.afectacion
    from public.catalogo_incidencias c
   where lower(c.unidad_negocio) = lower(i.unidad_negocio)
     and c.detalle = i.nombre_incidencia
   order by (c.afectacion is null), (c.tipo_mueble is not distinct from i.tipo_mueble) desc, c.id
   limit 1
) cat on true
left join lateral (
  -- Igual que contactos_app_biobox: un correo junto a SU teléfono cuando
  -- la incidencia tiene varios reportes.
  select string_agg(coalesce(ct.correo, '—'),   ' / ' order by ct.report_id) as correo,
         string_agg(coalesce(ct.telefono, '—'), ' / ' order by ct.report_id) as telefono
    from public.biobox_app_reportes r
    join public.biobox_app_contactos ct on ct.report_id = r.report_id
   where r.record_id = i.record_id
) app on true;

revoke all on table public.vw_incidencias_sheets from public, anon, authenticated;
grant select on table public.vw_incidencias_sheets to service_role;
