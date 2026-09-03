import { sql, type Kysely } from "kysely";
import type { Pool } from "mysql2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDb,
  createPool,
  MIGRATIONS,
  repositories,
  runMigrations,
  PaidCommissionRunError,
  type Database,
} from "@/db";
import type { AuthId, Cop } from "@/db/types";
import {
  canRunDbTests,
  skipReason,
  startEphemeralMysql,
  type EphemeralMysql,
} from "@/db/testing/ephemeral-mysql";
import {
  eaLocalToInstant,
  parseEaLocalDateTime,
  type EaLocalDateTime,
} from "@/lib/ea";

import {
  assessFortnight,
  fortnightBlockers,
  fortnightBounds,
  fortnightDays,
  fortnightOf,
  markFortnightPaid,
  markFortnightReviewed,
  runFortnight,
} from "./commission-run";

/**
 * Capa 2 de D1: la liquidación de la quincena contra un **MySQL real**.
 *
 * Lo que se verifica acá no lo decide el código, lo decide la base, y con plata
 * de por medio la diferencia no es académica:
 *
 * - **La siembra de la regla.** Que la migración `018` deje **una** fila al 40 %
 *   y que corriendo las migraciones dos veces siga habiendo una. Un
 *   `ON DUPLICATE KEY` sin llave con la que chocar habría sembrado dos, y la
 *   segunda regla empatada en especificidad marcaría cada renglón de cada
 *   quincena como ambiguo.
 * - **La idempotencia.** `uq_ce_item_provider` y `uq_run_provider_period` son
 *   lo que hace que liquidar dos veces la misma quincena no pague el doble. Sin
 *   un MySQL de verdad, "no duplica" sería una afirmación sobre un `if`.
 * - **La inmutabilidad de lo pagado.** Que después de marcar la quincena como
 *   pagada, recalcularla **no reescriba un solo peso** — ni en las entradas ni
 *   en el total de la liquidación.
 *
 * El caso de referencia es el mismo de `commission-run.test.ts` (dos técnicas,
 * un combo a cuatro manos, un descuento con residuo), con los montos calculados
 * a mano: Lina 227.600 y Sara 40.000.
 */

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;

const OWNER_ID: AuthId = "usr_owner_0000000000000000000000";
const LINA = 3;
const SARA = 7;
const COMBO_SERVICE = 42;
const EXTRA_SERVICE = 31;

const QUINCENA = fortnightOf("2026-09-08");
/** Después del último día del periodo: la quincena ya cerró. */
const DESPUES = eaLocalToInstant(parseEaLocalDateTime("2026-09-16 10:00:00"));

function dt(value: string): EaLocalDateTime {
  return parseEaLocalDateTime(value);
}

type RenglonSeed = {
  kind: "servicio" | "adicional" | "manual";
  eaServiceId: number | null;
  qty?: number;
  unitPrice: Cop;
  note?: string | null;
};

