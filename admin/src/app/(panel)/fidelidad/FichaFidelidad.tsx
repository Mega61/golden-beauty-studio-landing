import { StagePill, StampDots, stageLabel } from "@/components/loyalty/StampDots";
import { Card, CardHead, Icon } from "@/components/ui";
import { loadLoyalty } from "@/lib/stampee/client";
import { clientsForPhone } from "@/lib/stampee/model";

import styles from "./fidelidad.module.css";
import { RedeemButton } from "./RedeemButton";

/**
 * La tarjeta de sellos en la ficha de la clienta.
 *
 * Cruza por celular (los 10 últimos dígitos), que es lo único que EA y Stampee
 * tienen en común. Sin Stampee configurado no dibuja nada; caído, lo dice en
 * una línea, porque "no tiene tarjeta" y "no se pudo preguntar" no son lo mismo.
 */
export async function FichaFidelidad({
  phone,
  canRedeem,
}: {
  phone: string | null;
  canRedeem: boolean;
}) {
  if (!phone) return null;
  const result = await loadLoyalty();
  if (!result.ok && result.reason === "sin-configurar") return null;

  const clients = result.ok ? clientsForPhone(result.data, phone) : [];
  const cards = clients.flatMap((client) => client.cards.map((card) => ({ client, card })));
  const cardBaseUrl = result.ok ? result.data.cardBaseUrl : null;
  // Las canjeadas viejas no hacen falta en la ficha: con las tres últimas
  // alcanza para ver que es una clienta que ya cobró premios.
  const active = cards.filter(({ card }) => card.stage !== "canjeada");
  const redeemed = cards.filter(({ card }) => card.stage === "canjeada");

  return (
    <Card padded={false}>
      <CardHead title="Fidelidad" />
      {!result.ok ? (
        <p className={styles.empty}>{result.message}</p>
      ) : cards.length === 0 ? (
        <p className={styles.empty}>
          No tiene tarjeta de sellos en Stampee con este celular.
        </p>
      ) : (
        <ul className={styles.list}>
          {[...active, ...redeemed.slice(0, 3)].map(({ client, card }) => {
            const gifted = card.gifted.welcome + card.gifted.winBack;
            return (
              <li key={card.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <div className={styles.rowHead}>
                    <span className={styles.name}>{card.campaignName}</span>
                    <StagePill stage={card.stage}>{stageLabel(card)}</StagePill>
                  </div>
                  <div className={styles.rowStamps}>
                    <StampDots card={card} />
                    <span className="ui-num">
                      {card.stamps}/{card.totalStamps}
                    </span>
                  </div>
                  <p className={styles.meta}>
                    {[
                      card.rewardName ? `Premio: ${card.rewardName}` : null,
                      gifted > 0 ? `${card.fromVisits} por visitas, ${gifted} de regalo` : null,
                      card.stage === "canjeada" && card.redeemedAt
                        ? `aplicado el ${new Date(card.redeemedAt).toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Bogota" })}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className={styles.rowActions}>
                  {canRedeem && card.stage === "lista" ? (
                    <RedeemButton cardId={card.id} customerName={client.name} rewardName={card.rewardName} />
                  ) : null}
                  {cardBaseUrl ? (
                    <a
                      className="ui-btn ui-btn--ghost ui-btn--sm"
                      href={`${cardBaseUrl}/${card.uniqueId}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Abrir la tarjeta en Stampee"
                    >
                      <Icon name="externo" size={16} />
                      Tarjeta
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
