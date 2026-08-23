-- ============================================================
-- importar_rutas_capas.sql
-- Convierte las capas de un mapa de My Maps en rutas de monitoreo.
--
-- Es la hermana de `importar_rutas` (la del Excel de Ecovallas), pero para un
-- origen distinto: allá las rutas venían numeradas en una columna, aquí
-- vienen como CAPAS CON NOMBRE ("Ruta Gael", "Ruta Tona"). Se necesita una
-- función aparte porque el número de ruta no existe en el archivo: hay que
-- inventarlo y, sobre todo, MANTENERLO ESTABLE entre reimportaciones.
--
-- CÓMO SE CONSERVA LA IDENTIDAD DE LA RUTA: se busca por nombre dentro del
-- segmento (unidad + tipo de medio). Si ya existe, se reutiliza su número y
-- su color. Solo las capas nuevas reciben número nuevo. Sin esto, cada
-- reimportación renumeraría todo y el histórico de revisiones quedaría
-- apuntando a rutas que cambiaron de nombre.
--
-- QUÉ NO HACE: no borra nada por default. Si una máquina se quitó del mapa,
-- se queda en su ruta hasta que alguien pida explícitamente la limpieza
-- (p_quitar_faltantes). Borrar en silencio deja huecos que nadie relaciona
-- con la importación de hace tres semanas.
--
-- POR QUÉ EXISTE p_conservar: "no vino en el mapa" y "no se importó" NO son
-- lo mismo. En la vista previa el usuario desmarca los empates dudosos, y
-- esta función omite las claves que no están en el segmento. Esas máquinas
-- SÍ estaban en el mapa. Si la limpieza se guiara solo por lo insertado, la
-- primera importación con la casilla marcada las sacaría de su ruta —justo
-- lo contrario de lo que dice la casilla—. El frontend manda en p_conservar
-- los site_id que vio en el mapa pero no incluyó, y la limpieza los respeta.
--
-- EL TIPO DE MEDIO VIENE POR PARADA, NO POR IMPORTACIÓN. Biobox tiene 125
-- máquinas Digital y 77 Impreso, y las capas del mapa son GEOGRÁFICAS: una
-- ruta puede llevar de los dos. Pero `ruta_ubicaciones` tiene el trigger
-- `ruta_ubic_valida_segmento`, que exige que la ubicación coincida con el
-- tipo de medio de SU ruta. Una ruta mixta, hoy, no puede existir.
--
-- En vez de aflojar ese trigger —que también cuida a Ecovallas— cada parada
-- entra a la ruta de SU segmento. Si la capa "Ruta Tona" es toda Digital, se
-- crea una sola ruta y no se nota nada. Si viene mezclada, quedan dos filas
-- en `rutas_monitoreo` con el mismo nombre y distinto tipo. La vista de
-- Biobox agrupa por NOMBRE, así que el monitorista sigue viendo una sola
-- ruta: la partición es interna y no le llega.
--
-- p_capas: [{ nombre, paradas: [{ site_id, secuencia, tipo_medio }] }]
-- p_conservar: site_id[] que venían en el mapa pero no se importaron
--
-- Es seguro re-ejecutar este archivo: solo define funciones.
-- Aplicar después de revisiones_schema.sql.
-- ============================================================

