import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Reporte HTML de cobertura: JavaScript generado, no código nuestro.
    "coverage/**",
    // Los worktrees de agentes traen una copia completa del repo, con su build
    // adentro. Sin esta línea, un worktree olvidado en disco hace que el lint
    // reporte miles de problemas en chunks generados que nadie escribió.
    "../.claude/**",
    // Artefactos de Playwright: trazas, capturas y el reporte.
    "test-results/**",
    "playwright-report/**",
  ]),

  {
    /**
     * La suite E2E es código de Node, no de React.
     *
     * `react-hooks/rules-of-hooks` ve el `use` de las *fixtures* de Playwright
     * —`async ({ page }, use) => { … await use(x) }`— y lo confunde con un
     * hook de React llamado desde una función que no es componente. Es un
     * falso positivo del nombre, no del código: ahí no hay React.
     */
    files: ["e2e/**/*.ts", "playwright.config.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);

export default eslintConfig;
