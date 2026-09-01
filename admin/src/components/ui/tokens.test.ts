import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";

/**
 * Los pisos de contraste del sistema, medidos.
 *
 * El plan pide números, no impresiones: 4.5:1 en cuerpo y placeholders, y foco
 * visible a ≥3:1 **contra marfil y contra crema**. Este archivo los verifica y,
 * además, lee `globals.css` para comprobar que los hex del CSS son los que se
 * están midiendo — un test que verifica una constante duplicada en TypeScript
 * no prueba nada sobre lo que ve la usuaria.
 */

const CSS = readFileSync(
  fileURLToPath(new URL("../../app/globals.css", import.meta.url)),
  "utf8",
);

/**
 * El CSS sin comentarios. Las reglas de más abajo buscan patrones prohibidos
 * (`clamp(`, una franja lateral gruesa) y este archivo los **nombra** en sus
 * comentarios para explicar por qué están prohibidos. Sin este filtro, la
 * explicación haría fallar la regla que explica.
 */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** Lee un token `--nombre: #hex;` del bloque `@theme` de `globals.css`. */
function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(CSS);
  if (!m) throw new Error(`No está el token --${name} en globals.css`);
  return m[1].toLowerCase();
}

const paper = () => token("color-paper");
const ivory = () => token("color-ivory");
const cream = () => token("color-cream");
const ivoryDeep = () => token("color-ivory-deep");

describe("superficies", () => {
  it("son las cuatro de la landing, sin reinventar", () => {
    expect(paper()).toBe("#fbf8f3");
    expect(ivory()).toBe("#f8f4ee");
    expect(cream()).toBe("#f3ecdf");
    expect(ivoryDeep()).toBe("#efe7da");
  });
});

describe("texto de cuerpo", () => {
  const surfaces = () => [
    ["paper", paper()],
    ["ivory", ivory()],
    ["cream", cream()],
    ["ivory-deep", ivoryDeep()],
  ] as const;

  it("`ink` y `carbon` pasan 4.5:1 en las cuatro superficies", () => {
    for (const [name, bg] of surfaces()) {
      expect(contrastRatio(token("color-ink"), bg), `ink/${name}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(token("color-carbon"), bg), `carbon/${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("`ink-soft` pasa 4.5:1 — es el tono de labels, hints y placeholders", () => {
    for (const [name, bg] of surfaces()) {
      expect(
        contrastRatio(token("color-ink-soft"), bg),
        `ink-soft/${name}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("`ink-mute` NO llega a 4.5:1, y por eso no sirve para texto", () => {
    // Es la advertencia del plan convertida en test. Si algún día alguien lo
    // aclara hasta que pase, este test se cae y obliga a decidir a propósito.
    expect(contrastRatio(token("color-ink-mute"), paper())).toBeLessThan(4.5);
    expect(contrastRatio(token("color-ink-mute"), cream())).toBeLessThan(4.5);
    // Sí alcanza para un icono decorativo o un filete (3:1).
    expect(contrastRatio(token("color-ink-mute"), cream())).toBeGreaterThanOrEqual(3);
  });
});

describe("dorado", () => {
  it("el `gold` de marca NO llega a 3:1 sobre crema", () => {
    // Este es el hallazgo que obliga a que el anillo de foco y el relleno
    // primario usen `gold-dark`. Queda fijado para que nadie los "corrija" al
    // dorado de marca sin darse cuenta de lo que rompe.
    expect(contrastRatio(token("color-gold"), cream())).toBeLessThan(3);
  });

  it("el anillo de foco (`gold-dark`) pasa 3:1 sobre marfil y sobre crema", () => {
    const ring = token("color-gold-dark");
    expect(contrastRatio(ring, ivory())).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(ring, cream())).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(ring, paper())).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(ring, ivoryDeep())).toBeGreaterThanOrEqual(3);
  });

  it("el texto blanco del botón primario pasa 4.5:1 sobre su relleno", () => {
    expect(contrastRatio("#ffffff", token("color-gold-dark"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ffffff", token("color-gold-press"))).toBeGreaterThanOrEqual(4.5);
  });

  it("la fila seleccionada sigue siendo legible", () => {
    const pale = token("color-gold-pale");
    expect(contrastRatio(token("color-ink"), pale)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token("color-gold-deep"), pale)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("retroalimentación del sistema", () => {
  it.each(["ok", "warn", "error", "info"])(
    "la tinta de `%s` pasa 4.5:1 sobre su tinte y sobre marfil",
    (role) => {
      const ink = token(`color-${role}-ink`);
      const tint = token(`color-${role}-tint`);
      expect(contrastRatio(ink, tint), `${role} ink/tint`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ink, paper()), `${role} ink/paper`).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe("reglas del sistema que se pueden leer del CSS", () => {
  it("la escala tipográfica es fija: seis pasos y nada de clamp()", () => {
    expect(CSS).toContain("--text-*: initial;");
    for (const step of ["2xs", "xs", "sm", "md", "lg", "xl"]) {
      expect(CSS).toMatch(new RegExp(`--text-${step}:\\s*[\\d.]+rem;`));
    }
    expect(RULES).not.toContain("clamp(");
  });

  it("la paleta es cerrada: la de Tailwind se borra antes de declarar la nuestra", () => {
    expect(CSS).toContain("--color-*: initial;");
  });

  it("`tabular-nums` está en la base, no suelto por ahí", () => {
    expect(CSS).toContain("font-variant-numeric: tabular-nums;");
  });

  it("`prefers-reduced-motion` está y apaga las transiciones", () => {
    expect(CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(CSS).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  it("no hay franja lateral gruesa en ninguna parte", () => {
    // El patrón prohibido del plan: un borde lateral de color y grosor sobre
    // una tarjeta, un ítem de lista o una alerta. Se permite exactamente 1 px
    // —que es un filete, no una franja— y `0`.
    const offenders = [
      ...RULES.matchAll(
        /border-(?:left|right|inline-start|inline-end)(?:-width)?:\s*([^;]+);/g,
      ),
    ]
      .map((m) => m[1].trim())
      .filter((v) => !/^(0|1px\b)/.test(v));
    expect(offenders).toEqual([]);
  });

  it("el movimiento vive en la banda de 150–250 ms", () => {
    const durations = [...CSS.matchAll(/--dur-\d:\s*(\d+)ms/g)].map((m) => +m[1]);
    expect(durations.length).toBeGreaterThan(0);
    for (const d of durations) {
      expect(d).toBeGreaterThanOrEqual(150);
      expect(d).toBeLessThanOrEqual(250);
    }
  });

  it("la barra inferior respeta el área segura", () => {
    expect(CSS).toContain("env(safe-area-inset-bottom");
  });

  it("las áreas táctiles arrancan en 44 px", () => {
    expect(CSS).toMatch(/--hit:\s*44px/);
    expect(CSS).toMatch(/--control-h:\s*44px/);
  });

  it("la página no scrollea de lado", () => {
    expect(CSS).toMatch(/overflow-x:\s*hidden/);
  });
});
