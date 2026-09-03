/**
 * La geometría de los gráficos: escalas, marcas de eje y trazo de sparkline.
 *
 * Vive fuera de los componentes y con tests por la misma razón por la que el
 * cálculo de plata vive en `lib/`: un eje que redondea mal o una barra que se
 * sale del área de dibujo son bugs con una respuesta correcta, y una respuesta
 * correcta se fija con un test en vez de mirando la pantalla y diciendo "así
 * está bien".
 *
 * ## Por qué los gráficos son HTML y CSS, y no SVG
 *
 * Las cuatro formas que este paquete necesita —barra horizontal, barra apilada,
 * mapa de calor y sparkline— salen de HTML en las tres primeras:
 *
 * - **Se hacen responsive gratis.** Un `width: 42%` se re-mide en cada
 *   repintado; un SVG con `viewBox` escala el texto junto con las barras y a
 *   390 px las etiquetas quedan de 7 px. El contrato responsive de este panel
 *   pide 390 / 768 / 1440 sin scroll horizontal, y eso en CSS es una línea.
 * - **Desaparece el problema de medir texto.** En el servidor no hay
 *   `measureText()`, así que decidir en SVG si una etiqueta cabe adentro de una
 *   barra obliga a estimar el ancho — y una estimación equivocada recorta la
 *   etiqueta, que es un anti-patrón explícito. En CSS la etiqueta va afuera del
 *   extremo y el navegador la coloca bien siempre.
 * - **Los especímenes de `dataviz` son propiedades de CSS.** Grosor topado en
 *   24 px, extremo de dato redondeado en 4 px y cuadrado en la línea base,
 *   separador de 2 px en color de superficie entre rellenos que se tocan: son
 *   `max-height`, `border-radius` y `gap`. En SVG cada una es aritmética.
 *
 * La sparkline sí es SVG: es un trazo, y un trazo es un `path`. De ahí que este
 * archivo tenga escala y marcas de eje (que el CSS necesita como porcentajes y
 * como texto) y el trazo de la polilínea, y nada más.
 */

/** Los especímenes fijos de marca que manda `dataviz`. En px. */
export const MARK = {
  /** Grosor máximo de una barra. **Se topa**: el sobrante de la banda es aire. */
  barMax: 24,
  /** Radio del extremo de dato. El extremo de la línea base va cuadrado. */
  barRadius: 4,
  /** Grosor de una línea de serie. */
  line: 2,
  /** Diámetro mínimo de un marcador. */
  marker: 8,
  /** El separador: 2 px del color de la superficie entre rellenos que se tocan. */
  gap: 2,
  /** Piso del área de toque / de hover, aunque la marca sea más fina. */
  hit: 24,
} as const;

// ── Escala lineal ───────────────────────────────────────────────────────────

export type LinearScale = {
  /** Dominio `[0, max]`. Las barras crecen desde una sola línea base. */
  max: number;
  /** Tamaño del rango. En estos gráficos es 100: el CSS quiere porcentajes. */
  size: number;
  /** Valor → posición en el rango. */
  (value: number): number;
};

/**
 * Escala de `[0, max]` a `[0, size]`.
 *
 * Con `max = 0` devuelve siempre 0 en vez de `NaN`: un periodo sin datos es
 * normal en un estudio de dos técnicas —un mes recién arrancado, una quincena
 * en curso— y un `NaN` en un `width` de CSS deja la barra con el ancho del
 * contenedor, que es lo contrario de lo que el dato dice.
 */
export function linearScale(max: number, size = 100): LinearScale {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  const scale = ((value: number) => {
    if (safeMax === 0 || !Number.isFinite(value)) return 0;
    return (Math.max(0, value) / safeMax) * size;
  }) as LinearScale;
  scale.max = safeMax;
  scale.size = size;
  return scale;
}

// ── Marcas de eje ───────────────────────────────────────────────────────────

