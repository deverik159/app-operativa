// ============================================================
// src/components/LimiteSilencioso.tsx
// Límite de errores mínimo para piezas del ARMAZÓN que no deben tumbar la
// app: si su render falla, se reporta y no se pinta nada.
//
// POR QUÉ (revisión del diseño de la cola de tomas, 22-oct-2026): el aviso
// global de envíos vive en App, fuera del <ErrorBoundary> de cada módulo.
// Un registro viejo o raro de la cola de tomas que tronara al pintarse
// dejaba la pantalla en blanco para todos los roles, no solo en Pauta.
// ============================================================
import { Component, type ReactNode } from 'react';
import { reportarError } from '../lib/reportarError';

type Props = { nombre: string; children: ReactNode };
type State = { fallo: boolean };

export default class LimiteSilencioso extends Component<Props, State> {
  state: State = { fallo: false };

  static getDerivedStateFromError(): State {
    return { fallo: true };
  }

  componentDidCatch(error: Error): void {
    reportarError('render:' + this.props.nombre, error);
  }

  render() {
    return this.state.fallo ? null : this.props.children;
  }
}
