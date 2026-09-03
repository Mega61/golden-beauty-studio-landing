import { describe, expect, it } from "vitest";

import type { Provider, ProviderSettings } from "@/lib/ea";

import { eaGoogleOauthUrl, googleSyncStatus } from "./sync";

function provider(settings: Partial<ProviderSettings> | null): Provider {
  return {
    id: 3,
    firstName: "Lina",
    lastName: null,
    email: null,
    mobile: null,
    phone: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    notes: null,
    timezone: null,
    language: null,
    ldapDn: null,
    isPrivate: false,
    services: [1, 2],
    settings:
      settings === null
        ? null
        : {
            username: null,
            notifications: null,
            calendarView: null,
            googleSync: null,
            googleToken: null,
            googleCalendar: null,
            caldavSync: null,
            caldavUrl: null,
            caldavUsername: null,
            syncFutureDays: null,
            syncPastDays: null,
            workingPlan: null,
            workingPlanExceptions: null,
            ...settings,
          },
  };
}

describe("googleSyncStatus", () => {
  it("activo cuando hay interruptor, token y calendario", () => {
    const status = googleSyncStatus(
      provider({
        googleSync: true,
        googleToken: '{"access_token":"…"}',
        googleCalendar: "gbs-lina@goldenbeautystudio.com.co",
        syncPastDays: 30,
        syncFutureDays: 90,
      }),
    );

    expect(status.state).toBe("activo");
    expect(status.calendarId).toBe("gbs-lina@goldenbeautystudio.com.co");
    expect(status.hasToken).toBe(true);
    expect(status.pastDays).toBe(30);
    expect(status.futureDays).toBe(90);
    expect(status.problems).toEqual([]);
  });

  it("el token nunca sale del módulo, solo si lo hay", () => {
    const status = googleSyncStatus(
      provider({ googleSync: true, googleToken: "SECRETO", googleCalendar: "c" }),
    );
    expect(JSON.stringify(status)).not.toContain("SECRETO");
  });

  it("incompleto cuando está activo y falta el token: el push no llega a ninguna parte", () => {
    const status = googleSyncStatus(
      provider({ googleSync: true, googleToken: null, googleCalendar: "c" }),
    );
    expect(status.state).toBe("incompleto");
    expect(status.problems).toHaveLength(1);
    expect(status.problems[0]).toMatch(/credencial/);
  });

  it("incompleto cuando está activo y no hay calendario elegido", () => {
    const status = googleSyncStatus(
      provider({ googleSync: true, googleToken: "x", googleCalendar: "   " }),
    );
    expect(status.state).toBe("incompleto");
    expect(status.calendarId).toBeNull();
    expect(status.problems[0]).toMatch(/calendario/);
  });

  it("acumula los dos problemas cuando faltan los dos", () => {
    const status = googleSyncStatus(provider({ googleSync: true }));
    expect(status.problems).toHaveLength(2);
  });

  it("apagado no es un problema: puede ser deliberado", () => {
    const status = googleSyncStatus(provider({ googleSync: false, googleCalendar: "c" }));
    expect(status.state).toBe("apagado");
    expect(status.problems).toEqual([]);
  });

  it("un provider sin settings no revienta", () => {
    const status = googleSyncStatus(provider(null));
    expect(status.state).toBe("apagado");
    expect(status.hasToken).toBe(false);
    expect(status.pastDays).toBeNull();
  });
});

describe("eaGoogleOauthUrl", () => {
  it("arma la ruta del flujo de EA por provider", () => {
    expect(eaGoogleOauthUrl("https://agenda.goldenbeautystudio.com.co", 3)).toBe(
      "https://agenda.goldenbeautystudio.com.co/index.php/google/oauth/3",
    );
  });

  it("no duplica la barra final", () => {
    expect(eaGoogleOauthUrl("http://localhost:8080///", 12)).toBe(
      "http://localhost:8080/index.php/google/oauth/12",
    );
  });
});
