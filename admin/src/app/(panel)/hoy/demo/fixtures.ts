import type { TicketCatalog } from "@/components/ticket";
import type { TodayAppointment } from "@/components/ticket";

/**
 * Datos de mentira para revisar "Cerrar servicio" sin EA ni MySQL.
 *
 * Los precios y los ids de vitrina son los reales de `src/data/pricing.ts`, y
 * el caso que arma la primera cita es el de la Definition of Done del paquete:
 * **agendado `press-on`, cerrado como forrado + 3 diseños, con motivo.**
 */

const HOY = new Date();
const DIA = [
  HOY.getFullYear(),
  String(HOY.getMonth() + 1).padStart(2, "0"),
  String(HOY.getDate()).padStart(2, "0"),
].join("-");

function hora(hhmm: string): string {
  return `${DIA} ${hhmm}:00`;
}

export const CATALOGO_DEMO: TicketCatalog = {
  services: [
    // Montajes
    s(1, "Polygel esculpida", 120_000, 150, 1, "Montajes", "polygel-sculpted"),
    s(2, "Acrílico esculpida", 115_000, 150, 1, "Montajes", "acrylic-sculpted"),
    s(3, "Polygel dual", 110_000, 150, 1, "Montajes", "polygel-dual"),
    s(4, "Builder gel dual", 105_000, 150, 1, "Montajes", "builder-gel-dual"),
    s(5, "Press-on", 100_000, 105, 1, "Montajes", "press-on"),
    // Retoques
    s(6, "Retoque de polygel", 90_000, 120, 2, "Retoques", "polygel-refill"),
    s(7, "Retoque de builder gel", 85_000, 120, 2, "Retoques", "builder-gel-refill"),
    s(8, "Retoque de acrílico", 80_000, 120, 2, "Retoques", "acrylic-refill"),
    // Forrados
    s(9, "Forrado en polygel", 95_000, 90, 3, "Forrados", "polygel-overlay"),
    s(10, "Forrado en builder gel", 90_000, 90, 3, "Forrados", "builder-gel-overlay"),
    s(11, "Forrado en acrílico", 85_000, 90, 3, "Forrados", "acrylic-overlay"),
    s(12, "Dipping", 80_000, 90, 3, "Forrados", "dipping"),
    // Sencillos
    s(13, "Semipermanente manos", 50_000, 60, 4, "Sencillos", "semi-permanent-hands"),
    s(14, "Semipermanente pies", 55_000, 75, 4, "Sencillos", "semi-permanent-feet"),
    s(15, "Tradicional manos", 30_000, 60, 4, "Sencillos", "traditional-hands"),
    // Extras
    x(20, "Diseño por uña", 10_000, null, "design-per-nail"),
    x(21, "Retiro de sistema", 20_000, 30, "system-removal"),
    x(22, "Uña press-on suelta", 10_000, 5, "single-press-on-nail"),
    x(23, "Limpieza profunda de pies", 15_000, 10, "in-depth-foot-cleaning"),
    x(24, "Uña dual suelta", 11_000, 10, "single-dual-system-nail"),
    x(25, "Aromaterapia", 8_000, 10, null),
  ],
};

function s(
  eaServiceId: number,
  name: string,
  listPrice: number,
  durationMin: number | null,
  categoryId: number,
  categoryName: string,
  pricingId: string | null,
) {
  return {
    eaServiceId,
    name,
    listPrice,
    durationMin,
    categoryId,
    categoryName,
    pricingId,
    isExtra: false,
  };
}

function x(
  eaServiceId: number,
  name: string,
  listPrice: number,
  durationMin: number | null,
  pricingId: string | null,
) {
  return {
    eaServiceId,
    name,
    listPrice,
    durationMin,
    categoryId: 9,
    categoryName: "Extras",
    pricingId,
    isExtra: true,
  };
}

const SIN_CUENTA = {
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
} as const;

export const CITAS_DEMO: TodayAppointment[] = [
  {
    eaAppointmentId: 4101,
    start: hora("09:00"),
    end: hora("10:45"),
    status: "Confirmada",
    customerName: "Marcela Ríos",
    customerPhone: "+573001234567",
    eaProviderId: 3,
    providerName: "Lina",
    bookedServiceId: 5,
    bookedServiceName: "Press-on",
    // La cita ya tiene su precio congelado desde el webhook: 100.000.
    finance: { ...SIN_CUENTA, snapshot: 100_000, snapshotSource: "webhook" },
  },
  {
    eaAppointmentId: 4102,
    start: hora("11:00"),
    end: hora("12:00"),
    status: "Completada",
    customerName: "Daniela Pérez",
    customerPhone: "+573009876543",
    eaProviderId: 3,
    providerName: "Lina",
    bookedServiceId: 13,
    bookedServiceName: "Semipermanente manos",
    finance: {
      ...SIN_CUENTA,
      financeId: 91,
      performedServiceId: 13,
      amountCharged: 50_000,
      paymentMethod: "efectivo",
      tip: 5_000,
      closedAt: hora("12:05"),
      snapshot: 50_000,
      snapshotSource: "webhook",
      items: [
        { kind: "servicio", eaServiceId: 13, qty: 1, unitPrice: 50_000, note: null },
      ],
    },
  },
  {
    eaAppointmentId: 4103,
    start: hora("14:00"),
    end: hora("15:30"),
    status: "Reservada",
    customerName: "Ana María Gómez de la Espriella",
    customerPhone: null,
    eaProviderId: 4,
    providerName: "Marcela",
    bookedServiceId: 11,
    bookedServiceName: "Forrado en acrílico",
    finance: { ...SIN_CUENTA, snapshot: 85_000, snapshotSource: "reconcile" },
  },
  {
    eaAppointmentId: 4104,
    start: hora("16:00"),
    end: hora("16:45"),
    status: "No asistió",
    customerName: "Sara Vélez",
    customerPhone: "+573015550101",
    eaProviderId: 4,
    providerName: "Marcela",
    bookedServiceId: 15,
    bookedServiceName: "Tradicional manos",
    finance: { ...SIN_CUENTA, snapshot: 30_000, snapshotSource: "webhook" },
  },
];
