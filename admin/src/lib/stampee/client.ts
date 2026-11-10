import "server-only";

import {
  buildSnapshot,
  phoneKey,
  type LoyaltySnapshot,
  type StampeeCampaignRaw,
  type StampeeCardRaw,
  type StampeeCustomerRaw,
} from "./model";

/**
 * El **único** lugar del panel que le habla a Stampee.
 *
 * Lee clientas, tarjetas y campañas con la API key del estudio
 * (`docs/PRODUCTION_API.md` del repo de Stampee) y escribe dos cosas:
 * **aplicar el premio** de una tarjeta llena, igual que lo hace el kiosko de
 * Stampee, y **emitir la tarjeta de regalo** de "Te extrañamos"
 * ({@link issueWinbackCard}), que nace con los sellos que pone la campaña.
 * Sellos sueltos no los escribe nunca: los pone el CRM cada noche desde las
 * visitas del panel, y dos productores de sellos sobre la misma tarjeta es
 * cómo una clienta termina con un sello de más.
 *
 * ## Se puede apagar
 *
 * Sin `STAMPEE_API_URL` + `STAMPEE_API_KEY` la pantalla de Fidelidad lo dice y
 * Hoy y la ficha simplemente no muestran sellos. Stampee caído nunca tumba una
 * pantalla del panel: es un dato accesorio.
 *
 * ## Caché
 *
 * Una lectura completa por minuto, compartida por Hoy, la ficha y Fidelidad (un
 * solo vuelo por vez), con respaldo de hasta 10 min si Stampee no responde. El
 * canje la invalida. **El canje no lee de caché**: decide una escritura.
 */

const TTL_MS = 60_000;
const STALE_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;

export type StampeeConfig = {
  baseUrl: string;
  apiKey: string;
  /** La app de Stampee como la abre un navegador, para el link a la tarjeta. */
  appUrl: string | null;
};

export function stampeeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StampeeConfig | null {
  const baseUrl = env.STAMPEE_API_URL?.trim().replace(/\/+$/, "");
  const apiKey = env.STAMPEE_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, appUrl: env.STAMPEE_APP_URL?.trim().replace(/\/+$/, "") || null };
}

