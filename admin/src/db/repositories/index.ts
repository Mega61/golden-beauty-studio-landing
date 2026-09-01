/**
 * Los repositorios de `gbs_admin`, agrupados.
 *
 * Todos toman el mismo `Db` — un `Kysely<Database>` o una transacción suya —
 * así que `repositories(trx)` devuelve el juego completo participando de la
 * misma transacción. Es lo que hace que "cerrar el día" (crear el `day_close`,
 * enganchar las cuentas y anotar la bitácora) sea un solo acto o ninguno.
 */

import { allowedUserRepository } from "./allowed-user";
import { appointmentFinanceRepository } from "./appointment-finance";
import { appointmentFinanceItemRepository } from "./appointment-finance-item";
import { auditLogRepository } from "./audit-log";
import { comboRepository } from "./combo";
import { commissionEntryRepository } from "./commission-entry";
import { commissionRuleRepository } from "./commission-rule";
import { commissionRunRepository } from "./commission-run";
import { dayCloseRepository } from "./day-close";
import { legacyAppointmentRepository } from "./legacy-appointment";
import { serviceMapRepository } from "./service-map";
import { staffTotpRepository } from "./staff-totp";
import { stationRepository } from "./station";
import { webhookEventRepository } from "./webhook-event";
import type { Db } from "./shared";

export function repositories(db: Db) {
  return {
    allowedUsers: allowedUserRepository(db),
    appointmentFinance: appointmentFinanceRepository(db),
    appointmentFinanceItems: appointmentFinanceItemRepository(db),
    auditLog: auditLogRepository(db),
    combos: comboRepository(db),
    commissionEntries: commissionEntryRepository(db),
    commissionRules: commissionRuleRepository(db),
    commissionRuns: commissionRunRepository(db),
    dayCloses: dayCloseRepository(db),
    legacyAppointments: legacyAppointmentRepository(db),
    serviceMap: serviceMapRepository(db),
    staffTotp: staffTotpRepository(db),
    stations: stationRepository(db),
    webhookEvents: webhookEventRepository(db),
  };
}

export type Repositories = ReturnType<typeof repositories>;

export { allowedUserRepository } from "./allowed-user";
export { appointmentFinanceRepository } from "./appointment-finance";
export type { EnsureResult } from "./appointment-finance";
export { appointmentFinanceItemRepository } from "./appointment-finance-item";
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
export { legacyAppointmentRepository } from "./legacy-appointment";
export { serviceMapRepository } from "./service-map";
export { staffTotpRepository } from "./staff-totp";
export { stationRepository } from "./station";
export { webhookEventRepository } from "./webhook-event";
export type { RecordedEvent } from "./webhook-event";
export type { Db } from "./shared";
