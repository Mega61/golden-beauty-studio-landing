import type { Locator, Page } from "@playwright/test";
import { parsePricingSource } from "../src/app/(panel)/servicios/pricing-parse";
import { SHOWCASE_PRICING_SOURCE } from "../src/data/showcase-pricing";

import {
  aviso,
  contarCitasEnEa,
  elegirHora,
  elegirOpcion,
  expect,
  nombresDeOpciones,
  phoneNuevo,
  queryEa,
  queryOne,
  test,
} from "./fixtures";

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
 * que el panel no importa. `nombre` es el que se usa **si hay que crearla**; si
 * la pieza ya estaba vinculada —la base de desarrollo trae las del estudio, con
 * sus nombres de verdad— manda el que tiene en EA. Ver `nombresVinculados()`.
 */
const PIEZAS = [
  { pricingId: "semi-permanent-hands", nombre: "E2E Semipermanente manos" },
  { pricingId: "semi-permanent-feet", nombre: "E2E Semipermanente pies" },
  { pricingId: "semi-permanent-hands-feet", nombre: "E2E Combo manos y pies" },
] as const;

type PricingId = (typeof PIEZAS)[number]["pricingId"];

/**
 * Lo que `src/data/pricing.ts` dice de estas tres. La prueba de que no se suma.
 *
 * Se leen de la copia horneada y no se escriben acá: la dueña cambia precios,
 * y un número escrito a mano dejaba la suite en rojo por un cambio correcto.
 */
const VITRINA = new Map(parsePricingSource(SHOWCASE_PRICING_SOURCE).map((e) => [e.id, e]));
const precioDe = (id: PricingId): number => {
  const entrada = VITRINA.get(id);
  if (!entrada) throw new Error(`${id} ya no está en pricing.ts`);
  return entrada.priceCOP;
};
const PRECIO_MANOS = precioDe("semi-permanent-hands");
const PRECIO_PIES = precioDe("semi-permanent-feet");
const PRECIO_COMBO = precioDe("semi-permanent-hands-feet");
const SUMA = PRECIO_MANOS + PRECIO_PIES; // lo que NO se cobra.
const DURACION_COMBO = VITRINA.get("semi-permanent-hands-feet")?.durationMin ?? 0;

/** `95000` → `/95\.000/`, como lo escribe la pantalla. */
const cifra = (pesos: number): RegExp =>
  new RegExp(pesos.toLocaleString("es-CO").replace(/\./g, "\\."));

/** Elige en el selector de la agenda el servicio con ese nombre exacto. */
async function elegirPorTexto(campo: Locator, nombre: string): Promise<void> {
  await elegirOpcion(campo, { nombre });
}

/**
 * Con qué nombre quedó en EA cada pieza, leído de `service_map`.
 *
 * Es lo que la agenda muestra, y no tiene por qué ser el `nombre` de `PIEZAS`:
 * contra la base de desarrollo las piezas ya existen con los nombres del
 * estudio, y suponer los de la suite hacía fallar todo con "no hay ninguna
 * opción" sin que nada estuviera roto.
 */
function nombresVinculados(): Record<PricingId, string> {
  const nombres = {} as Record<PricingId, string>;
  for (const { pricingId } of PIEZAS) {
    const nombre = queryOne(
      `SELECT s.name FROM service_map m
         JOIN easyappointments.ea_services s ON s.id = m.ea_service_id
        WHERE m.pricing_id = '${pricingId}'`,
    );
    if (!nombre) throw new Error(`${pricingId} no quedó vinculado a ningún servicio de EA`);
    nombres[pricingId] = nombre;
  }
  return nombres;
}

/**
 * Deja las tres piezas publicadas en EA y vinculadas en `service_map`.
 *
 * Idempotente: si ya están —porque la suite corrió antes contra el mismo
 * stack— la fila deja de ofrecer "Crear" y no hay nada que hacer. Un `beforeAll`
 * que fallara la segunda vez convertiría la suite en dependiente del orden.
 */
