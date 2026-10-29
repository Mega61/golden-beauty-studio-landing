"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import type { NewAppointmentFinanceItem } from "@/db/types";
import { instantToEaLocal } from "@/lib/ea";
import { createCachedEaClient, createEaClient } from "@/lib/ea/client";
import { ForbiddenError, requireCapability, requireOwnProvider } from "@/lib/dal";
import { can } from "@/lib/auth-policy";
import {
  TicketError,
  assertPaymentsCoverCharge,
  computeTicketTotals,
  ticketFromEnteredTotal,
  validateHouseCourtesyClose,
  validateTicketClose,
} from "@/lib/ticket";
import { upsertAppointmentFinance } from "@/jobs/snapshot";
import {
  DRAFT_VERSION,
  FIRST_VISIT_SLUG,
  MAX_ADDITIONAL_SERVICES,
  draftToItems,
  draftToPayments,
  promoDateOf,
  resolveDiscount,
  type ResolvedDiscount,
  type TicketDraft,
  type TicketPricing,
} from "@/components/ticket/draft";
import type { CloseTicketInput, CloseTicketResult } from "@/components/ticket/types";
import type { PaymentMethod } from "@/db/types";
import { canOpenAccount } from "@/lib/attendance";
import { marcarCompletadaAlCerrar } from "./attendance";
import { loadCatalogForClose } from "./catalog-server";
import { detectFirstVisit, type FirstVisitStatus } from "./first-visit";

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
 * **A Easy!Appointments no se le escriben ni las notas ni el servicio
 * realizado.** Las notas de una cita en EA se copian a la `description` del
 * evento de Google, que está compartido en solo lectura a un correo personal:
 * una observación interna sobre una clienta no puede terminar ahí. Y reescribir
 * `id_services` dispararía la notificación de "tu cita cambió" por algo que ya
 * pasó. EA guarda la reserva; el panel guarda la entrega.
 *
 * **La única excepción es el estado**, y es solo el estado: después de guardar,
 * la cita pasa a `Completada` (`marcarCompletadaAlCerrar()` en `attendance.ts`,
 * un `PUT` con `{ status }` y nada más). Sin eso una cita atendida y cobrada se
 * quedaba `Reservada` en EA para siempre, y la historia y la inasistencia
 * —que leen el estado de EA— contaban a cada clienta como nueva y dividían la
 * tasa por citas que nadie sabía cómo terminaron. Es mejor esfuerzo: si EA no
 * contesta, la cuenta igual queda guardada y la reconciliación nocturna lo
 * reintenta. El `PUT` sí sincroniza el evento de Google (cuyo contenido no
 * cambia), y EA avisa por correo "la cita cambió" a la clienta si tiene correo
 * y a la técnica si tiene sus notificaciones de EA prendidas.
 *
 * ## Cortesía de la casa
 *
 * Con `houseCourtesy` la cuenta se cierra con cobro cero, sin pagos ni propina,
 * motivo `cortesia` y la marca `is_house_courtesy` (migración `026`); la
 * liquidación le paga a la profesional sobre el precio de lista. **Tocar una
 * cortesía es de la dueña** (`cortesia:otorgar`): marcarla, mantenerla al
 * editar la cuenta, o quitarla. Una técnica que pudiera mantenerla podría
 * sumarle adicionales a una cuenta que nadie paga y cobrar comisión por ellos.
 *
 * ## Promos
 *
 * La hoja manda **si** aplicar la promo (`applyPromo`) y si la cerró como
 * primera visita (`firstVisit`); nunca cuánto. El descuento lo vuelve a
 * calcular `resolveDiscount()` —la misma función que pintó la hoja— con el
 * catálogo de acá y el día de la cita según EA, y se guarda como el `discount`
 * de la cuenta con el motivo `promo` (migración `027`) y la promo en
 * `variance_reason`. La cortesía gana siempre: con la casilla no hay promo.
 *
 * La primera visita **no** se reemplaza por lo que diga el historial: la
 * técnica cobró con lo que vio en la hoja, y cambiarlo acá movería un cobro que
 * ya se hizo. Se revisa el historial igual y se anota si coincidía, para que
 * un 10 % marcado a mano se vea como tal en la bitácora y en el reporte de
 * variación.
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
  payments: z
    .array(z.object({ method: z.enum(METHODS), amount: z.number().int().min(0).max(MAX_PESOS) }))
    .max(METHODS.length),
  tip: z.number().int().min(0).max(MAX_PESOS),
  // Opcional: un borrador que quedó en la cola antes de esta versión no lo trae,
  // y ausente es **no** — la cuenta se cobra como siempre.
  houseCourtesy: z.boolean().optional(),
  // Lo mismo con lo de las promos y los servicios agregados: ausente es no /
  // ninguno, que es lo que la técnica vio en una hoja de antes.
  additionalServiceIds: z
    .array(z.number().int().positive())
    .max(MAX_ADDITIONAL_SERVICES)
    .optional(),
  applyPromo: z.boolean().optional(),
  firstVisit: z.boolean().optional(),
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
  const houseCourtesy = data.houseCourtesy === true;

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
  if (data.payments.length > 0 && !can(session.role, "cuenta:cobrar", { staffCobra: staffCobra() })) {
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
    return rechazo("El panel no está bien configurado. Avisa a administración.");
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
  // Los pagos que la cuenta ya tenía, para la bitácora: el "antes" de una
  // corrección tiene que decir con qué se había cobrado, y eso ya no vive en la
  // fila del encabezado.
  let existingPayments: { method: PaymentMethod; amount: number }[] = [];
  try {
    const outcome = await upsertAppointmentFinance({ db, ea }, appointment, "reconcile");
    financeId = outcome.financeId;
    existing = await repos.appointmentFinance.findById(financeId);
    existingPayments = await repos.appointmentPayments.listByFinanceId(financeId);
  } catch (error) {
    unstable_rethrow(error);
    console.error("[hoy] no se pudo asegurar la fila de plata", error);
    return masTarde("La base no respondió. Se reintenta solo.");
  }

  if (existing === undefined) {
    return masTarde("La cuenta desapareció entre dos consultas. Se reintenta solo.");
  }

  // Antes del cierre diario, para que el mensaje sea el del permiso y no otro.
  // `existing` y no la entrada: quitarle la marca a una cortesía ya guardada
  // también es decidir sobre ella.
  if (
    (houseCourtesy || existing.is_house_courtesy === 1) &&
    !can(session.role, "cortesia:otorgar")
  ) {
    return rechazo(
      existing.is_house_courtesy === 1
        ? "Esta cuenta es una cortesía de la casa. Solo la dueña la puede cambiar."
        : "Solo la dueña puede cerrar una cuenta como cortesía de la casa.",
    );
  }

  // Una cancelada no se cobra: la pantalla ya no ofrece el botón, pero un
  // borrador viejo en la cola del celular o una pantalla abierta desde antes de
  // cancelar todavía pueden llegar. Definitivo, no reintentable.
  if (!canOpenAccount(appointment.status, existing.closed_at !== null)) {
    return rechazo(
      "La cita está cancelada, así que no hay cuenta que cerrar. Si sí se cobró algo, cámbiale el estado en la agenda primero.",
    );
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
    version: DRAFT_VERSION,
    eaAppointmentId: data.eaAppointmentId,
    performedServiceId: data.performedServiceId,
    additionalServices: data.additionalServiceIds ?? [],
    extras: data.extras,
    manual: data.manual,
    totalOverride: data.totalOverride,
    varianceReasonCode: data.varianceReasonCode,
    varianceReason: data.varianceReason,
    notes: data.notes,
    payments: data.payments,
    tip: data.tip,
    houseCourtesy,
    applyPromo: data.applyPromo === true,
    firstVisit: data.firstVisit === true,
    updatedAt: Date.now(),
  };

  const pricing: TicketPricing = {
    bookedServiceId: existing.booked_service_id,
    bookedSnapshot: existing.service_price_snapshot,
    // El día de la cita según EA, no el de hoy ni el que diga el navegador: la
    // promo del miércoles es de la cita del miércoles.
    promoDate: promoDateOf(appointment.start),
  };

  const { items } = draftToItems(draft, catalog, pricing);

  let totals;
  let resolved: ResolvedDiscount | null = null;
  try {
    if (houseCourtesy) {
      // La cortesía no tiene total escrito, ni motivo que elegir, ni promo: el
      // total es cero y el motivo es ella misma. Lo que no puede traer
      // (propina, pago) lo rechaza `lib/ticket.ts`, no esta función.
      totals = validateHouseCourtesyClose({ items, tip: data.tip, payments: data.payments });
    } else {
      const subtotal = computeTicketTotals(items, 0, data.tip).subtotal;
      resolved = resolveDiscount(draft, items, subtotal, pricing);
      totals =
        data.totalOverride === null
          ? validateTicketClose({
              items,
              discount: resolved.discount,
              tip: data.tip,
              varianceReasonCode: resolved.varianceReasonCode,
            })
          : // `ticketFromEnteredTotal()` traduce "cobré esto" a un descuento,
            // rechaza escribir de más y —con el motivo que se le pasa— exige
            // uno si quedó por debajo de la lista. Antes el motivo no se le
            // pasaba, y un total escrito por debajo de la lista se rechazaba
            // aunque la técnica hubiera elegido el motivo.
            ticketFromEnteredTotal(items, data.totalOverride, data.tip, {
              varianceReasonCode: resolved.varianceReasonCode,
            });
    }
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TicketError) return rechazo(error.message);
    throw error;
  }

  // El 10 % lo decidió la hoja; acá solo se anota si el historial estaba de
  // acuerdo. Una sola consulta y solo cuando hace falta: EA corta a 100
  // peticiones cada 120 s y todo el panel es una sola IP.
  let firstVisitCheck: FirstVisitStatus | null = null;
  if (resolved?.promo?.slug === FIRST_VISIT_SLUG) {
    firstVisitCheck = await detectFirstVisit(ea, appointment);
  }

  // --- La escritura --------------------------------------------------------
  const now = new Date();
  // Se cobra siempre el mismo día: `paid_at` cae en la fecha de la cita, no en
  // la hora en que la técnica alcanzó a cerrar la cuenta. Sin método de pago
  // registrado no hay plata recibida todavía, así que queda `null` — es lo que
  // la pantalla de Caja tiene que reclamarle a recepción.
  // Los pagos definitivos los resuelve el servidor, no la pantalla: con un solo
  // método el monto es **todo lo cobrado**, y el total definitivo lo acaba de
  // calcular esta función. Con dos, los montos vienen escritos y solo se
  // verifican.
  const payments = houseCourtesy ? [] : draftToPayments(draft, totals.amountCharged);

  try {
    assertPaymentsCoverCharge(payments, totals.amountCharged);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TicketError) return rechazo(error.message);
    throw error;
  }

  const paidAt = payments.length === 0 ? null : (existing.appointment_start_at ?? now);

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

  // Una cortesía se registra con el motivo `cortesia` siempre, lo haya elegido
  // alguien o no: es lo que la agrupa en la bitácora y en Diagnóstico sin tener
  // que leer la columna nueva. Sin texto libre — el motivo es la casilla. Una
  // promo, con `promo` y cuál fue; el resto, con lo que eligió la técnica.
  const varianceReasonCode = houseCourtesy ? "cortesia" : (resolved?.varianceReasonCode ?? null);
  const varianceText = houseCourtesy
    ? ""
    : resolved?.promo
      ? promoReasonText(resolved.promo.slug, firstVisitCheck)
      : data.varianceReason;

  const patch = {
    performed_service_id: data.performedServiceId,
    discount: totals.discount,
    tip: totals.tip,
    amount_charged: totals.amountCharged,
    is_house_courtesy: houseCourtesy ? 1 : 0,
    // Shim de rollback, no fuente de verdad: la fuente es `appointment_payment`.
    // Con un solo método se escribe ése, y con dos queda en `null` — el código
    // de la imagen anterior lo muestra como "sin método", que es visible y
    // reclamable, en vez de afirmar un método que no fue.
    payment_method: payments.length === 1 ? payments[0].method : null,
    paid_at: paidAt,
    service_notes: data.notes.trim() === "" ? null : data.notes,
    variance_reason_code: varianceReasonCode,
    // El CHECK `ck_af_variance_text_needs_code` rechaza un texto sin código: un
    // motivo huérfano no se puede agrupar en el reporte de variación, que es
    // para lo que existe.
    variance_reason:
      houseCourtesy || varianceReasonCode === null || varianceText.trim() === ""
        ? null
        : varianceText,
    closed_by: session.userId,
    closed_at: now,
  } as const;

  try {
    await db.transaction().execute(async (trx) => {
      const tx = repositories(trx);
      await tx.appointmentFinanceItems.replaceForFinance(financeId, rows);
      await tx.appointmentPayments.replaceForFinance(
        financeId,
        payments.map((payment) => ({ method: payment.method, amount: payment.amount })),
      );
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
          is_house_courtesy: existing.is_house_courtesy,
          payments: existingPayments.map((payment) => ({
            method: payment.method,
            amount: payment.amount,
          })),
          closed_at: existing.closed_at,
        },
        after: {
          ...patch,
          clientRequestId: data.clientRequestId,
          // Qué promo se aplicó y con qué datos, para que una cuenta con
          // descuento automático se pueda explicar sin recalcular nada.
          promo:
            resolved?.promo == null
              ? null
              : {
                  slug: resolved.promo.slug,
                  discount: resolved.promo.discount,
                  date: pricing.promoDate ?? null,
                  firstVisitClaimed: draft.firstVisit,
                  firstVisitHistory: firstVisitCheck,
                },
        },
        reason: varianceReasonCode,
        at: now,
      });
    });
  } catch (error) {
    unstable_rethrow(error);
    console.error("[hoy] no se pudo guardar la cuenta", error);
    return masTarde("No se pudo guardar. Queda pendiente y se reintenta solo.");
  }

  await marcarCompletadaAlCerrar(ea, appointment);

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
 * El texto que acompaña al motivo `promo`: cuál fue, y —si fue el 10 % de
 * primera visita— si el historial lo respaldaba. `draftFromFinance()` lee el
 * prefijo para reabrir la cuenta con la casilla puesta, así que el slug va
 * siempre primero.
 */