/**
 * Marcas de eje en números redondos.
 *
 * "Redondos" es 1, 2, 2.5 o 5 por la potencia de diez que corresponda — la
 * escala de pasos habitual. Un eje que dice `0 · 173.400 · 346.800` es
 * técnicamente correcto y no se puede leer; las marcas cargan los valores que
 * uno **no** etiquetó directamente, así que si no son redondas no cargan nada.
 *
 * Devuelve al menos `[0]`, y el tope de las marcas es ≥ `max` para que ninguna
 * barra se salga del área de dibujo.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];

  const rawStep = max / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const stepFactor =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = stepFactor * magnitude;

  const ticks: number[] = [];
  for (let value = 0; value < max + step; value += step) {
    // El acumulador en punto flotante deriva (0.1 + 0.2). Se redondea a la
    // precisión del paso para que la etiqueta diga `300.000` y no
    // `299.999,9999999`.
    ticks.push(Number((Math.round(value / step) * step).toPrecision(12)));
    if (ticks.length > 24) break;
  }
  return ticks;
}

/** El tope del eje: la última marca. Es lo que hay que pasarle a `linearScale`. */
export function axisMax(max: number, count = 4): number {
  const ticks = niceTicks(max, count);
  return ticks[ticks.length - 1] ?? 0;
}

// ── Sparkline ───────────────────────────────────────────────────────────────

/**
 * El `d` de una polilínea normalizada a la caja `[0,w] × [0,h]`.
 *
 * Sin ejes y sin marcas: una sparkline es forma, no lectura precisa. El valor
 * exacto lo carga la cifra del tile que la acompaña.
 *
 * Con menos de dos puntos devuelve `null`: dos puntos son el mínimo para que
 * haya una tendencia, y un punto solo dibujado como línea plana afirmaría una
 * estabilidad que nadie midió.
 *
 * **La escala es la del propio dato, no `[0, max]`.** Es el comportamiento
 * clásico de la sparkline y tiene su costo: una serie `100 · 101 · 100` se
 * dibuja como una cordillera. Se acepta porque el nivel lo carga la cifra del
 * tile —que va al lado, en grande— y lo que la sparkline aporta es la forma;
 * ancladas en cero, doce meses de ingreso parecido serían doce líneas planas
 * indistinguibles y la sparkline no aportaría nada. Una serie constante sí sale
 * plana, al medio, porque "no cambió" es justo lo que pasó.
 */
export function sparklinePath(
  values: readonly number[],
  width: number,
  height: number,
): string | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2 || width <= 0 || height <= 0) return null;

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;
  const stepX = width / (finite.length - 1);

  return finite
    .map((value, index) => {
      const x = stepX * index;
      // Aire arriba y abajo para que el trazo de 2 px no se coma su propio
      // borde en el extremo de la caja.
      const t = span === 0 ? 0.5 : (value - min) / span;
      const y = height - MARK.line / 2 - t * (height - MARK.line);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

// ── Porcentajes ─────────────────────────────────────────────────────────────

/**
 * Una tasa `[0,1]` como porcentaje, o el texto de "no se puede medir".
 *
 * `null` **no es cero** en ninguna de las métricas de `lib/metrics.ts`, y esta
 * función es el único lugar donde se decide cómo se escribe esa diferencia. La
 * ocupación de un domingo cerrado y la retención de una cohorte cuya ventana no
 * venció salen las dos `null`, y las dos tienen que leerse como "todavía no se
 * puede medir" y no como un 0 % que alguien vaya a tomar por un dato.
 */
export const NOT_MEASURABLE = "todavía no se puede medir";

export function formatRate(rate: number | null, decimals = 0): string {
  if (rate === null || !Number.isFinite(rate)) return NOT_MEASURABLE;
  return `${(rate * 100).toFixed(decimals)} %`;
}

/**
 * El delta contra el periodo anterior, ya rotulado.
 *
 * `null` cuando no hay periodo anterior con qué comparar, o cuando el anterior
 * fue cero: "subió infinito por ciento" no es información. La dirección va
 * aparte del texto para que el tile decida el color con la regla de si subir es
 * bueno — que depende del indicador y no del signo.
 */
export type Delta = {
  direction: "up" | "down" | "flat";
  /** `"+12 %"`, `"−8 %"`. Con el menos tipográfico, no el guion. */
  label: string;
};

export function deltaAgainst(current: number, previous: number): Delta | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }

  const change = (current - previous) / Math.abs(previous);
  const pct = Math.round(change * 100);

  if (pct === 0) return { direction: "flat", label: "sin cambio" };
  return {
    direction: pct > 0 ? "up" : "down",
    label: `${pct > 0 ? "+" : "−"}${Math.abs(pct)} %`,
  };
}
