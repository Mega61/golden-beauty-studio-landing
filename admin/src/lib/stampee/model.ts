/**
 * Las tarjetas de sellos de Stampee, leídas para mostrar —puro, testeado—.
 *
 * Stampee es la tarjeta de fidelización del estudio: cada visita completada
 * suma un sello (lo hace el CRM cada noche, a partir de las visitas que le
 * manda el panel en `jobs/crm-visits.ts`), y con la tarjeta llena la clienta
 * tiene su premio. El panel **no da sellos**: los lee para que la dueña vea
 * quién va por dónde y, sobre todo, a quién hay que aplicarle el premio cuando
 * llega.
 *
 * ## De dónde sale cada número
 *
 * La API de Stampee devuelve filas crudas (`GET /customers?include=cards,
 * transactions` y `GET /campaigns`); este módulo las resume con las mismas
 * reglas que `summarizeCard()` de su `api/src/routes/lookup.ts`, para que el
 * panel y Stampee digan lo mismo de la misma tarjeta:
 *
 * - **La meta es la de la foto de la tarjeta** (`templateSnapshot.totalStamps`),
 *   no la de la campaña de hoy: es lo que la clienta ve en su celular. Cambiar
 *   la campaña no le mueve la meta a quien ya tiene la tarjeta.
 * - **Sellos regalados no son visitas.** Los de bienvenida (`bonusStamps`, con
 *   tope de meta − 1: una tarjeta no puede nacer llena) y los de win-back
 *   (transacciones `gift`) se restan para contar las visitas.
 * - **Lista para canjear** = activa y sin sellos por completar.
 */

/** Cuántos sellos de distancia cuentan como "a punto". */
export const NEAR_REWARD_STAMPS = 2;

// ── Lo que manda Stampee ────────────────────────────────────────────────────

export type StampeeTransaction = {
  type: string;
  amount: number;
  /** Milisegundos. Llega como número o como texto según la versión de la API. */
  timestamp: number | string;
};

export type StampeeCardRaw = {
  id: string;
  uniqueId: string;
  customerId?: string;
  campaignId: string | null;
  campaignName: string;
  stamps: number;
  lastVisit?: string | null;
  status: string;
  completedDate?: string | null;
  templateSnapshot?: Record<string, unknown> | null;
  history?: StampeeTransaction[];
};

export type StampeeCustomerRaw = {
  id: string;
  name: string;
  email?: string | null;
  mobile?: string | null;
  status?: string;
  cards?: StampeeCardRaw[];
};

export type StampeeCampaignRaw = {
  id: string;
  name: string;
  isEnabled: boolean;
  rewardName?: string | null;
  totalStamps: number;
  bonusStamps?: number | null;
};

// ── Lo que muestra el panel ─────────────────────────────────────────────────

/**
 * - `lista`: tarjeta llena, premio sin aplicar. Es lo que hay que hacer hoy.
 * - `cerca`: le faltan {@link NEAR_REWARD_STAMPS} sellos o menos.
 * - `en-curso`: el resto de las activas.
 * - `canjeada`: el premio ya se aplicó; la tarjeta quedó cerrada.
 */
export type LoyaltyStage = "lista" | "cerca" | "en-curso" | "canjeada";

export type LoyaltyCard = {
  id: string;
  uniqueId: string;
  campaignId: string | null;
  campaignName: string;
  rewardName: string;
  stage: LoyaltyStage;
  stamps: number;
  totalStamps: number;
  remaining: number;
  gifted: { welcome: number; winBack: number };
  fromVisits: number;
  /** ISO. Último sello por visita (`stamp_add`). */
  lastVisitAt: string | null;
  /** ISO o `YYYY-MM-DD`. Cuándo se aplicó el premio. */
  redeemedAt: string | null;
};

export type LoyaltyClient = {
  /** Id de la clienta en Stampee. */
  id: string;
  name: string;
  mobile: string | null;
  /** Los últimos 10 dígitos del celular; la llave para cruzar con EA. */
  phoneKey: string | null;
  /** Activas primero, de la más cerca del premio a la más lejos; luego canjeadas. */
  cards: LoyaltyCard[];
};

export type CampaignStats = {
  id: string;
  name: string;
  enabled: boolean;
  rewardName: string;
  totalStamps: number;
  active: number;
  lista: number;
  cerca: number;
  canjeadas: number;
  /**
   * Tarjetas activas por cantidad de sellos: `distribution[n]` = cuántas van en
   * `n`. Largo `totalStamps + 1`. Es "dónde está parada la clientela".
   */
  distribution: number[];
};

export type LoyaltySnapshot = {
  clients: LoyaltyClient[];
  campaigns: CampaignStats[];
};

// ── Reglas ──────────────────────────────────────────────────────────────────

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/**
 * Los últimos 10 dígitos de un celular, o `null` si no alcanza a 7.
 *
 * Stampee guarda el número como lo escribió quien lo cargó ("300 123 4567",
 * "+57300…") y EA como E.164; los 10 últimos son el número colombiano en los
 * dos. Es la misma llave que usa el `lookup` de Stampee.
 */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  return digits.length >= 7 ? digits.slice(-10) : null;
}

export function loyaltyStage(status: string, remaining: number): LoyaltyStage {
  if (status === "Redeemed") return "canjeada";
  if (remaining === 0) return "lista";
  if (remaining <= NEAR_REWARD_STAMPS) return "cerca";
  return "en-curso";
}

