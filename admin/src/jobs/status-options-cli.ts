import { createEaClient } from "@/lib/ea/client";

import {
  STATUS_OPTIONS,
  STATUS_OPTIONS_SETTING,
  parseStatusOptions,
  planStatusOptions,
  serializeStatusOptions,
} from "./status-options";

/**
 * Fija la lista de estados de citas en EA. **Se corre una vez, antes del corte.**
 *
 * ```
 *   node scripts/estados.js            ← muestra el plan y no escribe nada
 *   node scripts/estados.js --aplicar  ← escribe
 * ```
 *
 * ## Por qué no escribe por defecto
 *
 * Es una operación de una sola dirección sobre un ajuste de texto libre que EA
 * no migra hacia atrás. Un script que escribe al invocarse se corre por
 * accidente; uno que primero muestra el plan se lee antes de aplicarse. La
 * bandera se escribe entera —`--aplicar`, no `-a`— por lo mismo.
 *
 * ## Por qué lee todas las citas
 *
 * Para saber qué estados están en uso. Es una lectura completa de la agenda, y
 * está bien: corre una vez en la vida del estudio y la alternativa —asumir que
 * la agenda está vacía— es exactamente el supuesto que vuelve peligrosa esta
 * operación el día que no se cumple.
 */
async function run(): Promise<void> {
  const aplicar = process.argv.includes("--aplicar");

  try {
    const ea = createEaClient();

    const setting = await ea.settings.get(STATUS_OPTIONS_SETTING).catch(() => null);
    const current = parseStatusOptions(setting?.value ?? null);

    // `list()` de A1 pagina hasta agotar y **lanza** si toca el tope, en vez de
    // devolver un resultado parcial. Acá eso importa más que en ningún lado: un
    // listado truncado escondería justo las citas cuyo estado se va a perder.
    const appointments = await ea.appointments.list({});
    const inUse = appointments.map((appointment) => appointment.status ?? "");

    const plan = planStatusOptions({ current, inUse });

    console.log(`estados: ${appointments.length} cita(s) en la agenda.`);
    console.log(`estados: lista actual  → ${current === null ? "(sin ajuste)" : current.join(" · ")}`);
    console.log(`estados: lista destino → ${STATUS_OPTIONS.join(" · ")}`);

    if (plan.action === "peligro") {
      console.error(
        `estados: ⚠ NO se escribió. Hay citas con estados que la lista nueva no tiene: ` +
          `${plan.losing.map((s) => JSON.stringify(s)).join(", ")}.\n` +
          `         EA guarda el estado como texto en cada fila y no lo migra: esas citas ` +
          `quedarían con una cadena que el desplegable ya no ofrece.\n` +
          `         Estados en uso hoy: ${plan.inUse.join(" · ")}.`,
      );
      process.exitCode = 1;
      return;
    }

    if (plan.action === "ya-esta") {
      console.log("estados: la lista ya es la correcta. No se escribió nada.");
      return;
    }

    if (!aplicar) {
      console.log("estados: ejecución en seco. Volver a correr con --aplicar para escribir.");
      return;
    }

    await ea.settings.update(STATUS_OPTIONS_SETTING, serializeStatusOptions(plan.to));
    console.log(`estados: ✓ escrito. ${plan.to.length} estados en la lista.`);
  } catch (error) {
    console.error("estados: no se pudo fijar la lista.", error);
    process.exitCode = 1;
  }
}

void run();