async function publicarPiezas(panel: Page): Promise<Record<PricingId, string>> {
  for (const pieza of PIEZAS) {
    await panel.goto("/admin/servicios");

    // El campo trae una etiqueta de solo-lector que nombra el id: es la única
    // forma de apuntar a la fila correcta sin depender del orden de la tabla.
    const campo = panel.getByLabel(new RegExp(`${pieza.pricingId} aparece en la agenda`));
    if ((await campo.count()) === 0) continue; // ya estaba vinculada

    await campo.fill(pieza.nombre);
    await campo.locator("xpath=following-sibling::button[1]").click();

    // Llega como toast: la fila sale de la lista de pendientes en cuanto queda
    // vinculada, y el formulario —con su mensaje— se va con ella.
    await expect(
      aviso(panel),
      `no se pudo publicar ${pieza.pricingId}`,
    ).toContainText(`quedó creado en la agenda y vinculado a "${pieza.pricingId}"`, {
      timeout: 20_000,
    });
  }
  return nombresVinculados();
}

test.describe("componer un combo desde la agenda", () => {
  let MANOS = "";
  let PIES = "";
  let COMBO = "";

  test.beforeEach(async ({ panel }) => {
    const nombres = await publicarPiezas(panel);
    MANOS = nombres["semi-permanent-hands"];
    PIES = nombres["semi-permanent-feet"];
    COMBO = nombres["semi-permanent-hands-feet"];
  });

  test("el combo no está en la lista de servicios", async ({ panel }) => {
    // Dejarlo también en la lista sería dar dos caminos al mismo sitio, y el de
    // la lista es el que se toma por error cuando lo que se quería era el
    // servicio suelto de al lado.
    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    const servicio = panel.getByRole("combobox", { name: /^Servicio/ });
    const opciones = await nombresDeOpciones(servicio);

    expect(opciones).toContain(MANOS);
    expect(
      opciones.includes(COMBO),
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
      MANOS,
    );

    const acompañante = panel.getByLabel(/¿También pies\?/);
    await expect(acompañante, "elegir manos no ofreció los pies").toBeVisible();

    await elegirPorTexto(acompañante, PIES);

    // El "antes y después". Las dos cifras tienen que estar a la vez: la suma
    // de las mitades —el precio que **no** se va a cobrar, tachado— y el del
    // combo. Mostrar solo una convierte el descuento en un número sin contexto.
    const cotizacion = panel.getByText(/Ahorra/);
    await expect(cotizacion).toBeVisible();

    await expect(panel.getByText(cifra(SUMA)), "no se muestra la suma tachada").toBeVisible();
    await expect(panel.getByText(cifra(PRECIO_COMBO)), "no se muestra el precio del combo").toBeVisible();
    await expect(cotizacion).toContainText(cifra(SUMA - PRECIO_COMBO));

    // Y la duración que **manda** es la del combo.
    //
    // Se comprueba sobre el campo "Termina" y no sobre el texto de la
    // cotización: ahí arriba las dos duraciones aparecen juntas a propósito
    // (2 h 15 min tachado, 2 h real), así que buscar texto no distingue cuál
    // ganó. El fin de la cita sí: 2 h después del inicio, no 2 h 15.
    await elegirHora(panel.getByLabel(/^Empieza/), "10:00");
    await expect(
      panel.getByLabel(/^Termina/),
      "el fin salió de la suma de las mitades en vez de la duración del combo",
    ).toHaveAttribute("data-value", "12:00");
  });

  test("quitar los pies devuelve la cita al servicio suelto", async ({ panel }) => {
    // Si esto no cerrara, quitar el acompañante dejaría la cita en el combo y
    // se cobraría un combo por unas manos.
    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    const servicio = panel.getByRole("combobox", { name: /^Servicio/ });
    await elegirPorTexto(servicio, MANOS);
    await elegirPorTexto(panel.getByLabel(/¿También pies\?/), PIES);
    await expect(panel.getByText(/Ahorra/)).toBeVisible();

    await elegirPorTexto(panel.getByLabel(/¿También pies\?/), "No, solo manos");

    await expect(panel.getByText(/Ahorra/), "la cotización del combo se quedó pegada").toHaveCount(
      0,
    );
    // El selector principal sigue en la mitad que se había elegido.
    await expect(servicio).toHaveAttribute("data-value", /\d+/);
  });

  test("agendar el par guarda UNA cita, y es la del combo", async ({ panel }) => {
    // La afirmación que resume el diseño entero: dos servicios elegidos, **una**
    // cita, con el id del servicio combo. Si alguna vez esto guardara dos citas
    // o la del servicio de manos, el estudio cobraría mal sin que nada avise.
    const marca = `Cbo${Date.now().toString().slice(-6)}`;
    const antes = contarCitasEnEa();

    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    await panel.getByRole("textbox", { name: /^Cliente/ }).fill(`${marca} Test`);
    await panel.getByRole("button", { name: /crear «/i }).click();
    await panel.getByRole("textbox", { name: /^Nombre\b/ }).fill(marca);
    await panel.getByRole("textbox", { name: /^Apellido\b/ }).fill("Test");
    await panel.getByRole("textbox", { name: /^Teléfono/ }).fill(phoneNuevo());
    await panel.getByRole("button", { name: /crear y usar/i }).click();
    await expect(panel.getByRole("button", { name: /cambiar/i })).toBeVisible();

    await elegirPorTexto(
      panel.getByRole("combobox", { name: /^Servicio/ }),
      MANOS,
    );
    await elegirPorTexto(panel.getByLabel(/¿También pies\?/), PIES);

    // Una franja propia y fuera de horario, para no chocar con lo que dejaron
    // los otros archivos de la suite (ver las franjas en `caja.spec.ts`). A las
    // 22:00 el combo se encimaba con la cita de las 21:00 de `horario.spec.ts`
    // en cuanto el primer servicio durara más de una hora. La casilla lo
    // autoriza de una.
    await elegirHora(panel.getByLabel(/^Empieza/), "00:30");
    await panel.getByRole("checkbox", { name: /fuera del horario/i }).check();
    await panel.getByRole("button", { name: /^crear cita$/i }).click();

    await expect(panel.getByText("Cita creada.")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(contarCitasEnEa, { timeout: 15_000, message: "EA no recibió la cita" })
      .toBe(antes + 1);

    // Y quedó guardada con el servicio del **combo**, no con el de las manos.
    //
    // Se comprueba en la base de EA y no en la grilla: la cita se agendó a las
    // 00:30 para no chocar con el resto de la suite, y la jornada visible empieza
    // a las 08:00 — el bloque existe y no está dibujado. Buscarlo en
    // pantalla daría rojo hablando de otra cosa.
    const servicio = queryEa(
      `SELECT s.name FROM ea_appointments a
         JOIN ea_services s ON s.id = a.id_services
         JOIN ea_users c ON c.id = a.id_users_customer
        WHERE c.first_name = '${marca}'
        ORDER BY a.id DESC LIMIT 1`,
    );
    expect(servicio, "la cita quedó con el servicio suelto en vez del combo").toBe(COMBO);
  });
});

test.describe("manos + pies que no son combo, desde la agenda", () => {
  // Esculpidas no tiene combo con ningún pie. Antes, la agenda no tenía cómo
  // sumarle los pies: el formulario solo ofrecía la otra mitad de un combo, y
  // la dueña dejó de usar la agenda por eso.
  const ESCULPIDAS = { pricingId: "acrylic-sculpted", nombre: "E2E Esculpidas en acrílico" };

  test("se agenda como UNA cita, con los pies de adicional", async ({ panel }) => {
    // La dueña lo pidió así: una reserva, un bloque en la agenda, una cuenta.
    // Antes eran dos citas pegadas, y eso eran dos "Llegó" y dos cuentas.
    const nombres = await publicarPiezas(panel);
    await panel.goto("/admin/servicios");
    const campo = panel.getByLabel(new RegExp(`${ESCULPIDAS.pricingId} aparece en la agenda`));
    if ((await campo.count()) > 0) {
      await campo.fill(ESCULPIDAS.nombre);
      await campo.locator("xpath=following-sibling::button[1]").click();
      await expect(aviso(panel)).toContainText("quedó creado en la agenda", { timeout: 20_000 });
    }
    // Por id y no por nombre: el cliente de MySQL del contenedor devuelve la
    // "í" de "acrílico" rota, y el nombre no coincidiría con el de la pantalla.
    const idDe = (pricingId: string) => {
      const id = queryOne(`SELECT ea_service_id FROM service_map WHERE pricing_id = '${pricingId}'`);
      if (!id) throw new Error(`${pricingId} no quedó vinculado`);
      return id;
    };
    const MANOS = idDe(ESCULPIDAS.pricingId);
    const PIES = idDe("semi-permanent-feet");

    const marca = `CboPar${Date.now().toString().slice(-6)}`;
    const antes = contarCitasEnEa();

    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    await panel.getByRole("textbox", { name: /^Cliente/ }).fill(`${marca} Test`);
    await panel.getByRole("button", { name: /crear «/i }).click();
    await panel.getByRole("textbox", { name: /^Nombre\b/ }).fill(marca);
    await panel.getByRole("textbox", { name: /^Apellido\b/ }).fill("Test");
    await panel.getByRole("textbox", { name: /^Teléfono/ }).fill(phoneNuevo());
    await panel.getByRole("button", { name: /crear y usar/i }).click();
    await expect(panel.getByRole("button", { name: /cambiar/i })).toBeVisible();

    // Casi cuatro horas: va en el hueco de 10:00 a 21:00 de la primera
    // profesional (ver `caja.spec.ts`). La base de CI siembra **una sola**.
    await elegirOpcion(panel.getByRole("combobox", { name: /^Profesional/ }), { index: 0 });
    await elegirHora(panel.getByLabel(/^Empieza/), "16:00");
    await elegirOpcion(panel.getByRole("combobox", { name: /^Servicio/ }), { valor: MANOS });
    await panel.getByRole("button", { name: /agregar otro servicio/i }).click();
    await elegirOpcion(panel.getByLabel(/otro servicio en la misma cita/i), { valor: PIES });

    // El fin cubre los dos: 150 + 75 minutos.
    await expect(panel.getByLabel(/^Termina/)).toHaveAttribute("data-value", "19:45");

    await panel.getByRole("checkbox", { name: /fuera del horario/i }).check();
    await panel.getByRole("button", { name: /^crear cita$/i }).click();

    await expect(panel.getByText("Cita creada.")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(contarCitasEnEa, { timeout: 15_000, message: "EA no recibió la cita" })
      .toBe(antes + 1);

    // Una sola cita en EA, con el servicio principal y el rango entero…
    const fila = queryEa(
      `SELECT CONCAT(a.id, '|', a.id_services, '|', TIME(a.start_datetime), '|', TIME(a.end_datetime))
         FROM ea_appointments a
         JOIN ea_users c ON c.id = a.id_users_customer
        WHERE c.first_name = '${marca}'`,
    );
    const [idCita, ...resto] = (fila ?? "").split("|");
    expect(resto.join("|")).toBe(`${MANOS}|16:00:00|19:45:00`);

    // …y los pies como adicional de esa misma cita.
    expect(
      queryOne(`SELECT GROUP_CONCAT(ea_service_id) FROM appointment_planned_service WHERE ea_appointment_id = ${idCita}`),
    ).toBe(PIES);

    // En Hoy es una tarjeta que nombra los dos, y su cuenta los cobra juntos.
    await panel.goto("/admin/hoy");
    await expect(panel.getByText(`+ ${nombres["semi-permanent-feet"]}`).first()).toBeVisible();

    queryOne(`DELETE FROM appointment_planned_service WHERE ea_appointment_id = ${idCita}`);
  });
});

/** Lo que la vitrina afirma y este archivo da por cierto. Falla ruidoso si cambia. */
test("los números de la vitrina siguen siendo los que este archivo supone", () => {
  // Sin ahorro la pantalla no tacha nada, y la prueba de arriba no tendría qué mirar.
  expect(PRECIO_COMBO).toBeLessThan(SUMA);
  // "Termina" se comprueba a las 12:00 desde las 10:00.
  expect(DURACION_COMBO).toBe(120);
});