create or replace function importar_rutas_capas(
  p_unidad            text,
  p_capas             jsonb,
  p_quitar_faltantes  boolean default false,
  p_conservar         text[]  default '{}'
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_capa        jsonb;
  v_parada      jsonb;
  v_nombre      text;
  v_ruta_id     bigint;
  v_numero      int;
  v_color       text;
  v_site        text;
  v_tipo        text;
  v_rutas_new   int := 0;
  v_rutas_usadas bigint[] := '{}';
  v_ubics       int := 0;
  v_omitidas    int := 0;
  v_movidas     int := 0;
  v_quitadas    int := 0;
  v_omitidos_ej text[] := '{}';
  v_sites_vistos text[] := '{}';
  v_protegidos  text[] := '{}';
  -- Paleta fija: mismo orden de capas → mismos colores en cada importación.
  v_paleta text[] := array[
    '#4f8cff', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa',
    '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6',
    '#8b5cf6', '#eab308'
  ];
  v_i int := 0;
begin
  -- 1) Permiso. Mismas funciones que el resto del proyecto.
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'No tienes permiso para importar rutas (se requiere coordinador o manager).';
  end if;

  if p_unidad is null then
    raise exception 'Falta la unidad de negocio.';
  end if;
  if p_capas is null or jsonb_array_length(p_capas) = 0 then
    raise exception 'El archivo no trae capas con marcadores.';
  end if;

  -- 2) Capa por capa
  for v_capa in select * from jsonb_array_elements(p_capas)
  loop
    v_i := v_i + 1;
    v_nombre := nullif(trim(v_capa->>'nombre'), '');
    if v_nombre is null then
      v_nombre := 'Capa ' || v_i;
    end if;

    -- 3) Paradas de la capa. La ruta se resuelve DENTRO del ciclo, porque
    --    depende del tipo de medio de cada máquina (ver el encabezado).
    for v_parada in select * from jsonb_array_elements(coalesce(v_capa->'paradas', '[]'::jsonb))
    loop
      v_site := nullif(trim(v_parada->>'site_id'), '');
      if v_site is null then
        v_omitidas := v_omitidas + 1;
        continue;
      end if;

      -- El tipo de medio se toma de INVENTARIO, no de lo que mande el
      -- frontend: es la única fuente que el trigger va a aceptar. De paso
      -- comprueba que la máquina exista en esta unidad; si no, se omite la
      -- fila y se sigue, en vez de abortar la importación completa por una
      -- máquina mal empatada.
      select tipo_medio into v_tipo
      from inventario
      where site_id = v_site and unidad_negocio = p_unidad
      limit 1;

      if v_tipo is null then
        v_omitidas := v_omitidas + 1;
        if array_length(v_omitidos_ej, 1) is null or array_length(v_omitidos_ej, 1) < 8 then
          v_omitidos_ej := v_omitidos_ej || v_site;
        end if;
        continue;
      end if;

      -- La ruta de ESTE segmento. Se busca por nombre (sin distinguir
      -- mayúsculas ni espacios de más: en el mapa se escribe a mano) y se
      -- reutiliza su número y color. Renumerar en cada importación dejaría
      -- el histórico de revisiones apuntando a rutas que cambiaron de
      -- identidad.
      select id, numero, color
        into v_ruta_id, v_numero, v_color
      from rutas_monitoreo
      where unidad_negocio = p_unidad
        and tipo_medio = v_tipo
        and lower(regexp_replace(coalesce(nombre, ''), '\s+', ' ', 'g')) =
            lower(regexp_replace(v_nombre, '\s+', ' ', 'g'))
      limit 1;

      if v_ruta_id is null then
        insert into rutas_monitoreo (
          numero, nombre, color, unidad_negocio, tipo_medio, descripcion, activa
        )
        select
          coalesce(max(numero), 0) + 1,
          v_nombre,
          v_paleta[1 + (v_i - 1) % array_length(v_paleta, 1)],
          p_unidad,
          v_tipo,
          'Importada del mapa de My Maps',
          true
        from rutas_monitoreo
        where unidad_negocio = p_unidad and tipo_medio = v_tipo
        returning id into v_ruta_id;

        v_rutas_new := v_rutas_new + 1;
      end if;

      -- Una máquina vive en UNA ruta: ruta_ubicaciones tiene UNIQUE(site_id).
      -- Si ya estaba en otra, se mueve y se cuenta, porque mover máquinas
      -- entre rutas es justo lo que hace la gente al reorganizar el mapa.
      if exists (
        select 1 from ruta_ubicaciones
        where site_id = v_site and ruta_id <> v_ruta_id
      ) then
        v_movidas := v_movidas + 1;
      end if;

      insert into ruta_ubicaciones (ruta_id, site_id, secuencia)
      values (v_ruta_id, v_site, nullif(v_parada->>'secuencia', '')::int)
      on conflict (site_id) do update
        set ruta_id   = excluded.ruta_id,
            secuencia = excluded.secuencia;

      v_ubics := v_ubics + 1;
      v_sites_vistos := v_sites_vistos || v_site;
      if not (v_ruta_id = any(v_rutas_usadas)) then
        v_rutas_usadas := v_rutas_usadas || v_ruta_id;
      end if;
    end loop;
  end loop;

  -- 4) Limpieza opcional: máquinas que están en rutas de esta UNIDAD pero
  --    ya no aparecen en el mapa. Alcanza a los dos tipos de medio, porque
  --    el mapa es la lista completa de la unidad, no de un segmento.
  --    "Faltante" = no estaba en el mapa. Se protege tanto lo insertado
  --    (v_sites_vistos) como lo que el mapa traía pero no se importó
  --    (p_conservar). Ver la nota del encabezado.
  --
  --    OJO: si el arreglo protegido quedara vacío, el `not (x = any('{}'))`
  --    es TRUE para todas las filas y esto borraría el segmento completo. De
  --    ahí el guard.
  v_protegidos := v_sites_vistos || coalesce(p_conservar, '{}');

  if array_length(v_protegidos, 1) is null then
    v_quitadas := 0;
  elsif p_quitar_faltantes then
    delete from ruta_ubicaciones ru
    using rutas_monitoreo r
    where ru.ruta_id = r.id
      and r.unidad_negocio = p_unidad
      and not (ru.site_id = any(v_protegidos));
    get diagnostics v_quitadas = row_count;
  else
    select count(*)
      into v_quitadas
    from ruta_ubicaciones ru
    join rutas_monitoreo r on r.id = ru.ruta_id
    where r.unidad_negocio = p_unidad
      and not (ru.site_id = any(v_protegidos));
  end if;

  return jsonb_build_object(
    'rutas_creadas',      v_rutas_new,
    'rutas_usadas',       coalesce(array_length(v_rutas_usadas, 1), 0),
    'ubicaciones',        v_ubics,
    'movidas_de_ruta',    v_movidas,
    'omitidas',           v_omitidas,
    'omitidos_ejemplo',   to_jsonb(v_omitidos_ej),
    -- Si p_quitar_faltantes fue false, esto es un AVISO: cuántas sobran.
    'sobrantes',          v_quitadas,
    'sobrantes_borradas', p_quitar_faltantes
  );
end $$;

-- Se eliminan las firmas viejas si quedaron de una corrida previa: con varias
-- presentes, PostgREST no sabe cuál llamar y responde 300 Multiple Choices.
drop function if exists importar_rutas_capas(text, text, jsonb, boolean);
drop function if exists importar_rutas_capas(text, text, jsonb, boolean, text[]);

revoke all on function importar_rutas_capas(text, jsonb, boolean, text[]) from public;
grant execute on function importar_rutas_capas(text, jsonb, boolean, text[]) to authenticated;


-- ------------------------------------------------------------
-- Verificación (no importa nada, solo comprueba que existe)
-- ------------------------------------------------------------
select p.proname, pg_get_function_identity_arguments(p.oid) as argumentos
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('importar_rutas', 'importar_rutas_capas')
order by p.proname;
