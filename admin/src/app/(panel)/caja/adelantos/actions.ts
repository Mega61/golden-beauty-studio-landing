"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { mapEaStatus } from "@/components/calendar/status-map";
import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import type { AppointmentDeposit } from "@/db/types";
import { can } from "@/lib/auth-policy";
import { ForbiddenError, requireCapability, requireOwnProvider, type PanelSession } from "@/lib/dal";
import {
  addBlockReason,
  depositPaidAt,
  depositRemaining,
  moveBlockReason,
  refundBlockReason,
} from "@/lib/deposits";
import { eaLocalToInstant, instantToEaDate, isEaLocalDate } from "@/lib/ea";
import { createEaClient } from "@/lib/ea/client";
import type { Appointment } from "@/lib/ea/types";
import { formatCOP } from "@/components/ui/format";

import { normalizePhoneE164 } from "../../clientes/identity";
import { depositViewOf, type DepositView } from "./view";

/**
 * Las escrituras de los **adelantos** (migración `034`). Se usan desde el
 * detalle de la cita en la agenda y desde Caja → Adelantos.
 *
 * Registrar un adelanto es registrar plata que entró, así que pide
 * `cuenta:cobrar` (dueña y recepción; la técnica solo si el estudio la deja
 * cobrar, y solo en sus citas). La sincronización de la noche lo manda al CRM
 * como `abono:<id>` con el día en que entró, y ese es el movimiento que el bot
 * de finanzas enlaza con la transferencia.
 *
 * Devolver uno que ya llegó a Actual sale como ajuste negativo, y eso solo lo
 * decide la dueña (`cuenta:corregir-tras-cierre`), como anular una tarjeta
 * regalo vendida.
 *
 * Todas devuelven el resultado en vez de lanzarlo (un throw llega al navegador
 * como un digest opaco).
 */

export type DepositActionResult = { ok: true; message: string } | { ok: false; message: string };

const MAX_PESOS = 9_999_999;
const METHODS = ["efectivo", "transferencia", "otro"] as const;

const AddSchema = z.object({
  eaAppointmentId: z.number().int().positive(),
  amount: z.number().int().min(1).max(MAX_PESOS),
  method: z.enum(METHODS),
  paidOn: z.string().refine(isEaLocalDate),
  paidRef: z.string().trim().max(120).optional(),
});

const RefundSchema = z.object({
  depositId: z.number().int().positive(),
  amount: z.number().int().min(1).max(MAX_PESOS),
  method: z.enum(METHODS),
  refundedOn: z.string().refine(isEaLocalDate),
  reason: z.string().trim().min(3).max(500),
});

const MoveSchema = z.object({
  depositId: z.number().int().positive(),
  toEaAppointmentId: z.number().int().positive(),
});

type Guarded = { ok: true; session: PanelSession } | { ok: false; message: string };

async function guard(): Promise<Guarded> {
  try {
    return { ok: true, session: await requireCapability("cuenta:cobrar") };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) return { ok: false, message: "Tu rol no registra pagos." };
    console.error("[adelantos] no se pudo verificar la sesión", error);
    return { ok: false, message: "No se pudo verificar la sesión." };
  }
}

/** La cita de EA, y que quien mira pueda tocarla (una técnica, solo las suyas). */
async function appointmentFor(
  ea: ReturnType<typeof createEaClient>,
  eaAppointmentId: number,
): Promise<{ ok: true; appointment: Appointment } | { ok: false; message: string }> {
  let appointment: Appointment;
  try {
    appointment = await ea.appointments.get(eaAppointmentId);
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: "La agenda no respondió. Intenta de nuevo en un momento." };
  }
  try {
    await requireOwnProvider(appointment.providerId);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) return { ok: false, message: "Esta cita no es tuya." };
    throw error;
  }
  return { ok: true, appointment };
}

/** La clienta de la cita: nombre y celular E.164. Sin EA, sin nombre: el adelanto se guarda igual. */
async function customerOf(
  ea: ReturnType<typeof createEaClient>,
  customerId: number | null,
): Promise<{ name: string | null; phone: string | null }> {
  if (customerId === null) return { name: null, phone: null };
  try {
    const customer = await ea.customers.get(customerId);
    const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim();
    return { name: name || null, phone: normalizePhoneE164(customer.phone) };
  } catch {
    return { name: null, phone: null };
  }
}

