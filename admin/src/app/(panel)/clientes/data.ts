import "server-only";

import { getDb } from "@/db/client";
import { appointmentFinanceRepository } from "@/db/repositories";
import type { LegacyAppointment } from "@/db/types";
import { EaApiError, type Customer, type Provider, type Service } from "@/lib/ea";
import { createEaClient, type EaClient } from "@/lib/ea/client";

import { buildUnifiedHistory, type EaHistoryInput, type UnifiedHistory } from "./history";
import {
  clientKeyToParam,
  displayName,
  mergeCustomers,
  normalizePhoneE164,
  phoneSearchVariants,
  type ClientKey,
  type ResolvedClient,
} from "./identity";

/**
 * Las consultas de la pantalla de Clientas.
 *
 * Todo lo que decide algo —quién es la misma persona, cómo se ordena la
 * historia, qué correo se muestra— vive en `identity.ts` y `history.ts`, que son
 * puros y testeados. Acá solo se trae el dato y se pega.
 *
 * ## Cuando EA no responde
 *
 * El panel entra en **solo lectura** con una banda de aviso, no en pantalla de
 * error (§ Estados que no son el estado feliz). Por eso cada lectura devuelve
 * `{ ok, ... }` en vez de lanzar: la mitad de esta pantalla vive en
 * `gbs_admin`, que sigue arriba, y una clienta con su historia hasta el corte
 * es mejor que un 500.
 */

/** Cuántas clientas trae la vista sin búsqueda. Las más recientes. */
const RECENT_PAGE_LENGTH = 100;

export type EaFailure = {
  /** Para la banda: `true` cuando EA está caído y no mal configurado. */
  transient: boolean;
  message: string;
};

function describeEaFailure(error: unknown): EaFailure {
  if (error instanceof EaApiError) {
    return {
      transient: error.isTransient,
      message: error.isConfiguration
        ? "El panel no puede autenticarse contra la agenda. Es configuración, no un caído."
        : "La agenda no está respondiendo.",
    };
  }
  return { transient: true, message: "La agenda no está respondiendo." };
}

function eaClientOrNull(): { client: EaClient } | { failure: EaFailure } {
  try {
    return { client: createEaClient() };
  } catch (error) {
    return { failure: describeEaFailure(error) };
  }
}

// ---------------------------------------------------------------------------
// Listado y búsqueda
// ---------------------------------------------------------------------------

export type ClientListResult = {
  clients: ResolvedClient[];
  /** `null` = no hubo búsqueda; se listaron las más recientes. */
  query: string | null;
  /** `true` si la lista se recortó: hay más clientas de las que se muestran. */
  truncated: boolean;
  failure: EaFailure | null;
};

/**
 * Busca clientas, o lista las más recientes.
 *
 * **`q` anula todos los demás filtros dentro de EA** (hallazgo de A1: con `q`
 * presente el modelo llama a `search()` y descarta el `where`), así que la
 * búsqueda es su propia consulta y no se combina con nada. El cliente de A1
 * rechaza la combinación antes de salir a la red, así que ni siquiera se puede
 * cometer el error por accidente.
 */
export async function searchClients(query: string | null): Promise<ClientListResult> {
  const ea = eaClientOrNull();
  if ("failure" in ea) {
    return { clients: [], query, truncated: false, failure: ea.failure };
  }

  const term = query?.trim() ?? "";

  try {
    if (term === "") {
      const page = await ea.client.customers.listPage({
        length: RECENT_PAGE_LENGTH,
        sort: ["-id"],
      });
      return {
        clients: mergeCustomers(page.items),
        query: null,
        truncated: page.hasMore,
        failure: null,
      };
    }

    const found = await ea.client.customers.list({ q: term });
    return {
      clients: mergeCustomers(found),
      query: term,
      truncated: false,
      failure: null,
    };
  } catch (error) {
    return { clients: [], query: term || null, truncated: false, failure: describeEaFailure(error) };
  }
}

// ---------------------------------------------------------------------------
// La ficha
// ---------------------------------------------------------------------------

export type ClientProfile = {
  client: ResolvedClient;
  history: UnifiedHistory;
  /** `true` si la mitad de EA de la historia no se pudo traer. */
  historyPartial: boolean;
  failure: EaFailure | null;
};

export type ClientProfileResult =
  | { found: true; profile: ClientProfile }
  | { found: false; failure: EaFailure | null };

/**
 * La ficha de una clienta.
 *
 * El camino largo es el de `tel`, y es el que importa: **la misma persona puede
 * tener varias filas en EA** y la ficha tiene que juntar las citas de todas. La
 * búsqueda por teléfono se hace con las variantes de escritura porque el
 * `search()` de EA es un `LIKE` sobre el texto crudo, no sobre el número
 * normalizado.
 */
