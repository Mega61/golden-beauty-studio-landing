/**
 * Los regalos del calendario de Adviento de Stampee, leídos para el mostrador
 * —puro, testeado—.
 *
 * La clienta abre las puertas en su tarjeta (Stampee) y lo que le sale queda
 * guardado allá como un regalo con código (`GB-XXXX`). El panel solo hace dos
 * cosas con eso: **mostrarlo** donde la recepción mira a la clienta (la ficha,
 * Fidelidad, Hoy) y **marcarlo usado** cuando se lo cobran ("Marcar usado",
 * con "Deshacer" para un toque equivocado). El descuento no lo pone esto: se
 * escribe al cerrar la cuenta con motivo `promo` y la nota "Adviento día N",
 * como cualquier promo manual.
 *
 * Solo los cupones (`coupon`) se marcan usados; los demás tipos (sellos de
 * regalo, sellos dobles, un link, una tarjeta regalo) se listan como contexto.
 * Contrato: `docs/ADVENT_CONTRACT.md` del repo de Stampee.
 */

// ── Lo que manda Stampee ────────────────────────────────────────────────────

export type AdventRewardKind = "coupon" | "bonus_stamps" | "double_stamps" | "link" | "gift_card";
export type AdventRewardStatus = "available" | "redeemed" | "expired" | "transferred";

export type AdventReward = {
  id: string;
  doorNo: number;
  /** El día del calendario que dice la puerta: 2, 4 … 24. */
  dayLabel: number;
  kind: AdventRewardKind;
  title: string;
  subtitle: string;
  /** Las condiciones del regalo, renglón por renglón. */
  terms: string[];
  /** `GB-XXXX` en los cupones; `null` en los demás. */
  code: string | null;
  /** `expired` lo calcula Stampee al leer. */
  status: AdventRewardStatus;
  /** `YYYY-MM-DD`, día de Bogotá. */
  validFrom: string | null;
  validTo: string | null;
  openedAt: string;
  url: string | null;
  stamps: number | null;
  giftCardId: string | null;
};

/** `GET /advent/rewards`: el regalo con su dueña y quién lo marcó usado. */
export type StudioAdventReward = AdventReward & {
  customerId: string;
  customerName: string;
  redeemedAt: string | null;
  redeemedBy: string | null;
};

// ── Reglas ──────────────────────────────────────────────────────────────────

/** Cuántas horas sigue a la vista un regalo usado en Fidelidad, para poder deshacerlo. */
export const ADVENT_RECENT_HOURS = 48;

/** Se puede marcar usado: cupón disponible y ya vigente. */
export function canMarkUsed(reward: AdventReward, today: string): boolean {
  return (
    reward.kind === "coupon" &&
    reward.code !== null &&
    reward.status === "available" &&
    (reward.validFrom === null || reward.validFrom <= today)
  );
}

/** Se puede deshacer: cupón marcado usado. */
export function canUndo(reward: AdventReward): boolean {
  return reward.kind === "coupon" && reward.code !== null && reward.status === "redeemed";
}

