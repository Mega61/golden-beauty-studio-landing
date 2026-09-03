import "server-only";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import type { AppointmentFinance, AppointmentFinanceItem } from "@/db/types";
import {
  EA_TIME_ZONE,
  parseEaLocalDateTime,
  eaLocalToInstant,
  instantToEaDate,
  instantToEaLocal,
  type EaLocalDate,
} from "@/lib/ea";
import {
  buildListParams,
  createEaClient,
  decodeAppointmentWithRelations,
  type AppointmentWithRelations,
  type EaClient,
} from "@/lib/ea/client";
import type { TicketCatalog } from "@/components/ticket/catalog";
import type { TicketFinanceView, TodayAppointment } from "@/components/ticket/types";
import type { PanelSession } from "@/lib/dal";
import { loadCatalogForClose } from "./catalog-server";

/**
 * Los datos de la pantalla **Hoy**.
 *
 * Dos fuentes que no se pueden unir con un JOIN: las citas viven en
 * `easyappointments` y se leen por su API REST; la plata vive en `gbs_admin` y
 * se lee con otro usuario de MySQL. El cruce se hace acá, en memoria, por
 * `ea_appointment_id` — que es exactamente para lo que A2 copió `ea_provider_id`
 * y `appointment_start_at` a la fila de plata.
 *
 * ## Qué pasa cuando EA no responde
 *
 * El plan lo tiene decidido: **solo lectura con banda de aviso**, no una
 * pantalla de error. `gbs_admin` sigue arriba, así que las cuentas del día se
 * pueden mostrar igual — sin nombre de clienta y sin estado, porque eso vive
 * allá. Es peor esconder la jornada entera que mostrarla incompleta y decirlo.
 *
 * La recíproca no aplica: sin `gbs_admin` no hay cuenta que cerrar ni catálogo
 * que mapear, y la pantalla lo dice de frente.
 */

/** Tope de páginas al listar el día. Un día del estudio no llega ni a una. */
const MAX_PAGES = 20;
const PAGE_LENGTH = 100;

export type TodayProblem = {
  /** `ea` = la agenda; `db` = la plata. */
  source: "ea" | "db";
  message: string;
};

