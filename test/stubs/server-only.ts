// Test stub for the `server-only` package, wired up in `vitest.config.ts`.
//
// The real package throws on import outside a React Server Component, which is
// exactly what we want in the app and exactly what makes the modules that guard
// themselves with it (promos, careers, dictionaries, …) impossible to unit test.
// Aliasing it here neutralises the guard for tests only — production builds
// never see this file.
export {};
