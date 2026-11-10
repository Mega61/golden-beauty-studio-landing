import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell";
import type { EaLocalDate, EaLocalDateTime } from "@/lib/ea";
import { addCalendarDays, DEFAULT_WINBACK_TEMPLATE, type WinbackCandidate } from "@/lib/winback";

import { RecuperarVista } from "../RecuperarVista";

/**
 * `/admin/clientes/recuperar/vista-previa` — la pantalla con 70 clientas
 * inventadas, para revisarla a 390 / 768 / 1440 sin base ni Stampee. Mismo
 * componente que `/clientes/recuperar`. **404 en producción**, como las demás
 * vistas previas. Enviar o guardar desde acá llama a las acciones de verdad.
 */

export const metadata = { title: "Recuperar clientas (vista previa) · Panel" };
export const dynamic = "force-dynamic";

const TODAY = "2026-11-10" as EaLocalDate;
const NAMES = [
  "Laura Restrepo", "Ana María Gómez", "Valentina Ríos", "Daniela Osorio", "Camila Zapata", "Sara Montoya",
  "Mariana Vélez Arango de la Cuesta", "Juliana Henao", "Paula Cardona", "Natalia Ospina", "Isabella Mejía", "Manuela Torres",
];

function person(i: number, sent: boolean): WinbackCandidate {
  const daysAway = 46 + ((i * 37) % 420);
  const last = addCalendarDays(TODAY, -daysAway);
  const [firstName, ...rest] = NAMES[i % NAMES.length]!.split(" ");
  return {
    phone: `+57300${String(1000000 + i * 7919).slice(-7)}`,
    firstName: firstName!,
    lastName: rest.join(" "),
    lastAttended: `${last} 15:00:00` as EaLocalDateTime,
    hasUpcoming: false,
    visits: 1 + ((i * 7) % 9),
    daysAway,
    sent: sent ? { sentAt: `${addCalendarDays(TODAY, -(i % 9))} 10:00:00` as EaLocalDateTime, cameBack: i % 3 === 0 } : null,
  };
}

export default function VistaPreviaRecuperar() {
  if (process.env.NODE_ENV === "production") notFound();
  const pending = Array.from({ length: 58 }, (_, i) => person(i, false)).sort((a, b) => b.visits - a.visits);
  const sent = Array.from({ length: 12 }, (_, i) => person(100 + i, true));
  return (
    <AppShell role="owner" title="Recuperar clientas (vista previa)">
      <RecuperarVista
        canConfigure
        today={TODAY}
        settings={{
          campaignId: "custom-1",
          template: DEFAULT_WINBACK_TEMPLATE,
          discountEnabled: true,
          validDays: 30,
          lapsedDays: 45,
          saved: true,
        }}
        pending={pending}
        sent={sent}
        campaigns={[
          { id: "custom-0", name: "Golden Beauty Studio", enabled: true, totalStamps: 8, bonusStamps: 0, rewardName: "15% en tu siguiente servicio" },
          { id: "custom-1", name: "Te extrañamos!", enabled: true, totalStamps: 8, bonusStamps: 3, rewardName: "15% en tu siguiente servicio" },
        ]}
        stampeeProblem={null}
      />
    </AppShell>
  );
}
