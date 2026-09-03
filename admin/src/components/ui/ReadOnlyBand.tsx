import { Icon } from "./Icon";

/**
 * "EA no responde": la banda de solo lectura.
 *
 * Es uno de los tres estados de sistema que este panel sí va a ver. MySQL sigue
 * arriba, así que los reportes y la agenda se ven; lo que no se puede es
 * escribir, porque toda escritura va por la API REST de EA (nunca a sus tablas)
 * para que dispare sus notificaciones y su sync con Google Calendar.
 *
 * La banda existe para que la recepción se entere **antes** de llenar una
 * cuenta y no al tocar Guardar. Un formulario que falla al enviar después de
 * dos minutos de trabajo es peor que una interfaz que avisa de entrada.
 *
 * `role="status"`, no `alert`: describe una condición que persiste, no un
 * evento que acaba de pasar. `alert` interrumpe al lector de pantalla en cada
 * navegación mientras EA siga caído.
 *
 * Los paquetes que la usen tienen que **además deshabilitar los controles de
 * escritura**. La banda informa; no protege. Un botón habilitado bajo una banda
 * que dice "no se puede guardar" es peor que no tener banda.
 */
/**
 * Cierra la frase de la causa sin duplicarle la puntuación.
 *
 * La banda completa la oración con ", así que…", y por eso no puede pegar esa
 * coma detrás de un `reason` que ya viene terminado: el resultado era
 * "…no se puede guardar., así que por ahora no se puede…". Un `reason` que
 * cierra con `.`, `!` o `?` se deja como una oración aparte; uno que no,
 * recibe la subordinada.
 *
 * `since` va siempre antes del corte, porque es parte de la causa
 * ("EA no responde **desde las 3:12 p. m.**"), no de la consecuencia.
 */
function readOnlySentence(reason: string, since?: string): string {
  const causa = `${reason.trimEnd()}${since ? ` ${since}` : ""}`;

  return /[.!?]$/.test(causa)
    ? `${causa} Por ahora no se puede crear ni modificar nada.`
    : `${causa}, así que por ahora no se puede crear ni modificar nada.`;
}

export function ReadOnlyBand({
  /** Desde cuándo, ya formateado. `"desde las 3:12 p. m."` */
  since,
  /** Qué se está intentando. Deja lugar a otras causas además de EA caído. */
  reason = "Easy!Appointments no está respondiendo",
  /** Enlace al tablero de Diagnóstico. */
  detailsHref,
}: {
  since?: string;
  reason?: string;
  detailsHref?: string;
}) {
  return (
    <div className="ui-readonly" role="status">
      <Icon name="candado" size={16} className="ui-readonly__icon" />
      <span>
        <strong>Solo lectura.</strong> {readOnlySentence(reason, since)} La
        agenda y los reportes siguen al día.
        {detailsHref ? (
          <>
            {" "}
            <a href={detailsHref} style={{ fontWeight: 700 }}>
              Ver Diagnóstico
            </a>
          </>
        ) : null}
      </span>
    </div>
  );
}
