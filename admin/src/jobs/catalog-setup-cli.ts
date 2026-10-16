import { createAndLinkService, linkExistingService } from "@/app/(panel)/servicios/catalog-writes";
import { loadServicesView } from "@/app/(panel)/servicios/data";
import { SERVICE_CATEGORIES, SERVICE_NAMES } from "@/data/service-names";
import { getDb } from "@/db/client";
import { auditLogRepository } from "@/db/repositories";
import { EaApiError } from "@/lib/ea";
import { createEaClient } from "@/lib/ea/client";

import {
  bookableServiceIds,
  describeStep,
  parseProviderIds,
  planCatalogSetup,
  planProviderServices,
} from "./catalog-setup";

/**
 * Crea en EA los servicios de la vitrina que faltan, los vincula, y opcionalmente
 * se los asigna a las técnicas. **Se corre una vez, en la puesta en marcha.**
 *
 * ```
 *   node scripts/catalogo.js                         ← muestra el plan, no escribe
 *   node scripts/catalogo.js --aplicar               ← crea + vincula
 *   node scripts/catalogo.js --aplicar --asignar=2   ← y asigna todo a la técnica 2
 * ```
 *
 * Lo mismo que el botón "Crear" de /admin/servicios, de una sola vez y con los
 * nombres de la landing en vez de tipeados: mismo diff, mismo `createPayload()`,
 * mismo orden de escrituras y misma bitácora (`catalogo.crear`, con actor
 * `null` = el sistema, como el reconcile).
 *
 * Idempotente: lo ya vinculado se reporta y no se toca, así que la segunda
 * corrida no hace nada. Un fallo en un servicio no frena a los demás; el resumen
 * lista los que quedaron, y el código de salida es 1 si hubo alguno.
 *
 * Las categorías de EA no se tocan: `createPayload()` no las usa y la reserva
 * no las muestra.
 */
