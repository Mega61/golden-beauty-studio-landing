import type { Kysely, Transaction } from "kysely";

import type { Database } from "../types";

/**
 * Lo que recibe todo repositorio.
 *
 * Es `Kysely<Database>` o una transacción suya, indistintamente: `Transaction`
 * extiende `Kysely`, así que un repositorio construido sobre `trx` participa de
 * la transacción sin saberlo. Es lo que permite que "reemplazar los renglones
 * de una cuenta" sea atómico sin que el repositorio abra transacciones por su
 * cuenta — quién decide el alcance de una transacción es el llamador.
 */
export type Db = Kysely<Database> | Transaction<Database>;

/**
 * Los repositorios de este paquete **leen y escriben filas, nada más.**
 *
 * Ningún cálculo de plata acá: ni totales de cuenta, ni prorrateo de descuento,
 * ni resolución de reglas de comisión, ni redondeo. Todo eso son funciones
 * puras de `lib/` (paquete B1), testeadas al 100 % de ramas. Si un total
 * apareciera calculado dentro de un `SELECT`, estaría en el único lugar donde no
 * se puede testear sin una base de datos.
 *
 * La única lógica que sí vive acá es la que protege una invariante de
 * *integridad*, no de negocio: la idempotencia del alta por
 * `ea_appointment_id`, la deduplicación de `webhook_event`, y la inmutabilidad
 * de una liquidación pagada. Las tres son reglas sobre filas.
 */

/** Convierte el `insertId` de MySQL (que puede venir como bigint) a número. */
export function toId(insertId: bigint | number | undefined): number {
  if (insertId === undefined) {
    throw new Error(
      "El INSERT no devolvió insertId. Pasa cuando la tabla no tiene " +
        "AUTO_INCREMENT o cuando el ON DUPLICATE KEY no insertó nada.",
    );
  }
  return Number(insertId);
}
