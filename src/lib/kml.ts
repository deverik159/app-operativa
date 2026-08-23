// ============================================================
// src/lib/kml.ts
// Lectura de un KML/KMZ exportado de Google My Maps.
//
// El mapa de las máquinas está armado en My Maps: cada CAPA es una ruta y
// cada MARCADOR una máquina. En el KML eso se traduce a <Folder> y
// <Placemark>. No hay API pública para leer un mapa de My Maps, así que el
// camino es exportar el archivo y subirlo — el mismo patrón que ya se usa
// para la pauta.
//
// LO DELICADO ESTÁ EN LOS NOMBRES. Los marcadores se llaman "Leibnitz - 116",
// "Palmas - 46": nombre de la esquina y, después de un guion, el número de la
// máquina, que es el sufijo de su `site_id` (ver la sección de empate). Pero
// el mapa lo llenaron personas distintas a lo largo de meses, así que hay:
//
//   "Masarayk Moliere- 91"      → guion pegado al nombre
//   "Masaryk Taine 34"          → sin guion
//   "Nicolas Romero - UCL0002"  → el ID no es numérico
//   "OXXO Apolonia"             → sin ID
//   "OXXO Héroes de 47"         → el 47 es de la CALLE, no es un ID
//
// Ese último caso es el que obliga a ser estricto: solo se toma como ID lo
// que viene después de un guion. Un número suelto al final del nombre se
// marca como dudoso y se resuelve por coordenadas, no adivinando. Empatar
// mal una máquina manda al monitorista a otra colonia.
// ============================================================

export type PlacemarkKml = {
  /** Nombre tal cual viene en el mapa. */
  nombre: string;
  /** Nombre sin el sufijo del ID, para mostrar. */
  nombreLimpio: string;
  /** ID después del guion. null si el nombre no lo trae. */
  id: string | null;
  /** true si hay un número al final pero SIN guion: no es de fiar. */
  idDudoso: boolean;
  lat: number;
  lng: number;
  descripcion: string | null;
  /** Orden dentro de la capa, tal como está en el archivo. */
  secuencia: number;
};

export type CapaKml = {
  nombre: string;
  paradas: PlacemarkKml[];
};

/**
 * Arriba de esto, una capa deja de parecer una ruta de monitoreo. Sirve para
 * avisar cuando las capas no se detectaron y todo cayó en una sola.
 */
const MAX_PARADAS_RAZONABLE = 45;

/** Solo se toma como ID lo que sigue a un guion: "… - 116", "…- 91". */
const RE_ID_CONFIABLE = /[-–—]\s*([A-Za-z]{0,4}\d{1,6})\s*$/;
/** Número suelto al final, sin guion. Sospechoso: puede ser parte del nombre. */
const RE_ID_DUDOSO = /\s(\d{1,6})\s*$/;
/**
 * El nombre ENTERO es un ID ("116", "UCL0002"). Pasa cuando alguien puso el
 * marcador con prisa. Se toma como dudoso —no como confiable— porque sin más
 * contexto no hay forma de descartar que sea una etiqueta cualquiera; la
 * cercanía a inventario lo confirma.
 */
const RE_ID_SOLO = /^([A-Za-z]{0,4}\d{1,6})$/;

function limpiar(s: string | null | undefined): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** Separa el nombre del ID según las reglas de arriba. */
export function partirNombre(bruto: string): {
  nombreLimpio: string;
  id: string | null;
  idDudoso: boolean;
} {
  const n = limpiar(bruto);

  const conGuion = n.match(RE_ID_CONFIABLE);
  if (conGuion) {
    return {
      nombreLimpio: limpiar(n.slice(0, conGuion.index)).replace(/[-–—]\s*$/, '').trim(),
      id: conGuion[1].toUpperCase(),
      idDudoso: false,
    };
  }

  const solo = n.match(RE_ID_SOLO);
  if (solo) {
    return { nombreLimpio: n, id: solo[1].toUpperCase(), idDudoso: true };
  }

  const suelto = n.match(RE_ID_DUDOSO);
  if (suelto) {
    return { nombreLimpio: n, id: suelto[1], idDudoso: true };
  }

  return { nombreLimpio: n, id: null, idDudoso: false };
}

