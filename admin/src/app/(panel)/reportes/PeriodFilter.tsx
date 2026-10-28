import Link from "next/link";

import { DateStepper } from "@/components/ui/DateStepper";
import { Icon } from "@/components/ui/Icon";

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
 * Son `next/link`: con `basePath: "/admin"` un `<a href="/reportes">` pelado
 * apunta fuera del panel, y `Link` prefija el `basePath` solo.
 *
 * La cadencia es el control segmentado del kit (`.ui-seg`) y el periodo es el
 * `DateStepper`, el mismo de Hoy y de Caja: moverse en el tiempo se ve igual en
 * todo el panel, y las flechas hacen entrar el periodo nuevo desde su lado.
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
    <div className={styles.filters}>
      <div className={styles.filterRow}>
        <nav className="ui-seg" aria-label="Cadencia">
          {CADENCES.map((cadence) => {
            const active = cadence === period.cadence;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className="ui-seg__item"
                href={periodHref({ ...period, cadence }, base)}
                key={cadence}
              >
                {CADENCE_LABEL[cadence]}
              </Link>
            );
          })}
        </nav>

        <span className={styles.spacer} />

        {/* Diagnóstico es la otra mitad de este paquete y es donde uno va
            cuando un número de acá no cuadra. El enlace ahorra el viaje por el
            menú. */}
        <Link className="ui-btn ui-btn--ghost ui-btn--sm" href="/diagnostico">
          <Icon name="diagnostico" size={16} />
          Diagnóstico
        </Link>
      </div>

      <DateStepper
        label={period.label}
        prevHref={periodHref(previous, base)}
        nextHref={periodHref(next, base)}
        todayHref={null}
        prevLabel={`Periodo anterior: ${previous.label}`}
        nextLabel={`Periodo siguiente: ${next.label}`}
      />
    </div>
  );
}
