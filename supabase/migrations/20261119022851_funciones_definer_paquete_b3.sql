-- ============================================================
-- funciones_definer_paquete_b3 — asignar monitoristas solo en rutas de tu
-- unidad (Plataforma, 18-nov-2026).
--
-- POR QUÉ. ra_ins y ra_del de ruta_asignaciones solo pedían
-- tiene_rol('coordinador') o manager: un coordinador de cualquier unidad
-- podía asignar o quitar monitoristas en rutas de otra unidad por la API
-- (y disparar el aviso "se te retiró la ruta"). Lo encontró revisor-rls al
-- revisar el paquete B2.
--
-- DECISIÓN (Erik, 18-nov-2026): cualquier coordinador de la unidad de la
-- ruta (o sin unidad) puede asignar, aunque la ruta sea de otro coordinador
-- de esa unidad; el manager, siempre. No se exige ser el dueño.
--
-- La pantalla AsignarMonitoristas escribe esta tabla directo. No hay
-- política de UPDATE (los cambios son baja y alta). Hoy hay 1 asignación.
--
-- Re-ejecutable.
-- ============================================================

alter policy ra_ins on public.ruta_asignaciones
  with check (exists (select 1 from rutas_monitoreo r
                       where r.id = ruta_asignaciones.ruta_id
                         and rol_en_unidad(array['coordinador']::app_role[], r.unidad_negocio)));

alter policy ra_del on public.ruta_asignaciones
  using (exists (select 1 from rutas_monitoreo r
                  where r.id = ruta_asignaciones.ruta_id
                    and rol_en_unidad(array['coordinador']::app_role[], r.unidad_negocio)));

-- Verificar: con sesiones simuladas, un coordinador de Biobox no pasa la
-- condición para una ruta de Ecovallas y uno de Ecovallas sí; el manager
-- pasa en todas.
