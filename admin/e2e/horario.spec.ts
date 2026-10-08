import type { Page } from "@playwright/test";

import { contarCitasEnEa, expect, phoneNuevo, test } from "./fixtures";

/**
 * Agendar fuera del horario de la profesional, a propósito.
 *
 * **El caso real**: "entra a las 7 porque la clienta viaja", "hoy me quedo
 * hasta las 9". La jornada de una técnica es una política, no una ley de la
 * física, y la recepción tiene que poder pasarle por encima sin salirse del
 * panel — porque lo que se arregla fuera del panel es lo que deja de existir
 * como dato.
 *
 * Lo que este archivo fija es que **la casilla no es el `force` de siempre**.
 * "Guardar de todas formas" dice que sí a todo con un clic, doble reserva
 * incluida. La casilla apaga solo el plan de trabajo. Esa diferencia no se ve
 * en ninguna pantalla: se comprueba mandando las dos situaciones y mirando cuál
 * pide confirmación.
 *
 * El plan del provider en el stack de pruebas va de 8 a 20 todos los días
 * (`scripts/ci-prepare-ea.sh`), así que las 21:00 están fuera de la jornada sin
 * depender de qué día se corra la suite.
 */

/**
 * Horas que el plan de trabajo del stack de pruebas no cubre nunca.
 *
 * Son **dos y separadas** porque los tests de este archivo comparten la misma
 * agenda: si todos agendaran a la misma hora, el segundo chocaría contra la
 * cita que dejó el primero y el rojo hablaría del orden en que se corrió la
 * suite, no del código. Cada grupo se lleva su franja.
 */
const TARDE = "21:00";
const TEMPRANO = "06:00";

/** Deja el formulario listo con una clienta nueva, a la hora que se pida. */
async function armarCita(panel: Page, marca: string, hora: string) {
  await panel.goto("/admin/agenda");
  await panel.getByRole("button", { name: /nueva cita/i }).click();

  await panel.getByRole("textbox", { name: /^Clienta/ }).fill(`${marca} Test`);
  await panel.getByRole("button", { name: /crear «/i }).click();
  await panel.getByRole("textbox", { name: /^Nombre\b/ }).fill(marca);
  await panel.getByRole("textbox", { name: /^Apellido\b/ }).fill("Test");
  await panel.getByRole("textbox", { name: /^Teléfono/ }).fill(phoneNuevo());
  await panel.getByRole("button", { name: /crear y usar/i }).click();
  await expect(panel.getByRole("button", { name: /cambiar/i })).toBeVisible();

  const servicio = panel.getByRole("combobox", { name: /^Servicio/ });
  await servicio.selectOption({ index: 1 });

  // El fin se recalcula solo desde el inicio con la duración del servicio, así
  // que basta con correr el inicio. `getByLabel` y no `getByRole("textbox")`:
  // un `<input type="time">` no expone ese rol.
  await panel.getByLabel(/^Empieza/).fill(hora);
}

test.describe("fuera del horario de la profesional", () => {
  test("sin la casilla, el panel pide confirmación", async ({ panel }) => {
    // Es el comportamiento de siempre y tiene que seguir ahí: agendar a las
    // nueve de la noche por accidente no puede ser silencioso.
    const marca = `T1${Date.now().toString().slice(-6)}`;
    await armarCita(panel, marca, TARDE);

    await panel.getByRole("button", { name: /^crear cita$/i }).click();

    await expect(
      panel.getByRole("button", { name: /guardar de todas formas/i }),
      "el panel guardó a las 21:00 sin decir que está fuera de horario",
    ).toBeVisible({ timeout: 10_000 });

    // Y el motivo se lee, no solo el botón.
    await expect(panel.getByText(/fuera del horario|no trabaja ese día/i).first()).toBeVisible();
  });

  test("con la casilla, guarda directo y sin preguntar", async ({ panel }) => {
    const marca = `T2${Date.now().toString().slice(-6)}`;
    const antes = contarCitasEnEa();

    await armarCita(panel, marca, TARDE);
    await panel
      .getByRole("checkbox", { name: /fuera del horario de la profesional/i })
      .check();

    await panel.getByRole("button", { name: /^crear cita$/i }).click();

    // El desenlace es la cita creada, **sin** el paso intermedio. Antes había
    // que enviar, leer el reporte y volver a apretar: tres pasos para una
    // decisión que ya estaba tomada al abrir el formulario.
    await expect(panel.getByText("Cita creada.")).toBeVisible({ timeout: 15_000 });
    await expect(
      panel.getByRole("button", { name: /guardar de todas formas/i }),
      "pidió confirmar algo que la casilla ya había autorizado",
    ).toHaveCount(0);

    // La afirmación que no se puede falsear: EA tiene una cita más.
    await expect
      .poll(contarCitasEnEa, { timeout: 15_000, message: "EA no recibió la cita" })
      .toBe(antes + 1);
  });

  test("la casilla NO tapa una doble reserva", async ({ panel }) => {
    // Es la razón de existir de la casilla frente a "Guardar de todas formas".
    // Si esto se rompe, el síntoma son dos clientas en la misma silla a la
    // misma hora, autorizado por una casilla que decía hablar de horarios.
    const marca = `T3${Date.now().toString().slice(-6)}`;

    // Primera cita en la franja de la mañana, autorizada por la casilla. Va en
    // otra hora que los tests de arriba justamente para que **esta** sea la
    // primera: el choque que se quiere provocar es contra ella, no contra el
    // sedimento de otro test.
    await armarCita(panel, marca, TEMPRANO);
    await panel
      .getByRole("checkbox", { name: /fuera del horario de la profesional/i })
      .check();
    await panel.getByRole("button", { name: /^crear cita$/i }).click();
    await expect(panel.getByText("Cita creada.")).toBeVisible({ timeout: 15_000 });

    // Segunda, encima de la primera, con la misma casilla marcada.
    const otra = `T4${Date.now().toString().slice(-6)}`;
    await armarCita(panel, otra, TEMPRANO);
    await panel
      .getByRole("checkbox", { name: /fuera del horario de la profesional/i })
      .check();
    await panel.getByRole("button", { name: /^crear cita$/i }).click();

    await expect(
      panel.getByRole("button", { name: /guardar de todas formas/i }),
      "la casilla del horario dejó pasar una cita encimada",
    ).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("la jornada visible se puede correr", () => {
  test("hay cómo ver una hora antes y una después, sin citas escondidas", async ({ panel }) => {
    // Antes, ampliar la grilla solo era posible si YA había una cita fuera de
    // la jornada: había que crear la cita para poder ver dónde crearla.
    await panel.goto("/admin/agenda");

    const masTarde = panel.getByRole("button", { name: /mostrar una hora más tarde/i });
    await expect(masTarde, "no hay forma de ver más allá del fin de la jornada").toBeVisible();

    // El plan del stack de pruebas termina a las 20:00, así que el gutter llega
    // hasta las 19:45 y "8 p. m." todavía no se etiqueta.
    const ochoPm = panel.getByText("8 p. m.", { exact: true }).first();
    await expect(ochoPm, "la jornada ya mostraba las 8 p. m. sin ampliarla").toHaveCount(0);

    await masTarde.click();
    await expect(ochoPm, "ampliar la jornada no descubrió la hora siguiente").toBeVisible();

    await expect(
      panel.getByRole("button", { name: /mostrar una hora más temprano/i }),
    ).toBeVisible();
  });
});
