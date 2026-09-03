import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";

import { Board } from "../Board";
import {
  backupCheck,
  eaApiCheck,
  eaDatabaseCheck,
  googleMirrorCheck,
  ingestPushCheck,
  orphanCheck,
  reconcileCheck,
  snapshotCheck,
  statusOptionsCheck,
  webhookCheck,
  webhookTrafficCheck,
  type Check,
} from "../checks";

/**
 * `/admin/diagnostico/vista-previa` — el tablero con los once renglones en el
 * estado que se pida.
 *
 * **Por qué existe:** este tablero solo se ve interesante cuando algo está
 * roto, y "algo roto" es justo lo que no se puede provocar a demanda en un
 * entorno de desarrollo — no hay forma de vencer un token de Google ni de
 * hacer que un respaldo falle para comprobar que el renglón sale en rojo. Con
 * `?estado=roto` los once renglones se pintan en su peor caso y se puede
 * verificar el contraste, el punteado del `unknown` y el layout a 390 px.
 *
 * **Qué no es:** un modo de demostración. Responde **404 en producción** y no
 * toca ni la base ni la red: los checks son las mismas funciones puras que usa
 * la pantalla de verdad, alimentadas con hechos inventados.
 *
 * Tres estados: `sano`, `mixto` (el realista — con los dos `unknown` que hoy no
 * se pueden comprobar) y `roto`.
 */

export const metadata = {
  title: "Diagnóstico (vista previa) · Panel",
};

export const dynamic = "force-dynamic";

type State = "sano" | "mixto" | "roto";

function parseState(value: string | undefined): State {
  return value === "sano" || value === "roto" ? value : "mixto";
}

function parseRole(value: string | undefined): Role {
  return value === "staff" || value === "reception" ? value : "owner";
}

/** Un instante fijo: una captura que cambia cada día no se puede comparar. */
const NOW = new Date("2026-08-31T14:00:00-05:00");
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

function build(state: State): Check[] {
  const healthy = state === "sano";
  const broken = state === "roto";

  return [
    eaApiCheck({
      ok: !broken,
      error: broken ? "fetch failed: ECONNREFUSED 172.18.0.4:80" : undefined,
      at: NOW,
      now: NOW,
    }),
    eaDatabaseCheck({
      ok: !broken,
      error: broken ? "ER_ACCESS_DENIED_ERROR: Access denied for user 'gbs_ea_ro'" : undefined,
      at: NOW,
      now: NOW,
    }),
    ...webhookCheck({
      webhooks: broken
        ? [
            {
              id: 1,
              name: "panel",
              url: "http://gbs-admin:3000/admin/api/webhooks/ea",
              // El caso que produce el ejemplo del openapi.yml de EA: acciones
              // que no existen dejan el webhook mudo sin dar error.
              actions: "appointment_create,appointment_update",
              isSslVerified: false,
            },
          ]
        : [
            {
              id: 1,
              name: "panel",
              url: "http://gbs-admin:3000/admin/api/webhooks/ea",
              actions: "appointment_save",
              isSslVerified: false,
            },
          ],
      expectedPath: "/admin/api/webhooks/ea",
      requiredAction: "appointment_save",
      at: NOW,
      now: NOW,
    }),
    statusOptionsCheck({
      raw: healthy
        ? '["Reservada", "Confirmada", "Completada", "No asistió", "Cancelada"]'
        : '["Reservada", "Confirmada", "Completada", "No asistió", "Cancelada", "Pendiente de pago"]',
      recognized: (value) =>
        ["Reservada", "Confirmada", "Completada", "No asistió", "Cancelada"].includes(value),
      unmapped: healthy ? [] : ["Booked"],
      at: NOW,
      now: NOW,
    }),
    snapshotCheck({
      withoutSnapshot: broken ? 4 : healthy ? 0 : 0,
      fallback: healthy ? 0 : broken ? 7 : 1,
      total: 42,
      at: NOW,
      now: NOW,
    }),
    googleMirrorCheck({
      unmirrored: healthy ? 0 : broken ? 11 : 2,
      windowDays: 30,
      at: NOW,
      now: NOW,
    }),
    orphanCheck({
      orphans: healthy ? 0 : broken ? 3 : 0,
      checked: 42,
      at: NOW,
      now: NOW,
    }),
    webhookTrafficCheck({ lastEvent: healthy ? ago(2) : broken ? null : ago(6), now: NOW }),
    reconcileCheck({
      lastTouch: healthy ? ago(11) : broken ? null : ago(11),
      now: NOW,
    }),
    ingestPushCheck({
      lastPush: healthy ? ago(11) : broken ? ago(200) : ago(35),
      pending: healthy ? 0 : broken ? 5 : 1,
      now: NOW,
    }),
    backupCheck({
      lastRun: healthy ? ago(11) : broken ? ago(96) : null,
      status: healthy ? 0 : broken ? 1 : null,
      error: state === "mixto" ? "no se pudo leer /backups/last-run.txt" : undefined,
      now: NOW,
    }),
  ];
}

export default async function VistaPreviaDiagnostico({
  searchParams,
}: {
  searchParams: Promise<{ rol?: string; estado?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const params = await searchParams;
  const state = parseState(params.estado);

  return (
    <AppShell role={parseRole(params.rol)} title="Diagnóstico (vista previa)">
      <Board
        checks={build(state)}
        window={{ from: "2026-08-01", to: "2026-08-31", days: 30 }}
      />
    </AppShell>
  );
}
