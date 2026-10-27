import type { WaSentLabel } from "@/lib/whatsapp/sent-labels";

import { Icon } from "./Icon";

/**
 * "✓ Confirmación enviada · ✓ Recordatorio leído", al pie de una cita.
 *
 * Texto suave con ícono y **no** una pastilla: la pastilla de color es el
 * estado de la cita en EA, y esto no lo es (ver `lib/whatsapp/sent-labels.ts`).
 * Dos cosas con la misma forma se leen como la misma cosa.
 */
export function WaSentLabels({ labels }: { labels: readonly WaSentLabel[] | undefined }) {
  if (labels === undefined || labels.length === 0) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        alignItems: "center",
        columnGap: "0.625rem",
        rowGap: "0.125rem",
        fontSize: "var(--text-2xs)",
        lineHeight: "1rem",
        whiteSpace: "normal",
      }}
    >
      {labels.map((label) => (
        <span
          key={label.kind}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            color: label.state === "fallido" ? "var(--color-warn-ink)" : "var(--color-ink-soft)",
          }}
        >
          <Icon name={label.state === "fallido" ? "alerta" : "check"} size={12} style={{ flex: "none" }} />
          {label.text}
        </span>
      ))}
    </span>
  );
}
