import { aviso, elegirFecha, elegirHora, elegirOpcion, expect, phoneNuevo, queryEa, queryOne, test } from "./fixtures";

/**
 * Confirmarle una reserva a la clienta por WhatsApp, a mano.
 *
 * **El caso real**: alguien reserva —por la página o desde la agenda— y la
 * dueña le escribe "tu cita quedó agendada" desde el WhatsApp del estudio.
 * Mientras Meta no apruebe las plantillas, es un toque por reserva; lo que no
 * puede pasar es que la clienta reciba dos confirmaciones, o ninguna, porque
 * la pantalla no sabía qué se había mandado.
 *
 * Lo que solo se ve de punta a punta: el botón del aviso "Cita creada" abre
 * WhatsApp con el mensaje, la fila queda en `wa_message` **con el mismo
 * `kind` que usa la Cloud API**, y "Reservas nuevas" en Recordatorios la
 * muestra confirmada y no la vuelve a ofrecer.
 */

/** Mañana, en calendario de Bogotá: la cita tiene que ser futura para entrar a la lista. */
function mananaEnBogota(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

test("crear una cita y confirmarla por WhatsApp desde el aviso", async ({ panel }) => {
  const marca = `Cita${Date.now().toString().slice(-6)}`;
  const telefono = phoneNuevo();

  await panel.goto("/admin/agenda");
  await panel.getByRole("button", { name: /nueva cita/i }).click();

  await panel.getByRole("textbox", { name: /^Cliente/ }).fill(`${marca} Test`);
  await panel.getByRole("button", { name: /crear «/i }).click();
  await panel.getByRole("textbox", { name: /^Nombre\b/ }).fill(marca);
  await panel.getByRole("textbox", { name: /^Apellido\b/ }).fill("Test");
  await panel.getByRole("textbox", { name: /^Teléfono/ }).fill(telefono);
  await panel.getByRole("button", { name: /crear y usar/i }).click();
  await expect(panel.getByRole("button", { name: /cambiar/i })).toBeVisible();

  await elegirOpcion(panel.getByRole("combobox", { name: /^Servicio/ }), { index: 0 });
  // Mañana a la 1:00, fuera de toda franja de la suite (que agenda hoy).
  await elegirFecha(panel.getByLabel(/^Fecha/), mananaEnBogota());
  await elegirHora(panel.getByLabel(/^Empieza/), "01:00");
  await panel.getByRole("checkbox", { name: /fuera del horario/i }).check();
  // Sin Cloud API la casilla automática no existe; con ella, se apaga para
  // que la confirmación vaya por este botón.
  const auto = panel.getByRole("checkbox", { name: /enviar confirmación por whatsapp/i });
  if ((await auto.count()) > 0) await auto.uncheck();
  await panel.getByRole("button", { name: /^crear cita$/i }).click();

  await expect(aviso(panel)).toContainText("Cita creada.", { timeout: 15_000 });

  const idCita = queryEa(
    `SELECT a.id FROM ea_appointments a JOIN ea_users c ON c.id = a.id_users_customer
      WHERE c.first_name = '${marca}' ORDER BY a.id DESC LIMIT 1`,
  );
  expect(idCita, "EA no recibió la cita").not.toBeNull();

  // El botón del aviso abre WhatsApp con el mensaje listo.
  const popup = panel.waitForEvent("popup");
  await panel.getByRole("button", { name: /confirmar por whatsapp/i }).first().click();
  const tab = await popup;
  await expect
    .poll(() => tab.url(), { message: "la pestaña no fue a WhatsApp", timeout: 15_000 })
    .toMatch(/^https:\/\/api\.whatsapp\.com\/send\?phone=57\d+&text=/);
  const texto = decodeURIComponent(new URL(tab.url()).searchParams.get("text") ?? "");
  expect(texto).toContain(`¡Hola, ${marca}!`);
  expect(texto).toContain("quedó agendada");
  expect(texto, "la confirmación nunca lleva precio").not.toMatch(/\$\s?\d/);
  await tab.close();

  // Registrada antes de abrir WhatsApp, con el `kind` que comparte con la Cloud API.
  await expect
    .poll(
      () =>
        queryOne(
          `SELECT CONCAT(kind, '|', channel, '|', status) FROM wa_message
            WHERE ea_appointment_id = ${idCita}`,
        ),
      { timeout: 10_000 },
    )
    .toBe("confirmacion|manual|enviado");

  // "Reservas nuevas" la muestra confirmada y ya no ofrece el botón.
  await panel.goto("/admin/recordatorios");
  // Es de mañana, así que también sale en los recordatorios de "Mañana": se
  // mira solo la sección de reservas nuevas.
  const tarjeta = panel
    .getByRole("region", { name: "Reservas nuevas" })
    .locator("article")
    .filter({ hasText: `${marca} Test` });
  await expect(tarjeta).toContainText(/Confirmada por/);
  await expect(tarjeta.getByRole("button", { name: /confirmar/i })).toHaveCount(0);

  queryOne(`DELETE FROM wa_message WHERE ea_appointment_id = ${idCita}`);
});
