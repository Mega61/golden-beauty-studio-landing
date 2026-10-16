/**
 * Los repositorios de `gbs_admin`, agrupados.
 *
 * Todos toman el mismo `Db` — un `Kysely<Database>` o una transacción suya —
 * así que `repositories(trx)` devuelve el juego completo participando de la
 * misma transacción. Es lo que hace que "cerrar el día" (crear el `day_close`,
 * enganchar las cuentas y anotar la bitácora) sea un solo acto o ninguno.
 */

import { adSpendRepository } from "./ad-spend";
import { allowedUserRepository } from "./allowed-user";
import { appointmentFinanceRepository } from "./appointment-finance";
import { appointmentFinanceItemRepository } from "./appointment-finance-item";
import { appointmentPaymentRepository } from "./appointment-payment";
import { auditLogRepository } from "./audit-log";
import { comboRepository } from "./combo";
import { commissionEntryRepository } from "./commission-entry";
import { commissionRuleRepository } from "./commission-rule";
import { commissionRunRepository } from "./commission-run";
import { dayCloseRepository } from "./day-close";
import { jobRunRepository } from "./job-run";
import { legacyAppointmentRepository } from "./legacy-appointment";
import { legacyPaymentRepository } from "./legacy-payment";
import { pushSubscriptionRepository } from "./push-subscription";
import { serviceMapRepository } from "./service-map";
import { staffTotpRepository } from "./staff-totp";
import { stationRepository } from "./station";
import { waMessageRepository } from "./wa-message";
import { webhookEventRepository } from "./webhook-event";
import type { Db } from "./shared";

export function repositories(db: Db) {
  return {
    adSpend: adSpendRepository(db),
    allowedUsers: allowedUserRepository(db),
    appointmentFinance: appointmentFinanceRepository(db),
    appointmentFinanceItems: appointmentFinanceItemRepository(db),
    appointmentPayments: appointmentPaymentRepository(db),
    auditLog: auditLogRepository(db),
    combos: comboRepository(db),
    commissionEntries: commissionEntryRepository(db),
    commissionRules: commissionRuleRepository(db),
    commissionRuns: commissionRunRepository(db),
    dayCloses: dayCloseRepository(db),
    jobRuns: jobRunRepository(db),
    legacyAppointments: legacyAppointmentRepository(db),
    legacyPayments: legacyPaymentRepository(db),
    pushSubscriptions: pushSubscriptionRepository(db),
    serviceMap: serviceMapRepository(db),
    staffTotp: staffTotpRepository(db),
    stations: stationRepository(db),
    waMessages: waMessageRepository(db),
    webhookEvents: webhookEventRepository(db),
  };
}

export type Repositories = ReturnType<typeof repositories>;

export { adSpendRepository } from "./ad-spend";
export type { AdSpendInput } from "./ad-spend";
export { allowedUserRepository } from "./allowed-user";
export { appointmentFinanceRepository } from "./appointment-finance";
export type { EnsureResult } from "./appointment-finance";
export { appointmentFinanceItemRepository } from "./appointment-finance-item";
export { appointmentPaymentRepository } from "./appointment-payment";
export { auditLogRepository } from "./audit-log";
export type { AuditEntry } from "./audit-log";
export { comboRepository } from "./combo";
export { commissionEntryRepository } from "./commission-entry";
export { commissionRuleRepository } from "./commission-rule";
export {
  commissionRunRepository,
  PaidCommissionRunError,
} from "./commission-run";
export { dayCloseRepository } from "./day-close";
export {
  JOB_DAY_CLOSE_PUSH,
  JOB_RECONCILE,
  JOB_WHATSAPP_REMINDERS,
  jobRunRepository,
  jobRunValues,
} from "./job-run";
export type { JobRunInput } from "./job-run";
export { legacyAppointmentRepository } from "./legacy-appointment";
export { legacyPaymentRepository } from "./legacy-payment";
export { pushSubscriptionRepository } from "./push-subscription";
export type { DeliverableSubscription, PushSubscriptionInput } from "./push-subscription";
export { serviceMapRepository } from "./service-map";
export { staffTotpRepository } from "./staff-totp";
export { stationRepository } from "./station";
export { waMessageRepository } from "./wa-message";
export type { ManualSendInput, PendingInput, WaMessageWithSender } from "./wa-message";
export { webhookEventRepository } from "./webhook-event";
export type { RecordedEvent } from "./webhook-event";
export type { Db } from "./shared";
