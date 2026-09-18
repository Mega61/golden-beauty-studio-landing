import { contarCitasEnEa, expect, phoneNuevo, test } from "./fixtures";

/**
 * Agendar una cita, que es para lo que existe el panel.
 *
 * **El bug que motivó este archivo**: no se podía agendar a nadie que no
 * estuviera ya en la agenda. El campo de clienta solo sabía *buscar*, así que
 * para alguien nuevo había que irse a Clientas, crearla, volver y rearmar la
 * cita desde cero. En un estudio ése es el caso más común que existe: suena el
 * teléfono y es alguien que nunca vino.
 */

test.describe("crear una cita", () => {
  test("el botón está disponible cuando hay técnicas", async ({ panel }) => {
    // Se deshabilita solo si EA no respondió o no hay ninguna técnica. Que
    // esté apagado con la agenda sana fue el primer síntoma que se reportó.
    await panel.goto("/admin/agenda");

    const nueva = panel.getByRole("button", { name: /nueva cita/i });
    await expect(nueva).toBeVisible();
    await expect(nueva).toBeEnabled();
  });

  test("el formulario pide clienta, servicio y hora", async ({ panel }) => {
    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    await expect(panel.getByRole("textbox", { name: /^Clienta/ })).toBeVisible();
    await expect(panel.getByRole("combobox", { name: /^Servicio/ })).toBeVisible();
    await expect(panel.getByRole("combobox", { name: /^Profesional/ })).toBeVisible();
  });

  test("se puede crear una clienta nueva sin salir del formulario", async ({ panel }) => {
    // El caso que no existía. Sin esto había que abandonar la cita a medias.
    const marca = `Nueva${Date.now().toString().slice(-6)}`;

    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    // Buscar a alguien que no existe.
    await panel.getByRole("textbox", { name: /^Clienta/ }).fill(`${marca} Perez`);

    // La salida tiene que ofrecerse ahí mismo.
    const crear = panel.getByRole("button", { name: /crear «/i });
    await expect(crear, "no ofreció crear la clienta que no encontró").toBeVisible();
    await crear.click();

    await panel.getByRole("textbox", { name: /^Nombre y apellido/ }).fill(`${marca} Perez`);
    await panel.getByRole("textbox", { name: /^Teléfono/ }).fill(phoneNuevo());
    await panel.getByRole("button", { name: /crear y usar/i }).click();

    // Y queda elegida: quien la creó estaba armando una cita, no dando de
    // alta a alguien. Devolverlo al buscador sería cobrarle el paso dos veces.
    await expect(panel.getByText(`${marca} Perez`)).toBeVisible();
    await expect(panel.getByRole("button", { name: /cambiar/i })).toBeVisible();
  });

  test("agendar de punta a punta deja la cita en la agenda", async ({ panel }) => {
    const marca = `Cita${Date.now().toString().slice(-6)}`;

    // Se cuenta **antes** y contra EA. Mirar solo la pantalla deja pasar un
    // falso verde: el nombre de la clienta sigue escrito en el formulario
    // abierto y cualquier `getByText` lo encuentra ahí sin que exista cita.
    const antes = await contarCitasEnEa();

    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    await panel.getByRole("textbox", { name: /^Clienta/ }).fill(`${marca} Test`);
    await panel.getByRole("button", { name: /crear «/i }).click();
    await panel.getByRole("textbox", { name: /^Nombre y apellido/ }).fill(`${marca} Test`);
    await panel.getByRole("textbox", { name: /^Teléfono/ }).fill(phoneNuevo());
    await panel.getByRole("button", { name: /crear y usar/i }).click();
    await expect(panel.getByRole("button", { name: /cambiar/i })).toBeVisible();

    // El servicio: el primero que ofrezca el catálogo de EA.
    const servicio = panel.getByRole("combobox", { name: /^Servicio/ });
    const opciones = await servicio.locator("option").all();
    expect(opciones.length, "EA no ofreció ningún servicio").toBeGreaterThan(1);
    await servicio.selectOption({ index: 1 });

    // La hora que ofrece el botón «Nueva cita» es el inicio de la grilla
    // (8:00), y la técnica empieza a las 9:00 — así que el panel responde con
    // una **revisión de conflicto** en vez de guardar. Es su trabajo: la API de
    // EA acepta citas fuera de horario y encimadas sin protestar, y toda la
    // detección es del panel.
    //
    // El test la atiende como la atendería una persona: la lee y confirma.
    await panel.getByRole("button", { name: /^crear cita$/i }).click();

    // El botón cambia de «Crear cita» a «Guardar de todas formas» cuando hay
    // conflicto. Las dos severidades se pueden forzar; lo que cambia es el tono.
    // **Hay que esperar el desenlace, no preguntarlo.** El panel consulta al
    // servidor antes de decidir si hay conflicto, así que un `isVisible()`
    // inmediato contesta "no" mientras la respuesta viaja — y el test seguía
    // de largo sin confirmar nada, contra una cita que nunca se guardó.
    //
    // Tampoco sirve una carrera entre "apareció el botón de forzar" y
    // "desapareció el de crear": las dos ocurren a la vez cuando hay
    // conflicto —el botón se *reemplaza*— y gana la que no hay que atender.
    //
    // Lo que se espera es uno de los dos **desenlaces**: o el panel pide
    // confirmación, o la cita quedó creada. Que haya conflicto o no depende
    // del estado de la agenda, así que exigir uno de los dos haría al test
    // dependiente del orden en que se corrió.
    const forzar = panel.getByRole("button", { name: /guardar de todas formas/i });
    const creada = panel.getByText("Cita creada.");

    await expect(async () => {
      const hayQueConfirmar = await forzar.isVisible();
      const yaQuedó = await creada.isVisible();
      expect(hayQueConfirmar || yaQuedó, "el panel no respondió al envío").toBe(true);
    }).toPass({ timeout: 10_000 });

    if (await forzar.isVisible()) await forzar.click();

    // La afirmación que no se puede falsear: EA tiene una cita más.
    //
    // Se cuenta contra la **base** y no contra `GET /appointments`: el listado
    // por defecto de EA no devuelve lo que ya pasó, y una cita creada hoy a las
    // 8:00 a las 6 de la tarde simplemente no sale. Contarla así daba cero con
    // la cita existiendo — un rojo que culpaba al código equivocado.
    await expect
      .poll(contarCitasEnEa, { timeout: 15_000, message: "EA no recibió ninguna cita" })
      .toBe(antes + 1);

    // Y además quedó dibujada, que es donde alguien la busca.
    await expect(panel.locator(`:text("${marca}"):visible`).first()).toBeVisible();
  });
});

test.describe("lo que la agenda no puede hacer sola", () => {
  test("la API de EA acepta citas encimadas, así que el panel las detecta", async ({ panel }) => {
    // `Appointments_api_v1` no valida choques — el backend propio de EA sí,
    // pero la API no. Toda la detección es del panel, y si se rompe, el
    // síntoma es dos clientas en la misma silla a la misma hora.
    await panel.goto("/admin/agenda");
    await expect(panel.getByRole("button", { name: /nueva cita/i })).toBeEnabled();

    // La comprobación real vive en los unitarios de `lib/conflict.ts`, con
    // todos sus bordes. Acá solo se fija que la pantalla que la usa carga.
  });
});