/** Texto de un hijo directo, sin heredar el de los Placemark de adentro. */
function textoHijo(el: Element, tag: string): string | null {
  for (let i = 0; i < el.children.length; i++) {
    const h = el.children[i];
    if (h.tagName === tag || h.tagName.endsWith(':' + tag))
      return limpiar(h.textContent);
  }
  return null;
}

/**
 * Coordenadas de un Placemark.
 *
 * KML las escribe como "lng,lat,altitud" —longitud PRIMERO, al revés de
 * como se leen normalmente. Invertirlas manda todos los puntos al océano
 * Índico, y como el mapa igual dibuja algo, el error pasa desapercibido.
 */
function coordenadas(pm: Element): { lat: number; lng: number } | null {
  const nodos = pm.getElementsByTagName('coordinates');
  const crudo = nodos.length ? limpiar(nodos[0].textContent) : '';
  if (!crudo) return null;
  // Una línea puede traer varios pares (LineString). Para un marcador basta
  // el primero.
  const par = crudo.split(/\s+/)[0].split(',');
  const lng = parseFloat(par[0]);
  const lat = parseFloat(par[1]);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** Descripción: primero <description>, luego los <Data> de ExtendedData. */
function descripcion(pm: Element): string | null {
  const d = textoHijo(pm, 'description');
  if (d) {
    // My Maps mete HTML en la descripción cuando el punto tiene foto.
    const plano = limpiar(d.replace(/<[^>]*>/g, ' '));
    if (plano) return plano;
  }
  const datos = pm.getElementsByTagName('Data');
  const partes: string[] = [];
  for (let i = 0; i < datos.length; i++) {
    const nombre = datos[i].getAttribute('name') || '';
    const valor = limpiar(datos[i].getElementsByTagName('value')[0]?.textContent);
    // My Maps repite el nombre del punto como Data: no aporta nada.
    if (valor && !/^nombre$/i.test(nombre)) partes.push(valor);
  }
  return partes.length ? partes.join(' · ') : null;
}

/**
 * Convierte el XML de un KML en capas y paradas.
 *
 * Los Placemark que no cuelgan de ningún Folder van a una capa
 * "(sin capa)": es preferible mostrarlos y que alguien decida, a perderlos
 * en silencio.
 */
export function leerKml(xml: string): { capas: CapaKml[]; errores: string[] } {
  const errores: string[] = [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  // DOMParser no lanza excepción con XML roto: mete un <parsererror>.
  if (doc.getElementsByTagName('parsererror').length) {
    return { capas: [], errores: ['El archivo no es un KML válido.'] };
  }
  if (!doc.getElementsByTagName('Placemark').length) {
    return {
      capas: [],
      errores: [
        'El archivo no contiene marcadores. Si es un .kmz, descomprímelo ' +
          'primero, o exporta desde My Maps marcando "Exportar a un archivo .KML".',
      ],
    };
  }

  const capas: CapaKml[] = [];
  const vistos = new Set<Element>();

  const armar = (pms: Element[], nombreCapa: string) => {
    const paradas: PlacemarkKml[] = [];
    pms.forEach((pm) => {
      const bruto = textoHijo(pm, 'name') || '';
      const c = coordenadas(pm);
      if (!c) {
        errores.push(
          `"${bruto || '(sin nombre)'}" en la capa "${nombreCapa}" no trae coordenadas: se omite.`
        );
        return;
      }
      const { nombreLimpio, id, idDudoso } = partirNombre(bruto);
      paradas.push({
        nombre: limpiar(bruto),
        nombreLimpio: nombreLimpio || limpiar(bruto),
        id,
        idDudoso,
        lat: c.lat,
        lng: c.lng,
        descripcion: descripcion(pm),
        secuencia: paradas.length + 1,
      });
    });
    if (paradas.length) capas.push({ nombre: nombreCapa, paradas });
  };

  // Las capas de My Maps salen como <Folder>. Pero hay exportaciones —mapas
  // de una sola capa, o hechos con otra herramienta— donde los Placemark
  // cuelgan directo del <Document>. Sin este respaldo, esos 200 marcadores
  // caerían todos en "(sin capa)" y la importación crearía UNA ruta con todo:
  // un resultado equivocado presentado como éxito, que es justo lo que la
  // vista previa existe para evitar.
  const folders = doc.getElementsByTagName('Folder');
  const contenedores: Element[] =
    folders.length > 0
      ? Array.from(folders)
      : Array.from(doc.getElementsByTagName('Document')).filter((d) =>
          Array.from(d.children).some((h) => h.tagName === 'Placemark')
        );

  for (let i = 0; i < contenedores.length; i++) {
    const f = contenedores[i];
    // Un Folder puede contener otros Folder. Solo se toman los Placemark
    // que son hijos DIRECTOS, para no duplicarlos en la capa padre.
    const pms: Element[] = [];
    for (let j = 0; j < f.children.length; j++) {
      const h = f.children[j];
      if (h.tagName === 'Placemark') {
        pms.push(h);
        vistos.add(h);
      }
    }
    armar(pms, textoHijo(f, 'name') || `Capa ${i + 1}`);
  }

  const todos = doc.getElementsByTagName('Placemark');
  const sueltos: Element[] = [];
  for (let i = 0; i < todos.length; i++) {
    if (!vistos.has(todos[i])) sueltos.push(todos[i]);
  }
  if (sueltos.length) armar(sueltos, '(sin capa)');

  // Una "ruta" de 60 paradas no es una ruta: es que las capas no se
  // detectaron. Se avisa en vez de dejar que se importe callando.
  capas.forEach((c) => {
    if (c.paradas.length > MAX_PARADAS_RAZONABLE)
      errores.push(
        `La capa "${c.nombre}" trae ${c.paradas.length} marcadores. Si el mapa ` +
          'tiene varias rutas, revisa que estén como capas separadas.'
      );
  });

  return { capas, errores };
}


// ============================================================
// Empate contra inventario
//
// EL DIAGNÓSTICO CAMBIÓ LO QUE SE CREÍA. `site_legacy_id` NO es el número
// del mapa: es el NOMBRE que le da la operación a la máquina
// ("ALBERCA OLÍMPICA", "AMSTERDAM LAREDO"). El número del mapa es el
// SUFIJO NUMÉRICO DEL site_id:
//
//   "Alberca Olímpica - 99"  →  MX_CM_BB_MEC_0099  ("ALBERCA OLÍMPICA")
//   "Alfonso Reyes - 102"    →  MX_CM_BB_MED_0102  ("ALFONSO REYES")
//   "Amsterdam Laredo - 27"  →  MX_CM_BB_MED_0027  ("AMSTERDAM LAREDO")
//
// Comprobado contra las 10 filas de muestra: 10/10.
//
// Eso deja DOS señales independientes en cada marcador —el número y el
// nombre— más la distancia. Que dos coincidan es evidencia fuerte; que se
// contradigan es exactamente lo que hay que enseñarle a quien importa, no
// resolverlo adivinando.
// ============================================================

export type FilaInventario = {
  site_id: string | null;
  site_legacy_id: string | null;
  vendor_face_id: string;
  direccion: string | null;
  /** 'Digital' | 'Impreso'. Una ruta de Biobox mezcla los dos. */
  tipo_medio?: string | null;
  latitud: number | null;
  longitud: number | null;
};

export type Confianza = 'alta' | 'media' | 'baja' | 'ninguna';

export type Empate = {
  /**
   * Identidad del marcador dentro de esta importación. Es un contador, NO se
   * deriva del nombre: en el mapa real hay marcadores homónimos, incluso en
   * la misma capa ("Ejercito Nacional"). Con llave por nombre, desmarcar uno
   * desmarcaría al otro y el que sí empató se quedaría fuera sin que nadie
   * lo notara.
   */
  idx: number;
  parada: PlacemarkKml;
  capa: string;
  /** Posición de la capa en el archivo. Desambigua capas homónimas. */
  capaIdx: number;

  site_id: string | null;
  site_legacy_id: string | null;
  direccion: string | null;
  /** Digital o Impreso, de inventario. La ruta mezcla ambos. */
  tipo_medio: string | null;
  /** Metros entre el marcador del mapa y la coordenada de inventario. */
  metros: number | null;
  confianza: Confianza;
  /** Por qué se empató (o por qué no). Se muestra en la vista previa. */
  motivo: string;
  /** El mismo site_id lo reclama otro marcador. */
  duplicado: boolean;
};

/** Distancia en metros. Haversine: sobra para distinguir 50 m de 5 km. */
export function metrosEntre(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Hasta aquí se cree que es la misma máquina aunque nada más coincida. */
const METROS_MEDIA = 60;
/** Más allá de esto no se propone nada por cercanía: es otra ubicación. */
const METROS_BAJA = 250;
/** Distancia a partir de la cual un empate por número se vuelve sospechoso. */
const METROS_SOSPECHA = 400;

/** El número del mapa contra el sufijo de site_id: "MX_CM_BB_MED_0102" → "102". */
function numeroDeSiteId(siteId: string | null | undefined): string | null {
  const m = (siteId || '').match(/(\d+)\s*$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? null : String(n);
}

/** "0046" y "46" son la misma máquina; "116.0" también (cortesía de Excel). */
function normalizarNumero(s: string | null | undefined): string | null {
  const t = (s || '').toString().trim().replace(/\.0+$/, '');
  if (!/^\d+$/.test(t)) return null;
  return String(parseInt(t, 10));
}

/**
 * Nombre comparable: sin acentos, sin signos, en mayúsculas.
 *
 * El mapa escribe "Amsterdam y Chilpancingo" y el inventario
 * "ÁMSTERDAM Y CHILPANCINGO". Sin normalizar, no coinciden.
 */
export function normalizarNombre(s: string | null | undefined): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/**
 * ¿Son el mismo lugar? Se acepta que uno contenga al otro, porque el mapa
 * suele traer un dato de más: "San Antonio y Xola" contra "ANTONIO Y XOLA".
 *
 * El mínimo de 6 caracteres evita que "OXXO" empate con cualquier OXXO.
 */
function mismoNombre(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 6 || b.length < 6) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Cruza las capas del KML con inventario usando tres señales:
 *
 *   número  → el sufijo de site_id ("… - 102" ↔ MX_CM_BB_MED_0102)
 *   nombre  → site_legacy_id, que es como la operación llama a la máquina
 *   metros  → distancia entre el marcador y la coordenada de inventario
 *
 * `alta` exige que DOS señales coincidan. Una sola señal nunca pasa de
 * `media`, y una contradicción entre número y nombre baja a `baja` diciendo
 * cuál es cuál. Empatar mal una máquina manda al monitorista a otra colonia:
 * más vale que alguien confirme diez filas a que se importen cien mal.
 */
export function empatarInventario(
  capas: CapaKml[],
  inventario: FilaInventario[]
): Empate[] {
  const porNumero = new Map<string, FilaInventario>();
  const porNombre = new Map<string, FilaInventario[]>();
  const conCoords: FilaInventario[] = [];

  inventario.forEach((r) => {
    const n = numeroDeSiteId(r.site_id);
    // El primero gana. Los site_id son únicos, así que no debería haber
    // choques; si los hubiera, el nombre y la distancia lo resuelven.
    if (n && !porNumero.has(n)) porNumero.set(n, r);

    const nom = normalizarNombre(r.site_legacy_id);
    if (nom) porNombre.set(nom, [...(porNombre.get(nom) || []), r]);

    if (r.latitud != null && r.longitud != null) conCoords.push(r);
  });

  /** La máquina de inventario más cercana a un punto. */
  const cercana = (lat: number, lng: number) => {
    let mejor: FilaInventario | null = null;
    let d = Infinity;
    conCoords.forEach((r) => {
      const m = metrosEntre(lat, lng, r.latitud as number, r.longitud as number);
      if (m < d) {
        d = m;
        mejor = r;
      }
    });
    return mejor ? { fila: mejor as FilaInventario, metros: d } : null;
  };

  /** Nombre del mapa contra site_legacy_id. Solo sirve si es inequívoco. */
  const porNombreUnico = (nombreMapa: string): FilaInventario | null => {
    const n = normalizarNombre(nombreMapa);
    if (!n) return null;
    const exacto = porNombre.get(n);
    // Un nombre repetido en inventario no identifica nada.
    if (exacto) return exacto.length === 1 ? exacto[0] : null;
    const parciales: FilaInventario[] = [];
    porNombre.forEach((filas, clave) => {
      if (mismoNombre(n, clave)) parciales.push(...filas);
    });
    return parciales.length === 1 ? parciales[0] : null;
  };

  const distancia = (p: PlacemarkKml, f: FilaInventario): number | null =>
    f.latitud != null && f.longitud != null
      ? metrosEntre(p.lat, p.lng, f.latitud, f.longitud)
      : null;

  const res: Empate[] = [];
  let n = 0;

  capas.forEach((capa, ci) => {
    capa.paradas.forEach((p) => {
      const base = {
        idx: n++,
        parada: p,
        capa: capa.nombre,
        capaIdx: ci,
        duplicado: false,
      };
      const armar = (
        f: FilaInventario | null,
        confianza: Confianza,
        motivo: string,
        metros: number | null
      ) => {
        res.push({
          ...base,
          site_id: f?.site_id ?? null,
          site_legacy_id: f?.site_legacy_id ?? null,
          direccion: f?.direccion ?? null,
          tipo_medio: f?.tipo_medio ?? null,
          metros,
          confianza,
          motivo,
        });
      };

      const numKey = normalizarNumero(p.id);
      const candidatoNum = numKey ? porNumero.get(numKey) || null : null;
      const porNom = porNombreUnico(p.nombreLimpio);
      const cerca = cercana(p.lat, p.lng);

      const dNumCand = candidatoNum ? distancia(p, candidatoNum) : null;

      // Un número DUDOSO que apunta a kilómetros de distancia no es un
      // número: es parte del nombre. "OXXO Héroes de 47" existe como
      // máquina 47, pero está a 58 km — el 47 es de la calle. Se descarta
      // por completo y el marcador se resuelve por nombre o cercanía, que
      // es lo que de verdad lo identifica. Un número CONFIABLE (después de
      // un guion) sí se conserva aunque esté lejos: ahí el dato existe y
      // alguien tiene que mirarlo.
      const numeroFalso =
        p.idDudoso && dNumCand != null && dNumCand > METROS_SOSPECHA;
      const porNum = numeroFalso ? null : candidatoNum;
      const dNum = numeroFalso ? null : dNumCand;
      const dNom = porNom ? distancia(p, porNom) : null;

      // 1) Número y nombre apuntan a la MISMA máquina. Nada le gana a esto.
      if (porNum && porNom && porNum.site_id === porNom.site_id) {
        armar(
          porNum,
          'alta',
          `Número ${p.id} y nombre "${porNum.site_legacy_id}" coinciden`,
          dNum
        );
        return;
      }

      // 2) Número y nombre se CONTRADICEN. No se elige en silencio: se
      //    propone el que además esté cerca, y se dice cuál era el otro.
      if (porNum && porNom) {
        const ganaNombre =
          dNom != null && (dNum == null || dNom < dNum);
        const elegido = ganaNombre ? porNom : porNum;
        armar(
          elegido,
          'baja',
          `El número ${p.id} apunta a ${porNum.site_id} y el nombre a ` +
            `${porNom.site_id}. Se propone ${elegido.site_id} por cercanía. Confirmar.`,
          ganaNombre ? dNom : dNum
        );
        return;
      }

      // 3) Solo el número. Si además está cerca (o la máquina no tiene
      //    coordenadas para desmentirlo), es un empate sólido.
      if (porNum) {
        const lejos = dNum != null && dNum > METROS_SOSPECHA;
        const confiable = !p.idDudoso && !lejos;
        armar(
          porNum,
          confiable ? 'alta' : lejos ? 'baja' : 'media',
          lejos
            ? `El número ${p.id} existe (${porNum.site_legacy_id}), pero inventario ` +
                `lo ubica a ${Math.round(dNum as number)} m. Revisar.`
            : p.idDudoso
              ? `El "${p.id}" del nombre coincide con ${porNum.site_legacy_id}` +
                (dNum != null ? ` (a ${Math.round(dNum)} m)` : ' (sin coordenadas)')
              : `Número ${p.id} → ${porNum.site_legacy_id}` +
                (dNum != null ? ` (a ${Math.round(dNum)} m)` : ''),
          dNum
        );
        return;
      }

      // 4) Solo el nombre. Sirve para los marcadores que nunca tuvieron
      //    número ("OXXO Apolonia", "Ejercito Nacional").
      if (porNom) {
        const lejos = dNom != null && dNom > METROS_SOSPECHA;
        armar(
          porNom,
          lejos ? 'baja' : dNom != null && dNom <= METROS_BAJA ? 'alta' : 'media',
          `Nombre igual a "${porNom.site_legacy_id}"` +
            (dNom != null ? ` (a ${Math.round(dNom)} m)` : ' (sin coordenadas)') +
            (lejos ? '. Está lejos: revisar.' : ''),
          dNom
        );
        return;
      }

      // 5) Sin número ni nombre utilizables: queda la cercanía.
      if (cerca && cerca.metros <= METROS_MEDIA) {
        armar(
          cerca.fila,
          'media',
          `Sin número ni nombre reconocibles. La máquina "${cerca.fila.site_legacy_id}" ` +
            `está a ${Math.round(cerca.metros)} m`,
          cerca.metros
        );
        return;
      }
      if (cerca && cerca.metros <= METROS_BAJA) {
        armar(
          cerca.fila,
          'baja',
          `Lo más cercano es "${cerca.fila.site_legacy_id}", a ` +
            `${Math.round(cerca.metros)} m. Confirmar.`,
          cerca.metros
        );
        return;
      }

      // 6) Nada.
      armar(
        null,
        'ninguna',
        p.id
          ? `Ni el número ${p.id} ni el nombre están en inventario, y no hay ` +
              'ninguna máquina cerca.'
          : 'El nombre no está en inventario y no hay ninguna máquina cerca.',
        cerca ? cerca.metros : null
      );
    });
  });

  // Marcar los que se pelean el mismo site_id. `ruta_ubicaciones` tiene
  // UNIQUE(site_id): si dos marcadores apuntan a la misma máquina, el
  // segundo movería a la primera de ruta sin que nadie se enterara.
  const cuenta = new Map<string, number>();
  res.forEach((e) => {
    if (e.site_id) cuenta.set(e.site_id, (cuenta.get(e.site_id) || 0) + 1);
  });
  res.forEach((e) => {
    if (e.site_id && (cuenta.get(e.site_id) || 0) > 1) e.duplicado = true;
  });

  return res;
}
