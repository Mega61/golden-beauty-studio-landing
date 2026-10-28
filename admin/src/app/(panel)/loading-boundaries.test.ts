import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Un `loading.tsx` y un formulario con `useActionState` no viven en la misma
 * ruta.
 *
 * Con Next 16.2, una Server Action que llama a `revalidatePath` termina en una
 * navegación de "refrescar todo" **dentro de la misma transición** que la
 * acción (`server-action-reducer.js`). Si la ruta que se está mirando tiene un
 * `loading.tsx`, esa navegación a veces queda esperando una carga que se
 * abortó, y la transición no se confirma nunca: el `isPending` de
 * `useActionState` se queda en `true` (el botón gira para siempre) y el
 * resultado de la acción no llega a la pantalla, aunque la escritura sí se
 * hizo. Pasó con el alta de clientas: el E2E fallaba 2 de 4 contra un build de
 * producción, y quitando solo `clientes/loading.tsx` pasaba siempre.
 *
 * Por eso las pantallas con formularios de ese tipo (Caja, Clientes,
 * Comisiones, Equipo, Reportes, Servicios) no tienen esqueleto de ruta: la
 * respuesta al toque la dan la pastilla de la barra, la barra de progreso de
 * `NavProgress` y el giro en las flechas de `DateStepper`. Este test falla si
 * alguien vuelve a juntar las dos cosas.
 */

const PANEL = fileURLToPath(new URL(".", import.meta.url));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Las carpetas de ruta que tienen su propio `loading.tsx`. */
function routesWithLoading(dir: string): string[] {
  const here = existsSync(join(dir, "loading.tsx")) ? [dir] : [];
  const children = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory())
    .flatMap(routesWithLoading);
  return [...here, ...children];
}

describe("esqueletos de ruta", () => {
  it("ninguna ruta con loading.tsx tiene formularios con useActionState", () => {
    const offenders = routesWithLoading(PANEL).flatMap((route) =>
      filesUnder(route)
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
        .filter((file) => /\buseActionState\s*[<(]/.test(readFileSync(file, "utf8")))
        .map((file) => relative(PANEL, file)),
    );
    expect(offenders).toEqual([]);
  });

  it("y el test mira lo que tiene que mirar", () => {
    // Sin esto, un cambio de carpetas que dejara `routesWithLoading` vacío
    // haría pasar el test de arriba sin revisar nada.
    expect(routesWithLoading(PANEL).length).toBeGreaterThan(0);
  });
});
