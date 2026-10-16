/**
 * Un mes inventado, para poder mirar los nueve reportes en un navegador.
 *
 * **Por qué existe:** la Definition of Done de D4 pide revisar la pantalla a
 * 390 / 768 / 1440, y un reporte vacío no prueba nada — lo que hay que ver es
 * cómo se comportan una barra con un nombre largo, un mapa de calor de cinco
 * columnas y un tile cuyo valor dice "todavía no se puede medir". Montar EA con
 * su asistente, dos técnicas y un mes de citas cerradas para comprobar eso son
 * horas que no prueban nada del panel.
 *
 * **Qué no es:** un modo de demostración. La ruta que lo usa responde 404 en
 * producción, y estos datos entran por el mismo borde por el que entrarían los
 * de verdad — el tipo `ReportData` de `data.ts`, sin atajos.
 *
 * El mes está armado a propósito para que aparezcan los casos raros, que son
 * los que rompen el layout:
 *
 * - Un servicio **sin duración** en el catálogo, que sale `null` en el ingreso
 *   por hora de silla y va al final.
 * - Una cuenta cerrada **sin método de pago**, que traba el cierre.
 * - Un cambio de servicio (press-on → forrado), que es el caso del plan.
 * - Una cuenta con **variación sin motivo**, imposible por el panel, que es
 *   justo la que Diagnóstico tiene que destapar.
 * - Un estado de EA **que el panel no traduce** ("Pendiente"), para ver el
 *   aviso.
 * - Una cohorte de retención **con la ventana abierta**, para ver el
 *   "todavía no se puede medir" en vez de un 0 %.
 * - Un nombre de servicio largo, para ver el recorte de la etiqueta.
 * - Para los reportes de pauta: sábados por la tarde llenos, martes flojos, y
 *   una inversión en anuncios anotada para el mes (ver `demandRows()`).
 * - **Historial de Agenda Pro** en los primeros días del mes (ver
 *   `legacyRaw()`): ventas mezcladas con las del panel, una profesional que casa
 *   por nombre de pila (Lina), una que ya no está (Kati), una cancelada, una
 *   inasistencia, una reserva y una atendida **sin monto**.
 */

import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";
import type { EaLocalDate, EaLocalDateTime } from "@/lib/ea";

import type {
  AppointmentRow,
  CommissionEntryRow,
  FinanceItemRow,
  FinanceRow,
  ProviderRow,
  ServiceRow,
} from "../aggregate";
import type { ReportData } from "../data";
import { legacyReportRows, type LegacyRawRow } from "../legacy-blend";
import { windowOverRange } from "../occupancy";
import { eachDay, resolvePeriod, type Cadence } from "../period";

const at = (value: string) => parseEaLocalDateTime(value);

const PROVIDERS: ProviderRow[] = [
  { id: 7, name: "Lina" },
  { id: 8, name: "Sara" },
];

const SERVICES: ServiceRow[] = [
  { id: 1, name: "Montaje con diseño completo", durationMin: 150 },
  { id: 2, name: "Combo manos y pies", durationMin: 120 },
  { id: 3, name: "Press-on", durationMin: 60 },
  { id: 4, name: "Forrado", durationMin: 90 },
  { id: 5, name: "Retoque express", durationMin: 45 },
  // Sin duración: sale `null` en el ingreso por hora de silla y va al final.
  { id: 6, name: "Servicio sin duración", durationMin: 0 },
];

const PLAN = {
  monday: { start: "09:00", end: "18:00", breaks: [{ start: "13:00", end: "14:00" }] },
  tuesday: { start: "09:00", end: "18:00", breaks: [{ start: "13:00", end: "14:00" }] },
  wednesday: { start: "09:00", end: "18:00", breaks: [{ start: "13:00", end: "14:00" }] },
  thursday: { start: "09:00", end: "18:00", breaks: [{ start: "13:00", end: "14:00" }] },
  friday: { start: "09:00", end: "19:00", breaks: [{ start: "13:00", end: "14:00" }] },
  saturday: { start: "09:00", end: "15:00", breaks: [] },
  sunday: null,
} as const;

type Row = {
  id: number;
  provider: number;
  day: string;
  hour: string;
  booked: number;
  performed: number;
  service: number;
  charged: number | null;
  tip?: number;
  method?: FinanceRow["payments"][number]["method"];
  /** Para la cuenta partida: los pagos completos, en vez de un solo método. */
  payments?: FinanceRow["payments"];
  reason?: FinanceRow["varianceReasonCode"];
  extras?: number;
  status?: string;
  snapshotSource?: FinanceRow["snapshotSource"];
  mirrored?: boolean;
  customer?: string;
};

