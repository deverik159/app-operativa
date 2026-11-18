-- ============================================================
-- 18-nov-2026 · Incidencias · Árbol de Digital
-- Qué: nueva rama en «Falla en el proceso de reciclaje» para cuando el
--      técnico revisa y la máquina no tiene falla:
--        incidencia SRD  Máquina no presenta falla
--        causa raíz      N/A
--        diagnóstico     (vacío: el paso se salta, como en las demás
--                        filas de esta falla)
--        solución        Sin intervención digital; equipo operando
--                        correctamente tras revisión técnica.
--        categoría       Procesos y Gestión
--        SLA             6 / 8 / 12 h (mín / normal / fuera)
--        equipo          sin cambio de equipo (NULL)
-- Por qué: Erik (18-nov-2026). Datos de Erik; la categoría y dejar el
--      diagnóstico vacío los eligió él entre opciones (la causa necesita
--      texto para poder elegirse en la reparación).
-- Re-ejecutable: no la duplica si ya existe.
-- ============================================================

insert into public.arbol_digital
  (incidencia, categoria_principal, incidencia_srd, causa_raiz, diagnostico,
   solucion, sla_min, sla, sla_fuera, equipo)
select
  'Falla en el proceso de reciclaje',
  'Procesos y Gestión',
  'Máquina no presenta falla',
  'N/A',
  null,
  'Sin intervención digital; equipo operando correctamente tras revisión técnica.',
  6, 8, 12,
  null
where not exists (
  select 1 from public.arbol_digital
  where incidencia = 'Falla en el proceso de reciclaje'
    and incidencia_srd = 'Máquina no presenta falla'
);
