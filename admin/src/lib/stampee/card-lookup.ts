import { leadingCard, phoneKey, type LoyaltyClient, type LoyaltySnapshot } from "./model";

/**
 * "Encuentra tu tarjeta Golden": de celular + primer nombre al link de la
 * tarjeta de sellos —puro, testeado—. Lo usa la ruta pública
 * `api/public/tarjeta/buscar`, que alimenta la sección `#mi-tarjeta` de la
 * landing y la fila del `/bio`.
 *
 * ## El riesgo, y quién lo aceptó
 *
 * El link de la tarjeta es una llave al portador: abre los sellos y "Mis
 * regalos" (cupones del calendario de adviento y, si los tiene, el código
 * completo de sus tarjetas regalo). Mandarlo por WhatsApp no se puede todavía
 * (la Cloud API no está prendida), así que se muestra en pantalla. Juan lo
 * decidió el 2026-11-16 sabiendo eso: celular **y** primer nombre, nada más.
 * Lo que este módulo pone encima:
 *
 * - **No revela quién es clienta.** Celular desconocido y nombre que no
 *   coincide responden exactamente lo mismo.
 * - **No deja adivinar el nombre.** Cinco nombres errados para un mismo celular
 *   en una hora lo bloquean por esa hora ({@link createAttemptGate}); bloqueado,
 *   también responde "no encontrada", aunque el nombre sea el correcto.
 * - **No devuelve datos de la clienta**: ni nombre, ni correo, ni regalos. Solo
 *   el link y cuántos sellos lleva.
 */

export type CardMatch = {
  url: string;
  stamps: number;
  totalStamps: number;
  rewardName: string;
};

/** "María José" → "maria". Sin tildes, sin mayúsculas, solo la primera palabra. */
export function firstNameKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const word = raw
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .find((w) => w.length > 0);
  return word ?? null;
}

function bestClient(clients: readonly LoyaltyClient[]): LoyaltyClient | null {
  // Si hay dos fichas con el mismo celular y nombre, la que tenga la tarjeta
  // activa más cerca del premio; si ninguna tiene activa, la que tenga tarjeta.
  let best: LoyaltyClient | null = null;
  for (const client of clients) {
    if (client.cards.length === 0) continue;
    if (best === null) {
      best = client;
      continue;
    }
    if (leadingCard(best.cards) === null && leadingCard(client.cards) !== null) best = client;
  }
  return best;
}

/**
 * La tarjeta de quien escribió ese celular y ese nombre, o `null`.
 *
 * `cardBaseUrl` es `https://…/<slug>` (de `loadLoyalty`). El link es el
 * permanente de la clienta (`publicId`, Stampee #10) cuando la lectura lo trae;
 * si no, el de su tarjeta (`uniqueId`), que Stampee resuelve a esa misma página
 * permanente y reescribe la URL.
 */
export function findCard(
  snapshot: LoyaltySnapshot,
  cardBaseUrl: string,
  phone: string,
  name: string,
): CardMatch | null {
  const key = phoneKey(phone);
  const first = firstNameKey(name);
  if (key === null || key.length < 10 || first === null) return null;

  const matches = snapshot.clients.filter(
    (c) => c.phoneKey === key && firstNameKey(c.name) === first,
  );
  const client = bestClient(matches);
  if (client === null) return null;

  const card = leadingCard(client.cards) ?? client.cards[0];
  // `publicId` llega con el calendario de adviento; leído así para no depender
  // de que el tipo ya lo tenga en esta rama.
  const publicId = (client as { publicId?: string | null }).publicId;
  return {
    url: `${cardBaseUrl.replace(/\/+$/, "")}/${publicId || card.uniqueId}`,
    stamps: card.stamps,
    totalStamps: card.totalStamps,
    rewardName: card.rewardName,
  };
}

export type AttemptGate = {
  /** ¿Este celular ya gastó sus intentos? */
  locked(phoneKey: string): boolean;
  /** Anota un nombre errado (o un celular que no es de nadie). */
  fail(phoneKey: string): void;
};

/**
 * Intentos fallidos por celular, en memoria (el panel es un solo contenedor).
 * Un celular que no es de nadie también suma: así un barrido de números se
 * frena igual, y la respuesta no cambia según exista o no.
 */
export function createAttemptGate(options: {
  maxFailures: number;
  windowMs: number;
  maxEntries?: number;
  now?: () => number;
}): AttemptGate {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 2000;
  const failures = new Map<string, number[]>();

  const recent = (key: string) => {
    const t = now();
    const list = (failures.get(key) ?? []).filter((at) => t - at < options.windowMs);
    if (list.length === 0) failures.delete(key);
    else failures.set(key, list);
    return list;
  };

  return {
    locked(key) {
      return recent(key).length >= options.maxFailures;
    },
    fail(key) {
      const list = recent(key);
      failures.delete(key);
      while (failures.size >= maxEntries) {
        const oldest = failures.keys().next().value;
        if (oldest === undefined) break;
        failures.delete(oldest);
      }
      failures.set(key, [...list, now()]);
    },
  };
}
