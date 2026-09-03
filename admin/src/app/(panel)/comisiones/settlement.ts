import type { CommissionEntryDetail } from "@/db/repositories/commission-entry";
import type {
  BasisPoints,
  CommissionRun,
  CommissionRunStatus,
  Cop,
  FinanceItemKind,
} from "@/db/types";

/**
 * De filas de `commission_entry` a lo que la pantalla dibuja.
 *
 * Vive acá y no en `lib/` porque `admin/src/lib/**` pertenece a otros paquetes
 * (A1 y B1) y este no puede escribir ahí. Es puro, sin React y sin base de
 * datos, así que mudarlo el día que la propiedad lo permita es un `git mv` — es
 * la misma nota que dejó `components/ui/format.ts`.
 *
 * **Nada se calcula acá que no sea una suma de enteros ya decididos.** Las
 * tasas las aplicó `lib/commission.ts` y quedaron congeladas en cada fila; esto
 * agrupa y suma. Que la suma esté en una función pura y testeada, en vez de
 * dentro del componente, es lo que hace que un total equivocado se vea en un
 * test rojo y no en una quincena mal pagada.
 */

/** Un renglón de la cuenta, con su comisión, listo para la tabla. */
export type SettlementLine = {
  itemId: number;
  kind: FinanceItemKind;
  /** Nombre del servicio, la nota del renglón manual, o un rótulo genérico. */
  label: string;
  qty: number;
  base: Cop;
  rateBp: BasisPoints | null;
  amount: Cop;
  /** `true` = ninguna regla aplicó: cero **marcado**. */
  flagged: boolean;
};

/** Una cita del periodo, con lo que aporta a la liquidación. */
export type SettlementAppointment = {
  eaAppointmentId: number;
  /** `YYYY-MM-DD` de la cita, o `null` si la fila no la tenía. */
  date: string | null;
  base: Cop;
  amount: Cop;
  flagged: boolean;
  lines: SettlementLine[];
};

/** La liquidación de una técnica en la quincena. */
export type ProviderSettlement = {
  eaProviderId: number;
  name: string;
  /** Lo que hay que pagarle: la suma de sus entradas del periodo. */
  amount: Cop;
  /** Sobre cuánto cobrado se calculó. */
  base: Cop;
  appointments: number;
  flagged: number;
  /** `null` = todavía no se ha liquidado la quincena de esta técnica. */
  status: CommissionRunStatus | null;
  runId: number | null;
  /** El total que quedó guardado en `commission_run`. */
  runTotal: Cop | null;
  /**
   * `true` = el total guardado no coincide con la suma de las entradas.
   *
   * Pasa cuando una cuenta cambió después de liquidar y todavía nadie
   * recalculó. La pantalla lo dice en vez de mostrar la cifra guardada como si
   * fuera la buena: las dos son ciertas y la diferencia es justo lo que hay que
   * resolver antes de pagar.
   */
  stale: boolean;
  detail: SettlementAppointment[];
};

export type SettlementNames = {
  /** `ea_provider_id` → nombre. Lo trae EA; vacío si no respondió. */
  providers: ReadonlyMap<number, string>;
  /** `ea_service_id` → nombre. Igual. */
  services: ReadonlyMap<number, string>;
};

const SIN_NOMBRE = "Técnica";

/**
 * Cómo se llama un renglón cuando EA no contestó.
 *
 * Un `#31` no le sirve a nadie para revisar una liquidación, pero es mejor que
 * dejar la celda vacía: dice que hay un renglón y con qué id buscarlo. Y el
 * renglón manual trae su propia nota, que es obligatoria justamente para esto.
 */
function labelFor(entry: CommissionEntryDetail, services: ReadonlyMap<number, string>): string {
  if (entry.itemKind === "manual") {
    const note = (entry.note ?? "").trim();
    return note === "" ? "Renglón manual" : note;
  }

  if (entry.eaServiceId !== null) {
    const name = services.get(entry.eaServiceId);
    if (name !== undefined) return name;
  }

  if (entry.pricingId !== null) return entry.pricingId;
  if (entry.itemKind === "adicional") return "Adicional";
  return entry.eaServiceId === null ? "Servicio" : `Servicio #${entry.eaServiceId}`;
}

