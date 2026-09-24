// ============================================================
// src/components/ErrorBoundary.tsx
// Contiene el error de render de UN módulo.
//
// Sin esto, una excepción al pintar (un null inesperado que llega por FDW o
// QTM) desmontaba TODA la app: pantalla en blanco, sin menú ni forma de
// salir, para todos los que abrieran ese módulo (auditoría, 24-sep-2026).
// Ahora la barra y el menú sobreviven, el error se registra, y el usuario
// puede reintentar o cambiarse de módulo (al cambiar, el error se limpia).
// ============================================================
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportarError } from '../lib/reportarError';

type Props = {
  /** Nombre del módulo: va al registro y resetea el error al cambiar. */
  modulo: string;
  /**
   * Cualquier cambio de esta llave limpia el error (sin remontar nada en el
   * uso normal: solo actúa si hay un error puesto). Sirve para que alternar
   * Mis pendientes ↔ Incidencias, tocar una notificación o ↻ también saquen
   * al usuario del aviso, aunque el módulo registrado sea el mismo.
   */
  resetKey?: string;
  children: ReactNode;
};

type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportarError('render:' + this.props.modulo, error, {
      componentStack: (info.componentStack || '').slice(0, 2000),
    });
  }

  componentDidUpdate(prev: Props) {
    // Cambiar de módulo (o de llave) es la salida natural: arranca limpio.
    if (
      this.state.error &&
      (prev.modulo !== this.props.modulo || prev.resetKey !== this.props.resetKey)
    )
      this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="err" role="alert" style={{ lineHeight: 1.5 }}>
        <b>Este módulo tuvo un error y no se pudo mostrar.</b>
        <br />
        Ya quedó registrado para revisarlo. Puedes reintentar, cambiarte de
        módulo desde el menú o recargar la app.
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <button
            type="button"
            className="btn sm"
            onClick={() => this.setState({ error: null })}
          >
            Reintentar
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => window.location.reload()}
          >
            Recargar la app
          </button>
        </div>
      </div>
    );
  }
}
