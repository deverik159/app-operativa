// ============================================================
// src/lib/sinSesion.ts
// Consultas a la base que salen SIN sesión: se retienen en el cliente.
// Sin dependencias, para poder probarlo en node.
//
// POR QUÉ (25-nov-2026): cuando una renovación de sesión falla («Refresh
// Token Not Found»), supabase-js se queda sin sesión y las consultas de
// segundo plano que ya estaban por salir (contador de Aviso NUC, sus
// unidades extra, revisar la suscripción de avisos, marcar actividad) se
// mandan con la llave pública como si fueran anónimas. El rol `anon` no tiene
// permiso en ninguna tabla de la app (verificado el 25-nov-2026): el servidor
// contesta 401 y deja «permission denied for table …» en los registros de
// Postgres. No sirven para nada y ensucian el diagnóstico.
//
// Qué se hace: si la petición va a PostgREST (/rest/v1/) y su Authorization
// es la llave pública (así manda supabase-js cuando no hay sesión), no sale a
// la red y se contesta lo mismo que habría contestado el servidor: 401 con
// código 42501. Quien llama ve exactamente el error de siempre.
// No toca /auth/v1/ (entrar y renovar van sin sesión a propósito), Storage,
// funciones ni realtime.
// ============================================================

/** ¿Es una consulta a PostgREST que va sin sesión de usuario? */
export function esConsultaSinSesion(
  destino: string,
  authorization: string | null,
  llavePublica: string
): boolean {
  if (!llavePublica || !authorization) return false;
  if (!destino.split('?')[0].includes('/rest/v1/')) return false;
  return authorization.trim() === 'Bearer ' + llavePublica;
}

/** La misma respuesta que da PostgREST a `anon` sin permiso. */
export function respuestaSinSesion(): Response {
  return new Response(
    JSON.stringify({
      code: '42501',
      message: 'Sin sesión: la consulta no se mandó (la app la retuvo).',
      details: null,
      hint: null,
    }),
    { status: 401, statusText: 'Unauthorized', headers: { 'Content-Type': 'application/json' } }
  );
}
