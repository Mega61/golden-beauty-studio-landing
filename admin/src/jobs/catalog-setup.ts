/**
 * El plan de `scripts/catalogo.js`: dejar el catálogo de Easy!Appointments con
 * un servicio por cada ítem de la vitrina, vinculado en `service_map`.
 *
 * Una EA recién instalada trae un servicio de ejemplo y nada más, y la pantalla
 * de Servicios crea de a uno, con alguien tipeando el nombre. Son treinta. Este
 * módulo decide, para cada id de la vitrina, qué pasaría — **con las mismas
 * piezas que usa la pantalla**: el diff (`buildCatalogDiff`, vía
 * `loadServicesView()`) dice en qué estado está cada renglón y `createPayload()`
 * decide qué viaja a EA o por qué no se puede crear. Acá no se reimplementa
 * ninguna de las dos reglas; solo se les pasa el nombre, que sale de
 * `@/data/service-names` (horneado desde el `es.json` de la landing).
 *
 * Es puro: recibe los renglones y los nombres, devuelve pasos. Correrlo dos
 * veces sobre el resultado de la primera da todo "ya vinculado" — la
 * idempotencia sale de que el diff ya no los ve `sin-vincular`, no de una marca
 * aparte.
 */

import {
  CREATE_BLOCKER_MESSAGE,
  createPayload,
  type CreatePayload,
  type DiffRow,
} from "@/app/(panel)/servicios/diff";

export type CatalogStep =
  /** No existe en EA: se crea con este payload y se vincula. */
  | { kind: "crear"; pricingId: string; categoryId: string | null; payload: CreatePayload }
  /**
   * Ya hay en EA un servicio **sin dueño** con exactamente este nombre —una
   * creación anterior cuyo vínculo falló, o uno hecho a mano—. Se vincula en
   * vez de crear un duplicado.
   */
  | {
      kind: "vincular";
      pricingId: string;
      categoryId: string | null;
      eaServiceId: number;
      name: string;
    }
  | {
      kind: "vinculado";
      pricingId: string;
      categoryId: string | null;
      eaServiceId: number;
      eaName: string | null;
      /** `true` si precio o duración difieren: se publica desde la pantalla. */
      desincronizado: boolean;
    }
  | { kind: "bloqueado"; pricingId: string; categoryId: string | null; reason: string };

export type CatalogPlan = {
  steps: CatalogStep[];
  counts: Record<CatalogStep["kind"], number>;
  /** Servicios de EA que nadie reclama y que el plan no va a vincular. */
  unclaimed: Array<{ eaServiceId: number; name: string | null }>;
};

function normalizeName(name: string | null): string {
  return (name ?? "").trim().toLocaleLowerCase("es");
}

/**
 * El plan para todos los renglones de la vitrina, en el orden de `order` (los
 * ids de `pricing.ts`) y, si alguno falta en esa lista, al final por id.
 */
