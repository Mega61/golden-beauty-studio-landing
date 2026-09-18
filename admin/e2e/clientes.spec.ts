import { aviso, expect, phoneNuevo, queryOne, test } from "./fixtures";

/**
 * Crear, buscar y corregir una clienta — contra la API de EA de verdad.
 *
 * **El bug que motivó este archivo**: el alta fallaba con "La agenda no
 * respondió. Se puede reintentar en un momento." sobre algo que no se
 * arreglaba reintentando nunca. La API de EA exige `last_name` y responde
 * **500** sin él; un 500 se clasifica como error transitorio, así que el panel
 * daba el mensaje equivocado y escondía la causa.
 *
 * Un doble de EA no lo habría atrapado: habría aceptado el payload que quien
 * escribió el doble suponía correcto. Por eso esta suite no tiene dobles.
 */

test.describe("alta de clienta", () => {
  test("crea con nombre y apellido, y aparece en la búsqueda", async ({ panel }) => {
    const phone = phoneNuevo();
    const apellido = `Prueba${Date.now().toString().slice(-6)}`;

    await panel.goto("/admin/clientes");
    await panel.getByRole("button", { name: /nueva clienta/i }).click();

    await panel.getByLabel(/^Nombre\b/).fill("Ana");
    await panel.getByLabel(/^Apellido/).fill(apellido);
    await panel.getByLabel(/^Teléfono/).fill(phone);
    await panel.getByRole("button", { name: /^crear$/i }).click();

    await expect(aviso(panel)).toContainText(/quedó creada/i);

    // Y existe de verdad del otro lado, no solo en el mensaje. `:visible`
    // porque `DataTable` pinta la tabla y la lista a la vez y esconde una por
    // CSS: sin el filtro se agarra la copia invisible.
    await panel.goto(`/admin/clientes?q=${apellido}`);
    await expect(panel.locator(`:text("${apellido}"):visible`).first()).toBeVisible();
  });

  test("sin apellido lo dice, en vez de culpar a la agenda", async ({ panel }) => {
    // Es el bug exacto: EA responde 500 y el panel decía "no respondió".
    // Reintentar no servía de nada, y el mensaje no decía qué faltaba.
    await panel.goto("/admin/clientes");
    await panel.getByRole("button", { name: /nueva clienta/i }).click();

    await panel.getByLabel(/^Nombre\b/).fill("Solonombre");
    await panel.getByLabel(/^Teléfono/).fill(phoneNuevo());
    await panel.getByRole("button", { name: /^crear$/i }).click();

    const mensaje = aviso(panel);
    await expect(mensaje).toContainText(/apellido/i);
    await expect(mensaje).not.toContainText(/no respondió/i);
  });

  test("un teléfono que no es un teléfono se rechaza en el panel", async ({ panel }) => {
    // La identidad de la clienta es el número. Un número a medias deduplica
    // mal, que es peor que no deduplicar.
    await panel.goto("/admin/clientes");
    await panel.getByRole("button", { name: /nueva clienta/i }).click();

    await panel.getByLabel(/^Nombre\b/).fill("Ana");
    await panel.getByLabel(/^Apellido/).fill("Ríos");
    await panel.getByLabel(/^Teléfono/).fill("N/A");
    await panel.getByRole("button", { name: /^crear$/i }).click();

    await expect(aviso(panel)).toContainText(/teléfono/i);
  });

  test("el mismo número dos veces no crea dos clientas", async ({ panel }) => {
    // EA deduplica por correo, no por número. Sin el chequeo del panel, la que
    // llama aparece dos veces en la agenda.
    const phone = phoneNuevo();

    for (const intento of [1, 2]) {
      await panel.goto("/admin/clientes");
      await panel.getByRole("button", { name: /nueva clienta/i }).click();
      await panel.getByLabel(/^Nombre\b/).fill("Repetida");
      await panel.getByLabel(/^Apellido/).fill(`Dos${intento}`);
      await panel.getByLabel(/^Teléfono/).fill(phone);
      await panel.getByRole("button", { name: /^crear$/i }).click();

      const mensaje = aviso(panel);
      if (intento === 1) await expect(mensaje).toContainText(/quedó creada/i);
      else await expect(mensaje).toContainText(/ya es de/i);
    }
  });

  test("queda anotado en la bitácora", async ({ panel }) => {
    // La plata y las personas se tocan con rastro. Si el alta no deja fila,
    // nadie puede reconstruir quién creó qué.
    const apellido = `Bitacora${Date.now().toString().slice(-6)}`;

    await panel.goto("/admin/clientes");
    await panel.getByRole("button", { name: /nueva clienta/i }).click();
    await panel.getByLabel(/^Nombre\b/).fill("Ana");
    await panel.getByLabel(/^Apellido/).fill(apellido);
    await panel.getByLabel(/^Teléfono/).fill(phoneNuevo());
    await panel.getByRole("button", { name: /^crear$/i }).click();
    await expect(aviso(panel)).toContainText(/quedó creada/i);

    const n = queryOne(
      "SELECT COUNT(*) FROM audit_log WHERE action='clienta.crear' AND created_at > NOW() - INTERVAL 2 MINUTE",
    );
    expect(Number(n)).toBeGreaterThan(0);
  });
});

test.describe("la ficha", () => {
  test("se abre desde el listado y conserva la navegación", async ({ panel }) => {
    // La ficha fue una de las cinco pantallas que se quedaron sin shell.
    await panel.goto("/admin/clientes");

    // `DataTable` pinta la tabla y la lista a la vez y esconde una por CSS,
    // así que `.first()` a secas agarra la invisible.
    const primera = panel.locator("a[href*='/clientes/']:visible").first();
    await expect(primera).toBeVisible();
    await primera.click();

    await expect(panel.locator("aside").first()).toBeVisible();
    await expect(panel.getByRole("link", { name: /agenda/i }).first()).toBeVisible();
  });
});
