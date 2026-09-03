import "server-only";

import { stationRepository } from "@/db/repositories";
import { getDb } from "@/db/client";
import type { GridProvider } from "@/lib/calendar-layout";
import type { ServiceCapacity, StationSlot } from "@/lib/conflict";
import { requireSession, type PanelSession } from "@/lib/dal";
import {
  createEaClient,
  decodeAppointmentWithRelations,
  type EaClient,
} from "@/lib/ea/client";
import { EaApiError } from "@/lib/ea/errors";
import type { EaLocalDate } from "@/lib/ea/datetime";
import { instantToEaDate } from "@/lib/ea/datetime";
import type {
  Appointment,
  ApiShape,
  BlockedPeriod,
  Unavailability,
} from "@/lib/ea/types";
import { fetchWindow, touchesDates } from "@/components/calendar/range";
import type {
  AppointmentMeta,
  MetaIndex,
  ServiceOption,
} from "@/components/calendar/types";

/**
 * Todo lo que la agenda le pide a EA y a `gbs_admin` para pintar un rango.
 *
 * ## Cinco cosas de la API de EA que este archivo tiene que respetar
 *
 * 1. **Pagina de a 20 por defecto.** `list()` de A1 agota las páginas; donde se
 *    usa `raw()` —el listado con relaciones— la paginación es de acá, y con
 *    `length` explícito. Una agenda que muestra 20 de 34 citas no avisa: se ve
 *    perfecta y le falta media tarde.
 * 2. **`from`/`till` son de grano día e inclusivos**, así que se pide un día
 *    extra a cada lado y se recorta en memoria (`fetchWindow`, `touchesDates`).
 * 3. **`q` anula todos los demás filtros.** Acá no se usa; queda dicho para que
 *    nadie lo agregue de paso.
 * 4. **El color del servicio no se puede leer con `GET /services`** — es de solo
 *    escritura en la API v1. Se obtiene con `with=service`, que además evita el
 *    N+1 de pedir el servicio de cada cita.
 * 5. **Las relaciones de `with=` vienen en snake_case**, no en camelCase: EA las
 *    pega con un `row_array()` sin pasar por `api_encode()`. Por eso se decodifican
 *    con `decodeAppointmentWithRelations()` de A1 y no a mano.
 *
 * ## Y una que no es de EA
 *
 * **El DAL se llama acá otra vez.** El layout de `(panel)` ya exigió sesión;
 * este módulo lo vuelve a hacer porque lo invoca también el Route Handler del
 * polling, que no pasa por ningún layout. La regla del plan es literal: cada
 * Server Component que lee y cada Server Action que escribe llama al DAL.
 */

// ---------------------------------------------------------------------------
// Forma del resultado
// ---------------------------------------------------------------------------

/**
 * Lo que cruza al cliente.
 *
 * Son datos crudos, no una grilla ya armada: el cliente vuelve a llamar a
 * `buildDayGrid()` con esto cada vez que el polling trae algo nuevo, y tener un
 * solo camino —el mismo en el primer render y en el refresco número cuarenta—
 * es lo que evita que la agenda se vea distinta según cómo llegó el dato.
 */
export type AgendaData = {
  providers: GridProvider[];
  appointments: Appointment[];
  unavailabilities: Unavailability[];
  blockedPeriods: BlockedPeriod[];
  meta: MetaIndex;
  services: ServiceOption[];
  /** Lo que `checkConflicts()` necesita saber de cada servicio. */
  capacities: ServiceCapacity[];
  /** Los puestos del estudio, de `gbs_admin`. Ver § El estudio tiene dos puestos. */
  stations: StationSlot[];
  /** ISO. Lo muestra la barra: "actualizado hace 12 s". */
  fetchedAt: string;
};

export type AgendaLoad =
  | { ok: true; data: AgendaData; session: PanelSession }
  | { ok: false; reason: string; session: PanelSession; stations: StationSlot[] };

// ---------------------------------------------------------------------------
// Carga
// ---------------------------------------------------------------------------

/**
 * Trae lo necesario para los días pedidos.
 *
 * **Nunca lanza por culpa de EA.** Si EA no responde, `gbs_admin` sigue arriba y
 * el panel entra en solo lectura con una banda de aviso (§ Estados que no son el
 * estado feliz): mucho mejor que una pantalla de error, y muchísimo mejor que un
 * formulario que falla al enviar. Lo que sí propaga es un fallo de sesión, que
 * es un redirect y no un error.
 */
