import "server-only";

import {
  isDuplicateKeyError,
  JOB_DAY_CLOSE_PUSH,
  repositories,
  type Db,
} from "@/db";
import type { AppointmentFinance, AuthId, Cop, DayClose } from "@/db/types";
import {
  EA_TIME_ZONE,
  eaLocalToInstant,
  instantToEaDate,
  parseEaLocalDateTime,
  type EaLocalDate,
  type EaLocalDateTime,
} from "@/lib/ea";
import { mapEaStatus } from "@/components/calendar/status-map";
import { IngestError, type IngestClient } from "@/lib/ingest-client";
import {
  buildDayClosePayments,
  buildIngestAdjustment,
  IngestPayloadError,
  type FinanceForIngest,
  type IngestPayment,
} from "@/lib/ingest-payload";

/**
 * El cierre diario: la compuerta, los totales y el push a ingest.
 *
 * ## La compuerta es la funcionalidad
 *
 * "Se cobra el mismo día, siempre" no es un supuesto contable, es una regla que
 * el panel **impone**: `paid_at` cae en la fecha de la cita y base caja = base
 * servicio. Se implementa como compuerta y no como confianza —
 * **no se puede cerrar el día si queda una cita atendida sin cuenta cerrada** —
 * y la lista de pendientes de Caja es esa compuerta hecha visible. Cerrar el
 * día es el acto que la vacía.
 *
 * ## El push va por cierre diario, nunca por cita
 *
 * Actual Budget deduplica por `imported_id` y **no actualiza** el monto de una
 * transacción ya importada. Empujar al cerrar cada cuenta dejaría a Actual con
 * la cifra vieja para siempre si alguien corrige un ticket a las 3 p. m., sin
 * error visible en ninguna parte. Empujando al cierre del día las correcciones
 * intradía salen gratis, y una corrección **posterior** al cierre viaja como
 * ajuste con id propio (`recordAdjustment()`), nunca reescribiendo el original.
 *
 * ## Dónde vive la llave de idempotencia, exactamente
 *
 * Este archivo habla de `imported_id` porque es la llave con la que Actual
 * Budget deduplica, pero **el panel no la escribe**: escribe el `tx_id` de la
 * fila `Payment` de Strapi, y `automation/actual-sync/sync.mjs` del CRM le pega
 * el prefijo (`` `agendapro-tx:${tx_id}` ``). La cadena completa —qué campo del
 * cuerpo lleva qué id— vive en `lib/ingest-client.ts`, que es el único que
 * conoce el esquema del CRM. Lo único que importa acá: cada movimiento tiene
 * una llave estable y distinta, y reenviar el mismo lote no crea uno nuevo.
 *
 * ## Qué está y qué no está en este archivo
 *
 * Está la orquestación y las dos funciones puras que el plan pide que existan
 * en un solo lugar: `reviewDay()` (la compuerta) y `summarizeDayTotals()` (los
 * totales por método). **No está ninguna forma de cuerpo de Strapi**: los
 * movimientos los arma `lib/ingest-payload.ts` y los manda
 * `lib/ingest-client.ts`, que es el único que conoce la URL, el header y el
 * sobre.
 *
 * Nota de propiedad: `summarizeDayTotals()` vive acá y no en `lib/` porque B1
 * no entregó una función de agregación por día —`ticket.ts` cierra *una* cuenta,
 * `metrics.ts` define ocupación y retención— y los archivos de `lib/` que
 * calculan plata son de otro paquete. Es pura, está testeada, y mudarla a
 * `lib/` el día que convenga es un `git mv`.
 */

// ── Lo que el día es, como dato ─────────────────────────────────────────────

/**
 * Una cuenta del día, reducida a lo que la caja necesita.
 *
 * Extiende `FinanceForIngest` de B1 en vez de declarar los mismos campos otra
 * vez: así el lote del push se arma pasando estas filas tal cual, y si mañana
 * B1 le agrega un campo obligatorio, esto no compila — que es exactamente el
 * aviso que uno quiere.
 */
export type DayAccount = FinanceForIngest & {
  financeId: number;
  /** `null` = la cuenta no está cerrada. */
  closedAt: Date | null;
  /** `null` = todavía no entró a ningún cierre. */
  dayCloseId: number | null;
  pushedToIngestAt: Date | null;
};

/**
 * Una cita del día según EA, reducida a lo que la compuerta necesita.
 *
 * La carga la hace quien llama (`(panel)/caja/data.ts`), no este módulo: el
 * cruce entre `easyappointments` y `gbs_admin` es en memoria porque se leen con
 * usuarios de MySQL distintos, y la pantalla ya lo hace para pintar la lista.
 * Que entre como dato es lo que deja `reviewDay()` pura.
 */
export type DayAppointment = {
  eaAppointmentId: number;
  /** El `status` **crudo** de EA. Es texto libre; lo traduce `mapEaStatus()`. */
  status: string;
  start: EaLocalDateTime;
  end: EaLocalDateTime;
  customerName: string;
  providerName: string;
};

