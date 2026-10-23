-- Rol "supervisor" (etiqueta «Supervisor»; Erik, 22-oct-2026): encargado de
-- los analistas en Comprobaciones. Carga el periodo, asigna y reasigna
-- analistas, ve el avance del equipo y cierra o reabre campañas.
--
-- Va sola: Postgres no deja usar un valor nuevo de un enum en la misma
-- transacción en que se agrega, y comp_base (la migración siguiente) ya lo
-- usa en sus funciones y políticas (lección de 20261020172933_rol_analista.sql).
alter type public.app_role add value if not exists 'supervisor';
