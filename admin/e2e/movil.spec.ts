import { expect, test } from "./fixtures";

/**
 * Ergonomía móvil, medida en cada pantalla.
 *
 * **El teléfono es el dispositivo principal del panel**, no el caso degradado.
 * Este archivo existe para que eso siga siendo cierto sin que nadie tenga que
 * acordarse: mide desbordes y objetivos táctiles en las nueve pantallas, con
 * emulación de toque de verdad.
 *
 * ## Por qué mide golpeando y no midiendo cajas
 *
 * Un enlace estirado con `::after` ocupa la fila entera al tacto y su
 * `getBoundingClientRect()` sigue siendo el del texto: 140 × 17. La primera
 * versión de esta auditoría medía cajas y reportaba veintinueve objetivos
 * diminutos en Clientas **después** de haberlos arreglado. Se mide desde el
 * centro hacia arriba y hacia abajo preguntando quién recibe el toque, que es
 * lo que hace un dedo.
 *
 * ## Y con `hasTouch`, no solo con la ventana angosta
 *
 * Las reglas que agrandan los controles son `@media (pointer: coarse)`. Sin
 * emulación de toque no aplican, y la auditoría mediría exactamente la
 * variante que nadie usa en un teléfono. También fue un error de la primera
 * versión.
 */

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 780 } });

const PANTALLAS = [
  "/admin/hoy",
  "/admin/agenda",
  "/admin/caja",
  "/admin/clientes",
  "/admin/comisiones",
  "/admin/servicios",
  "/admin/equipo",
  "/admin/reportes",
  "/admin/diagnostico",
] as const;

/**
 * Cuántos objetivos por debajo del mínimo se toleran, y por qué.
 *
 * La agenda tiene una fila por cada quince minutos: a 24 px de alto una
 * jornada mide 1.150 px y a 44 px mediría 2.100, donde encontrar la tarde
 * cuesta más que errarle a un hueco. **El costo de fallar es recuperable** —
 * se abre el formulario con las 8:15 en vez de las 8:00 y se corrige ahí
 * mismo— así que la densidad gana. Es una excepción con motivo, no una
 * tolerancia general: cualquier otra pantalla tiene que dar cero.
 */
const TOLERADOS: Record<string, number> = { "/admin/agenda": 24 };

type Medida = { desborde: number; chicos: number; detalle: string[] };

test.describe("ergonomía en el teléfono", () => {
  for (const ruta of PANTALLAS) {
    test(`${ruta.replace("/admin/", "")} se puede usar con el dedo`, async ({ panel }) => {
      await panel.goto(ruta);
      await panel.waitForTimeout(700);

      const m: Medida = await panel.evaluate(() => {
        const doc = document.documentElement;

        const alcance = (el: Element, x: number, y: number, dy: number): number => {
          let d = 0;
          for (; d <= 24; d += 2) {
            const hit = document.elementFromPoint(x, y + dy * d);
            if (!hit) break;
            // El indicador de desarrollo de Next flota sobre la página y no
            // existe en producción: contarlo daría un falso positivo en todas.
            if (hit.tagName.startsWith("NEXTJS")) break;
            if (!(hit === el || el.contains(hit) || hit.contains(el))) break;
          }
          return d;
        };

        const detalle: string[] = [];
        let chicos = 0;

        document.querySelectorAll<HTMLElement>("button,a,input,select,textarea").forEach((el) => {
          const b = el.getBoundingClientRect();
          if (b.width <= 0 || b.height <= 0) return;
          const cx = Math.round(b.left + b.width / 2);
          const cy = Math.round(b.top + b.height / 2);
          if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return;
          // Lo que está tapado por otra capa no es un objetivo de esta
          // pantalla: es una hoja cerrada o algo fuera del pliegue.
          const centro = document.elementFromPoint(cx, cy);
          if (!centro || centro.tagName.startsWith("NEXTJS")) return;
          if (!(centro === el || el.contains(centro) || centro.contains(el))) return;

          // **Un enlace dentro de una frase no es un objetivo táctil.** "ve a
          // Hoy" mide 24 px de ancho porque la palabra mide eso, y estirarlo a
          // 32 rompería el renglón para cumplir una regla que no lo cubre —
          // WCAG excluye explícitamente los enlaces en línea dentro de un
          // bloque de texto. Se detecta por lo que es: `display: inline` y un
          // padre que tiene más texto alrededor.
          const enLinea =
            getComputedStyle(el).display === "inline" &&
            (el.parentElement?.textContent?.trim().length ?? 0) >
              (el.textContent?.trim().length ?? 0);
          if (enLinea) return;

          const alto = alcance(el, cx, cy, -1) + alcance(el, cx, cy, 1);
          if (alto < 40 || b.width < 32) {
            chicos += 1;
            if (detalle.length < 5) {
              const clase = (el.className || "").toString().split(" ")[0].slice(0, 30);
              detalle.push(`${el.tagName.toLowerCase()}.${clase} ${Math.round(b.width)}×${alto}`);
            }
          }
        });

        return { desborde: doc.scrollWidth - doc.clientWidth, chicos, detalle };
      });

      // **Nada desborda la página.** Una tabla ancha scrollea dentro de su
      // caja; lo que no puede pasar es que el cuerpo entero se mueva de lado,
      // porque entonces la navegación y los botones se van de la pantalla.
      expect(m.desborde, `${ruta} desborda ${m.desborde}px a lo ancho`).toBe(0);

      expect(
        m.chicos,
        `${ruta} tiene ${m.chicos} objetivos por debajo de 40px: ${m.detalle.join(" · ")}`,
      ).toBeLessThanOrEqual(TOLERADOS[ruta] ?? 0);
    });
  }
});
