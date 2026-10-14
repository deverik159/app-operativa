-- ============================================================
-- catorcenas_2027 — fase 3 de "catorcena con año" (Erik, 14-oct-2026).
-- Carga las 26 catorcenas de 2027 del calendario oficial (imagen
-- "Calendario 2027 · Catorcenas" que pasó Erik). Re-ejecutable.
--
-- Validado antes de escribir: las 26 duran 14 días, todas empiezan en
-- martes y la Cat-1 empieza el 5-ene-2027, el día siguiente al fin de la
-- Cat-26 de 2026. La Cat-26 de 2027 termina el 3-ene-2028 y sigue siendo
-- de 2027.
-- Mismas reglas que las filas de 2026: mes = primer día del mes en que
-- TERMINA, mes_texto = mes en que EMPIEZA, cat_texto = 'Cat-N'.
-- Los cortes 1 y 2 del calendario no tienen columna en la tabla: no se
-- cargan.
-- Requiere 20261014172034_catorcena_con_anio (llave (anio, numero)) y la
-- app de dec7898 (ordena por fecha); con la app vieja, Nueva incidencia y
-- Disponibilidad tomaban estas filas antes que las de 2026.
-- ============================================================
insert into public.catorcenas (anio, numero, fecha_inicio, fecha_fin, mes, mes_texto, cat_texto)
values
  (2027, 1, '2027-01-05', '2027-01-18', '2027-01-01', 'Enero', 'Cat-1'),
  (2027, 2, '2027-01-19', '2027-02-01', '2027-02-01', 'Enero', 'Cat-2'),
  (2027, 3, '2027-02-02', '2027-02-15', '2027-02-01', 'Febrero', 'Cat-3'),
  (2027, 4, '2027-02-16', '2027-03-01', '2027-03-01', 'Febrero', 'Cat-4'),
  (2027, 5, '2027-03-02', '2027-03-15', '2027-03-01', 'Marzo', 'Cat-5'),
  (2027, 6, '2027-03-16', '2027-03-29', '2027-03-01', 'Marzo', 'Cat-6'),
  (2027, 7, '2027-03-30', '2027-04-12', '2027-04-01', 'Marzo', 'Cat-7'),
  (2027, 8, '2027-04-13', '2027-04-26', '2027-04-01', 'Abril', 'Cat-8'),
  (2027, 9, '2027-04-27', '2027-05-10', '2027-05-01', 'Abril', 'Cat-9'),
  (2027, 10, '2027-05-11', '2027-05-24', '2027-05-01', 'Mayo', 'Cat-10'),
  (2027, 11, '2027-05-25', '2027-06-07', '2027-06-01', 'Mayo', 'Cat-11'),
  (2027, 12, '2027-06-08', '2027-06-21', '2027-06-01', 'Junio', 'Cat-12'),
  (2027, 13, '2027-06-22', '2027-07-05', '2027-07-01', 'Junio', 'Cat-13'),
  (2027, 14, '2027-07-06', '2027-07-19', '2027-07-01', 'Julio', 'Cat-14'),
  (2027, 15, '2027-07-20', '2027-08-02', '2027-08-01', 'Julio', 'Cat-15'),
  (2027, 16, '2027-08-03', '2027-08-16', '2027-08-01', 'Agosto', 'Cat-16'),
  (2027, 17, '2027-08-17', '2027-08-30', '2027-08-01', 'Agosto', 'Cat-17'),
  (2027, 18, '2027-08-31', '2027-09-13', '2027-09-01', 'Agosto', 'Cat-18'),
  (2027, 19, '2027-09-14', '2027-09-27', '2027-09-01', 'Septiembre', 'Cat-19'),
  (2027, 20, '2027-09-28', '2027-10-11', '2027-10-01', 'Septiembre', 'Cat-20'),
  (2027, 21, '2027-10-12', '2027-10-25', '2027-10-01', 'Octubre', 'Cat-21'),
  (2027, 22, '2027-10-26', '2027-11-08', '2027-11-01', 'Octubre', 'Cat-22'),
  (2027, 23, '2027-11-09', '2027-11-22', '2027-11-01', 'Noviembre', 'Cat-23'),
  (2027, 24, '2027-11-23', '2027-12-06', '2027-12-01', 'Noviembre', 'Cat-24'),
  (2027, 25, '2027-12-07', '2027-12-20', '2027-12-01', 'Diciembre', 'Cat-25'),
  (2027, 26, '2027-12-21', '2028-01-03', '2028-01-01', 'Diciembre', 'Cat-26')
on conflict (anio, numero) do update
  set fecha_inicio = excluded.fecha_inicio,
      fecha_fin    = excluded.fecha_fin,
      mes          = excluded.mes,
      mes_texto    = excluded.mes_texto,
      cat_texto    = excluded.cat_texto;
