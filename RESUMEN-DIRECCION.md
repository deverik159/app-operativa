# Central de Operaciones GPO VALLAS — Resumen para Dirección

_Septiembre de 2026 · Documento de contexto: qué hace la app y cómo ordena
la operación. El detalle técnico vive en HANDOFF-COMPLETO-GPOVALLAS.md._

## Qué es

Una aplicación web propia (funciona en cualquier celular o computadora, se
instala como app) que centraliza la operación de campo de GPO VALLAS:
**incidencias en los medios, revisiones de máquinas Biobox, avance de pauta,
fijación externa y disponibilidad de inventario**. Sustituye reportes por
WhatsApp/Excel con un flujo trazable: cada falla tiene folio, responsable,
evidencia fotográfica y tiempos medidos.

## El flujo central: una incidencia de principio a fin

1. **Se reporta** (personal de campo o monitoreo): se elige el sitio y la
   cara afectada del inventario real, la falla sale de un **catálogo
   cerrado** —no texto libre—, y la evidencia (foto/video) es obligatoria.
   El catálogo decide solo el área responsable y el nivel de la falla; el
   reportante no tiene que saberlo.
2. **Se valida**: un validador la aprueba o rechaza. Su tiempo de respuesta
   corre contra un **SLA configurable** (hoy 20 minutos en horario hábil).
3. **Se repara**: el técnico del área correcta la recibe con notificación
   push al celular, documenta diagnóstico y solución (en Digital, guiado por
   el árbol técnico de fallas) y sube evidencia obligatoria de la reparación.
4. **Se cierra**: el validador aprueba la reparación con la evidencia a la
   vista, o la rechaza con motivo (cada rechazo se cuenta como indicador).

Cada paso deja rastro: quién, cuándo, con qué foto. Los indicadores se
calculan de estos datos, no de reportes manuales.

## Comunicación dentro del ticket

- **Notificaciones push al celular** (incluido iPhone): cada cambio de manos
  avisa solo a quien le toca actuar — el validador cuando hay algo nuevo que
  validar, el técnico cuando le llega trabajo, el área nueva cuando se
  aprueba una reasignación. Tocar la notificación abre la incidencia exacta,
  aunque la app estuviera cerrada.
- **Chat por incidencia**: todos los involucrados en el ticket (reportante,
  validador, técnico) conversan dentro de la propia incidencia, con fotos y
  videos cortos. El hilo es parte del expediente: los mensajes no pueden
  borrarse (las correcciones quedan marcadas como "editado" y el texto
  original se conserva) y al cerrar la incidencia el chat queda de solo
  lectura. Nada de la operación se decide en canales externos sin rastro.

## Qué mide (pestaña Indicadores)

- Incidencias por estatus, área, unidad de negocio, tipo y nivel.
- **Cumplimiento de SLA** de validación y de reparación por área.
- **Rechazos de reparación**: cuántas veces una reparación no pasó la
  validación (calidad del trabajo de campo).
- Disponibilidad de caras para venta (consultada por comercial en vivo).

## Los módulos, en una línea cada uno

- **Incidencias** — el flujo descrito arriba; el corazón de la app.
- **Máquinas Biobox** — revisión periódica contra checklist: el revisor
  marca punto por punto y, ante una anomalía, elige la causa de una lista
  cerrada definida por el área; la incidencia se levanta sola con el
  responsable y la prioridad correctos.
- **Pauta y Monitoreo** — avance fotográfico de las campañas por catorcena.
- **Fijación Externa** — las órdenes del sistema del proveedor (Mario Luna)
  llegan a la app conectadas base a base; las cuadrillas marcan lo fijado
  con evidencia obligatoria y atienden ahí mismo las incidencias del sitio.
- **Disponibilidad** — "¿puedo vender esta cara en estas fechas?": estatus,
  retiros y pauta vigente en una sola consulta.
- **Rutas de Monitoreo** — mapas de recorridos con navegación al sitio.

## Datos que la app conecta (sin capturar dos veces)

- **Inventario y pauta de QTM**: sitios, caras, estatus comercial y campañas
  vigentes se sincronizan; al reportar en una pantalla, la campaña de ESA
  cara se precarga sola desde la pauta.
- **Sistema de fijación del proveedor**: conexión directa entre bases de
  datos, sin recaptura ni correos.
- **Nombres operativos**: las 103 megapantallas de Ecovallas y las máquinas
  Biobox se identifican por su nombre de calle ("Reforma 350"), no solo por
  clave.

## Seguridad y control

- Acceso con correo corporativo y **roles** (reportante, validador, técnico,
  coordinador, manager, consulta): cada quien ve y toca solo lo suyo, y las
  reglas se aplican en la base de datos, no solo en pantalla.
- La evidencia es obligatoria en cada paso que cambia un estatus.

## Estado (18-sep-2026)

Operando en producción (app-operativa.vercel.app) con los módulos de arriba
completos y verificados de punta a punta. En agenda: que el sistema del
proveedor asigne cuadrillas directamente sobre nuestras incidencias, y
replicar el módulo de órdenes de trabajo a Implementaciones, Instalaciones e
Iluminación cuando existan sus bases.