/** La nota que va en la cuenta al poner el descuento a mano. */
export function adventTicketNote(reward: Pick<AdventReward, "dayLabel">): string {
  return `Adviento día ${reward.dayLabel}`;
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** `2026-12-04` → `4 dic`. Sin `Date`: es un día de calendario, no un instante. */
export function shortDay(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1] ?? ""}`.trim();
}

/** "Vale del 4 al 10 dic", "Vale hasta el 10 dic"… */
export function adventValidity(reward: Pick<AdventReward, "validFrom" | "validTo">): string {
  const { validFrom, validTo } = reward;
  if (validFrom && validTo) return `Vale del ${shortDay(validFrom)} al ${shortDay(validTo)}`;
  if (validTo) return `Vale hasta el ${shortDay(validTo)}`;
  if (validFrom) return `Vale desde el ${shortDay(validFrom)}`;
  return "Sin fecha de vencimiento";
}

export type AdventTone = "ok" | "warn" | "muted";

/** El estado como lo lee la recepción, con el tono de la píldora. */
export function adventStatus(reward: AdventReward, today: string): { label: string; tone: AdventTone } {
  switch (reward.status) {
    case "available":
      if (reward.validFrom !== null && reward.validFrom > today) {
        return { label: `Desde el ${shortDay(reward.validFrom)}`, tone: "warn" };
      }
      return { label: reward.kind === "coupon" ? "Por usar" : "Disponible", tone: "ok" };
    case "redeemed":
      return { label: "Usado", tone: "muted" };
    case "expired":
      return { label: "Vencido", tone: "muted" };
    case "transferred":
      return { label: "Regalado a otra persona", tone: "muted" };
  }
}

/** Qué hacer con un regalo que no es un cupón: se lista, pero no se marca. */
export function adventKindNote(kind: AdventRewardKind): string | null {
  switch (kind) {
    case "coupon":
      return null;
    case "bonus_stamps":
      return "Sellos de regalo: Stampee ya se los puso en la tarjeta.";
    case "double_stamps":
      return "Sellos dobles: no se marca en el panel.";
    case "link":
      return "Un enlace para la clienta: no se marca en el panel.";
    case "gift_card":
      return "Tarjeta regalo: se cobra con su código al cerrar la cuenta (pago con tarjeta regalo).";
  }
}

/**
 * Los regalos de una clienta para su ficha: los disponibles (cualquier tipo) y
 * los cupones ya usados, para ver la historia y poder deshacer. Los vencidos y
 * los regalados a otra persona no se muestran: no hay nada que hacer con ellos.
 *
 * Orden: cupones vigentes primero (el que vence antes arriba), después los
 * demás disponibles, al final los usados (el más reciente arriba).
 */
export function adventForCustomers(
  rewards: readonly StudioAdventReward[],
  customerIds: readonly string[],
  today: string,
): StudioAdventReward[] {
  const ids = new Set(customerIds);
  const rank = (r: StudioAdventReward) =>
    canMarkUsed(r, today) ? 0 : r.status === "available" ? 1 : 2;
  return rewards
    .filter((r) => ids.has(r.customerId))
    .filter((r) => r.status === "available" || (r.status === "redeemed" && r.kind === "coupon"))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (rank(a) === 2
          ? (b.redeemedAt ?? "").localeCompare(a.redeemedAt ?? "")
          : (a.validTo ?? "9999").localeCompare(b.validTo ?? "9999")) ||
        a.doorNo - b.doorNo,
    );
}

/** Cuántos cupones de Adviento tiene por usar, para el aviso de Hoy. */
export function availableCouponCount(
  rewards: readonly StudioAdventReward[],
  customerIds: readonly string[],
): number {
  const ids = new Set(customerIds);
  return rewards.filter(
    (r) => ids.has(r.customerId) && r.kind === "coupon" && r.status === "available",
  ).length;
}

/**
 * La lista de Fidelidad: los cupones por usar de todas, y los usados en las
 * últimas {@link ADVENT_RECENT_HOURS} horas (para deshacer un toque
 * equivocado sin ir a buscar la ficha).
 */
export function adventFrontDesk(
  rewards: readonly StudioAdventReward[],
  now: Date,
): { available: StudioAdventReward[]; recentlyUsed: StudioAdventReward[] } {
  const since = now.getTime() - ADVENT_RECENT_HOURS * 60 * 60 * 1000;
  const coupons = rewards.filter((r) => r.kind === "coupon" && r.code !== null);
  return {
    available: coupons
      .filter((r) => r.status === "available")
      .sort(
        (a, b) =>
          (a.validTo ?? "9999").localeCompare(b.validTo ?? "9999") ||
          a.customerName.localeCompare(b.customerName, "es"),
      ),
    recentlyUsed: coupons
      .filter((r) => r.status === "redeemed" && r.redeemedAt !== null && Date.parse(r.redeemedAt) >= since)
      .sort((a, b) => (b.redeemedAt ?? "").localeCompare(a.redeemedAt ?? "")),
  };
}

/**
 * El mensaje para la recepción de un error de Stampee al marcar o deshacer.
 * Los 409 del contrato tienen su frase; lo demás, el genérico de quien llama.
 */
export function adventErrorMessage(
  code: string | null,
  status: number | null,
  fallback: string,
): string {
  switch (code) {
    case "EXPIRED":
      return "Ese regalo ya venció: no se puede usar.";
    case "NOT_YET_VALID":
      return "Ese regalo todavía no está vigente: se puede usar desde el día que dice.";
    case "NOT_REDEEMABLE":
      return "Ese regalo no es un cupón: no se marca como usado en el panel.";
  }
  if (status === 404) return "Ese código de Adviento no existe en Stampee.";
  if (status === 401 || status === 403) return "Stampee rechazó la llave del panel (STAMPEE_API_KEY).";
  if (status === null) return "Stampee no respondió. No se cambió nada; intenta en un momento.";
  return fallback;
}
