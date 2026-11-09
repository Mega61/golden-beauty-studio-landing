import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import Link from "next/link";

import { DateStepper, DaySwipe, Icon, formatDateLong, formatTime } from "@/components/ui";
import { unmarkedAppointments } from "@/lib/attendance";
import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import { instantToEaDate, instantToEaLocal, isEaLocalDate, type EaLocalDate } from "@/lib/ea";
import { requireSession, sessionCan } from "@/lib/dal";
import type { UserRole } from "@/db/types";
import { loadComboCompositions } from "@/lib/combo-source";
import { hoyCardShare, pendingShares } from "@/lib/stampee/card-share";
import { loadLoyaltyWithin } from "@/lib/stampee/client";
import { loadRecentPendingCharges } from "@/jobs/pending-charges";
import { createCachedEaClient } from "@/lib/ea/client";
import { relativeDayLabel } from "@/lib/push/payload";
import { describePending, groupPendingByDay, type PendingCharge } from "@/lib/pending-charges";
import { loadRangeAppointments } from "../caja/data";
import { activeRows, clientsForPhone, leadingCard } from "@/lib/stampee/model";
import { cerrarCuenta, revisarPrimeraVisita } from "./actions";
import { loadToday } from "./data";
import { loadConfirmations, pendingConfirmations } from "../recordatorios/confirmations-data";
import { loadReminders } from "../recordatorios/data";
import { TodayList } from "./TodayList";

/**
 * **Hoy** — la raíz del panel para todos los roles.
 *
 * Para una técnica es su día: sus citas, y sobre cada una la acción primaria
 * "Cerrar servicio". Para recepción y para la dueña es el día completo, con los
 * montos a la vista.
 *
 * ## Lo que este archivo decide y lo que no
 *
 * Decide **qué se dibuja**: el rol define si se ven las demás citas y si se ven
 * los montos. No decide **qué se puede hacer**: eso lo vuelve a resolver la
 * Server Action con `requireCapability()` y `requireOwnProvider()`. Preguntar
 * dos veces es el diseño y no una redundancia — un botón escondido no es un
 * permiso, porque la Action que había detrás se puede invocar sin él.
 *
 * ## La ruta
 *
 * Vive en `/hoy` y no en `/`, que es lo que dice `components/shell/nav.ts`. La
 * raíz del panel sigue siendo el placeholder de WP-0 y ninguno de los dos
 * archivos pertenece a este paquete. Está reportado: hace falta que `/` redirija
 * acá, o que el destino "Hoy" apunte a `/hoy`.
 */

export const metadata: Metadata = {
  title: "Hoy · Panel",
};

/** El shell nombra a la recepción `reception`; la base la llama `admin`. */
function shellRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

/**
 * El día que se mira. `?fecha=YYYY-MM-DD` abre un día anterior, para cerrar la
 * cuenta de una cita que se registró tarde o que nadie alcanzó a cerrar. El
 * futuro no: ahí no hay nada que cobrar. Cualquier otra cosa cae en hoy.
 */
function parseFecha(raw: string | undefined, today: EaLocalDate): EaLocalDate {
  return isEaLocalDate(raw) && raw <= today ? raw : today;
}

/** Un día antes o después, en calendario. Sin husos: es una fecha, no un instante. */
function shiftDate(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Si la caja de un día anterior ya se cerró. Solo se pregunta para el pasado, y
 * si la base no contesta se calla: es un aviso, la regla vive en Caja.
 */
/** "Hoy", "Ayer", "Hace 3 días": la segunda línea del paso de fecha. */
function relativeDay(date: string, today: string): string {
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000,
  );
  if (days === 0) return "Hoy";
  if (days === 1) return "Ayer";
  return `Hace ${days} días`;
}

/**
 * Las citas de la última semana que quedaron sin cobrar (`lib/pending-charges.ts`).
 * Es lo único que la sincronización nocturna no puede hacer sola. Una lectura
 * a EA para toda la semana, con caché. Es un aviso: si algo falla, se calla.
 */
async function pendingChargesSafe(): Promise<PendingCharge[]> {
  try {
    return await loadRecentPendingCharges({
      db: getDb(),
      loadRange: loadRangeAppointments(createCachedEaClient()),
    });
  } catch {
    return [];
  }
}

