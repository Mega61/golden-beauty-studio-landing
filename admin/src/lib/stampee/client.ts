import "server-only";

import { adventErrorMessage, type AdventReward, type StudioAdventReward } from "./advent";
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
 * (`docs/PRODUCTION_API.md` del repo de Stampee). Las **tarjetas regalo**
 * (`/gift-cards`) tienen su propio bloque, delimitado. Fuera de ellas escribe
 * dos cosas:
 * **aplicar el premio** de una tarjeta llena, igual que lo hace el kiosko de
 * Stampee, y **emitir la tarjeta de regalo** de "Te extrañamos"
 * ({@link issueWinbackCard}), que nace con los sellos que pone la campaña.
 * El **calendario de Adviento** (`/advent/rewards`) va en su bloque, al final:
 * leer los regalos y marcarlos usados (o deshacerlo).
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
    /** El `error.code` del sobre de Stampee (`ALREADY_REDEEMED`…), si vino. */
    readonly code: string | null = null,
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
    throw new StampeeError(
      `Stampee ${init.method ?? "GET"} ${path.split("?")[0]}: ${detail}`,
      response.status,
      json?.error?.code ?? null,
    );
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

// ═══ Tarjetas regalo (inicio del bloque) ════════════════════════════════════
//
// La API de tarjetas regalo de Stampee (`/gift-cards`, `/gift-card-tiers`),
// contrato en el SPEC de tarjetas regalo. Las reglas —qué se puede redimir,
// cuánto descuenta, qué viaja al CRM— no viven acá: son puras, en
// `lib/gift-cards.ts`. Acá solo se habla con Stampee, **siempre fresco**: cada
// llamada decide una escritura o un cobro, y no pasan por la caché de sellos.

export type GiftCardDto = {
  id: string;
  uniqueId: string;
  code: string;
  amountCop: number;
  status: "pending_payment" | "active" | "redeemed" | "void";
  effectiveStatus: "pending_payment" | "active" | "redeemed" | "void" | "expired";
  funded: boolean;
  source: "sale" | "advent" | "manual";
  tierId: string | null;
  tierName: string | null;
  buyerCustomerId: string | null;
  buyerName: string | null;
  buyerPhone: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  recipientCustomerId: string | null;
  message: string;
  validFrom: string | null;
  validTo: string | null;
  minTicketCop: number | null;
  transferable: boolean;
  rules: { recipient?: "any" | "new_or_dormant"; giverStampOnRedeem?: boolean; buyerStampOnPaid?: boolean; buyerStamps?: number; ref?: string } | null;
  paidAt: string | null;
  paidMethod: string | null;
  paidAmountCop: number | null;
  paidRef: string | null;
  redeemedAt: string | null;
  redeemedRef: string | null;
  redeemedAmountCop: number | null;
  voidedAt: string | null;
  voidReason: string | null;
  externalRef: string | null;
  publicUrl: string | null;
  createdAt: string;
  /** Solo en `GET /gift-cards/:id`: la bitácora de la tarjeta, la más vieja primero. */
  events?: { id: number; type: string; data: unknown; actorName: string | null; createdAt: string }[];
};

export type GiftCardTierDto = {
  id: string;
  name: string;
  amountCop: number;
  description: string;
  validityDays: number;
  isEnabled: boolean;
  sort: number;
  design: unknown;
  createdAt: string;
};

/**
 * Un fallo de Stampee, con el código HTTP y el `error.code` del sobre para que
 * quien llama decida (`TIER_UNAVAILABLE`, `ALREADY_REDEEMED`, `REF_MISMATCH`…).
 */
export type GiftCardFailure = { ok: false; status: number | null; code: string | null; message: string };

function giftFailure(error: unknown, fallback: string): GiftCardFailure {
  if (error instanceof StampeeError) {
    return {
      ok: false,
      status: error.status,
      code: error.code,
      message: error.isConfiguration
        ? "Stampee rechazó la llave del panel (STAMPEE_API_KEY)."
        : error.status === null
          ? "Stampee no respondió. Intenta en un momento."
          : `${fallback} (${error.message})`,
    };
  }
  return { ok: false, status: null, code: null, message: fallback };
}

