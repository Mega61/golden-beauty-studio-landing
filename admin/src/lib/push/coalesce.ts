/**
 * Junta los cambios seguidos de una misma cita en un solo aviso.
 *
 * Mover una cita en la grilla ofrece "Deshacer" durante 9 s (`UNDO_MS` en
 * `components/ui/Toast.tsx`). Avisar en el momento haría sonar el celular de
 * la técnica dos veces —"se movió", "se movió de vuelta"— por algo que, visto
 * desde su silla, no pasó. Lo mismo al estirar y corregir, o al mover dos veces
 * hasta acertar el hueco.
 *
 * Así que el primer cambio de una cita abre una ventana, cada cambio siguiente
 * la alarga, y al cerrarse sale **un** aviso que compara el estado de antes del
 * primero con el de ahora. Mover y deshacer da "nada cambió", y no sale nada.
 *
 * ## Por qué en memoria
 *
 * El panel es un solo contenedor (lo mismo que asume la caché de EA en
 * `lib/ea/cache.ts`). Si el proceso se reinicia dentro de la ventana, se
 * pierde ese aviso — es un aviso, no un dato: la agenda sigue diciendo la
 * verdad.
 */

export type Coalesced<T> = {
  /** El estado de antes del primer cambio de la ventana. */
  first: T;
  /** Todos los que cambiaron la cita en la ventana: ninguno recibe el aviso. */
  actorUserIds: string[];
  /** El nombre de quien hizo el último cambio, para "por Juan". */
  actorName: string | null;
};

type Entry<T> = {
  first: T;
  deadline: number;
  actorUserIds: Set<string>;
  actorName: string | null;
};

export type Coalescer<T> = {
  /**
   * Anota un cambio de `key`. Al primero de la ventana le devuelve —cuando la
   * ventana se cierra— lo juntado; a los demás, `null` en el acto: el aviso
   * lo manda el primero.
   */
  settle(
    key: number,
    before: T,
    actor: { userId: string; name: string | null },
  ): Promise<Coalesced<T> | null>;
  pending(): number;
};

export function createCoalescer<T>(options: {
  windowMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Coalescer<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const entries = new Map<number, Entry<T>>();

  return {
    async settle(key, before, actor) {
      const open = entries.get(key);
      if (open !== undefined) {
        open.deadline = now() + options.windowMs;
        open.actorUserIds.add(actor.userId);
        open.actorName = actor.name;
        return null;
      }

      const entry: Entry<T> = {
        first: before,
        deadline: now() + options.windowMs,
        actorUserIds: new Set([actor.userId]),
        actorName: actor.name,
      };
      entries.set(key, entry);
      try {
        for (let wait = entry.deadline - now(); wait > 0; wait = entry.deadline - now()) {
          await sleep(wait);
        }
      } finally {
        entries.delete(key);
      }
      return { first: entry.first, actorUserIds: [...entry.actorUserIds], actorName: entry.actorName };
    },
    pending: () => entries.size,
  };
}
