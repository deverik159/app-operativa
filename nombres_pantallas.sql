-- ============================================================
-- nombres_pantallas.sql — nombres "amigables" de las pantallas de Ecovallas
-- Correr en Supabase → SQL Editor. Es seguro correrlo más de una vez:
-- re-siembra con upsert (la llave es la cara).
--
-- Como el nombre de máquina de los Biobox, pero para las megapantallas
-- (Erik, 17-sep-2026, 103 pantallas de su Excel). Va en TABLA PROPIA y
-- no en una columna de `inventario` a propósito: inventario se sincroniza
-- con QTM cada noche y una columna ajena podría no sobrevivir; además
-- site_legacy_id (donde vive el nombre de los Biobox) en Ecovallas trae el
-- id legado real. El nombre es POR CARA: en un mismo sitio, cada pantalla
-- tiene el suyo ("... 218 1/4", "... 218 2/4").
--
-- La app lo copia a incidencias.nombre_biobox al capturar — esa columna ya
-- es, en la práctica, "el nombre amigable del medio" y toda la tubería de
-- tarjetas y modales ya la enseña.
--
-- Para agregar o corregir nombres después: editar el VALUES y re-correr.
-- ============================================================

create table if not exists public.nombres_pantallas (
  vendor_face_id text primary key,
  nombre         text not null,
  actualizado_en timestamptz not null default now()
);

alter table public.nombres_pantallas enable row level security;

grant select on public.nombres_pantallas to authenticated;

drop policy if exists nombres_pantallas_sel on public.nombres_pantallas;
create policy nombres_pantallas_sel on public.nombres_pantallas
  for select to authenticated
  using (nullif(lower(coalesce(auth_email(), '')), '') is not null);
-- Sin política de escritura: los nombres se cargan por aquí, no desde la app.