async function accountClosed(eaAppointmentId: number): Promise<boolean> {
  const row = await repositories(getDb()).appointmentFinance.findByEaAppointmentId(eaAppointmentId);
  return row?.closed_at != null;
}

function revalidate(): void {
  revalidatePath("/caja/adelantos");
  revalidatePath("/caja");
  revalidatePath("/hoy");
  revalidatePath("/agenda");
}

/**
 * Los adelantos de una cita y los de la misma clienta que se pueden pasar a
 * ella (pagó para una cita que canceló). Solo lectura, para el detalle de la
 * agenda.
 */
export async function adelantosDeCita(eaAppointmentId: number): Promise<
  | {
      ok: true;
      deposits: DepositView[];
      movable: DepositView[];
      /** Por qué no se puede registrar uno nuevo acá, o `null`. */
      blocked: string | null;
      canFixAfterSync: boolean;
    }
  | { ok: false; message: string }
> {
  if (!Number.isSafeInteger(eaAppointmentId) || eaAppointmentId <= 0) {
    return { ok: false, message: "La cita no es válida." };
  }
  const auth = await guard();
  if (!auth.ok) return auth;

  try {
    const ea = createEaClient();
    const found = await appointmentFor(ea, eaAppointmentId);
    if (!found.ok) return found;
    const repos = repositories(getDb());
    const closed = await accountClosed(eaAppointmentId);
    const own = await repos.appointmentDeposits.listByAppointment(eaAppointmentId);

    // Los de la misma clienta en otras citas, que todavía tienen plata y cuya
    // cuenta no se cerró: los que se pueden pasar acá.
    const { phone } = await customerOf(ea, found.appointment.customerId);
    const others =
      phone === null
        ? []
        : (await repos.appointmentDeposits.listByPhone(phone)).filter(
            (row) => row.ea_appointment_id !== eaAppointmentId && depositRemaining(row) > 0,
          );
    const otherClosed = new Map<number, boolean>();
    for (const id of new Set(others.map((row) => row.ea_appointment_id))) {
      otherClosed.set(id, await accountClosed(id));
    }

    return {
      ok: true,
      deposits: own.map((row) => depositViewOf(row, closed)),
      movable: closed
        ? []
        : others
            .filter((row) => otherClosed.get(row.ea_appointment_id) !== true)
            .map((row) => depositViewOf(row, false)),
      blocked: addBlockReason({
        cancelled: mapEaStatus(found.appointment.status) === "cancelada",
        accountClosed: closed,
      }),
      canFixAfterSync: can(auth.session.role, "cuenta:corregir-tras-cierre"),
    };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[adelantos] no se pudieron leer los adelantos de la cita", error);
    return { ok: false, message: "No se pudieron leer los adelantos. Intenta de nuevo." };
  }
}

/** **Registrar** un adelanto en una cita. */
export async function registrarAdelanto(input: z.input<typeof AddSchema>): Promise<DepositActionResult> {
  const parsed = AddSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Faltan datos del adelanto: monto, método y fecha." };
  const auth = await guard();
  if (!auth.ok) return auth;

  const now = new Date();
  const paidAt = depositPaidAt(parsed.data.paidOn, now);
  if (paidAt === null) return { ok: false, message: "La fecha del pago no puede ser futura." };

  try {
    const ea = createEaClient();
    const found = await appointmentFor(ea, parsed.data.eaAppointmentId);
    if (!found.ok) return found;
    const { appointment } = found;

    const blocked = addBlockReason({
      cancelled: mapEaStatus(appointment.status) === "cancelada",
      accountClosed: await accountClosed(appointment.id),
    });
    if (blocked !== null) return { ok: false, message: blocked };

    const customer = await customerOf(ea, appointment.customerId);
    const db = getDb();
    await db.transaction().execute(async (trx) => {
      const tx = repositories(trx);
      const id = await tx.appointmentDeposits.insert({
        ea_appointment_id: appointment.id,
        appointment_start_at: eaLocalToInstant(appointment.start),
        amount: parsed.data.amount,
        method: parsed.data.method,
        paid_at: paidAt,
        paid_ref: parsed.data.paidRef || null,
        customer_name: customer.name,
        customer_phone: customer.phone,
        created_by: auth.session.userId,
      });
      await tx.auditLog.append({
        actorUserId: auth.session.userId,
        action: "deposit.create",
        entity: "appointment_deposit",
        entityId: id,
        after: {
          eaAppointmentId: appointment.id,
          amount: parsed.data.amount,
          method: parsed.data.method,
          paidOn: parsed.data.paidOn,
        },
        at: now,
      });
    });

    revalidate();
    return {
      ok: true,
      message: `Adelanto de ${formatCOP(parsed.data.amount)} registrado. Se descuenta solo al cobrar la cita.`,
    };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[adelantos] no se pudo registrar el adelanto", error);
    return { ok: false, message: "No se pudo registrar el adelanto. Intenta de nuevo." };
  }
}

