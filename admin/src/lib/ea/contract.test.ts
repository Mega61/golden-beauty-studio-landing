/**
 * Capa 3 — suite de contrato contra una Easy!Appointments **real**.
 *
 * No prueba EA. Prueba **que seguimos teniendo razón sobre EA**: cada
 * afirmación de acá es un supuesto del que depende una decisión de diseño del
 * panel, y si EA cambia en un upgrade, esto es lo que lo dice antes de que se
 * note como una cita perdida o un choque que nadie detectó.
 *
 * ## Cómo se corre
 *
 * ```bash
 * EA_CONTRACT_URL=http://localhost/index.php/api/v1 \
 * EA_CONTRACT_TOKEN=… \
 * npm test -- src/lib/ea/contract.test.ts
 * ```
 *
 * Sin esas dos variables la suite **se salta sola**, para que `npm test` siga
 * verde en CI y en el portátil de cualquiera sin una EA levantada. Un test de
 * contrato que rompe el build cuando no hay servidor se termina borrando.
 *
 * ## Contra qué instancia
 *
 * **Una instancia desechable**, nunca la de producción: la prueba del choque
 * de horarios crea dos citas encimadas de verdad. Se borran al final, pero un
 * fallo a mitad de camino deja basura, y en producción esa basura son citas que
 * alguien va a ver en su calendario de Google.
 *
 * ## Qué necesita la instancia
 *
 * Al menos una técnica y un servicio dados de alta, y una clienta. Es lo que
 * trae el seed de EA. Si falta, la suite lo dice en vez de fallar en cascada.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { instantToEaDate, addMinutes, eaLocalDateTime } from "./datetime";
import { createEaClient, type EaClient } from "./client";
import { EA_WEBHOOK_ACTIONS } from "./types";

const baseUrl = process.env.EA_CONTRACT_URL;
const token = process.env.EA_CONTRACT_TOKEN;
const enabled = Boolean(baseUrl && token);

/**
 * Todo cuelga de acá. `describe.skipIf` colecciona los tests y los reporta como
 * saltados, que es mejor que no existir: en la salida de `npm test` se ve que
 * la capa 3 está y que hoy no corrió.
 */
