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

    case "sin-cobrar": {
      const citas = blocker.count === 1 ? "Queda una cita atendida sin cobrar" : `Quedan ${blocker.count} citas atendidas sin cobrar`;
      const days = blocker.days;
      // Con muchos días, nombrarlos todos convierte el aviso en un párrafo que
      // nadie lee. Tres y el resto contado dicen lo mismo; la lista completa
      // está en Caja, día por día, y se cobran desde Hoy.
      const listados = days.slice(0, MAX_DIAS_LISTADOS).map(dia).join(", ");
      const resto = days.length - MAX_DIAS_LISTADOS;
      return resto > 0
        ? `${citas} en el periodo: ${listados} y ${resto} días más.`
        : `${citas} en el periodo: ${days.length === 1 ? "el " : ""}${listados}.`;
    }

    case "sin-agenda":
      return "No se pudo leer la agenda para comprobar que todas las citas de la quincena estén cobradas. Vuelve a intentar en un momento.";

    case "sin-regla":
      return blocker.count === 1
        ? "Un renglón quedó sin regla de comisión aplicable, con comisión en cero."
        : `${blocker.count} renglones quedaron sin regla de comisión aplicable, con comisión en cero.`;
  }
}

export function describeBlockers(blockers: readonly FortnightBlocker[]): string[] {
  return blockers.map(describeBlocker);
}
