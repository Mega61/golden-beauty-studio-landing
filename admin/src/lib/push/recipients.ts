import { can, findAllowedEntry, type AllowedIdentity } from "@/lib/auth-policy";

/**
 * A quién le llega el aviso de algo que pasó con una cita: reserva web, cita
 * creada desde el panel, cambio o cancelación. Puro: entra la lista de
 * suscripciones y la allowlist, sale quién recibe qué.
 *
 * Tres avisos distintos para la misma cita:
 *
 * - **general** (`avisos:reservas-web`): dueña y recepción, que ven la agenda
 *   de todo el equipo. Nombra a la técnica.
 * - **propio** (`avisos:mis-citas`): a quien es la columna de la cita **ahora**.
 *   Nunca a otra persona — la técnica no puede enterarse por la pantalla de
 *   bloqueo de la clienta de otra.
 * - **salió** (`avisos:mis-citas`): a quien era la columna **antes**, cuando un
 *   cambio se la pasó a otra. Se entera de que ya no la tiene, y de nada más.
 *
 * Y tres reglas de sentido común:
 *
 * - Quien hizo el cambio no recibe aviso de lo que acaba de hacer. Son varias
 *   personas cuando los cambios se juntan (mover y "Deshacer" de otra).
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
  /** La columna de antes, si un cambio la movió a otra. */
  previousProviderId?: number | null;
  /** Quienes hicieron lo que se avisa. Vacío para una reserva de la página. */
  actorUserIds?: readonly string[];
}): { general: S[]; own: S[]; left: S[] } {
  const general: S[] = [];
  const own: S[] = [];
  const left: S[] = [];
  const actors = new Set(input.actorUserIds ?? []);
  const previous =
    input.previousProviderId !== undefined && input.previousProviderId !== input.providerId
      ? input.previousProviderId
      : null;

  for (const sub of input.subscriptions) {
    if (actors.has(sub.userId)) continue;
    const entry = findAllowedEntry(sub.email, input.allowlist);
    if (entry === null) continue;

    if (can(entry.role, "avisos:reservas-web")) {
      general.push(sub);
      continue;
    }
    if (!can(entry.role, "avisos:mis-citas") || entry.ea_provider_id === null) continue;
    if (input.providerId !== null && entry.ea_provider_id === input.providerId) {
      own.push(sub);
    } else if (previous !== null && entry.ea_provider_id === previous) {
      left.push(sub);
    }
  }

  return { general, own, left };
}