describe.skipIf(!canRunDbTests())(
  `liquidación de comisiones contra MySQL real${skipReason() ? ` (saltado: ${skipReason()})` : ""}`,
  () => {
    let container: EphemeralMysql;
    let pool: Pool;
    let db: Kysely<Database>;

    beforeAll(async () => {
      container = await startEphemeralMysql();
      pool = createPool(container.url);
      db = createDb(pool);
      await runMigrations(db);
    }, HOOK_TIMEOUT);

    afterAll(async () => {
      await db?.destroy();
      await container?.stop();
    }, HOOK_TIMEOUT);

    beforeEach(async () => {
      await limpiar(db);
      await sembrarDuena(db);
    }, TEST_TIMEOUT);

    // ── La regla sembrada ──────────────────────────────────────────────────

    describe("la regla que rige hoy", () => {
      it(
        "queda sembrada una sola vez, al 40 % y en puntos básicos",
        async () => {
          const reglas = await repositories(db).commissionRules.listAll();
          expect(reglas).toHaveLength(1);
          expect(reglas[0]).toMatchObject({
            ea_provider_id: null,
            category_id: null,
            ea_service_id: null,
            applies_to: "ambos",
            kind: "percent",
            // 4000 bp = 40 %. Ni `40` ni `0.4`.
            percent_bp: 4000,
            fixed_amount: null,
            valid_to: null,
          });
          // La vigencia empieza antes de que el panel exista: el 40 % es cómo
          // se paga desde antes, y una vigencia que arrancara el día del
          // despliegue habría dejado la primera quincena marcada y en cero.
          expect(reglas[0].valid_from <= "2026-09-01").toBe(true);
        },
        TEST_TIMEOUT,
      );

      it(
        "no se duplica al aplicarse de nuevo",
        async () => {
          await runMigrations(db);
          // Y aunque el libro de migraciones se hubiera perdido y la siembra
          // se volviera a aplicar: la sentencia es condicional, no un INSERT.
          await correrSiembra(db);
          await correrSiembra(db);
          expect(await repositories(db).commissionRules.listAll()).toHaveLength(1);
        },
        TEST_TIMEOUT,
      );

      it(
        "no resucita si la dueña la cerró y puso otra tasa",
        async () => {
          const repos = repositories(db);
          const [global] = await repos.commissionRules.listAll();
          await repos.commissionRules.closeAt(global.id, "2026-09-30");
          await repos.commissionRules.insert({
            ea_provider_id: null,
            category_id: null,
            ea_service_id: null,
            applies_to: "ambos",
            kind: "percent",
            percent_bp: 4500,
            valid_from: "2026-10-01",
          });

          await correrSiembra(db);

          const reglas = await repos.commissionRules.listAll();
          expect(reglas).toHaveLength(2);
          expect(reglas.map((regla) => regla.percent_bp).sort()).toEqual([4000, 4500]);
        },
        TEST_TIMEOUT,
      );
    });

    // ── La corrida ─────────────────────────────────────────────────────────

    describe("liquidar la quincena", () => {
      beforeEach(async () => {
        await sembrarQuincenaDeReferencia(db);
      }, TEST_TIMEOUT);

      it(
        "escribe una entrada por renglón y una liquidación por técnica",
        async () => {
          const result = await runFortnight(
            { db },
            { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES },
          );

          expect(result.written).toEqual({
            inserted: 8,
            updated: 0,
            frozen: 0,
            dropped: 0,
          });
          // La cuenta sin cerrar del día 12 no produce nada, y se dice.
          expect(result.skipped.map((s) => s.reason)).toEqual(["sin-cerrar"]);
          // El renglón manual del retoque de garantía queda marcado.
          expect(result.flagged).toBe(1);

          expect(result.runs).toEqual([
            {
              eaProviderId: LINA,
              runId: expect.any(Number),
              total: 227_600,
              status: "borrador",
              created: true,
              recalculated: true,
            },
            {
              eaProviderId: SARA,
              runId: expect.any(Number),
              total: 40_000,
              status: "borrador",
              created: true,
              recalculated: true,
            },
          ]);

          // Y el total de la liquidación es la suma de sus entradas, no una
          // cifra aparte que pueda irse por su lado.
          const repos = repositories(db);
          for (const row of result.runs) {
            const entradas = await repos.commissionEntries.listByRun(row.runId);
            expect(entradas.reduce((sum, e) => sum + e.amount, 0)).toBe(row.total);
            expect(entradas.every((e) => e.commission_run_id === row.runId)).toBe(true);
          }
        },
        TEST_TIMEOUT,
      );

      it(
        "congela la tasa y la base en cada entrada",
        async () => {
          await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES });

          const entradas = await repositories(db).commissionEntries.listDetailedByPeriod(
            QUINCENA.periodStart,
            QUINCENA.periodEnd,
          );

          // El renglón del combo, repartido 60/40 entre las dos técnicas.
          const combo = entradas.filter((e) => e.eaServiceId === COMBO_SERVICE);
          expect(combo).toHaveLength(2);
          expect(combo.map((e) => [e.eaProviderId, e.baseAmount, e.amount])).toEqual([
            [LINA, 150_000, 60_000],
            [SARA, 100_000, 40_000],
          ]);
          expect(combo.every((e) => e.rateBp === 4000)).toBe(true);

          // El manual: cero **marcado**, sin regla. Es lo que la base puede
          // distinguir de un cero correcto.
          const manual = entradas.filter((e) => e.itemKind === "manual");
          expect(manual).toHaveLength(1);
          expect(manual[0]).toMatchObject({ amount: 0, commissionRuleId: null, rateBp: null });
        },
        TEST_TIMEOUT,
      );

      it(
        "corrida dos veces no duplica ni una fila ni un peso",
        async () => {
          const primera = await runFortnight(
            { db },
            { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES },
          );
          const segunda = await runFortnight(
            { db },
            { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES },
          );

          expect(segunda.written).toEqual({
            inserted: 0,
            updated: 8,
            frozen: 0,
            dropped: 0,
          });
          expect(segunda.runs.map((r) => [r.total, r.created])).toEqual([
            [227_600, false],
            [40_000, false],
          ]);
          expect(segunda.runs.map((r) => r.runId)).toEqual(primera.runs.map((r) => r.runId));

          expect(await contar(db, "commission_entry")).toBe(8);
          expect(await contar(db, "commission_run")).toBe(2);
        },
        TEST_TIMEOUT,
      );

      it(
        "recalcula el borrador cuando la cuenta cambió, sin dejar la entrada vieja",
        async () => {
          await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES });

          // Una corrección posterior entra como renglón nuevo —que puede
          // restar— y nunca como edición en sitio.
          const repos = repositories(db);
          const cuenta = await repos.appointmentFinance.findByEaAppointmentId(5001);
          if (!cuenta) throw new Error("falta la cuenta A");
          await repos.appointmentFinanceItems.insertMany([
            {
              appointment_finance_id: cuenta.id,
              kind: "adicional",
              ea_service_id: EXTRA_SERVICE,
              pricing_id: null,
              qty: 1,
              unit_price_snapshot: -24_000,
              line_total: -24_000,
              note: null,
            },
          ]);
          await repos.appointmentFinance.update(cuenta.id, { amount_charged: 180_000 });

          const result = await runFortnight(
            { db },
            { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES },
          );

          // 24.000 devueltos ⇒ 9.600 de comisión que se deshacen. Lina baja de
          // 227.600 a 218.000, y la corrección cancela exacto: la comisión del
          // renglón que resta es −9.600, no cero.
          expect(result.runs[0]).toMatchObject({ eaProviderId: LINA, total: 218_000 });
          expect(result.written).toMatchObject({ inserted: 1, updated: 8, dropped: 0 });
          expect(await contar(db, "commission_entry")).toBe(9);
        },
        TEST_TIMEOUT,
      );

      it(
        "deja la bitácora de quién liquidó",
        async () => {
          await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES });
          const bitacora = await repositories(db).auditLog.listForEntity(
            "commission_run",
            `${QUINCENA.periodStart}/${QUINCENA.periodEnd}`,
          );
          expect(bitacora).toHaveLength(1);
          expect(bitacora[0]).toMatchObject({
            action: "commission.run",
            actor_user_id: OWNER_ID,
          });
        },
        TEST_TIMEOUT,
      );
    });

    // ── La compuerta y el pago ─────────────────────────────────────────────

    describe("revisar y pagar", () => {
      beforeEach(async () => {
        await sembrarQuincenaDeReferencia(db);
      }, TEST_TIMEOUT);

      it(
        "no deja revisar mientras falten cierres de caja o queden renglones marcados",
        async () => {
          await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES });

          const sinCierres = await markFortnightReviewed(
            { db },
            { period: QUINCENA, eaProviderId: LINA, actorUserId: OWNER_ID, now: DESPUES },
          );
          expect(sinCierres.ok).toBe(false);
          if (sinCierres.ok) throw new Error("no debería haber revisado");
          expect(sinCierres.reason).toBe("compuerta");
          // Quince días sin cierre y un renglón sin regla: los dos motivos.
          expect(sinCierres.blockers).toHaveLength(2);

          // Con los quince días cerrados sigue faltando el renglón marcado: la
          // marca del retoque de garantía es un bloqueo, no un adorno.
          await cerrarTodosLosDias(db);
          const conMarca = await markFortnightReviewed(
            { db },
            { period: QUINCENA, eaProviderId: LINA, actorUserId: OWNER_ID, now: DESPUES },
          );
          expect(conMarca.ok).toBe(false);
          if (conMarca.ok) throw new Error("no debería haber revisado");
          expect(conMarca.blockers).toEqual([{ kind: "sin-regla", count: 1 }]);
        },
        TEST_TIMEOUT,
      );

      it(
        "no deja pagar desde borrador",
        async () => {
          await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES });
          const result = await markFortnightPaid(
            { db },
            { period: QUINCENA, eaProviderId: LINA, actorUserId: OWNER_ID, now: DESPUES },
          );
          expect(result).toMatchObject({ ok: false, reason: "sin-revisar" });

          const run = await repositories(db).commissionRuns.findByProviderAndPeriod(
            LINA,
            QUINCENA.periodStart,
            QUINCENA.periodEnd,
          );
          expect(run?.status).toBe("borrador");
        },
        TEST_TIMEOUT,
      );

      it(
        "no deja pagar ni revisar una quincena que todavía no terminó",
        async () => {
          const enCurso = eaLocalToInstant(dt("2026-09-10 18:00:00"));
          await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: enCurso });
          const assessment = await assessFortnight({ db }, { period: QUINCENA, now: enCurso });

          expect(assessment.open).toBe(true);
          // Los días que todavía no llegaron no cuentan como faltantes: hasta
          // el 9 hay nueve días pasados, y solo ésos pueden tener cierre.
          expect(assessment.missingDayCloses).toEqual(fortnightDays(QUINCENA).slice(0, 9));
          expect(fortnightBlockers(assessment)[0]).toEqual({
            kind: "en-curso",
            until: "2026-09-15",
          });
        },
        TEST_TIMEOUT,
      );

      it(
        "paga, congela las entradas y deja de recalcular",
        async () => {
          await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES });
          await cerrarTodosLosDias(db);

          // Sara es la que tiene el renglón marcado; Lina no. Se revisa la de
          // Lina, que es la que se paga en este test.
          const repos = repositories(db);
          const marcada = await repos.commissionEntries.listUnmatchedInPeriod(
            QUINCENA.periodStart,
            QUINCENA.periodEnd,
          );
          expect(marcada.every((entry) => entry.ea_provider_id === SARA)).toBe(true);
          // Se resuelve como se resolvería de verdad: la dueña convierte el
          // retoque en un renglón del catálogo. Acá se simula borrando la
          // marca — lo que importa del test es lo que pasa después de pagar.
          await db
            .updateTable("commission_entry")
            .set({ commission_rule_id: 1 })
            .where("commission_rule_id", "is", null)
            .execute();

          const revisada = await markFortnightReviewed(
            { db },
            { period: QUINCENA, eaProviderId: LINA, actorUserId: OWNER_ID, now: DESPUES },
          );
          expect(revisada).toMatchObject({ ok: true, already: false });

          const pagada = await markFortnightPaid(
            { db },
            { period: QUINCENA, eaProviderId: LINA, actorUserId: OWNER_ID, now: DESPUES },
          );
          expect(pagada).toMatchObject({ ok: true, already: false });

          const run = await repos.commissionRuns.findByProviderAndPeriod(
            LINA,
            QUINCENA.periodStart,
            QUINCENA.periodEnd,
          );
          expect(run).toMatchObject({ status: "pagada", total: 227_600 });
          expect(run?.paid_by).toBe(OWNER_ID);
          expect(run?.paid_at).toBeInstanceOf(Date);
          expect(run?.reviewed_by).toBe(OWNER_ID);

          const entradas = await repos.commissionEntries.listByRun(run!.id);
          expect(entradas.every((entry) => entry.status === "paid")).toBe(true);

          // **Lo pagado no se reescribe.** Ni aunque la cuenta cambie después.
          const cuenta = await repos.appointmentFinance.findByEaAppointmentId(5001);
          await repos.appointmentFinanceItems.insertMany([
            {
              appointment_finance_id: cuenta!.id,
              kind: "adicional",
              ea_service_id: EXTRA_SERVICE,
              pricing_id: null,
              qty: 1,
              unit_price_snapshot: -24_000,
              line_total: -24_000,
              note: null,
            },
          ]);
          await repos.appointmentFinance.update(cuenta!.id, { amount_charged: 180_000 });

          const recalculo = await runFortnight(
            { db },
            { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES },
          );

          // Las seis entradas de Lina ya pagadas, más la que la corrección
          // habría creado: la quincena pagada es de solo lectura entera, no
          // renglón por renglón. Solo las dos de Sara, que sigue en borrador,
          // se recalculan.
          expect(recalculo.written).toEqual({
            inserted: 0,
            updated: 2,
            frozen: 7,
            dropped: 0,
          });
          expect(recalculo.runs[0]).toMatchObject({
            eaProviderId: LINA,
            total: 227_600,
            status: "pagada",
            recalculated: false,
          });

          const entradasDespues = await repos.commissionEntries.listByRun(run!.id);
          expect(entradasDespues.reduce((sum, e) => sum + e.amount, 0)).toBe(227_600);
          // Y la corrección no dejó una entrada suelta que ninguna liquidación
          // pueda recoger: en una quincena pagada no se escribe nada.
          expect(await contar(db, "commission_entry")).toBe(8);
        },
        TEST_TIMEOUT,
      );

      it(
        "y una liquidación pagada rechaza cualquier cambio de estado",
        async () => {
          await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES });
          const repos = repositories(db);
          const run = await repos.commissionRuns.findByProviderAndPeriod(
            SARA,
            QUINCENA.periodStart,
            QUINCENA.periodEnd,
          );
          await repos.commissionRuns.setStatus(run!.id, "revisada", {
            userId: OWNER_ID,
            at: DESPUES,
          });
          await repos.commissionRuns.setStatus(run!.id, "pagada", {
            userId: OWNER_ID,
            at: DESPUES,
          });

          await expect(
            repos.commissionRuns.setStatus(run!.id, "borrador", {
              userId: OWNER_ID,
              at: DESPUES,
            }),
          ).rejects.toBeInstanceOf(PaidCommissionRunError);

          expect(
            await markFortnightReviewed(
              { db },
              { period: QUINCENA, eaProviderId: SARA, actorUserId: OWNER_ID, now: DESPUES },
            ),
          ).toMatchObject({ ok: false, reason: "pagada" });

          // Pagar de nuevo no falla, pero tampoco vuelve a hacer nada.
          expect(
            await markFortnightPaid(
              { db },
              { period: QUINCENA, eaProviderId: SARA, actorUserId: OWNER_ID, now: DESPUES },
            ),
          ).toMatchObject({ ok: true, already: true });
        },
        TEST_TIMEOUT,
      );

      it(
        "sin liquidación no hay nada que revisar ni que pagar",
        async () => {
          // Sin `now`: las cuatro funciones lo toman del reloj cuando no se lo
          // pasan, que es como corren de verdad detrás de un botón. El resto
          // de los tests fija el instante para poder afirmar sobre fechas.
          expect(
            await markFortnightReviewed(
              { db },
              { period: QUINCENA, eaProviderId: LINA, actorUserId: OWNER_ID },
            ),
          ).toMatchObject({ ok: false, reason: "sin-liquidacion" });
          expect(
            await markFortnightPaid(
              { db },
              { period: QUINCENA, eaProviderId: LINA, actorUserId: OWNER_ID },
            ),
          ).toMatchObject({ ok: false, reason: "sin-liquidacion" });
        },
        TEST_TIMEOUT,
      );

      it(
        "revisar dos veces es idempotente",
        async () => {
          await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES });
          await cerrarTodosLosDias(db);
          await db
            .updateTable("commission_entry")
            .set({ commission_rule_id: 1 })
            .where("commission_rule_id", "is", null)
            .execute();

          await markFortnightReviewed(
            { db },
            { period: QUINCENA, eaProviderId: LINA, actorUserId: OWNER_ID, now: DESPUES },
          );
          expect(
            await markFortnightReviewed(
              { db },
              { period: QUINCENA, eaProviderId: LINA, actorUserId: OWNER_ID, now: DESPUES },
            ),
          ).toMatchObject({ ok: true, already: true });
        },
        TEST_TIMEOUT,
      );
    });

    // ── El repositorio de entradas ─────────────────────────────────────────

    describe("las consultas de la pantalla", () => {
      beforeEach(async () => {
        await sembrarQuincenaDeReferencia(db);
        await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES });
      }, TEST_TIMEOUT);

      it(
        "el desglose se puede pedir de una sola técnica",
        async () => {
          // Es lo que ve una técnica: su liquidación y la de nadie más. El
          // filtro va en el `WHERE` y no en la pantalla — traer las filas de
          // todas y descartarlas al pintar es lo mismo que mandarlas al
          // navegador.
          const repos = repositories(db);
          const todas = await repos.commissionEntries.listDetailedByPeriod(
            QUINCENA.periodStart,
            QUINCENA.periodEnd,
          );
          const suyas = await repos.commissionEntries.listDetailedByPeriod(
            QUINCENA.periodStart,
            QUINCENA.periodEnd,
            { eaProviderId: SARA },
          );

          expect(todas).toHaveLength(8);
          expect(suyas).toHaveLength(2);
          expect(suyas.every((entry) => entry.eaProviderId === SARA)).toBe(true);
          // Y trae pegada la cita, que es lo que hace revisable el desglose.
          expect(suyas.map((entry) => entry.eaAppointmentId).sort()).toEqual([5003, 5004]);
          expect(suyas[0].appointmentStartAt).toBeInstanceOf(Date);
        },
        TEST_TIMEOUT,
      );

      it(
        "lista las cuentas cerradas que no produjeron comisión",
        async () => {
          // Una cuenta saltada en silencio es igual a una comisión perdida: el
          // reporte del botón se pierde al recargar, esta consulta no.
          const repos = repositories(db);
          const [from, to] = fortnightBounds(QUINCENA);

          // Con todo liquidado no debería quedar ninguna: la única cuenta
          // saltada del fixture es la que no está cerrada, y ésa no cuenta.
          expect(
            await repos.commissionEntries.listClosedWithoutCommission(from, to),
          ).toEqual([]);

          // Se rompe una cuenta y se vuelve a liquidar: su entrada se borra y
          // la cuenta aparece acá.
          const cuenta = await repos.appointmentFinance.findByEaAppointmentId(5002);
          await repos.appointmentFinance.update(cuenta!.id, { amount_charged: 999_999 });
          await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES });

          const sinComision = await repos.commissionEntries.listClosedWithoutCommission(
            from,
            to,
          );
          expect(sinComision).toHaveLength(1);
          expect(sinComision[0]).toMatchObject({
            eaAppointmentId: 5002,
            eaProviderId: LINA,
            amountCharged: 999_999,
          });
        },
        TEST_TIMEOUT,
      );

      it(
        "no reescribe una entrada pagada aunque se le pida directamente",
        async () => {
          // La compuerta de verdad está en `runFortnight()`, que ni intenta
          // tocar una quincena pagada. Ésta es la de abajo: el repositorio es
          // la autoridad sobre una entrada pagada, y contesta `"paid"` en vez
          // de dejar creer que actualizó algo.
          const repos = repositories(db);
          const run = await repos.commissionRuns.findByProviderAndPeriod(
            SARA,
            QUINCENA.periodStart,
            QUINCENA.periodEnd,
          );
          await repos.commissionRuns.setStatus(run!.id, "revisada", {
            userId: OWNER_ID,
            at: DESPUES,
          });
          await markFortnightPaid(
            { db },
            { period: QUINCENA, eaProviderId: SARA, actorUserId: OWNER_ID, now: DESPUES },
          );

          const [pagada] = await repos.commissionEntries.listByRun(run!.id);
          const outcome = await repos.commissionEntries.upsert({
            appointment_finance_item_id: pagada.appointment_finance_item_id,
            ea_provider_id: pagada.ea_provider_id,
            commission_rule_id: pagada.commission_rule_id,
            base_amount: 1,
            rate_bp: 9999,
            amount: 1,
            period_start: QUINCENA.periodStart,
            period_end: QUINCENA.periodEnd,
          });

          expect(outcome).toBe("paid");
          const despues = await repos.commissionEntries.findByItemAndProvider(
            pagada.appointment_finance_item_id,
            pagada.ea_provider_id,
          );
          expect(despues).toMatchObject({
            amount: pagada.amount,
            base_amount: pagada.base_amount,
            rate_bp: pagada.rate_bp,
          });
        },
        TEST_TIMEOUT,
      );

      it(
        "borrar sin ids no borra nada, y soltar un borrador no borra sus entradas",
        async () => {
          const repos = repositories(db);
          await repos.commissionEntries.deletePending([]);
          expect(await contar(db, "commission_entry")).toBe(8);

          // Descartar una liquidación en borrador **suelta** sus entradas para
          // que la siguiente corrida las recoja; no las borra, porque la
          // comisión calculada sigue siendo cierta.
          const run = await repos.commissionRuns.findByProviderAndPeriod(
            LINA,
            QUINCENA.periodStart,
            QUINCENA.periodEnd,
          );
          await repos.commissionEntries.detachFromRun(run!.id);
          expect(await repos.commissionEntries.listByRun(run!.id)).toEqual([]);
          expect(await contar(db, "commission_entry")).toBe(8);
        },
        TEST_TIMEOUT,
      );
    });

    // ── El repositorio de reglas y de liquidaciones ────────────────────────

    describe("las otras consultas del modelo", () => {
      it(
        "las reglas vigentes en una fecha respetan el valid_to inclusivo",
        async () => {
          const repos = repositories(db);
          const [global] = await repos.commissionRules.listAll();
          expect(global.percent_bp).toBe(4000);
          await repos.commissionRules.closeAt(global.id, "2026-09-15");

          // El día 15 todavía paga: `valid_to` es inclusivo, y una regla que
          // "termina el 15" aplica al día 15 completo.
          expect(await repos.commissionRules.listEffectiveOn("2026-09-15")).toHaveLength(1);
          expect(await repos.commissionRules.listEffectiveOn("2026-09-16")).toHaveLength(0);
          // Y antes de empezar tampoco aplica.
          expect(await repos.commissionRules.listEffectiveOn("2025-12-31")).toHaveLength(0);

          expect(await repos.commissionRules.findById(global.id)).toMatchObject({
            percent_bp: 4000,
            valid_to: "2026-09-15",
          });
          expect(await repos.commissionRules.findById(999_999)).toBeUndefined();
        },
        TEST_TIMEOUT,
      );

      it(
        "el total de una liquidación que ya no es borrador no se reescribe",
        async () => {
          await sembrarQuincenaDeReferencia(db);
          await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES });

          const repos = repositories(db);
          const run = await repos.commissionRuns.findByProviderAndPeriod(
            LINA,
            QUINCENA.periodStart,
            QUINCENA.periodEnd,
          );
          expect(await repos.commissionRuns.findById(run!.id)).toMatchObject({
            total: 227_600,
          });

          await repos.commissionRuns.setStatus(run!.id, "revisada", {
            userId: OWNER_ID,
            at: DESPUES,
          });

          // Cambiar el total por debajo de una revisión convertiría la revisión
          // en teatro, y la revisión es lo único que hace aceptable que pagar
          // sea irreversible.
          await expect(repos.commissionRuns.setDraftTotal(run!.id, 1)).rejects.toThrow(
            /ya no se recalcula/,
          );
          expect(await repos.commissionRuns.findById(run!.id)).toMatchObject({
            total: 227_600,
          });
        },
        TEST_TIMEOUT,
      );
    });

    // ── Sin nada que liquidar ──────────────────────────────────────────────

    it(
      "una quincena sin cuentas no escribe ninguna liquidación",
      async () => {
        // Sin `now`, como corre detrás del botón.
        const result = await runFortnight(
          { db },
          { period: QUINCENA, actorUserId: OWNER_ID },
        );
        expect(result.written).toEqual({
          inserted: 0,
          updated: 0,
          frozen: 0,
          dropped: 0,
        });
        expect(result.runs).toEqual([]);
        expect(await contar(db, "commission_run")).toBe(0);
        // Y la compuerta también sabe leer el reloj sola.
        const assessment = await assessFortnight({ db }, { period: QUINCENA });
        expect(assessment.period).toEqual(QUINCENA);
      },
      TEST_TIMEOUT,
    );

    it(
      "una técnica cuyas cuentas dejaron de cuadrar vuelve a cero, no se queda con el total viejo",
      async () => {
        await sembrarCuenta(db, {
          eaAppointmentId: 6001,
          fecha: "2026-09-04",
          eaProviderId: LINA,
          renglones: [{ kind: "servicio", eaServiceId: 5, unitPrice: 100_000 }],
        });

        const antes = await runFortnight(
          { db },
          { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES },
        );
        expect(antes.runs[0].total).toBe(40_000);

        // Alguien escribió en la tabla por fuera del flujo y el cobrado dejó de
        // ser la suma de los renglones. La cuenta no se liquida — y el borrador
        // que ya existía tiene que bajar a cero, porque pagarle el total viejo
        // sería pagar por una cuenta que nadie puede explicar.
        const cuenta = await repositories(db).appointmentFinance.findByEaAppointmentId(6001);
        await repositories(db).appointmentFinance.update(cuenta!.id, {
          amount_charged: 130_000,
        });

        const despues = await runFortnight(
          { db },
          { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES },
        );
        expect(despues.skipped.map((s) => s.reason)).toEqual(["total-no-cuadra"]);
        expect(despues.written.dropped).toBe(1);
        expect(despues.runs[0]).toMatchObject({ eaProviderId: LINA, total: 0 });
        expect(await contar(db, "commission_entry")).toBe(0);
      },
      TEST_TIMEOUT,
    );
  },
);