/** El adelanto y si su cita ya se cobró. */
async function depositFor(
  depositId: number,
): Promise<{ ok: true; deposit: AppointmentDeposit; closed: boolean } | { ok: false; message: string }> {
  const deposit = await repositories(getDb()).appointmentDeposits.findById(depositId);
  if (deposit === undefined) return { ok: false, message: "Ese adelanto ya no está." };
  return { ok: true, deposit, closed: await accountClosed(deposit.ea_appointment_id) };
}

/**
 * **Devolver** un adelanto, todo o parte (la clienta canceló, o la cuenta salió
 * menor). Si ya llegó a Actual, la noche manda el ajuste negativo
 * (`abono:<id>:adj1`) con el día y el método por donde salió la plata.
 */
export async function devolverAdelanto(input: z.input<typeof RefundSchema>): Promise<DepositActionResult> {
  const parsed = RefundSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Faltan datos: monto, método, fecha y motivo." };
  const auth = await guard();
  if (!auth.ok) return auth;

  try {
    const found = await depositFor(parsed.data.depositId);
    if (!found.ok) return found;
    const { deposit, closed } = found;

    const ea = createEaClient();
    const own = await appointmentFor(ea, deposit.ea_appointment_id);
    // Una cita borrada en EA no impide devolver: la plata sigue siendo de la
    // clienta. Pero una técnica solo toca lo suyo, y sin EA no se sabe.
    if (!own.ok && (own.message === "Esta cita no es tuya." || auth.session.role === "staff")) return own;

    const blocked = refundBlockReason({
      deposit,
      accountClosed: closed,
      pushed: deposit.pushed_to_ingest_at !== null,
      canFixAfterSync: can(auth.session.role, "cuenta:corregir-tras-cierre"),
    });
    if (blocked !== null) return { ok: false, message: blocked };

    if (parsed.data.amount > deposit.amount) {
      return { ok: false, message: `No se puede devolver más que el adelanto (${formatCOP(deposit.amount)}).` };
    }

    const now = new Date();
    const refundedAt = depositPaidAt(parsed.data.refundedOn, now);
    if (refundedAt === null) return { ok: false, message: "La fecha de la devolución no puede ser futura." };
    if (parsed.data.refundedOn < instantToEaDate(deposit.paid_at)) {
      return { ok: false, message: "La devolución no puede ser de antes del adelanto." };
    }

    const db = getDb();
    let done = false;
    await db.transaction().execute(async (trx) => {
      const tx = repositories(trx);
      done = await tx.appointmentDeposits.markRefunded(deposit.id, {
        amount: parsed.data.amount,
        method: parsed.data.method,
        at: refundedAt,
        by: auth.session.userId,
        reason: parsed.data.reason,
      });
      if (!done) return;
      await tx.auditLog.append({
        actorUserId: auth.session.userId,
        action: "deposit.refund",
        entity: "appointment_deposit",
        entityId: deposit.id,
        before: { amount: deposit.amount, pushed: deposit.pushed_to_ingest_at !== null },
        after: { refunded: parsed.data.amount, method: parsed.data.method, on: parsed.data.refundedOn },
        reason: parsed.data.reason,
        at: now,
      });
    });
    if (!done) return { ok: false, message: "Este adelanto ya tiene una devolución registrada." };

    revalidate();
    return {
      ok: true,
      message:
        `Devolución de ${formatCOP(parsed.data.amount)} registrada.` +
        (deposit.pushed_to_ingest_at === null ? "" : " Esta noche sale el ajuste negativo a Actual."),
    };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[adelantos] no se pudo registrar la devolución", error);
    return { ok: false, message: "No se pudo registrar la devolución. Intenta de nuevo." };
  }
}

