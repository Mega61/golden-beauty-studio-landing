/**
 * La lista de clientas para una **audiencia personalizada de Meta**, cifrada.
 *
 * Es la tercera pregunta de la metodología de pauta de la dueña: a quién
 * **excluir** de una campaña de captación (quien ya es clienta no tiene por
 * qué ver el anuncio de "primera visita") y a quién volver a traer. Meta
 * resuelve eso con una lista de clientes subida al Administrador de anuncios.
 *
 * Todo lo de este archivo es puro —sin base, sin red, sin reloj— y está
 * testeado: la normalización, el cifrado, la selección del segmento y el CSV.
 * Lo que trae los datos vive en `meta-export-data.ts`.
 *
 * ## Cifrada antes de salir
 *
 * Meta acepta el archivo con los valores ya en SHA-256 y lo recomienda: así
 * nunca viaja un teléfono en claro, ni a Meta ni a la carpeta de Descargas de
 * quien lo bajó. Cada valor se **normaliza** con las reglas del formato de
 * lista de clientes de Meta y después se cifra; un valor sin normalizar da
 * otro hash y la clienta simplemente no coincide, sin error que lo diga.
 *
 * | Columna   | Normalización (Meta)                                     |
 * | --------- | -------------------------------------------------------- |
 * | `phone`   | Solo dígitos, con indicativo de país, sin `+` ni ceros a la izquierda |
 * | `fn`/`ln` | Minúsculas, solo `a`–`z`: sin tildes, sin puntuación, sin espacios |
 * | `ct`      | Igual: minúsculas, `a`–`z`, sin espacios                 |
 * | `country` | ISO 3166-1 alfa-2 en minúscula (`co`)                    |
 *
 * Las tildes se **quitan** (`maría` → `maria`): Meta acepta UTF-8 en el
 * nombre, pero recomienda la forma romana sin caracteres especiales porque es
 * la que mejor coincide con sus perfiles.
 *
 * ## La identidad es el teléfono
 *
 * Las tres fuentes —clientas de EA, citas de EA y el histórico de Agenda Pro—
 * se unen por **teléfono en E.164**, con `mergeCustomers()` y
 * `normalizePhoneE164()` de `identity.ts`. Una clienta sin teléfono utilizable
 * no se puede identificar ni subir, y **se cuenta** en vez de desaparecer.
 *
 * ## `wa_optout` no aplica, a propósito
 *
 * La baja de recordatorios es "no me escriban por WhatsApp". No es "no me
 * muestren anuncios", y Meta no le escribe a nadie con esta lista: la usa para
 * decidir a quién mostrar —o, sobre todo, **no** mostrar— un anuncio. Sacar a
 * esas clientas de una lista de exclusión lograría justo lo contrario de lo
 * que pidieron: que les llegue el anuncio de captación. No se filtra nada más
 * en silencio: todo lo que queda fuera tiene su contador en pantalla.
 */

import { createHash } from "node:crypto";

import { mapEaStatus } from "@/components/calendar";
import { eaDatePart, type EaLocalDate, type EaLocalDateTime } from "@/lib/ea";
import type { Customer } from "@/lib/ea";

import { addDays } from "../reportes/period";
import type { LegacyStatusKind } from "../reportes/aggregate";
import { splitName } from "@/jobs/import-agendapro";

import { mergeCustomers, normalizePhoneE164, type E164 } from "./identity";

// ── Segmentos ───────────────────────────────────────────────────────────────

export type MetaSegment = "todas" | "ultimos-180" | "inactivas-60";

export const META_SEGMENTS: readonly {
  id: MetaSegment;
  label: string;
  /** Para qué sirve en el Administrador de anuncios. */
  use: string;
}[] = [
  {
    id: "todas",
    label: "Todas las clientas",
    use: "Toda la clientela con teléfono. Para excluirla de una campaña de captación o como base de un público similar.",
  },
  {
    id: "ultimos-180",
    label: "Atendidas en los últimos 180 días",
    use: "Clientas activas. Es la lista de exclusión de las campañas de captación: no tiene sentido pagar para que vean «tu primera visita».",
  },
  {
    id: "inactivas-60",
    label: "Sin venir hace más de 60 días",
    use: "Ya vinieron, no han vuelto en dos meses y no tienen cita agendada. Para una campaña de volver a traer.",
  },
];

/** Las dos ventanas de los segmentos, en días de calendario. */
export const ACTIVE_WINDOW_DAYS = 180;
export const LAPSED_AFTER_DAYS = 60;

