import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The admin panel is a sibling Next app with its own eslint/tsconfig and
    // its own CI job — it is not part of the landing's lint or build.
    "admin/**",
    // Agent worktrees hold a full copy of the repo, build output included.
    // Without this, a worktree left on disk makes `npm run lint` report
    // thousands of problems in generated chunks that nobody wrote.
    ".claude/**",
  ]),
]);

export default eslintConfig;
