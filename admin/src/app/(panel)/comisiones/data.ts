import "server-only";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import type { Cop } from "@/db/types";
import {
  assessFortnight,
  fortnightBlockers,
  fortnightBounds,
  fortnightOf,
  shiftFortnight,
  type FortnightAssessment,
  type FortnightBlocker,
} from "@/jobs/commission-run";
import type { CommissionPeriod } from "@/lib/commission";
import { EaApiError, instantToEaDate, isEaLocalDate } from "@/lib/ea";
import { createEaClient } from "@/lib/ea/client";

import {
  buildSettlements,
  settlementsBase,
  settlementsTotal,
  type ProviderSettlement,
} from "./settlement";

/**
 * Los datos de **Comisiones**.
 *
 * La pantalla contesta una pregunta: *cuánto le pago a cada una el 15*. Todo lo
 * que hay acá existe para responder eso con una cifra que se pueda defender —
 * de dónde sale, sobre qué base, y qué falta revisar antes de pagarla.
 *
 * ## Ni un peso se calcula acá
 *
 * Las comisiones ya están congeladas en `commission_entry`: las calculó
 * `lib/commission.ts` y las escribió `jobs/commission-run.ts`. Este archivo lee
 * filas, le pide a EA los nombres, y agrupa con `settlement.ts`, que es puro y
 * testeado. Si un total apareciera sumado dentro de un `SELECT` o dentro de un
 * componente, estaría en el único lugar donde no se puede testear.
 *
 * ## EA es opcional, y eso es a propósito
 *
 * Los nombres de las técnicas y de los servicios viven en `easyappointments`,
 * que se lee por su API. Si no responde, la liquidación **se muestra igual**:
 * la plata está en `gbs_admin`, que sí contestó, y una pantalla de error
 * dejaría a la dueña sin poder pagar una quincena por un problema de nombres.
 * Lo que se pierde son las etiquetas, y la pantalla lo dice.
 */

export type ComisionesView = {
  period: CommissionPeriod;
  /** La quincena en la que cae hoy. Es a dónde vuelve el enlace "Esta quincena". */
  current: CommissionPeriod;
  previous: CommissionPeriod;
  /** `null` = la siguiente todavía no empezó, así que no hay a dónde ir. */
  next: CommissionPeriod | null;
  settlements: ProviderSettlement[];
  total: Cop;
  base: Cop;
  /**
   * Cuentas cerradas del periodo sin ninguna comisión calculada.
   *
   * Es lo que quedó por fuera, reconstruido desde la base y no desde la
   * respuesta del botón: al recargar la pantalla, una cuenta saltada tiene que
   * seguir estando a la vista.
   */
  pending: PendingAccount[];
  assessment: FortnightAssessment;
  /**
   * Por qué la quincena no se puede marcar como revisada todavía.
   *
   * Viajan como dato, no como frase: la frase la arma `blockers.ts` con el
   * formato de fecha de la interfaz.
   */
  blockers: FortnightBlocker[];
  /** `propia` = una técnica mirando su liquidación y la de nadie más. */
  scope: "todas" | "propia";
  /** `true` = puede recalcular, revisar y pagar. */
  canAdmin: boolean;
  /**
   * Una técnica sin `ea_provider_id` en la allowlist.
   *
   * Es una fila a medio configurar en Equipo, no un error del sistema, y la
   * respuesta honesta es decirlo: sin ese puente no hay forma de saber cuál de
   * las liquidaciones es la suya.
   */
  unlinked: boolean;
  /** `null` = EA respondió. Si no, el motivo, para decirlo en pantalla. */
  eaFailure: string | null;
};

/** La quincena de hoy, en el calendario del estudio. */
export function currentFortnight(now: Date = new Date()): CommissionPeriod {
  return fortnightOf(instantToEaDate(now));
}

/**
 * La quincena de la pantalla.
 *
 * Se acepta `?quincena=YYYY-MM-DD` con **cualquier** día de dentro del periodo,
 * no el corte exacto: así el enlace de "la quincena pasada" no depende de que
 * quien lo arme sepa dónde cae el corte. Una fecha inválida cae en la quincena
 * de hoy — un parámetro roto no puede dejar la pantalla en blanco.
 */
export function parseQuincena(
  raw: string | undefined,
  now: Date = new Date(),
): CommissionPeriod {
  return isEaLocalDate(raw) ? fortnightOf(raw) : currentFortnight(now);
}

function describeEaFailure(error: unknown): string {
  if (error instanceof EaApiError && error.isConfiguration) {
    return "El panel no puede autenticarse contra la agenda, así que las técnicas y los servicios salen por su id.";
  }
  return "La agenda no está respondiendo, así que las técnicas y los servicios salen por su id.";
}

