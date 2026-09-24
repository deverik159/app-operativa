import React from 'react';
import ReactDOM from 'react-dom/client';
// CSS de Leaflet DENTRO del bundle, no desde un CDN: con red débil en campo
// el JS (local) cargaba pero el CSS (cdnjs) no, y el mapa salía con los
// mosaicos apilados en columna y los controles rotos.
// Antes de index.css para que sus ajustes de Leaflet le ganen en cascada.
//
// Se queda AQUÍ aunque Rutas y Fijación ya se carguen diferidos (auditoría
// primer mes, 24-sep-2026): el CSS de un chunk diferido se inserta DESPUÉS
// de index.css, y entonces leaflet.css ganaría los empates —mismo
// selector, misma especificidad—: `.leaflet-container{background:#ddd}`
// pisaría el fondo oscuro (el mapa destellaría gris claro al cargar
// mosaicos) y la atribución perdería su padding compacto. Además, un CSS
// diferido que no llega es otro "Unable to preload CSS" posible en campo.
// Son ~15 KB sin comprimir (~4 KB por la red): no vale el riesgo.
import 'leaflet/dist/leaflet.css';
import './index.css';
import App from './App';
import { registrarSW } from './lib/push';
import { instalarReporteGlobal } from './lib/reportarError';

// Antes del render: así también se registra lo que truene al arrancar.
instalarReporteGlobal();

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