/** Fila de plata → la forma que este módulo y el push consumen. */
export function toDayAccount(row: AppointmentFinance): DayAccount {
  return {
    financeId: row.id,
    eaAppointmentId: row.ea_appointment_id,
    amountCharged: row.amount_charged,
    tip: row.tip,
    paymentMethod: row.payment_method,
    // Base caja: se cobra siempre el mismo día, así que la fecha del cobro es
    // la del instante que la cuenta guardó — no la del proceso que lo lee.
    paidOn: row.paid_at === null ? null : instantToEaDate(row.paid_at),
    eaProviderId: row.ea_provider_id,
    performedServiceId: row.performed_service_id,
    closedAt: row.closed_at,
    dayCloseId: row.day_close_id,
    pushedToIngestAt: row.pushed_to_ingest_at,
  };
}

// ── Totales ─────────────────────────────────────────────────────────────────

export type DayTotals = {
  efectivo: Cop;
  transferencia: Cop;
  otro: Cop;
  /**
   * Cobrado en cuentas cerradas **sin método asignado**.
   *
   * No entra a ninguna de las tres columnas de arriba y por eso existe: sin
   * este campo, esa plata desaparecería de la pantalla y el total del día
   * cuadraría con una cifra equivocada. Que se vea es lo que hace que
   * recepción la reclame — y mientras sea distinta de cero, el día no cierra.
   */
  sinMetodo: Cop;
  /** Aparte, siempre. Nunca entra al ingreso ni a la base de comisión. */
  tips: Cop;
  /** Cuentas cerradas contadas. */
  count: number;
  /** Ingreso del estudio: los tres métodos más lo que falta asignar. */
  ingreso: Cop;
};

const CERO: DayTotals = {
  efectivo: 0,
  transferencia: 0,
  otro: 0,
  sinMetodo: 0,
  tips: 0,
  count: 0,
  ingreso: 0,
};

/**
 * Los totales del día por método de pago, con las propinas aparte.
 *
 * Suma **solo cuentas cerradas**: una cita sin cuenta no tiene monto, y contarla
 * como cero haría que el total del día bajara sin que nada se viera roto.
 *
 * Una cuenta cerrada con `amount_charged` en `null` es un estado que no debería
 * existir (`validateTicketClose()` siempre lo fija), así que se cuenta como
 * cero y `reviewDay()` la marca como incompleta: es la misma disciplina de B1 —
 * un cero que no se sabe si es un cero se **marca**, no se acepta.
 */
export function summarizeDayTotals(accounts: readonly DayAccount[]): DayTotals {
  const totals: DayTotals = { ...CERO };

  for (const account of accounts) {
    if (account.closedAt === null) continue;

    const amount = account.amountCharged ?? 0;
    totals.count += 1;
    totals.tips += account.tip;
    totals.ingreso += amount;

    switch (account.paymentMethod) {
      case "efectivo":
        totals.efectivo += amount;
        break;
      case "transferencia":
        totals.transferencia += amount;
        break;
      case "otro":
        totals.otro += amount;
        break;
      default:
        totals.sinMetodo += amount;
        break;
    }
  }

  return totals;
}

/** Los totales tal como quedan en la fila `day_close`. */
export function totalsOf(row: DayClose): DayTotals {
  return {
    efectivo: row.total_efectivo,
    transferencia: row.total_transferencia,
    otro: row.total_otro,
    sinMetodo: 0,
    tips: row.total_tips,
    count: row.appointment_count,
    ingreso: row.total_efectivo + row.total_transferencia + row.total_otro,
  };
}

// ── La compuerta ────────────────────────────────────────────────────────────

/**
 * Lo que le falta al día.
 *
 * - `sin-cuenta` — la cita ya pasó (o EA la marca completada) y nadie cerró su
 *   cuenta. **Bloquea.** Es el pendiente del que habla el plan.
 * - `en-curso` — la cita todavía no terminó. **No bloquea**, y se muestra igual
 *   porque la lista de pendientes se consulta desde el celular a media tarde
 *   para saber qué falta, no solo a las ocho para cerrar.
 * - `cuenta-incompleta` — la cuenta está cerrada pero le falta el método de
 *   pago, el monto o la fecha de caja. **Bloquea**: sin método esa plata no
 *   entra a ninguna columna del cierre y `buildIngestPayment()` la rechazaría a
 *   mitad del push.
 */
export type DayIssueKind = "sin-cuenta" | "en-curso" | "cuenta-incompleta";

export type DayIssue = {
  kind: DayIssueKind;
  blocks: boolean;
  eaAppointmentId: number;
  /** `null` cuando la cita no está en la respuesta de EA. */
  start: EaLocalDateTime | null;
  customerName: string;
  providerName: string;
  /** El `status` crudo de EA, para que la pantalla dibuje su pastilla. */
  status: string;
  /** Lo cobrado, cuando la cuenta existe. */
  amountCharged: Cop | null;
  message: string;
};

