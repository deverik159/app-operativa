// ============================================================
// supabase/functions/limpiar-chat/index.ts
// Borra de Storage los adjuntos del chat cuya incidencia ya cerró.
//
// POR QUÉ ESTO NO ES UN TRIGGER DE POSTGRES: borrar de Supabase Storage exige
// pasar por su API. Borrar la fila de `storage.objects` desde SQL deja el
// archivo ocupando espacio igual — justo lo que se quiere evitar. Solo el
// cliente de Storage con la service_role key lo elimina de verdad.
//
// La despierta `pg_cron` una vez al día (ver chat_adjuntos.sql). El criterio
// de QUÉ purgar vive en la vista `vw_chat_adjuntos_purgables`, no aquí: así
// se ajusta con un `create or replace view`, sin volver a desplegar.
//
// DESPLIEGUE
//   Supabase → Edge Functions → Deploy a new function
//     nombre: limpiar-chat
//     Verify JWT: da igual — el trigger manda Authorization con la anon key
//   Secretos: reutiliza los que ya existen (PUSH_SECRET). No hay que crear
//   ninguno nuevo.
//   Después: copiar la URL que muestre el panel y ponerla en
//     app_config.limpieza_url
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

/** Bucket donde viven las evidencias y también los adjuntos del chat. */
const BUCKET = 'evidencias';

/** Cuántos borrar por corrida. Evita una petición gigantesca a Storage. */
const LOTE = 200;

type Purgable = { id: number; path: string; record_id: string };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Solo POST' }, 405);

  // Mismo secreto compartido que el push. Sin él, cualquiera con la URL
  // podría borrar los archivos de la operación.
  const esperado = Deno.env.get('PUSH_SECRET');
  if (!esperado || req.headers.get('x-push-secret') !== esperado) {
    return json({ error: 'No autorizado' }, 401);
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // 1) Qué toca borrar. El criterio está en la vista, no aquí.
  const { data, error } = await sb
    .from('vw_chat_adjuntos_purgables')
    .select('id,path,record_id')
    .limit(LOTE);

  if (error) return json({ error: error.message }, 500);
  const filas = (data || []) as Purgable[];
  if (filas.length === 0) return json({ ok: true, purgados: 0 });

  // 2) Borrar de Storage. `remove` acepta varias rutas de un golpe.
  const rutas = filas.map((f) => f.path).filter(Boolean);
  const { error: errStorage } = await sb.storage.from(BUCKET).remove(rutas);

  // Si Storage falla, NO se marcan como purgadas: se reintentan mañana.
  // Marcarlas sin haber borrado dejaría archivos invisibles ocupando espacio
  // para siempre, que es peor que un reintento.
  if (errStorage) {
    console.error('[limpieza] fallo al borrar de Storage:', errStorage.message);
    return json({ error: errStorage.message, purgados: 0 }, 500);
  }

  // 3) Marcar las filas. El registro se queda para poder mostrar
  //    "📎 archivo eliminado" en el hilo en vez de un hueco sin explicación.
  const ids = filas.map((f) => f.id);
  const { error: errMarca } = await sb
    .from('chat_adjuntos')
    .update({ purgado_en: new Date().toISOString() })
    .in('id', ids);

  if (errMarca) {
    // Caso feo pero recuperable: el archivo ya no está y la fila dice que sí.
    // Mañana se reintenta el `remove` (Storage no se queja de borrar algo que
    // no existe) y la marca se pone entonces.
    console.error('[limpieza] borrados de Storage pero sin marcar:', errMarca.message);
    return json({ ok: false, purgados: rutas.length, aviso: errMarca.message });
  }

  return json({
    ok: true,
    purgados: rutas.length,
    // Si viene lleno el lote, quedan más para la próxima corrida.
    quedan_mas: filas.length === LOTE,
  });
});
