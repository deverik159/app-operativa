-- ============================================================
-- bitacora_vv_baja_edomex.sql — baja de las columnas de EDO MEX
-- Correr una vez en Supabase → SQL Editor.
--
-- POR QUÉ (Erik, 22-sep-2026): las columnas del Estado de México se
-- retiraron este año y no habrá más. Se DESACTIVAN, no se borran: si
-- alguna pauta vieja las referencia, el historial sigue completo, y la
-- app (que solo carga activo=true) deja de ofrecerlas — el botón
-- "Columnas EDO MEX" y su sección desaparecen solos.
-- ============================================================

update vv_espacios
set activo = false
where tipo_espacio = 'columna' and tramo = 'EDO MEX';

-- Verificación: 10 desactivadas; deben quedar 51 columnas + 4 pórticos activos.
select tipo_espacio, activo, count(*)
from vv_espacios
group by tipo_espacio, activo
order by tipo_espacio, activo;