export type DayReview = {
  date: EaLocalDate;
  /**
   * Las citas del día según EA, o `null` si no respondió.
   *
   * Se devuelven porque `DayAccount` no tiene con qué nombrar a la clienta —es
   * la forma que viaja al push, y ahí un nombre no tiene nada que hacer— y una
   * lista de cuentas que dice "#101" en vez de "Marcela Ríos" no le sirve a la
   * recepción para cuadrar la caja. El cruce lo hace la pantalla, por
   * `ea_appointment_id`, que es la única llave que las dos fuentes comparten.
   */
  appointments: readonly DayAppointment[] | null;
  /** Las cuentas cerradas del día. La base del cierre y del push. */
  closed: DayAccount[];
  /** Todo lo que falta, bloquee o no. En orden de cita. */
  issues: DayIssue[];
  totals: DayTotals;
  /**
   * Impedimentos que no son de una cita concreta: EA sin responder, un total
   * negativo. Van aparte porque no se arreglan cerrando una cuenta.
   */
  blockers: string[];
  canClose: boolean;
};

export type ReviewDayInput = {
  date: EaLocalDate;
  /** Las citas del día según EA, o `null` si EA no respondió. */
  appointments: readonly DayAppointment[] | null;
  /** Las filas de plata del día. */
  accounts: readonly DayAccount[];
  now: Date;
};

/**
 * La compuerta, como función pura.
 *
 * Está acá y no dentro de la Server Action por la razón de siempre: es la
 * decisión que separa "la caja cuadra" de "faltan tres cuentas y nadie se
 * enteró", y una decisión así se testea con una tabla de casos, no probándola a
 * mano una vez.
 *
 * **Si EA no respondió, el día no se cierra.** No es cautela genérica: la única
 * forma de saber qué citas hubo es preguntárselo a EA. Cerrar a ciegas armaría
 * el lote con las cuentas que sí existen y empujaría un día al que le falta la
 * mitad — y como Actual no actualiza montos, esa mitad no se puede agregar
 * después sin ajustes uno por uno.
 */
export function reviewDay(input: ReviewDayInput): DayReview {
  const { date, appointments, accounts, now } = input;

  const byEaId = new Map(accounts.map((a) => [a.eaAppointmentId, a]));
  const issues: DayIssue[] = [];
  const blockers: string[] = [];

  for (const appointment of appointments ?? []) {
    const token = mapEaStatus(appointment.status);

    // Cancelada o inasistencia: no se espera plata. Si de todos modos tiene
    // cuenta cerrada —un renglón manual en cero por el retoque, o un cobro que
    // sí se hizo— la fila entra al cierre por el camino de las cuentas, abajo.
    if (token === "cancelada" || token === "no-asistio") continue;

    const account = byEaId.get(appointment.eaAppointmentId);
    if (account !== undefined && account.closedAt !== null) continue;

    const termino = eaLocalToInstant(appointment.end, EA_TIME_ZONE).getTime() <= now.getTime();

    // Un estado que el panel no reconoce se trata como si esperara plata en
    // cuanto la cita terminó. Es la dirección segura: aparece en la lista,
    // recepción lo ve y arregla el estado en EA. Al revés —darlo por
    // irrelevante— es cómo un día cierra sin una cuenta que sí existía.
    if (token === "completada" || termino) {
      issues.push({
        kind: "sin-cuenta",
        blocks: true,
        eaAppointmentId: appointment.eaAppointmentId,
        start: appointment.start,
        customerName: appointment.customerName,
        providerName: appointment.providerName,
        status: appointment.status,
        amountCharged: account?.amountCharged ?? null,
        message: "Sin cuenta cerrada",
      });
      continue;
    }

    issues.push({
      kind: "en-curso",
      blocks: false,
      eaAppointmentId: appointment.eaAppointmentId,
      start: appointment.start,
      customerName: appointment.customerName,
      providerName: appointment.providerName,
      status: appointment.status,
      amountCharged: null,
      message: "Todavía no terminó",
    });
  }

  const closed = accounts.filter((a) => a.closedAt !== null);
  const appointmentById = new Map(
    (appointments ?? []).map((a) => [a.eaAppointmentId, a]),
  );

  for (const account of closed) {
    const falta = missingOf(account);
    if (falta === null) continue;

    const appointment = appointmentById.get(account.eaAppointmentId);
    issues.push({
      kind: "cuenta-incompleta",
      blocks: true,
      eaAppointmentId: account.eaAppointmentId,
      start: appointment?.start ?? null,
      customerName: appointment?.customerName ?? `Cita #${account.eaAppointmentId}`,
      providerName: appointment?.providerName ?? "—",
      status: appointment?.status ?? "",
      amountCharged: account.amountCharged,
      message: falta,
    });
  }

  issues.sort(
    (a, b) =>
      (a.start ?? "").localeCompare(b.start ?? "") ||
      a.eaAppointmentId - b.eaAppointmentId,
  );

  const totals = summarizeDayTotals(closed);

  if (appointments === null) {
    blockers.push(
      "La agenda no responde, así que no se puede saber qué citas hubo hoy. " +
        "El cierre queda bloqueado hasta que vuelva.",
    );
  }

  // Un total negativo por método no puede entrar a `day_close`: el CHECK
  // `ck_day_close_totals` lo rechazaría y el cierre fallaría con un error de
  // SQL en vez de con una explicación. Se atrapa acá para que diga qué pasa.
  if (totals.efectivo < 0 || totals.transferencia < 0 || totals.otro < 0) {
    blockers.push(
      "Algún total por método quedó negativo. Revisa las cuentas con renglones " +
        "en negativo antes de cerrar.",
    );
  }

  return {
    date,
    appointments,
    closed,
    issues,
    totals,
    blockers,
    canClose: blockers.length === 0 && !issues.some((i) => i.blocks),
  };
}

