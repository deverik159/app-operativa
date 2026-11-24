// ============================================================
// supabase/functions/sync-sheets/index.ts
// Escribe cada folio en la pestaña «App» de la base general de su unidad
// (Erik, 24-nov-2026): Ecovallas, impresas y digitales → Incidencias EV
// Gral; Vía Verde → VV Gral; Biobox después. De ahí cada equipo trae sus
// folios a su archivo de trabajo con el botón «Actualizar»
// (scripts/sheets/ActualizarIncidenciasApp.gs). «Sistema de Incidencias»
// no es destino.
//
// CÓMO FUNCIONA
//   La base encola cada folio que se crea, cambia o se borra (sheets_cola,
//   migración 20261124171724) y pg_cron despierta esta función cada 5 min.
//   Por cada archivo: una lectura (encabezados + columna Folio) y una
//   escritura para las filas que ya estaban, otra para las nuevas y otra
//   para las que se quitan. Se llena por NOMBRE de encabezado y solo los
//   que conoce vw_incidencias_sheets. Cada fila escrita lleva la hora en
//   «Actualizado (UTC)». Si Google falla, los folios se quedan en la cola y
//   se reintentan con espera creciente.
//
// DESPLIEGUE
//   Supabase → Edge Functions → sync-sheets (index.ts + logica.ts).
//   Secretos de la función (Edge Functions → Secrets; NUNCA en el repo):
//     GOOGLE_SA_JSON    el JSON completo de la llave de la cuenta de servicio
//     SHEETS_DESTINOS   {"Ecovallas":"<id>","Vía Verde":"<id>"}
//                       (el id es lo que va entre /d/ y /edit en el enlace;
//                       una unidad que no está aquí se descarta de la cola)
//     PUSH_SECRET       ya existe: el mismo de enviar-push y limpiar-chat
//   Cada archivo se comparte con el correo de la cuenta de servicio como
//   Editor. Si falta la pestaña «App», se crea con ENCABEZADOS_BASE.
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  base64Url,
  CLAVE_ACTUALIZADO,
  destinoDe,
  ENCABEZADOS_BASE,
  faltantes,
  letraColumna,
  nombreHoja,
  planear,
  type Fila,
} from './logica.ts';

/** Pestaña de la base general donde escribe la app. */
const PESTANA = Deno.env.get('SHEETS_PESTANA') || 'App';

/** Folios por corrida. La carga inicial (unos 300) cabe en una. */
const LOTE = 500;

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

