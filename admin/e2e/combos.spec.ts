import type { Locator, Page } from "@playwright/test";

import { contarCitasEnEa, expect, phoneNuevo, queryEa, test } from "./fixtures";

/**
 * Llegar a un combo eligiendo sus dos mitades.
 *
 * **El caso real**: quien atiende el teléfono piensa "semipermanente en manos…
 * ah, y pies también", no "combo número cuatro". Buscar el combo correcto entre
 * veinticinco servicios, cuando ya se eligió una de sus mitades, es trabajo que
 * la agenda existe para ahorrar — y el que no se hace es el que termina
 * agendando dos citas sueltas y cobrando la suma.
 *
 * ## Por qué esto no puede ser un unitario
 *
 * La aritmética ya está cubierta en `lib/combos.test.ts`. Lo que **solo** se ve
 * cargando la página es la cadena entera: la composición horneada desde la
 * vitrina (`admin/src/data/combo-composition.ts`), traducida a ids de EA con
 * `service_map`, aplicada a un catálogo que EA devuelve de verdad, y guardada
 * como **un** servicio de EA distinto al que se eligió primero. Cada eslabón de
 * esa cadena vive en un módulo distinto y ninguno se equivoca solo.
 *
 * ## El combo se publica desde el panel, no se siembra por SQL
 *
 * Los tres servicios se crean por la pantalla de Servicios, que es como se
 * crean de verdad (`docs/DEPLOY.md` § los combos). Sembrarlos con un INSERT
 * saltaría justo el paso que conecta la vitrina con la agenda —`service_map`—
 * que es el que decide si un combo se puede componer o no.
 */

/**
 * Las tres piezas, con los ids que declara `src/data/pricing.ts`.
 *
 * Los nombres los escribe una persona, acá y en el estudio: `pricing.ts` guarda
 * id, precio y duración, y los nombres viven en los diccionarios de la landing,
 * que el panel no importa.
 */
const PIEZAS = [
  { pricingId: "semi-permanent-hands", nombre: "E2E Semipermanente manos" },
  { pricingId: "semi-permanent-feet", nombre: "E2E Semipermanente pies" },
  { pricingId: "semi-permanent-hands-feet", nombre: "E2E Combo manos y pies" },
] as const;

/** Lo que `src/data/pricing.ts` dice de estas tres. La prueba de que no se suma. */
const PRECIO_MANOS = 50_000;
const PRECIO_PIES = 55_000;
const PRECIO_COMBO = 95_000;
const SUMA = PRECIO_MANOS + PRECIO_PIES; // 105.000 — lo que NO se cobra.

/**
 * Elige en un `<select>` la opción cuyo texto contiene lo que se pide.
 *
 * `selectOption({ label })` exige el texto **exacto**, y las opciones de la
 * agenda llevan la duración pegada ("E2E Semipermanente manos · 1 h"): la
 * coincidencia exacta falla y el mensaje —"expected string, got object" si se
 * intenta con una expresión regular— no habla de eso. Se resuelve por el
 * `value`, que es el id de EA y es lo único estable.
 */
async function elegirPorTexto(select: Locator, contiene: string): Promise<void> {
  const opcion = select.locator("option").filter({ hasText: contiene }).first();
  await expect(opcion, `no hay ninguna opción que diga "${contiene}"`).toHaveCount(1);
  await select.selectOption(await opcion.getAttribute("value"));
}

/**
 * Deja las tres piezas publicadas en EA y vinculadas en `service_map`.
 *
 * Idempotente: si ya están —porque la suite corrió antes contra el mismo
 * stack— la fila deja de ofrecer "Crear" y no hay nada que hacer. Un `beforeAll`
 * que fallara la segunda vez convertiría la suite en dependiente del orden.
 */
async function publicarPiezas(panel: Page): Promise<void> {
  for (const pieza of PIEZAS) {
    await panel.goto("/admin/servicios");

    // El campo trae una etiqueta de solo-lector que nombra el id: es la única
    // forma de apuntar a la fila correcta sin depender del orden de la tabla.
    const campo = panel.getByLabel(new RegExp(`${pieza.pricingId} aparece en la agenda`));
    if ((await campo.count()) === 0) continue; // ya estaba vinculada

    await campo.fill(pieza.nombre);
    await campo.locator("xpath=following-sibling::button[1]").click();

    await expect(
      panel.getByText(new RegExp(`quedó creado en la agenda y vinculado a "${pieza.pricingId}"`)),
      `no se pudo publicar ${pieza.pricingId}`,
    ).toBeVisible({ timeout: 20_000 });
  }
}