// ── Fixtures ────────────────────────────────────────────────────────────────

async function limpiar(db: Kysely<Database>): Promise<void> {
  const tablas = [
    "commission_entry",
    "commission_run",
    "commission_rule",
    "appointment_finance_item",
    "appointment_finance",
    "day_close",
    "combo",
    "audit_log",
    "user",
  ];
  await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);
  for (const tabla of tablas) {
    await sql.raw(`TRUNCATE TABLE \`${tabla}\``).execute(db);
  }
  await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);
  // La regla vive en una migración, no en el fixture: se resiembra corriendo
  // **su propio SQL**, para que ningún test dependa de lo que le dejó el
  // anterior y para que lo que se prueba sea la sentencia que se despliega.
  await correrSiembra(db);
}

/**
 * Corre las sentencias de la migración `018` tal cual, sin el libro de
 * migraciones de por medio.
 *
 * Es el escenario contra el que la siembra se defiende: `runMigrations()` no la
 * repite nunca —el libro `schema_migration` lo impide— así que correrla dos
 * veces por esa vía no prueba nada. Lo que sí puede pasar es que el libro se
 * pierda (una restauración de respaldo de solo datos, alguien borrando la
 * fila) y la migración se vuelva a aplicar sobre una base que ya tiene reglas.
 */
