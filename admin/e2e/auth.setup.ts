import { expect, signIn, test as setup } from "./fixtures";

/**
 * Entra **una vez** y guarda la sesión para toda la suite.
 *
 * ## Por qué, y no un login por test
 *
 * Así empezó, y se rompió en cuanto la suite corrió contra un build de
 * producción: `/sign-in/totp` tiene un tope de **10 intentos por minuto** por
 * IP —puesto a propósito, para que nadie recorra la grilla de códigos de seis
 * dígitos— y treinta y cinco tests haciendo login lo revientan. El síntoma es
 * un `429` en la mitad de la suite, que no habla de ninguno de los tests que
 * falla.
 *
 * En desarrollo no pasaba: Better Auth no aplica el límite ahí. Es exactamente
 * la clase de diferencia que hace que "pasa en mi máquina" sea verdad y no
 * sirva de nada.
 *
 * Entrar una vez es además lo correcto por otro lado: **cuando el login se
 * rompa, lo va a decir este archivo**, no los treinta y cinco a la vez.
 *
 * El estado se guarda en `.auth/` y no se commitea: es una cookie de sesión.
 */

const ARCHIVO = "e2e/.auth/panel.json";

setup("entrar al panel y guardar la sesión", async ({ page }) => {
  await signIn(page);

  // Que el POST devuelva 200 no alcanza: lo que importa es que la cookie sirva
  // para pedir una pantalla. Sin esta comprobación, una cookie mal firmada
  // guardaría un estado inútil y los demás tests fallarían por "no encuentro
  // el botón" en una pantalla que en realidad es el login.
  await page.goto("/admin/hoy");
  await expect(page).toHaveURL(/\/admin\/hoy/);

  await page.context().storageState({ path: ARCHIVO });
});
