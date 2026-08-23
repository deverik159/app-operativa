# Notificaciones push — guía de activación

Notificaciones que llegan al celular **con la app cerrada**, sin App Store ni
Play Store y sin costo por mensaje.

Son **5 pasos**. Los tres primeros se hacen una sola vez.

---

## 1. Generar las llaves VAPID (una vez)

Son el par de llaves con el que el navegador verifica que el push viene de ti.

```bash
npx web-push generate-vapid-keys
```

Devuelve algo así:

```
Public Key:   BEl62iUYgUiv...
Private Key:  8ZL_ux1Kk9...
```

- La **pública** va al frontend. Es visible, no es secreto.
- La **privada** es un secreto. Nunca va al repo ni al `.env.local`.

Guárdalas en tu gestor de contraseñas: si se pierde la privada hay que
regenerar el par y **todos** los dispositivos tienen que volver a suscribirse.

---

## 2. Base de datos

Aplica `push_suscripciones.sql` en el SQL Editor.

**Antes de ejecutarlo**, cambia `CAMBIA-ESTE-SECRETO` (aparece dos veces) por
una cadena larga y aleatoria. Es el secreto que autoriza al trigger a invocar
la Edge Function; sin él, cualquiera con la URL podría mandar notificaciones a
tu equipo.

Para generar una:

```bash
openssl rand -base64 32
```

> Este SQL crea un trigger **nuevo** (`trg_notificar_push`). El que ya existe
> para WhatsApp (`notificaciones` → `dynamic-worker`) sigue intacto: Postgres
> dispara los dos.

---

## 3. Edge Function

Requiere el CLI de Supabase (`npm i -g supabase`, luego `supabase login` y
`supabase link --project-ref qztxpcfbbbmvgmtjnlxg`).

```bash
# Secretos (el PUSH_SECRET debe ser EL MISMO del paso 2)
supabase secrets set VAPID_PUBLIC_KEY=BEl62iUYgUiv...
supabase secrets set VAPID_PRIVATE_KEY=8ZL_ux1Kk9...
supabase secrets set VAPID_SUBJECT=mailto:mejia.erik@gpovallas.com
supabase secrets set PUSH_SECRET=<el del paso 2>

# Despliegue
supabase functions deploy enviar-push --no-verify-jwt
```

`--no-verify-jwt` es necesario: el trigger llama sin token de usuario. La
autorización la hace el header `x-push-secret`.

---

## 4. Frontend

En `.env.local` de **cada máquina**:

```
VITE_VAPID_PUBLIC_KEY=BEl62iUYgUiv...
```

Reinicia `npm run dev` — Vite solo lee las variables al arrancar.

En Vercel, agrégala también en las variables de entorno del proyecto.

---

## 5. Activar en cada dispositivo

En la barra superior aparece un botón 🔕. Al tocarlo se explica qué hace y se
pide el permiso. Cuando queda activo se ve 🔔✓.

Es **por dispositivo**: el celular y la computadora se activan por separado.

### Android / Chrome de escritorio
Funciona directo. Opcionalmente se puede instalar la app desde el menú del
navegador ("Instalar app") para que quede con su icono.

### iPhone / iPad — el paso extra
iOS solo permite Web Push si la app está **agregada a la pantalla de inicio**.
Desde una pestaña de Safari el navegador ni siquiera expone la función.

1. Botón **Compartir** de Safari (el cuadrito con la flecha hacia arriba).
2. **Agregar a inicio**.
3. Abrir la app desde el icono nuevo y ahí tocar el botón de notificaciones.

La app lo detecta y muestra estas instrucciones sola, así que no hace falta
explicárselo a cada persona.

Requiere **iOS 16.4 o superior**.

---

## Probar que funciona

Con las notificaciones activas en un dispositivo, inserta una notificación a
mano en el SQL Editor:

```sql
insert into notificaciones (para_email, evento, mensaje, unidad_negocio)
values ('tu.correo@gpovallas.com', 'chat', 'Prueba de notificación push', 'Ecovallas');
```

Debería llegar en segundos. Si no:

| Dónde mirar | Qué buscar |
|---|---|
| Logs de la Edge Function (dashboard de Supabase) | `401` = el PUSH_SECRET no coincide entre el SQL y los secretos |
| Respuesta de la función | `"enviados": 0, "motivo": "sin dispositivos"` = la suscripción no se guardó |
| `select * from push_suscripciones` | debe haber una fila por dispositivo, con `invalida = false` |
| Consola del navegador | errores con la etiqueta `[push]` |

```sql
-- ¿Se está llamando la función? pg_net registra cada intento.
select * from net._http_response order by created desc limit 10;
```

---

## Cosas que conviene saber

**El service worker no cachea nada a propósito.** Solo recibe los push. Una
caché mal invalidada deja a la gente con una versión vieja de la app sin forma
obvia de actualizar, y eso cuesta más de lo que ayuda. Si más adelante se
quiere modo offline, se agrega con una estrategia explícita de versionado.

**Las suscripciones se mueren solas.** Si alguien borra los datos del navegador
o desinstala la app, el servicio de push responde 404/410. La función marca esa
fila como `invalida = true` en vez de borrarla, para poder ver el historial. El
usuario simplemente vuelve a activar.

**Las notificaciones del mismo registro se reemplazan.** El payload lleva un
`tag` por `record_id`, así que cinco mensajes de la misma incidencia no saturan
la bandeja del celular: se ve el último.

**Esto no reemplaza la campana.** La campana sigue siendo la fuente de verdad y
el historial. El push solo es el aviso.

---

## Lo que sigue (opcional)

La campana dentro de la app se actualiza por consulta cada 25 segundos. Se
puede cambiar a Supabase Realtime —el mismo mecanismo que ya usa el chat— para
que el contador se prenda al instante. Son horas de trabajo y no requiere nada
de infraestructura nueva.