/**
 * Una jornada del mes, renglón por renglón. Se escribe una vez y de acá salen
 * las citas de EA y las cuentas de `gbs_admin`, que es como llegan de verdad:
 * dos fuentes que hablan de lo mismo.
 */
const MONTH: Row[] = [
  { id: 101, provider: 7, day: "03", hour: "09:00", booked: 1, performed: 1, service: 150_000, charged: 150_000, tip: 10_000, method: "efectivo", customer: "+573001110001" },
  { id: 102, provider: 8, day: "03", hour: "09:30", booked: 2, performed: 2, service: 95_000, charged: 95_000, method: "transferencia", customer: "+573001110002" },
  { id: 103, provider: 7, day: "04", hour: "14:00", booked: 3, performed: 4, service: 60_000, charged: 90_000, method: "efectivo", extras: 0, customer: "+573001110003" },
  { id: 104, provider: 8, day: "05", hour: "10:00", booked: 1, performed: 1, service: 150_000, charged: 130_000, method: "efectivo", reason: "cortesia", customer: "+573001110004" },
  { id: 105, provider: 7, day: "06", hour: "16:00", booked: 5, performed: 5, service: 55_000, charged: 55_000, extras: 24_000, method: "transferencia", customer: "+573001110005" },
  { id: 106, provider: 8, day: "07", hour: "11:00", booked: 2, performed: 2, service: 95_000, charged: 95_000, extras: 8_000, method: "otro", customer: "+573001110001" },
  { id: 107, provider: 7, day: "10", hour: "09:00", booked: 1, performed: 1, service: 150_000, charged: 150_000, tip: 15_000, method: "efectivo", customer: "+573001110006" },
  // Sin método de pago: traba el cierre del día y sale aparte de "otro".
  { id: 108, provider: 8, day: "10", hour: "15:00", booked: 4, performed: 4, service: 90_000, charged: 90_000, customer: "+573001110007" },
  { id: 109, provider: 7, day: "11", hour: "18:30", booked: 3, performed: 3, service: 60_000, charged: 60_000, method: "efectivo", status: "No asistió", customer: "+573001110008" },
  { id: 110, provider: 8, day: "12", hour: "12:00", booked: 6, performed: 6, service: 40_000, charged: 40_000, method: "efectivo", customer: "+573001110009" },
  // Variación sin motivo: imposible por el panel, así que es un hallazgo.
  { id: 111, provider: 7, day: "13", hour: "10:00", booked: 1, performed: 1, service: 150_000, charged: 120_000, method: "efectivo", customer: "+573001110010" },
  { id: 112, provider: 8, day: "14", hour: "09:00", booked: 3, performed: 4, service: 60_000, charged: 85_000, method: "transferencia", reason: "cambio_servicio", customer: "+573001110011" },
  { id: 113, provider: 7, day: "17", hour: "11:00", booked: 2, performed: 2, service: 95_000, charged: 95_000, extras: 16_000, method: "efectivo", customer: "+573001110002" },
  { id: 114, provider: 8, day: "18", hour: "14:00", booked: 5, performed: 5, service: 55_000, charged: 50_000, method: "efectivo", reason: "correccion", customer: "+573001110012" },
  { id: 115, provider: 7, day: "19", hour: "09:30", booked: 1, performed: 1, service: 150_000, charged: 150_000, method: "transferencia", snapshotSource: "fallback", customer: "+573001110013" },
  // Estado que el panel no traduce: sale del denominador y se avisa.
  { id: 116, provider: 8, day: "20", hour: "16:00", booked: 4, performed: 4, service: 90_000, charged: null, status: "Pendiente", customer: "+573001110014" },
  { id: 117, provider: 7, day: "21", hour: "10:00", booked: 2, performed: 2, service: 95_000, charged: 95_000, method: "efectivo", customer: "+573001110005" },
  // Sin espejar en Google: el push falló en silencio.
  { id: 118, provider: 8, day: "24", hour: "11:00", booked: 1, performed: 1, service: 150_000, charged: 150_000, method: "efectivo", mirrored: false, customer: "+573001110015" },
  { id: 119, provider: 7, day: "25", hour: "13:00", booked: 5, performed: 5, service: 55_000, charged: 55_000, method: "otro", status: "Cancelada", customer: "+573001110016" },
  { id: 120, provider: 8, day: "26", hour: "09:00", booked: 3, performed: 3, service: 60_000, charged: 60_000, extras: 8_000, method: "efectivo", customer: "+573001110017" },
  // Una cita atendida sin cuenta cerrada, para ver la compuerta del cierre.
  { id: 121, provider: 7, day: "27", hour: "15:00", booked: 1, performed: 1, service: 150_000, charged: null, customer: "+573001110018" },
  // Sin teléfono: sale de la cuenta de clientas y se dice cuántas fueron.
  { id: 122, provider: 8, day: "28", hour: "10:00", booked: 2, performed: 2, service: 95_000, charged: 95_000, method: "efectivo" },
];

