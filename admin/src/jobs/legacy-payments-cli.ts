import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import type { NewLegacyPayment } from "@/db/types";
import { eaLocalToInstant, EA_TIME_ZONE } from "@/lib/ea";

import { legacyStartToWallClock } from "@/app/(panel)/clientes/history";

import {
  applyCorrections,
  matchPayments,
  parseCorrections,
  parsePaymentSheets,
  paymentTotals,
  sheetKind,
  type Corrections,
  type PaymentMatch,
  type SourceSheet,
} from "./legacy-payments";
import { looksLikeXlsx, parseXlsxSheets } from "./xlsx";

/**
 * Importa cómo se pagó cada venta del historial de Agenda Pro a
 * `gbs_admin.legacy_payment`. **Se corre a mano, mirando la salida.**
 *
 * ```
 *   node scripts/historial-pagos.js /tmp/finanzas/              ← plan, no escribe
 *   node scripts/historial-pagos.js ventas_*.xlsx transacciones_*.xlsx
 *   node scripts/historial-pagos.js /tmp/finanzas/ --aplicar    ← escribe
 *   node scripts/historial-pagos.js /tmp/finanzas/ --correcciones=/tmp/correcciones.json
 * ```
 *
 * `--correcciones` aplica lo que la dueña corrigió a mano en Actual Budget y
 * Agenda Pro dice distinto: el medio real, el pago partido en dos medios y las
 * cortesías (ver `applyCorrections()`). Sin el archivo, todo queda como lo dijo
 * Agenda Pro — y una segunda corrida **con** el archivo lo corrige, porque la
 * escritura converge a lo que dicen los archivos.
 *
 * Acepta archivos o carpetas (de una carpeta toma todos los `.xlsx`). Da igual
 * pasar el reporte de ventas, el de transacciones o los dos, y que los tramos
 * mensuales se pisen: los pagos se juntan por id de transacción.
 *
 * Imprime totales por mes y por método, y cuántos pagos casaron con su
 * reserva de `legacy_appointment` (que solo se lee). Con `--aplicar` escribe,
 * idempotente: lo ya importado no se toca, salvo completar un enlace a la
 * reserva que la vez anterior no se encontró.
 *
 * ⚠ **Nada de esto se empuja a ingest.** Esa plata ya está en Actual Budget,
 * por el scraper de Agenda Pro. Ver la nota de `legacy-payments.ts`.
 *
 * Los archivos traen nombres de clientas: esta salida imprime cifras y nombres
 * de archivo, nunca nombres ni teléfonos.
 */

const cop = (value: number) => `$${value.toLocaleString("es-CO")}`;

function collectFiles(args: readonly string[]): string[] {
  const files: string[] = [];
  for (const arg of args) {
    if (statSync(arg).isDirectory()) {
      for (const entry of readdirSync(arg).sort()) {
        if (/\.xlsx$/i.test(entry)) files.push(join(arg, entry));
      }
    } else {
      files.push(arg);
    }
  }
  return files;
}

