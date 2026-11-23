-- ============================================================
-- 23-nov-2026 · Incidencias · Catálogo
-- Qué: «Chapa dañada» pasa del área Op. Bio Box a TI en el catálogo de
--      Biobox (México): M4, M4 URBANA, M4-R2, M5 y M5 OXXO. Se llena también
--      area_resp_code = TI, como las demás fallas de TI.
-- Por qué: Erik (23-nov-2026): esa falla la atiende TI.
-- Efectos: lo que se reporte desde ahora con esa falla va a TI, también lo
--      que levante la revisión de Biobox por sus causas del checklist
--      (checklist_causas.incidencia_detalle: «Llave frontal inferior» y
--      «Llave de gabinete»). Las incidencias existentes no cambian (hay 1
--      abierta en Op. Bio Box; se mueve con Corrección del validador si se
--      quiere). Origen, tipo, impacto y SLA de cada fila se quedan igual.
--      Solo existe en Biobox México; no hay palabras ni equivalencias de la
--      app Biobox que la usen.
-- Re-ejecutable: solo toca las filas que siguen en Op. Bio Box.
-- ============================================================

update public.catalogo_incidencias
   set area = 'TI',
       area_resp_code = 'TI'
 where lower(btrim(detalle)) = 'chapa dañada'
   and lower(btrim(unidad_negocio)) = 'biobox'
   and lower(btrim(area)) = 'op. bio box';
