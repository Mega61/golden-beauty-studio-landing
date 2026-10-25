import { elegirOpcion, expect, test } from "./fixtures";

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
          // Tampoco lo que está **a medias** debajo de una capa fija —la barra
          // de pestañas de abajo—: su centro asoma, pero medirlo daría la mitad
          // de su alto. Al hacer scroll queda entero, y ahí sí se mide. Sin
          // esto, cuántas citas hay en el día decidía si la prueba pasaba.
          const tapado = (y: number) => {
            const hit = document.elementFromPoint(cx, y);
            return hit !== null && !(hit === el || el.contains(hit) || hit.contains(el));
          };
          if (tapado(Math.round(b.top + 2)) || tapado(Math.round(b.bottom - 2))) {
            const capa = (y: number) => {
              let n: Element | null = document.elementFromPoint(cx, y);
              for (; n; n = n.parentElement) {
                if (getComputedStyle(n).position === "fixed" || getComputedStyle(n).position === "sticky") return true;
              }
              return false;
            };
            if (capa(Math.round(b.top + 2)) || capa(Math.round(b.bottom - 2))) return;
          }

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

test.describe("nueva cita en el teléfono", () => {
  // En el celular un `<select>` abre la rueda del sistema, que no deja buscar:
  // con veinte servicios, encontrar uno era girar a ciegas. El formulario usa
  // los selectores propios del panel (`components/ui/Pickers.tsx`), iguales en
  // todos los teléfonos.
  test("el servicio se busca escribiendo, sin selectores del sistema", async ({ panel }) => {
    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    const servicio = panel.getByRole("combobox", { name: /^Servicio/ });
    await expect(servicio).toBeVisible();

    const nativos = panel.locator(
      'form select, form input[type="date"], form input[type="time"]',
    );
    await expect(nativos, "quedó un selector nativo en el formulario").toHaveCount(0);

    await servicio.click();
    const busqueda = panel.getByPlaceholder(/^Busca:/);
    await expect(busqueda, "la búsqueda no recibió el foco").toBeFocused();

    const opciones = panel.getByRole("listbox").getByRole("option");
    const total = await opciones.count();
    expect(total, "EA no ofreció ningún servicio").toBeGreaterThan(0);

    // Lo que se busca: las primeras letras del primer servicio, sin tildes ni
    // mayúsculas. Así no depende del catálogo de cada base.
    const primero = (await opciones.first().locator(".ui-picker__body > span").first().textContent()) ?? "";
    const termino = primero.normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 4).toLowerCase();
    await busqueda.fill(termino);
    await expect(opciones.first()).toBeVisible();
    expect(await opciones.count()).toBeLessThanOrEqual(total);

    await busqueda.fill("zzzz-no-existe");
    await expect(opciones).toHaveCount(0);
    await expect(panel.getByText("Ningún servicio se llama así.")).toBeVisible();

    await busqueda.fill(termino);
    await opciones.first().click();
    await expect(servicio).toHaveAttribute("data-value", /\d+/);
  });

  test("la fecha y la hora no desbordan la pantalla", async ({ panel }) => {
    await panel.goto("/admin/agenda");
    await panel.getByRole("button", { name: /nueva cita/i }).click();

    const anchoSinScroll = () =>
      panel.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    await panel.getByLabel(/^Fecha/).click();
    await expect(panel.getByRole("dialog", { name: "Elegir fecha" })).toBeVisible();
    expect(await anchoSinScroll(), "el calendario empuja la página de lado").toBeLessThanOrEqual(0);
    await panel.getByRole("button", { name: "Mes siguiente" }).click();
    await panel.getByLabel(/^Fecha/).click();

    await elegirOpcion(panel.getByRole("combobox", { name: /^Profesional/ }), { index: 0 });
    await panel.getByLabel(/^Empieza/).click();
    await panel.getByPlaceholder(/^Escribe la hora/).fill("2 pm");
    await panel.getByPlaceholder(/^Escribe la hora/).press("Enter");
    await expect(panel.getByLabel(/^Empieza/)).toHaveAttribute("data-value", "14:00");
    expect(await anchoSinScroll()).toBeLessThanOrEqual(0);
  });
});
