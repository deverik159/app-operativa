-- ============================================================
-- verificar_mis_notificaciones.sql
-- Confirma qué DEBERÍA ver cada usuario en su campana, y compáralo con lo
-- que la app le muestra de verdad.
--
-- El SQL Editor se salta la RLS, así que aquí simulamos a mano el filtro
-- de la política notif_sel: lower(para_email) = lower(auth_email()).
-- ============================================================


-- 1) Lo que le toca a cada correo: cuántas tiene y cuántas sin leer.
--    Si tu correo aparece con total > 0 pero la campana está vacía en la
--    app, el problema es de sesión (auth_email() no coincide), no de datos.
select lower(para_email) as correo,
       count(*)                            as total,
       count(*) filter (where not leida)   as sin_leer,
       max(creado_en)                      as mas_reciente
from notificaciones
group by 1
order by total desc;


-- 2) Las 20 más recientes de UN correo específico.
--    Cambia el correo por el del usuario con el que probaste.
select id, evento, mensaje, leida, creado_en
from notificaciones
where lower(para_email) = lower('mejia.erik@gpovallas.com')
order by creado_en desc
limit 20;


-- 3) ¿A quién notificaría un cambio de estatus a 'en_proceso' de una
--    incidencia dada? Reproduce la consulta interna de notificar_incidencia.
--    Si devuelve 0 filas, ese es el motivo de que nadie reciba nada:
--    no hay usuarios de reparación que casen unidad + departamento.
--    Cambia el record_id por uno real que hayas usado en tu prueba.
with inc as (
  select * from incidencias where record_id = '1b41bb9a'
)
select distinct lower(ur.usuario_email) as recibiria,
       ur.unidad_negocio, ur.departamento
from usuario_roles ur, inc
where ur.rol = 'reparacion'
  and ur.unidad_negocio ilike inc.unidad_negocio
  and (inc.area_responsable is null or ur.departamento ilike inc.area_responsable);


-- 4) Panorama: qué roles de reparación existen y con qué alcance.
--    Un departamento mal escrito (o null donde debía tener valor) hace que
--    las notificaciones no encuentren destinatario.
select rol, unidad_negocio, departamento, count(*) as usuarios,
       string_agg(distinct lower(usuario_email), ', ') as correos
from usuario_roles
where rol in ('reparacion','validador')
group by rol, unidad_negocio, departamento
order by rol, unidad_negocio, departamento;
