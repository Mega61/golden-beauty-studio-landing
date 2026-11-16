import { Card, CardHead } from "@/components/ui";
import { instantToEaDate } from "@/lib/ea";
import { adventForCustomers, type StudioAdventReward } from "@/lib/stampee/advent";
import { listAdventRewards, loadLoyalty } from "@/lib/stampee/client";
import { clientsForPhone } from "@/lib/stampee/model";

import { AdventGiftList } from "./AdventGiftList";
import styles from "./fidelidad.module.css";

/**
 * Los regalos del calendario de Adviento en la ficha de la clienta.
 *
 * Los regalos son de la clienta en Stampee, así que se cruza igual que la
 * tarjeta: celular → fichas de Stampee → sus regalos. Lee fresco (los botones
 * deciden una escritura). Sin calendario, sin regalos abiertos o con Stampee
 * sin el endpoint (404) no dibuja nada; con Stampee caído lo dice en una línea.
 */
export async function FichaAdviento({ phone, canRedeem }: { phone: string | null; canRedeem: boolean }) {
  if (!phone) return null;
  const loyalty = await loadLoyalty();
  if (!loyalty.ok) return null;
  const clients = clientsForPhone(loyalty.data, phone);
  if (clients.length === 0) return null;

  const results = await Promise.all(
    clients.map((client) => listAdventRewards({ customerId: client.id, status: "all" })),
  );
  const failure = results.find((r) => !r.ok && r.status !== 404);
  const rewards: StudioAdventReward[] = results.flatMap((r) => (r.ok ? r.rewards : []));
  const today = instantToEaDate(new Date());
  const shown = adventForCustomers(
    rewards,
    clients.map((c) => c.id),
    today,
  );

  if (shown.length === 0 && (failure === undefined || failure.ok)) return null;

  return (
    <Card padded={false}>
      <CardHead title="Regalos de Adviento" />
      {failure && !failure.ok ? <p className={styles.empty}>{failure.message}</p> : null}
      {shown.length > 0 ? <AdventGiftList rewards={shown} today={today} canRedeem={canRedeem} /> : null}
    </Card>
  );
}
