import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the pure logic under `src/data`, `src/lib` and `src/config` —
 * the price formatter, the `{price:<id>}` token resolver, the promo-scenario
 * selector and the env parsing in `siteConfig`. These are the parts where a
 * silent regression ships a wrong price or an empty section rather than an
 * obvious crash, so they are the parts worth pinning.
 *
 * Components and `async` Server Components are deliberately out of scope:
 * Vitest cannot render async Server Components, and Next's own testing guide
 * points at E2E for those. See `docs/TESTING.md`.
 *
 * `.mts`, not `.ts`: Vite's native config loader treats a `.ts` config in a
 * CommonJS package as CJS and warns that the ESM syntax here will stop working.
 * Setting `"type": "module"` instead would break `next.config.ts`, which uses
 * `__dirname`.
 */
export default defineConfig({
  resolve: {
    // Vite resolves the `@/*` → `./src/*` mapping from tsconfig.json natively,
    // so tests import exactly the specifiers the app does. This replaces the
    // `vite-tsconfig-paths` plugin, which Vite now reports as redundant.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    alias: {
      // `server-only` throws by design when imported outside a React Server
      // Component. Nine data modules import it as a guard (promos, careers,
      // dictionaries, …), which would make their pure logic untestable. Swap it
      // for a no-op in tests; the guard still holds in real builds, where this
      // alias does not exist.
      "server-only": fileURLToPath(
        new URL("./test/stubs/server-only.ts", import.meta.url),
      ),
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Only the logic layer. Components, route handlers and the generated
      // lookbook manifest would dilute the number into meaninglessness.
      include: ["src/data/**", "src/lib/**", "src/config/**"],
      exclude: [
        "**/*.test.ts",
        "**/*.types.ts",
        "src/data/lookbook-manifest.ts",
        "src/data/promos.es.ts",
        "src/data/promos.en.ts",
        "src/data/bio.es.ts",
        "src/data/bio.en.ts",
      ],
    },
  },
});
