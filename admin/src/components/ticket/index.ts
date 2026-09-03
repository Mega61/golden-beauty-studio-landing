/**
 * Superficie pública de la cuenta de servicio (WP-C2).
 *
 * Nada de acá toca la red, la base ni `server-only`: la hoja recibe la Server
 * Action como prop (`CloseTicketAction`) y el catálogo ya resuelto. Es lo que
 * permite que `types.ts`, `catalog.ts`, `draft.ts` y `draft-store.ts` se
 * importen desde un Server Component sin arrastrar `"use client"`, y que la
 * lógica del borrador se pruebe en Node sin un navegador.
 */

export {
  EXTRAS_CATEGORY_ALIASES,
  FEATURED_EXTRAS,
  PREFERRED_EXTRAS,
  UNCATEGORIZED,
  filterGroups,
  findService,
  groupServicesForPicker,
  isExtrasCategory,
  mainServices,
  normalizeName,
  orderExtras,
  type CatalogGroup,
  type CatalogService,
  type TicketCatalog,
} from "./catalog";

export {
  DRAFT_VERSION,
  NOTE_CHIPS,
  PAYMENT_METHODS,
  VARIANCE_REASONS,
  appendNoteChip,
  bumpExtra,
  draftFromFinance,
  draftToItems,
  emptyDraft,
  isDirty,
  priceDraft,
  setExtraQty,
  type DraftPricing,
  type PriceFlag,
  type TicketDraft,
  type TicketPricing,
} from "./draft";

export {
  draftKey,
  dropDraft,
  enqueue,
  flushOutbox,
  isRetryDue,
  listPending,
  newRequestId,
  outboxKey,
  parseDraft,
  readDraft,
  readPending,
  recordFailure,
  resolvePending,
  retryDelayMs,
  scopeKey,
  writeDraft,
  type DraftStorage,
  type FlushReport,
  type PendingTicket,
  type SendOutcome,
} from "./draft-store";

export { TicketSheet } from "./TicketSheet";
export { CambioTag, ServicePicker } from "./ServicePicker";
export { ExtrasChips } from "./ExtrasChips";
export { useTicketOutbox, type OutboxApi } from "./useTicketOutbox";

export type {
  CloseTicketAction,
  CloseTicketInput,
  CloseTicketResult,
  TicketFinanceView,
  TodayAppointment,
} from "./types";
