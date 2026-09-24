// ============================================================
// src/lib/xlsxDiferido.ts
// La librería de Excel (xlsx, ~424 KB) se baja SOLO al importar o exportar.
//
// Por qué (auditoría primer mes, 24-sep-2026): con los módulos ya diferidos,
// xlsx seguía llegando con Pauta, Rutas y la Bitácora porque sus archivos la
// importaban de forma estática. Un monitorista que abre Pauta en el celular
// cada mañana descargaba 424 KB para un botón de importar que no es suyo.
//
// Una sola promesa compartida: el segundo clic no vuelve a pedir el archivo.
// Si falla (sin red, o un despliegue nuevo borró el chunk viejo) se olvida,
// para que el siguiente intento lo vuelva a pedir en vez de fallar siempre.
// ============================================================
type ModuloXlsx = typeof import('xlsx');

let pendiente: Promise<ModuloXlsx> | null = null;

export function cargarXlsx(): Promise<ModuloXlsx> {
  if (!pendiente) {
    pendiente = import('xlsx').catch((e) => {
      pendiente = null;
      throw e;
    });
  }
  return pendiente;
}
