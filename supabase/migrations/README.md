# supabase/migrations

Desde el 24-sep-2026 (auditoría primer mes), **todo cambio de base nuevo es
un archivo aquí**, se aplica primero en staging y después en producción. El
paso a paso completo está en [GUIA-STAGING-Y-CARGA.md](../../GUIA-STAGING-Y-CARGA.md) §3.

Los ~58 `.sql` sueltos de la raíz son la **historia** hasta hoy: no se mueven
(el HANDOFF los referencia) y no se vuelven a correr. Los diagnósticos de
solo lectura tampoco son migraciones: siguen como archivo suelto.

## Nombre y orden

- `AAAAMMDDHHMMSS_nombre_en_minusculas.sql`, con la hora en **UTC**. Ejemplo:
  `20261002183000_indice_bandeja.sql`.
- Créalo con `npx supabase migration new indice_bandeja` (pone la hora sola).
- El CLI las aplica de la marca más vieja a la más nueva. **Nunca** edites ni
  renombres una que ya se aplicó en algún lado: corrige con una nueva.
- El CLI avisa `Skipping migration README.md...`: es este archivo, es normal.

## La primera: la línea base

Es una foto del esquema de producción (tablas, vistas, funciones, políticas,
triggers y permisos; sin datos). No se ejecuta en producción: solo se
**registra** como aplicada, para que el historial arranque desde lo que ya
existe. Se saca UNA vez, antes de la primera migración nueva, con la guía:
§2.3 (sacar el dump), §2.5 (limpiarlo) y §3 «Registrar la línea base»
(copiarlo aquí y registrarlo en staging y en producción, cada paso con su
candado). Staging también se registra como aplicada porque ya recibió ese
mismo esquema por `psql` (guía §2.6).

La receta vive solo en la guía (revisión primer mes, 24-sep-2026): la copia
que había aquí volvía a sacar el dump **sin limpiar** encima del limpio y lo
copiaba a esta carpeta en el mismo pegado. Esta carpeta **sí** se sube a
GitHub: la contraseña del FDW de Mario o la llave del webhook que entren
aquí ya no salen del historial (nunca se hace force-push); solo queda
rotarlas, y la de Mario es de un tercero.

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
  cuenta con `.select()`; una política nueva se prueba igual en staging.
