// ============================================================
// src/lib/chatLocal.ts
// COPIA EN EL TELÉFONO de cada chat de incidencia que se abrió, para leer
// el historial sin señal (25-sep-2026). Antes, sin red, el chat decía
// "Sin mensajes. Escribe el primero." aunque tuviera toda una conversación.
//
// Qué se guarda y qué no:
//   · Solo chats que el usuario YA abrió con señal, y solo lo que ya bajó
//     al verlos: no se descarga nada extra, así que no cuesta datos. Bajar
//     de antemano los chats de todas las incidencias sí costaría (egress y
//     batería) y no se hace.
//   · Texto, datos de los adjuntos y lecturas; las fotos/videos no: se ven
//     sin señal solo si el navegador ya los tiene en su caché (se suben con
//     caché de un año), y si no, la burbuja lo dice.
//   · Los últimos MAX_MENSAJES de cada chat y los MAX_CHATS abiertos más
//     recientemente por usuario: ~KB por chat, el total ni se nota.
//   · Por correo: en un teléfono compartido cada quien ve solo sus copias,
//     y al Salir se borran las suyas (App.tsx, igual que la lista).
//
// Mismas reglas que datosLocales: nada aquí lanza ni bloquea — sin
// IndexedDB, o si no contesta, simplemente no hay copia.
// ============================================================
import { datosGet, datosTx } from './idbDatos';
import type { ChatAdjunto, ChatLectura, Mensaje } from '../types/db';

const MAX_MENSAJES = 150;
const MAX_CHATS = 60;

export type ChatLocal = {
  clave: string;
  email: string;
  record_id: string;
  /** Cuándo se guardó (lo que se enseña como "copia de las 10:32"). */
  guardado: string;
  mensajes: Mensaje[];
  adjuntos: ChatAdjunto[];
  lecturas: ChatLectura[];
  /** false = la base no tenía chat_lecturas al guardarla. */
  conLecturas: boolean;
};

/** Qué chats tiene guardados cada usuario y cuándo, para podar los viejos. */
type Indice = { clave: string; email: string; chats: Record<string, string> };

const llaveEmail = (email: string) => (email || '').trim().toLowerCase();
const claveChat = (email: string, recordId: string) =>
  `${llaveEmail(email)}|${recordId}`;
const claveIndice = (email: string) => `${llaveEmail(email)}|__indice`;

/** La copia de ese chat, o null. No lanza. */
export async function leerChatLocal(
  email: string,
  recordId: string
): Promise<ChatLocal | null> {
  try {
    if (!llaveEmail(email) || !recordId) return null;
    const r = await datosGet<ChatLocal>('chats', claveChat(email, recordId));
    if (!r || !Array.isArray(r.mensajes)) return null;
    return {
      ...r,
      adjuntos: Array.isArray(r.adjuntos) ? r.adjuntos : [],
      lecturas: Array.isArray(r.lecturas) ? r.lecturas : [],
      conLecturas: !!r.conLecturas,
    };
  } catch {
    return null;
  }
}

/**
 * Guarda la copia de un chat recién visto. No lanza. OJO quien llama: solo
 * datos que llegaron del servidor con sesión real. Un hilo sin mensajes no
 * se guarda: los mensajes no se borran, así que un [] nunca es más cierto
 * que una copia con mensajes (sería una respuesta anónima o incompleta).
 *
 * `adjuntos`/`lecturas` en null = "no se pudieron leer esta vez": se
 * conservan los de la copia anterior. Una consulta que falló (se fue la
 * señal justo al abrir) no debe dejar la copia sin fotos ni ✓✓.
 *
 * Todo en UNA transacción (índice, copia anterior y escritura): dos chats
 * guardados casi al mismo tiempo no se pisan el índice.
 */
export async function guardarChatLocal(
  email: string,
  recordId: string,
  datos: {
    mensajes: Mensaje[];
    adjuntos: ChatAdjunto[] | null;
    lecturas: ChatLectura[] | null;
    conLecturas: boolean | null;
  }
): Promise<void> {
  try {
    const k = llaveEmail(email);
    if (!k || !recordId || !datos.mensajes.length) return;
    const mensajes = datos.mensajes.slice(-MAX_MENSAJES);
    const ids = new Set(mensajes.map((m) => m.id));
    const guardado = new Date().toISOString();
    const clave = claveChat(email, recordId);
    await datosTx(['chats'], 'readwrite', (tx) => {
      const st = tx.objectStore('chats');
      const pideIndice = st.get(claveIndice(email));
      const pidePrevio = st.get(clave);
      let listos = 0;
      const escribir = () => {
        if (++listos < 2) return;
        const previo = pidePrevio.result as ChatLocal | undefined;
        const indice = pideIndice.result as Indice | undefined;
        const adjuntos = (datos.adjuntos ?? previo?.adjuntos ?? []).filter((a) =>
          ids.has(a.mensaje_id)
        );
        const copia: ChatLocal = {
          clave,
          email: k,
          record_id: recordId,
          guardado,
          mensajes,
          adjuntos,
          lecturas: datos.lecturas ?? previo?.lecturas ?? [],
          conLecturas: datos.conLecturas ?? previo?.conLecturas ?? false,
        };
        const chats = { ...(indice?.chats || {}), [recordId]: guardado };
        // Poda: se quedan los MAX_CHATS vistos más recientemente.
        const sobran = Object.entries(chats)
          .sort((a, b) => b[1].localeCompare(a[1]))
          .slice(MAX_CHATS)
          .map(([rid]) => rid);
        sobran.forEach((rid) => delete chats[rid]);
        st.put(copia);
        st.put({ clave: claveIndice(email), email: k, chats } as Indice);
        sobran.forEach((rid) => st.delete(claveChat(email, rid)));
      };
      pideIndice.onsuccess = escribir;
      pidePrevio.onsuccess = escribir;
    });
  } catch {
    /* sin base o sin espacio: la copia anterior (si había) sigue */
  }
}

/**
 * Borra todas las copias de chat de ese usuario (Salir). No lanza. Por
 * rango de llave ("correo|…") y no por el índice: si el índice se hubiera
 * perdido, las copias no se quedarían huérfanas en un teléfono compartido.
 */
export async function borrarChatsLocal(email: string): Promise<void> {
  try {
    const k = llaveEmail(email);
    if (!k) return;
    await datosTx(['chats'], 'readwrite', (tx) => {
      tx.objectStore('chats').delete(IDBKeyRange.bound(`${k}|`, `${k}|\uffff`));
    });
  } catch {
    /* sin base: no había nada */
  }
}