export function parseSegment(raw: unknown): MetaSegment | null {
  return META_SEGMENTS.find((segment) => segment.id === raw)?.id ?? null;
}

// ── Las personas ────────────────────────────────────────────────────────────

/** Una clienta del estudio, ya unificada por teléfono. */
export type AudiencePerson = {
  phone: E164;
  firstName: string;
  lastName: string;
  city: string | null;
  /** Su última visita **atendida**, en EA o en Agenda Pro. `null` = nunca. */
  lastAttended: EaLocalDateTime | null;
  /** ¿Tiene una cita futura que no esté cancelada? */
  hasUpcoming: boolean;
};

export type AudienceSources = {
  /** Las filas de clientas de EA, con el teléfono crudo como lo guardó EA. */
  customers: readonly Customer[];
  /** Citas de EA: de quién, cuándo y en qué estado. */
  appointments: readonly {
    customerId: number | null;
    start: EaLocalDateTime;
    status: string | null;
  }[];
  /** Filas de `legacy_appointment`. */
  legacy: readonly {
    phone: string | null;
    name: string | null;
    at: EaLocalDateTime;
    kind: LegacyStatusKind;
  }[];
  /** El instante de corte. Entra por parámetro: un reloj adentro no se testea. */
  now: EaLocalDateTime;
};

export type Audience = {
  people: AudiencePerson[];
  /** Fichas de EA sin teléfono utilizable. No se pueden subir. */
  customersWithoutPhone: number;
  /** Citas del histórico sin teléfono utilizable. Tampoco. */
  legacyWithoutPhone: number;
};

/**
 * Las clientas del estudio, una por teléfono, con lo que los segmentos
 * necesitan saber.
 *
 * - "Atendida" es la misma definición de los reportes: en EA, el estado
 *   `completada` (lo agendado todavía no es una visita); en Agenda Pro,
 *   `legacyStatusKind() === "atendida"`.
 * - El nombre sale de EA cuando la clienta está ahí —`mergeCustomers()` elige
 *   la fila más completa—, y del histórico solo cuando no está en EA.
 */
export function buildAudience(sources: AudienceSources): Audience {
  const resolved = mergeCustomers(sources.customers);
  const byPhone = new Map<E164, AudiencePerson>();
  const phoneOfCustomer = new Map<number, E164>();
  let customersWithoutPhone = 0;

  const cityOf = new Map(sources.customers.map((row) => [row.id, row.city]));

  for (const client of resolved) {
    if (client.phone === null) {
      customersWithoutPhone += client.eaCustomerIds.length;
      continue;
    }
    for (const id of client.eaCustomerIds) phoneOfCustomer.set(id, client.phone);
    const city =
      client.eaCustomerIds
        .map((id) => (cityOf.get(id) ?? "").trim())
        .find((value) => value !== "") ?? null;
    byPhone.set(client.phone, {
      phone: client.phone,
      firstName: client.firstName,
      lastName: client.lastName,
      city,
      lastAttended: null,
      hasUpcoming: false,
    });
  }

  const attended = (person: AudiencePerson, at: EaLocalDateTime) => {
    if (person.lastAttended === null || at > person.lastAttended) person.lastAttended = at;
  };

  for (const appointment of sources.appointments) {
    if (appointment.customerId === null) continue;
    const phone = phoneOfCustomer.get(appointment.customerId);
    // Una cita de una ficha sin teléfono: la ficha ya está contada arriba.
    if (phone === undefined) continue;
    const person = byPhone.get(phone);
    if (person === undefined) continue;

    const token = mapEaStatus(appointment.status);
    if (token === "completada") attended(person, appointment.start);
    // Futura y no cancelada = la clienta ya está volviendo. Un estado que el
    // panel no traduce también cuenta: mandarle un anuncio de "te extrañamos"
    // a quien ya tiene cita es plata tirada, y la duda se resuelve por ahí.
    if (appointment.start > sources.now && token !== "cancelada") person.hasUpcoming = true;
  }

  let legacyWithoutPhone = 0;
  for (const row of sources.legacy) {
    const phone = normalizePhoneE164(row.phone);
    if (phone === null) {
      legacyWithoutPhone += 1;
      continue;
    }
    let person = byPhone.get(phone);
    if (person === undefined) {
      // Vino antes del corte y no está en EA: su nombre es el del histórico.
      const split = splitName(row.name ?? undefined, undefined);
      person = {
        phone,
        firstName: split.firstName,
        lastName: split.lastName,
        city: null,
        lastAttended: null,
        hasUpcoming: false,
      };
      byPhone.set(phone, person);
    } else if (person.firstName === "" && person.lastName === "" && row.name) {
      const split = splitName(row.name, undefined);
      person.firstName = split.firstName;
      person.lastName = split.lastName;
    }
    if (row.kind === "atendida") attended(person, row.at);
  }

  const people = [...byPhone.values()].sort((a, b) => a.phone.localeCompare(b.phone));
  return { people, customersWithoutPhone, legacyWithoutPhone };
}

