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

type Ids = { general: { id: number }[]; own: { id: number }[]; left: { id: number }[] };
const ids = (r: Ids) => ({
  general: r.general.map((s) => s.id),
  own: r.own.map((s) => s.id),
  left: r.left.map((s) => s.id),
});

describe("bookingRecipients", () => {
  it("una reserva web en la columna de Daniela: general a dueña y recepción, propio a Daniela", () => {
    expect(ids(bookingRecipients({ subscriptions: SUBS, allowlist: ALLOWLIST, providerId: 5 }))).toEqual({
      general: [1, 2],
      own: [3],
      left: [],
    });
  });

  it("nunca le avisa a la técnica de la columna de otra", () => {
    const r = bookingRecipients({ subscriptions: SUBS, allowlist: ALLOWLIST, providerId: 5 });
    expect([...r.own, ...r.left].map((s) => s.email)).toEqual(["daniela@goldenbeautystudio.com.co"]);
  });

  it("una cita del panel que agendó recepción: a la dueña y a Daniela, no a recepción", () => {
    expect(
      ids(
        bookingRecipients({
          subscriptions: SUBS,
          allowlist: ALLOWLIST,
          providerId: 5,
          actorUserIds: ["u-recepcion"],
        }),
      ),
    ).toEqual({ general: [1], own: [3], left: [] });
  });

  it("la técnica que se agenda a sí misma: se enteran dueña y recepción, ella no", () => {
    expect(
      ids(
        bookingRecipients({
          subscriptions: SUBS,
          allowlist: ALLOWLIST,
          providerId: 5,
          actorUserIds: ["u-daniela"],
        }),
      ),
    ).toEqual({ general: [1, 2], own: [], left: [] });
  });

  it("la dueña que atiende recibe el general y no además el propio", () => {
    expect(
      ids(
        bookingRecipients({
          subscriptions: SUBS,
          allowlist: ALLOWLIST,
          providerId: 4,
          actorUserIds: ["u-recepcion"],
        }),
      ),
    ).toEqual({ general: [1], own: [], left: [] });
  });

  it("una cita que pasa de Daniela a Lina: Lina la recibe, Daniela se entera de que salió", () => {
    expect(
      ids(
        bookingRecipients({
          subscriptions: SUBS,
          allowlist: ALLOWLIST,
          providerId: 6,
          previousProviderId: 5,
          actorUserIds: ["u-duena"],
        }),
      ),
    ).toEqual({ general: [2], own: [4], left: [3] });
  });

  it("sin cambio de columna nadie recibe «salió»", () => {
    const r = bookingRecipients({
      subscriptions: SUBS,
      allowlist: ALLOWLIST,
      providerId: 5,
      previousProviderId: 5,
    });
    expect(r.left).toEqual([]);
    expect(r.own.map((s) => s.id)).toEqual([3]);
  });

  it("ninguno de los que hicieron cambios juntados recibe el aviso", () => {
    expect(
      ids(
        bookingRecipients({
          subscriptions: SUBS,
          allowlist: ALLOWLIST,
          providerId: 5,
          actorUserIds: ["u-recepcion", "u-duena"],
        }),
      ),
    ).toEqual({ general: [], own: [3], left: [] });
  });

  it("quien ya no está en Equipo no recibe nada", () => {
    const r = bookingRecipients({
      subscriptions: SUBS,
      allowlist: ALLOWLIST,
      providerId: 5,
      previousProviderId: 6,
    });
    expect([...r.general, ...r.own, ...r.left].map((s) => s.id)).not.toContain(5);
  });
});
