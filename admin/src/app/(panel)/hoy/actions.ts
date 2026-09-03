"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import type { NewAppointmentFinanceItem } from "@/db/types";
import { instantToEaLocal } from "@/lib/ea";
import { createEaClient } from "@/lib/ea/client";
import { ForbiddenError, requireCapability, requireOwnProvider } from "@/lib/dal";
import { can } from "@/lib/auth-policy";
import { TicketError, ticketFromEnteredTotal, validateTicketClose } from "@/lib/ticket";
import { upsertAppointmentFinance } from "@/jobs/snapshot";
import { draftToItems, type TicketDraft } from "@/components/ticket/draft";
import type { CloseTicketInput, CloseTicketResult } from "@/components/ticket/types";
import { loadCatalogForClose } from "./catalog-server";

/**
 * **Cerrar la cuenta de una cita.** Es la única escritura de este paquete.
 *
 * ## Devuelve los errores, no los lanza
 *
 * Una excepción dentro de una Server Action llega al navegador como un digest
 * opaco en producción — un identificador y nada más. Este flujo necesita que el
 * cliente distinga tres desenlaces, porque la cola de reintentos se comporta
 * distinto en cada uno:
 *
 * | Desenlace | `retryable` | Qué hace la cola |
 * | --- | --- | --- |
 * | guardó | — | limpia el borrador |
 * | el servidor dijo que no | `false` | saca de la cola, **conserva** el borrador |
 * | no se pudo ahora | `true` | deja en la cola y reintenta |
 *
 * Un error de validación devuelto como reintentable dejaría el celular
 * golpeando el mismo error cada quince segundos hasta que alguien abra la
 * consola. Uno de red devuelto como definitivo perdería la cuenta.
 *
 * Los `redirect()` de Next sí tienen que propagarse: por eso cada `catch` pasa
 * primero por `unstable_rethrow`.
 *
 * ## Ningún precio llega del navegador
 *
 * Lo que manda la hoja son ids y cantidades. Los precios los pone el catálogo
 * de EA acá, en el servidor, y los renglones los arma `draftToItems()` — la
 * misma función que usó el cliente para pintar el total, así que lo que se ve y
 * lo que se guarda no pueden divergir. Un navegador manipulado puede pedir un
 * servicio que no le corresponde; no puede fijar cuánto vale.
 *
 * ## Las observaciones no viajan a EA
 *
 * **Este archivo no le escribe nada a Easy!Appointments.** Ni las notas, ni el
 * servicio realizado. Las notas de una cita en EA se copian a la `description`
 * del evento de Google, que está compartido en solo lectura a un correo
 * personal: una observación interna sobre una clienta no puede terminar ahí. Y
 * reescribir `id_services` dispararía la notificación de "tu cita cambió" por
 * algo que ya pasó. EA guarda la reserva; el panel guarda la entrega.
 */

const REASONS = ["cambio_servicio", "adicionales", "cortesia", "correccion", "otro"] as const;
const METHODS = ["efectivo", "transferencia", "otro"] as const;

/** Un peso más que esto es un dedo pegado, no un cobro. */
const MAX_PESOS = 99_999_999;

const InputSchema = z.object({
  eaAppointmentId: z.number().int().positive(),
  performedServiceId: z.number().int().positive().nullable(),
  extras: z.record(z.string().regex(/^\d+$/), z.number().int().min(1).max(999)),
  manual: z
    .object({
      note: z.string().max(500),
      amount: z.number().int().min(-MAX_PESOS).max(MAX_PESOS),
    })
    .nullable(),
  totalOverride: z.number().int().min(0).max(MAX_PESOS).nullable(),
  varianceReasonCode: z.enum(REASONS).nullable(),
  varianceReason: z.string().max(500),
  notes: z.string().max(4000),
  paymentMethod: z.enum(METHODS).nullable(),
  tip: z.number().int().min(0).max(MAX_PESOS),
  clientRequestId: z.string().max(64),
});

function rechazo(message: string): CloseTicketResult {
  return { ok: false, retryable: false, message };
}

function masTarde(message: string): CloseTicketResult {
  return { ok: false, retryable: true, message };
}

