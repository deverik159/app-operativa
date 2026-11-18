-- ============================================================
-- 18-nov-2026 · Incidencias · Catálogo
-- Qué: «NUC con fallas» pasa del área Digital a TI en el catálogo de
--      Biobox (M4, M5, M5 OXXO, M4 URBANA, M4-R2) y Biobox Perú (M5).
-- Por qué: Erik (18-nov-2026): esa falla la atiende TI. Además, con área
--      Digital no salía en la lista de Nueva incidencia: en Biobox las
--      fallas de Digital salen solo del árbol de Digital (catalogoBiobox,
--      regla 2) y el árbol no tiene ninguna de NUC. Con área TI sale como
--      las demás fallas de TI de la máquina (regla 4).
-- Efectos: lo que se reporte desde ahora con esa falla va a TI, también lo
--      que levante la revisión de Biobox por sus 3 causas del checklist
--      (checklist_causas.incidencia_detalle). Las incidencias existentes no
--      cambian (hay 1 con ese nombre y está cerrada). Nivel, origen, tipo y
--      SLA de cada fila se quedan igual.
-- Re-ejecutable: solo toca las filas que siguen en Digital.
-- ============================================================

update public.catalogo_incidencias
   set area = 'TI',
       area_resp_code = 'TI'
 where lower(btrim(detalle)) = 'nuc con fallas'
   and lower(btrim(area)) = 'digital';
