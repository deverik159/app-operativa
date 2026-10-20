-- Rol "analista" (20-oct-2026): recibe del coordinador las fotos comprobadas
-- de Pauta por campaña, las revisa y, si hace falta, sube la versión editada.
--
-- Va sola: un valor nuevo de un enum no se puede usar en la misma
-- transacción en que se agrega, y la migración de los envíos ya lo usa.
alter type public.app_role add value if not exists 'analista';