export async function cerrarCuenta(input: CloseTicketInput): Promise<CloseTicketResult> {
  const parsed = InputSchema.safeParse(input);

  if (!parsed.success) {
    // No se le devuelve el detalle de zod a la pantalla: son rutas de campo que
    // no significan nada para la técnica. El detalle va al log del servidor,
    // que es donde alguien lo va a buscar.
    console.error("[hoy] cuenta con forma inválida", parsed.error.issues);
    return rechazo("La cuenta llegó incompleta. Vuelve a abrirla y guarda de nuevo.");
  }

  const data = parsed.data;

  let session;
  try {
    session = await requireCapability("cuenta:cerrar-propia");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) return rechazo("Tu rol no puede cerrar cuentas.");
    console.error("[hoy] no se pudo verificar la sesión", error);
    return masTarde("No se pudo verificar la sesión.");
  }

  // El método de pago es una capacidad aparte (`TICKET_STAFF_COBRA`). Se
  // **rechaza** en vez de descartarlo en silencio: guardar la cuenta sin el
  // método que la técnica sí registró la dejaría creyendo que quedó cobrada.
  if (data.paymentMethod !== null && !can(session.role, "cuenta:cobrar", { staffCobra: staffCobra() })) {
    return rechazo("En este estudio el método de pago lo registra recepción.");
  }

  // `getDb()` y `createEaClient()` **lanzan** si falta una variable de entorno.
  // Un throw acá llegaría al navegador como un digest opaco y la cola lo
  // trataría como red caída, reintentando para siempre contra un contenedor mal
  // configurado. Se convierte en un desenlace explícito, que además queda en el
  // log del servidor con el nombre de la variable.
  let db;
  let ea;
  try {
    db = getDb();
    ea = createEaClient();
  } catch (error) {
    unstable_rethrow(error);
    console.error("[hoy] el panel está mal configurado", error);
    return rechazo("El panel no está bien configurado. Avisa a la dueña.");
  }

  // --- La cita, desde EA (es quien manda sobre de quién es) ---------------
  let appointment;
  try {
    appointment = await ea.appointments.get(data.eaAppointmentId);
  } catch (error) {
    unstable_rethrow(error);
    // Sin la cita no se puede saber de quién es, y "no sé" se contesta que no.
    // Es transitorio: el reintento la va a encontrar cuando EA vuelva.
    return masTarde("La agenda no respondió. Se reintenta solo.");
  }

  try {
    await requireOwnProvider(appointment.providerId);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) return rechazo("Esta cita no es tuya.");
    throw error;
  }

  // --- La fila de plata ----------------------------------------------------
  //
  // Puede no existir: EA no reintenta sus webhooks y el reconcile corre de
  // noche. `upsertAppointmentFinance()` de B4 es el único lugar donde se crea, y
  // congela el precio con su marca; duplicar esa lógica acá sería tener dos
  // reglas para el mismo snapshot.
  const repos = repositories(db);
  let financeId: number;
  let existing;
  try {
    const outcome = await upsertAppointmentFinance({ db, ea }, appointment, "reconcile");
    financeId = outcome.financeId;
    existing = await repos.appointmentFinance.findById(financeId);
  } catch (error) {
    unstable_rethrow(error);
    console.error("[hoy] no se pudo asegurar la fila de plata", error);
    return masTarde("La base no respondió. Se reintenta solo.");
  }

  if (existing === undefined) {
    return masTarde("La cuenta desapareció entre dos consultas. Se reintenta solo.");
  }

  if (existing.day_close_id !== null) {
    // Después del cierre diario los números ya salieron hacia Strapi y Actual
    // Budget, y editarlos en sitio los desincroniza en silencio. La corrección
    // es un **ajuste** con su propio motivo, y esa pantalla es de C3/D1: acá se
    // rechaza de frente en vez de escribir algo que nadie va a poder conciliar.
    return rechazo("Esta cuenta ya entró al cierre del día. Corregirla exige un ajuste.");
  }

  // --- Los renglones, valorados acá ---------------------------------------
  const catalog = await loadCatalogForClose(db, ea).catch((error: unknown) => {
    unstable_rethrow(error);
    return null;
  });

  if (catalog === null) return masTarde("No se pudo leer el catálogo de EA. Se reintenta solo.");

  const draft: TicketDraft = {
    version: 1,
    eaAppointmentId: data.eaAppointmentId,
    performedServiceId: data.performedServiceId,
    extras: data.extras,
    manual: data.manual,
    totalOverride: data.totalOverride,
    varianceReasonCode: data.varianceReasonCode,
    varianceReason: data.varianceReason,
    notes: data.notes,
    paymentMethod: data.paymentMethod,
    tip: data.tip,
    updatedAt: Date.now(),
  };

  const { items } = draftToItems(draft, catalog, {
    bookedServiceId: existing.booked_service_id,
    bookedSnapshot: existing.service_price_snapshot,
  });

  let totals;
  try {
    totals =
      data.totalOverride === null
        ? validateTicketClose({
            items,
            discount: 0,
            tip: data.tip,
            varianceReasonCode: data.varianceReasonCode,
          })
        : cerrarConTotalEscrito(items, data.totalOverride, data.tip, data.varianceReasonCode);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TicketError) return rechazo(error.message);
    throw error;
  }

  // --- La escritura --------------------------------------------------------
  const now = new Date();
  // Se cobra siempre el mismo día: `paid_at` cae en la fecha de la cita, no en
  // la hora en que la técnica alcanzó a cerrar la cuenta. Sin método de pago
  // registrado no hay plata recibida todavía, así que queda `null` — es lo que
  // la pantalla de Caja tiene que reclamarle a recepción.
  const paidAt =
    data.paymentMethod === null ? null : (existing.appointment_start_at ?? now);

  const rows: Omit<NewAppointmentFinanceItem, "appointment_finance_id">[] = totals.lines.map(
    (line) => ({
      kind: line.kind,
      ea_service_id: line.eaServiceId ?? null,
      pricing_id: line.pricingId ?? null,
      qty: line.qty,
      unit_price_snapshot: line.unitPriceSnapshot,
      line_total: line.lineTotal,
      note: line.note ?? null,
    }),
  );

  const patch = {
    performed_service_id: data.performedServiceId,
    discount: totals.discount,
    tip: totals.tip,
    amount_charged: totals.amountCharged,
    payment_method: data.paymentMethod,
    paid_at: paidAt,
    service_notes: data.notes.trim() === "" ? null : data.notes,
    variance_reason_code: data.varianceReasonCode,
    // El CHECK `ck_af_variance_text_needs_code` rechaza un texto sin código: un
    // motivo huérfano no se puede agrupar en el reporte de variación, que es
    // para lo que existe.
    variance_reason:
      data.varianceReasonCode === null || data.varianceReason.trim() === ""
        ? null
        : data.varianceReason,
    closed_by: session.userId,
    closed_at: now,
  } as const;

  try {
    await db.transaction().execute(async (trx) => {
      const tx = repositories(trx);
      await tx.appointmentFinanceItems.replaceForFinance(financeId, rows);
      await tx.appointmentFinance.update(financeId, patch);
      // La cuenta se puede corregir; lo que no se puede es corregirla sin dejar
      // huella. El antes y el después van completos, en la misma transacción:
      // una bitácora que se escribe aparte es una bitácora que puede faltar.
      await tx.auditLog.append({
        actorUserId: session.userId,
        action: existing.closed_at === null ? "ticket.close" : "ticket.update",
        entity: "appointment_finance",
        entityId: financeId,
        before: {
          performed_service_id: existing.performed_service_id,
          discount: existing.discount,
          tip: existing.tip,
          amount_charged: existing.amount_charged,
          payment_method: existing.payment_method,
          closed_at: existing.closed_at,
        },
        after: { ...patch, clientRequestId: data.clientRequestId },
        reason: data.varianceReasonCode,
        at: now,
      });
    });
  } catch (error) {
    unstable_rethrow(error);
    console.error("[hoy] no se pudo guardar la cuenta", error);
    return masTarde("No se pudo guardar. Queda pendiente y se reintenta solo.");
  }

  revalidatePath("/hoy");

  return {
    ok: true,
    eaAppointmentId: data.eaAppointmentId,
    financeId,
    amountCharged: totals.amountCharged,
    tip: totals.tip,
    closedAt: instantToEaLocal(now),
  };
}

