/**
 * El set completo de migraciones de `gbs_admin`, en orden.
 *
 * **Todas juntas en un solo paquete (A2), y ningún otro paquete escribe
 * migraciones.** Si cada paquete trajera la suya, los números chocarían al
 * mergear cuatro ramas en paralelo y el orden real de aplicación dependería del
 * orden de los merges. Si a un paquete le falta una columna, la pide.
 *
 * El orden es el de este array, no el alfabético de los archivos, aunque hoy
 * coincidan. Las dependencias que lo fijan son las llaves foráneas:
 *
 * ```text
 * 001 better-auth ──┬─▶ 003 day_close ──┐
 *                   ├─▶ 008 commission_run
 *                   └─▶ 013 staff_totp  │
 *                                       ▼
 *                        004 appointment_finance
 *                                       │
 *                                       ▼
 *                        005 appointment_finance_item ──┐
 *                                                       ▼
 *                        007 commission_rule ──▶ 009 commission_entry ◀── 008
 * ```
 *
 * Las demás (`002`, `006`, `010`–`012`, `014`, `015`) no tienen FK y podrían ir
 * en cualquier posición; van donde están para agrupar por tema.
 */

import type { Migration } from "./migration";

import { migration as m001 } from "./001-better-auth";
import { migration as m002 } from "./002-allowed-user";
import { migration as m003 } from "./003-day-close";
import { migration as m004 } from "./004-appointment-finance";
import { migration as m005 } from "./005-appointment-finance-item";
import { migration as m006 } from "./006-webhook-event";
import { migration as m007 } from "./007-commission-rule";
import { migration as m008 } from "./008-commission-run";
import { migration as m009 } from "./009-commission-entry";
import { migration as m010 } from "./010-combo";
import { migration as m011 } from "./011-service-map";
import { migration as m012 } from "./012-station";
import { migration as m013 } from "./013-staff-totp";
import { migration as m014 } from "./014-legacy-appointment";
import { migration as m015 } from "./015-audit-log";

export const MIGRATIONS: readonly Migration[] = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m008,
  m009,
  m010,
  m011,
  m012,
  m013,
  m014,
  m015,
];

/**
 * Las tablas que el set deja creadas, para que un test pueda afirmar el
 * inventario sin leer las migraciones una por una. Ordenadas como en el plan.
 */
export const EXPECTED_TABLES: readonly string[] = [
  // Better Auth
  "user",
  "session",
  "account",
  "verification",
  // Dominio
  "allowed_user",
  "appointment_finance",
  "appointment_finance_item",
  "day_close",
  "webhook_event",
  "commission_rule",
  "commission_entry",
  "commission_run",
  "combo",
  "service_map",
  "station",
  "staff_totp",
  "legacy_appointment",
  "audit_log",
  // Infraestructura
  "schema_migration",
];

export type { Migration } from "./migration";