export default async function HoyPage({
  searchParams,
}: {
  // En Next 16 los parámetros de la petición son asíncronos.
  searchParams: Promise<{ fecha?: string }>;
}) {
  const session = await requireSession();
  const today = instantToEaDate(new Date());
  const fecha = parseFecha((await searchParams).fecha, today);
  const isToday = fecha === today;

  const [verTodas, canCharge, canSeeTotals, canFixAfterClose, canRemind, canGiveCourtesy, canCloseDay] =
    await Promise.all([
      sessionCan("agenda:ver-todas"),
      sessionCan("cuenta:cobrar"),
      sessionCan("caja:ver"),
      sessionCan("cuenta:corregir-tras-cierre"),
      sessionCan("recordatorios:enviar"),
      sessionCan("cortesia:otorgar"),
      sessionCan("caja:cerrar-dia"),
    ]);

  // El acceso a Recordatorios va acá con su conteo porque Hoy es la pantalla
  // que recepción abre primero: un "3 pendientes" a la vista es lo que hace
  // que la pasada diaria no dependa de acordarse. Si la carga falla, el acceso
  // sale sin número —nunca tumba Hoy por un dato accesorio.
  const [{ date, appointments: citas, catalog, problems }, pendingReminders, comboSource, loyalty, pendingCharges] = await Promise.all([
    loadToday(session, { verTodas, date: fecha }),
    // Recordatorios **y** reservas nuevas por confirmar: los dos son mensajes
    // que salen del mismo botón de la misma pantalla.
    canRemind
      ? Promise.all([
          loadReminders().then((r) =>
            r.problems.length > 0 ? null : r.rows.filter((row) => row.state === "pendiente").length,
          ),
          loadConfirmations().then(pendingConfirmations),
        ])
          .then(([reminders, confirmations]) =>
            reminders === null || confirmations === null ? null : reminders + confirmations,
          )
          .catch(() => null)
      : Promise.resolve(null),
    // Para "¿también pies?" en la cuenta: el par que es un combo se cobra como
    // el combo. Nunca lanza; sin composiciones la hoja simplemente no lo ofrece.
    loadComboCompositions(),
    // "Premio listo" / "le falta 1 sello" en la tarjeta de la cita. Es un
    // detalle: con Stampee lento o caído Hoy sale igual, sin sellos.
    loadLoyaltyWithin(1_500),
    // Solo para dueña y recepción: a la técnica no le toca.
    canCloseDay ? pendingChargesSafe() : Promise.resolve([]),
  ]);

  // La tarjeta de sellos por mandar: el CRM la crea en silencio y Stampee no
  // se la manda a nadie (`lib/stampee/card-share.ts`). Solo para quien la
  // puede mandar; sin la base, no se dice nada en vez de pedirlas todas.
  const sentCardIds =
    loyalty?.ok && (await sessionCan("fidelidad:ver"))
      ? await repositories(getDb())
          .stampeeCardShares.listSentCardIds()
          .catch(() => null)
      : null;

  const appointments = citas.map((appointment) => {
    if (!loyalty?.ok) return appointment;
    const cards = clientsForPhone(loyalty.data, appointment.customerPhone).flatMap((client) => client.cards);
    const card = leadingCard(cards);
    const share =
      sentCardIds === null
        ? null
        : hoyCardShare({
            closed: appointment.finance.closedAt !== null,
            cards,
            leading: card,
            sent: sentCardIds,
            phone: appointment.customerPhone,
            customerName: appointment.customerName,
            cardBaseUrl: loyalty.data.cardBaseUrl,
          });
    return {
      ...appointment,
      ...(card && (card.stage === "lista" || card.stage === "cerca")
        ? { loyalty: { stage: card.stage, remaining: card.remaining, rewardName: card.rewardName } }
        : {}),
      ...(share === null
        ? {}
        : { cardShare: share.state === "enviar" ? { state: share.state, cardId: share.cardId } : share }),
    };
  });
  const tarjetasPorEnviar =
    loyalty?.ok && sentCardIds !== null
      ? pendingShares(activeRows(loyalty.data), sentCardIds, new Date()).length
      : 0;

  const eaCaido = problems.find((p) => p.source === "ea") ?? null;
  const dbCaida = problems.find((p) => p.source === "db") ?? null;

  // Las citas que ya terminaron sin cuenta y sin marca. Es el recordatorio de
  // fin de jornada: la inasistencia solo se puede medir sobre lo que alguien
  // marcó, y lo que nadie marcó queda fuera de la tasa (`lib/attendance.ts`).
  // Sin EA no hay estados que leer, así que no se dice nada.
  const sinMarcar =
    eaCaido === null
      ? unmarkedAppointments(
          appointments.map((appointment) => ({
            ...appointment,
            closed: appointment.finance.closedAt !== null,
          })),
          instantToEaLocal(new Date()),
        )
      : [];

  const prevHref = `/hoy?fecha=${shiftDate(date, -1)}`;
  // Mañana no se abre: desde ayer, "siguiente" es volver a hoy.
  const nextHref = isToday ? null : shiftDate(date, 1) < today ? `/hoy?fecha=${shiftDate(date, 1)}` : "/hoy";

  return (
    <AppShell
      role={shellRole(session.role)}
      title="Hoy"
      readOnly={
        eaCaido === null
          ? undefined
          : {
              reason:
                "La agenda no responde. Se ven las cuentas que ya están en el panel, pero no se puede guardar.",
            }
      }
    >
      <div style={{ display: "grid", gap: "1rem" }}>
        {/* Enlaces y no un control con estado, igual que en Caja: la pantalla
            es un Server Component y navegar es lo que ya sabe hacer. El futuro
            no se abre: la flecha de la derecha se apaga en hoy. */}
        <DateStepper
          label={formatDateLong(`${date} 00:00:00`)}
          sub={[relativeDay(date, today), verTodas ? null : "tus citas"].filter(Boolean).join(" · ")}
          prevHref={prevHref}
          nextHref={nextHref}
          todayHref={isToday ? null : "/hoy"}
        />

        {pendingCharges.length === 0 ? null : (
          <div role="alert" className="ui-callout ui-callout--warn">
            <Icon name="caja" size={18} />
            <span>
              <strong>Quedan {describePending(pendingCharges)}</strong>
              {" — "}
              {groupPendingByDay(pendingCharges).map((day, i) => (
                <span key={day.date}>
                  {i > 0 ? " · " : null}
                  <Link href={`/hoy?fecha=${day.date}`}>{relativeDayLabel(day.date, today)}</Link>
                  {`: ${day.charges.map((charge) => charge.customerName).join(", ")}`}
                </span>
              ))}
              . Se cobran en su día; lo demás ya viaja solo a Actual.
            </span>
          </div>
        )}

        {dbCaida === null ? null : (
          <div role="alert" className="ui-callout ui-callout--error">
            <Icon name="alerta" size={18} />
            <span>
              No se pudo leer la base del panel, así que no hay cuentas ni precios. Las cuentas que
              se escriban ahora quedan pendientes en el celular hasta que vuelva.
            </span>
          </div>
        )}

        {canRemind ? (
          // `Link` y no `ButtonLink`: un `<a>` crudo no lleva el `basePath`.
          <Link
            href="/recordatorios"
            className={`ui-btn ui-btn--${pendingReminders ? "primary" : "secondary"} ui-btn--block`}
          >
            <Icon name="mensaje" size={18} />
            {pendingReminders === null
              ? "Confirmaciones y recordatorios"
              : pendingReminders === 0
                ? "WhatsApp: nada pendiente"
                : pendingReminders === 1
                  ? "WhatsApp: 1 mensaje pendiente"
                  : `WhatsApp: ${pendingReminders} mensajes pendientes`}
          </Link>
        ) : null}

        {tarjetasPorEnviar === 0 ? null : (
          <div role="status" className="ui-callout ui-callout--warn">
            <Icon name="regalo" size={18} />
            <span>
              <strong>
                {tarjetasPorEnviar === 1
                  ? "1 tarjeta de sellos sin enviar"
                  : `${tarjetasPorEnviar} tarjetas de sellos sin enviar`}
              </strong>
              {" — "}
              clientas que todavía no saben que la tienen. Mándalas desde{" "}
              <Link href="/fidelidad">Fidelidad</Link>.
            </span>
          </div>
        )}

        {sinMarcar.length === 0 ? null : (
          <div role="status" className="ui-callout ui-callout--warn">
            <Icon name="reloj" size={18} />
            <span>
              <strong>
                {sinMarcar.length === 1
                  ? `1 cita ${isToday ? "de hoy" : "de este día"} sin marcar`
                  : `${sinMarcar.length} citas ${isToday ? "de hoy" : "de este día"} sin marcar`}
              </strong>
              {" — "}
              {sinMarcar
                .map((cita) => `${formatTime(cita.start)} ${cita.customerName}`)
                .join(" · ")}
              . Ya terminaron y no tienen cuenta: marca si llegó o no en su tarjeta.
            </span>
          </div>
        )}

        <DaySwipe
          prevHref={prevHref}
          nextHref={nextHref}
        >
          <TodayList
            appointments={appointments}
            catalog={catalog}
            scope={session.userId}
            canCharge={canCharge}
            canGiveCourtesy={canGiveCourtesy}
            canSeeTotals={canSeeTotals}
            canFixAfterClose={canFixAfterClose}
            readOnly={eaCaido !== null}
            action={cerrarCuenta}
            combos={comboSource.combos}
            checkFirstVisit={revisarPrimeraVisita}
            isToday={isToday}
          />
        </DaySwipe>
      </div>
    </AppShell>
  );
}
