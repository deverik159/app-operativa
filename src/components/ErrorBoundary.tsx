// ============================================================
// src/components/ErrorBoundary.tsx
// Contiene el error de render de UN módulo.
//
// Sin esto, una excepción al pintar (un null inesperado que llega por FDW o
// QTM) desmontaba TODA la app: pantalla en blanco, sin menú ni forma de
// salir, para todos los que abrieran ese módulo (auditoría, 24-sep-2026).
// Ahora la barra y el menú sobreviven, el error se registra, y el usuario
// puede reintentar o cambiarse de módulo (al cambiar, el error se limpia).
//
// Desde la carga diferida (auditoría primer mes, 24-sep-2026) también llegan
// aquí los chunks que no se pudieron descargar —versión nueva publicada o
// señal cortada— cuando lazyConReintento ya no pudo resolverlo solo. Ese
// caso NO es un error del módulo y se explica distinto: lo que lo arregla
// es recargar (o esperar señal), no reportarlo a sistemas.
// ============================================================
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportarError } from '../lib/reportarError';
import { esErrorDeChunk, reintentarCargasFallidas } from '../lib/cargaDiferida';
import { confirmarRecargaConEnvios } from '../lib/envios';

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
    // Un chunk que no llegó va con su propio prefijo: así en errores_cliente
    // se separa "hubo despliegue / sin señal" de un error real de pantalla.
    // No inunda la tabla: reportarError descarta repetidos por firma
    // (módulo + mensaje, y el mensaje trae la URL del chunk) y tiene tope
    // por sesión, así que Reintentar varias veces deja UNA fila.
    if (esErrorDeChunk(error)) {
      reportarError('chunk:' + this.props.modulo, error);
      return;
    }
    reportarError('render:' + this.props.modulo, error, {
      componentStack: (info.componentStack || '').slice(0, 2000),
    });
  }

  /**
   * Limpia el error. Antes libera los módulos diferidos que fallaron: si
   * no, React.lazy repetiría el mismo rechazo guardado sin volver a pedir
   * el chunk (ver reintentarCargasFallidas).
   */
  limpiar = () => {
    reintentarCargasFallidas();
    this.setState({ error: null });
  };

  /**
   * "Recargar la app", preguntando antes si un reporte se perdería: con uno
   * así en vuelo la recarga automática por chunk se retiene y el usuario
   * llega justo a este aviso (integración primer mes, 24-sep-2026).
   */
  recargar = () => {
    if (confirmarRecargaConEnvios()) window.location.reload();
  };

  componentDidUpdate(prev: Props) {
    // Cambiar de módulo (o de llave) es la salida natural: arranca limpio.
    if (
      this.state.error &&
      (prev.modulo !== this.props.modulo || prev.resetKey !== this.props.resetKey)
    )
      this.limpiar();
  }

  render() {
    if (!this.state.error) return this.props.children;

    if (esErrorDeChunk(this.state.error)) {
      return (
        <div className="err" role="alert" style={{ lineHeight: 1.5 }}>
          <b>
            Hay una versión nueva de la app o se cortó la conexión al abrir
            este módulo.
          </b>
          <br />
          Toca Recargar la app para traer la versión al día. Si no tienes
          señal, espera a tenerla antes de recargar.
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <button type="button" className="btn sm" onClick={this.recargar}>
              Recargar la app
            </button>
            {/* Secundario: Chrome guarda el fallo del import() por URL y ahí
                solo la recarga lo arregla; en otros navegadores Reintentar
                sí vuelve a descargar el módulo. */}
            <button type="button" className="btn ghost sm" onClick={this.limpiar}>
              Reintentar
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="err" role="alert" style={{ lineHeight: 1.5 }}>
        <b>Este módulo tuvo un error y no se pudo mostrar.</b>
        <br />
        Ya quedó registrado para revisarlo. Puedes reintentar, cambiarte de
        módulo desde el menú o recargar la app.
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <button type="button" className="btn sm" onClick={this.limpiar}>
            Reintentar
          </button>
          <button type="button" className="btn ghost sm" onClick={this.recargar}>
            Recargar la app
          </button>
        </div>
      </div>
    );
  }
}
