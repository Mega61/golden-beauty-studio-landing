import { describe, expect, it } from "vitest";

import { confirmationIntent } from "./booking-confirmation";

describe("confirmationIntent", () => {
  const base = { configured: true, phoneE164: "+573001234567", optedOut: false };

  it("con todo en orden, la confirmación se intenta", () => {
    expect(confirmationIntent(base)).toBe("sending");
  });

  it("sin configuración de Meta, la pantalla no promete nada", () => {
    expect(confirmationIntent({ ...base, configured: false })).toBe("disabled");
  });

  it("sin número utilizable, tampoco", () => {
    expect(confirmationIntent({ ...base, phoneE164: null })).toBe("disabled");
  });

  it("un número dado de baja no recibe confirmación", () => {
    expect(confirmationIntent({ ...base, optedOut: true })).toBe("disabled");
  });

  it("si no se pudo consultar la baja, no se intenta (sin base no hay fila)", () => {
    expect(confirmationIntent({ ...base, optedOut: null })).toBe("disabled");
  });
});
