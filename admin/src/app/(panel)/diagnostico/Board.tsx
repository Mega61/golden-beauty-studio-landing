import Link from "next/link";

import type { Check, CheckLevel } from "./checks";
import { worstLevel } from "./checks";
import styles from "./diagnostico.module.css";

/**
 * El tablero, separado de la página que lo carga.
 *
 * `page.tsx` se queda con la compuerta del DAL y las sondas; esto solo dibuja.
 * La vista previa reusa **este** componente, no una copia — un tablero de
 * mentira que se desactualiza no sirve para validar el de verdad.
 *
 * ## Las tres decisiones visuales de esta pantalla
 *
 * - **Una lista, no una rejilla de tarjetas.** Once tarjetas obligan a barrer
 *   en dos dimensiones para encontrar el rojo. En una columna el ojo baja una
 *   vez.
 * - **Nunca color solo.** Cada renglón lleva punto, palabra y texto — la misma
 *   regla que la pastilla de la agenda, y por la misma razón: daltonismo, y una
 *   hoja impresa en blanco y negro. Y el color sale de la familia de
 *   *retroalimentación del sistema*, no de la de estados de la cita: un rojo de
 *   "está roto" no puede ser el mismo tono que un rojo de "no asistió".
 * - **`unknown` va con filete punteado**, igual que la pastilla `desconocido`.
 *   Lo que este panel no puede comprobar se dice, no se pinta de verde. Un
 *   tablero que miente en un renglón deja de servir en todos.
 */

const WORD: Record<CheckLevel, string> = {
  ok: "Bien",
  warn: "Revisar",
  down: "Roto",
  unknown: "Sin comprobar",
};

const HEADLINE: Record<CheckLevel, string> = {
  ok: "Todo en orden",
  warn: "Hay algo que revisar",
  down: "Hay algo roto",
  unknown: "No se pudo comprobar todo",
};

export function Board({
  checks,
  window,
}: {
  checks: readonly Check[];
  window: { from: string; to: string; days: number };
}) {
  const level = worstLevel(checks);

  const counts = checks.reduce<Record<CheckLevel, number>>(
    (acc, check) => ({ ...acc, [check.level]: acc[check.level] + 1 }),
    { ok: 0, warn: 0, down: 0, unknown: 0 },
  );

  return (
    <>
      <header className={styles.head}>
        <span className={styles.headline}>
          {/* El mismo atributo `data-level` que los renglones: un solo
              mecanismo, no dos formas de decir lo mismo. */}
          <span aria-hidden="true" className={styles.dot} data-level={level} />
          {HEADLINE[level]}
        </span>
        <span className={styles.meta}>
          {counts.ok} bien · {counts.warn} por revisar · {counts.down} roto
          {counts.down === 1 ? "" : "s"} · {counts.unknown} sin comprobar
        </span>
        <span className={styles.spacer} />
        <span className={styles.meta}>
          Ventana de {window.days} días · {window.from} a {window.to}
        </span>
        <Link className="ui-btn ui-btn--ghost ui-btn--sm" href="/reportes">
          Reportes
        </Link>
      </header>

      <ul className={styles.list}>
        {checks.map((check) => (
          <li className={styles.item} data-level={check.level} key={check.id}>
            <span aria-hidden="true" className={styles.dot} />
            <div className={styles.body}>
              <h2 className={styles.title}>{check.title}</h2>
              <span className={styles.word}>{WORD[check.level]}</span>
              <p className={styles.detail}>{check.detail}</p>
              {check.lastSeen ? (
                <span className={styles.lastSeen}>Última vez: {check.lastSeen}</span>
              ) : null}
            </div>
            {check.figure ? <span className={styles.figure}>{check.figure}</span> : null}
          </li>
        ))}
      </ul>

      {/* Lo que esta pantalla no puede comprobar. Va al pie y en crema porque
          es contexto permanente, no un hallazgo del día — pero va, porque un
          tablero que calla sus huecos se lee como si no los tuviera. */}
      <section className={styles.foot}>
        <h2>Lo que este tablero no puede comprobar</h2>
        <ul>
          <li>
            <strong>El header secreto del webhook.</strong> La API de EA no expone{" "}
            <code>secret_header</code>: no lo emite al leer ni lo acepta al escribir. Se
            configura en la interfaz de EA o por SQL, y la única prueba de que está bien es
            que un evento real llegue y sea aceptado.
          </li>
          <li>
            <strong>Si el reconcile corrió.</strong> No hay tabla de corridas de trabajos, así
            que lo que se muestra es la marca de tiempo más nueva de una fila que el reconcile
            escribió. Una corrida sin nada que reparar no deja rastro, así que una racha
            tranquila se ve igual que un reconcile caído.
          </li>
          <li>
            <strong>La antigüedad del respaldo, mientras el volumen no esté montado.</strong>{" "}
            El servicio <code>db-backup</code> escribe <code>last-run.txt</code> y{" "}
            <code>last-status.txt</code> en el volumen <code>gbs_backups</code>, y el
            contenedor del panel no lo monta. Falta una línea en el stack.
          </li>
          <li>
            <strong>En qué estación se atendió una cita.</strong> Ninguna tabla lo registra —
            EA no tiene el concepto de puesto. Por eso Reportes muestra la ocupación agregada
            de las horas de puesto y no el reparto entre los dos.
          </li>
        </ul>
      </section>
    </>
  );
}