export type TodayData = {
  /** El día del **estudio**, no el del proceso. */
  date: EaLocalDate;
  appointments: TodayAppointment[];
  catalog: TicketCatalog;
  /** Lo que no se pudo traer. Vacío = todo bien. */
  problems: TodayProblem[];
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function personName(
  person: { firstName: string | null; lastName: string | null } | null,
  fallback: string,
): string {
  if (person === null) return fallback;
  const name = [person.firstName, person.lastName].filter(Boolean).join(" ").trim();
  return name === "" ? fallback : name;
}

/**
 * Las citas de un día con `service`, `provider` y `customer` adjuntos.
 *
 * Se pide por el acceso crudo y no por `ea.appointments.list()` porque las
 * relaciones que EA adjunta con `with=` vienen en **snake_case** —su `load()`
 * pega la fila de MySQL tal cual— y el codec tipado del listado las descarta.
 * `decodeAppointmentWithRelations()` de A1 es justamente el que sabe leer esa
 * mezcla.
 *
 * La paginación se replica con la misma disciplina que `list()`: se pide de a
 * 100 hasta que una página venga incompleta, y si se agotan las páginas se
 * **lanza** en vez de devolver medio día. `Api::$default_length` de EA vale 20 y
 * no hay ninguna señal en la respuesta de que falten registros: una agenda a la
 * que le falta una cita se ve exactamente igual que una completa.
 */
async function listDayAppointments(
  ea: EaClient,
  date: EaLocalDate,
  eaProviderId: number | null,
): Promise<AppointmentWithRelations[]> {
  const out: AppointmentWithRelations[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const params = buildListParams({ with: ["service", "provider", "customer"] });
    params.set("date", date);
    if (eaProviderId !== null) params.set("providerId", String(eaProviderId));
    params.set("page", String(page));
    params.set("length", String(PAGE_LENGTH));

    const payload = await ea.raw({ method: "GET", path: "appointments", params });

    if (!Array.isArray(payload)) {
      throw new Error("EA devolvió algo que no es una lista de citas");
    }

    for (const raw of payload) {
      out.push(decodeAppointmentWithRelations(raw as Record<string, unknown>));
    }

    if (payload.length < PAGE_LENGTH) return out;
  }

  throw new Error(
    `Las citas de ${date} superaron ${MAX_PAGES} páginas de ${PAGE_LENGTH}. ` +
      "Se aborta en vez de mostrar medio día.",
  );
}

function financeViewOf(
  row: AppointmentFinance | undefined,
  items: readonly AppointmentFinanceItem[],
): TicketFinanceView {
  if (row === undefined) {
    return {
      financeId: null,
      performedServiceId: null,
      discount: 0,
      tip: 0,
      amountCharged: null,
      paymentMethod: null,
      serviceNotes: "",
      varianceReasonCode: null,
      varianceReason: "",
      closedAt: null,
      frozenByDayClose: false,
      snapshot: null,
      snapshotSource: null,
      items: [],
    };
  }

  return {
    items: items.map((i) => ({
      kind: i.kind,
      eaServiceId: i.ea_service_id,
      qty: i.qty,
      unitPrice: i.unit_price_snapshot,
      note: i.note,
    })),
    financeId: row.id,
    performedServiceId: row.performed_service_id,
    discount: row.discount,
    tip: row.tip,
    amountCharged: row.amount_charged,
    paymentMethod: row.payment_method,
    serviceNotes: row.service_notes ?? "",
    varianceReasonCode: row.variance_reason_code,
    varianceReason: row.variance_reason ?? "",
    closedAt: row.closed_at === null ? null : instantToEaLocal(row.closed_at),
    frozenByDayClose: row.day_close_id !== null,
    snapshot: row.service_price_snapshot,
    snapshotSource: row.snapshot_source,
  };
}

/**
 * El día completo, ya cruzado.
 *
 * Una técnica ve **solo sus citas**, y el recorte se hace en dos lugares a
 * propósito: el `providerId` que va a EA (para no traer lo que no le toca) y el
 * filtro sobre las filas de plata (para el modo degradado, donde EA no
 * contestó). Ninguno de los dos es la compuerta — ésa es `requireOwnProvider()`
 * en la Server Action, que es la que decide si una escritura se permite.
 */
export async function loadToday(
  session: PanelSession,
  options: { verTodas: boolean; now?: Date } = { verTodas: true },
): Promise<TodayData> {
  const now = options.now ?? new Date();
  const date = instantToEaDate(now);
  const problems: TodayProblem[] = [];

  const soloProvider = options.verTodas ? null : session.eaProviderId;

  const dayStart = eaLocalToInstant(parseEaLocalDateTime(`${date} 00:00:00`), EA_TIME_ZONE);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  // --- La plata -----------------------------------------------------------
  let financeRows: AppointmentFinance[] = [];
  let financeItems: AppointmentFinanceItem[] = [];
  let db: ReturnType<typeof getDb> | null = null;

  try {
    db = getDb();
    const repos = repositories(db);
    financeRows = await repos.appointmentFinance.listByStartRange(dayStart, dayEnd);
    // Los renglones se traen en una sola consulta para todo el día: una por
    // cuenta serían veinte idas y vueltas para pintar una lista.
    financeItems = await repos.appointmentFinanceItems.listByFinanceIds(
      financeRows.map((r) => r.id),
    );
  } catch (error) {
    db = null;
    problems.push({ source: "db", message: messageOf(error) });
  }

  const financeByEaId = new Map(financeRows.map((r) => [r.ea_appointment_id, r]));
  const itemsByFinanceId = new Map<number, AppointmentFinanceItem[]>();
  for (const item of financeItems) {
    const bucket = itemsByFinanceId.get(item.appointment_finance_id);
    if (bucket) bucket.push(item);
    else itemsByFinanceId.set(item.appointment_finance_id, [item]);
  }

  const viewFor = (row: AppointmentFinance | undefined): TicketFinanceView =>
    financeViewOf(row, row === undefined ? [] : (itemsByFinanceId.get(row.id) ?? []));

  // --- La agenda ----------------------------------------------------------
  let catalog: TicketCatalog = { services: [] };
  let citas: AppointmentWithRelations[] | null = null;

  try {
    const ea = createEaClient();
    const [lista, cat] = await Promise.all([
      listDayAppointments(ea, date, soloProvider),
      // Sin base no hay `service_map`, así que el catálogo saldría sin
      // `pricing_id`. Se prefiere no armarlo: una cuenta cerrada con renglones
      // sin id de vitrina deja las reglas de comisión por categoría sin nada
      // con qué emparejar, y eso no se ve hasta la liquidación.
      db === null
        ? Promise.resolve<TicketCatalog>({ services: [] })
        : loadCatalogForClose(db, ea),
    ]);
    citas = lista;
    catalog = cat;
  } catch (error) {
    problems.push({ source: "ea", message: messageOf(error) });
  }

  if (citas !== null) {
    const appointments = citas
      .map(({ appointment, service, provider, customer }): TodayAppointment => {
        const finance = financeByEaId.get(appointment.id);
        return {
          eaAppointmentId: appointment.id,
          start: appointment.start,
          end: appointment.end,
          status: appointment.status,
          customerName: personName(customer, "Sin clienta"),
          customerPhone: customer?.phone ?? null,
          eaProviderId: appointment.providerId,
          providerName: personName(provider, "Sin asignar"),
          bookedServiceId: appointment.serviceId,
          bookedServiceName: service?.name ?? "Sin servicio",
          finance: viewFor(finance),
        };
      })
      .sort((a, b) => a.start.localeCompare(b.start) || a.eaAppointmentId - b.eaAppointmentId);

    return { date, appointments, catalog, problems };
  }

  // --- Modo degradado: EA no contestó -------------------------------------
  //
  // Queda lo que `gbs_admin` sabe por sí solo. Sin nombre de clienta, sin
  // estado y sin catálogo: cerrar una cuenta necesita precios de EA, así que la
  // pantalla se dibuja en solo lectura. Mostrar la jornada sin poder tocarla es
  // mejor que un formulario que falla al enviar.
  const appointments = financeRows
    .filter((row) => soloProvider === null || row.ea_provider_id === soloProvider)
    .map((row): TodayAppointment => {
      const start =
        row.appointment_start_at === null
          ? parseEaLocalDateTime(`${date} 00:00:00`)
          : instantToEaLocal(row.appointment_start_at);
      return {
        eaAppointmentId: row.ea_appointment_id,
        start,
        end: start,
        status: "",
        customerName: `Cita #${row.ea_appointment_id}`,
        customerPhone: null,
        eaProviderId: row.ea_provider_id,
        providerName: "—",
        bookedServiceId: row.booked_service_id,
        bookedServiceName: "—",
        finance: viewFor(row),
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start) || a.eaAppointmentId - b.eaAppointmentId);

  return { date, appointments, catalog, problems };
}