/**
 * Quiénes entran en un segmento.
 *
 * Las ventanas son de **calendario de Bogotá**, con los dos extremos
 * inclusivos, igual que los periodos de Reportes: "atendida en los últimos
 * 180 días" es una visita el día `hoy − 180` o después; "sin venir hace más
 * de 60" es una última visita **antes** de `hoy − 60`.
 */
export function selectSegment(
  people: readonly AudiencePerson[],
  segment: MetaSegment,
  today: EaLocalDate,
): AudiencePerson[] {
  if (segment === "todas") return [...people];

  if (segment === "ultimos-180") {
    const since = addDays(today, -ACTIVE_WINDOW_DAYS);
    return people.filter(
      (person) => person.lastAttended !== null && eaDatePart(person.lastAttended) >= since,
    );
  }

  const before = addDays(today, -LAPSED_AFTER_DAYS);
  return people.filter(
    (person) =>
      person.lastAttended !== null &&
      eaDatePart(person.lastAttended) < before &&
      !person.hasUpcoming,
  );
}

// ── Normalización y cifrado ─────────────────────────────────────────────────

/** `+573001234567` → `573001234567`. Ya viene en E.164, así que es quitar el `+`. */
export function normalizePhoneForMeta(phone: E164): string {
  return phone.slice(1).replace(/\D/g, "").replace(/^0+/, "");
}

/**
 * Nombre, apellido o ciudad → minúsculas `a`–`z`.
 *
 * `NFD` separa la tilde de su letra y después se descarta todo lo que no sea
 * `a`–`z`: `"María José"` → `"mariajose"`, `"Peña-Ríos"` → `"penarios"`,
 * `"Bogotá D.C."` → `"bogotadc"`. Puede quedar vacío (un nombre en otro
 * alfabeto, o solo signos): entonces la celda va vacía, no con el hash de "".
 */
export function normalizeTextForMeta(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** SHA-256 en hexadecimal minúscula, sobre UTF-8. Lo que Meta espera. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** El país, solo cuando el indicativo lo dice sin ambigüedad. Hoy: Colombia. */
function countryOf(phone: E164): string | null {
  return phone.startsWith("+57") ? "co" : null;
}

/** Un valor ya normalizado → su hash, o vacío si no hay nada que cifrar. */
function hashed(normalized: string): string {
  return normalized === "" ? "" : sha256Hex(normalized);
}

// ── El CSV ──────────────────────────────────────────────────────────────────

/**
 * El archivo, listo para subir.
 *
 * Encabezados del formato de lista de clientes de Meta. `ct` va solo si al
 * menos una clienta trae ciudad: una columna entera vacía no aporta nada a la
 * coincidencia y Meta pide no mandar columnas que no se tienen. Los hashes son
 * hexadecimal puro, así que ninguna celda necesita comillas.
 *
 * El país se pone solo cuando el indicativo es `+57`: a una clienta con número
 * de Miami no se le inventa que es de Colombia.
 */
export function buildMetaCsv(people: readonly AudiencePerson[]): string {
  const withCity = people.some((person) => normalizeTextForMeta(person.city) !== "");
  const header = withCity
    ? ["phone", "fn", "ln", "ct", "country"]
    : ["phone", "fn", "ln", "country"];

  const lines = [header.join(",")];
  for (const person of people) {
    const cells = [
      hashed(normalizePhoneForMeta(person.phone)),
      hashed(normalizeTextForMeta(person.firstName)),
      hashed(normalizeTextForMeta(person.lastName)),
      ...(withCity ? [hashed(normalizeTextForMeta(person.city))] : []),
      hashed(countryOf(person.phone) ?? ""),
    ];
    lines.push(cells.join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** `golden-meta-ultimos-180-2026-10-15.csv`. */
export function metaFilename(segment: MetaSegment, today: EaLocalDate): string {
  return `golden-meta-${segment}-${today}.csv`;
}