export async function loadAgenda(
  dates: readonly EaLocalDate[],
  options: { client?: EaClient } = {},
): Promise<AgendaLoad> {
  const session = await requireSession();
  const stations = await loadStations();

  try {
    const client = options.client ?? createEaClient();
    const data = await fetchFromEa(client, dates, session, stations);
    return { ok: true, data, session };
  } catch (error) {
    // El mensaje se registra entero en el servidor —`EaApiError` ya tacha el
    // token— y a la pantalla solo llega el porqué, sin la URL ni el cuerpo.
    console.error("[agenda] no se pudo leer de EA", error);
    return {
      ok: false,
      session,
      stations,
      reason:
        error instanceof EaApiError
          ? describeEaFailure(error)
          : "No se pudo leer la agenda de Easy!Appointments.",
    };
  }
}

function describeEaFailure(error: EaApiError): string {
  switch (error.kind) {
    case "timeout":
      return "Easy!Appointments no respondió a tiempo.";
    case "network":
      return "No se pudo alcanzar Easy!Appointments.";
    case "unauthorized":
      return "Easy!Appointments rechazó el token del panel.";
    case "config":
      return "Al panel le falta la configuración de Easy!Appointments.";
    default:
      return "Easy!Appointments devolvió una respuesta que el panel no pudo leer.";
  }
}

/** Los puestos del estudio. Si `gbs_admin` no responde, se devuelven cero. */
async function loadStations(): Promise<StationSlot[]> {
  try {
    const rows = await stationRepository(getDb()).listAll();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      allows: row.allows ?? null,
    }));
  } catch (error) {
    // Cero puestos y omitir el chequeo son cosas distintas, y la diferencia
    // importa: `checkConflicts()` con `stations: []` reporta "no hay puestos
    // configurados", que es exactamente lo que hay que ver si la consulta
    // falló. Devolver `[]` acá y que el motor lo grite es mejor que apagar en
    // silencio la restricción más fácil de olvidar del proyecto.
    console.error("[agenda] no se pudieron leer los puestos", error);
    return [];
  }
}

