import { main } from "./reconcile";

/**
 * Punto de entrada del reconcile nocturno.
 *
 * ## Por qué existe este archivo
 *
 * Mismo motivo que `db/migrate-cli.ts`: el loader nativo de TypeScript de Node
 * no resuelve imports de directorio ni sabe qué hacer con `server-only`, así
 * que el job se empaqueta con esbuild a un único `.js` dentro del árbol
 * standalone (`npm run build:reconcile`) y el contenedor ejecuta ese archivo.
 *
 * ## Por qué el reconcile es el mecanismo principal y no el respaldo
 *
 * **Los webhooks de EA no reintentan.** `Webhooks_client::call()` hace el POST
 * dentro de un `try` cuyo `catch` solo escribe en el log de EA: si el panel
 * está caído, en redespliegue, o simplemente tarda de más, el evento se pierde
 * **para siempre** y no queda rastro de este lado. Cada despliegue del panel es
 * una ventana de eventos perdidos.
 *
 * Por eso este job no es una red de seguridad para un caso raro: es lo que
 * garantiza que toda cita termine con su precio congelado. El webhook solo lo
 * adelanta unos minutos.
 *
 * ## Salida
 *
 * Código 0 si el barrido terminó, aunque no haya creado nada — "no había nada
 * que reconciliar" es éxito. Código 1 solo si el barrido no pudo completarse,
 * para que el cron lo reporte en vez de fallar en silencio.
 */
async function run(): Promise<void> {
  try {
    const r = await main();
    console.log(
      `reconcile ${r.from}→${r.till}: ${r.scanned} citas revisadas · ` +
        `${r.created} creadas · ${r.repaired} reparadas · ${r.repriced} recongeladas · ` +
        `${r.mirrored} espejadas · ${r.untouched} intactas · ${r.frozen} ya cerradas.`,
    );

    // `fallback` no es un contador más: es la alarma. Son citas que quedaron
    // sin el precio que EA tenía al agendarlas, y cada una es una comisión que
    // se va a calcular mal si nadie la mira. Va a stderr para que se vea aunque
    // los logs estén filtrados por nivel.
    if (r.fallback > 0) {
      console.error(
        `reconcile: ⚠ ${r.fallback} cuenta(s) quedaron marcadas como fallback ` +
          `(sin el precio congelado de EA). Revisar en Diagnóstico.`,
      );
    }
  } catch (error) {
    // El mensaje va a stderr entero: este job corre sin nadie mirando, y su
    // único canal de diagnóstico son los logs del contenedor en Portainer.
    console.error("reconcile: el barrido no pudo completarse.", error);
    process.exitCode = 1;
  }
}

void run();
