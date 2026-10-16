import "server-only";

import type { RowDataPacket } from "mysql2";

import { getDb, getEaReadOnlyPool } from "@/db/client";
import {
  instantToEaDate,
  instantToEaLocal,
  parseEaLocalDateTime,
  type Customer,
  type EaLocalDate,
} from "@/lib/ea";

import { legacyStatusKind } from "../reportes/aggregate";
import {
  buildAudience,
  META_SEGMENTS,
  selectSegment,
  type Audience,
  type MetaSegment,
} from "./meta-export";

/**
 * Los datos de la exportación para Meta: **toda** la clientela, de una vez.
 *
 * ## Por SQL de solo lectura, no por la API de EA
 *
 * La API de EA pagina de a 100 y EA corta a 100 peticiones por IP cada 120 s,
 * con todo el panel detrás de una sola IP. Recorrer miles de clientas y sus
 * citas por la API se comería el cupo de la agenda y de la reserva pública
 * justo mientras la dueña baja un archivo. El pool de solo lectura
 * (`DATABASE_URL_EA_RO`) es el mismo que usan Reportes, y este módulo solo
 * hace `SELECT`.
 *
 * ## El teléfono de la ficha
 *
 * Se usa `phone_number` —el campo que el panel escribe y el que muestra la
 * lista de Clientas— y, si está vacío o no se puede normalizar, el celular
 * (`mobile_number`). Así la persona de esta lista es la misma que la dueña ve
 * en `/clientes`.
 */

interface CustomerPacket extends RowDataPacket {
  id: number;
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
  mobile_number: string | null;
  city: string | null;
}

interface AppointmentPacket extends RowDataPacket {
  id_users_customer: number | null;
  start: string;
  status: string | null;
}

async function select<T extends RowDataPacket>(sql: string): Promise<T[]> {
  const [rows] = await getEaReadOnlyPool().promise().query<T[]>(sql);
  return rows;
}

function toCustomer(row: CustomerPacket): Customer {
  const phone =
    row.phone_number !== null && /\d/.test(row.phone_number) ? row.phone_number : row.mobile_number;
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: null,
    phone,
    address: null,
    city: row.city,
    zip: null,
    timezone: null,
    language: null,
    customField1: null,
    customField2: null,
    customField3: null,
    customField4: null,
    customField5: null,
    ldapDn: null,
    notes: null,
  };
}

export type MetaExportLoad =
  | { ok: true; audience: Audience; today: EaLocalDate; counts: Record<MetaSegment, number> }
  | { ok: false; message: string };

/**
 * La audiencia completa y cuántas clientas caen en cada segmento.
 *
 * `now` entra por parámetro, como en Reportes.
 */
export async function loadMetaAudience(now: Date = new Date()): Promise<MetaExportLoad> {
  let customers: Customer[];
  let appointments: { customerId: number | null; start: ReturnType<typeof parseEaLocalDateTime>; status: string | null }[];

  try {
    const [customerRows, appointmentRows] = await Promise.all([
      select<CustomerPacket>(
        `SELECT u.id, u.first_name, u.last_name, u.phone_number, u.mobile_number, u.city
           FROM ea_users u
           INNER JOIN ea_roles r ON r.id = u.id_roles
          WHERE r.slug = 'customer'
          ORDER BY u.id`,
      ),
      select<AppointmentPacket>(
        `SELECT a.id_users_customer,
                DATE_FORMAT(a.start_datetime, '%Y-%m-%d %H:%i:%s') AS start,
                a.status
           FROM ea_appointments a
          WHERE a.is_unavailability = 0`,
      ),
    ]);
    customers = customerRows.map(toCustomer);
    appointments = appointmentRows.map((row) => ({
      customerId: row.id_users_customer,
      start: parseEaLocalDateTime(row.start),
      status: row.status,
    }));
  } catch (error) {
    console.error("[clientes] no se pudo leer EA para la exportación", error);
    return {
      ok: false,
      message:
        "No se pudo leer la agenda (Easy!Appointments). Sin las clientas de EA la lista saldría incompleta, así que no se ofrece.",
    };
  }

  let legacy: Parameters<typeof buildAudience>[0]["legacy"];
  try {
    const rows = await getDb()
      .selectFrom("legacy_appointment")
      .select(["client_phone_e164", "client_name", "started_at", "status"])
      .execute();
    legacy = rows.map((row) => ({
      phone: row.client_phone_e164,
      name: row.client_name,
      at: instantToEaLocal(row.started_at),
      kind: legacyStatusKind(row.status),
    }));
  } catch (error) {
    console.error("[clientes] no se pudo leer el histórico para la exportación", error);
    return {
      ok: false,
      message:
        "No se pudo leer el histórico de Agenda Pro. Sin él, las clientas de antes del corte saldrían como si nunca hubieran venido.",
    };
  }

  const today = instantToEaDate(now);
  const audience = buildAudience({ customers, appointments, legacy, now: instantToEaLocal(now) });

  const counts = Object.fromEntries(
    META_SEGMENTS.map((segment) => [
      segment.id,
      selectSegment(audience.people, segment.id, today).length,
    ]),
  ) as Record<MetaSegment, number>;

  return { ok: true, audience, today, counts };
}