/**
 * La demanda del mes, para los dos reportes de pauta.
 *
 * Armada para que la lectura sea obvia en la vista previa: **los sábados por
 * la tarde se llenan** (las dos técnicas, de 12 m. a 3 p. m., los cinco
 * sábados del mes) y **los martes se quedan flojos** — solo los cuatro
 * renglones de `MONTH`, uno de ellos una inasistencia y otro una cancelada.
 * Los viernes al final de la tarde tienen algo, para que el mapa tenga más de
 * dos tonos.
 *
 * Una de cada tres clientas es nueva (un teléfono que no aparece en ninguna
 * historia) y las demás vuelven, para que el costo por clienta nueva y el "ya
 * recuperado" salgan con cifras creíbles contra la inversión de abajo.
 * Ninguna técnica tiene dos citas encimadas: con dos puestos, más que eso
 * dispararía el aviso de "físicamente imposible" de la ocupación.
 */
const SATURDAY_SLOTS: { provider: number; hour: string; service: number; price: number }[] = [
  { provider: 7, hour: "10:00", service: 5, price: 55_000 },
  { provider: 8, hour: "11:00", service: 3, price: 60_000 },
  { provider: 7, hour: "12:00", service: 3, price: 60_000 },
  { provider: 8, hour: "12:00", service: 5, price: 55_000 },
  { provider: 7, hour: "13:00", service: 5, price: 55_000 },
  { provider: 8, hour: "13:00", service: 3, price: 60_000 },
  { provider: 7, hour: "14:00", service: 5, price: 55_000 },
  { provider: 8, hour: "14:00", service: 5, price: 55_000 },
];

const RETURNING = ["+573001110001", "+573001110002", "+573001110005", "+573001110006"];

function demandRows(): Row[] {
  const rows: Row[] = [];
  let id = 200;
  let fresh = 0;

  const push = (day: string, slot: (typeof SATURDAY_SLOTS)[number], index: number) => {
    id += 1;
    // Una de cada tres es nueva; las otras, alguien que ya venía.
    const customer =
      index % 3 === 0
        ? `+5730022${String((fresh += 1)).padStart(5, "0")}`
        : RETURNING[index % RETURNING.length];
    rows.push({
      id,
      provider: slot.provider,
      day,
      hour: slot.hour,
      booked: slot.service,
      performed: slot.service,
      service: slot.price,
      charged: slot.price,
      method: index % 3 === 0 ? "transferencia" : "efectivo",
      customer,
    });
  };

  for (const day of ["01", "08", "15", "22", "29"]) {
    SATURDAY_SLOTS.forEach((slot, index) => push(day, slot, index));
  }

  // Jueves: una al final de la mañana, para que el más flojo sea el martes y no por
  // un empate.
  for (const [index, day] of ["06", "13", "27"].entries()) {
    push(day, { provider: 8, hour: "11:00", service: 3, price: 60_000 }, index + 1);
  }

  // Viernes: una o dos al final de la tarde.
  for (const [index, day] of ["07", "14", "21", "28"].entries()) {
    push(day, { provider: 7, hour: "17:00", service: 3, price: 60_000 }, index);
    if (index % 2 === 0) push(day, { provider: 8, hour: "16:00", service: 5, price: 55_000 }, index + 1);
  }

  return rows;
}

const ALL_ROWS: Row[] = [...MONTH, ...demandRows()];

function itemsOf(row: Row): FinanceItemRow[] {
  const items: FinanceItemRow[] = [
    {
      kind: "servicio",
      eaServiceId: row.performed,
      pricingId: null,
      qty: 1,
      unitPrice: row.service,
      lineTotal: row.service,
      note: null,
    },
  ];

  if (row.extras !== undefined && row.extras > 0) {
    items.push({
      kind: "adicional",
      eaServiceId: null,
      pricingId: "design",
      qty: 1,
      unitPrice: row.extras,
      lineTotal: row.extras,
      note: null,
    });
  }

  return items;
}

