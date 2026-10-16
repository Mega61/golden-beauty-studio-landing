/**
 * Una visita = una o más citas de EA seguidas: misma persona, misma
 * profesional, cada una empieza exactamente cuando termina la anterior.
 *
 * ## Por qué existe
 *
 * EA admite un solo servicio por cita. "Manos + pies" sin combo se agenda como
 * dos citas pegadas (la reserva pública lo hace así, y la agenda del panel
 * puede hacerlo a mano), pero para quien viene es **una** visita: un
 * recordatorio, una confirmación, un aviso al celular de la dueña. Sin esto,
 * cada mitad mandaría su propio mensaje y la persona recibiría dos.
 *
 * La regla es estricta a propósito —mismo cliente, misma profesional, fin ==
 * inicio— para no fusionar dos citas que solo coinciden en el día.
 */

export type VisitPart = {
  id: number;
  customerId: number | null;
  providerId: number | null;
  /** Hora de pared de EA, `"YYYY-MM-DD HH:MM:SS"`. */
  start: string;
  end: string;
  serviceName: string | null;
};

/** Las citas, agrupadas por la primera de cada visita, en orden. */
export function groupVisits(parts: readonly VisitPart[]): Map<number, VisitPart[]> {
  const sorted = [...parts].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id - b.id));
  const visits = new Map<number, VisitPart[]>();
  // La última parte de cada visita abierta, por cliente+profesional.
  const open = new Map<string, number>();

  for (const part of sorted) {
    if (part.customerId === null || part.providerId === null) {
      visits.set(part.id, [part]);
      continue;
    }
    const key = `${part.customerId}:${part.providerId}`;
    const leaderId = open.get(key);
    const chain = leaderId === undefined ? undefined : visits.get(leaderId);
    const last = chain?.[chain.length - 1];
    if (chain && last && last.end === part.start) {
      chain.push(part);
    } else {
      visits.set(part.id, [part]);
      open.set(key, part.id);
    }
  }
  return visits;
}

/** Las citas que continúan otra: no llevan mensaje propio. */
export function continuationIds(parts: readonly VisitPart[]): Set<number> {
  const out = new Set<number>();
  for (const chain of groupVisits(parts).values()) {
    for (const part of chain.slice(1)) out.add(part.id);
  }
  return out;
}

/** "Semipermanente manos y Semipermanente pies". Los nulos se saltan. */
export function visitServiceName(names: readonly (string | null)[]): string | null {
  const clean = names.map((n) => n?.trim()).filter((n): n is string => Boolean(n));
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} y ${clean[clean.length - 1]}`;
}
