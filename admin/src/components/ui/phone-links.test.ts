import { describe, expect, it } from "vitest";

import { chatGreeting, phoneLinks } from "./phone-links";

describe("chatGreeting", () => {
  it("saluda por el primer nombre, presentable", () => {
    expect(chatGreeting("LAURA MARCELA PÉREZ")).toBe("¡Hola, Laura! ✨");
    expect(chatGreeting("ana")).toBe("¡Hola, Ana! ✨");
  });

  it("sin nombre sigue siendo un saludo", () => {
    for (const name of [null, undefined, "", "   "]) {
      expect(chatGreeting(name)).toBe("¡Hola! ✨");
    }
  });
});

describe("phoneLinks", () => {
  it("normaliza lo que tecleó recepción antes de armar los enlaces", () => {
    const links = phoneLinks("300 123 4567", "Laura Pérez");
    expect(links).not.toBeNull();
    expect(links?.e164).toBe("+573001234567");
    expect(links?.display).toBe("+57 300 123 4567");
    expect(links?.tel).toBe("tel:+573001234567");

    const url = new URL(links?.whatsapp as string);
    expect(url.host).toBe("api.whatsapp.com");
    // Los dígitos van sin el +.
    expect(url.searchParams.get("phone")).toBe("573001234567");
    expect(url.searchParams.get("text")).toBe("¡Hola, Laura! ✨");
  });

  it.each([
    ["3001234567", "/573001234567"],
    ["+57 300 123 4567", "/573001234567"],
    ["(300) 123-4567", "/573001234567"],
    ["0057 3001234567", "/573001234567"],
    ["+1 305 555 0123", "/13055550123"],
  ])("%j → wa.me%s", (raw, path) => {
    expect(new URL(phoneLinks(raw)?.whatsapp as string).searchParams.get("phone")).toBe(path.slice(1));
  });

  it("un número de otro país se pinta tal cual, sin forzarle el formato colombiano", () => {
    expect(phoneLinks("+1 305 555 0123")?.display).toBe("+13055550123");
  });

  it.each([null, undefined, "", "   ", "N/A", "sin teléfono", "1234", "300 123 456", "03001234567"])(
    "sin enlace para lo que no es un número: %j",
    (raw) => {
      expect(phoneLinks(raw)).toBeNull();
    },
  );
});
