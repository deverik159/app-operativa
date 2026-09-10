// Detecta una publicación nueva sin interrumpir a quien está capturando datos.
// La recarga siempre la decide el usuario desde el aviso de App.
declare const __APP_BUILD_ID__: string;

export const BUILD_ID = __APP_BUILD_ID__;

type VersionRemota = { id?: unknown };

export function vigilarNuevaVersion(alEncontrar: () => void): () => void {
  if (!import.meta.env.PROD) return () => {};
  let detenida = false;

  const revisar = async () => {
    try {
      const res = await fetch(`/version.json?_=${Date.now()}`, {
        cache: 'no-store',
      });
      if (!res.ok || detenida) return;
      const version = (await res.json()) as VersionRemota;
      if (typeof version.id === 'string' && version.id !== BUILD_ID)
        alEncontrar();
    } catch {
      // Una pérdida de red no debe mostrar una falsa actualización.
    }
  };

  const alVolver = () => {
    if (document.visibilityState === 'visible') void revisar();
  };
  void revisar();
  document.addEventListener('visibilitychange', alVolver);
  const intervalo = window.setInterval(revisar, 5 * 60 * 1000);
  return () => {
    detenida = true;
    window.clearInterval(intervalo);
    document.removeEventListener('visibilitychange', alVolver);
  };
}