const NOT_CONFIGURED: GiftCardFailure = {
  ok: false,
  status: null,
  code: null,
  message: "Stampee no está configurado en el panel.",
};

/** La tarjeta de un código, o `null` si no existe. Lanza `StampeeError` si Stampee falla. */
export async function getGiftCardByCode(code: string): Promise<GiftCardDto | null> {
  const config = stampeeConfigFromEnv();
  if (config === null) throw new StampeeError("Stampee no está configurado en el panel.", null);
  try {
    return await call<GiftCardDto>(config, `/gift-cards/by-code/${encodeURIComponent(code)}`);
  } catch (error) {
    if (error instanceof StampeeError && error.status === 404) return null;
    throw error;
  }
}

export async function getGiftCard(id: string): Promise<{ ok: true; card: GiftCardDto } | GiftCardFailure> {
  const config = stampeeConfigFromEnv();
  if (config === null) return NOT_CONFIGURED;
  try {
    return { ok: true, card: await call<GiftCardDto>(config, `/gift-cards/${encodeURIComponent(id)}`) };
  } catch (error) {
    return giftFailure(error, "No se pudo leer la tarjeta");
  }
}

/**
 * `GET /gift-cards`: `data` es un arreglo plano (el más nuevo primero); el
 * total va en el header `X-Total-Count`, que el panel no necesita. `status`
 * es el efectivo: `active` excluye las vencidas.
 */
export async function listGiftCards(query: {
  status?: GiftCardDto["effectiveStatus"];
  q?: string;
  limit?: number;
}): Promise<{ ok: true; cards: GiftCardDto[] } | GiftCardFailure> {
  const config = stampeeConfigFromEnv();
  if (config === null) return NOT_CONFIGURED;
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.q) params.set("q", query.q);
  params.set("limit", String(query.limit ?? 50));
  try {
    return { ok: true, cards: await call<GiftCardDto[]>(config, `/gift-cards?${params.toString()}`) };
  } catch (error) {
    return giftFailure(error, "No se pudieron leer las tarjetas regalo");
  }
}

export async function listGiftCardTiers(
  opts: { enabledOnly?: boolean } = {},
): Promise<{ ok: true; tiers: GiftCardTierDto[] } | GiftCardFailure> {
  const config = stampeeConfigFromEnv();
  if (config === null) return NOT_CONFIGURED;
  try {
    const tiers = await call<GiftCardTierDto[]>(
      config,
      `/gift-card-tiers${opts.enabledOnly ? "?enabled=1" : ""}`,
    );
    return { ok: true, tiers };
  } catch (error) {
    return giftFailure(error, "No se pudieron leer los montos de las tarjetas");
  }
}

/** Un pedido nuevo: queda `pending_payment` hasta que alguien confirme el pago. */
export async function createGiftCard(input: {
  tierId: string;
  buyer: { name: string; phone: string };
  recipientName?: string | null;
  message?: string | null;
  source: "sale" | "manual";
  rules?: GiftCardDto["rules"];
  ref?: string | null;
}): Promise<{ ok: true; card: GiftCardDto } | GiftCardFailure> {
  const config = stampeeConfigFromEnv();
  if (config === null) return NOT_CONFIGURED;
  try {
    const card = await call<GiftCardDto>(config, "/gift-cards", {
      method: "POST",
      body: JSON.stringify({
        tierId: input.tierId,
        buyer: input.buyer,
        ...(input.recipientName ? { recipientName: input.recipientName } : {}),
        ...(input.message ? { message: input.message } : {}),
        source: input.source,
        funded: true,
        ...(input.rules ? { rules: input.rules } : {}),
        ...(input.ref ? { ref: input.ref } : {}),
      }),
    });
    return { ok: true, card };
  } catch (error) {
    return giftFailure(error, "Stampee no aceptó el pedido");
  }
}