async function fetchFromEa(
  client: EaClient,
  dates: readonly EaLocalDate[],
  session: PanelSession,
  stations: StationSlot[],
): Promise<AgendaData> {
  const window = fetchWindow(dates);

  const [rawProviders, rawServices, exceptions, unavailabilities, blockedPeriods, withRelations] =
    await Promise.all([
      client.providers.list(),
      client.services.list(),
      client.workingPlanExceptions.list(),
      client.unavailabilities.list(),
      client.blockedPeriods.list(),
      listAppointmentsWithRelations(client, window.from, window.till),
    ]);

  // **Una técnica ve solo su columna.** El filtro está acá y no en el
  // componente: esconder la columna es cortesía, no autorización, y la lista de
  // citas de las demás no puede ni llegar al navegador.
  const mine = session.role === "staff" ? session.eaProviderId : null;

  const providers: GridProvider[] = rawProviders
    .filter((provider) => mine === null || provider.id === mine)
    .map((provider) => ({
      id: provider.id,
      name: fullName(provider.firstName, provider.lastName) ?? `Profesional ${provider.id}`,
      workingPlan: provider.settings?.workingPlan ?? null,
      workingPlanExceptions: exceptions.filter((e) => e.providerId === provider.id),
    }));

  const visibleProviderIds = new Set(providers.map((p) => p.id));
  const keep = <T extends { providerId: number | null }>(item: T): boolean =>
    mine === null || (item.providerId !== null && visibleProviderIds.has(item.providerId));

  return {
    providers,
    appointments: withRelations.appointments.filter(
      (appointment) => keep(appointment) && touchesDates(appointment, dates),
    ),
    // `unavailabilities` y `blocked_periods` no aceptan `from`/`till` en el
    // cliente tipado de A1, así que se traen enteras y se recortan acá. Con las
    // decenas de filas al año de un estudio de dos puestos es correcto y barato;
    // el día que sean miles, lo que corresponde es pedirle a A1 el filtro, no
    // hacer aritmética de fechas en un componente.
    unavailabilities: unavailabilities.filter(
      (item) => keep(item) && touchesDates(item, dates),
    ),
    blockedPeriods: blockedPeriods.filter((item) => touchesDates(item, dates)),
    meta: withRelations.meta,
    services: rawServices
      .map<ServiceOption>((service) => ({
        id: service.id,
        name: service.name ?? `Servicio ${service.id}`,
        duration: service.duration,
        attendantsNumber: service.attendantsNumber,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "es")),
    capacities: rawServices.map<ServiceCapacity>((service) => ({
      id: service.id,
      attendantsNumber: service.attendantsNumber,
      // ⚠ La categoría de `pricing.ts` sale de `service_map` cruzado con el
      // catálogo de la vitrina, que vive en la landing y no en `admin/`. Hoy los
      // dos puestos tienen `allows: NULL` —cualquier categoría— así que `null`
      // acá da exactamente el mismo resultado que el valor correcto. El día que
      // un puesto se especialice, esto **tiene** que dejar de ser `null` o el
      // chequeo de puestos empezará a decir que sí a citas que no caben.
      category: null,
    })),
    stations,
    fetchedAt: new Date().toISOString(),
  };
}

function fullName(first: string | null, last: string | null): string | null {
  const name = [first, last].filter((part) => part && part.trim() !== "").join(" ").trim();
  return name === "" ? null : name;
}

// ---------------------------------------------------------------------------
// El listado con relaciones
// ---------------------------------------------------------------------------

/** Cuántas citas por página. Muy por encima de una semana de un estudio chico. */
const PAGE_LENGTH = 100;
/** Tope de páginas. Se lanza al superarlo; nunca se devuelve una lista parcial. */
const MAX_PAGES = 50;

/**
 * `GET /appointments?with=service,customer`, paginado hasta agotar.
 *
 * Va por `raw()` —la escotilla sin tipar de A1— y no por `appointments.list()`,
 * porque el cliente tipado decodifica solo la cita y descarta las relaciones
 * adjuntas. Y las relaciones son justo lo que hace falta: el nombre de la
 * clienta, el del servicio y **el color**, que `GET /services` no devuelve.
 *
 * La paginación se repite acá en quince líneas en vez de pedirle a A1 un método
 * nuevo. Es la deuda consciente de este paquete; está anotada en el reporte.
 */
async function listAppointmentsWithRelations(
  client: EaClient,
  from: EaLocalDate,
  till: EaLocalDate,
): Promise<{ appointments: Appointment[]; meta: MetaIndex }> {
  const appointments: Appointment[] = [];
  const meta: Record<number, AppointmentMeta> = {};

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      from,
      till,
      with: "service,customer",
      sort: "start",
      page: String(page),
      length: String(PAGE_LENGTH),
    });

    const payload = await client.raw({ method: "GET", path: "appointments", params });

    if (!Array.isArray(payload)) {
      throw new EaApiError("Se esperaba una lista de citas y llegó otra cosa", {
        kind: "malformed",
        path: "appointments",
      });
    }

    for (const item of payload as ApiShape[]) {
      const decoded = decodeAppointmentWithRelations(item);
      appointments.push(decoded.appointment);
      meta[decoded.appointment.id] = {
        customer: fullName(
          decoded.customer?.firstName ?? null,
          decoded.customer?.lastName ?? null,
        ),
        service: decoded.service?.name ?? null,
        serviceColor: decoded.service?.color ?? null,
        phone: decoded.customer?.phone ?? null,
      };
    }

    // Página incompleta = se acabó. Es la única señal que EA da: su respuesta
    // es un arreglo pelado, sin total.
    if (payload.length < PAGE_LENGTH) {
      return { appointments, meta };
    }
  }

  throw new EaApiError(
    `El listado de citas superó ${MAX_PAGES} páginas de ${PAGE_LENGTH}. Se aborta en vez de ` +
      "mostrar una agenda incompleta.",
    { kind: "pagination_overflow", path: "appointments" },
  );
}

// ---------------------------------------------------------------------------
// Utilidades compartidas con las acciones
// ---------------------------------------------------------------------------

/** Hoy, en el reloj del estudio. Nunca `new Date().toISOString()`. */
export function todayInStudio(now: Date = new Date()): EaLocalDate {
  return instantToEaDate(now);
}

/** Las opciones de clienta para el formulario, buscadas por texto. */
export async function searchCustomers(
  term: string,
  options: { client?: EaClient } = {},
): Promise<Array<{ id: number; name: string; phone: string | null }>> {
  await requireSession();
  const trimmed = term.trim();
  if (trimmed.length < 2) return [];

  const client = options.client ?? createEaClient();

  // `q` anula cualquier otro filtro dentro de EA; el cliente de A1 lo rechaza si
  // se mandan juntos. Acá va solo, que es como corresponde.
  const found = await client.customers.listPage({ q: trimmed, length: 20 });

  return found.items.map((customer) => ({
    id: customer.id,
    name: fullName(customer.firstName, customer.lastName) ?? `Clienta ${customer.id}`,
    phone: customer.phone,
  }));
}
