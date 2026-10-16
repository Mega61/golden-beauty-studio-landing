import { main, summarize } from "./reminders-run";

/**
 * Punto de entrada del emisor de recordatorios por WhatsApp.
 *
 * Empaquetado con esbuild a `scripts/recordatorios.js` (`npm run
 * build:recordatorios`) por la misma razón que el reconcile: el loader de
 * TypeScript de Node no resuelve los imports de directorio ni `server-only`.
 * Lo corre el servicio `admin-recordatorios` del stack cada 30 minutos.
 *
 * ## Salida
 *
 * - Sin configuración de Meta: una línea y código 0. No es un error: es el
 *   estado normal hasta que la dueña termine el trámite.
 * - Corrida completa (aunque algún mensaje haya fallado): código 0. Los
 *   fallos por mensaje quedan en `wa_message` y en el resumen.
 * - La corrida no pudo completarse (EA o la base no respondieron): código 1.
 */
async function run(): Promise<void> {
  try {
    const result = await main();
    if (result.status === "apagado") {
      console.log(
        "recordatorios: WhatsApp no está configurado (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID). No se manda nada.",
      );
      return;
    }
    console.log(`recordatorios ${summarize(result.report)}`);
    if (result.report.failed > 0) {
      console.error(
        `recordatorios: ⚠ ${result.report.failed} mensaje(s) no salieron. Ver /admin/recordatorios y Diagnóstico.`,
      );
    }
  } catch (error) {
    console.error("recordatorios: la corrida no pudo completarse.", error);
    process.exitCode = 1;
  }
}

void run();
