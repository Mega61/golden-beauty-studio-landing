import Link from "next/link";

import styles from "./charts.module.css";
import {
  CADENCE_LABEL,
  CADENCES,
  periodHref,
  shiftPeriod,
  type Period,
} from "./period";

/**
 * La fila de filtros de Reportes.
 *
 * ## Una sola fila, arriba de todo lo que scopea
 *
 * Es la regla de composición de `dataviz`, y no es cosmética: los nueve
 * reportes se dibujan contra **el mismo** rango, así que las cifras de dos
 * tarjetas se pueden sumar entre sí. Un filtro dentro de una tarjeta rompería
 * eso sin que nada lo advierta — "si un gráfico necesita su propio rango, es
 * otro tablero".
 *
 * ## Son enlaces, no un componente de cliente
 *
 * Cambiar de periodo cambia la URL, y la URL es lo que hace que el reporte se
 * pueda compartir por WhatsApp y volver a abrir igual. Con enlaces el servidor
 * vuelve a pedir los datos, el estado vive en la barra de direcciones y la
 * pantalla funciona sin JavaScript. Un selector de cliente habría necesitado
 * `useRouter`, un estado que se desincroniza del historial, y un bundle para
 * hacer lo que un `<a>` hace solo.
 *
 * Y son `next/link` y no el `ButtonLink` del kit de A3: ese componente
 * renderiza un `<a>` pelado, y con `basePath: "/admin"` un `<a href="/reportes">`
 * apunta fuera del panel. `next/link` prefija el `basePath` solo — es la misma
 * razón por la que `SideNav` de A3 usa `Link`. Las clases del botón se aplican
 * igual, así que el gesto visual es el mismo.
 *
 * ## Presets antes que un calendario
 *
 * Nadie pelea con una grilla de calendario para pedir "el mes pasado". Las tres
 * cadencias son los presets, y las flechas mueven de una en una. El rango
 * arbitrario existe por `?desde=&hasta=` —es la escotilla para el día en que
 * los cortes de quincena reales no sean 1–15 / 16–fin— y no ocupa espacio en el
 * cromo mientras nadie lo necesite.
 */
export function PeriodFilter({
  period,
  base = "/reportes",
}: {
  period: Period;
  /** La vista previa se pasa su propia ruta para no salirse de sí misma. */
  base?: string;
}) {
  const previous = shiftPeriod(period, -1);
  const next = shiftPeriod(period, 1);

  return (
    <nav aria-label="Periodo del reporte" className={styles.filters}>
      <div className={styles.filterGroup} role="group" aria-label="Cadencia">
        {CADENCES.map((cadence) => {
          const active = cadence === period.cadence;
          return (
            <Link
              aria-current={active ? "true" : undefined}
              className={`ui-btn ui-btn--sm ${active ? "ui-btn--primary" : "ui-btn--ghost"}`}
              href={periodHref({ ...period, cadence }, base)}
              key={cadence}
            >
              {CADENCE_LABEL[cadence]}
            </Link>
          );
        })}
      </div>

      <div className={styles.filterGroup}>
        <Link
          aria-label={`Periodo anterior: ${previous.label}`}
          className="ui-btn ui-btn--secondary ui-btn--sm"
          href={periodHref(previous, base)}
        >
          ‹
        </Link>
        <span className={styles.periodLabel}>{period.label}</span>
        <Link
          aria-label={`Periodo siguiente: ${next.label}`}
          className="ui-btn ui-btn--secondary ui-btn--sm"
          href={periodHref(next, base)}
        >
          ›
        </Link>
      </div>

      <span className={styles.spacer} />

      {/* Diagnóstico es la otra mitad de este paquete y es donde uno va cuando
          un número de acá no cuadra. El enlace ahorra el viaje por el menú. */}
      <Link className="ui-btn ui-btn--ghost ui-btn--sm" href="/diagnostico">
        Diagnóstico
      </Link>
    </nav>
  );
}
