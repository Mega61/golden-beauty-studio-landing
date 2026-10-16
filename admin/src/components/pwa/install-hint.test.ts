import { describe, expect, it } from "vitest";

import { installHintMode, isIos, type InstallSignals } from "./install-hint";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const base: InstallSignals = {
  userAgent: ANDROID,
  maxTouchPoints: 5,
  standalone: false,
  mobile: true,
  dismissed: false,
  hasPrompt: true,
};

describe("isIos", () => {
  it("reconoce al iPad que se anuncia como Mac por la pantalla táctil", () => {
    expect(isIos(IPHONE, 5)).toBe(true);
    expect(isIos(IPAD_AS_MAC, 5)).toBe(true);
    expect(isIos(IPAD_AS_MAC, 0)).toBe(false);
    expect(isIos(ANDROID, 5)).toBe(false);
  });
});

describe("installHintMode", () => {
  it("Android con el evento de instalación, en celular: botón", () => {
    expect(installHintMode(base)).toBe("android");
  });

  it("iPhone: instrucciones, aunque no haya evento (Safari no lo tiene)", () => {
    expect(installHintMode({ ...base, userAgent: IPHONE, hasPrompt: false })).toBe("ios");
  });

  it("ya instalada o ya cerrada: nunca", () => {
    expect(installHintMode({ ...base, standalone: true })).toBeNull();
    expect(installHintMode({ ...base, dismissed: true })).toBeNull();
    expect(installHintMode({ ...base, userAgent: IPHONE, standalone: true })).toBeNull();
    expect(installHintMode({ ...base, userAgent: IPHONE, dismissed: true })).toBeNull();
  });

  it("Android sin el evento no promete un botón que no funciona", () => {
    expect(installHintMode({ ...base, hasPrompt: false })).toBeNull();
  });

  it("en el computador no aparece, aunque Chrome ofrezca instalar", () => {
    expect(installHintMode({ ...base, userAgent: DESKTOP, mobile: false, maxTouchPoints: 0 })).toBeNull();
  });
});
