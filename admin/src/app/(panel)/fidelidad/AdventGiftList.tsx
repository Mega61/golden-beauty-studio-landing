import Link from "next/link";

import {
  adventKindNote,
  adventStatus,
  adventTicketNote,
  adventValidity,
  canMarkUsed,
  canUndo,
  type StudioAdventReward,
} from "@/lib/stampee/advent";

import { AdventRedeemButton, AdventUndoButton } from "./AdventButtons";
import styles from "./fidelidad.module.css";

/**
 * Los regalos del calendario de Adviento como filas, para la ficha y para
 * Fidelidad. Cada una: título, día de la puerta, código, vigencia, estado, sus
 * condiciones (plegadas) y, en los cupones, "Marcar usado" con la instrucción
 * de la cuenta al lado — o "Deshacer" si ya se marcó.
 */
export function AdventGiftList({
  rewards,
  today,
  canRedeem,
  fichaHrefs,
}: {
  rewards: readonly StudioAdventReward[];
  /** `YYYY-MM-DD` de Bogotá. */
  today: string;
  canRedeem: boolean;
  /**
   * En Fidelidad, la ficha de cada clienta (por id de Stampee): la fila lleva
   * su nombre. En la ficha no hace falta: ya se sabe de quién es.
   */
  fichaHrefs?: ReadonlyMap<string, string | null>;
}) {
  return (
    <ul className={styles.list}>
      {rewards.map((reward) => {
        const status = adventStatus(reward, today);
        const note = adventTicketNote(reward);
        const kindNote = adventKindNote(reward.kind);
        const href = fichaHrefs?.get(reward.customerId) ?? null;
        return (
          <li key={reward.id} className={styles.row}>
            <div className={styles.rowMain}>
              <div className={styles.rowHead}>
                {fichaHrefs ? (
                  href ? (
                    <Link href={href} className={styles.name}>
                      {reward.customerName}
                    </Link>
                  ) : (
                    <span className={styles.name}>{reward.customerName}</span>
                  )
                ) : null}
                <span className={fichaHrefs ? undefined : styles.name}>{reward.title}</span>
                <span className={styles.advPill} data-tone={status.tone}>
                  {status.label}
                </span>
              </div>
              <p className={styles.meta}>
                {[
                  `Puerta del día ${reward.dayLabel}`,
                  adventValidity(reward),
                  reward.status === "redeemed" && reward.redeemedAt
                    ? `usado el ${fechaHora(reward.redeemedAt)}${reward.redeemedBy ? ` por ${reward.redeemedBy}` : ""}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {reward.code ? (
                  <>
                    {" · "}
                    <code className={styles.code}>{reward.code}</code>
                  </>
                ) : null}
              </p>
              {reward.subtitle ? <p className={styles.meta}>{reward.subtitle}</p> : null}
              {kindNote ? <p className={styles.meta}>{kindNote}</p> : null}
              {reward.terms.length > 0 ? (
                <details className={styles.terms}>
                  <summary>Condiciones</summary>
                  <ul>
                    {reward.terms.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
            {canRedeem && reward.code && (canMarkUsed(reward, today) || canUndo(reward)) ? (
              <div className={styles.advActions}>
                {canMarkUsed(reward, today) ? (
                  <>
                    <AdventRedeemButton
                      code={reward.code}
                      customerName={reward.customerName}
                      title={reward.title}
                      note={note}
                    />
                    <span className={styles.meta}>
                      Al cerrar la cuenta: descuento con motivo <strong>promo</strong> y nota «{note}».
                    </span>
                  </>
                ) : (
                  <AdventUndoButton code={reward.code} />
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function fechaHora(iso: string): string {
  return new Date(iso).toLocaleString("es-CO", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Bogota",
  });
}