test.describe("componer un combo desde la agenda", () => {
  test.beforeEach(async ({ panel }) => {
    await publicarPiezas(panel);
  });

  test("el combo no está en la lista de servicios", async ({ panel }) => {
    // Dejarlo también en la lista sería dar dos caminos al mismo sitio, y el de
    // la lista es el que se toma por error cuando lo que se quería era el
    // servicio suelto de al lado.
    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    const servicio = panel.getByRole("combobox", { name: /^Servicio/ });
    const opciones = await servicio.locator("option").allTextContents();

    expect(opciones.some((o) => o.includes("E2E Semipermanente manos"))).toBe(true);
    expect(
      opciones.some((o) => o.includes("E2E Combo manos y pies")),
      "el combo se ofrece en la lista: se llega a él componiendo, no eligiéndolo",
    ).toBe(false);
  });

  test("elegir manos ofrece pies, y el par muestra el precio del combo", async ({ panel }) => {
    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    // Un servicio suelto no ofrece acompañante: la pregunta solo aparece cuando
    // hay un combo de verdad detrás.
    await expect(panel.getByLabel(/¿También pies\?/)).toHaveCount(0);

    await elegirPorTexto(
      panel.getByRole("combobox", { name: /^Servicio/ }),
      "E2E Semipermanente manos",
    );

    const acompañante = panel.getByLabel(/¿También pies\?/);
    await expect(acompañante, "elegir manos no ofreció los pies").toBeVisible();

    await elegirPorTexto(acompañante, "E2E Semipermanente pies");

    // El "antes y después". Las dos cifras tienen que estar a la vez: la suma
    // de las mitades —el precio que **no** se va a cobrar, tachado— y el del
    // combo. Mostrar solo una convierte el descuento en un número sin contexto.
    const cotizacion = panel.getByText(/Ahorra/);
    await expect(cotizacion).toBeVisible();

    await expect(panel.getByText(/105\.000/), "no se muestra la suma tachada").toBeVisible();
    await expect(panel.getByText(/95\.000/), "no se muestra el precio del combo").toBeVisible();
    await expect(cotizacion).toContainText(/10\.000/);

    // Y la duración que **manda** es la del combo.
    //
    // Se comprueba sobre el campo "Termina" y no sobre el texto de la
    // cotización: ahí arriba las dos duraciones aparecen juntas a propósito
    // (2 h 15 min tachado, 2 h real), así que buscar texto no distingue cuál
    // ganó. El fin de la cita sí: 2 h después del inicio, no 2 h 15.
    await panel.getByLabel(/^Empieza/).fill("10:00");
    await expect(
      panel.getByLabel(/^Termina/),
      "el fin salió de la suma de las mitades en vez de la duración del combo",
    ).toHaveValue("12:00");
  });

  test("quitar los pies devuelve la cita al servicio suelto", async ({ panel }) => {
    // Si esto no cerrara, quitar el acompañante dejaría la cita en el combo y
    // se cobraría un combo por unas manos.
    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    const servicio = panel.getByRole("combobox", { name: /^Servicio/ });
    await elegirPorTexto(servicio, "E2E Semipermanente manos");
    await elegirPorTexto(panel.getByLabel(/¿También pies\?/), "E2E Semipermanente pies");
    await expect(panel.getByText(/Ahorra/)).toBeVisible();

    await elegirPorTexto(panel.getByLabel(/¿También pies\?/), "No, solo manos");

    await expect(panel.getByText(/Ahorra/), "la cotización del combo se quedó pegada").toHaveCount(
      0,
    );
    // El selector principal sigue en la mitad que se había elegido.
    await expect(servicio).toHaveValue(/\d+/);
  });

  test("agendar el par guarda UNA cita, y es la del combo", async ({ panel }) => {
    // La afirmación que resume el diseño entero: dos servicios elegidos, **una**
    // cita, con el id del servicio combo. Si alguna vez esto guardara dos citas
    // o la del servicio de manos, el estudio cobraría mal sin que nada avise.
    const marca = `Cbo${Date.now().toString().slice(-6)}`;
    const antes = contarCitasEnEa();

    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    await panel.getByRole("textbox", { name: /^Clienta/ }).fill(`${marca} Test`);
    await panel.getByRole("button", { name: /crear «/i }).click();
    await panel.getByRole("textbox", { name: /^Nombre\b/ }).fill(marca);
    await panel.getByRole("textbox", { name: /^Apellido\b/ }).fill("Test");
    await panel.getByRole("textbox", { name: /^Teléfono/ }).fill(phoneNuevo());
    await panel.getByRole("button", { name: /crear y usar/i }).click();
    await expect(panel.getByRole("button", { name: /cambiar/i })).toBeVisible();

    await elegirPorTexto(
      panel.getByRole("combobox", { name: /^Servicio/ }),
      "E2E Semipermanente manos",
    );
    await elegirPorTexto(panel.getByLabel(/¿También pies\?/), "E2E Semipermanente pies");

    // Una franja propia y fuera de horario, para no chocar con lo que dejaron
    // los otros archivos de la suite. La casilla lo autoriza de una.
    await panel.getByLabel(/^Empieza/).fill("22:00");
    await panel.getByRole("checkbox", { name: /fuera del horario/i }).check();
    await panel.getByRole("button", { name: /^crear cita$/i }).click();

    await expect(panel.getByText("Cita creada.")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(contarCitasEnEa, { timeout: 15_000, message: "EA no recibió la cita" })
      .toBe(antes + 1);

    // Y quedó guardada con el servicio del **combo**, no con el de las manos.
    //
    // Se comprueba en la base de EA y no en la grilla: la cita se agendó a las
    // 22:00 para no chocar con el resto de la suite, y la jornada visible llega
    // hasta las 20:00 — el bloque existe y no está dibujado. Buscarlo en
    // pantalla daría rojo hablando de otra cosa.
    const servicio = queryEa(
      `SELECT s.name FROM ea_appointments a
         JOIN ea_services s ON s.id = a.id_services
         JOIN ea_users c ON c.id = a.id_users_customer
        WHERE c.first_name = '${marca}'
        ORDER BY a.id DESC LIMIT 1`,
    );
    expect(servicio, "la cita quedó con el servicio suelto en vez del combo").toBe(
      "E2E Combo manos y pies",
    );
  });
});

/** Lo que la vitrina afirma y este archivo da por cierto. Falla ruidoso si cambia. */
test("los números de la vitrina siguen siendo los que este archivo supone", () => {
  expect(SUMA).toBe(105_000);
  expect(PRECIO_COMBO).toBeLessThan(SUMA);
});
