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
  ]),
]);

export default eslintConfig;