async function correrSiembra(db: Kysely<Database>): Promise<void> {
  const migracion = MIGRATIONS.find((m) => m.id === "018-commission-rule");
  if (migracion === undefined) throw new Error("falta la migración 018");
  for (const statement of migracion.statements) {
    await sql.raw(statement).execute(db);
  }
}

/** `commission_run.paid_by` y `day_close.closed_by` tienen FK hacia `user`. */
async function sembrarDuena(db: Kysely<Database>): Promise<void> {
  await db
    .insertInto("user")
    .values({
      id: OWNER_ID,
      name: "Dueña",
      email: "duena@goldenbeautystudio.com.co",
      emailVerified: 1,
    })
    .execute();
}

async function contar(db: Kysely<Database>, tabla: "commission_entry" | "commission_run") {
  const rows = await db.selectFrom(tabla).select("id").execute();
  return rows.length;
}

/**
 * Una cuenta con sus renglones, escrita con los repositorios.
 *
 * Con los repositorios y no con SQL a mano para que el fixture pase por los
 * mismos CHECK que la escritura real: una cuenta que la base no aceptaría no
 * sirve para probar la liquidación.
 */
async function sembrarCuenta(
  db: Kysely<Database>,
  opts: {
    eaAppointmentId: number;
    fecha: string;
    eaProviderId: number;
    secondaryEaProviderId?: number | null;
    performedServiceId?: number;
    renglones: RenglonSeed[];
    descuento?: Cop;
    propina?: Cop;
    cerrada?: boolean;
    hora?: string;
  },
): Promise<number> {
  const { appointmentFinance, appointmentFinanceItems } = repositories(db);
  const start = eaLocalToInstant(dt(`${opts.fecha} ${opts.hora ?? "09:00:00"}`));
  const subtotal = opts.renglones.reduce(
    (sum, item) => sum + (item.qty ?? 1) * item.unitPrice,
    0,
  );
  const descuento = opts.descuento ?? 0;
  const performed = opts.performedServiceId ?? 5;

  const { row } = await appointmentFinance.ensure({
    ea_appointment_id: opts.eaAppointmentId,
    ea_provider_id: opts.eaProviderId,
    secondary_ea_provider_id: opts.secondaryEaProviderId ?? null,
    appointment_start_at: start,
    booked_service_id: 5,
    performed_service_id: performed,
    service_price_snapshot: subtotal,
    snapshot_source: "webhook",
  });

  if (opts.cerrada === false) return row.id;

  await appointmentFinanceItems.insertMany(
    opts.renglones.map((item) => ({
      appointment_finance_id: row.id,
      kind: item.kind,
      ea_service_id: item.eaServiceId,
      pricing_id: null,
      qty: item.qty ?? 1,
      unit_price_snapshot: item.unitPrice,
      line_total: (item.qty ?? 1) * item.unitPrice,
      note: item.note ?? null,
    })),
  );

  await appointmentFinance.update(row.id, {
    discount: descuento,
    amount_charged: subtotal - descuento,
    tip: opts.propina ?? 0,
    payment_method: "efectivo",
    paid_at: start,
    closed_by: OWNER_ID,
    closed_at: start,
  });

  return row.id;
}

