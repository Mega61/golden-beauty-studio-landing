import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `site.ts` reads the environment at module scope, so every case needs a fresh
 * module registry rather than a re-invocation. `vi.resetModules()` + dynamic
 * import gives each test its own evaluation of the file.
 */
const snapshot = { ...process.env };

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("./site");
}

afterEach(() => {
  process.env = { ...snapshot };
});

describe("section flags", () => {
  it("defaults to on when the variable is unset", async () => {
    const { siteConfig } = await loadConfig({
      NEXT_PUBLIC_SECTION_LOOKBOOK: undefined,
    });
    expect(siteConfig.sections.lookbook).toBe(true);
  });

  it("defaults to on for an empty or whitespace value", async () => {
    const { siteConfig } = await loadConfig({
      NEXT_PUBLIC_SECTION_LOOKBOOK: "   ",
    });
    expect(siteConfig.sections.lookbook).toBe(true);
  });

  it.each(["false", "0", "off", "FALSE", "  Off  "])(
    "reads %s as off",
    async (value) => {
      const { siteConfig } = await loadConfig({
        NEXT_PUBLIC_SECTION_LOOKBOOK: value,
      });
      expect(siteConfig.sections.lookbook).toBe(false);
    },
  );

  it.each(["true", "1", "on", "TRUE"])("reads %s as on", async (value) => {
    const { siteConfig } = await loadConfig({
      NEXT_PUBLIC_SECTION_LOOKBOOK: value,
    });
    expect(siteConfig.sections.lookbook).toBe(true);
  });

  /**
   * Documented quirk worth pinning: the parser is an allowlist, not a
   * truthiness check. Anything that is neither an on-token nor an off-token
   * reads as OFF — so a typo like "yes" silently hides a section rather than
   * showing it. Changing this is a behaviour change, and this test says so.
   */
  it("reads an unrecognised value as off, not as on", async () => {
    const { siteConfig } = await loadConfig({
      NEXT_PUBLIC_SECTION_LOOKBOOK: "yes",
    });
    expect(siteConfig.sections.lookbook).toBe(false);
  });
});

describe("hiring announcement", () => {
  it("is on by default", async () => {
    const { siteConfig } = await loadConfig({
      NEXT_PUBLIC_SECTION_TRABAJA: undefined,
      NEXT_PUBLIC_HIRING_BANNER: undefined,
    });
    expect(siteConfig.hiringBanner).toBe(true);
  });

  it("can be switched off on its own, leaving the form up", async () => {
    const { siteConfig } = await loadConfig({
      NEXT_PUBLIC_SECTION_TRABAJA: "true",
      NEXT_PUBLIC_HIRING_BANNER: "false",
    });
    expect(siteConfig.hiringBanner).toBe(false);
    expect(siteConfig.sections.trabaja).toBe(true);
  });

  /**
   * The invariant AGENTS.md states in words: the announcement can never outlive
   * the form it points at. Careers off must force the announcement off even
   * when its own flag says on — otherwise the /bio carousel advertises a form
   * that no longer renders.
   */
  it("cannot outlive the careers form it points at", async () => {
    const { siteConfig } = await loadConfig({
      NEXT_PUBLIC_SECTION_TRABAJA: "false",
      NEXT_PUBLIC_HIRING_BANNER: "true",
    });
    expect(siteConfig.sections.trabaja).toBe(false);
    expect(siteConfig.hiringBanner).toBe(false);
  });
});

describe("telephone (E.164)", () => {
  it("prepends the Colombian calling code to a bare mobile", async () => {
    const { business } = await loadConfig({
      NEXT_PUBLIC_WHATSAPP_NUMBER: "3001234567",
    });
    expect(business.telephone).toBe("+573001234567");
  });

  it("does not double-prefix a number that already carries 57", async () => {
    const { business } = await loadConfig({
      NEXT_PUBLIC_WHATSAPP_NUMBER: "573001234567",
    });
    expect(business.telephone).toBe("+573001234567");
  });

  it("strips separators before building the number", async () => {
    const { business } = await loadConfig({
      NEXT_PUBLIC_WHATSAPP_NUMBER: "300 123 4567",
    });
    expect(business.telephone).toBe("+573001234567");
  });

  // Emitting a fabricated phone number in JSON-LD is worse than emitting none.
  it("is null when no number is configured", async () => {
    const { business } = await loadConfig({
      NEXT_PUBLIC_WHATSAPP_NUMBER: undefined,
    });
    expect(business.telephone).toBeNull();
  });
});

describe("derived URLs", () => {
  it("strips trailing slashes from the site URL", async () => {
    const { siteConfig } = await loadConfig({
      NEXT_PUBLIC_SITE_URL: "https://goldenbeautystudio.com.co///",
    });
    expect(siteConfig.siteUrl).toBe("https://goldenbeautystudio.com.co");
  });

  it("builds a WhatsApp deep link with the greeting encoded", async () => {
    const { siteConfig } = await loadConfig({
      NEXT_PUBLIC_WHATSAPP_NUMBER: "3001234567",
      NEXT_PUBLIC_WHATSAPP_GREETING: "Hola Golden, quiero info",
    });
    expect(siteConfig.whatsappUrl).toBe(
      "https://wa.me/3001234567?text=Hola%20Golden%2C%20quiero%20info",
    );
  });

  it("hides the WhatsApp CTA entirely when no number is set", async () => {
    const { siteConfig } = await loadConfig({
      NEXT_PUBLIC_WHATSAPP_NUMBER: undefined,
    });
    expect(siteConfig.whatsappUrl).toBeNull();
  });

  it("emits no map embed without an API key", async () => {
    const { siteConfig } = await loadConfig({
      NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: undefined,
      NEXT_PUBLIC_GOOGLE_MAPS_QUERY: "Sabaneta",
    });
    expect(siteConfig.mapsEmbedUrl).toBeNull();
  });

  it("prefers the place id over the free-text query", async () => {
    const { siteConfig } = await loadConfig({
      NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "key123",
      NEXT_PUBLIC_GOOGLE_MAPS_QUERY: "Sabaneta",
      NEXT_PUBLIC_GOOGLE_MAPS_PLACE_ID: "ChIJtest",
    });
    expect(siteConfig.mapsEmbedUrl).toContain("place_id%3AChIJtest");
    expect(siteConfig.mapsEmbedUrl).not.toContain("Sabaneta");
  });
});
