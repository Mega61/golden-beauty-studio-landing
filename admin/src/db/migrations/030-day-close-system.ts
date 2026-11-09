import type { Migration } from "./migration";

/**
 * **El cierre de caja lo hace el sistema, no una persona.**
 *
 * Hasta 2026-11-09 la plata viajaba a Actual solo cuando alguien apretaba
 * "Cerrar el día" en Caja, y el día no cerraba mientras quedara una cita sin
 * cuenta. A la dueña ese modelo no le sirve —un día sin cerrar es plata que no
 * llega, y una sesión olvidada después del cierre exigía un ajuste—, así que la
 * sincronización nocturna (`syncDay()` en `jobs/day-close.ts`) arma la fila
 * `day_close` sola con lo que ya está cobrado.
 *
 * Una fila escrita por el sistema no tiene quién la firme: `closed_by` pasa a
 * aceptar `NULL`. La FK hacia `user` se queda —un cierre firmado por alguien
 * sigue sin poder perder a su firmante—, y MySQL no la aplica sobre un `NULL`.
 */
export const migration: Migration = {
  id: "030-day-close-system",
  description: "day_close.closed_by acepta NULL: el cierre lo arma la sincronización nocturna",
  statements: [`ALTER TABLE day_close MODIFY closed_by VARCHAR(36) NULL`],
};
