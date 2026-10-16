import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseEaLocalDate } from "@/lib/ea";
import type { AppointmentWithRelations } from "@/lib/ea/client";

import { REMINDER_RULES, planReminders, toleranceCoversInterval } from "./reminders";
import {
  REMINDERS_INTERVAL_MINUTES,
  planRetries,
  summarize,
  toRunnerAppointments,
  type StoredRow,
} from "./reminders-run";

/** Jueves 15 de octubre de 2026, 10:00 a. m. en Bogotá. */
const NOW = new Date("2026-10-15T15:00:00Z");

function row(over: {
  id?: number;
  start?: string;
  status?: string;
  phone?: string | null;
  firstName?: string | null;
}): AppointmentWithRelations {
  return {
    appointment: {
      id: over.id ?? 1,
      start: over.start ?? "2026-10-16 10:00:00",
      end: "2026-10-16 11:00:00",
      status: over.status ?? "Reservada",
      customerId: 5,
      providerId: 2,
      serviceId: 3,
    },
    service: { name: "Semipermanente manos" },
    provider: { firstName: "Lina" },
    customer:
      over.phone === null
        ? { firstName: over.firstName ?? "Laura", phone: null }
        : { firstName: over.firstName ?? "Laura", phone: over.phone ?? "300 123 4567" },
  } as unknown as AppointmentWithRelations;
}

describe("toRunnerAppointments", () => {
  it("manos + pies seguidas son un solo recordatorio, que nombra los dos servicios", () => {
    const manos = row({ id: 1 });
    const pies = row({ id: 2, start: "2026-10-16 11:00:00" });
    (pies.appointment as { end: string }).end = "2026-10-16 12:15:00";
    (pies as { service: { name: string } }).service = { name: "Semipermanente pies" };

    const map = toRunnerAppointments([manos, pies]);
    expect([...map.keys()]).toEqual([1]);
    expect(map.get(1)?.template.serviceName).toBe("Semipermanente manos y Semipermanente pies");
  });


  it("convierte la hora de pared al instante y normaliza el teléfono", () => {
    const map = toRunnerAppointments([row({})]);
    const a = map.get(1);
    expect(a?.planning).toEqual({
      eaAppointmentId: 1,
      // 10:00 en Bogotá (UTC−5) = 15:00 UTC.
      startAt: new Date("2026-10-16T15:00:00Z"),
      phoneE164: "+573001234567",
      status: "Reservada",
    });
    expect(a?.template).toEqual({
      start: "2026-10-16 10:00:00",
      customerFirstName: "Laura",
      serviceName: "Semipermanente manos",
      providerFirstName: "Lina",
    });
  });

  it("una clienta sin teléfono utilizable queda con null, no con basura", () => {
    expect(toRunnerAppointments([row({ phone: "no tiene" })]).get(1)?.planning.phoneE164).toBeNull();
    expect(toRunnerAppointments([row({ phone: null })]).get(1)?.planning.phoneE164).toBeNull();
  });

  it("la cita de mañana a esta hora entra en la ventana de 24 h", () => {
    const appointments = [...toRunnerAppointments([row({})]).values()].map((a) => a.planning);
    const decisions = planReminders({ appointments, existing: [], optedOut: new Set(), now: NOW });
    expect(decisions).toEqual([
      expect.objectContaining({ action: "enviar", rule: expect.objectContaining({ kind: "recordatorio_24h" }) }),
    ]);
  });
});

describe("planRetries", () => {
  const appointments = [...toRunnerAppointments([row({})]).values()].map((a) => a.planning);
  const stored = (over: Partial<StoredRow>): StoredRow => ({
    id: 9,
    eaAppointmentId: 1,
    kind: "recordatorio_24h",
    channel: "cloud_api",
    status: "fallido",
    error: "reintentable:130429: Límite.",
    ...over,
  });
  const plan = (row: StoredRow, optedOut: string[] = []) =>
    planRetries({
      decisions: planReminders({
        appointments,
        existing: [{ eaAppointmentId: row.eaAppointmentId, kind: row.kind }],
        optedOut: new Set(optedOut),
        now: NOW,
      }),
      stored: [row],
      optedOut: new Set(optedOut),
      now: NOW,
    });

  it("reintenta un fallo reintentable del automático, dentro de la ventana", () => {
    expect(plan(stored({}))).toEqual([expect.objectContaining({ rowId: 9 })]);
  });

  it("no reintenta un fallo definitivo ni un timeout", () => {
    expect(plan(stored({ error: "definitivo:131026: Sin WhatsApp." }))).toEqual([]);
    expect(plan(stored({ error: "definitivo:timeout: Puede haber salido." }))).toEqual([]);
  });

  it("no toca lo que salió, ni lo que mandó recepción a mano", () => {
    expect(plan(stored({ status: "enviado" }))).toEqual([]);
    expect(plan(stored({ channel: "manual" }))).toEqual([]);
  });

  it("respeta una baja que llegó después del fallo", () => {
    expect(plan(stored({}), ["+573001234567"])).toEqual([]);
  });
});

describe("summarize", () => {
  it("una línea con lo que hizo y por qué omitió", () => {
    expect(
      summarize({
        from: parseEaLocalDate("2026-10-15"),
        till: parseEaLocalDate("2026-10-17"),
        scanned: 12,
        sent: 3,
        failed: 1,
        retried: 0,
        alreadyHandled: 2,
        skipped: { "sin-telefono": 1, "ya-existe": 2 },
      }),
    ).toBe(
      "2026-10-15→2026-10-17: 12 citas · 3 enviados · 1 fallidos · 0 reintentados · 2 ya resueltos · omitidos: sin-telefono 1",
    );
  });
});

describe("el intervalo del servicio y la tolerancia de las ventanas", () => {
  it("la tolerancia de REMINDER_RULES cubre el intervalo del job", () => {
    expect(toleranceCoversInterval(REMINDER_RULES, REMINDERS_INTERVAL_MINUTES)).toBe(true);
  });

  it("el servicio admin-recordatorios del stack duerme exactamente ese intervalo", () => {
    // Si alguien sube el `sleep` del compose sin subir la tolerancia, las citas
    // empiezan a caer entre dos corridas y nadie se entera. Este test lee el
    // archivo real para que ese cambio no pase inadvertido.
    const compose = readFileSync(
      fileURLToPath(new URL("../../../deploy/compose/gbs-stack.yml", import.meta.url)),
      "utf8",
    );
    const block = compose.slice(compose.indexOf("  admin-recordatorios:"));
    expect(block).toContain("node scripts/recordatorios.js");
    const sleeps = [...block.matchAll(/node scripts\/recordatorios\.js\s+sleep (\d+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(sleeps).toEqual([REMINDERS_INTERVAL_MINUTES * 60]);
  });
});
