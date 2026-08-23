-- ============================================================
-- diagnostico_biobox_2.sql
-- Solo LECTURA. Segunda tanda, con lo que el primer diagnóstico dejó abierto.
--
-- Lo que ya quedó claro y NO hay que volver a preguntar:
--   • `site_legacy_id` es el NOMBRE de la máquina ("ALBERCA OLÍMPICA"),
--     no el número.
--   • El número del mapa es el SUFIJO de `site_id`:
--     "Alberca Olímpica - 99" → MX_CM_BB_MEC_0099.  Comprobado 10/10.
--   • 202 máquinas, una cara cada una, casi todas con coordenadas.
--   • `ruta_ubicaciones` es UNIQUE(site_id): el importador puede usar
--     `on conflict (site_id)`.
--   • Biobox mezcla 125 Digital y 77 Impreso.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Comprobar el empate por número en las 202, no solo en 10
-- ------------------------------------------------------------
-- Debe salir una fila por máquina, con `numero` lleno y sin repetidos.
-- Si `repetidos` trae algo, dos máquinas comparten número y el empate
-- automático no puede decidir sola cuál es cuál.
with n as (
  select site_id,
         site_legacy_id,
         tipo_medio,
         (regexp_match(site_id, '(\d+)$'))[1]::int as numero
  from inventario
  where unidad_negocio = 'Biobox'
)
select count(*) as maquinas,
       count(numero) as con_numero,
       min(numero) as menor,
       max(numero) as mayor
from n;

-- Números repetidos (esperado: 0 filas).
with n as (
  select site_id, (regexp_match(site_id, '(\d+)$'))[1]::int as numero
  from inventario
  where unidad_negocio = 'Biobox'
)
select numero, count(*), string_agg(site_id, ', ') as claves
from n
group by numero
having count(*) > 1
order by numero;


-- ------------------------------------------------------------
-- 2. EL DATO QUE FALTA: el catálogo de incidencias de Biobox
-- ------------------------------------------------------------
-- La vez pasada solo llegó el conteo por área. Necesito los `detalle`
-- para poder ligar cada punto del checklist con su incidencia; de ahí
-- salen el área, el nivel y el SLA sin que el revisor sepa nada de eso.
--
-- Si son muchas, con las de estas áreas basta para empezar.
select area, detalle, trim(impacto) as impacto, origen, tipo, tipo_mueble
from catalogo_incidencias
where unidad_negocio ilike '%biobox%'
  and area in ('Op. Bio Box', 'Implementaciones', 'Digital', 'TI', 'Iluminación')
order by area, detalle;


-- ------------------------------------------------------------
-- 3. ¿Las rutas del mapa mezclan Digital con Impreso?
-- ------------------------------------------------------------
-- No cambia el código —el importador ya manda cada máquina a la ruta de su
-- segmento— pero sirve para saber qué esperar en la vista previa.
-- Se aproxima por municipio, que es lo más cercano a "zona" que hay hoy.
select municipio,
       count(*) filter (where tipo_medio = 'Digital') as digital,
       count(*) filter (where tipo_medio = 'Impreso') as impreso
from inventario
where unidad_negocio = 'Biobox'
group by municipio
order by count(*) desc
limit 15;


-- ------------------------------------------------------------
-- 4. El trigger de segmento, para tenerlo documentado
-- ------------------------------------------------------------
-- El importador está escrito para NO tener que tocarlo. Esto es solo para
-- dejar constancia de qué valida, por si algún día estorba.
select pg_get_functiondef(p.oid) as definicion
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'ruta_ubic_valida_segmento';


-- ------------------------------------------------------------
-- 5. `bitacoras`: ¿tiene historia que valga la pena conservar?
-- ------------------------------------------------------------
-- La tabla ya existe (unidad, clave_sitio, nombre_biobox, operador, estado,
-- observaciones, evidencia_url, incidencia_record_id). Es una versión
-- primitiva de lo que ahora hace `revisiones`, del módulo de Bitácora que se
-- descartó. Si tiene filas, conviene mostrarlas dentro de la hoja de vida en
-- vez de dejarlas huérfanas.
select count(*) as filas,
       count(distinct clave_sitio) as maquinas,
       min(creado_en) as primera,
       max(creado_en) as ultima
from bitacoras;

select estado, count(*)
from bitacoras
group by estado
order by 2 desc;
