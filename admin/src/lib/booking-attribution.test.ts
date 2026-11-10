import { describe, expect, it } from "vitest";

import { channelOf, parseAttribution, type BookingAttribution } from "./booking-attribution";

function attr(partial: Partial<BookingAttribution>): BookingAttribution {
  return {
    source: null,
    medium: null,
    campaign: null,
    content: null,
    referrerHost: null,
    landingPath: null,
    clickId: null,
    ...partial,
  };
}

describe("parseAttribution — lo escribe cualquiera con curl", () => {
  it("nada útil = null", () => {
    expect(parseAttribution(null)).toBeNull();
    expect(parseAttribution("instagram")).toBeNull();
    expect(parseAttribution([])).toBeNull();
    expect(parseAttribution({})).toBeNull();
    expect(parseAttribution({ source: "   ", medium: 3 })).toBeNull();
  });

  it("baja a minúsculas, recorta y corta lo largo", () => {
    const parsed = parseAttribution({ source: "  Instagram ", medium: "BIO", campaign: "x".repeat(300) });
    expect(parsed?.source).toBe("instagram");
    expect(parsed?.medium).toBe("bio");
    expect(parsed?.campaign).toHaveLength(100);
  });

  it("el referente es un host, nunca una URL", () => {
    expect(parseAttribution({ referrerHost: "l.instagram.com" })?.referrerHost).toBe("l.instagram.com");
    expect(parseAttribution({ referrerHost: "https://evil.com/?q=1", source: "x" })?.referrerHost).toBeNull();
  });

  it("el click id solo si es uno conocido, y el path solo si es un path", () => {
    expect(parseAttribution({ clickId: "FBCLID" })?.clickId).toBe("fbclid");
    expect(parseAttribution({ clickId: "abc123", source: "x" })?.clickId).toBeNull();
    expect(parseAttribution({ landingPath: "/es/bio" })?.landingPath).toBe("/es/bio");
    expect(parseAttribution({ landingPath: "javascript:1", source: "x" })?.landingPath).toBeNull();
  });
});

describe("channelOf — de dónde llegó", () => {
  it("sin datos es directo", () => {
    expect(channelOf(null)).toBe("directo");
  });

  it("los links que se etiquetaron a mano", () => {
    expect(channelOf(attr({ source: "instagram", medium: "bio" }))).toBe("instagram");
    expect(channelOf(attr({ source: "ig", medium: "story" }))).toBe("instagram");
    expect(channelOf(attr({ source: "google", medium: "maps" }))).toBe("google-maps");
    expect(channelOf(attr({ source: "google", medium: "maps_reservar" }))).toBe("google-maps");
    expect(channelOf(attr({ source: "gbp" }))).toBe("google-maps");
    expect(channelOf(attr({ source: "whatsapp", medium: "estado" }))).toBe("whatsapp");
    expect(channelOf(attr({ source: "volante" }))).toBe("otro");
  });

  it("la pauta gana sobre la fuente", () => {
    expect(channelOf(attr({ source: "meta", medium: "paid" }))).toBe("pauta-meta");
    expect(channelOf(attr({ source: "instagram", medium: "cpc" }))).toBe("pauta-meta");
    expect(channelOf(attr({ source: "google", medium: "cpc" }))).toBe("pauta-google");
    expect(channelOf(attr({ clickId: "gclid", referrerHost: "google.com" }))).toBe("pauta-google");
  });

  it("un fbclid solo no es pauta: Meta lo pega a todos los links", () => {
    expect(channelOf(attr({ clickId: "fbclid" }))).toBe("meta");
    expect(channelOf(attr({ clickId: "fbclid", referrerHost: "l.instagram.com" }))).toBe("instagram");
    expect(channelOf(attr({ clickId: "fbclid", source: "instagram", medium: "bio" }))).toBe("instagram");
  });

  it("sin UTM, el dominio que refirió", () => {
    expect(channelOf(attr({ referrerHost: "l.instagram.com" }))).toBe("instagram");
    expect(channelOf(attr({ referrerHost: "lm.facebook.com" }))).toBe("facebook");
    expect(channelOf(attr({ referrerHost: "www.google.com.co" }))).toBe("google");
    expect(channelOf(attr({ referrerHost: "maps.google.com" }))).toBe("google-maps");
    expect(channelOf(attr({ referrerHost: "www.tiktok.com" }))).toBe("tiktok");
    expect(channelOf(attr({ referrerHost: "notgoogle.com" }))).toBe("otro");
  });
});
