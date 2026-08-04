// Shape of a cargo (vacancy) as the form consumes it. Kept in its own file —
// like bio.types.ts / promos.types.ts — because `careers.ts` is `server-only`
// and the form is a client component that needs the type but not the fetcher.

/** Mirrors the `Cargo (vacante)` content type, flattened for one locale. */
export type JobRole = {
  /** Stable key posted with the application and validated server-side. */
  slug: string;
  label: string;
};
