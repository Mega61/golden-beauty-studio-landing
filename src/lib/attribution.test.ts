import { describe, expect, it } from "vitest";

import { ATTRIBUTION_TTL_MS, attributionFromVisit, readStoredAttribution } from "./attribution";

const NOW = 1_800_000_000_000;
const SITE = "https://www.goldenbeautystudio.com.co";

describe("attributionFromVisit", () => {
  it("reads the UTMs of a tagged link", () => {
    const a = attributionFromVisit(`${SITE}/es/bio?utm_source=instagram&utm_medium=bio`, "", NOW);
    expect(a).toMatchObject({
      source: "instagram",
      medium: "bio",
      campaign: null,
      landingPath: "/es/bio",
      referrerHost: null,
      clickId: null,
      at: NOW,
    });
  });

  it("keeps an external referrer host, never the full URL", () => {
    const a = attributionFromVisit(`${SITE}/es`, "https://l.instagram.com/?u=secret", NOW);
    expect(a?.referrerHost).toBe("l.instagram.com");
  });

  it("records which click id came, not its value", () => {
    const a = attributionFromVisit(`${SITE}/es?fbclid=IwAR123`, "", NOW);
    expect(a?.clickId).toBe("fbclid");
    expect(JSON.stringify(a)).not.toContain("IwAR123");
  });

  it("says nothing for a direct visit or a navigation inside the site", () => {
    expect(attributionFromVisit(`${SITE}/es/reservar`, "", NOW)).toBeNull();
    expect(attributionFromVisit(`${SITE}/es/reservar`, `${SITE}/es/bio`, NOW)).toBeNull();
    // The bare domain redirects to www: still us.
    expect(
      attributionFromVisit(`${SITE}/es`, "https://goldenbeautystudio.com.co/", NOW),
    ).toBeNull();
  });
});

describe("readStoredAttribution", () => {
  it("drops what's expired or malformed", () => {
    const fresh = JSON.stringify({ source: "google", at: NOW - 1000 });
    const old = JSON.stringify({ source: "google", at: NOW - ATTRIBUTION_TTL_MS - 1 });
    expect(readStoredAttribution(fresh, NOW)?.source).toBe("google");
    expect(readStoredAttribution(old, NOW)).toBeNull();
    expect(readStoredAttribution("{nope", NOW)).toBeNull();
    expect(readStoredAttribution(null, NOW)).toBeNull();
  });
});