/** `YYYY-MM-DD` de la cita, en el calendario que ya trae la fila. */
function dateOf(entry: CommissionEntryDetail): string | null {
  if (entry.appointmentStartAt === null) return null;
  // El `DATETIME` lo devuelve el driver en la zona del proceso, que en la VM es
  // America/Bogota (`TZ` del contenedor). Se corta con los getters locales por
  // eso mismo: `toISOString()` lo pasaría a UTC y una cita de las 8 p. m. del
  // día 15 aparecería en el 16.
  const at = entry.appointmentStartAt;
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * Las liquidaciones de la quincena, una por técnica.
 *
 * El orden es **por monto descendente**: la pregunta de la pantalla es "cuánto
 * le pago a cada una el 15", así que arriba va la cifra más grande y no el id
 * más bajo. A igual monto, por nombre, para que el orden no baile entre dos
 * recargas.
 *
 * Una técnica con liquidación guardada y sin entradas también aparece: su total
 * es cero y eso es información — significa que su quincena se liquidó y no
 * quedó nada que pagarle, que no es lo mismo que no haberla liquidado.
 */
export function buildSettlements(
  entries: readonly CommissionEntryDetail[],
  runs: readonly CommissionRun[],
  names: SettlementNames,
): ProviderSettlement[] {
  const byProvider = new Map<number, ProviderSettlement>();
  const appointments = new Map<string, SettlementAppointment>();

  function settlementFor(eaProviderId: number): ProviderSettlement {
    let settlement = byProvider.get(eaProviderId);
    if (settlement === undefined) {
      settlement = {
        eaProviderId,
        name: names.providers.get(eaProviderId) ?? `${SIN_NOMBRE} #${eaProviderId}`,
        amount: 0,
        base: 0,
        appointments: 0,
        flagged: 0,
        status: null,
        runId: null,
        runTotal: null,
        stale: false,
        detail: [],
      };
      byProvider.set(eaProviderId, settlement);
    }
    return settlement;
  }

  for (const entry of entries) {
    const settlement = settlementFor(entry.eaProviderId);
    const flagged = entry.commissionRuleId === null;

    settlement.amount += entry.amount;
    settlement.base += entry.baseAmount;
    if (flagged) settlement.flagged += 1;

    const key = `${entry.eaProviderId}:${entry.eaAppointmentId}`;
    let appointment = appointments.get(key);
    if (appointment === undefined) {
      appointment = {
        eaAppointmentId: entry.eaAppointmentId,
        date: dateOf(entry),
        base: 0,
        amount: 0,
        flagged: false,
        lines: [],
      };
      appointments.set(key, appointment);
      settlement.detail.push(appointment);
      settlement.appointments += 1;
    }

    appointment.base += entry.baseAmount;
    appointment.amount += entry.amount;
    appointment.flagged = appointment.flagged || flagged;
    appointment.lines.push({
      itemId: entry.itemId,
      kind: entry.itemKind,
      label: labelFor(entry, names.services),
      qty: entry.qty,
      base: entry.baseAmount,
      rateBp: entry.rateBp,
      amount: entry.amount,
      flagged,
    });
  }

  for (const run of runs) {
    const settlement = settlementFor(run.ea_provider_id);
    settlement.status = run.status;
    settlement.runId = run.id;
    settlement.runTotal = run.total;
    settlement.stale = run.total !== settlement.amount;
  }

  return [...byProvider.values()].sort(
    (a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "es-CO"),
  );
}

/** El total de la quincena: lo que sale del estudio en comisiones. */
export function settlementsTotal(settlements: readonly ProviderSettlement[]): Cop {
  let total = 0;
  for (const settlement of settlements) total += settlement.amount;
  return total;
}

/** La base sobre la que se calculó todo: lo cobrado que sí comisiona. */
export function settlementsBase(settlements: readonly ProviderSettlement[]): Cop {
  let base = 0;
  for (const settlement of settlements) base += settlement.base;
  return base;
}