/**
 * `pending_payment → active`. Idempotente en Stampee si ya está activa con el
 * mismo `paidRef`, así que reintentar una confirmación a medias es seguro.
 */
export async function activateGiftCard(
  id: string,
  input: { paidAt: string; method: "efectivo" | "transferencia" | "otro"; paidAmountCop: number; paidRef: string },
): Promise<{ ok: true; card: GiftCardDto } | GiftCardFailure> {
  const config = stampeeConfigFromEnv();
  if (config === null) return NOT_CONFIGURED;
  try {
    const card = await call<GiftCardDto>(config, `/gift-cards/${encodeURIComponent(id)}/activate`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return { ok: true, card };
  } catch (error) {
    return giftFailure(error, "Stampee no activó la tarjeta");
  }
}

export async function voidGiftCard(
  id: string,
  reason: string,
): Promise<{ ok: true; card: GiftCardDto } | GiftCardFailure> {
  const config = stampeeConfigFromEnv();
  if (config === null) return NOT_CONFIGURED;
  try {
    const card = await call<GiftCardDto>(config, `/gift-cards/${encodeURIComponent(id)}/void`, {
      method: "POST",
      body: JSON.stringify({ reason: reason.trim().slice(0, 200) }),
    });
    return { ok: true, card };
  } catch (error) {
    return giftFailure(error, "Stampee no anuló la tarjeta");
  }
}

/**
 * Redime la tarjeta en una cuenta. `externalRef` es la cuenta
 * (`ea-appt:<id>`): Stampee contesta OK si ya estaba redimida con esa misma
 * llave, y 409 si la usó otra (`conflict`).
 */
export async function redeemGiftCard(
  code: string,
  input: {
    externalRef: string;
    amountUsedCop: number;
    customer?: { name: string; phone: string } | null;
    date: string;
  },
): Promise<
  | { ok: true; card: GiftCardDto; alreadyRedeemed: boolean }
  | (GiftCardFailure & { conflict: boolean })
> {
  const config = stampeeConfigFromEnv();
  if (config === null) return { ...NOT_CONFIGURED, conflict: false };
  try {
    const card = await call<GiftCardDto & { alreadyRedeemed?: boolean }>(config, `/gift-cards/by-code/${encodeURIComponent(code)}/redeem`, {
      method: "POST",
      body: JSON.stringify({
        externalRef: input.externalRef,
        amountUsedCop: input.amountUsedCop,
        ...(input.customer ? { customer: input.customer } : {}),
        date: input.date,
      }),
    });
    return { ok: true, card, alreadyRedeemed: card.alreadyRedeemed === true };
  } catch (error) {
    const failure = giftFailure(error, "Stampee no aceptó la tarjeta");
    return { ...failure, conflict: failure.code === "ALREADY_REDEEMED" };
  }
}

/**
 * Deshace la redención de esa cuenta. OK también si la tarjeta ya estaba
 * activa (reintentar una compensación es seguro); 409 `REF_MISMATCH` si la
 * redimió otra cuenta.
 */
export async function unredeemGiftCard(
  code: string,
  input: { externalRef: string },
): Promise<{ ok: true } | GiftCardFailure> {
  const config = stampeeConfigFromEnv();
  if (config === null) return NOT_CONFIGURED;
  try {
    await call(config, `/gift-cards/by-code/${encodeURIComponent(code)}/unredeem`, {
      method: "POST",
      body: JSON.stringify({ externalRef: input.externalRef }),
    });
    return { ok: true };
  } catch (error) {
    return giftFailure(error, "Stampee no liberó la tarjeta");
  }
}

// ═══ Tarjetas regalo (fin del bloque) ═══════════════════════════════════════

// ── Escritura: la tarjeta de regalo de "Te extrañamos" ──────────────────────

export type WinbackCardOutcome =
  | {
      ok: true;
      customerId: string;
      card: { id: string; uniqueId: string; stamps: number; totalStamps: number; rewardName: string };
      /** `false` = ya tenía una tarjeta activa de esa campaña y se reusó. */
      created: boolean;
      cardBaseUrl: string;
      /** El link permanente de la clienta, si Stampee ya lo manda; si no, el link es el de la tarjeta. */
      publicId: string | null;
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
  // Sin link no hay qué mandar: se corta ANTES de emitir, para no dejar una
  // tarjeta de regalo que nadie le va a enviar.
  if (cardBaseUrl === null) {
    return {
      ok: false,
      message: config.appUrl
        ? "Stampee no devolvió el enlace público del estudio (/profile). No se emitió nada."
        : "Falta STAMPEE_APP_URL en el panel: no hay link de tarjeta para mandar. No se emitió nada.",
    };
  }

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
    if (existing) {
      return {
        ok: true,
        customerId: customer.id,
        card: summary(existing),
        created: false,
        cardBaseUrl,
        publicId: customer.publicId ?? null,
      };
    }
  }

  try {
    // La ficha con tarjetas primero: es la que el CRM y el kiosko ya conocen.
    const known = [...matches].sort((a, b) => (b.cards?.length ?? 0) - (a.cards?.length ?? 0))[0];
    let customerId = known?.id;
    if (customerId === undefined) {
      const created = await call<{ id: string }>(config, "/customers", {
        method: "POST",
        body: JSON.stringify({ name: input.name.slice(0, 120) || input.phone, mobile: input.phone, status: "Active" }),
      });
      customerId = created.id;
    }
    const card = await call<StampeeCardRaw & { customerPublicId?: string | null }>(config, "/cards", {
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

    return {
      ok: true,
      customerId,
      card: summary(card),
      created: true,
      cardBaseUrl,
      // `POST /cards` trae el link permanente de la clienta (`customerPublicId`).
      publicId: card.customerPublicId ?? known?.publicId ?? null,
    };
  } catch (error) {
    console.error("[stampee] no se pudo emitir la tarjeta de regalo", error);
    return { ok: false, message: "Stampee no aceptó la tarjeta nueva. Intenta de nuevo." };
  } finally {
    invalidateLoyalty();
  }
}

// ═══ Calendario de Adviento ═════════════════════════════════════════════════
//
// `GET /advent/rewards`, `POST /advent/rewards/:code/redeem|unredeem`
// (contrato en `docs/ADVENT_CONTRACT.md` del repo de Stampee). Las reglas —qué
// se puede marcar, cómo se muestra— son puras, en `lib/stampee/advent.ts`.
// Marcar y deshacer van **siempre frescos**; la lista de todas para Hoy tiene
// su propia caché corta, que esas dos escrituras invalidan.

/** Un fallo de Stampee con el mensaje ya en castellano para la recepción. */
export type AdventFailure = { ok: false; status: number | null; code: string | null; message: string };

function adventFailure(error: unknown, fallback: string): AdventFailure {
  if (error instanceof StampeeError) {
    return {
      ok: false,
      status: error.status,
      code: error.code,
      message: adventErrorMessage(error.code, error.status, fallback),
    };
  }
  return { ok: false, status: null, code: null, message: fallback };
}

const ADVENT_NOT_CONFIGURED: AdventFailure = {
  ok: false,
  status: null,
  code: null,
  message: "Stampee no está configurado en el panel.",
};

/**
 * Los regalos de Adviento. Sin `customerId`, los de todas las clientas (las
 * listas de Fidelidad y Hoy). `available` trae solo los que siguen por usar,
 * de cualquier tipo; `all` también los usados, vencidos y regalados.
 */
export async function listAdventRewards(query: {
  customerId?: string;
  status: "available" | "all";
}): Promise<{ ok: true; rewards: StudioAdventReward[] } | AdventFailure> {
  const config = stampeeConfigFromEnv();
  if (config === null) return ADVENT_NOT_CONFIGURED;
  const params = new URLSearchParams();
  if (query.customerId) params.set("customerId", query.customerId);
  params.set("status", query.status);
  try {
    const data = await call<{ rewards: StudioAdventReward[] }>(config, `/advent/rewards?${params.toString()}`);
    return { ok: true, rewards: data.rewards ?? [] };
  } catch (error) {
    return adventFailure(error, "No se pudieron leer los regalos de Adviento");
  }
}

/**
 * Marca un cupón de Adviento como usado. Un segundo toque no falla: Stampee
 * contesta 200 con `alreadyRedeemed: true` (misma convención que las tarjetas
 * regalo). 409 `EXPIRED` / `NOT_YET_VALID` / `NOT_REDEEMABLE` vuelven con su
 * frase en `message`.
 */
export async function redeemAdventReward(
  code: string,
  input: { actorName: string; ticketRef?: string },
): Promise<
  | { ok: true; reward: AdventReward & { customerId: string; customerName: string }; alreadyRedeemed: boolean }
  | AdventFailure
> {
  const config = stampeeConfigFromEnv();
  if (config === null) return ADVENT_NOT_CONFIGURED;
  try {
    const data = await call<{
      reward: AdventReward & { customerId: string; customerName: string };
      alreadyRedeemed?: boolean;
    }>(config, `/advent/rewards/${encodeURIComponent(code)}/redeem`, {
      method: "POST",
      body: JSON.stringify({
        actorName: input.actorName.slice(0, 120),
        ...(input.ticketRef ? { ticketRef: input.ticketRef } : {}),
      }),
    });
    return { ok: true, reward: data.reward, alreadyRedeemed: data.alreadyRedeemed === true };
  } catch (error) {
    return adventFailure(error, "Stampee no aceptó el regalo. No se marcó nada; intenta de nuevo.");
  } finally {
    invalidateAdventRewards();
  }
}

/** Deshace un "Marcar usado" equivocado. OK también si ya estaba disponible. */
export async function unredeemAdventReward(
  code: string,
  input: { actorName: string },
): Promise<{ ok: true } | AdventFailure> {
  const config = stampeeConfigFromEnv();
  if (config === null) return ADVENT_NOT_CONFIGURED;
  try {
    await call(config, `/advent/rewards/${encodeURIComponent(code)}/unredeem`, {
      method: "POST",
      body: JSON.stringify({ actorName: input.actorName.slice(0, 120) }),
    });
    return { ok: true };
  } catch (error) {
    return adventFailure(error, "Stampee no deshizo el uso del regalo. Intenta de nuevo.");
  } finally {
    invalidateAdventRewards();
  }
}

const ADVENT_TTL_MS = 60_000;

type AdventSlot = { value: StudioAdventReward[] | null; at: number; inflight: Promise<StudioAdventReward[]> | null };
const adventGlobal = globalThis as unknown as { __gbsStampeeAdvent?: AdventSlot };
function adventSlot(): AdventSlot {
  adventGlobal.__gbsStampeeAdvent ??= { value: null, at: 0, inflight: null };
  return adventGlobal.__gbsStampeeAdvent;
}

export function invalidateAdventRewards(): void {
  const s = adventSlot();
  s.value = null;
  s.at = 0;
  s.inflight = null;
}

/**
 * Los regalos por usar de todas, para el aviso de Hoy: caché de 60 s y tope de
 * espera, como los sellos. `null` = Stampee no contestó a tiempo, no hay
 * calendario, o falló; Hoy sale sin el aviso. Nunca lanza.
 */
export async function loadAvailableAdventWithin(ms: number): Promise<StudioAdventReward[] | null> {
  const s = adventSlot();
  if (s.value && Date.now() - s.at < ADVENT_TTL_MS) return s.value;
  if (s.inflight === null) {
    const flight: Promise<StudioAdventReward[]> = listAdventRewards({ status: "available" })
      .then((result) => {
        if (!result.ok) throw new StampeeError(result.message, result.status, result.code);
        if (s.inflight === flight) {
          s.value = result.rewards;
          s.at = Date.now();
        }
        return result.rewards;
      })
      .finally(() => {
        if (s.inflight === flight) s.inflight = null;
      });
    s.inflight = flight;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([s.inflight, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
