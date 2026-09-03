import type {
  BasisPoints,
  CommissionEntry,
  CommissionEntryStatus,
  Cop,
  FinanceItemKind,
  NewCommissionEntry,
} from "../types";
import type { Db } from "./shared";

/**
 * La comisión de un renglón con el renglón y la cita pegados.
 *
 * Es lo que la pantalla de Comisiones necesita para el desglose: una fila de
 * `commission_entry` sola dice "3.200 pesos por el renglón 4109", que no le
 * sirve a nadie para revisar una quincena. El JOIN es dentro de `gbs_admin` y
 * hacia atrás —de la comisión al renglón a la cuenta— así que no cruza esquemas
 * ni depende de que EA responda.
 *
 * Lo que **no** trae es el nombre de la clienta ni el del servicio: eso vive en
 * `easyappointments`, se lee con otro usuario de MySQL y no hay JOIN posible.
 * La pantalla lo cruza en memoria por `ea_appointment_id` y por
 * `ea_service_id`, como hace Caja.
 */
export type CommissionEntryDetail = {
  entryId: number;
  eaProviderId: number;
  /** `null` = cero **marcado**: ninguna regla aplicó. */
  commissionRuleId: number | null;
  baseAmount: Cop;
  rateBp: BasisPoints | null;
  amount: Cop;
  status: CommissionEntryStatus;
  commissionRunId: number | null;
  periodStart: string;
  periodEnd: string;
  itemId: number;
  itemKind: FinanceItemKind;
  eaServiceId: number | null;
  pricingId: string | null;
  qty: number;
  note: string | null;
  financeId: number;
  eaAppointmentId: number;
  appointmentStartAt: Date | null;
};

/**
 * Las comisiones congeladas, renglón por renglón.
 */
