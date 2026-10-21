// ============================================================
// src/lib/erroresAcceso.ts
// Errores de Supabase Auth en español (21-oct-2026). Auth responde en
// inglés ("Invalid login credentials") y la pantalla de inicio lo mostraba
// tal cual. Se traduce por `code` (auth-js ≥ 2.6) y, si no viene, por el
// texto; lo que no se reconozca sale como llegó, para no esconder la causa.
// ============================================================

type ErrorAuth = { code?: string; message?: string; status?: number };

/** Segundos de espera que trae "you can only request this after 45 seconds". */
function segundos(msg: string): string | null {
  const m = /after (\d+) seconds?/i.exec(msg);
  return m ? m[1] : null;
}

export function errorAccesoEnEspanol(error: ErrorAuth): string {
  const code = error.code || '';
  const msg = error.message || '';

  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg))
    return 'Correo o contraseña incorrectos. Si nunca has creado contraseña, entra con Google o toca «Olvidé mi contraseña».';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg))
    return 'Tu correo todavía no está confirmado. Pídele a un administrador que lo confirme.';
  if (code === 'user_banned' || /banned/i.test(msg))
    return 'Tu acceso está bloqueado. Pídele a un administrador que lo revise.';
  if (code === 'signup_disabled' || /signups? not allowed/i.test(msg))
    return 'Tu correo no está dado de alta en la app. Pídele a un administrador que te dé de alta.';
  if (code === 'over_email_send_rate_limit' || /email rate limit/i.test(msg) || segundos(msg)) {
    const s = segundos(msg);
    return s
      ? `Por seguridad, espera ${s} segundos antes de pedir otro correo.`
      : 'Se enviaron demasiados correos. Espera un rato antes de pedir otro.';
  }
  if (code === 'over_request_rate_limit' || /rate limit|too many requests/i.test(msg))
    return 'Demasiados intentos seguidos. Espera unos minutos y vuelve a intentar.';
  if (code === 'same_password' || /different from the old password/i.test(msg))
    return 'La contraseña nueva debe ser distinta de la anterior.';
  if (code === 'weak_password' || /password should be at least/i.test(msg))
    return 'La contraseña es muy débil: usa al menos 6 caracteres.';
  if (code === 'email_address_invalid' || /invalid format|unable to validate email/i.test(msg))
    return 'El correo no es válido. Revisa que esté bien escrito.';
  if (
    code === 'session_not_found' ||
    code === 'session_expired' ||
    /auth session missing/i.test(msg)
  )
    return 'El enlace ya no es válido. Pide otro con «Olvidé mi contraseña».';
  return msg || 'No se pudo completar. Intenta de nuevo.';
}

/**
 * Al abrir un enlace de correo vencido o ya usado, Supabase regresa a la app
 * con el error en el hash (#error_code=otp_expired&…). Devuelve el aviso en
 * español, o null si la URL no trae error.
 */
export function errorEnlaceCorreo(hash: string): string | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const code = p.get('error_code');
  if (!code && !p.get('error')) return null;
  if (code === 'otp_expired')
    return 'El enlace del correo ya venció o ya se usó. Pide otro con «Olvidé mi contraseña».';
  return errorAccesoEnEspanol({
    code: code || undefined,
    message: p.get('error_description') || undefined,
  });
}
