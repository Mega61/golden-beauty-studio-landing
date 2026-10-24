import { can, findAllowedEntry, type AllowedIdentity } from "@/lib/auth-policy";

/**
 * A quién le llega el aviso de una cita nueva. Puro: entra la lista de
 * suscripciones y la allowlist, sale quién recibe qué.
 *
 * Dos avisos distintos para la misma cita:
 *
 * - **general** (`avisos:reservas-web`): solo por las reservas de la página, a
 *   dueña y recepción. Nombra a la técnica: es agenda de todo el equipo.
 * - **propio** (`avisos:mis-citas`): a quien es la columna de la cita, venga
 *   de la página o del panel. Nunca a otra persona — la técnica no puede
 *   enterarse por la pantalla de bloqueo de la clienta de otra.
 *
 * Y tres reglas de sentido común:
 *
 * - Quien agendó la cita no recibe aviso de lo que acaba de hacer.
 * - Un dispositivo que ya recibe el general no recibe además el propio: sería
 *   el mismo aviso dos veces.
 * - El rol y la columna se leen de la allowlist **de hoy**, no de cuando se
 *   suscribió: quien salió de Equipo o cambió de columna deja de recibir.
 */

export type PushRecipient = { id: number; userId: string; email: string };

export function bookingRecipients<S extends PushRecipient>(input: {
  subscriptions: readonly S[];
  allowlist: readonly AllowedIdentity[];
  /** La columna de la cita. `null` = sin técnica: nadie recibe el propio. */
  providerId: number | null;
  /** `web` = la página; `panel` = alguien del equipo desde la agenda. */
  source: "web" | "panel";
  /** Quien la agendó desde el panel. */
  actorUserId?: string | null;
}): { general: S[]; own: S[] } {
  const general: S[] = [];
  const own: S[] = [];

  for (const sub of input.subscriptions) {
    if (input.actorUserId && sub.userId === input.actorUserId) continue;
    const entry = findAllowedEntry(sub.email, input.allowlist);
    if (entry === null) continue;

    if (input.source === "web" && can(entry.role, "avisos:reservas-web")) {
      general.push(sub);
      continue;
    }
    if (
      input.providerId !== null &&
      entry.ea_provider_id === input.providerId &&
      can(entry.role, "avisos:mis-citas")
    ) {
      own.push(sub);
    }
  }

  return { general, own };
}
