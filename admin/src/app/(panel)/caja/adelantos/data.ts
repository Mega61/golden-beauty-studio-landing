import "server-only";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import { instantToEaDate } from "@/lib/ea";

import { depositViewOf, type DepositView } from "./view";

/** Cuántos se muestran. Una temporada entera cabe de sobra. */
const LIMIT = 300;

export type AdelantosView = {
  today: string;
  /** Plata recibida por citas que todavía no se cobran: lo que se le debe a las clientas. */
  porUsar: DepositView[];
  /** El resto: usados en su cuenta o devueltos. */
  historial: DepositView[];
};

export async function loadAdelantosView(now: Date = new Date()): Promise<AdelantosView> {
  const repos = repositories(getDb());
  const rows = await repos.appointmentDeposits.listRecent(LIMIT);
  const closed = await repos.appointmentFinance.findClosedEaIds([
    ...new Set(rows.map((row) => row.ea_appointment_id)),
  ]);
  const views = rows.map((row) => depositViewOf(row, closed.has(row.ea_appointment_id)));
  return {
    today: instantToEaDate(now),
    // Por usar, la cita más cercana primero: es la que se cobra antes.
    porUsar: views
      .filter((view) => view.state === "pendiente")
      .sort((a, b) => (a.appointmentStart ?? "9").localeCompare(b.appointmentStart ?? "9") || a.id - b.id),
    historial: views.filter((view) => view.state !== "pendiente"),
  };
}
