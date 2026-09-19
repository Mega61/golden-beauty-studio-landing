/**
 * La marca, y es **la misma de la landing** — no una versión dibujada aparte.
 *
 * Estuvo un tiempo siendo la palabra "Golden Beauty" compuesta en Cormorant, y
 * el resultado era que el panel y el sitio parecían de dos negocios distintos:
 * la landing pinta el logotipo de verdad —el script "Golden" con su filete
 * dorado— y el panel escribía el nombre con una tipografía parecida. De cerca
 * no se nota; una al lado de la otra, sí.
 *
 * Los archivos son los mismos de `public/logos/` de la landing, copiados a
 * `admin/public/logos/`. **Copiados y no importados**: el contexto de build de
 * la imagen del panel es `admin/` y no alcanza la raíz del repo — es la misma
 * razón por la que la app no importa nada de `src/`. Son 111 KB de SVG que
 * cambian una vez cada varios años.
 *
 * ## Por qué hay que recortar el SVG
 *
 * Las fuentes vienen en un lienzo cuadrado de 1500 × 1500 con muchísimo aire:
 * el trazo ocupa el 86 % del ancho y el 33 % del alto, empezando al 30 % desde
 * arriba. Pintarlas tal cual dejaría el wordmark diminuto en el centro de un
 * bloque enorme. Se renderiza sobredimensionado dentro de una ventana con
 * `overflow: hidden` y se desplaza para dejar ver solo la parte pintada — las
 * proporciones son las mismas que midió `_components/Logo.tsx` en la landing,
 * y están acá otra vez porque los dos árboles no se pueden importar entre sí.
 *
 * ## Por qué `<img>` y no `next/image`
 *
 * Un SVG en `next/image` exige `dangerouslyAllowSVG` en la configuración, que
 * es una puerta abierta para un beneficio nulo: son dos archivos estáticos
 * propios, de tamaño fijo, servidos desde el mismo origen.
 */

/**
 * Extensión real del trazo dentro del lienzo de 1500². Medido, no estimado.
 *
 * Las rutas llevan `/admin` escrito: `basePath` prefija las rutas y los chunks
 * del bundler, pero **no el `src` de una etiqueta `<img>`** — eso lo escribe
 * quien la pone. Sin el prefijo, el navegador pediría `/logos/…` a la landing
 * de Vercel, que no los tiene bajo esa ruta.
 */
const WORDMARK = {
  src: "/admin/logos/LogoText.svg",
  altoContenido: 0.326,
  margenSuperior: 0.301,
  anchoContenido: 0.858,
} as const;

/** El subtítulo "— BEAUTY STUDIO —". Mismo lienzo, otras proporciones. */
const SUBLINEA = {
  src: "/admin/logos/LogoSubText.svg",
  altoContenido: 0.043,
  margenSuperior: 0.479,
  anchoContenido: 0.899,
} as const;

/**
 * La marca recortada a su caja real.
 *
 * `alto` es la altura **visible** que se quiere, en píxeles; el resto se deriva.
 */
function MarcaRecortada({
  alto,
  parte = WORDMARK,
}: {
  alto: number;
  parte?: typeof WORDMARK | typeof SUBLINEA;
}) {
  const lienzo = Math.round(alto / parte.altoContenido);
  const ancho = Math.round(lienzo * parte.anchoContenido);
  const desplazamiento = Math.round(-lienzo * parte.margenSuperior);

  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: ancho,
        height: alto,
        overflow: "hidden",
        position: "relative",
        lineHeight: 0,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={parte.src}
        alt=""
        decoding="async"
        style={{
          width: lienzo,
          height: lienzo,
          position: "absolute",
          top: desplazamiento,
          left: Math.round(-lienzo * 0.07),
          maxWidth: "none",
        }}
      />
    </span>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="ui-wordmark" style={{ display: "inline-flex", alignItems: "center" }}>
      {/*
        Siempre el mismo trazo, más pequeño cuando no hay sitio. Acá estuvo el
        sello redondo para el riel y **no se leía**: su campo es marfil claro
        sobre una barra marfil, y a 26 px se veía un círculo pálido y nada más.
        El sello es correcto a 256 px —donde sirve es de favicon— y a este
        tamaño el que funciona es el logotipo.

        16 px de altura de trazo son unos 42 de ancho, y el riel tiene 52
        útiles (4.25rem menos el padding). 24 en la barra completa, que mide
        240: legible sin competir con la navegación, que es lo que la persona
        viene a usar. La landing usa 12 en su nav, donde el logotipo sí es el
        protagonista de la fila.
      */}
      <MarcaRecortada alto={compact ? 16 : 24} />
      {/*
        El nombre siempre viaja para el lector de pantalla: lo que el recorte
        quita es pintura, nunca información. En el riel, además, es lo único
        que dice dónde está parado quien navega con teclado.
      */}
      <span className="ui-sr">Golden Beauty Studio · Panel</span>
    </span>
  );
}

/**
 * El logotipo completo, con su subtítulo. Solo para la pantalla de entrada.
 *
 * Es el único lugar del panel donde la marca tiene espacio para respirar: no
 * hay datos que mirar todavía y sí una persona comprobando que llegó al sitio
 * correcto. En el resto del panel el logotipo va reducido a su mínimo — una
 * herramienta de trabajo no se pasa el día presentándose.
 */
export function Logotipo({ alto = 34 }: { alto?: number }) {
  return (
    <span style={{ display: "inline-grid", gap: "0.45rem", justifyItems: "start" }}>
      <MarcaRecortada alto={alto} />
      <MarcaRecortada alto={Math.max(6, Math.round(alto * 0.13))} parte={SUBLINEA} />
      <span className="ui-sr">Golden Beauty Studio</span>
    </span>
  );
}
