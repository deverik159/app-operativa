-- ============================================================
-- area_reportante_mkt — lo que MKT levantó con su formulario queda con
-- área que reporta = MKT (Erik, 27-sep-2026). Re-ejecutable. Solo datos:
-- no cambia estructura ni permisos.
--
-- Por qué: area_reportante se llenaba con el PRIMER departamento de todas
-- las filas de rol del usuario, y "departamento" significa pertenencia en
-- reportante/validador pero área técnica en técnico/coordinador. Con otra
-- fila antes, lo que levantaba MKT salía con otra área y no aparecía en el
-- filtro "Reporta" ni en sus indicadores. La app ya pone el área de
-- pertenencia primero (departamentosDelUsuario en src/lib/helpers.ts).
--
-- A cuáles: SOLO las capturadas con el formulario de MKT. Ese formulario
-- exige correo del solicitante y vía de reporte, y ningún otro flujo los
-- llena: contacto_correo o via_reporte no nulos = reporte de MKT.
--
-- No dispara notificaciones: los triggers de incidencias reaccionan a
-- estatus, área responsable y área asignada, no a esta columna.
-- ============================================================
set lock_timeout = '5s';

update public.incidencias
set area_reportante = 'MKT'
where (contacto_correo is not null or via_reporte is not null)
  and area_reportante is distinct from 'MKT';

reset lock_timeout;

-- Cómo quedó: todas las de formulario MKT deben decir MKT.
select coalesce(area_reportante, '(vacía)') as area_reportante, count(*) as incidencias
from public.incidencias
where contacto_correo is not null or via_reporte is not null
group by 1
order by 2 desc;