export function summarizeCard(
  card: StampeeCardRaw,
  campaign: StampeeCampaignRaw | undefined,
): LoyaltyCard {
  const snapshot = card.templateSnapshot ?? {};
  const totalStamps = Math.max(num(snapshot.totalStamps) ?? campaign?.totalStamps ?? card.stamps, 1);

  let winBack = 0;
  let issuedAmount: number | undefined;
  let issuedAt: number | null = null;
  let lastVisitAt: number | null = null;
  let redeemedAt: number | null = null;
  for (const tx of card.history ?? []) {
    const ts = Number(tx.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (tx.type === "issued" && (issuedAt === null || ts < issuedAt)) {
      issuedAt = ts;
      issuedAmount = tx.amount;
    }
    if (tx.type === "stamp_add" && (lastVisitAt === null || ts > lastVisitAt)) lastVisitAt = ts;
    if (tx.type === "redeem" && (redeemedAt === null || ts > redeemedAt)) redeemedAt = ts;
    if (tx.type === "gift") winBack += tx.amount;
  }

  const welcome = Math.min(
    num(snapshot.bonusStamps) ?? issuedAmount ?? campaign?.bonusStamps ?? 0,
    Math.max(totalStamps - 1, 0),
  );
  const remaining = Math.max(totalStamps - card.stamps, 0);

  return {
    id: card.id,
    uniqueId: card.uniqueId,
    campaignId: card.campaignId,
    campaignName: card.campaignName,
    rewardName: str(snapshot.rewardName) ?? campaign?.rewardName ?? "",
    stage: loyaltyStage(card.status, remaining),
    stamps: card.stamps,
    totalStamps,
    remaining,
    gifted: { welcome, winBack },
    fromVisits: Math.max(card.stamps - welcome - winBack, 0),
    lastVisitAt: lastVisitAt === null ? null : new Date(lastVisitAt).toISOString(),
    redeemedAt:
      redeemedAt !== null
        ? new Date(redeemedAt).toISOString()
        : card.status === "Redeemed"
          ? (card.completedDate ?? null)
          : null,
  };
}

const STAGE_ORDER: Record<LoyaltyStage, number> = { lista: 0, cerca: 1, "en-curso": 2, canjeada: 3 };

/** Activas antes que canjeadas; entre activas, la que menos le falta primero. */
export function compareCards(a: LoyaltyCard, b: LoyaltyCard): number {
  return (
    STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] ||
    a.remaining - b.remaining ||
    (b.redeemedAt ?? "").localeCompare(a.redeemedAt ?? "")
  );
}

/** La tarjeta que importa para una clienta: la activa más cerca del premio. */
export function leadingCard(cards: readonly LoyaltyCard[]): LoyaltyCard | null {
  const active = cards.filter((c) => c.stage !== "canjeada");
  return active.length === 0 ? null : [...active].sort(compareCards)[0];
}

export function buildSnapshot(
  customers: readonly StampeeCustomerRaw[],
  campaigns: readonly StampeeCampaignRaw[],
): LoyaltySnapshot {
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));

  const clients: LoyaltyClient[] = customers.map((customer) => ({
    id: customer.id,
    name: customer.name,
    mobile: customer.mobile ?? null,
    phoneKey: phoneKey(customer.mobile),
    cards: (customer.cards ?? [])
      .map((card) => summarizeCard(card, card.campaignId ? campaignById.get(card.campaignId) : undefined))
      .sort(compareCards),
  }));

  const stats = new Map<string, CampaignStats>();
  for (const campaign of campaigns) {
    stats.set(campaign.id, {
      id: campaign.id,
      name: campaign.name,
      enabled: campaign.isEnabled,
      rewardName: campaign.rewardName ?? "",
      totalStamps: campaign.totalStamps,
      active: 0,
      lista: 0,
      cerca: 0,
      canjeadas: 0,
      distribution: Array.from({ length: Math.max(campaign.totalStamps, 0) + 1 }, () => 0),
    });
  }
  for (const card of clients.flatMap((c) => c.cards)) {
    const s = card.campaignId ? stats.get(card.campaignId) : undefined;
    // Una tarjeta de una campaña borrada sigue en la ficha de la clienta, pero
    // no tiene fila donde sumarse.
    if (!s) continue;
    if (card.stage === "canjeada") {
      s.canjeadas += 1;
      continue;
    }
    s.active += 1;
    if (card.stage === "lista") s.lista += 1;
    if (card.stage === "cerca") s.cerca += 1;
    const bucket = Math.min(card.stamps, s.distribution.length - 1);
    if (bucket >= 0) s.distribution[bucket] += 1;
  }

  return {
    clients,
    campaigns: [...stats.values()].sort(
      (a, b) => Number(b.enabled) - Number(a.enabled) || b.active - a.active,
    ),
  };
}

/**
 * Las clientas de Stampee que corresponden a un teléfono del panel.
 *
 * Puede ser más de una: Stampee no impide dos fichas con el mismo número, y
 * esconder una sería esconder sus sellos.
 */
export function clientsForPhone(
  snapshot: LoyaltySnapshot,
  phone: string | null | undefined,
): LoyaltyClient[] {
  const key = phoneKey(phone);
  return key === null ? [] : snapshot.clients.filter((c) => c.phoneKey === key);
}

/** Una fila por tarjeta activa, para las listas de la pantalla de Fidelidad. */
export type LoyaltyRow = { client: LoyaltyClient; card: LoyaltyCard };

export function activeRows(snapshot: LoyaltySnapshot): LoyaltyRow[] {
  return snapshot.clients
    .flatMap((client) =>
      client.cards.filter((card) => card.stage !== "canjeada").map((card) => ({ client, card })),
    )
    .sort(
      (a, b) =>
        compareCards(a.card, b.card) ||
        (b.card.lastVisitAt ?? "").localeCompare(a.card.lastVisitAt ?? "") ||
        a.client.name.localeCompare(b.client.name, "es"),
    );
}
