import React from 'react';
import ReactDOM from 'react-dom/client';
// CSS de Leaflet DENTRO del bundle, no desde un CDN: con red débil en campo
// el JS (local) cargaba pero el CSS (cdnjs) no, y el mapa salía con los
// mosaicos apilados en columna y los controles rotos.
// Antes de index.css para que sus ajustes de Leaflet le ganen en cascada.
import 'leaflet/dist/leaflet.css';
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