/** Nombres de EA, o mapas vacíos y el motivo. */
async function loadNames(): Promise<{
  providers: Map<number, string>;
  services: Map<number, string>;
  failure: string | null;
}> {
  try {
    const ea = createEaClient();
    const [providers, services] = await Promise.all([
      ea.providers.list(),
      ea.services.list(),
    ]);

    return {
      providers: new Map(
        providers.map((provider) => [
          provider.id,
          [provider.firstName, provider.lastName].filter(Boolean).join(" ").trim() ||
            `Técnica #${provider.id}`,
        ]),
      ),
      services: new Map(
        services.map((service) => [service.id, service.name ?? `Servicio #${service.id}`]),
      ),
      failure: null,
    };
  } catch (error) {
    console.error("[comisiones] no se pudieron leer los nombres de EA", error);
    return { providers: new Map(), services: new Map(), failure: describeEaFailure(error) };
  }
}

export type PendingAccount = {
  eaAppointmentId: number;
  /** `null` = la fila no traía la fecha de la cita. */
  date: string | null;
  amountCharged: Cop | null;
  /** Nombre de la técnica, o su id si EA no respondió. */
  provider: string;
};

export type LoadComisionesInput = {
  quincena: string | undefined;
  /** `null` = ve todas (la dueña). Un id = ve solo la suya (la técnica). */
  onlyEaProviderId: number | null;
  scope: "todas" | "propia";
  canAdmin: boolean;
  unlinked?: boolean;
  now?: Date;
};

export async function loadComisionesView(
  input: LoadComisionesInput,
): Promise<ComisionesView> {
  const now = input.now ?? new Date();
  const period = parseQuincena(input.quincena, now);
  const current = currentFortnight(now);
  const db = getDb();
  const repos = repositories(db);

  // Una técnica sin provider no tiene liquidación que mirar, y el filtro por
  // `undefined` traería las de todas: la respuesta segura es no consultar.
  if (input.unlinked === true) {
    const assessment = await assessFortnight({ db }, { period, now });
    return {
      period,
      current,
      previous: shiftFortnight(period, -1),
      next: period.periodEnd >= current.periodEnd ? null : shiftFortnight(period, 1),
      settlements: [],
      total: 0,
      base: 0,
      pending: [],
      assessment,
      blockers: fortnightBlockers(assessment),
      scope: input.scope,
      canAdmin: false,
      unlinked: true,
      eaFailure: null,
    };
  }

  const scopeOpts =
    input.onlyEaProviderId === null ? {} : { eaProviderId: input.onlyEaProviderId };

  const [from, to] = fortnightBounds(period);

  const [entries, runs, sinComision, assessment, names] = await Promise.all([
    repos.commissionEntries.listDetailedByPeriod(
      period.periodStart,
      period.periodEnd,
      scopeOpts,
    ),
    repos.commissionRuns.listByPeriod(period.periodStart, period.periodEnd),
    repos.commissionEntries.listClosedWithoutCommission(from, to),
    assessFortnight({ db }, { period, now }),
    loadNames(),
  ]);

  const settlements = buildSettlements(
    entries,
    input.onlyEaProviderId === null
      ? runs
      : runs.filter((run) => run.ea_provider_id === input.onlyEaProviderId),
    { providers: names.providers, services: names.services },
  );

  return {
    period,
    current,
    previous: shiftFortnight(period, -1),
    // No se ofrece navegar a una quincena que todavía no empezó: no habría nada
    // que mirar y el botón invitaría a pensar que sí.
    next: period.periodEnd >= current.periodEnd ? null : shiftFortnight(period, 1),
    settlements,
    total: settlementsTotal(settlements),
    base: settlementsBase(settlements),
    pending: sinComision
      .filter(
        (row) =>
          input.onlyEaProviderId === null || row.eaProviderId === input.onlyEaProviderId,
      )
      .map((row) => ({
        eaAppointmentId: row.eaAppointmentId,
        date: row.appointmentStartAt === null ? null : instantToEaDate(row.appointmentStartAt),
        amountCharged: row.amountCharged,
        provider:
          row.eaProviderId === null
            ? "Sin técnica"
            : (names.providers.get(row.eaProviderId) ?? `Técnica #${row.eaProviderId}`),
      })),
    assessment,
    blockers: fortnightBlockers(assessment),
    scope: input.scope,
    canAdmin: input.canAdmin,
    unlinked: false,
    eaFailure: names.failure,
  };
}
