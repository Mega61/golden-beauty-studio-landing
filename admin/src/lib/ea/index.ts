/**
 * Superficie pública del contrato de Easy!Appointments (WP-A1).
 *
 * **`client.ts` no se reexporta acá a propósito.** Importa `server-only`, así
 * que cualquier barril que lo incluyera contagiaría esa guarda a todo lo demás
 * — y `datetime.ts` y `types.ts` sí tienen que poder usarse desde un componente
 * cliente (formatear una hora, tipar una prop). Quien necesite hablar con EA
 * importa `@/lib/ea/client` explícitamente, y ese import extra es el
 * recordatorio de que está tocando la red desde el servidor.
 *
 * ```ts
 * import type { Appointment } from "@/lib/ea";        // en cualquier lado
 * import { createEaClient } from "@/lib/ea/client";   // solo en el servidor
 * ```
 */

export * from "./datetime";
export * from "./errors";
export * from "./mapping";
export * from "./types";