/**
 * **Borrar** un adelanto mal escrito, mientras no haya viajado. Uno que ya
 * llegó a Actual no se borra: se devuelve.
 */
export async function borrarAdelanto(depositId: number): Promise<DepositActionResult> {
  if (!Number.isSafeInteger(depositId) || depositId <= 0) return { ok: false, message: "El adelanto no es válido." };
  const auth = await guard();
  if (!auth.ok) return auth;

  try {
    const found = await depositFor(depositId);
    if (!found.ok) return found;
    const { deposit, closed } = found;
    if (closed) return { ok: false, message: "La cuenta de la cita ya se cerró con este adelanto." };
    if (deposit.pushed_to_ingest_at !== null) {
      return { ok: false, message: "Este adelanto ya llegó a Actual: no se borra, se devuelve." };
    }
    const own = await appointmentFor(createEaClient(), deposit.ea_appointment_id);
    if (!own.ok && (own.message === "Esta cita no es tuya." || auth.session.role === "staff")) return own;

    const now = new Date();
    let done = false;
    await getDb()
      .transaction()
      .execute(async (trx) => {
        const tx = repositories(trx);
        done = await tx.appointmentDeposits.deleteUnpushed(deposit.id);
        if (!done) return;
        await tx.auditLog.append({
          actorUserId: auth.session.userId,
          action: "deposit.delete",
          entity: "appointment_deposit",
          entityId: deposit.id,
          before: {
            eaAppointmentId: deposit.ea_appointment_id,
            amount: deposit.amount,
            method: deposit.method,
            paidOn: instantToEaDate(deposit.paid_at),
          },
          at: now,
        });
      });
    if (!done) return { ok: false, message: "Este adelanto ya llegó a Actual: no se borra, se devuelve." };

    revalidate();
    return { ok: true, message: "Adelanto borrado." };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[adelantos] no se pudo borrar el adelanto", error);
    return { ok: false, message: "No se pudo borrar. Intenta de nuevo." };
  }
}

/**
 * **Pasar** un adelanto a otra cita de la misma clienta (canceló y volvió a
 * agendar). Entero y con su llave: en Actual nada cambia, solo la cita que paga.
 */
export async function pasarAdelanto(input: z.input<typeof MoveSchema>): Promise<DepositActionResult> {
  const parsed = MoveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Faltan datos para pasar el adelanto." };
  const auth = await guard();
  if (!auth.ok) return auth;

  try {
    const found = await depositFor(parsed.data.depositId);
    if (!found.ok) return found;
    const { deposit, closed } = found;

    const ea = createEaClient();
    const target = await appointmentFor(ea, parsed.data.toEaAppointmentId);
    if (!target.ok) return target;
    if (mapEaStatus(target.appointment.status) === "cancelada") {
      return { ok: false, message: "La cita a la que lo quieres pasar está cancelada." };
    }

    const blocked = moveBlockReason({
      deposit,
      fromAccountClosed: closed,
      toAccountClosed: await accountClosed(target.appointment.id),
      sameAppointment: deposit.ea_appointment_id === target.appointment.id,
    });
    if (blocked !== null) return { ok: false, message: blocked };

    // Solo entre citas de la misma clienta: es su plata.
    const customer = await customerOf(ea, target.appointment.customerId);
    if (deposit.customer_phone !== null && customer.phone !== deposit.customer_phone) {
      return { ok: false, message: "Ese adelanto es de otra clienta." };
    }

    const now = new Date();
    await getDb()
      .transaction()
      .execute(async (trx) => {
        const tx = repositories(trx);
        await tx.appointmentDeposits.moveToAppointment(
          deposit.id,
          target.appointment.id,
          eaLocalToInstant(target.appointment.start),
        );
        await tx.auditLog.append({
          actorUserId: auth.session.userId,
          action: "deposit.move",
          entity: "appointment_deposit",
          entityId: deposit.id,
          before: { eaAppointmentId: deposit.ea_appointment_id },
          after: { eaAppointmentId: target.appointment.id },
          at: now,
        });
      });

    revalidate();
    return { ok: true, message: `Adelanto de ${formatCOP(depositRemaining(deposit))} pasado a esta cita.` };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[adelantos] no se pudo pasar el adelanto", error);
    return { ok: false, message: "No se pudo pasar el adelanto. Intenta de nuevo." };
  }
}