/** Qué le falta a una cuenta cerrada para poder viajar, o `null` si nada. */
function missingOf(account: DayAccount): string | null {
  if (account.amountCharged === null) {
    return "Sin monto cobrado";
  }
  if (account.paymentMethod === null) {
    return "Falta el método de pago";
  }
  if (account.paidOn === null) {
    return "Falta la fecha de caja";
  }
  return null;
}

/** Los pendientes que de verdad impiden cerrar. Atajo para la pantalla. */
export function blockingIssues(review: DayReview): DayIssue[] {
  return review.issues.filter((i) => i.blocks);
}

// ── Orquestación ────────────────────────────────────────────────────────────

/**
 * De dónde salen las citas del día.
 *
 * Entra como función y no como cliente de EA para que `closeDay()` no tenga que
 * saber cómo se piden las relaciones (`with=service,provider,customer` viene en
 * snake_case y necesita el decodificador de A1), y para que el test de capa 2
 * pueda inyectar un día entero sin levantar un EA.
 *
 * **`closeDay()` la vuelve a llamar aunque la pantalla ya la haya llamado.** La
 * compuerta se evalúa en el servidor, en el momento del cierre, con los datos
 * de ese momento: entre que se pintó la pantalla y que alguien apretó el botón
 * pudo cerrarse una cuenta, o aparecer una cita.
 */
export type DayAppointmentSource = (
  date: EaLocalDate,
) => Promise<readonly DayAppointment[]>;

export type DayCloseDeps = {
  db: Db;
  loadAppointments: DayAppointmentSource;
  /**
   * `null` = el push está apagado (`INGEST_URL` ausente).
   *
   * No es un caso degradado que haya que arreglar: hoy el contrato del cuerpo
   * no está verificado contra el CRM, y cerrar la caja del estudio no puede
   * depender de eso. El día se cierra, se registra que no se empujó, y Caja lo
   * dice.
   */
  ingest: IngestClient | null;
};

/** Qué pasó con el push. Lo muestra Caja tal cual. */
export type PushOutcome =
  | { state: "hecho"; at: Date; sent: number }
  | { state: "apagado" }
  | { state: "vacio" }
  | { state: "ya"; at: Date }
  /**
   * Otra llamada simultánea se está encargando del push de este cierre.
   *
   * Existe para **no mandar el lote dos veces**. Cuando dos personas cierran el
   * día a la vez, `uq_day_close_date` deja una sola fila pero las dos llamadas
   * llegarían al push, las dos leyendo `pushed_to_ingest_at` todavía en `null`.
   * Los `imported_id` son los mismos, así que Actual Budget no crearía un
   * movimiento duplicado — pero **la ruta de ingest del CRM no está verificada**
   * y no se puede afirmar que sea idempotente. La que perdió el INSERT no
   * empuja; si la ganadora falla, el día queda en la cola de reintento, que es
   * donde tiene que estar.
   */
  | { state: "pendiente" }
  | { state: "fallo"; message: string; retryable: boolean };

export type CloseDayResult =
  | { ok: false; reason: "compuerta"; review: DayReview }
  | { ok: false; reason: "lote"; message: string }
  | {
      ok: true;
      dayCloseId: number;
      /** `false` = el día ya estaba cerrado y no se creó una segunda fila. */
      created: boolean;
      totals: DayTotals;
      push: PushOutcome;
    };

/**
 * Cerrar el día.
 *
 * ## Idempotente por diseño, en los dos niveles
 *
 * 1. **El `day_close`.** Se busca el del día *antes* de evaluar la compuerta.
 *    Si ya existe, no se inserta otra fila y no se vuelve a juzgar el día — está
 *    cerrado. Lo que sí se hace es continuar al push, porque el caso normal de
 *    apretar el botón dos veces es "el primer intento cerró pero el push falló".
 *    `uq_day_close_date` cubre además la carrera de dos personas apretando a la
 *    vez: el segundo INSERT choca y se resuelve leyendo el que ganó.
 * 2. **El push.** Si la fila ya tiene `pushed_to_ingest_at`, no se manda de
 *    nuevo. Y si se mandara, el lote llevaría los mismos `imported_id` y ni
 *    Strapi ni Actual crearían un movimiento nuevo.
 *
 * ## El lote se arma antes de escribir
 *
 * `buildDayClosePayments()` corre **antes** del INSERT. Si una sola cuenta del
 * día está mal, no queda un `day_close` a medio hacer: no se escribió nada.
 */
