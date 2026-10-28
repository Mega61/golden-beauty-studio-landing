import type { LoyaltyCard, LoyaltyStage } from "@/lib/stampee/model";

import styles from "./loyalty.module.css";

/**
 * La tarjeta de sellos como la ve la clienta: un punto por sello.
 *
 * Los regalados (bienvenida y win-back) se pintan aparte de los de visitas,
 * porque "lleva 6" y "vino 6 veces" no son lo mismo y la dueña decide distinto
 * con cada uno. Con más de 20 sellos de meta los puntos ya no se leen y se
 * cambia a una barra.
 */
export function StampDots({ card, size = "md" }: { card: LoyaltyCard; size?: "sm" | "md" }) {
  const label = `${card.stamps} de ${card.totalStamps} sellos`;
  const filled = Math.min(card.stamps, card.totalStamps);

  if (card.totalStamps > 20) {
    return (
      <span className={styles.bar} data-stage={card.stage} role="img" aria-label={label}>
        <span style={{ width: `${(filled / card.totalStamps) * 100}%` }} />
      </span>
    );
  }

  const gifted = Math.min(card.gifted.welcome + card.gifted.winBack, filled);
  return (
    <span className={styles.dots} data-size={size} data-stage={card.stage} role="img" aria-label={label}>
      {Array.from({ length: card.totalStamps }, (_, i) => (
        <span
          key={i}
          className={styles.dot}
          data-fill={i < gifted ? "regalo" : i < filled ? "visita" : undefined}
        />
      ))}
    </span>
  );
}

export function stageLabel(card: LoyaltyCard): string {
  switch (card.stage) {
    case "lista":
      return "Premio listo";
    case "canjeada":
      return "Premio aplicado";
    default:
      return card.remaining === 1 ? "Le falta 1 sello" : `Le faltan ${card.remaining} sellos`;
  }
}

export function StagePill({ stage, children }: { stage: LoyaltyStage; children: React.ReactNode }) {
  return (
    <span className={styles.pill} data-stage={stage}>
      {children}
    </span>
  );
}
