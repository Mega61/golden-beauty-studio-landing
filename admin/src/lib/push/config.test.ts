import { describe, expect, it } from "vitest";

import nextConfig from "../../../next.config";
import manifest from "../../app/manifest";
import { PANEL_BASE_PATH, parseVapidEnv } from "./config";

// Llaves con la forma real (87 y 43 caracteres base64url); no son de nadie.
const PUB = `B${"a".repeat(86)}`;
const PRIV = "c".repeat(43);
const OK = { VAPID_PUBLIC_KEY: PUB, VAPID_PRIVATE_KEY: PRIV, VAPID_SUBJECT: "mailto:hola@goldenbeautystudio.com.co" };

describe("parseVapidEnv", () => {
  it("con las tres variables bien formadas, prende la función", () => {
    expect(parseVapidEnv(OK)).toEqual({
      publicKey: PUB,
      privateKey: PRIV,
      subject: "mailto:hola@goldenbeautystudio.com.co",
    });
  });

  it("acepta un subject https y recorta espacios", () => {
    expect(parseVapidEnv({ ...OK, VAPID_SUBJECT: " https://goldenbeautystudio.com.co " })?.subject).toBe(
      "https://goldenbeautystudio.com.co",
    );
  });

  it("sin alguna de las tres, la función queda apagada sin lanzar", () => {
    expect(parseVapidEnv({})).toBeNull();
    expect(parseVapidEnv({ ...OK, VAPID_PUBLIC_KEY: undefined })).toBeNull();
    expect(parseVapidEnv({ ...OK, VAPID_PRIVATE_KEY: "" })).toBeNull();
    expect(parseVapidEnv({ ...OK, VAPID_SUBJECT: undefined })).toBeNull();
  });

  it("una llave pegada con comillas, cortada o con otro alfabeto se rechaza", () => {
    expect(parseVapidEnv({ ...OK, VAPID_PUBLIC_KEY: `"${PUB}"` })).toBeNull();
    expect(parseVapidEnv({ ...OK, VAPID_PUBLIC_KEY: PUB.slice(1) })).toBeNull();
    expect(parseVapidEnv({ ...OK, VAPID_PRIVATE_KEY: `${PRIV.slice(1)}+` })).toBeNull();
  });

  it("un subject que no es mailto: ni https: se rechaza", () => {
    for (const subject of ["hola@goldenbeautystudio.com.co", "http://x.co", "mailto:", "mailto:sin-arroba"]) {
      expect(parseVapidEnv({ ...OK, VAPID_SUBJECT: subject }), subject).toBeNull();
    }
  });
});

describe("el panel bajo /admin", () => {
  it("PANEL_BASE_PATH es el basePath real de next.config.ts", () => {
    // Si alguien mueve el panel de ruta y olvida esta constante, el manifest,
    // el registro del worker y el enlace de cada aviso apuntarían a la landing.
    expect(PANEL_BASE_PATH).toBe(nextConfig.basePath);
  });

  it("el manifest abre y se queda dentro de /admin", () => {
    const m = manifest();
    expect(m.scope).toBe("/admin/");
    expect(m.start_url).toBe("/admin/hoy");
    expect(m.id).toBe("/admin/");
    expect(m.display).toBe("standalone");
    for (const icon of m.icons ?? []) expect(icon.src.startsWith("/admin/icons/"), icon.src).toBe(true);
    expect(m.icons?.some((i) => i.purpose === "maskable")).toBe(true);
    expect(m.icons?.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  });
});