export class StampeeError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "StampeeError";
  }
  /** 401/403: la llave está mal o la revocaron. Reintentar no lo arregla. */
  get isConfiguration(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

async function call<T>(config: StampeeConfig, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch (error) {
    throw new StampeeError(`Stampee no respondió (${(error as Error).name})`, null);
  }

  const text = await response.text();
  let json: { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Un 502 del proxy no es JSON.
  }
  if (!response.ok || json?.ok !== true) {
    const detail = json?.error?.message ?? json?.error?.code ?? `HTTP ${response.status}`;
    throw new StampeeError(`Stampee ${init.method ?? "GET"} ${path.split("?")[0]}: ${detail}`, response.status);
  }
  return json.data as T;
}

// ── Lectura ─────────────────────────────────────────────────────────────────

export type LoyaltyData = LoyaltySnapshot & {
  /** `https://…/<slug>`; la tarjeta pública es `${cardBaseUrl}/${uniqueId}`. */
  cardBaseUrl: string | null;
  fetchedAt: Date;
};

export type LoyaltyResult =
  | { ok: true; data: LoyaltyData; stale: boolean }
  | { ok: false; reason: "sin-configurar" | "caido"; message: string };

type CacheSlot = {
  value: LoyaltyData | null;
  at: number;
  inflight: Promise<LoyaltyData> | null;
  /** Sube con cada canje: una lectura que salió antes no puede pisar el después. */
  generation: number;
};

const globalCache = globalThis as unknown as { __gbsStampee?: CacheSlot };
function slot(): CacheSlot {
  globalCache.__gbsStampee ??= { value: null, at: 0, inflight: null, generation: 0 };
  return globalCache.__gbsStampee;
}

async function fetchAll(config: StampeeConfig): Promise<LoyaltyData> {
  const [customers, campaigns, profile] = await Promise.all([
    call<StampeeCustomerRaw[]>(config, "/customers?include=cards,transactions"),
    call<StampeeCampaignRaw[]>(config, "/campaigns"),
    // Solo para el link a la tarjeta; sin él la pantalla sigue.
    call<{ slug?: string | null }>(config, "/profile").catch(() => null),
  ]);
  const slug = profile?.slug;
  return {
    ...buildSnapshot(customers, campaigns),
    cardBaseUrl: config.appUrl && slug ? `${config.appUrl}/${slug}` : null,
    fetchedAt: new Date(),
  };
}

/** Todas las tarjetas, resumidas. Nunca lanza. */
export async function loadLoyalty(): Promise<LoyaltyResult> {
  const config = stampeeConfigFromEnv();
  if (config === null) {
    return {
      ok: false,
      reason: "sin-configurar",
      message: "Falta STAMPEE_API_URL o STAMPEE_API_KEY en el entorno del panel.",
    };
  }

  const cache = slot();
  const now = Date.now();
  if (cache.value && now - cache.at < TTL_MS) return { ok: true, data: cache.value, stale: false };

  if (cache.inflight === null) {
    const generation = cache.generation;
    const flight: Promise<LoyaltyData> = fetchAll(config)
      .then((data) => {
        if (cache.generation === generation) {
          cache.value = data;
          cache.at = Date.now();
        }
        return data;
      })
      .finally(() => {
        if (cache.inflight === flight) cache.inflight = null;
      });
    cache.inflight = flight;
  }

  try {
    return { ok: true, data: await cache.inflight, stale: false };
  } catch (error) {
    console.error("[stampee] la lectura falló", error);
    if (cache.value && now - cache.at < STALE_MS) return { ok: true, data: cache.value, stale: true };
    return {
      ok: false,
      reason: "caido",
      message:
        error instanceof StampeeError && error.isConfiguration
          ? "Stampee rechazó la llave del panel (STAMPEE_API_KEY). Hay que crear una nueva en Stampee → Ajustes → API."
          : "Stampee no respondió. Los sellos se ven de nuevo cuando vuelva.",
    };
  }
}

/**
 * {@link loadLoyalty} con tope de espera, para las pantallas donde los sellos
 * son un detalle (Hoy). Si Stampee tarda más, la pantalla sale sin sellos y la
 * lectura sigue en vuelo: la próxima carga ya la encuentra en caché.
 */
export async function loadLoyaltyWithin(ms: number): Promise<LoyaltyResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([loadLoyalty(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function invalidateLoyalty(): void {
  const cache = slot();
  cache.value = null;
  cache.at = 0;
  cache.inflight = null;
  cache.generation += 1;
}

// ── Escritura: aplicar el premio ────────────────────────────────────────────

export type RedeemOutcome =
  | { ok: true; customerName: string; rewardName: string; historyRecorded: boolean }
  | { ok: false; message: string };

/**
 * Cierra una tarjeta llena como **canjeada**, igual que el botón "Redeem" del
 * kiosko de Stampee: estado `Redeemed` + fecha, y una transacción `redeem` en
 * la historia de la tarjeta (con quién lo hizo, porque la llave firma como
 * "api").
 *
 * Vuelve a leer la tarjeta fresca antes de escribir: aplicar un premio a una
 * tarjeta que no está llena —o que alguien ya canjeó desde el kiosko— es
 * regalar un servicio.
 *
 * La API de Stampee no tiene un canje atómico: son dos llamadas. Si la segunda
 * falla, la tarjeta queda canjeada sin renglón en su historia, que es el lado
 * seguro (no se puede volver a canjear) y se avisa.
 */
export async function redeemCard(
  cardId: string,
  ctx: { actorName: string; today: string },
): Promise<RedeemOutcome> {
  const config = stampeeConfigFromEnv();
  if (config === null) return { ok: false, message: "Stampee no está configurado en el panel." };

  let fresh: LoyaltyData;
  try {
    fresh = await fetchAll(config);
  } catch (error) {
    console.error("[stampee] no se pudo leer la tarjeta antes del canje", error);
    return { ok: false, message: "Stampee no respondió. No se aplicó nada; intenta en un momento." };
  }

  const owner = fresh.clients.find((c) => c.cards.some((card) => card.id === cardId));
  const card = owner?.cards.find((c) => c.id === cardId);
  if (!owner || !card) return { ok: false, message: "Esa tarjeta ya no está en Stampee." };
  if (card.stage === "canjeada") {
    invalidateLoyalty();
    return { ok: false, message: `El premio de ${owner.name} ya se había aplicado.` };
  }
  if (card.stage !== "lista") {
    return {
      ok: false,
      message: `A ${owner.name} todavía le ${card.remaining === 1 ? "falta 1 sello" : `faltan ${card.remaining} sellos`}.`,
    };
  }

  try {
    await call(config, `/cards/${encodeURIComponent(cardId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "Redeemed", completedDate: ctx.today }),
    });
  } catch (error) {
    console.error("[stampee] el canje falló", error);
    return { ok: false, message: "Stampee no aceptó el canje. No se aplicó nada; intenta de nuevo." };
  } finally {
    invalidateLoyalty();
  }

  let historyRecorded = true;
  try {
    const now = new Date();
    await call(config, `/cards/${encodeURIComponent(cardId)}/transactions`, {
      method: "POST",
      body: JSON.stringify({
        type: "redeem",
        amount: 0,
        date: ctx.today,
        timestamp: now.getTime(),
        title: "Reward Redeemed",
        remarks: `Aplicado desde el panel por ${ctx.actorName}`.slice(0, 500),
      }),
    });
  } catch (error) {
    console.error("[stampee] la tarjeta quedó canjeada sin renglón en su historia", error);
    historyRecorded = false;
  }

  return { ok: true, customerName: owner.name, rewardName: card.rewardName, historyRecorded };
}

// ── Escritura: la tarjeta de regalo de "Te extrañamos" ──────────────────────

export type WinbackCardOutcome =
  | {
      ok: true;
      customerId: string;
      card: { id: string; uniqueId: string; stamps: number; totalStamps: number; rewardName: string };
      /** `false` = ya tenía una tarjeta activa de esa campaña y se reusó. */
      created: boolean;
      cardBaseUrl: string | null;
    }
  | { ok: false; message: string };

/**
 * Le emite a una clienta una tarjeta **nueva** de la campaña de "Te
 * extrañamos", que nace con los sellos de regalo de la campaña
 * (`bonusStamps`): Stampee los pone al emitirla, el panel no escribe sellos.
 * Es la única otra escritura del panel en Stampee, además del canje.
 *
 * - Lee fresco (decide una escritura) y busca a la clienta por los últimos 10
 *   dígitos del celular. Si no existe en Stampee —vino antes de que hubiera
 *   tarjetas— se crea. **Nunca crea una segunda ficha** para un número que ya
 *   está: el CRM cruza por teléfono y dos fichas con el mismo número le
 *   esconderían una.
 * - Si ya tiene una tarjeta activa de esa campaña, la devuelve: tocar el botón
 *   dos veces no regala dos tarjetas.
 * - Anota el renglón `issued` con los sellos regalados, para que Stampee, el
 *   panel y el CRM los cuenten como regalo y no como visitas aunque después se
 *   cambie la campaña.
 */
export async function issueWinbackCard(input: {
  phone: string;
  name: string;
  campaignId: string;
  actorName: string;
  today: string;
}): Promise<WinbackCardOutcome> {
  const config = stampeeConfigFromEnv();
  if (config === null) return { ok: false, message: "Stampee no está configurado en el panel." };

  let customers: StampeeCustomerRaw[];
  let campaigns: StampeeCampaignRaw[];
  let slug: string | null | undefined;
  try {
    [customers, campaigns, slug] = await Promise.all([
      call<StampeeCustomerRaw[]>(config, "/customers?include=cards"),
      call<StampeeCampaignRaw[]>(config, "/campaigns"),
      call<{ slug?: string | null }>(config, "/profile")
        .then((p) => p?.slug)
        .catch(() => null),
    ]);
  } catch (error) {
    console.error("[stampee] no se pudo leer antes de emitir la tarjeta de regalo", error);
    return { ok: false, message: "Stampee no respondió. No se emitió nada; intenta en un momento." };
  }
  const cardBaseUrl = config.appUrl && slug ? `${config.appUrl}/${slug}` : null;

  const campaign = campaigns.find((c) => c.id === input.campaignId);
  if (!campaign) return { ok: false, message: "La campaña de \"Te extrañamos\" ya no está en Stampee." };
  if (!campaign.isEnabled) {
    return { ok: false, message: `La campaña "${campaign.name}" está apagada en Stampee. Actívala para emitir tarjetas.` };
  }
  const summary = (raw: { id: string; uniqueId: string; stamps: number }) => ({
    id: raw.id,
    uniqueId: raw.uniqueId,
    stamps: raw.stamps,
    totalStamps: campaign.totalStamps,
    rewardName: campaign.rewardName ?? "",
  });

  const key = phoneKey(input.phone);
  const matches = key === null ? [] : customers.filter((c) => phoneKey(c.mobile) === key);
  for (const customer of matches) {
    const existing = (customer.cards ?? []).find(
      (card) => card.campaignId === campaign.id && card.status !== "Redeemed",
    );
    if (existing) return { ok: true, customerId: customer.id, card: summary(existing), created: false, cardBaseUrl };
  }

  try {
    // La ficha con tarjetas primero: es la que el CRM y el kiosko ya conocen.
    let customerId = [...matches].sort((a, b) => (b.cards?.length ?? 0) - (a.cards?.length ?? 0))[0]?.id;
    if (customerId === undefined) {
      const created = await call<{ id: string }>(config, "/customers", {
        method: "POST",
        body: JSON.stringify({ name: input.name.slice(0, 120) || input.phone, mobile: input.phone, status: "Active" }),
      });
      customerId = created.id;
    }
    const card = await call<StampeeCardRaw>(config, "/cards", {
      method: "POST",
      body: JSON.stringify({ customerId, campaignId: campaign.id }),
    });

    try {
      await call(config, `/cards/${encodeURIComponent(card.id)}/transactions`, {
        method: "POST",
        body: JSON.stringify({
          type: "issued",
          amount: card.stamps,
          date: input.today,
          timestamp: Date.now(),
          title: "Card Issued",
          remarks: `Te extrañamos · desde el panel por ${input.actorName}`.slice(0, 500),
        }),
      });
    } catch (error) {
      // Sin el renglón, Stampee y el CRM toman los sellos de regalo de la
      // campaña, que hoy dice lo mismo: se sigue.
      console.error("[stampee] la tarjeta de regalo quedó sin renglón de emisión", error);
    }

    return { ok: true, customerId, card: summary(card), created: true, cardBaseUrl };
  } catch (error) {
    console.error("[stampee] no se pudo emitir la tarjeta de regalo", error);
    return { ok: false, message: "Stampee no aceptó la tarjeta nueva. Intenta de nuevo." };
  } finally {
    invalidateLoyalty();
  }
}
