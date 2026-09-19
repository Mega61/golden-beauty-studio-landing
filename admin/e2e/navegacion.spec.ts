import { expect, test } from "./fixtures";

/**
 * Que cada pantalla monte, y que se pueda salir de ella.
 *
 * **Éste es el test que faltaba.** Cinco pantallas —Clientas, la ficha de la
 * clienta, Equipo, la ficha de la profesional y Servicios— llegaron a estar sin
 * barra de navegación: el layout de `(panel)` solo garantiza la sesión y el
 * shell lo monta cada página, así que olvidarlo no rompe nada visible en
 * desarrollo salvo que alguien entre y busque cómo volver.
 *
 * Los 1.870 unitarios pasaban con el defecto adentro. No podían verlo: ninguno
 * abre una página.
 */

/** Las nueve pantallas del panel, con algo que solo aparece si montó bien. */
const PANTALLAS = [
  { ruta: "/admin/hoy", titulo: "Hoy" },
  { ruta: "/admin/agenda", titulo: "Agenda" },
  { ruta: "/admin/caja", titulo: "Caja" },
  { ruta: "/admin/clientes", titulo: "Clientas" },
  { ruta: "/admin/comisiones", titulo: "Comisiones" },
  { ruta: "/admin/servicios", titulo: "Servicios" },
  { ruta: "/admin/equipo", titulo: "Equipo" },
  { ruta: "/admin/reportes", titulo: "Reportes" },
  { ruta: "/admin/diagnostico", titulo: "Diagnóstico" },
] as const;

test.describe("la navegación no desaparece", () => {
  for (const { ruta, titulo } of PANTALLAS) {
    test(`${titulo} monta el shell y deja volver`, async ({ panel }) => {
      const respuesta = await panel.goto(ruta);

      // Un 500 acá es el modo de falla que tuvo `/reportes` durante semanas:
      // compilaba, pasaba el lint, pasaba los tests, y reventaba al pedirla.
      expect(respuesta?.status(), `${ruta} respondió ${respuesta?.status()}`).toBe(200);

      // La barra lateral en escritorio, la inferior en móvil. Al menos una
      // tiene que estar **visible**, o la pantalla es una calle sin salida.
      //
      // `:visible` no es cosmético: debajo de 768 px el `<aside>` sigue en el
      // DOM con `display:none` y la navegación real es la barra inferior. Sin
      // el filtro, el test daba rojo en móvil sobre una pantalla que estaba
      // perfectamente navegable.
      const navegacion = panel.locator("aside:visible, nav:visible").first();
      await expect(navegacion, `${ruta} se quedó sin navegación`).toBeVisible();

      // Y tiene que llevar a otro lado de verdad, no solo dibujarse.
      await expect(navegacion.getByRole("link").first()).toBeVisible();
    });
  }
});

test.describe("el catálogo de destinos", () => {
  test("ningún enlace del menú lleva a un 404", async ({ panel }) => {
    // El bug: «Avanzado (EA)» apuntaba a `/avanzado`, una ruta que nunca se
    // creó. Abría una pestaña nueva en un 404, y como abre en pestaña nueva
    // nadie lo reportó por semanas.
    await panel.goto("/admin/hoy");

    const hrefs = await panel
      .locator("aside a[href], nav a[href]")
      .evaluateAll((as) => as.map((a) => a.getAttribute("href")!));

    expect(hrefs.length, "el menú no trajo ningún enlace").toBeGreaterThan(3);

    for (const href of hrefs) {
      // Los externos (la interfaz de EA) viven fuera del panel y su
      // disponibilidad no es cosa de este test.
      if (/^https?:\/\//.test(href)) continue;

      const r = await panel.request.get(href);
      expect(r.status(), `${href} respondió ${r.status()}`).toBeLessThan(400);
    }
  });
});

test.describe("la sesión", () => {
  test.describe("sin entrar", () => {
    // Explícitamente **sin** la sesión que el proyecto `setup` dejó: este es el
    // único bloque que necesita un navegador anónimo, y sin esta línea heredaba
    // la cookie de los demás y comprobaba lo contrario de lo que dice.
    test.use({ storageState: { cookies: [], origins: [] } });

    test("cualquier pantalla manda a entrar", async ({ page }) => {
    // Esconder un enlace no es un permiso. La compuerta es el DAL, y esto lo
    // comprueba pidiendo la URL a mano, que es lo que haría alguien.
      for (const { ruta } of PANTALLAS) {
        const r = await page.request.get(ruta, { maxRedirects: 0 });
        expect([302, 307], `${ruta} no redirigió: ${r.status()}`).toContain(r.status());
        expect(r.headers()["location"]).toContain("/entrar");
      }
    });
  });

  test("la raíz del panel lleva a Hoy y no a un 404", async ({ panel }) => {
    // `/admin` a secas es lo que alguien guarda en favoritos.
    await panel.goto("/admin");
    await expect(panel).toHaveURL(/\/admin\/hoy/);
  });
});
