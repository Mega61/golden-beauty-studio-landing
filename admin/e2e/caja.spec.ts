import { expect, phoneNuevo, queryEa, queryOne, test } from "./fixtures";

/**
 * Cerrar la cuenta de una cita: el único camino por el que entra plata.
 *
 * ## Por qué esto no puede ser un unitario
 *
 * `lib/ticket.ts` ya prueba la aritmética hasta el último peso, y prueba la
 * invariante que la gobierna — `Σ line_total − discount === amount_charged` —
 * mejor de lo que la probaría un navegador. Lo que ningún unitario ve es que
 * **la cuenta llegue a la base**: la hoja vive en el cliente, el borrador pasa
 * por `localStorage`, la valoración se rehace en el servidor con su propio
 * catálogo, y recién ahí se escriben dos tablas. Cada una de esas costuras está
 * probada por separado y ninguna prueba que la cadena cierre.
 *
 * Y es la cadena que decide cuánto cobra el estudio y cuánto se le paga a una
 * técnica. Si se rompe en silencio, la señal es una quincena mal liquidada.
 *
 * ## La afirmación final está en SQL, no en pantalla
 *
 * La hoja dice "cuenta cerrada" apenas el servidor responde. Lo que importa es
 * la fila de `appointment_finance` con su monto: es lo que leen las comisiones,
 * el cierre diario y el push a Actual Budget. Mirar solo el cartel sería creerle
 * a la pantalla sobre la plata.
 */

/** Una hora de hoy fuera de la jornada: no choca con lo que dejen otros specs. */
const HORA = "07:00";

test.describe("cerrar una cuenta", () => {
  test("de la cita a la fila de plata, con su método de pago", async ({ panel }) => {
    const marca = `Cja${Date.now().toString().slice(-6)}`;

    // ── 1. Una cita de hoy, creada por el camino normal ────────────────────
    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    await panel.getByRole("textbox", { name: /^Clienta/ }).fill(`${marca} Test`);
    await panel.getByRole("button", { name: /crear «/i }).click();
    await panel.getByRole("textbox", { name: /^Nombre\b/ }).fill(marca);
    await panel.getByRole("textbox", { name: /^Apellido\b/ }).fill("Test");
    await panel.getByRole("textbox", { name: /^Teléfono/ }).fill(phoneNuevo());
    await panel.getByRole("button", { name: /crear y usar/i }).click();
    await expect(panel.getByRole("button", { name: /cambiar/i })).toBeVisible();

    await panel.getByRole("combobox", { name: /^Servicio/ }).selectOption({ index: 1 });
    await panel.getByLabel(/^Empieza/).fill(HORA);
    await panel.getByRole("checkbox", { name: /fuera del horario/i }).check();
    await panel.getByRole("button", { name: /^crear cita$/i }).click();
    await expect(panel.getByText("Cita creada.")).toBeVisible({ timeout: 15_000 });

    const citaId = queryEa(
      `SELECT a.id FROM ea_appointments a
         JOIN ea_users c ON c.id = a.id_users_customer
        WHERE c.first_name = '${marca}' ORDER BY a.id DESC LIMIT 1`,
    );
    expect(citaId, "la cita no quedó en EA").not.toBeNull();

    // Todavía no hay cuenta: se crea al cerrarla, no al agendar.
    expect(
      queryOne(`SELECT id FROM appointment_finance WHERE ea_appointment_id = ${citaId}`),
      "existía una cuenta antes de cerrarla",
    ).toBeNull();

    // ── 2. La cuenta, desde Hoy ────────────────────────────────────────────
    await panel.goto("/admin/hoy");

    const fila = panel.locator("article, li, tr").filter({ hasText: marca }).first();
    await expect(fila, "la cita de hoy no aparece en Hoy").toBeVisible({ timeout: 15_000 });
    await fila.getByRole("button", { name: /cerrar servicio/i }).click();

    // El servicio realizado: el que la cita traía ya viene elegido, porque lo
    // normal es que se haya hecho lo que se agendó. Se confirma que esté, en
    // vez de volver a elegirlo — si llegara vacío, la cuenta no se podría
    // guardar y el motivo sería otro.
    await expect(
      panel.getByRole("button", { name: /elige el servicio/i }),
      "la hoja abrió sin el servicio agendado",
    ).toHaveCount(0);

    // El método de pago es obligatorio: una cuenta cerrada sin él no dice con
    // qué entró la plata, y el cierre diario cuadra por método.
    await panel.getByRole("button", { name: /^efectivo$/i }).click();

    const guardar = panel.getByRole("button", { name: /^Guardar/ });
    await expect(guardar).toBeEnabled();
    await guardar.click();

    // ── 3. La plata, en la base ────────────────────────────────────────────
    await expect
      .poll(
        () => queryOne(`SELECT amount_charged FROM appointment_finance
                          WHERE ea_appointment_id = ${citaId}`),
        { timeout: 15_000, message: "la cuenta no llegó a appointment_finance" },
      )
      .not.toBeNull();

    const cobrado = Number(
      queryOne(`SELECT amount_charged FROM appointment_finance WHERE ea_appointment_id = ${citaId}`),
    );
    expect(cobrado, "la cuenta quedó en cero").toBeGreaterThan(0);

    // Y con sus renglones: la cuenta es un encabezado más renglones, y un
    // encabezado sin ninguno es una cuenta que no dice qué se hizo.
    const renglones = Number(
      queryOne(`SELECT COUNT(*) FROM appointment_finance_item afi
                  JOIN appointment_finance af ON af.id = afi.appointment_finance_id
                 WHERE af.ea_appointment_id = ${citaId}`),
    );
    expect(renglones, "la cuenta quedó sin renglones").toBeGreaterThan(0);

    // La invariante, comprobada donde el dato quedó: lo cobrado es la suma de
    // los renglones menos el descuento. `lib/ticket.ts` la verifica sobre su
    // propio resultado; esto verifica que lo que se guardó sea ese resultado.
    const suma = Number(
      queryOne(`SELECT COALESCE(SUM(afi.line_total), 0) FROM appointment_finance_item afi
                  JOIN appointment_finance af ON af.id = afi.appointment_finance_id
                 WHERE af.ea_appointment_id = ${citaId}`),
    );
    const descuento = Number(
      queryOne(`SELECT discount FROM appointment_finance WHERE ea_appointment_id = ${citaId}`),
    );
    expect(suma - descuento, "Σ renglones − descuento ≠ cobrado").toBe(cobrado);

    // El método quedó registrado, y por su monto.
    expect(
      queryOne(`SELECT ap.method FROM appointment_payment ap
                  JOIN appointment_finance af ON af.id = ap.appointment_finance_id
                 WHERE af.ea_appointment_id = ${citaId}`),
    ).toBe("efectivo");

    // ── 4. Y la pantalla lo dice ───────────────────────────────────────────
    await panel.goto("/admin/hoy");
    await expect(
      panel.locator("article, li, tr").filter({ hasText: marca }).first(),
      "la cuenta se cerró pero la lista sigue diciendo que está pendiente",
    ).toContainText(/cuenta cerrada/i, { timeout: 15_000 });
  });
});
