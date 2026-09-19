import { defineConfig, devices } from "@playwright/test";

/**
 * La suite E2E del panel.
 *
 * ## Contra el entorno real, sin dobles
 *
 * `baseURL` apunta al `npm run dev` del host, que habla con el EA y el MySQL
 * del stack de desarrollo. Un doble de EA habría dejado pasar el bug que
 * motivó esta suite —el alta de clienta sin `last_name`, que EA rechaza con un
 * 500— porque un doble acepta lo que el que lo escribió supone.
 *
 * ## `webServer` no lo levanta esta config, a propósito
 *
 * Playwright puede arrancar el servidor, y acá sería un tiro en el pie: el
 * panel necesita **además** MySQL y EA en Docker, que Playwright no sabe
 * levantar. Un `webServer` daría la ilusión de que basta con `npx playwright
 * test` y fallaría con un error de red que no dice qué falta. La suite
 * comprueba el entorno de frente en `global-setup.ts` y explica qué levantar.
 *
 * ## Un solo worker
 *
 * Los tests escriben en la misma base y en el mismo EA. Con paralelismo, una
 * clienta creada por un test aparece en la búsqueda de otro y los conteos
 * dejan de ser estables. El estudio tiene tres personas y la suite tarda menos
 * de un minuto: no hay nada que ganar corriéndola en paralelo.
 */
/** La sesión que deja el proyecto `setup`. Es una cookie: no se commitea. */
const ESTADO = "e2e/.auth/panel.json";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",

  // Escriben contra la misma base. Ver arriba.
  workers: 1,
  fullyParallel: false,

  // En CI un reintento tapa un test inestable; acá también. Cero: si falla, es
  // que falla.
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3001",
    // La traza solo del primer reintento no sirve con `retries: 0`: se guarda
    // siempre que falle, que es cuando hace falta mirarla.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    locale: "es-CO",
    timezoneId: "America/Bogota",
  },

  projects: [
    {
      /**
       * Entra una vez y deja la sesión guardada para los demás.
       *
       * No es una optimización: `/sign-in/totp` tiene un tope de 10 intentos
       * por minuto —para que nadie recorra la grilla de códigos— y un login
       * por test lo revienta con un `429` a mitad de suite. En desarrollo no
       * se nota porque Better Auth no aplica el límite ahí, que es justo la
       * diferencia que hace inútil el "en mi máquina pasa".
       */
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "escritorio",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        storageState: ESTADO,
      },
    },
    {
      // El panel se usa de pie, con el celular en la mano, y la barra lateral
      // desaparece por debajo de 768 px: la navegación móvil es otro árbol de
      // componentes y merece su propia corrida.
      name: "movil",
      dependencies: ["setup"],
      use: { ...devices["Pixel 7"], storageState: ESTADO },
      testMatch: /(navegacion|hoy)\.spec\.ts/,
    },
  ],
});
