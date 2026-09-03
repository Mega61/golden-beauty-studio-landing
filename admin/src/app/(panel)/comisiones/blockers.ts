import { formatDateLong } from "@/components/ui/format";
import type { FortnightBlocker } from "@/jobs/commission-run";

/**
 * Los bloqueos de la quincena, en la lengua de la pantalla.
 *
 * `jobs/commission-run.ts` devuelve el bloqueo como **dato** —qué falta y de
 * qué día— y la frase se arma acá. Es la separación que permite que el mismo
 * motor corra en un cron sin conocer el formato de fecha de la interfaz, y que
 * la pantalla diga "el martes 4 de septiembre" donde un log diría
 * `2026-09-04`.
 *
 * Vive en el paquete de la pantalla y no en `lib/` porque `admin/src/lib/**`
 * pertenece a otros paquetes; es puro y sin React, así que mudarlo cuando la
 * propiedad lo permita es un `git mv`.
 */

/** Cuántos días se nombran antes de pasar a contarlos. */
const MAX_DIAS_LISTADOS = 3;

function dia(date: string): string {
  return formatDateLong(`${date} 00:00:00`);
}

export function describeBlocker(blocker: FortnightBlocker): string {
  switch (blocker.kind) {
    case "en-curso":
      return `La quincena termina el ${dia(blocker.until)} y todavía está en curso.`;

    case "sin-cierre": {
      const days = blocker.days;
      if (days.length === 1) {
        return `El ${dia(days[0])} no tiene cierre de caja.`;
      }
      // Con quince días sin cerrar, nombrarlos todos convierte el aviso en un
      // párrafo que nadie lee. Tres y el resto contado dicen lo mismo y se
      // leen de un vistazo; la lista completa está en Caja, que es donde se
      // resuelve.
      const listados = days.slice(0, MAX_DIAS_LISTADOS).map(dia).join(", ");
      const resto = days.length - MAX_DIAS_LISTADOS;
      return resto > 0
        ? `${days.length} días del periodo no tienen cierre de caja: ${listados} y ${resto} más.`
        : `${days.length} días del periodo no tienen cierre de caja: ${listados}.`;
    }

    case "sin-regla":
      return blocker.count === 1
        ? "Un renglón quedó sin regla de comisión aplicable, con comisión en cero."
        : `${blocker.count} renglones quedaron sin regla de comisión aplicable, con comisión en cero.`;
  }
}

export function describeBlockers(blockers: readonly FortnightBlocker[]): string[] {
  return blockers.map(describeBlocker);
}