export async function closeDay(
  deps: DayCloseDeps,
  input: { date: EaLocalDate; closedBy: AuthId; now?: Date },
): Promise<CloseDayResult> {
  const now = input.now ?? new Date();
  const repos = repositories(deps.db);

  const existing = await repos.dayCloses.findByDate(input.date);
  if (existing !== undefined) {
    return {
      ok: true,
      dayCloseId: existing.id,
      created: false,
      totals: totalsOf(existing),
      push: await pushClose(deps, existing, now),
    };
  }

  const review = await loadReview(deps, input.date, now);
  if (!review.canClose) return { ok: false, reason: "compuerta", review };

  // La última compuerta antes de que la cifra salga del panel. Un `imported_id`
  // repetido en el mismo lote, un método que el enum de Strapi no acepta, una
  // fecha de caja inválida: todo eso lanza acá, con el día todavía sin cerrar.
  //
  // **Este `catch` no tiene test y no se le puede escribir uno**: `reviewDay()`
  // ya bloquea cada condición que haría lanzar a `buildDayClosePayments()`
  // sobre `review.closed`, y la que queda —dos movimientos con la misma llave—
  // la impide `uq_af_ea_appointment`. Se conserva porque las dos funciones
  // pueden divergir, y el modo de falla que evita es "medio día empujado a
  // Actual Budget y un error a la mitad", del que hay que salir a mano. La
  // versión alcanzable de esta misma guarda sí está testeada, en `pushClose()`:
  // ahí el lote se arma desde la base y una fila corrompida después del cierre
  // llega hasta acá.
  try {
    buildDayClosePayments(review.closed);
  } catch (error) {
    if (error instanceof IngestPayloadError) {
      return { ok: false, reason: "lote", message: error.message };
    }
    throw error;
  }

  const { totals, closed } = review;

  let dayCloseId: number;
  let created: boolean;

  try {
    dayCloseId = await deps.db.transaction().execute(async (trx) => {
      const tx = repositories(trx);
      const id = await tx.dayCloses.insert({
        close_date: input.date,
        total_efectivo: totals.efectivo,
        total_transferencia: totals.transferencia,
        total_otro: totals.otro,
        total_tips: totals.tips,
        appointment_count: totals.count,
        closed_by: input.closedBy,
        closed_at: now,
      });

      // Congelar las cuentas bajo su cierre. Desde acá, corregirlas exige un
      // ajuste: los números ya son los que salieron —o van a salir— hacia
      // Strapi y Actual Budget.
      await tx.appointmentFinance.attachToDayClose(
        closed.map((a) => a.financeId),
        id,
      );

      await tx.auditLog.append({
        actorUserId: input.closedBy,
        action: "day.close",
        entity: "day_close",
        entityId: id,
        after: { date: input.date, ...totals, accounts: closed.length },
        at: now,
      });

      return id;
    });
    created = true;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // Dos personas apretaron el botón a la vez. El día se cerró una sola vez,
    // que es lo correcto; esta llamada se queda con el que ganó.
    const winner = await repos.dayCloses.findByDate(input.date);
    if (winner === undefined) throw error;
    return {
      ok: true,
      dayCloseId: winner.id,
      created: false,
      totals: totalsOf(winner),
      // **Esta llamada no empuja.** La que ganó el INSERT ya está en eso, y
      // mandar el mismo lote por dos conexiones a la vez es la única forma de
      // duplicar movimientos que las llaves no cubren: dependería de que la
      // ruta de ingest del CRM sea idempotente, y eso está sin verificar. Si
      // la ganadora falla, el día queda sin marca y el reintento lo agarra.
      push:
        winner.pushed_to_ingest_at === null
          ? { state: "pendiente" }
          : { state: "ya", at: winner.pushed_to_ingest_at },
    };
  }

  const row = await repos.dayCloses.findById(dayCloseId);
  const push =
    row === undefined
      ? ({ state: "fallo", message: "El cierre desapareció entre dos consultas.", retryable: true } as const)
      : await pushClose(deps, row, now);

  return { ok: true, dayCloseId, created, totals, push };
}

/** La revisión del día, con la plata y la agenda ya cruzadas. */
export async function loadReview(
  deps: Pick<DayCloseDeps, "db" | "loadAppointments">,
  date: EaLocalDate,
  now: Date,
): Promise<DayReview> {
  const repos = repositories(deps.db);
  const [dayStart, dayEnd] = dayBounds(date);

  const rows = await repos.appointmentFinance.listByStartRange(dayStart, dayEnd);

  let appointments: readonly DayAppointment[] | null = null;
  try {
    appointments = await deps.loadAppointments(date);
  } catch (error) {
    // No se propaga: un día sin agenda igual tiene que poder verse, con la
    // compuerta bloqueada y el motivo escrito. El detalle va al log.
    console.error("[caja] no se pudieron leer las citas del día", error);
  }

  return reviewDay({
    date,
    appointments,
    accounts: rows.map(toDayAccount),
    now,
  });
}

/** Los dos instantes que delimitan un día del estudio. `to` exclusivo. */
export function dayBounds(date: EaLocalDate): [Date, Date] {
  const start = eaLocalToInstant(parseEaLocalDateTime(`${date} 00:00:00`), EA_TIME_ZONE);
  return [start, new Date(start.getTime() + 24 * 60 * 60 * 1000)];
}

// ── El push ─────────────────────────────────────────────────────────────────