const REASON = "scripts/catalogo.js";

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const aplicar = argv.includes("--aplicar");
  const failures: string[] = [];

  try {
    const providerIds = parseProviderIds(argv);

    const view = await loadServicesView();
    if (view.diff === null) {
      console.error("catalogo: no se pudo leer alguna de las tres fuentes (vitrina, agenda, mapa):");
      for (const failure of view.failures) {
        console.error(`  - ${failure.message}${failure.detail ? ` (${failure.detail})` : ""}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`catalogo: vitrina leída de ${view.pricingSourcePath}.`);
    console.log(`catalogo: ${view.services.length} servicio(s) en la agenda, ${view.serviceMap.length} vinculado(s).`);

    const plan = planCatalogSetup({
      rows: view.diff.rows,
      names: SERVICE_NAMES,
      order: Object.keys(SERVICE_NAMES),
    });

    const label = new Map(SERVICE_CATEGORIES.map((c) => [c.id, c.label]));
    let lastCategory: string | null | undefined;
    for (const step of plan.steps) {
      if (step.categoryId !== lastCategory) {
        lastCategory = step.categoryId;
        console.log(`\n  ${label.get(step.categoryId ?? "") ?? step.categoryId ?? "(sin categoría)"}`);
      }
      console.log(`    ${describeStep(step)}`);
    }

    console.log(
      `\ncatalogo: ${plan.counts.crear} por crear · ${plan.counts.vincular} por vincular · ` +
        `${plan.counts.vinculado} ya vinculados · ${plan.counts.bloqueado} bloqueados.`,
    );
    if (plan.unclaimed.length > 0) {
      console.log(
        `catalogo: en la agenda sin dueño (no se tocan): ` +
          plan.unclaimed.map((s) => `${s.eaServiceId} "${s.name ?? "?"}"`).join(", ") +
          ".",
      );
    }

    if (!aplicar) {
      if (providerIds.length > 0) {
        const bookable = bookableServiceIds(view.diff.rows);
        const pending = plan.counts.crear + plan.counts.vincular;
        console.log(
          `catalogo: --asignar=${providerIds.join(",")} asignaría los ${bookable.length} servicio(s) ` +
            `vinculados hoy` + (pending > 0 ? ` más los ${pending} que se crearían/vincularían` : "") + ".",
        );
      }
      console.log("\ncatalogo: ejecución en seco. Volver a correr con --aplicar para escribir.");
      return;
    }

    // ── Crear y vincular ─────────────────────────────────────────────────────
    const actor = { actorUserId: null, reason: REASON };
    let created = 0;
    let linked = 0;
    for (const step of plan.steps) {
      if (step.kind === "crear") {
        const outcome = await createAndLinkService(step.pricingId, step.payload, actor);
        if (outcome.ok) {
          created += 1;
          console.log(`  ✓ ${step.pricingId} creado (id ${outcome.eaServiceId}).`);
        } else if (outcome.stage === "ea") {
          failures.push(step.pricingId);
          console.error(`  ✗ ${step.pricingId}: la agenda no aceptó la creación. ${describe(outcome.error)}`);
        } else {
          failures.push(step.pricingId);
          console.error(
            `  ✗ ${step.pricingId}: se creó en la agenda (id ${outcome.eaServiceId}) pero no se vinculó. ` +
              `La próxima corrida lo vincula por nombre; no hay que borrarlo. ${describe(outcome.error)}`,
          );
        }
      } else if (step.kind === "vincular") {
        try {
          await linkExistingService(step.pricingId, step.eaServiceId, actor);
          linked += 1;
          console.log(`  ✓ ${step.pricingId} vinculado al ${step.eaServiceId}.`);
        } catch (error) {
          failures.push(step.pricingId);
          console.error(`  ✗ ${step.pricingId}: no se pudo vincular. ${describe(error)}`);
        }
      }
    }
    console.log(`catalogo: ${created} creado(s), ${linked} vinculado(s), ${failures.length} con error.`);

    // ── Asignar a las técnicas ───────────────────────────────────────────────
    if (providerIds.length > 0) {
      // Se relee todo: lo que cuenta es lo que quedó vinculado, no lo que se
      // intentó.
      const after = await loadServicesView();
      if (after.diff === null) {
        failures.push("asignar");
        console.error("catalogo: no se pudo releer el catálogo para asignar. No se asignó nada.");
      } else {
        const bookable = bookableServiceIds(after.diff.rows);
        const ea = createEaClient();
        for (const providerId of providerIds) {
          try {
            const provider = await ea.providers.get(providerId);
            const { add, next } = planProviderServices(provider.services, bookable);
            const who = [provider.firstName, provider.lastName].filter(Boolean).join(" ") || "?";
            if (add.length === 0) {
              console.log(`  = técnica ${providerId} (${who}): ya tenía los ${bookable.length}.`);
              continue;
            }
            // PUT quirúrgico: solo `services`. `api_decode()` de EA pisa
            // únicamente las claves presentes.
            await ea.providers.update(providerId, { services: next });
            await auditLogRepository(getDb()).append({
              actorUserId: null,
              action: "catalogo.asignar",
              entity: "ea_provider",
              entityId: providerId,
              before: { services: provider.services ?? [] },
              after: { services: next },
              reason: REASON,
              at: new Date(),
            });
            console.log(`  ✓ técnica ${providerId} (${who}): +${add.length} servicio(s).`);
          } catch (error) {
            failures.push(`técnica ${providerId}`);
            console.error(`  ✗ técnica ${providerId}: ${describe(error)}`);
          }
        }
      }
    }

    if (failures.length > 0) {
      console.error(`catalogo: ⚠ quedaron pendientes: ${failures.join(", ")}. Se puede volver a correr.`);
      process.exitCode = 1;
    } else {
      console.log("catalogo: ✓ listo.");
    }
  } catch (error) {
    console.error("catalogo: no se pudo completar.", error);
    process.exitCode = 1;
  } finally {
    await getDb()
      .destroy()
      .catch(() => undefined);
  }
}

function describe(error: unknown): string {
  if (error instanceof EaApiError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

void run();
