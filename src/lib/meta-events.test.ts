import { describe, expect, it } from "vitest";

import { buildCapiEvent, fbcFrom, newEventId, normalizeName, normalizePhoneForMeta } from "./meta-events";

describe("normalizePhoneForMeta", () => {
  it.each([
    ["300 123 4567", "573001234567"],
    ["+57 300 123 4567", "573001234567"],
    ["573001234567", "573001234567"],
    ["+1 (415) 555-0100", "14155550100"],
    ["123", null],
    ["", null],
  ])("%s → %s", (raw, out) => expect(normalizePhoneForMeta(raw)).toBe(out));
});

describe("names and click ids", () => {
  it("lowercases and trims, keeps accents", () => {
    expect(normalizeName("  Ángela ")).toBe("ángela");
    expect(normalizeName("  ")).toBeNull();
  });

  it("prefers the Pixel's cookie, rebuilds from fbclid otherwise", () => {
    expect(fbcFrom("fb.1.1.abc", "zzz")).toBe("fb.1.1.abc");
    expect(fbcFrom(null, "zzz", 1700000000000)).toBe("fb.1.1700000000000.zzz");
    expect(fbcFrom(null, null)).toBeNull();
  });

  it("event ids are unique and carry their prefix", () => {
    const a = newEventId("schedule");
    expect(a.startsWith("schedule-")).toBe(true);
    expect(a).not.toBe(newEventId("schedule"));
  });
});

describe("buildCapiEvent", () => {
  const hash = (s: string) => `h(${s})`;
  const base = {
    eventName: "Schedule" as const,
    eventId: "schedule-1",
    eventTime: new Date("2026-10-15T20:00:00Z"),
    sourceUrl: "https://goldenbeautystudio.com.co/es/reservar",
    ip: "203.0.113.9",
    userAgent: "UA",
    fbc: "fb.1.1.abc",
    fbp: null,
  };

  it("hashes what identifies a person and nothing else", () => {
    const e = buildCapiEvent(
      { ...base, phone: "300 123 4567", firstName: "Laura", lastName: "Gómez", customData: { value: 50000, currency: "COP" } },
      hash,
    );
    expect(e.user_data).toEqual({
      country: ["h(co)"],
      ph: ["h(573001234567)"],
      fn: ["h(laura)"],
      ln: ["h(gómez)"],
      client_ip_address: "203.0.113.9",
      client_user_agent: "UA",
      fbc: "fb.1.1.abc",
    });
    expect(e.event_time).toBe(1792094400);
    expect(e.event_id).toBe("schedule-1");
    expect(e.custom_data).toEqual({ value: 50000, currency: "COP" });
  });

  it("leaves out what it doesn't have instead of sending blanks", () => {
    const e = buildCapiEvent({ ...base, ip: "unknown", userAgent: null, fbc: null }, hash);
    expect(e.user_data).toEqual({ country: ["h(co)"] });
    expect("custom_data" in e).toBe(false);
  });
});
