# supabase/migrations

Desde el 24-sep-2026 (auditoría primer mes), **todo cambio de base nuevo es
un archivo aquí**. Hoy no hay staging en uso: cada migración la revisa el
subagente `revisor-rls` contra la base actual y se aplica en producción solo
con el sí de Erik, una por una; después el archivo se renombra a la versión
que registró la base. Si algún día se usa staging, va primero ahí: el paso a
paso está en [GUIA-STAGING-Y-CARGA.md](../../GUIA-STAGING-Y-CARGA.md) §3.

**Esta carpeta es el único lugar del repo con SQL** (Erik, 31-oct-2026). Los
62 `.sql` sueltos que había en la raíz (la historia de agosto y septiembre),
la foto de `supabase/referencia/` y `scripts/limpiar-storage.mjs` se movieron al
repo privado de contexto, en `contexto/_archivo/sql-historico/`, con un
`INDICE.md` que dice de cada uno si está aplicado, si era diagnóstico o si es
peligroso. **Ninguno se vuelve a correr**: varios regresan funciones que una
migración cambió después (así se perdió la retención del chat). Cuando un
comentario del código, el HANDOFF o una guía cite un `.sql` que no está aquí,
es uno de esos archivos.

- La base de producción dice cómo está todo hoy; esta carpeta, cómo se llegó.
- Los diagnósticos no se guardan: se corren y listo.
- El guardia de commits de Claude bloquea un `.sql` nuevo fuera de esta carpeta.

## Nombre y orden

- `AAAAMMDDHHMMSS_nombre_en_minusculas.sql`, con la hora en **UTC**. Ejemplo:
  `20261002183000_indice_bandeja.sql`.
- Créalo con `npx supabase migration new indice_bandeja` (pone la hora sola).
- El CLI las aplica de la marca más vieja a la más nueva. **Nunca** edites ni
  renombres una que ya se aplicó en algún lado: corrige con una nueva.
- El CLI avisa `Skipping migration README.md...`: es este archivo, es normal.

## Sin foto del esquema

La carpeta empieza en `20260925065305`: lo anterior se creó a mano antes de
usar migraciones. No se guarda una "línea base" (foto del esquema de
producción) porque se vuelve vieja (Erik, 31-oct-2026): la base de
producción dice cómo está todo hoy y aquí queda cómo se llegó. La carpeta
coincide con lo registrado en `supabase_migrations.schema_migrations`.

Esta carpeta **sí** se sube a GitHub, y el repo es público: una contraseña
(p. ej. la del FDW de Mario) o una llave que entre aquí ya no sale del
historial (nunca se hace force-push); solo queda rotarla, y la de Mario es de
un tercero.

## Reglas de contenido (las lecciones del proyecto)

- **Re-ejecutable**: `if not exists`, `create or replace`, `drop … if exists`.
- **Funciones nuevas: `grant execute … to authenticated` explícito.** A
  PUBLIC ya no se le da EXECUTE por omisión (prelanzamiento_300.sql).
- **`alter type … add value` va SOLO en su propia migración**: Postgres no
  deja usar el valor nuevo en la misma transacción (rol_monitorista.sql).
- **Nada de secretos** (Vault y secretos de funciones se llenan a mano en
  cada proyecto) **ni del ref del proyecto** dentro de una función: cambia
  entre staging y producción (`notificar_push` lo trae escrito — lección).
  Antes de cada commit que toque esta carpeta, esto debe salir vacío:
  `git grep --untracked -nE 'USER MAPPING|eyJ|sb_secret_|http_request' -- 'supabase/migrations/*.sql'`.
- Con RLS, un update que no pasa devuelve 0 filas sin error: la app siempre
  cuenta con `.select()`; una política nueva se prueba simulando al usuario
  (solo lectura) o con su sesión en la app, no como administrador.
