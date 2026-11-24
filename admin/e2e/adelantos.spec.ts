import { elegirHora, elegirOpcion, expect, phoneNuevo, queryEa, queryOne, test } from "./fixtures";

/**
 * Un **adelanto** de punta a punta: se registra en la cita desde la agenda, se
 * ve en Hoy, y al cobrar la cuenta se descuenta solo — el pago `abono` por lo
 * que se pagó antes y el método de la hoja por el resto.
 *
 * Como en `caja.spec.ts`, la afirmación que importa está en SQL: lo que leen el
 * push a Actual y el bot de finanzas son las filas, no el cartel.
 *
 * Franja: 12:00, libre entre la de la agenda (08:00) y el par de combos (16:00).
 */
const HORA = "12:00";

test.describe("adelanto de una cita", () => {
  test("se registra en la agenda y la cuenta cobra solo el resto", async ({ panel }) => {
    const marca = `CjaAd${Date.now().toString().slice(-5)}`;

    // ── 1. Una cita de hoy ─────────────────────────────────────────────────
    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();
    await panel.getByRole("textbox", { name: /^Cliente/ }).fill(`${marca} Test`);
    await panel.getByRole("button", { name: /crear «/i }).click();
    await panel.getByRole("textbox", { name: /^Nombre\b/ }).fill(marca);
    await panel.getByRole("textbox", { name: /^Apellido\b/ }).fill("Test");
    await panel.getByRole("textbox", { name: /^Teléfono/ }).fill(phoneNuevo());
    await panel.getByRole("button", { name: /crear y usar/i }).click();
    await expect(panel.getByRole("button", { name: /cambiar/i })).toBeVisible();

    await elegirOpcion(panel.getByRole("combobox", { name: /^Servicio/ }), { index: 0 });
    await elegirHora(panel.getByLabel(/^Empieza/), HORA);
    const fuera = panel.getByRole("checkbox", { name: /fuera del horario/i });
    if (await fuera.isVisible()) await fuera.check();
    await panel.getByRole("button", { name: /^crear cita$/i }).click();
    await expect(panel.getByText("Cita creada.")).toBeVisible({ timeout: 15_000 });

    const citaId = queryEa(
      `SELECT a.id FROM ea_appointments a
         JOIN ea_users c ON c.id = a.id_users_customer
        WHERE c.first_name = '${marca}' ORDER BY a.id DESC LIMIT 1`,
    );
    expect(citaId, "la cita no quedó en EA").not.toBeNull();

    // ── 2. El adelanto, desde el detalle de la cita ────────────────────────
    await panel.goto(`/admin/agenda?cita=${citaId}`);
    await panel.getByRole("button", { name: /^registrar adelanto$/i }).click();
    await panel.getByLabel(/^Monto del adelanto/).fill("10000");
    await panel.getByRole("button", { name: /^registrar · /i }).click();
    await expect(panel.getByText(/adelanto de .*registrado/i)).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText(/por usar/i).first()).toBeVisible();

    expect(
      queryOne(`SELECT CONCAT(amount, ' ', method) FROM appointment_deposit WHERE ea_appointment_id = ${citaId}`),
    ).toBe("10000 transferencia");

    // ── 3. Hoy lo dice, y la hoja lo descuenta ─────────────────────────────
    await panel.goto("/admin/hoy");
    const fila = panel.locator("article, li, tr").filter({ hasText: marca }).first();
    await expect(fila).toContainText(/adelanto/i, { timeout: 15_000 });
    await fila.getByRole("button", { name: /cerrar servicio/i }).click();
    await expect(panel.getByText(/adelanto ya pagado/i)).toBeVisible();
    await panel.getByRole("button", { name: /^efectivo$/i }).click();
    await panel.getByRole("button", { name: /^Guardar/ }).click();

    await expect
      .poll(
        () => queryOne(`SELECT amount_charged FROM appointment_finance WHERE ea_appointment_id = ${citaId}`),
        { timeout: 15_000, message: "la cuenta no llegó a appointment_finance" },
      )
      .not.toBeNull();
    const cobrado = Number(
      queryOne(`SELECT amount_charged FROM appointment_finance WHERE ea_appointment_id = ${citaId}`),
    );

    // ── 4. Los pagos: el adelanto y el resto ───────────────────────────────
    const pagos = queryOne(
      `SELECT GROUP_CONCAT(CONCAT(ap.method, ':', ap.amount) ORDER BY ap.id SEPARATOR ',')
         FROM appointment_payment ap
         JOIN appointment_finance af ON af.id = ap.appointment_finance_id
        WHERE af.ea_appointment_id = ${citaId}`,
    );
    expect(pagos).toBe(
      cobrado > 10_000 ? `abono:10000,efectivo:${cobrado - 10_000}` : `abono:${cobrado}`,
    );

    // ── 5. Caja → Adelantos lo muestra usado ───────────────────────────────
    await panel.goto("/admin/caja/adelantos");
    await expect(panel.locator("li").filter({ hasText: marca }).first()).toContainText(/usado en la cuenta/i);
  });
});