type Item = {
  record_id: string;
  unidad: string;
  folio: string | null;
  borrado: boolean;
  version: number;
  intentos: number;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

class ErrorGoogle extends Error {
  constructor(public estado: number, public cuerpo: string) {
    super(`Google respondió ${estado}: ${cuerpo.slice(0, 300)}`);
  }
}

/** Token de la cuenta de servicio (JWT firmado con su llave, RS256). */
async function tokenGoogle(sa: { client_email: string; private_key: string }): Promise<string> {
  const enc = new TextEncoder();
  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = base64Url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const cuerpo = base64Url(
    enc.encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: 'https://oauth2.googleapis.com/token',
        iat: ahora,
        exp: ahora + 3600,
      })
    )
  );
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const llave = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const firma = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', llave, enc.encode(`${cabecera}.${cuerpo}`))
  );

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${cabecera}.${cuerpo}.${base64Url(firma)}`,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(`Google no dio acceso (${r.status}): ${j.error_description || j.error || 'sin detalle'}`);
  }
  return j.access_token as string;
}

/** Llamada a la API de Sheets. Un 429 o 5xx se reintenta una vez. */
async function google(token: string, metodo: string, url: string, cuerpo?: unknown): Promise<any> {
  for (let intento = 0; ; intento++) {
    const r = await fetch(url, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const texto = await r.text();
    if (r.ok) return texto ? JSON.parse(texto) : {};
    if (intento === 0 && (r.status === 429 || r.status >= 500)) {
      await new Promise((ok) => setTimeout(ok, 2000));
      continue;
    }
    throw new ErrorGoogle(r.status, texto);
  }
}

const rango = (r: string) => encodeURIComponent(r);

/** sheetId y número de columnas de la pestaña «App». */
async function propiedadesPestana(token: string, base: string): Promise<{ sheetId: number; columnas: number }> {
  const meta = await google(token, 'GET', `${base}?fields=sheets.properties(sheetId,title,gridProperties)`);
  const p = (meta.sheets ?? []).find((s: any) => s.properties?.title === PESTANA)?.properties;
  if (p?.sheetId === undefined) throw new Error(`No se encontró la pestaña «${PESTANA}».`);
  return { sheetId: p.sheetId, columnas: p.gridProperties?.columnCount ?? 0 };
}

/**
 * Crea la pestaña «App» con ENCABEZADOS_BASE y la fila 1 fija. Queda
 * protegida «solo con aviso»: quien la edite o la ordene a mano ve que la
 * escribe la app. Ordenarla entre la lectura y la escritura de una corrida
 * movería las filas (revisor-rls, 24-nov-2026).
 */
async function crearPestana(token: string, base: string): Promise<void> {
  const r = await google(token, 'POST', `${base}:batchUpdate`, {
    requests: [
      {
        addSheet: {
          properties: {
            title: PESTANA,
            gridProperties: { rowCount: 1000, columnCount: ENCABEZADOS_BASE.length, frozenRowCount: 1 },
          },
        },
      },
    ],
  });
  await google(token, 'PUT', `${base}/values/${rango(`${nombreHoja(PESTANA)}!A1`)}?valueInputOption=RAW`, {
    values: [ENCABEZADOS_BASE],
  });
  const sheetId = r.replies?.[0]?.addSheet?.properties?.sheetId;
  if (sheetId !== undefined) {
    await google(token, 'POST', `${base}:batchUpdate`, {
      requests: [
        {
          addProtectedRange: {
            protectedRange: {
              range: { sheetId },
              warningOnly: true,
              description:
                'La escribe la app de incidencias cada 5 min. No la ordenes ni le muevas filas; ' +
                'los equipos traen sus folios con el botón «Actualizar» de su archivo.',
            },
          },
        },
      ],
    });
  }
}

/**
 * Lee la fila 1 y la columna Folio de la pestaña «App» (la crea si falta).
 * Si le faltan encabezados de ENCABEZADOS_BASE (una llave nueva de la
 * vista), los agrega al final.
 */
async function leerPestana(token: string, base: string): Promise<{ encabezados: unknown[]; folios: unknown[] }> {
  const hoja = nombreHoja(PESTANA);
  const leer = () =>
    google(
      token,
      'GET',
      `${base}/values:batchGet?ranges=${rango(`${hoja}!1:1`)}&ranges=${rango(`${hoja}!A:A`)}` +
        '&majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE'
    );

  let r;
  try {
    r = await leer();
  } catch (e) {
    // Sheets contesta 400 «Unable to parse range» cuando la pestaña no existe.
    if (e instanceof ErrorGoogle && e.estado === 400 && /parse range/i.test(e.cuerpo)) {
      await crearPestana(token, base);
      r = await leer();
    } else {
      throw e;
    }
  }

  let encabezados: unknown[] = r.valueRanges?.[0]?.values?.[0] ?? [];
  let folios: unknown[] = (r.valueRanges?.[1]?.values ?? []).map((f: unknown[]) => f?.[0] ?? '');

  // Encabezados que faltan (o la pestaña está vacía): al final de la fila 1.
  const nuevos = faltantes(encabezados);
  if (nuevos.length) {
    let ultimo = encabezados.length - 1;
    while (ultimo >= 0 && !String(encabezados[ultimo] ?? '').trim()) ultimo--;
    const desde = ultimo + 1;
    const necesarias = desde + nuevos.length;
    const p = await propiedadesPestana(token, base);
    if (p.columnas < necesarias) {
      await google(token, 'POST', `${base}:batchUpdate`, {
        requests: [{ appendDimension: { sheetId: p.sheetId, dimension: 'COLUMNS', length: necesarias - p.columnas } }],
      });
    }
    await google(
      token,
      'PUT',
      `${base}/values/${rango(`${hoja}!${letraColumna(desde)}1`)}?valueInputOption=RAW`,
      { values: [nuevos] }
    );
    encabezados = [...encabezados.slice(0, desde), ...nuevos];
    if (!folios.length) folios = [encabezados[0]];
  }

  // Folio no está en la columna A: se lee la suya.
  const col = encabezados.findIndex((h) => String(h ?? '').trim().toLowerCase() === 'folio');
  if (col > 0) {
    const letra = letraColumna(col);
    const c = await google(
      token,
      'GET',
      `${base}/values/${rango(`${hoja}!${letra}:${letra}`)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`
    );
    folios = (c.values ?? []).map((f: unknown[]) => f?.[0] ?? '');
  }
  return { encabezados, folios };
}

/** Escribe en un archivo los folios de su unidad. */
async function escribirArchivo(
  token: string,
  archivo: string,
  items: Item[],
  filas: Map<string, Fila>
): Promise<{ actualizadas: number; agregadas: number; quitadas: number; repetidos: string[] }> {
  const base = `${SHEETS}/${encodeURIComponent(archivo)}`;
  const escribir: Fila[] = [];
  const borrar: string[] = [];
  // Marca de escritura: el botón de cada equipo trae solo lo que cambió.
  const ahora = new Date().toISOString();

  for (const it of items) {
    const fila = filas.get(it.record_id);
    // Ya no existe, o ya no es de esta unidad: se quita de este archivo.
    const deOtraUnidad =
      fila && String(fila.unidad_negocio ?? '').trim().toLowerCase() !== it.unidad.trim().toLowerCase();
    if (it.borrado || !fila || deOtraUnidad) {
      const folio = fila?.folio ?? it.folio;
      if (folio) borrar.push(folio);
    } else {
      escribir.push({ ...fila, texto: { ...fila.texto, [CLAVE_ACTUALIZADO]: ahora } });
    }
  }

  const { encabezados, folios } = await leerPestana(token, base);
  const plan = planear({ hoja: PESTANA, encabezados, folios, escribir, borrar });

  // Primero lo que no mueve filas; al final se quitan, de abajo hacia arriba.
  if (plan.actualizar.length) {
    await google(token, 'POST', `${base}/values:batchUpdate`, {
      valueInputOption: 'USER_ENTERED',
      data: plan.actualizar,
    });
  }
  if (plan.agregar.length) {
    const ancho = letraColumna(Math.max(encabezados.length, 1) - 1);
    await google(
      token,
      'POST',
      `${base}/values/${rango(`${nombreHoja(PESTANA)}!A1:${ancho}1`)}:append` +
        '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
      { values: plan.agregar }
    );
  }
  if (plan.borrarFilas.length) {
    const { sheetId } = await propiedadesPestana(token, base);
    await google(token, 'POST', `${base}:batchUpdate`, {
      requests: plan.borrarFilas.map((n) => ({
        deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: n - 1, endIndex: n } },
      })),
    });
  }

  return {
    actualizadas: plan.actualizadas,
    agregadas: plan.agregar.length,
    quitadas: plan.borrarFilas.length,
    repetidos: plan.repetidos,
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Solo POST' }, 405);

  // Mismo secreto que el push y la limpieza: sin él, cualquiera con la URL
  // podría vaciar la cola.
  const esperado = Deno.env.get('PUSH_SECRET');
  if (!esperado || req.headers.get('x-push-secret') !== esperado) {
    return json({ error: 'No autorizado' }, 401);
  }

  // La configuración se revisa ANTES de tomar folios: si falta algo, la
  // cola se queda como está.
  let destinos: Record<string, string>;
  let sa: { client_email: string; private_key: string };
  try {
    destinos = JSON.parse(Deno.env.get('SHEETS_DESTINOS') || '');
    sa = JSON.parse(Deno.env.get('GOOGLE_SA_JSON') || '');
    if (!sa?.client_email || !sa?.private_key) throw new Error('GOOGLE_SA_JSON sin client_email o private_key');
  } catch (e) {
    console.error('[sheets] configuración incompleta:', (e as Error).message);
    return json({ error: 'Faltan o están mal escritos SHEETS_DESTINOS o GOOGLE_SA_JSON' }, 500);
  }

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: lote, error: errLote } = await sb.rpc('sheets_tomar_lote', { p_limite: LOTE });
  if (errLote) return json({ error: errLote.message }, 500);
  const items = (lote ?? []) as Item[];
  if (!items.length) return json({ ok: true, folios: 0 });

  const confirmar = (lista: Item[]) =>
    sb.rpc('sheets_confirmar', {
      p_record_ids: lista.map((i) => i.record_id),
      p_unidades: lista.map((i) => i.unidad),
      p_versiones: lista.map((i) => i.version),
    });
  const fallo = (lista: Item[], mensaje: string) =>
    sb.rpc('sheets_fallo', {
      p_record_ids: lista.map((i) => i.record_id),
      p_unidades: lista.map((i) => i.unidad),
      p_error: mensaje,
    });

  // Por archivo. Una unidad sin destino (hoy Biobox y Biobox Perú) sale de
  // la cola; cuando tenga archivo: select sheets_recargar('Biobox').
  const porArchivo = new Map<string, { unidad: string; items: Item[] }>();
  const sinDestino: Item[] = [];
  for (const it of items) {
    const archivo = destinoDe(destinos, it.unidad);
    if (!archivo) {
      sinDestino.push(it);
      continue;
    }
    const g = porArchivo.get(archivo) ?? { unidad: it.unidad, items: [] };
    g.items.push(it);
    porArchivo.set(archivo, g);
  }
  if (sinDestino.length) await confirmar(sinDestino);

  // Los datos de cada folio, de la vista (de 150 en 150 por el largo de la URL).
  const filas = new Map<string, Fila>();
  const ids = [...new Set([...porArchivo.values()].flatMap((g) => g.items).filter((i) => !i.borrado).map((i) => i.record_id))];
  for (let k = 0; k < ids.length; k += 150) {
    const { data, error } = await sb
      .from('vw_incidencias_sheets')
      .select('record_id,folio,unidad_negocio,texto,dato')
      .in('record_id', ids.slice(k, k + 150));
    if (error) {
      // Sin datos no se escribe nada: todo regresa a la cola.
      await fallo([...porArchivo.values()].flatMap((g) => g.items), `vista: ${error.message}`);
      return json({ error: error.message }, 500);
    }
    for (const f of (data ?? []) as Fila[]) filas.set(f.record_id, f);
  }

  if (!porArchivo.size) return json({ sin_destino: sinDestino.length });

  let token: string;
  try {
    token = await tokenGoogle(sa);
  } catch (e) {
    const msg = (e as Error).message;
    console.error('[sheets]', msg);
    await fallo([...porArchivo.values()].flatMap((g) => g.items), msg);
    return json({ error: msg }, 502);
  }

  const resumen: Record<string, unknown> = { sin_destino: sinDestino.length };
  for (const [archivo, g] of porArchivo) {
    try {
      const r = await escribirArchivo(token, archivo, g.items, filas);
      await confirmar(g.items);
      resumen[g.unidad] = r;
      if (r.repetidos.length) console.warn(`[sheets] ${g.unidad}: folios repetidos en la hoja`, r.repetidos);
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[sheets] ${g.unidad}:`, msg);
      await fallo(g.items, msg);
      resumen[g.unidad] = { error: msg };
    }
  }
  return json(resumen);
});