insert into public.nombres_pantallas (vendor_face_id, nombre) values
  ('MX_CM_EV_MGP_08_2740', 'Tecamachalco 5'),
  ('MX_CM_EV_MGP_01_3579', 'Campos Elíseos 290'),
  ('MX_CM_EV_MGP_04_3233', 'Constituyentes 107'),
  ('MX_CM_EV_MGP_01_2958', 'Reforma 350'),
  ('MX_CM_EV_MGP_01_2094', 'Andres Bello (Hotel Presidente Campos Eliseos) 218 1/4'),
  ('MX_CM_EV_MGP_02_2094', 'Andres Bello (Hotel Presidente Campos Eliseos) 218 2/4'),
  ('MX_CM_EV_MGP_03_2094', 'Andres Bello (Hotel Presidente Campos Eliseos) 218 3/4'),
  ('MX_CM_EV_MGP_04_2094', 'Andres Bello (Hotel Presidente Campos Eliseos) 218 4/4'),
  ('MX_CM_EV_MGP_01_3434', 'Arquímedes 18'),
  ('MX_CM_EV_MGP_01_3591', 'Calle Arquímedes 173'),
  ('MX_CM_EV_MGP_05_3548', 'Horacio 1019'),
  ('MX_CM_EV_MGP_01_3546', 'Av. Homero 1127'),
  ('MX_CM_EV_MGP_01_3605', 'Av. Homero 1027'),
  ('MX_CM_EV_MGP_07_2920', 'Av. Río San Joaquín 434'),
  ('MX_CM_EV_MGP_07_3492', 'Viaducto 18 de julio 85 patriotismo'),
  ('MX_CM_EV_MGP_01_3147', 'Once De Abril 174'),
  ('MX_CM_EV_MGP_04_2219', 'Paseo De La Reforma 2603'),
  ('MX_CM_EV_MGP_12_3604', 'Paseo De Los Ahuehuetes 1221/bosques de la reforma'),
  ('MX_CM_EV_MGP_04_3074', 'Paseo De Las Palmas 1150'),
  ('MX_CM_EV_MGP_02_3236', 'Miguel De Cervantes Saavedra 565'),
  ('MX_CM_EV_MGP_03_2738', 'Av. Cuauhtémoc Eje 1 Poniente 267'),
  ('MX_CM_EV_MGP_01_3261', 'Insurgentes 363'),
  ('MX_CM_EV_MGP_01_3596', 'Av. Insurgentes Sur 324'),
  ('MX_CM_EV_MGP_15_3378', 'Av. Insurgentes Sur 171'),
  ('MX_CM_EV_MGP_01_3323', 'Amsterdam 107'),
  ('MX_CM_EV_MGP_01_3133', 'Av. Nuevo León 272'),
  ('MX_CM_EV_MGP_11_2993', 'Eje 2 Pte Monterrey 75 y Oro'),
  ('MX_CM_EV_MGP_01_3436', 'Av Nuevo León 62'),
  ('MX_CM_EV_MGP_01_3598', 'Av. Chapultepec 438'),
  ('MX_CM_EV_MGP_01_3490', 'Paseo De La Reforma 458'),
  ('MX_CM_EV_MGP_03_3225', 'San Jeronimo'),
  ('MX_CM_EV_MGP_06_3225', 'Río Magdalena'),
  ('MX_CM_EV_MGP_01_3519', 'Av. Revolución 811'),
  ('MX_CM_EV_MGP_05_3530', 'Revolución 1300'),
  ('MX_CM_EV_MGP_05_3422', 'Blvd Adolfo Ruiz Cortinez 3232'),
  ('MX_CM_EV_MGP_03_3580', 'Picacho Ajusco Lt 63 Mz 49'),
  ('MX_CM_EV_MGP_03_3544', 'Av. Boulevard Adolfo Ruiz Cortinez 5120'),
  ('MX_CM_EV_MGP_17_3420', 'Periférico 1181'),
  ('MX_CM_EV_MGP_11_2397', 'Javier Barros Sierra 495'),
  ('MX_CM_EV_MGP_01_2466', 'Calzada De Las Águilas 2341'),
  ('MX_CM_EV_MGP_01_2880', 'Blvd. Adolfo López Mateos 248'),
  ('MX_CM_EV_MGP_17_3576', 'Calzada De Tlalpan 855'),
  ('MX_CM_EV_MGP_03_2994', 'Avenida Insurgentes Sur 1761'),
  ('MX_CM_EV_MGP_06_3429', 'Eje 8 Sur 724'),
  ('MX_CM_EV_MGP_11_3373', 'Av. Paseo De La Reforma 398 y 400'),
  ('MX_CM_EV_MGP_21_3346', 'Paseo De La Reforma 432 1/3'),
  ('MX_CM_EV_MGP_22_3346', 'Paseo De La Reforma 432 2/3'),
  ('MX_CM_EV_MGP_23_3346', 'Paseo De La Reforma 432 3/3'),
  ('MX_EM_EV_MGP_09_0008', 'Av. Lomas Verdes 506'),
  ('MX_CM_EV_MGP_01_3139', 'Av. Paseo De La Reforma 202'),
  ('MX_CM_EV_MGP_04_3139', 'Av. Paseo De La Reforma 202'),
  ('MX_CM_EV_MGP_02_3139', 'Av. Paseo De La Reforma 202'),
  ('MX_CM_EV_MGP_03_3139', 'Av. Paseo De La Reforma 202'),
  ('MX_CM_EV_MGP_01_3510', 'Av. Paseo De La Reforma 146'),
  ('MX_CM_EV_MGP_10_3347', 'Eje 2 Pte. Río Tiber 113 y 119'),
  ('MX_CM_EV_MGP_01_2941', 'Insurgentes Centro 121'),
  ('MX_CM_EV_MGP_02_3200', 'Hamburgo 49'),
  ('MX_CM_EV_MGP_01_3379', 'Benjamín Franklin 246'),
  ('MX_CM_EV_MGP_03_3615', 'Av. Constituyentes 555'),
  ('MX_CM_EV_MGP_11_3419', 'Avenida Constituyentes 890'),
  ('MX_CM_EV_MGP_03_2339', 'Av. Circuito Estadio Azteca S/N'),
  ('MX_CM_EV_MGP_16_3606', 'Periferico 5157'),
  ('MX_CM_EV_MGP_11_3425', 'Calzada del Hueso 256'),
  ('MX_CM_EV_MGP_01_3559', 'Periférico Sur 4290'),
  ('MX_CM_EV_MGP_02_3394', 'Jacarandas 90'),
  ('MX_CM_EV_MGP_05_3586', 'Viaducto Esq. Sur 69'),
  ('MX_CM_EV_MGP_17_3535', 'Río de la Loza 30'),
  ('MX_CM_EV_MGP_05_3292', 'Campos Eliseos 164'),
  ('MX_CM_EV_MGP_01_3612', 'Rio Consulado 1652'),
  ('MX_CM_EV_MGP_03_3350', 'Viaducto 106'),
  ('MX_CM_EV_MGP_01_3229', 'Canal de Miramontes 2640'),
  ('MX_CM_EV_MGP_14_3626', 'Av. Juárez 95 1/2 Reforma'),
  ('MX_CM_EV_MGP_01_3626', 'Av. Juárez 95 2/2 Juarez'),
  ('MX_CM_EV_MGP_02_3601', 'Viad. Tlalpan 5357'),
  ('MX_CM_EV_MGP_06_3184', 'San Antonio Abad 122'),
  ('MX_CM_EV_MGP_07_3619', 'Av. Prado Norte 130'),
  ('MX_CM_EV_MGP_01_3643', 'Río Consulado 649'),
  ('MX_CM_EV_MGP_02_3192', 'Tlalpan 2520 (Xotepingo)'),
  ('MX_CM_EV_MGP_02_3641', 'POPOCATEPETL 145'),
  ('MX_CM_EV_MGP_01_3638', 'C. RUPIAS'),
  ('MX_CM_EV_MGP_07_3599', 'Av. Altavista 32'),
  ('MX_CM_EV_MGP_05_3368', 'Prolongacion Reforma 2754'),
  ('MX_CM_EV_MGP_14_3351', 'Tlalpan 2050'),
  ('MX_CM_EV_MGP_06_2462', 'Marina Nacional 175'),
  ('MX_CM_EV_MGP_09_3489', 'Division del Norte 247'),
  ('MX_CM_EV_MGP_04_3622', 'Parque Lira'),
  ('MX_CM_EV_MGP_01_3381', 'Manuel Navarrete'),
  ('MX_CM_EV_MGP_01_3650', 'Rio de la Piedad'),
  ('MX_EM_EV_MGP_01_0004', 'Francisco Terrazas'),
  ('MX_CM_EV_MGP_13_2768', 'Mariano Escobedo 570'),
  ('MX_CM_EV_MGP_01_3639', 'Moliere 88'),
  ('MX_CM_EV_MGP_07_3647', 'CALZADA DE LOS LEONES (Liga Maya)'),
  ('MX_CM_EV_MGP_03_3640', 'Periferico 2250 (Leon Felipe)'),
  ('MX_CM_EV_MGP_07_3567', 'Insurgentes 168'),
  ('MX_CM_EV_MGP_02_3653', 'Escocia 4 (Gabriel Mancera)'),
  ('MX_EM_EV_MGP_02_0010', 'Pantalla Hormona Cov (Esquinada)'),
  ('MX_EM_EV_MGP_08_0002', 'T de la Chica'),
  ('MX_CM_EV_MGP_01_3663', 'Insurgentes 2386'),
  ('MX_CM_EV_MGP_01_3667', 'Ciencias 11 (Patriotismo)'),
  ('MX_CM_EV_MGP_01_3672', 'Ejercito Nacional 1'),
  ('MX_CM_EV_MGP_02_3672', 'Ejercito Nacional 2'),
  ('MX_CM_EV_MGP_01_3675', 'Monterrey 15'),
  ('MX_CM_EV_MGP_01_3634', 'Rio Chico')
on conflict (vendor_face_id) do update
  set nombre = excluded.nombre,
      actualizado_en = now();

-- Verificar: cuántos quedaron y cuántos empatan con el inventario.
select count(*) as nombres_cargados,
       count(i.vendor_face_id) as con_cara_en_inventario
from public.nombres_pantallas n
left join public.inventario i on i.vendor_face_id = n.vendor_face_id;

-- Las que NO empataron con inventario (0 filas = todo bien):
select n.vendor_face_id, n.nombre
from public.nombres_pantallas n
left join public.inventario i on i.vendor_face_id = n.vendor_face_id
where i.vendor_face_id is null;