describe.skipIf(!enabled)("contrato contra una EA real", () => {
  let ea: EaClient;
  const creados: number[] = [];

  beforeAll(() => {
    ea = createEaClient({
      baseUrl: baseUrl as string,
      token: token as string,
      timeoutMs: 30_000,
    });
  });

  afterAll(async () => {
    // Se borra lo que se creó, incluso si un `expect` falló antes.
    for (const id of creados) {
      await ea.appointments.remove(id).catch(() => undefined);
    }
  });

  it(
    "los trece recursos que el plan asume existen y responden",
    async () => {
      // `blocked_periods` y `unavailabilities` son los dos que el plan da por
      // sentados para Bloqueos y para el motor de choques de B3. Si un upgrade
      // los sacara, C1 y B3 se caen enteros.
      await expect(ea.blockedPeriods.listPage({ length: 1 })).resolves.toBeDefined();
      await expect(ea.unavailabilities.listPage({ length: 1 })).resolves.toBeDefined();
      await expect(ea.workingPlanExceptions.listPage({ length: 1 })).resolves.toBeDefined();
      await expect(ea.appointments.listPage({ length: 1 })).resolves.toBeDefined();
      await expect(ea.customers.listPage({ length: 1 })).resolves.toBeDefined();
      await expect(ea.services.listPage({ length: 1 })).resolves.toBeDefined();
      await expect(ea.serviceCategories.listPage({ length: 1 })).resolves.toBeDefined();
      await expect(ea.providers.listPage({ length: 1 })).resolves.toBeDefined();
      await expect(ea.secretaries.listPage({ length: 1 })).resolves.toBeDefined();
      await expect(ea.admins.listPage({ length: 1 })).resolves.toBeDefined();
      await expect(ea.webhooks.listPage({ length: 1 })).resolves.toBeDefined();
      await expect(ea.settings.list()).resolves.toBeDefined();
    },
    60_000,
  );

  it("appointments acepta from y till", async () => {
    const hoy = instantToEaDate(new Date());

    const page = await ea.appointments.listPage({ from: hoy, till: hoy, length: 50 });

    expect(Array.isArray(page.items)).toBe(true);
  });

  it("el payload de la API es camelCase, no la fila cruda", async () => {
    const raw = await ea.raw({
      method: "GET",
      path: "appointments",
      params: new URLSearchParams({ length: "1", page: "1" }),
    });

    const [first] = raw as Record<string, unknown>[];

    // Puede no haber ninguna cita en una instancia recién levantada; el test
    // sigue siendo válido en cuanto haya una.
    if (!first) return;

    expect(first).toHaveProperty("start");
    expect(first).toHaveProperty("providerId");
    expect(first).not.toHaveProperty("start_datetime");
    expect(first).not.toHaveProperty("id_users_provider");
  });

  it("la paginación por defecto sigue siendo de 20", async () => {
    // El número exacto importa: si EA lo bajara, un listado que hoy da completo
    // pasaría a truncarse. El cliente manda `length` siempre, pero esto es lo
    // que verifica que la razón para hacerlo sigue vigente.
    const raw = await ea.raw({ method: "GET", path: "appointments" });
    const rows = raw as unknown[];

    if (rows.length < 20) return; // La instancia no tiene suficientes citas.

    expect(rows).toHaveLength(20);
  });

  it("service.color sigue sin viajar en la respuesta de la API", async () => {
    // `Services_model::api_encode()` no lo emite aunque el openapi.yml lo
    // declare. Si algún día lo emitiera, C1 puede dejar de leerlo por MySQL.
    const raw = await ea.raw({
      method: "GET",
      path: "services",
      params: new URLSearchParams({ length: "1" }),
    });

    const [first] = raw as Record<string, unknown>[];

    if (!first) return;

    expect(first).not.toHaveProperty("color");
  });

  it("las acciones de webhook que registramos son las que EA reconoce", async () => {
    // No hay endpoint que las liste, así que se verifica de rebote: registrar
    // un webhook con nuestras acciones y leerlo de vuelta tal cual.
    const created = await ea.webhooks.create({
      name: "contrato-gbs",
      url: "http://127.0.0.1:9/never",
      actions: "appointment_save,appointment_delete",
      secretToken: "contract-test",
      isSslVerified: false,
    });

    try {
      expect(created.actions?.split(",")).toEqual(["appointment_save", "appointment_delete"]);
      expect(EA_WEBHOOK_ACTIONS).toContain("appointment_save");
      // La columna existe pero la API no la expone: si algún día apareciera,
      // el Diagnóstico de D4 podría verificar el header además de la URL.
      expect(created).not.toHaveProperty("secretHeader");
    } finally {
      await ea.webhooks.remove(created.id).catch(() => undefined);
    }
  });

  it(
    "POST /appointments SIGUE sin validar choques — todo lib/conflict.ts depende de esto",
    async () => {
      // El supuesto más caro del plan. `Appointments_api_v1::store()` no llama
      // a `has_provider_conflict()`; solo `Calendar.php`, el backend propio de
      // EA, lo hace. Si un upgrade agregara la validación a la API, nuestras
      // escrituras empezarían a fallar con `{success:false, conflict:true}` y
      // habría que enterarse acá, no en el celular de una técnica.
      const [provider] = (await ea.providers.listPage({ length: 1 })).items;
      const [service] = (await ea.services.listPage({ length: 1 })).items;
      const [customer] = (await ea.customers.listPage({ length: 1 })).items;

      expect(
        provider && service && customer,
        "la instancia de contrato necesita al menos una técnica, un servicio y una clienta",
      ).toBeTruthy();

      // Un año adelante, para no chocar con datos reales de la instancia.
      const start = eaLocalDateTime(new Date().getFullYear() + 1, 6, 15, 10, 0, 0);
      const end = addMinutes(start, 60);
      const solapada = addMinutes(start, 30);

      const primera = await ea.appointments.create({
        start,
        end,
        providerId: provider.id,
        serviceId: service.id,
        customerId: customer.id,
        status: "Booked",
        notes: "contrato gbs — borrar",
      });
      creados.push(primera.id);

      const segunda = await ea.appointments.create({
        start: solapada,
        end: addMinutes(solapada, 60),
        providerId: provider.id,
        serviceId: service.id,
        customerId: customer.id,
        status: "Booked",
        notes: "contrato gbs — borrar",
      });
      creados.push(segunda.id);

      // Las dos existen, encimadas, para la misma técnica. EA no protestó.
      expect(segunda.id).not.toBe(primera.id);
      expect(segunda.providerId).toBe(primera.providerId);
      expect(segunda.start < primera.end).toBe(true);
    },
    60_000,
  );

  it("el datetime que EA devuelve es hora de pared, sin zona ni sufijo", async () => {
    const page = await ea.appointments.listPage({ length: 1 });
    const [first] = page.items;

    if (!first) return;

    // El codec ya lo habría rechazado, pero el test lo dice explícito: es el
    // supuesto del que cuelga toda la aritmética de `datetime.ts`.
    expect(first.start).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("un token equivocado da 401, no un 200 vacío", async () => {
    const impostor = createEaClient({
      baseUrl: baseUrl as string,
      token: "definitivamente-no-es-el-token",
      timeoutMs: 30_000,
    });

    await expect(impostor.appointments.listPage({ length: 1 })).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });
});