function promoReasonText(slug: string, firstVisitCheck: FirstVisitStatus | null): string {
  if (slug !== FIRST_VISIT_SLUG || firstVisitCheck === null || firstVisitCheck === "primera") {
    return slug;
  }
  return firstVisitCheck === "recurrente"
    ? `${slug} · marcada a mano: el historial dice que ya vino`
    : `${slug} · sin confirmar en el historial`;
}

/**
 * **¿Es su primera visita?**, para la hoja que se acaba de abrir.
 *
 * Se pregunta al abrir la cuenta y no al cargar Hoy: revisar el historial de
 * una clienta son varias lecturas a EA (una búsqueda por cada forma de escribir
 * su teléfono, más sus citas), y hacerlo para todas las citas del día en cada
 * recarga se comería el cupo de EA —100 peticiones cada 120 s para todo el
 * panel—. Lectura con caché: no decide ninguna escritura, solo el valor inicial
 * de una casilla que la técnica puede cambiar.
 *
 * Nunca lanza: cualquier duda es `desconocido`, que la hoja trata como no.
 */
export async function revisarPrimeraVisita(eaAppointmentId: number): Promise<FirstVisitStatus> {
  if (!Number.isSafeInteger(eaAppointmentId) || eaAppointmentId <= 0) return "desconocido";

  try {
    await requireCapability("cuenta:cerrar-propia");
    const ea = createCachedEaClient();
    const appointment = await ea.appointments.get(eaAppointmentId);
    await requireOwnProvider(appointment.providerId);
    return await detectFirstVisit(ea, appointment);
  } catch (error) {
    unstable_rethrow(error);
    return "desconocido";
  }
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