export function commissionEntryRepository(db: Db) {
  return {
    async findByItemAndProvider(
      appointmentFinanceItemId: number,
      eaProviderId: number,
    ): Promise<CommissionEntry | undefined> {
      return db
        .selectFrom("commission_entry")
        .selectAll()
        .where("appointment_finance_item_id", "=", appointmentFinanceItemId)
        .where("ea_provider_id", "=", eaProviderId)
        .executeTakeFirst();
    },

    /**
     * Escribe o reescribe la comisión de un renglón para una técnica.
     *
     * Recalcular una quincena en borrador tiene que ser repetible: correr el
     * motor dos veces sobre el mismo periodo da el mismo resultado y no una
     * segunda tanda de entradas. Lo garantiza `uq_ce_item_provider`, que
     * incluye el provider porque un combo trabajado por dos técnicas reparte el
     * mismo renglón entre las dos.
     *
     * **Una entrada ya pagada no se reescribe**, y devuelve `"paid"` para que
     * el llamador lo pueda decir en voz alta en vez de creer que actualizó algo.
     * Nada se ajusta después de pagar: así se trabaja hoy y el sistema lo
     * respalda en vez de pelearlo.
     *
     * La guarda es una lectura previa y no un `WHERE` atómico. Deja una ventana
     * teórica entre leer y escribir, y se acepta porque la compuerta de verdad
     * está un nivel más arriba: `commissionRunRepository.setStatus()` rechaza
     * tocar una liquidación `pagada`, y una entrada llega a `paid` solo por esa
     * vía. Dos recálculos simultáneos del mismo periodo no son un escenario
     * real — es una persona apretando un botón.
     */
    async upsert(row: NewCommissionEntry): Promise<"inserted" | "updated" | "paid"> {
      const existing = await db
        .selectFrom("commission_entry")
        .select(["id", "status"])
        .where(
          "appointment_finance_item_id",
          "=",
          row.appointment_finance_item_id,
        )
        .where("ea_provider_id", "=", row.ea_provider_id)
        .executeTakeFirst();

      if (!existing) {
        await db.insertInto("commission_entry").values(row).execute();
        return "inserted";
      }
      if (existing.status === "paid") return "paid";

      await db
        .updateTable("commission_entry")
        .set({
          commission_rule_id: row.commission_rule_id,
          base_amount: row.base_amount,
          rate_bp: row.rate_bp,
          amount: row.amount,
          period_start: row.period_start,
          period_end: row.period_end,
        })
        .where("id", "=", existing.id)
        .execute();
      return "updated";
    },

    /** La liquidación de una técnica en un periodo. Extremos inclusivos. */
    async listByProviderAndPeriod(
      eaProviderId: number,
      periodStart: string,
      periodEnd: string,
    ): Promise<CommissionEntry[]> {
      return db
        .selectFrom("commission_entry")
        .selectAll()
        .where("ea_provider_id", "=", eaProviderId)
        .where("period_start", ">=", periodStart)
        .where("period_end", "<=", periodEnd)
        .orderBy("id")
        .execute();
    },

    /**
     * La quincena con el desglose que la pantalla dibuja.
     *
     * Extremos **inclusivos** y comparados como texto: `period_start` y
     * `period_end` son `DATE`, el driver los devuelve como `"YYYY-MM-DD"` y
     * ordenarlos como cadena ordena igual que como calendario. Sin `Date` de
     * por medio no hay forma de que la zona del proceso corra un corte de
     * quincena cinco horas.
     *
     * `eaProviderId` filtra para el caso de la técnica, que ve su liquidación y
     * la de nadie más. El filtro va en el `WHERE` y no en la pantalla: traer
     * las filas de todas y descartarlas al pintar es lo mismo que mandarlas al
     * navegador.
     */
    async listDetailedByPeriod(
      periodStart: string,
      periodEnd: string,
      opts: { eaProviderId?: number } = {},
    ): Promise<CommissionEntryDetail[]> {
      let q = db
        .selectFrom("commission_entry as ce")
        .innerJoin(
          "appointment_finance_item as afi",
          "afi.id",
          "ce.appointment_finance_item_id",
        )
        .innerJoin("appointment_finance as af", "af.id", "afi.appointment_finance_id")
        .select([
          "ce.id as entry_id",
          "ce.ea_provider_id",
          "ce.commission_rule_id",
          "ce.base_amount",
          "ce.rate_bp",
          "ce.amount",
          "ce.status",
          "ce.commission_run_id",
          "ce.period_start",
          "ce.period_end",
          "afi.id as item_id",
          "afi.kind as item_kind",
          "afi.ea_service_id",
          "afi.pricing_id",
          "afi.qty",
          "afi.note",
          "af.id as finance_id",
          "af.ea_appointment_id",
          "af.appointment_start_at",
        ])
        .where("ce.period_start", ">=", periodStart)
        .where("ce.period_end", "<=", periodEnd);

      if (opts.eaProviderId !== undefined) {
        q = q.where("ce.ea_provider_id", "=", opts.eaProviderId);
      }

      const rows = await q
        .orderBy("af.appointment_start_at")
        .orderBy("af.id")
        .orderBy("afi.id")
        .orderBy("ce.ea_provider_id")
        .execute();

      return rows.map((row) => ({
        entryId: row.entry_id,
        eaProviderId: row.ea_provider_id,
        commissionRuleId: row.commission_rule_id,
        baseAmount: row.base_amount,
        rateBp: row.rate_bp,
        amount: row.amount,
        status: row.status,
        commissionRunId: row.commission_run_id,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        itemId: row.item_id,
        itemKind: row.item_kind,
        eaServiceId: row.ea_service_id,
        pricingId: row.pricing_id,
        qty: row.qty,
        note: row.note,
        financeId: row.finance_id,
        eaAppointmentId: row.ea_appointment_id,
        appointmentStartAt: row.appointment_start_at,
      }));
    },

    /**
     * Cuentas cerradas del periodo que **no** tienen ni una comisión calculada.
     *
     * Es el otro lado de la liquidación: `runFortnight()` reporta las cuentas
     * que saltó, pero ese reporte vive en la respuesta de un botón y se pierde
     * al recargar. Esta consulta lo reconstruye desde la base, que es lo que
     * hace que una cuenta saltada siga visible mañana. Sin ella, una comisión
     * perdida y una quincena correcta se ven exactamente igual.
     *
     * Los extremos son **instantes** (`[desde, hasta)`), no fechas: la columna
     * es `DATETIME` y el periodo se convierte con `fortnightBounds()`, que
     * ancla la medianoche en Bogotá.
     */
    async listClosedWithoutCommission(
      from: Date,
      to: Date,
    ): Promise<
      Array<{
        financeId: number;
        eaAppointmentId: number;
        eaProviderId: number | null;
        appointmentStartAt: Date | null;
        amountCharged: Cop | null;
      }>
    > {
      const rows = await db
        .selectFrom("appointment_finance as af")
        .select([
          "af.id as finance_id",
          "af.ea_appointment_id",
          "af.ea_provider_id",
          "af.appointment_start_at",
          "af.amount_charged",
        ])
        .where("af.closed_at", "is not", null)
        .where("af.appointment_start_at", ">=", from)
        .where("af.appointment_start_at", "<", to)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("appointment_finance_item as afi")
                .innerJoin("commission_entry as ce", "ce.appointment_finance_item_id", "afi.id")
                .select("ce.id")
                .whereRef("afi.appointment_finance_id", "=", "af.id"),
            ),
          ),
        )
        .orderBy("af.appointment_start_at")
        .orderBy("af.id")
        .execute();

      return rows.map((row) => ({
        financeId: row.finance_id,
        eaAppointmentId: row.ea_appointment_id,
        eaProviderId: row.ea_provider_id,
        appointmentStartAt: row.appointment_start_at,
        amountCharged: row.amount_charged,
      }));
    },

    async listByRun(commissionRunId: number): Promise<CommissionEntry[]> {
      return db
        .selectFrom("commission_entry")
        .selectAll()
        .where("commission_run_id", "=", commissionRunId)
        .orderBy("id")
        .execute();
    },

    /**
     * Los renglones que quedaron **sin regla aplicable**.
     *
     * Cero marcado, no cero calculado: un cero silencioso es indistinguible de
     * un cero correcto, y esta consulta es la que hace que la marca se vea.
     * Sale en Diagnóstico y bloquea la revisión de la quincena.
     */
    async listUnmatchedInPeriod(
      periodStart: string,
      periodEnd: string,
    ): Promise<CommissionEntry[]> {
      return db
        .selectFrom("commission_entry")
        .selectAll()
        .where("commission_rule_id", "is", null)
        .where("period_start", ">=", periodStart)
        .where("period_end", "<=", periodEnd)
        .orderBy("id")
        .execute();
    },

    async attachToRun(ids: number[], commissionRunId: number): Promise<void> {
      if (ids.length === 0) return;
      await db
        .updateTable("commission_entry")
        .set({ commission_run_id: commissionRunId })
        .where("id", "in", ids)
        .execute();
    },

    /**
     * Borra entradas **pendientes**, por id.
     *
     * Es el único borrado de todo el esquema de plata, y existe por un caso
     * concreto: una cuenta que dejó de liquidar entre dos corridas de la misma
     * quincena en borrador —se corrompió, se reabrió, se le quitó la técnica—
     * deja una entrada vieja que seguiría sumando al total. Pagarle a alguien
     * por una cuenta que ya nadie puede explicar es peor que borrar un cálculo
     * que todavía no era plata.
     *
     * Lo que **no** borra es una entrada `paid`. El `WHERE` lo garantiza y no
     * la buena voluntad del llamador: después de pagar no se ajusta nada, y
     * una entrada pagada es el rastro de plata que salió del estudio.
     *
     * La cuenta detrás no desaparece de la vista: `runFortnight()` la reporta en
     * `skipped` con su motivo, y la pantalla la lista.
     */
    async deletePending(ids: number[]): Promise<void> {
      if (ids.length === 0) return;
      await db
        .deleteFrom("commission_entry")
        .where("id", "in", ids)
        .where("status", "=", "pending")
        .execute();
    },

    /** Marcar pagado es un efecto de pagar la liquidación, no un acto propio. */
    async markPaidByRun(commissionRunId: number): Promise<void> {
      await db
        .updateTable("commission_entry")
        .set({ status: "paid" })
        .where("commission_run_id", "=", commissionRunId)
        .execute();
    },

    /**
     * Suelta las entradas de una liquidación en borrador que se descarta.
     *
     * No las borra: la comisión calculada sobre un renglón sigue siendo cierta
     * aunque la liquidación se rehaga.
     */
    async detachFromRun(commissionRunId: number): Promise<void> {
      await db
        .updateTable("commission_entry")
        .set({ commission_run_id: null })
        .where("commission_run_id", "=", commissionRunId)
        .where("status", "=", "pending")
        .execute();
    },
  };
}

export type CommissionEntryRepository = ReturnType<
  typeof commissionEntryRepository
>;