/**
 * El total escrito a mano.
 *
 * `ticketFromEnteredTotal()` traduce "cobré esto" a un descuento y rechaza
 * escribir de más; `validateTicketClose()` es el que exige el motivo. Se
 * encadenan en vez de reimplementar la resta acá — la regla de que un descuento
 * sin motivo no se guarda tiene que valer también para esta rama, y una copia
 * es una copia que se olvida de actualizar.
 */
function cerrarConTotalEscrito(
  items: ReturnType<typeof draftToItems>["items"],
  enteredAmount: number,
  tip: number,
  varianceReasonCode: CloseTicketInput["varianceReasonCode"],
) {
  const conTotal = ticketFromEnteredTotal(items, enteredAmount, tip);
  return validateTicketClose({
    items,
    discount: conTotal.discount,
    tip,
    varianceReasonCode,
  });
}

/**
 * `TICKET_STAFF_COBRA`, leído acá y no en `auth-policy.ts`, que es puro.
 *
 * Es la misma lectura que hace el DAL. Se repite en vez de exportarla porque
 * `lib/dal.ts` es de otro paquete y agregarle una función sería tocarlo; son
 * cinco caracteres y la semántica —ausente o distinto de `"true"` es **no**— es
 * la misma en los dos lugares.
 */
function staffCobra(): boolean {
  return process.env.TICKET_STAFF_COBRA === "true";
}
