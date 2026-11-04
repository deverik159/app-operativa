-- 4-nov-2026 · Incidencias (catálogo) · Erik
-- «Recolección de reciclaje» de Biobox México pasa de Ecodrann a Op. Bio Box:
-- Ecodrann no tiene técnicos y la recolección la atiende Op. Bio Box.
-- Solo Biobox México (5 renglones: M4, M5, M5 OXXO, M4 URBANA y M4-R2);
-- Biobox Perú se queda en Ecodrann por decisión de Erik.
-- Solo cambia el catálogo: las incidencias ya capturadas no se tocan aquí
-- (BBOXXO00005 se mueve con «Corrección» desde la app, que avisa al área nueva).
-- Re-ejecutable: la segunda vez no encuentra renglones con Ecodrann.

update catalogo_incidencias
   set area = 'Op. Bio Box',
       area_resp_code = 'OPB'
 where detalle = 'Recolección de reciclaje'
   and area = 'Ecodrann'
   and unidad_negocio = 'BioBox';
