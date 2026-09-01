// ============================================================
// supabase/functions/enviar-push/index.ts
// Edge Function que entrega las notificaciones como Web Push.
//
// La invoca el trigger `trg_notificar_push` con la fila recién insertada en
// `notificaciones`. Aquí se buscan las suscripciones de ese correo y se manda
// el push a cada dispositivo.
//
// Usa la service_role key para leer `push_suscripciones` saltándose la RLS:
// el trigger no tiene sesión de usuario, así que no hay `auth_email()`.
//
// DESPLIEGUE
//   1. Genera las llaves VAPID (una sola vez, en tu máquina):
//        npx web-push generate-vapid-keys
//   2. Configura los secretos:
//        supabase secrets set VAPID_PUBLIC_KEY=...
//        supabase secrets set VAPID_PRIVATE_KEY=...
//        supabase secrets set VAPID_SUBJECT=mailto:mejia.erik@gpovallas.com
//        supabase secrets set PUSH_SECRET=<el mismo de push_suscripciones.sql>
//   3. Despliega:
//        supabase functions deploy enviar-push --no-verify-jwt
//
//   --no-verify-jwt es necesario porque el trigger llama sin token de usuario.
//   La autorización la hace el header x-push-secret.
//
//   La llave PÚBLICA también va al frontend, en .env.local:
//        VITE_VAPID_PUBLIC_KEY=...
//   La PRIVADA nunca sale de los secretos de Supabase.
// ============================================================
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

/** Texto legible por tipo de evento, para el título de la notificación. */
const TITULOS: Record<string, string> = {
  captura: 'Nueva incidencia por validar',
  asignacion: 'Incidencia asignada a tu área',
  asignacion_area: 'Te dirigieron una incidencia',
  asignacion_tecnico: 'Se te asignó una incidencia',
  reparado: 'Reparación por aprobar',
  reparado_reportante: 'Tu incidencia fue reparada',
  cierre: 'Tu incidencia fue cerrada',
  reabierta: 'Reparación rechazada',
  reasignacion: 'Reasignación aprobada',
  chat: 'Nuevo mensaje',
  ruta: 'Cambio en tu ruta',
};

type Cuerpo = {
  id?: number;
  para_email?: string;
  evento?: string;
  mensaje?: string;
  record_id?: string | null;
  unidad_negocio?: string | null;
};

type Suscripcion = {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Solo POST' }, 405);

  // 1) Autorización. El trigger manda el secreto compartido; sin él,
  //    cualquiera con la URL podría mandar notificaciones a tu gente.
  const esperado = Deno.env.get('PUSH_SECRET');
  if (!esperado || req.headers.get('x-push-secret') !== esperado) {
    return json({ error: 'No autorizado' }, 401);
  }

  const pub = Deno.env.get('VAPID_PUBLIC_KEY');
  const priv = Deno.env.get('VAPID_PRIVATE_KEY');
  const subject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@gpovallas.com';
  if (!pub || !priv) return json({ error: 'Faltan las llaves VAPID' }, 500);

  webpush.setVapidDetails(subject, pub, priv);

  let cuerpo: Cuerpo;
  try {
    cuerpo = await req.json();
  } catch {
    return json({ error: 'Cuerpo inválido' }, 400);
  }
  if (!cuerpo.para_email) return json({ error: 'Falta para_email' }, 400);

  // 2) Suscripciones activas de ese correo. service_role salta la RLS.
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { data, error } = await sb
    .from('push_suscripciones')
    .select('id,endpoint,p256dh,auth')
    .ilike('usuario_email', cuerpo.para_email)
    .eq('invalida', false);

  if (error) return json({ error: error.message }, 500);
  const subs = (data || []) as Suscripcion[];
  if (subs.length === 0) return json({ ok: true, enviados: 0, motivo: 'sin dispositivos' });

  // 3) Payload. Se mantiene chico: hay servicios de push que limitan a ~4 KB.
  // En los chats el trigger manda "Nuevo mensaje en <folio>: <texto>", que
  // repetía al título genérico. Aquí se parte: el folio sube al título y el
  // cuerpo queda solo con el texto del mensaje.
  let titulo = TITULOS[cuerpo.evento || ''] || 'GPO VALLAS';
  let texto = cuerpo.mensaje || '';
  if (cuerpo.evento === 'chat') {
    const m = texto.match(/^Nuevo mensaje en (.+?): ([\s\S]*)$/);
    if (m) {
      titulo = `Nuevo mensaje en ${m[1]}`;
      texto = m[2];
    }
  }
  const payload = JSON.stringify({
    titulo,
    cuerpo: texto,
    url: '/',
    record_id: cuerpo.record_id || null,
    // tag por registro: varias notificaciones de la misma incidencia se
    // reemplazan en el celular en vez de apilarse.
    tag: cuerpo.record_id ? `inc-${cuerpo.record_id}` : undefined,
  });

  let enviados = 0;
  const invalidas: number[] = [];
  // El motivo exacto de cada rechazo, DE VUELTA en la respuesta: con solo
  // console.error el error real (p. ej. el 403 de Apple por llave VAPID
  // equivocada) quedaba enterrado en los logs y el diagnóstico era a ciegas.
  const fallos: { id: number; status?: number; detalle?: string }[] = [];

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          },
          payload,
          { TTL: 3600 } // si no se entrega en 1 h, ya no es útil en campo
        );
        enviados++;
      } catch (e) {
        const err = e as { statusCode?: number; body?: string; message?: string };
        // 404/410 = el navegador revocó la suscripción (datos borrados, app
        // desinstalada). Se marca para dejar de intentar por siempre.
        if (err.statusCode === 404 || err.statusCode === 410) invalidas.push(s.id);
        else {
          console.error('[push] fallo en', s.endpoint.slice(0, 60), err.statusCode, e);
          fallos.push({
            id: s.id,
            status: err.statusCode,
            detalle: String(err.body || err.message || '').slice(0, 200),
          });
        }
      }
    })
  );

  if (invalidas.length) {
    await sb
      .from('push_suscripciones')
      .update({ invalida: true })
      .in('id', invalidas);
  }
  if (enviados) {
    await sb
      .from('push_suscripciones')
      .update({ ultimo_envio: new Date().toISOString() })
      .in(
        'id',
        subs.filter((s) => !invalidas.includes(s.id)).map((s) => s.id)
      );
  }

  return json({ ok: true, enviados, invalidadas: invalidas.length, fallos });
});
