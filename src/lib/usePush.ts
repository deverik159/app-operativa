// ============================================================
// src/lib/usePush.ts
// Estado de los avisos push compartido entre el botón de la barra
// (BotonPush) y el aviso de abajo (AvisoPush), para que activar en uno
// se vea al instante en el otro.
//
// Se revisa al abrir y cada vez que la app vuelve al frente (con un mínimo
// de 5 min entre revisiones): una suscripción la puede dar de baja el
// servidor en cualquier momento.
// ============================================================
import { useEffect, useSyncExternalStore } from 'react';
import { reactivarAlEntrar, revisarPush } from './push';
import type { RevisionPush } from './push';

// Con el correo: si en la misma pestaña entra otra cuenta, no hereda el
// estado de la anterior.
let actual: (RevisionPush & { email: string }) | null = null;
let enCurso: Promise<void> | null = null;
let ultima = 0;
const oyentes = new Set<() => void>();

const ENTRE_REVISIONES_MS = 5 * 60 * 1000;
const EVENTO_ABRIR = 'push:abrir';

function avisar() {
  oyentes.forEach((f) => f());
}

/** Vuelve a revisar (botón de activar, ↻). Si ya hay una en curso, la espera. */
export function refrescarPush(email: string): Promise<void> {
  if (enCurso) return enCurso;
  enCurso = revisarPush()
    .then((r) => {
      actual = { ...r, email };
      ultima = Date.now();
      avisar();
    })
    .catch(() => {
      // Sin cambiar lo que ya se sabía.
    })
    .finally(() => {
      enCurso = null;
    });
  return enCurso;
}

function suscribir(f: () => void) {
  oyentes.add(f);
  return () => {
    oyentes.delete(f);
  };
}

export function usePush(email: string): RevisionPush | null {
  const r = useSyncExternalStore(suscribir, () => actual);
  useEffect(() => {
    if (actual?.email !== email) void refrescarPush(email);
    // Si este teléfono tenía los avisos activos para esta cuenta cuando
    // salió, se reactivan solos (Erik, 12-nov-2026; ver bajaAlSalir).
    void reactivarAlEntrar(email).then((si) => {
      if (si) void refrescarPush(email);
    });
    const alVolver = () => {
      if (document.visibilityState === 'visible' && Date.now() - ultima > ENTRE_REVISIONES_MS)
        void refrescarPush(email);
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => document.removeEventListener('visibilitychange', alVolver);
  }, [email]);
  return r && r.email === email ? r : null;
}

/** Abre la ventana de BotonPush desde otro lugar (el aviso de abajo). */
export function abrirPanelPush() {
  window.dispatchEvent(new Event(EVENTO_ABRIR));
}

export function alPedirPanelPush(f: () => void) {
  window.addEventListener(EVENTO_ABRIR, f);
  return () => window.removeEventListener(EVENTO_ABRIR, f);
}