function financeOf(row: Row, month: string): FinanceRow {
  return {
    eaAppointmentId: row.id,
    eaProviderId: row.provider,
    secondaryEaProviderId: null,
    startAt: at(`${month}-${row.day} ${row.hour}:00`),
    bookedServiceId: row.booked,
    performedServiceId: row.charged === null ? null : row.performed,
    snapshot: row.service,
    snapshotSource: row.snapshotSource ?? "webhook",
    discount: 0,
    amountCharged: row.charged,
    tip: row.tip ?? 0,
    payments:
      row.payments ??
      (row.method === undefined || row.charged === null
        ? []
        : [{ method: row.method, amount: row.charged }]),
    varianceReasonCode: row.reason ?? null,
    closed: row.charged !== null,
    items: itemsOf(row),
  };
}

function appointmentOf(row: Row, month: string): AppointmentRow {
  const start = at(`${month}-${row.day} ${row.hour}:00`);
  const minutes = SERVICES.find((service) => service.id === row.performed)?.durationMin ?? 60;
  const [hours, mins] = row.hour.split(":").map(Number);
  const endMinutes = hours * 60 + mins + minutes;
  const end = at(
    `${month}-${row.day} ${String(Math.min(23, Math.floor(endMinutes / 60))).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}:00`,
  );

  return {
    id: row.id,
    start,
    end,
    status: row.status ?? "Completada",
    eaProviderId: row.provider,
    eaServiceId: row.performed,
    customerKey: row.customer ?? null,
    googleCalendarId: row.mirrored === false ? null : `evt-${row.id}`,
  };
}

const COMMISSION: CommissionEntryRow[] = [
  { eaProviderId: 7, baseAmount: 150_000, amount: 18_000, commissionRuleId: 3, status: "pending" },
  { eaProviderId: 7, baseAmount: 90_000, amount: 10_800, commissionRuleId: 3, status: "pending" },
  { eaProviderId: 7, baseAmount: 24_000, amount: 4_800, commissionRuleId: 4, status: "paid" },
  { eaProviderId: 8, baseAmount: 95_000, amount: 11_400, commissionRuleId: 3, status: "pending" },
  { eaProviderId: 8, baseAmount: 130_000, amount: 15_600, commissionRuleId: 3, status: "paid" },
  // Cero **marcado**: no había regla aplicable, y eso se cuenta y se avisa.
  { eaProviderId: 8, baseAmount: 40_000, amount: 0, commissionRuleId: null, status: "pending" },
];

/**
 * Visitas anteriores, para que el reporte de clientas tenga historia.
 *
 * Sin esto, cada clienta del mes contaría como nueva — que es exactamente el
 * error que `splitCustomers()` advierte que produce llamarla con solo las citas
 * de EA.
 */
function history(month: string): AppointmentRow[] {
  const previous: AppointmentRow[] = [
    "+573001110001",
    "+573001110002",
    "+573001110005",
  ].map((phone, index) => ({
    id: 900 + index,
    start: at("2026-05-14 10:00:00"),
    end: at("2026-05-14 12:00:00"),
    status: "Completada",
    eaProviderId: 7,
    eaServiceId: 1,
    customerKey: phone,
    googleCalendarId: "evt-old",
  }));

  // Una que volvió **después** del periodo: hace que la retención se pueda
  // medir para su cohorte en vez de quedar pendiente.
  previous.push({
    id: 950,
    start: at(`${month}-30 10:00:00`),
    end: at(`${month}-30 12:00:00`),
    status: "Completada",
    eaProviderId: 7,
    eaServiceId: 1,
    customerKey: "+573001110004",
    googleCalendarId: "evt-back",
  });

  return previous;
}

/**
 * Lo que traería `legacy_appointment` para el mes: los días antes del corte.
 * Pasa por `legacyReportRows()`, el mismo filtro que usa `data.ts`.
 */