function readSheets(files: readonly string[]): SourceSheet[] {
  const sheets: SourceSheet[] = [];
  for (const file of files) {
    const raw = readFileSync(file);
    if (!looksLikeXlsx(raw)) {
      console.log(`historial-pagos: ${basename(file)} — no es un .xlsx, se salta.`);
      continue;
    }
    const kinds: string[] = [];
    for (const [name, rows] of parseXlsxSheets(raw)) {
      const kind = rows[0] === undefined ? null : sheetKind(rows[0]);
      if (kind === null) continue;
      kinds.push(`${name} (${Math.max(0, rows.length - 1)})`);
      sheets.push({ file: basename(file), rows });
    }
    console.log(
      `historial-pagos: ${basename(file)} — ${kinds.length > 0 ? kinds.join(" · ") : "ninguna hoja de ventas, ítems ni transacciones"}.`,
    );
  }
  return sheets;
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const aplicar = argv.includes("--aplicar");
  const paths = argv.filter((arg) => !arg.startsWith("--"));
  const correctionsPath = argv.find((arg) => arg.startsWith("--correcciones="))?.slice("--correcciones=".length);
  // `--desde=AAAA-MM-DD`: solo los pagos de esa fecha en adelante. La escritura
  // converge a lo que dicen los archivos, así que pasar un tramo viejo sin el
  // archivo de correcciones desharía las correcciones de ese tramo; con esto se
  // puede sumar lo nuevo sin tocar lo ya corregido.
  const desde = argv.find((arg) => arg.startsWith("--desde="))?.slice("--desde=".length);
  if (desde !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
    console.error(`historial-pagos: --desde espera AAAA-MM-DD, no "${desde}".`);
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    console.error(
      "historial-pagos: faltan los archivos. Uso: node scripts/historial-pagos.js <carpeta|archivo.xlsx>… [--aplicar]",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const all = parsePaymentSheets(readSheets(collectFiles(paths)));
    const parsed =
      desde === undefined
        ? all
        : { ...all, payments: all.payments.filter((payment) => payment.paidAt.slice(0, 10) >= desde) };
    if (desde !== undefined) {
      console.log(
        `historial-pagos: --desde=${desde} — ${parsed.payments.length} de ${all.payments.length} pago(s).`,
      );
    }

    let corrections: Corrections = new Map();
    if (correctionsPath !== undefined) {
      corrections = parseCorrections(JSON.parse(readFileSync(correctionsPath, "utf8")));
      console.log(`historial-pagos: ${corrections.size} corrección(es) en ${basename(correctionsPath)}.`);
    }
    const { rows: planned, report: fixes } = applyCorrections(parsed.payments, corrections);
    const totals = paymentTotals(planned);

    console.log(
      `\nhistorial-pagos: ${totals.transactions} transacción(es) · ${parsed.duplicates} repetida(s) entre ` +
        "archivos (se cuentan una vez).",
    );
    console.log(`  bruto (lo que registró Agenda Pro)   ${cop(totals.gross)}`);
    console.log(
      `  cortesías (sin cobro a la clienta)   ${totals.courtesy.transactions} · ${cop(totals.courtesy.amount)}`,
    );
    console.log(`  neto (lo que entró)                  ${cop(totals.net)}`);
    for (const method of ["efectivo", "transferencia", "otro"] as const) {
      console.log(`    neto ${method.padEnd(14)}                ${cop(totals.netByMethod[method])}`);
    }
    console.log(`  propinas (aparte)                    ${cop(totals.tips)}`);
    if (correctionsPath !== undefined) {
      console.log(
        `historial-pagos: correcciones aplicadas — medio cambiado en ${fixes.methodChanged} · ` +
          `${fixes.split} pago(s) partido(s) · ${fixes.courtesy} cortesía(s).`,
      );
      if (fixes.notFound.length > 0) {
        console.log(
          `historial-pagos: ⚠ ${fixes.notFound.length} corrección(es) sin su transacción en los archivos: ` +
            fixes.notFound.slice(0, 20).join(", "),
        );
      }
      if (fixes.saleMismatch.length > 0) {
        console.log(
          `historial-pagos: ⚠ ${fixes.saleMismatch.length} corrección(es) con otra venta que la del archivo ` +
            `(revisar antes de aplicar): ${fixes.saleMismatch.slice(0, 20).join(", ")}`,
        );
      }
    }
    console.log("historial-pagos: por mes (fecha de pago), neto —");
    for (const month of totals.byMonth) {
      console.log(
        `  ${month.month}  ${String(month.transactions).padStart(3)} · neto ${cop(month.net).padStart(11)}` +
          `  efectivo ${cop(month.netByMethod.efectivo)} · transferencia ${cop(month.netByMethod.transferencia)}` +
          (month.netByMethod.otro > 0 ? ` · otro ${cop(month.netByMethod.otro)}` : "") +
          (month.courtesy > 0 ? ` · cortesías ${cop(month.courtesy)}` : "") +
          (month.tips > 0 ? ` · propinas ${cop(month.tips)}` : ""),
      );
    }

    if (parsed.skipped.length > 0) {
      console.log(
        `historial-pagos: ⚠ ${parsed.skipped.length} fila(s) saltada(s): ` +
          parsed.skipped.slice(0, 20).map((s) => `${s.file}:${s.line} ${s.reason}`).join(", "),
      );
    }
    if (parsed.conflicts.length > 0) {
      // Un mismo pago con otro monto u otro método en dos archivos. No debería
      // pasar; si pasa, se quedó el primero y alguien tiene que mirarlo.
      console.log(
        `historial-pagos: ⚠ ${parsed.conflicts.length} pago(s) con datos distintos entre archivos ` +
          `(se quedó el primero): ${parsed.conflicts.slice(0, 20).join(", ")}`,
      );
    }
    if (parsed.withoutSale > 0) {
      console.log(
        `historial-pagos: ${parsed.withoutSale} pago(s) sin su venta en los archivos — para casarlos ` +
          "con la reserva hace falta el reporte de ventas del mismo tramo.",
      );
    }

    // --- Casar con legacy_appointment (solo lectura) ----------------------
    let match: PaymentMatch | null = null;
    try {
      const legacy = await repositories(getDb()).legacyAppointments.listByStartRange(
        new Date(2000, 0, 1),
        new Date(2100, 0, 1),
      );
      match = matchPayments(
        parsed.payments,
        legacy.map((row) => ({
          id: row.id,
          // La inversa exacta de lo que hizo el driver: la misma hora de pared
          // que guardó el import de reservas. Ver `legacyStartToWallClock`.
          start: legacyStartToWallClock(row.started_at),
          clientName: row.client_name,
          serviceName: row.service_name,
          amountCharged: row.amount_charged,
        })),
      );
      const rate =
        parsed.payments.length === 0 ? 0 : Math.round((match.matched / parsed.payments.length) * 1000) / 10;
      console.log(
        `\nhistorial-pagos: contra ${legacy.length} cita(s) de legacy_appointment — ` +
          `${match.matched} casado(s) (${rate} %: ${match.byRule.reserva} por fecha de reserva y nombre, ` +
          `${match.byRule.respaldo} por día + monto + servicio) · ${match.unmatched} sin casar` +
          (match.unmatched > 0 ? ` (${cop(match.unmatchedAmount)})` : "") +
          ".",
      );
    } catch (error) {
      if (aplicar) throw error;
      console.log(
        `\nhistorial-pagos: no se pudo leer legacy_appointment (${error instanceof Error ? error.message : error}); ` +
          "el casado con las reservas se calcula al aplicar.",
      );
    }

    if (!aplicar) {
      console.log("\nhistorial-pagos: ejecución en seco. Volver a correr con --aplicar para escribir.");
      return;
    }

    if (fixes.saleMismatch.length > 0) {
      // Una corrección que apunta a otra venta corrige otra cosa. No se
      // escribe nada hasta que alguien la mire.
      console.error("historial-pagos: hay correcciones que no coinciden con su venta; no se escribió nada.");
      process.exitCode = 1;
      return;
    }

    const rows: NewLegacyPayment[] = planned.map((payment) => ({
      source_tx_id: payment.sourceTxId,
      part: payment.part,
      sale_id: payment.saleId,
      // Hora de pared de Bogotá → instante, igual que el import de reservas,
      // para que las dos tablas guarden la misma hora de pared.
      paid_at: eaLocalToInstant(payment.paidAt, EA_TIME_ZONE),
      amount: payment.amount,
      tip: payment.tip,
      method: payment.method,
      method_agendapro: payment.methodAgendapro,
      method_raw: payment.methodRaw?.slice(0, 80) ?? null,
      is_courtesy: payment.isCourtesy ? 1 : 0,
      client_name: payment.clientName?.slice(0, 160) ?? null,
      service_name: payment.serviceName?.slice(0, 255) ?? null,
      provider_name: payment.providerName?.slice(0, 120) ?? null,
      booked_at: payment.bookedAt === null ? null : eaLocalToInstant(payment.bookedAt, EA_TIME_ZONE),
      legacy_appointment_id: match?.links.get(payment.sourceTxId) ?? null,
    }));

    const { legacyPayments } = repositories(getDb());
    let touched = 0;
    // De a 200: un solo INSERT con miles de filas puede pasar el
    // `max_allowed_packet` de un MySQL compartido.
    for (let i = 0; i < rows.length; i += 200) {
      touched += await legacyPayments.upsert(rows.slice(i, i + 200));
    }
    const parts = new Map<string, number>();
    for (const row of planned) parts.set(row.sourceTxId, (parts.get(row.sourceTxId) ?? 0) + 1);
    const pruned = await legacyPayments.pruneParts(parts);
    console.log(
      `historial-pagos: ✓ aplicado sobre ${rows.length} fila(s) (${touched} tocada(s) por MySQL: ` +
        "1 por alta, 2 por cambio, 0 si ya estaba)" +
        (pruned > 0 ? ` · ${pruned} parte(s) sobrante(s) borrada(s)` : "") +
        ".",
    );
  } catch (error) {
    console.error("historial-pagos: no se pudo completar.", error);
    process.exitCode = 1;
  } finally {
    // Sin `DATABASE_URL` el `getDb()` mismo lanza (la ejecución en seco puede
    // correr sin base): el cierre no puede tapar la salida de arriba.
    try {
      await getDb().destroy();
    } catch {
      // nada que cerrar
    }
  }
}

void run();