/** Qué pasó con el push, en una línea. Es lo que queda en `job_run.summary`. */
export function summarizePush(row: DayClose, outcome: PushOutcome): string {
  const day = `cierre ${row.close_date}`;

  switch (outcome.state) {
    case "hecho":
      return `${day}: ${outcome.sent} movimiento(s) enviados`;
    case "ya":
      return `${day}: ya se había empujado, no se manda de nuevo`;
    case "vacio":
      return `${day}: sin movimientos que empujar`;
    case "apagado":
      return `${day}: el push está apagado (falta INGEST_URL)`;
    case "pendiente":
      return `${day}: otra llamada se está encargando del push`;
    case "fallo":
      return `${day}: falló — ${outcome.message}`;
  }
}

/**
 * Empuja el lote de un cierre y **deja constancia de que corrió**.
 *
 * La fila de `job_run` es para Diagnóstico, y responde algo que
 * `pushed_to_ingest_at` no puede: esa columna dice si el push *llegó*, no si se
 * intentó. Un intento que terminó en "no había nada que empujar" o en "el push
 * está apagado" no deja marca en ninguna otra parte, y son justamente los casos
 * que se confunden con "nadie apretó el botón".
 *
 * **La constancia es mejor esfuerzo.** Un fallo al escribir la bitácora no
 * puede cambiar el resultado del push ni tumbar el cierre del día: la plata ya
 * viajó o ya falló, y esa es la información que la pantalla necesita. Se grita
 * al log del contenedor y se sigue.
 */
