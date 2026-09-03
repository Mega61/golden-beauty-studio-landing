import type { GoogleSyncStatus } from "./sync";

/**
 * El estado del espejo de Google, en una pastilla.
 *
 * `incompleto` existe porque **el push a Google falla en silencio**: el sync
 * marcado activo sin token ni calendario no da error en ningún lado, y la única
 * señal que queda es un `id_google_calendar` vacío en las citas. Una pastilla
 * amarilla en Equipo es la primera oportunidad de verlo sin abrir Diagnóstico.
 */
const TONE = {
  activo: { texto: "Espejo activo", tono: "ok" },
  incompleto: { texto: "Espejo a medias", tono: "warn" },
  apagado: { texto: "Sin espejo", tono: "info" },
} as const;

export function SyncBadge({ status }: { status: GoogleSyncStatus }) {
  const { texto, tono } = TONE[status.state];
  return (
    <span
      title={
        status.problems.length > 0
          ? status.problems.join(" ")
          : status.calendarId
            ? `Calendario: ${status.calendarId}`
            : undefined
      }
      style={{
        fontSize: "var(--text-2xs)",
        padding: "0.0625rem 0.375rem",
        borderRadius: "var(--radius-sm)",
        whiteSpace: "nowrap",
        background: `var(--color-${tono}-tint)`,
        border: `1px solid var(--color-${tono}-line)`,
        color: `var(--color-${tono}-ink)`,
      }}
    >
      {texto}
    </span>
  );
}
