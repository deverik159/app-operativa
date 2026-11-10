-- 10-nov-2026 · Reportes de la app Biobox: Biobox Perú en pausa
--
-- Qué hace (decisión de Erik del 10-nov-2026): mientras no haya quien
--   clasifique y repare en Biobox Perú, sus reportes no deben aparecer ni
--   crear incidencias.
--   · Se desactivan las equivalencias de Biobox Perú: un reporte nuevo de Perú
--     de puntos ya no nace como incidencia directa a TI; se queda guardado
--     como pendiente (sin decisión), escondido.
--   · La bandeja de la app ya no enseña Perú (UNIDADES_APP_BIOBOX en
--     src/lib/reportesAppBiobox.ts).
--   Los reportes de Perú se SIGUEN cargando: si el monitor dejara de mandarlos,
--   quedarían «ausentes» y el freno del 80 % pararía toda la carga.
-- Para reactivar: volver a poner activo = true en estas filas (el manager lo
--   puede hacer; la tabla es suya) y agregar 'Biobox Perú' en la app. OJO
--   (revisor-rls): los reportes de puntos que lleguen DURANTE la pausa no se
--   vuelven directos a TI al reactivar (eso solo pasa al entrar); quedan por
--   clasificar a mano, salvo los que Biobox marque Atendido antes.
-- No toca las 5 incidencias de Perú que ya existen (BBP00001-BBP00005):
--   eso lo decide Erik aparte.

set local lock_timeout = '5s';

update public.biobox_app_equivalencias
   set activo = false
 where unidad_negocio = 'Biobox Perú'
   and activo;
