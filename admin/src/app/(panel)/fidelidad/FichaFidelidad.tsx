import { StagePill, StampDots, stageLabel } from "@/components/loyalty/StampDots";
import { Card, CardHead, Icon } from "@/components/ui";
import { getDb } from "@/db/client";
import { stampeeCardShareRepository } from "@/db/repositories";
import { cardShareLink } from "@/lib/stampee/card-share";
import { loadLoyalty } from "@/lib/stampee/client";
import { clientsForPhone } from "@/lib/stampee/model";

import styles from "./fidelidad.module.css";
import { RedeemButton } from "./RedeemButton";
import { ShareCardButton } from "./ShareCardButton";

/**
 * La tarjeta de sellos en la ficha de la clienta.
 *
 * Cruza por celular (los 10 últimos dígitos), que es lo único que EA y Stampee
 * tienen en común. Sin Stampee configurado no dibuja nada; caído, lo dice en
 * una línea, porque "no tiene tarjeta" y "no se pudo preguntar" no son lo mismo.
 *
 * Solo se dibuja para quien tiene `fidelidad:ver`, que es lo mismo que pide
 * "Enviar tarjeta": por eso el botón no lleva su propia pregunta de permiso.
 */
export async function FichaFidelidad({
  phone,
  canRedeem,
}: {
  phone: string | null;
  canRedeem: boolean;
}) {
  if (!phone) return null;
  const [result, sentIds] = await Promise.all([
    loadLoyalty(),
    // Si la base no responde, el botón sale igual, como "Enviar".
    stampeeCardShareRepository(getDb())
      .listSentCardIds()
      .catch(() => new Set<string>()),
  ]);
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
          No tiene tarjeta de sellos en Stampee con este celular. Se crea sola la noche después de
          su primera visita con la cuenta cerrada, y al otro día se le puede mandar desde acá.
        </p>
      ) : (
        <ul className={styles.list}>
          {[...active, ...redeemed.slice(0, 3)].map(({ client, card }) => {
            const gifted = card.gifted.welcome + card.gifted.winBack;
            const canShare =
              card.stage !== "canjeada" &&
              cardShareLink({ phone: client.mobile, customerName: client.name, card, cardBaseUrl }) !== null;
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
                  {canShare ? <ShareCardButton cardId={card.id} sent={sentIds.has(card.id)} /> : null}
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