async function pushClose(
  deps: DayCloseDeps,
  row: DayClose,
  now: Date,
): Promise<PushOutcome> {
  const startedAt = new Date();

  const record = async (ok: boolean, summary: string): Promise<void> => {
    try {
      await repositories(deps.db).jobRuns.record({
        job: JOB_DAY_CLOSE_PUSH,
        startedAt,
        finishedAt: new Date(),
        ok,
        summary,
      });
    } catch (error) {
      console.error("[caja] no se pudo registrar el push en job_run", error);
    }
  };

  let outcome: PushOutcome;

  try {
    outcome = await runPush(deps, row, now);
  } catch (error) {
    await record(false, `cierre ${row.close_date}: ${messageOf(error)}`);
    throw error;
  }

  await record(outcome.state !== "fallo", summarizePush(row, outcome));

  return outcome;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * El push en sí.
 *
 * El lote se arma **desde la base**, no desde lo que la pantalla tenía en
 * memoria: `listByDayClose()` devuelve exactamente las cuentas que quedaron
 * congeladas bajo ese cierre, así que el reintento de mañana manda el mismo
 * lote que el intento de hoy.
 */
async function runPush(
  deps: DayCloseDeps,
  row: DayClose,
  now: Date,
): Promise<PushOutcome> {
  if (row.pushed_to_ingest_at !== null) {
    return { state: "ya", at: row.pushed_to_ingest_at };
  }

  const repos = repositories(deps.db);
  const accounts = (await repos.appointmentFinance.listByDayClose(row.id)).map(toDayAccount);

  let payments: IngestPayment[];
  try {
    payments = buildDayClosePayments(accounts);
  } catch (error) {
    if (error instanceof IngestPayloadError) {
      return { state: "fallo", message: error.message, retryable: false };
    }
    throw error;
  }

  if (payments.length === 0) return { state: "vacio" };
  if (deps.ingest === null) return { state: "apagado" };

  let sent: number;
  try {
    const receipt = await deps.ingest.push(payments);
    sent = receipt.sent;
  } catch (error) {
    if (error instanceof IngestError) {
      // El día queda cerrado y sin marca de push. `listPendingPush()` lo
      // encuentra, Caja ofrece reintentar y Diagnóstico lo cuenta. Un push que
      // falló en silencio es exactamente igual a no haber empujado.
      console.error("[caja] el push a ingest falló", error.message, error.body ?? "");
      return { state: "fallo", message: error.message, retryable: error.retryable };
    }
    throw error;
  }

  await deps.db.transaction().execute(async (trx) => {
    const tx = repositories(trx);
    await tx.dayCloses.markPushed(row.id, now);
    // La marca también baja a cada cuenta: es lo que hace que una corrección
    // posterior sepa que su cifra ya salió y tenga que viajar como ajuste.
    await tx.appointmentFinance.markPushed(row.id, now);
    await tx.auditLog.append({
      actorUserId: null,
      action: "day.push",
      entity: "day_close",
      entityId: row.id,
      after: { movements: sent },
      at: now,
    });
  });

  return { state: "hecho", at: now, sent };
}

/**
 * Reintentar el push de un día ya cerrado.
 *
 * Es la acción que Caja ofrece cuando el cierre salió pero el CRM no contestó,
 * y la que corresponde después de configurar `INGEST_URL` en un día que se
 * cerró con el push apagado. No re-juzga el día ni toca los totales.
 */
export async function retryDayPush(
  deps: DayCloseDeps,
  input: { date: EaLocalDate; now?: Date },
): Promise<PushOutcome | { state: "sin-cierre" }> {
  const now = input.now ?? new Date();
  const row = await repositories(deps.db).dayCloses.findByDate(input.date);
  if (row === undefined) return { state: "sin-cierre" };
  return pushClose(deps, row, now);
}

// ── Ajustes posteriores al cierre ───────────────────────────────────────────

/** Acciones de la bitácora que llevan la cuenta de los ajustes. */
const ADJUST_ACTION = "ticket.adjust";
const ADJUST_PUSH_ACTION = "ingest.adjust";

export type AdjustmentResult =
  | { ok: false; reason: "sin-cuenta" | "sin-cierre" | "cero" | "lote"; message: string }
  | { ok: true; sequence: number; delta: Cop; amountCharged: Cop; push: PushOutcome };

/**
 * Corregir una cuenta **después** del cierre diario.
 *
 * No es una edición: es un movimiento nuevo. Actual Budget no actualiza el
 * monto de una transacción ya importada, así que reescribir la cifra original
 * dejaría a Actual con la vieja para siempre y sin ningún error. El ajuste
 * viaja con su propia llave —`ea-tx:<id>:adj<n>` acá, que `ingest-client.ts`
 * traduce al `tx_id` `ea-appt:<id>:adj<n>` de Strapi— que Actual sí importa como
 * movimiento aparte, y lleva **el delta con signo**, no el total nuevo.
 *
 * ## De dónde sale el número de ajuste
 *
 * De la bitácora: `sequence` = cuántos `ticket.adjust` lleva esa cuenta, más
 * uno. **No es un contador global** —dos citas distintas pueden tener las dos su
 * `adj1`— y no se puede inventar: dos correcciones con la misma secuencia
 * producirían el mismo `imported_id` y Actual se comería la segunda en
 * silencio.
 *
 * El esquema de A2 no tiene columna para esto y no se agrega una: `audit_log`
 * ya es append-only y ya guarda quién, cuándo y el antes/después, que es
 * exactamente lo que un ajuste necesita dejar. La secuencia se deriva de ahí.
 *
 * ## El reintento no crea un ajuste nuevo
 *
 * Si el push del ajuste falla, el renglón ya está escrito y su secuencia ya
 * está en la bitácora. `retryAdjustmentPush()` la vuelve a leer y manda **el
 * mismo** `imported_id` con **el mismo** delta. Sumar uno otra vez sería crear
 * un segundo movimiento por la misma corrección, y si el primer intento sí
 * había llegado, cobrarla dos veces.
 */
export async function recordAdjustment(
  deps: DayCloseDeps,
  input: {
    eaAppointmentId: number;
    /** Diferencia con signo respecto de lo ya empujado. */
    delta: Cop;
    /** Obligatorio: un renglón `manual` sin nota lo rechaza el CHECK de A2. */
    reason: string;
    actorUserId: AuthId;
    now?: Date;
  },
): Promise<AdjustmentResult> {
  const now = input.now ?? new Date();
  const repos = repositories(deps.db);

  const row = await repos.appointmentFinance.findByEaAppointmentId(input.eaAppointmentId);
  if (row === undefined || row.closed_at === null) {
    return {
      ok: false,
      reason: "sin-cuenta",
      message: "Esa cita no tiene una cuenta cerrada que corregir.",
    };
  }

  if (row.day_close_id === null) {
    // Antes del cierre la corrección es una edición normal del ticket, y ésa la
    // hace "Cerrar servicio" desde Hoy. Un ajuste acá dejaría dos formas de
    // cambiar la misma cifra y una de ellas sin el rastro de la otra.
    return {
      ok: false,
      reason: "sin-cierre",
      message: "La cuenta todavía no entró a un cierre: corregila desde Hoy, no como ajuste.",
    };
  }

  const trimmed = input.reason.trim();
  if (input.delta === 0 || trimmed === "") {
    return {
      ok: false,
      reason: "cero",
      message:
        input.delta === 0
          ? "Un ajuste de cero no es un movimiento: no se registra."
          : "Un ajuste exige un motivo escrito.",
    };
  }

  const account = toDayAccount(row);
  const sequence = (await countAdjustments(deps.db, row.id)) + 1;

  // El movimiento se arma **antes** de escribir. Si el ajuste no puede viajar
  // —método de pago que el enum no acepta, delta que no es entero— no queda un
  // renglón en la base que nadie va a poder conciliar.
  let payment: IngestPayment;
  try {
    payment = buildIngestAdjustment(account, input.delta, sequence);
  } catch (error) {
    if (error instanceof IngestPayloadError) {
      return { ok: false, reason: "lote", message: error.message };
    }
    throw error;
  }

  const amountCharged = (row.amount_charged ?? 0) + input.delta;

  await deps.db.transaction().execute(async (trx) => {
    const tx = repositories(trx);
    // El signo vive en el precio unitario, no en la cantidad — es el contrato
    // de B1: con signo en los dos campos, `qty −2 × precio −1000 = +2000` y una
    // devolución queda indistinguible de un cobro.
    await tx.appointmentFinanceItems.insertMany([
      {
        appointment_finance_id: row.id,
        kind: "manual",
        ea_service_id: null,
        pricing_id: null,
        qty: 1,
        unit_price_snapshot: input.delta,
        line_total: input.delta,
        note: trimmed,
      },
    ]);

    await tx.appointmentFinance.update(row.id, { amount_charged: amountCharged });

    await tx.auditLog.append({
      actorUserId: input.actorUserId,
      action: ADJUST_ACTION,
      entity: "appointment_finance",
      entityId: row.id,
      before: { amount_charged: row.amount_charged },
      after: { amount_charged: amountCharged, sequence, delta: input.delta },
      reason: trimmed,
      at: now,
    });
  });

  return {
    ok: true,
    sequence,
    delta: input.delta,
    amountCharged,
    push: await pushAdjustment(deps, row.id, payment, sequence, now),
  };
}

/**
 * Reintenta los ajustes de una cuenta que quedaron sin empujar.
 *
 * Un ajuste "sin empujar" es un `ticket.adjust` de la bitácora sin su
 * `ingest.adjust` correspondiente. La secuencia y el delta se **releen** de la
 * bitácora, así que el `imported_id` es el mismo del primer intento y el
 * reintento no puede duplicar el movimiento — ni siquiera cuando el primer
 * intento sí había llegado y la respuesta se perdió.
 */
export async function retryAdjustmentPush(
  deps: DayCloseDeps,
  input: { eaAppointmentId: number; now?: Date },
): Promise<PushOutcome | { state: "sin-cuenta" }> {
  const now = input.now ?? new Date();
  const repos = repositories(deps.db);

  const row = await repos.appointmentFinance.findByEaAppointmentId(input.eaAppointmentId);
  if (row === undefined || row.day_close_id === null) return { state: "sin-cuenta" };

  const pendientes = await pendingAdjustments(deps.db, row.id);
  if (pendientes.length === 0) return { state: "vacio" };
  if (deps.ingest === null) return { state: "apagado" };

  const account = toDayAccount(row);
  let ultimo: PushOutcome = { state: "vacio" };

  for (const { sequence, delta } of pendientes) {
    let payment: IngestPayment;
    try {
      payment = buildIngestAdjustment(account, delta, sequence);
    } catch (error) {
      if (error instanceof IngestPayloadError) {
        return { state: "fallo", message: error.message, retryable: false };
      }
      throw error;
    }
    ultimo = await pushAdjustment(deps, row.id, payment, sequence, now);
    // Se corta en el primer fallo: los ajustes son acumulativos y mandar el
    // `adj3` habiendo fallado el `adj2` dejaría a Actual con una suma que no
    // corresponde a ningún estado real de la cuenta.
    if (ultimo.state === "fallo") return ultimo;
  }

  return ultimo;
}

/** Manda un ajuste ya construido y deja su rastro. */
async function pushAdjustment(
  deps: DayCloseDeps,
  financeId: number,
  payment: IngestPayment,
  sequence: number,
  now: Date,
): Promise<PushOutcome> {
  if (deps.ingest === null) return { state: "apagado" };

  try {
    const receipt = await deps.ingest.push([payment]);
    await repositories(deps.db).auditLog.append({
      actorUserId: null,
      action: ADJUST_PUSH_ACTION,
      entity: "appointment_finance",
      entityId: financeId,
      after: { sequence, txId: payment.source_tx_id, movements: receipt.sent },
      at: now,
    });
    return { state: "hecho", at: now, sent: receipt.sent };
  } catch (error) {
    if (error instanceof IngestError) {
      console.error("[caja] el push del ajuste falló", error.message, error.body ?? "");
      return { state: "fallo", message: error.message, retryable: error.retryable };
    }
    throw error;
  }
}

/** Cuántos ajustes lleva esta cuenta, según la bitácora. */
async function countAdjustments(db: Db, financeId: number): Promise<number> {
  const rows = await repositories(db).auditLog.listForEntity(
    "appointment_finance",
    financeId,
    500,
  );
  return rows.filter((r) => r.action === ADJUST_ACTION).length;
}

/** Los ajustes registrados que todavía no tienen constancia de push. */
async function pendingAdjustments(
  db: Db,
  financeId: number,
): Promise<{ sequence: number; delta: Cop }[]> {
  const rows = await repositories(db).auditLog.listForEntity(
    "appointment_finance",
    financeId,
    500,
  );

  const pushed = new Set<number>();
  for (const row of rows) {
    if (row.action !== ADJUST_PUSH_ACTION) continue;
    const sequence = numberField(row.after_json, "sequence");
    if (sequence !== null) pushed.add(sequence);
  }

  const out: { sequence: number; delta: Cop }[] = [];
  for (const row of rows) {
    if (row.action !== ADJUST_ACTION) continue;
    const sequence = numberField(row.after_json, "sequence");
    const delta = numberField(row.after_json, "delta");
    if (sequence === null || delta === null || pushed.has(sequence)) continue;
    out.push({ sequence, delta });
  }

  // De más viejo a más nuevo: los ajustes son acumulativos y el orden en que
  // entran a Actual es el orden en que se registraron.
  return out.sort((a, b) => a.sequence - b.sequence);
}

/**
 * Un entero de un documento de la bitácora, o `null`.
 *
 * Se lee con desconfianza porque es JSON guardado hace meses por una versión
 * anterior de este archivo. Un `undefined` coerced a `NaN` acá produciría un
 * `imported_id` con `NaN` adentro, que es un identificador nuevo cada vez.
 */
function numberField(doc: Record<string, unknown> | null, key: string): number | null {
  const value = doc?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