export async function loadClientProfile(key: ClientKey): Promise<ClientProfileResult> {
  const ea = eaClientOrNull();
  const legacy = await loadLegacyByPhone(key.kind === "tel" ? key.phone : null);

  if ("failure" in ea) {
    // Sin EA todavía se puede mostrar la mitad histórica, que es mejor que un
    // 500 — pero solo si la llave es un teléfono: una ficha `ea-…` no existe
    // fuera de EA.
    if (key.kind === "ea" || legacy.length === 0) {
      return { found: false, failure: ea.failure };
    }
    return {
      found: true,
      profile: {
        client: legacyOnlyClient(key, legacy),
        history: buildUnifiedHistory([], legacy),
        historyPartial: true,
        failure: ea.failure,
      },
    };
  }

  let customers: Customer[];
  try {
    customers = await findCustomers(ea.client, key);
  } catch (error) {
    return { found: false, failure: describeEaFailure(error) };
  }

  if (customers.length === 0) {
    if (key.kind === "tel" && legacy.length > 0) {
      // Clienta que solo existe en el histórico: vino antes del corte y no ha
      // vuelto. Es una ficha legítima, no un 404.
      return {
        found: true,
        profile: {
          client: legacyOnlyClient(key, legacy),
          history: buildUnifiedHistory([], legacy),
          historyPartial: false,
          failure: null,
        },
      };
    }
    return { found: false, failure: null };
  }

  const [client] = mergeCustomers(customers);

  let eaHistory: EaHistoryInput[] = [];
  let historyPartial = false;
  let failure: EaFailure | null = null;
  try {
    eaHistory = await loadEaHistory(ea.client, client.eaCustomerIds);
  } catch (error) {
    historyPartial = true;
    failure = describeEaFailure(error);
  }

  return {
    found: true,
    profile: {
      client,
      history: buildUnifiedHistory(eaHistory, legacy),
      historyPartial,
      failure,
    },
  };
}

async function findCustomers(ea: EaClient, key: ClientKey): Promise<Customer[]> {
  if (key.kind === "ea") {
    try {
      return [await ea.customers.get(key.eaCustomerId)];
    } catch (error) {
      if (error instanceof EaApiError && error.kind === "not_found") return [];
      throw error;
    }
  }

  const byId = new Map<number, Customer>();
  for (const variant of phoneSearchVariants(key.phone)) {
    const found = await ea.customers.list({ q: variant });
    for (const customer of found) {
      // El `LIKE` de EA trae de más: "300 123 4567" también encuentra a quien
      // tenga eso en las notas. El filtro de verdad es la normalización.
      if (normalizePhoneE164(customer.phone) === key.phone) {
        byId.set(customer.id, customer);
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Las citas de EA de una clienta, con nombre de servicio y de técnica.
 *
 * Los catálogos se traen enteros una vez en vez de pedir `with=service` por
 * cita: son decenas de filas, se reutilizan para todas las citas, y evitan
 * depender de la forma cruda en snake_case que devuelve `with=`.
 */
async function loadEaHistory(
  ea: EaClient,
  customerIds: readonly number[],
): Promise<EaHistoryInput[]> {
  const [services, providers] = await Promise.all([
    ea.services.list(),
    ea.providers.list(),
  ]);

  const serviceName = new Map<number, string | null>(
    services.map((service: Service) => [service.id, service.name]),
  );
  const providerName = new Map<number, string>(
    providers.map((provider: Provider) => [provider.id, displayName(provider)]),
  );

  const perCustomer = await Promise.all(
    customerIds.map((customerId) => ea.appointments.list({ customerId })),
  );
  const appointments = perCustomer.flat();

  const finance = appointmentFinanceRepository(getDb());
  const amounts = await Promise.all(
    appointments.map(async (appointment) => {
      try {
        const row = await finance.findByEaAppointmentId(appointment.id);
        return row?.amount_charged ?? null;
      } catch {
        // La plata que no se pudo leer se muestra como desconocida, no como
        // cero: `history.ts` marca el total como parcial y la ficha lo dice.
        return null;
      }
    }),
  );

  return appointments.map((appointment, index) => ({
    appointment,
    serviceName:
      appointment.serviceId === null
        ? null
        : (serviceName.get(appointment.serviceId) ?? null),
    providerName:
      appointment.providerId === null
        ? null
        : (providerName.get(appointment.providerId) ?? null),
    amountCharged: amounts[index],
  }));
}

/**
 * Las filas del histórico de Agenda Pro de un teléfono.
 *
 * ⚠ **Consulta directa, sin pasar por un repositorio.** `legacyAppointmentRepository`
 * expone `firstVisitByPhone()` y `listByStartRange()`, y ninguna de las dos
 * sirve acá: una devuelve una fecha y la otra obligaría a barrer toda la
 * historia del estudio para filtrar en memoria. Está pedido como
 * `listByPhone()` en el reporte de este paquete; el día que exista, esta
 * función se reduce a una línea.
 */
async function loadLegacyByPhone(phone: string | null): Promise<LegacyAppointment[]> {
  if (phone === null) return [];
  try {
    return await getDb()
      .selectFrom("legacy_appointment")
      .selectAll()
      .where("client_phone_e164", "=", phone)
      .orderBy("started_at", "desc")
      .execute();
  } catch (error) {
    console.error("[clientes] no se pudo leer el histórico", error);
    return [];
  }
}

/** La ficha de alguien que solo existe antes del corte. */
function legacyOnlyClient(key: ClientKey, legacy: LegacyAppointment[]): ResolvedClient {
  const named = legacy.find((row) => (row.client_name ?? "").trim() !== "");
  return {
    key,
    phone: key.kind === "tel" ? key.phone : null,
    name: named?.client_name?.trim() ?? "Clienta sin nombre",
    email: null,
    suspiciousEmails: [],
    eaCustomerIds: [],
    notes: null,
    merged: false,
  };
}

/** El enlace a la ficha. Vive acá para que la lista y la ficha no se separen. */
export function clientHref(key: ClientKey): string {
  return `/clientes/${clientKeyToParam(key)}`;
}
