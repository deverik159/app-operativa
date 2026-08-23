import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { registrarSW } from './lib/push';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// El service worker se registra al arrancar, no al pedir el permiso: así ya
// está listo cuando el usuario toca "Activar", y el navegador puede ofrecer
// instalar la app.
//
// Va DESPUÉS del render y sin await: si algo falla aquí, la app debe cargar
// igual. Las notificaciones son un extra, no un requisito para operar.
registrarSW();
