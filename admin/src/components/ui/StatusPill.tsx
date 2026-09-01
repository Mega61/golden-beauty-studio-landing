import { resolveStatus, type StatusToken } from "./status";

/**
 * La pastilla de estado de la cita.
 *
 * Tres reglas duras del plan, y las tres están en el marcado, no en la
 * disciplina de quien la use:
 *
 * 1. **Nunca color solo.** Punto *y* texto, siempre. No hay prop para apagar la
 *    etiqueta. Una persona daltónica y una hoja impresa en blanco y negro
 *    tienen que poder leerla, y la hoja de ruta del día se imprime.
 * 2. **Nada de franja lateral de 4 px.** Superficie tintada + filete de 1 px +
 *    punto. El patrón de la franja está prohibido en todo el sistema.
 * 3. **Contraste ≥4.5:1 de la etiqueta sobre su propio tinte.** El mínimo
 *    medido de los cinco es 6.03:1 (ver `status.test.ts`, que lo recalcula).
 *
 * `raw` acepta lo que venga: el id del panel (`"no-asistio"`) o la etiqueta tal
 * cual (`"No asistió"`). Lo que no reconoce lo dibuja punteado y neutro, en vez
 * de inventarle un color — el `status` de EA es texto libre y renombrarlo desde
 * su interfaz no debería producir una pastilla mentirosa.
 */
export function StatusPill({
  status,
  size = "md",
}: {
  /** Id, etiqueta o lo que sea que haya traído EA. */
  status: string | StatusToken | null | undefined;
  size?: "md" | "sm";
}) {
  const meta = resolveStatus(status);
  return (
    <span
      className={`ui-pill ui-pill--${meta.id}`}
      style={size === "sm" ? { padding: "0.0625rem 0.375rem 0.0625rem 0.3125rem" } : undefined}
      title={meta.description}
    >
      <span className="ui-pill__dot" aria-hidden />
      {meta.label}
    </span>
  );
}
