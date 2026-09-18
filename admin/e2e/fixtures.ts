import { execFileSync } from "node:child_process";

import { test as base, expect, type Page } from "@playwright/test";

/**
 * Lo que la suite E2E necesita para existir: una sesión y datos que limpiar.
 *
 * ## Por qué esta suite existe
 *
 * Tres defectos llegaron a producción sin que nada los viera: cinco pantallas
 * sin barra de navegación, un destino del menú apuntando a una ruta que nunca
 * se creó, y el alta de clienta fallando contra la API de EA por un campo
 * obligatorio. Los 1.870 tests unitarios pasaban con los tres adentro, porque
 * **ninguno abre el panel**. Las funciones puras estaban bien; lo que estaba
 * roto era el pegamento, y el pegamento solo se ve cargando la página.
 *
 * La regla que sale de eso: **lo que se prueba acá es lo que un unitario no
 * puede ver.** Que la pantalla monte, que el enlace lleve a algún lado, que el
 * formulario guarde de verdad contra EA. No la aritmética del ticket ni el
 * prorrateo del descuento — eso ya está cubierto donde corresponde y repetirlo
 * acá lo haría diez veces más lento sin ganar nada.
 *
 * ## Contra qué corre
 *
 * Contra el entorno local de verdad: el panel en `npm run dev`, EA en su
 * contenedor, MySQL en el suyo. **No hay dobles.** Un doble de EA habría
 * pasado feliz el alta de clienta sin `last_name`, que es exactamente el bug
 * que se escapó.
 *
 * El precio es que la suite necesita el stack arriba y se salta sola si no lo
 * está — mejor eso que fallar en rojo por algo que no es del código.
 */

/** Correo de la cuenta que la suite usa. No es la de nadie. */
export const E2E_EMAIL = "e2e@goldenbeautystudio.com.co";

/**
 * Siembra la cuenta y devuelve un código TOTP válido ahora mismo.
 *
 * Reusa `dev:seed`, el mismo camino documentado para entrar a mano. No inventa
 * una sesión ni firma cookies: la suite entra por la puerta de verdad, que es
 * lo único que prueba que la puerta funciona.
 */
function seedAccount(): { userId: string; code: string } {
  const out = execFileSync(
    "node",
    ["--env-file=.env.local", ".next/dev-seed.js", `--email=${E2E_EMAIL}`, "--rol=owner", "--nombre=E2E"],
    { encoding: "utf8" },
  );

  const code = /Código:\s*(\d{6})/.exec(out)?.[1];
  if (!code) throw new Error(`dev:seed no imprimió un código:\n${out}`);

  const userId = queryOne(
    `SELECT id FROM user WHERE email='${E2E_EMAIL}'`,
  );
  if (!userId) throw new Error("dev:seed no dejó la fila de user");

  return { userId, code };
}

/** Una consulta de una sola celda contra el MySQL del stack de desarrollo. */
export function queryOne(sql: string): string | null {
  const out = execFileSync(
    "docker",
    ["exec", "gbs-dev-mysql", "mysql", "-uroot", "-psecret", "-N", "-B", "gbs_admin", "-e", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  return out === "" ? null : out.split("\n")[0];
}

/**
 * Entra al panel.
 *
 * Se hace por la API de sign-in y no llenando el formulario **en cada test**:
 * el login por pantalla tiene su propio test, y repetirlo veinte veces sería
 * pagar veinte veces por probar lo mismo una. Cuando el login se rompa, lo va
 * a decir su test, no los otros diecinueve a la vez.
 */
export async function signIn(page: Page): Promise<void> {
  const { userId, code } = seedAccount();

  const response = await page.request.post("/admin/api/auth/sign-in/totp", {
    data: { userId, code },
  });

  if (!response.ok()) {
    throw new Error(`el login de la suite falló: ${response.status()} ${await response.text()}`);
  }
}

export const test = base.extend<{ panel: Page }>({
  /** Una página ya autenticada. Es lo que usa casi todo. */
  panel: async ({ page }, use) => {
    await signIn(page);
    await use(page);
  },
});

export { expect };

/**
 * Cuántas citas hay, contadas en la **base de EA**.
 *
 * Dos razones, y las dos costaron una hora cada una:
 *
 * 1. Un test de "agendar" que solo mira la pantalla **pasa sin crear nada**: el
 *    nombre de la clienta sigue escrito en el formulario abierto y cualquier
 *    `getByText` lo encuentra ahí. Daba verde con cero citas.
 * 2. `GET /appointments` **no devuelve lo que ya pasó**. Una cita creada para
 *    hoy a las 8:00, consultada a las 6 de la tarde, no sale — y el test daba
 *    rojo culpando al código equivocado, con la cita existiendo.
 *
 * La tabla no miente en ninguno de los dos sentidos.
 */
export function contarCitasEnEa(): number {
  const n = execFileSync(
    "docker",
    ["exec", "gbs-dev-mysql", "mysql", "-uroot", "-psecret", "-N", "-B", "easyappointments",
     "-e", "SELECT COUNT(*) FROM ea_appointments WHERE is_unavailability=0"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  return Number(n);
}

/**
 * El aviso que deja una acción en la pantalla.
 *
 * El shell monta un `<div role="status">` vacío para los toasts, así que
 * `getByRole("status")` a secas resuelve a dos elementos y Playwright falla por
 * modo estricto — con la acción **ya ejecutada correctamente**, que es la peor
 * clase de test rojo: el que miente sobre qué se rompió.
 */
export function aviso(page: Page) {
  return page.locator('[role="status"]').filter({ hasNotText: /^\s*$/ }).first();
}

/**
 * Borra lo que la suite creó: sus citas y sus clientas.
 *
 * Sin esto cada corrida deja sedimento, y el sedimento cambia el resultado de
 * la siguiente — la agenda se llena, el hueco de las 8:00 deja de estar libre,
 * y un test empieza a fallar por el estado que dejó su corrida anterior en vez
 * de por el código. Un test que depende del orden en que se corrió no dice
 * nada.
 *
 * Se borra por **marca en el nombre**, no por fecha: así nunca toca una
 * clienta de verdad, ni siquiera corriendo contra una base con datos reales.
 */
export function limpiarDatosDePrueba(): void {
  const sql = [
    // Primero las citas: `ea_appointments` referencia a la clienta.
    `DELETE a FROM ea_appointments a JOIN ea_users c ON c.id = a.id_users_customer
       WHERE c.first_name REGEXP '^(Cita|Nueva|Dx|Prueba|Repetida|Bitacora|Ana|Solonombre|T[0-9])'
         AND c.last_name REGEXP '^(Test|Perez|Prueba|Dos|Bitacora|Ríos|Nostico|Uno|-)'`,
    `DELETE FROM ea_users
       WHERE id_roles = (SELECT id FROM ea_roles WHERE slug = 'customer')
         AND first_name REGEXP '^(Cita|Nueva|Dx|Prueba|Repetida|Bitacora|Solonombre|T[0-9])'`,
  ];

  for (const q of sql) {
    execFileSync(
      "docker",
      ["exec", "gbs-dev-mysql", "mysql", "-uroot", "-psecret", "easyappointments", "-e", q],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  }
}

/**
 * Un teléfono que no choca con ninguno que ya exista.
 *
 * La identidad de la clienta es el teléfono, y el panel rechaza un duplicado
 * —correctamente—, así que dos corridas con el mismo número harían fallar la
 * segunda por un motivo que no es el que el test mira.
 */
export function phoneNuevo(): string {
  const n = String(Math.floor(Math.random() * 90_000_000) + 10_000_000);
  return `30${n}`;
}
