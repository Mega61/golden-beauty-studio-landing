import { describe, expect, it } from "vitest";

import type { AllowedIdentity } from "@/lib/auth-policy";

import { bookingRecipients } from "./recipients";

const ALLOWLIST: AllowedIdentity[] = [
  { email: "duena@goldenbeautystudio.com.co", role: "owner", ea_provider_id: 4 },
  { email: "recepcion@goldenbeautystudio.com.co", role: "admin", ea_provider_id: null },
  { email: "daniela@goldenbeautystudio.com.co", role: "staff", ea_provider_id: 5 },
  { email: "lina@goldenbeautystudio.com.co", role: "staff", ea_provider_id: 6 },
];

const sub = (id: number, who: string) => ({
  id,
  userId: `u-${who}`,
  email: `${who}@goldenbeautystudio.com.co`,
});

const SUBS = [sub(1, "duena"), sub(2, "recepcion"), sub(3, "daniela"), sub(4, "lina"), sub(5, "exempleada")];

const ids = (r: { general: { id: number }[]; own: { id: number }[] }) => ({
  general: r.general.map((s) => s.id),
  own: r.own.map((s) => s.id),
});

describe("bookingRecipients", () => {
  it("una reserva web en la columna de Daniela: general a dueña y recepción, propio a Daniela", () => {
    expect(
      ids(bookingRecipients({ subscriptions: SUBS, allowlist: ALLOWLIST, providerId: 5, source: "web" })),
    ).toEqual({ general: [1, 2], own: [3] });
  });

  it("nunca le avisa a la técnica de la columna de otra", () => {
    const r = bookingRecipients({ subscriptions: SUBS, allowlist: ALLOWLIST, providerId: 5, source: "panel" });
    expect(r.own.map((s) => s.email)).toEqual(["daniela@goldenbeautystudio.com.co"]);
  });

  it("una cita del panel no manda el general, y no le avisa a quien la agendó", () => {
    expect(
      ids(
        bookingRecipients({
          subscriptions: SUBS,
          allowlist: ALLOWLIST,
          providerId: 5,
          source: "panel",
          actorUserId: "u-daniela",
        }),
      ),
    ).toEqual({ general: [], own: [] });
  });

  it("la dueña que atiende: por la página le basta el general; desde el panel, el propio", () => {
    expect(
      ids(bookingRecipients({ subscriptions: SUBS, allowlist: ALLOWLIST, providerId: 4, source: "web" })),
    ).toEqual({ general: [1, 2], own: [] });
    expect(
      ids(
        bookingRecipients({
          subscriptions: SUBS,
          allowlist: ALLOWLIST,
          providerId: 4,
          source: "panel",
          actorUserId: "u-recepcion",
        }),
      ),
    ).toEqual({ general: [], own: [1] });
  });

  it("quien ya no está en Equipo no recibe nada", () => {
    const r = bookingRecipients({ subscriptions: SUBS, allowlist: ALLOWLIST, providerId: 5, source: "web" });
    expect([...r.general, ...r.own].map((s) => s.id)).not.toContain(5);
  });
});