/**
 * La quincena de referencia: las cinco cuentas cuyos montos están calculados a
 * mano en `commission-run.test.ts`.
 *
 * Lina 227.600 · Sara 40.000.
 */
async function sembrarQuincenaDeReferencia(db: Kysely<Database>): Promise<void> {
  await repositories(db).combos.upsert({
    ea_service_id: COMBO_SERVICE,
    hands_ea_service_id: 5,
    feet_ea_service_id: 6,
    price: 250_000,
    duration_min: 180,
    // Criterio de la dueña, nunca una fórmula: 60 % manos.
    allocation_hands_bp: 6000,
  });

  // A · forrado + 3 diseños, con propina que **no** entra a la base.
  await sembrarCuenta(db, {
    eaAppointmentId: 5001,
    fecha: "2026-09-02",
    eaProviderId: LINA,
    propina: 20_000,
    renglones: [
      { kind: "servicio", eaServiceId: 5, unitPrice: 180_000 },
      { kind: "adicional", eaServiceId: EXTRA_SERVICE, qty: 3, unitPrice: 8_000 },
    ],
  });

  // B · montaje + adicional, con un descuento cuyo prorrateo deja residuo.
  await sembrarCuenta(db, {
    eaAppointmentId: 5002,
    fecha: "2026-09-05",
    eaProviderId: LINA,
    descuento: 10_000,
    renglones: [
      { kind: "servicio", eaServiceId: 5, unitPrice: 200_000 },
      { kind: "adicional", eaServiceId: EXTRA_SERVICE, unitPrice: 15_000 },
    ],
  });

  // C · el combo a cuatro manos.
  await sembrarCuenta(db, {
    eaAppointmentId: 5003,
    fecha: "2026-09-08",
    eaProviderId: LINA,
    secondaryEaProviderId: SARA,
    performedServiceId: COMBO_SERVICE,
    renglones: [
      { kind: "servicio", eaServiceId: COMBO_SERVICE, unitPrice: 250_000 },
      { kind: "adicional", eaServiceId: EXTRA_SERVICE, unitPrice: 10_000 },
    ],
  });

  // D · retoque de garantía: renglón manual en cero, marcado.
  await sembrarCuenta(db, {
    eaAppointmentId: 5004,
    fecha: "2026-09-10",
    eaProviderId: SARA,
    renglones: [
      {
        kind: "manual",
        eaServiceId: null,
        unitPrice: 0,
        note: "retoque de garantía",
      },
    ],
  });

  // E · cita atendida sin cuenta cerrada.
  await sembrarCuenta(db, {
    eaAppointmentId: 5005,
    fecha: "2026-09-12",
    eaProviderId: LINA,
    cerrada: false,
    renglones: [],
  });
}

/** Los quince días del periodo, cerrados. Es la compuerta de la revisión. */
async function cerrarTodosLosDias(db: Kysely<Database>): Promise<void> {
  const { dayCloses } = repositories(db);
  for (const day of fortnightDays(QUINCENA)) {
    await dayCloses.insert({
      close_date: day,
      closed_by: OWNER_ID,
      closed_at: eaLocalToInstant(dt(`${day} 20:00:00`)),
    });
  }
}