export function planCatalogSetup(input: {
  rows: readonly DiffRow[];
  names: Readonly<Record<string, string>>;
  order?: readonly string[];
}): CatalogPlan {
  const { rows, names } = input;

  // Los `solo-en-ea`, por nombre. Uno con nombre repetido no se reclama: no hay
  // forma de saber cuál de los dos es el bueno.
  const orphanByName = new Map<string, DiffRow | null>();
  for (const row of rows) {
    if (row.state !== "solo-en-ea" || row.eaServiceId === null) continue;
    const key = normalizeName(row.eaName);
    if (key === "") continue;
    orphanByName.set(key, orphanByName.has(key) ? null : row);
  }
  const claimed = new Set<number>();

  const steps: CatalogStep[] = [];
  for (const row of rows) {
    if (row.pricingId === null) continue;
    const { pricingId, categoryId } = row;

    if (row.state === "mapa-roto") {
      steps.push({
        kind: "bloqueado",
        pricingId,
        categoryId,
        reason:
          `está vinculado al servicio ${row.eaServiceId} de la agenda, que ya no existe. ` +
          "Hay que desvincularlo en Servicios y volver a correr esto.",
      });
      continue;
    }

    if (row.state !== "sin-vincular") {
      steps.push({
        kind: "vinculado",
        pricingId,
        categoryId,
        eaServiceId: row.eaServiceId as number,
        eaName: row.eaName,
        desincronizado: row.state === "desincronizado",
      });
      continue;
    }

    const result = createPayload(row, names[pricingId] ?? "");
    if ("blocker" in result) {
      steps.push({
        kind: "bloqueado",
        pricingId,
        categoryId,
        reason:
          result.blocker === "sin-nombre"
            ? "no tiene nombre en es.json (servicios.categories.<cat>.items.<id>.name). " +
              "Correr `npm run build-combo-map` en la landing."
            : CREATE_BLOCKER_MESSAGE[result.blocker],
      });
      continue;
    }

    const orphan = orphanByName.get(normalizeName(result.payload.name));
    if (orphan && orphan.eaServiceId !== null && !claimed.has(orphan.eaServiceId)) {
      claimed.add(orphan.eaServiceId);
      steps.push({
        kind: "vincular",
        pricingId,
        categoryId,
        eaServiceId: orphan.eaServiceId,
        name: result.payload.name,
      });
      continue;
    }

    steps.push({ kind: "crear", pricingId, categoryId, payload: result.payload });
  }

  const position = new Map((input.order ?? []).map((id, index) => [id, index]));
  steps.sort((a, b) => {
    const pa = position.get(a.pricingId) ?? Number.MAX_SAFE_INTEGER;
    const pb = position.get(b.pricingId) ?? Number.MAX_SAFE_INTEGER;
    return pa !== pb ? pa - pb : a.pricingId.localeCompare(b.pricingId);
  });

  const counts: CatalogPlan["counts"] = { crear: 0, vincular: 0, vinculado: 0, bloqueado: 0 };
  for (const step of steps) counts[step.kind] += 1;

  const unclaimed = rows
    .filter(
      (row) =>
        row.state === "solo-en-ea" &&
        row.eaServiceId !== null &&
        !claimed.has(row.eaServiceId),
    )
    .map((row) => ({ eaServiceId: row.eaServiceId as number, name: row.eaName }));

  return { steps, counts, unclaimed };
}

/** Una línea por paso, para la consola. */
export function describeStep(step: CatalogStep): string {
  switch (step.kind) {
    case "crear": {
      const { name, price, duration } = step.payload;
      return `crear       ${step.pricingId} → "${name}" · $${price.toLocaleString("es-CO")} · ${duration} min`;
    }
    case "vincular":
      return `vincular    ${step.pricingId} → "${step.name}" (ya existe en la agenda, id ${step.eaServiceId})`;
    case "vinculado":
      return (
        `ya vinculado ${step.pricingId} → ${step.eaServiceId} "${step.eaName ?? "?"}"` +
        (step.desincronizado ? " · precio/duración distintos: publicar desde Servicios" : "")
      );
    case "bloqueado":
      return `bloqueado   ${step.pricingId}: ${step.reason}`;
  }
}

/**
 * Los ids de técnica de `--asignar=4,7`. Lanza ante cualquier cosa que no sea
 * una lista de enteros positivos: asignarle el catálogo a la técnica
 * equivocada por un typo no es un error que se note enseguida.
 */
export function parseProviderIds(argv: readonly string[]): number[] {
  const flag = argv.find((arg) => arg === "--asignar" || arg.startsWith("--asignar="));
  if (flag === undefined) return [];
  const raw = flag.slice("--asignar=".length);
  const parts = raw.split(",").map((part) => part.trim());
  if (flag === "--asignar" || parts.some((part) => !/^[1-9]\d*$/.test(part))) {
    throw new Error(
      `--asignar espera ids de técnica de EA separados por coma (ej. --asignar=2,5); llegó "${flag}".`,
    );
  }
  return [...new Set(parts.map(Number))];
}

/**
 * Qué servicios hay que agregarle a una técnica. **Solo agrega**: lo que ya
 * tenía asignado se conserva, sea o no de la vitrina.
 */
export function planProviderServices(
  current: readonly number[] | null,
  bookable: readonly number[],
): { add: number[]; next: number[] } {
  const have = new Set(current ?? []);
  const add = [...new Set(bookable)].filter((id) => !have.has(id)).sort((a, b) => a - b);
  return { add, next: [...(current ?? []), ...add] };
}

/** Los servicios de EA que hoy están vinculados y existen: lo que se agenda. */
export function bookableServiceIds(rows: readonly DiffRow[]): number[] {
  return rows
    .filter(
      (row) =>
        row.pricingId !== null &&
        (row.state === "al-dia" || row.state === "desincronizado") &&
        row.eaServiceId !== null,
    )
    .map((row) => row.eaServiceId as number)
    .sort((a, b) => a - b);
}
