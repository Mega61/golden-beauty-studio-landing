import "server-only";

import { getDb } from "@/db/client";
import { waMessageRepository, winbackRepository, type WinbackConfigRow } from "@/db/repositories";
import { instantToEaLocal, type EaLocalDate, type EaLocalDateTime } from "@/lib/ea";
import { loadLoyalty } from "@/lib/stampee/client";
import {
  DEFAULT_LAPSED_DAYS,
  DEFAULT_VALID_DAYS,
  DEFAULT_WINBACK_TEMPLATE,
  selectWinbackCandidates,
  type WinbackCandidate,
  type WinbackSent,
} from "@/lib/winback";

import { loadMetaAudience } from "../meta-export-data";

/**
 * Lo que necesita `/clientes/recuperar`.
 *
 * La lista sale de la misma audiencia que la exportación para Meta
 * (`loadMetaAudience()`: EA por SQL de solo lectura + el histórico de Agenda
 * Pro, unidos por teléfono). El histórico entra a propósito: casi todas las
 * clientas que se fueron vinieron antes del corte del 2026-10-24, y sin él esta
 * lista estaría vacía. Se lee para saber **a quién** y **cuándo vino por última
 * vez**, nunca plata (`AGENTS.md` § Recuperar clientas).
 */

export type WinbackSettings = {
  campaignId: string | null;
  template: string;
  discountEnabled: boolean;
  validDays: number | null;
  lapsedDays: number;
  saved: boolean;
};

export function settingsFrom(row: WinbackConfigRow | null): WinbackSettings {
  if (row === null) {
    return {
      campaignId: null,
      template: DEFAULT_WINBACK_TEMPLATE,
      discountEnabled: true,
      validDays: DEFAULT_VALID_DAYS,
      lapsedDays: DEFAULT_LAPSED_DAYS,
      saved: false,
    };
  }
  return {
    campaignId: row.stampeeCampaignId,
    template: row.messageTemplate?.trim() ? row.messageTemplate : DEFAULT_WINBACK_TEMPLATE,
    discountEnabled: row.discountEnabled,
    validDays: row.validDays,
    lapsedDays: row.lapsedDays,
    saved: true,
  };
}

export type CampaignOption = {
  id: string;
  name: string;
  enabled: boolean;
  totalStamps: number;
  bonusStamps: number;
  rewardName: string;
};

export type RecuperarLoad =
  | {
      ok: true;
      today: EaLocalDate;
      settings: WinbackSettings;
      pending: WinbackCandidate[];
      sent: WinbackCandidate[];
      campaigns: CampaignOption[];
      /** Stampee no respondió: la lista se ve, pero no se puede mandar. */
      stampeeProblem: string | null;
    }
  | { ok: false; message: string };

export async function loadRecuperar(now: Date = new Date()): Promise<RecuperarLoad> {
  const db = getDb();
  const [audience, configRow, offers, loyalty] = await Promise.all([
    loadMetaAudience(now),
    winbackRepository(db).getConfig(),
    winbackRepository(db).listOffers(),
    loadLoyalty(),
  ]);
  if (!audience.ok) return { ok: false, message: audience.message };

  const settings = settingsFrom(configRow);
  const people = audience.audience.people;
  const optedOut = await waMessageRepository(db).listOptedOut(people.map((p) => p.phone));

  const lastByPhone = new Map<string, EaLocalDateTime | null>(people.map((p) => [p.phone, p.lastAttended]));
  const sent = new Map<string, WinbackSent>();
  for (const offer of offers) {
    const sentAt = instantToEaLocal(offer.sentAt);
    const last = lastByPhone.get(offer.phone) ?? null;
    sent.set(offer.phone, { sentAt, cameBack: last !== null && last > sentAt });
  }

  const { pending, sent: sentRows } = selectWinbackCandidates({
    people,
    today: audience.today,
    lapsedDays: settings.lapsedDays,
    optedOut,
    sent,
  });

  return {
    ok: true,
    today: audience.today,
    settings,
    pending,
    sent: sentRows,
    campaigns: loyalty.ok
      ? loyalty.data.campaigns.map((c) => ({
          id: c.id,
          name: c.name,
          enabled: c.enabled,
          totalStamps: c.totalStamps,
          bonusStamps: c.bonusStamps,
          rewardName: c.rewardName,
        }))
      : [],
    stampeeProblem: loyalty.ok ? null : loyalty.message,
  };
}
