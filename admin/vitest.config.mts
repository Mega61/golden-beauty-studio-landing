import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Misma forma que el `vitest.config.mts` de la landing, por las mismas razones.
 *
 * `.mts`, no `.ts`: el loader nativo de Vite trata un `.ts` en un paquete
 * CommonJS como CJS y avisa que el `import.meta.url` de ahí va a dejar de
 * funcionar. Poner `"type": "module"` no es opción: rompe `next.config.ts`,
 * que usa `__dirname`.
 *
 * Qué se testea acá: la lógica pura de `src/lib` — el motor de comisiones, la
 * cuenta de servicio, el reparto de combos, los ids de ingest, el layout del
 * calendario, la detección de choques, TOTP. Todo lo que decide un monto o una
 * decisión vive fuera de React y se fija con tests. Un bug de UI se ve; un bug
 * de comisión se paga.
 *
 * Qué NO: componentes y Server Components `async` — Vitest no puede renderizar
 * los `async`, y la guía de Next manda E2E para eso.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    alias: {
      // `server-only` lanza por diseño fuera de un React Server Component. Los
      // módulos de datos lo importan como guarda, así que sin este alias su
      // lógica sería intesteable. La guarda sigue viva en los builds reales.
      "server-only": fileURLToPath(
        new URL("./test/stubs/server-only.ts", import.meta.url),
      ),
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Solo la capa de lógica. Componentes y route handlers diluirían el
      // número hasta volverlo insignificante.
      // `src/jobs/**` entra: el reconcile y el congelado de precio deciden qué
      // plata queda registrada, aunque no vivan bajo `lib/`.
      include: ["src/lib/**", "src/db/**", "src/jobs/**"],
      exclude: ["**/*.test.ts", "**/*.types.ts"],
      // **Umbrales por archivo, no globales.** Un número global sobre todo el
      // panel no significa nada y se cumple con tests de relleno; lo que
      // importa es que los módulos que deciden un monto —o quién entra— no
      // tengan una sola rama sin ejercitar.
      //
      // Están al 100 % el día que se entregaron. El umbral existe para que
      // sigan ahí: sin él, la primera rama nueva sin test pasa sin que nadie
      // se entere, y un bug de comisión se paga.
      //
      thresholds: {
        // Auth: la puerta de entrada. `totp.ts` es criptografía escrita a mano
        // —ventana, anti-repetición, bloqueo, comparación en tiempo constante—
        // y `auth-policy.ts` decide quién ve la plata de quién.
        "src/lib/auth-policy.ts": { branches: 100, functions: 100, lines: 100 },
        "src/lib/totp.ts": { branches: 100, functions: 100, lines: 100 },
        "src/lib/dal.ts": { branches: 100, functions: 100, lines: 100 },
        "src/lib/ticket.ts": { branches: 100, functions: 100, lines: 100 },
        "src/lib/commission.ts": { branches: 100, functions: 100, lines: 100 },
        "src/lib/combo-allocation.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "src/lib/price-snapshot.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "src/lib/ingest-id.ts": { branches: 100, functions: 100, lines: 100 },
        "src/lib/ingest-payload.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "src/lib/metrics.ts": { branches: 100, functions: 100, lines: 100 },
        "src/lib/conflict.ts": { branches: 100, functions: 100, lines: 100 },
        "src/lib/calendar-layout.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