function legacyRaw(month: string): LegacyRawRow[] {
  const row = (
    n: number,
    day: string,
    time: string,
    service: string,
    provider: string,
    amount: number | null,
    status: string,
  ): LegacyRawRow => ({
    sourceId: `AP-${month}-${n}`,
    start: at(`${month}-${day} ${time}:00`),
    serviceName: service,
    providerName: provider,
    amountCharged: amount,
    status,
    customerKey: `+57300222${String(n).padStart(4, "0")}`,
    clientName: `Cliente histórico ${n}`,
  });
  return [
    row(1, "01", "09:00", "Montaje con diseño completo", "Lina", 150_000, "Asiste"),
    row(2, "01", "11:00", "Semipermanente manos", "Kati", 55_000, "Asiste"),
    row(3, "02", "15:00", "Forrado", "Kati", 90_000, "Asiste"),
    row(4, "02", "16:30", "Press-on", "Lina", null, "Asiste"),
    row(5, "03", "10:00", "Combo manos y pies", "Kati", 95_000, "Asiste"),
    row(6, "03", "14:00", "Semipermanente manos", "Lina", null, "No Asiste"),
    row(7, "04", "09:30", "Forrado", "Kati", null, "Cancelado"),
    row(8, "04", "17:00", "Retoque express", "lina", 40_000, "Asiste"),
    row(9, "05", "18:00", "Semipermanente manos", "Kati", null, "Reservado"),
  ];
}

/**
 * El mes completo, en la forma exacta que `loadReports()` devuelve.
 *
 * `now` se elige **dentro** de la ventana de retención de algunas cohortes y
 * fuera de otras, para que el tile muestre las dos caras: una tasa medible y un
 * "todavía no se puede medir" con su explicación.
 */
export function previewData(cadence: Cadence, anchor: EaLocalDate): ReportData {
  const period = resolvePeriod({ cadencia: cadence, ancla: anchor }, anchor);
  const month = period.from.slice(0, 7);
  const days = eachDay(period.from, period.to);

  const inPeriod = ALL_ROWS.filter((row) => {
    const date = `${month}-${row.day}`;
    return date >= period.from && date <= period.to;
  });

  const previousMonth = resolvePeriod(
    { cadencia: cadence, ancla: parseEaLocalDate(`${month}-01`) },
    anchor,
  );

  const providerWindows = new Map(
    PROVIDERS.map((provider) => [provider.id, windowOverRange(days, PLAN, [])]),
  );

  const studioOpen = [...providerWindows.values()].flatMap((window) => window.open);
  const studioBreaks = [...providerWindows.values()].flatMap((window) => window.breaks);

  const now: EaLocalDateTime = at(`${month}-30 20:00:00`);

  return {
    period,
    days,
    providers: PROVIDERS,
    services: SERVICES,
    finance: inPeriod.map((row) => financeOf(row, month)),
    // El periodo anterior existe solo para el delta de los tiles: se usa la
    // mitad de las filas para que el delta no salga en cero.
    previousFinance: inPeriod
      .slice(0, Math.ceil(inPeriod.length / 2))
      .map((row) => financeOf(row, previousMonth.from.slice(0, 7))),
    appointments: inPeriod.map((row) => appointmentOf(row, month)),
    visitHistory: [...history(month), ...inPeriod.map((row) => appointmentOf(row, month))],
    legacyVisits: [
      {
        customerKey: "+573001110006",
        at: at("2025-11-02 10:00:00"),
        kind: "atendida",
        attended: true,
      },
    ],
    legacy: legacyReportRows(
      legacyRaw(month),
      { from: period.from, to: period.to },
      inPeriod.map((row) => appointmentOf(row, month)),
      PROVIDERS,
    ),
    // El mes anterior trae la mitad del historial: alcanza para que el delta
    // de ventas no salga en cero.
    previousLegacy: legacyReportRows(
      legacyRaw(previousMonth.from.slice(0, 7)).slice(0, 4),
      { from: previousMonth.from, to: previousMonth.to },
      [],
      PROVIDERS,
    ),
    commissionEntries: COMMISSION,
    // La pauta del mes: Meta casi toda, algo de Google. Con las nuevas del
    // mes da un costo por clienta y un "ya recuperado" con cifras creíbles.
    adSpend: [
      { month, channel: "meta", amountCop: 1_150_000 },
      { month, channel: "google", amountCop: 250_000 },
    ],
    stations: 2,
    studioWindow: { open: studioOpen, breaks: studioBreaks },
    providerWindows,
    blocks: {
      byProvider: new Map([
        [
          7,
          [
            {
              start: at(`${month}-06 09:00:00`),
              end: at(`${month}-06 13:00:00`),
            },
          ],
        ],
      ]),
      studio: [
        {
          start: at(`${month}-20 09:00:00`),
          end: at(`${month}-20 19:00:00`),
        },
      ],
    },
    now,
    problems: [],
  };
}
