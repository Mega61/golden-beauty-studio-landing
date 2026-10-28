"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { StagePill, StampDots, stageLabel } from "@/components/loyalty/StampDots";
import { Card, CardHead, Icon } from "@/components/ui";
import type { CampaignStats, LoyaltyCard } from "@/lib/stampee/model";

import styles from "./fidelidad.module.css";
import { RedeemButton } from "./RedeemButton";

export type FidelidadRow = {
  key: string;
  clientName: string;
  mobile: string | null;
  /** La ficha del panel, si el celular de Stampee es un número usable. */
  fichaHref: string | null;
  /** La tarjeta pública en Stampee, como la ve la clienta. */
  cardUrl: string | null;
  card: LoyaltyCard;
};

type Filtro = "todas" | "lista" | "cerca" | "en-curso";

const FILTROS: Array<{ value: Filtro; label: string }> = [
  { value: "todas", label: "Todas" },
  { value: "lista", label: "Premio listo" },
  { value: "cerca", label: "A punto" },
  { value: "en-curso", label: "En curso" },
];

/** Sin tildes ni mayúsculas, para que "sofia" encuentre a "Sofía". */
function plain(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function FidelidadVista({
  rows,
  campaigns,
  redeemedTotal,
  canRedeem,
}: {
  rows: FidelidadRow[];
  campaigns: CampaignStats[];
  redeemedTotal: number;
  canRedeem: boolean;
}) {
  const [query, setQuery] = useState("");
  const [filtro, setFiltro] = useState<Filtro>("todas");
  const [campaign, setCampaign] = useState<string>("todas");

  const listas = rows.filter((r) => r.card.stage === "lista");
  const cerca = rows.filter((r) => r.card.stage === "cerca");
  const withCards = campaigns.filter((c) => c.active > 0 || c.canjeadas > 0 || c.enabled);

  const filtered = useMemo(() => {
    const q = plain(query.trim());
    const digits = query.replace(/\D/g, "");
    return rows.filter(
      (r) =>
        (filtro === "todas" || r.card.stage === filtro) &&
        (campaign === "todas" || r.card.campaignId === campaign) &&
        (q === "" ||
          plain(r.clientName).includes(q) ||
          (digits.length >= 3 && (r.mobile ?? "").replace(/\D/g, "").includes(digits))),
    );
  }, [rows, query, filtro, campaign]);

  return (
    <>
      <div className={styles.kpis}>
        <Kpi etiqueta="Premio listo" valor={listas.length} tono={listas.length > 0 ? "ok" : undefined} nota="tarjeta llena, sin aplicar" />
        <Kpi etiqueta="A punto" valor={cerca.length} tono={cerca.length > 0 ? "warn" : undefined} nota="les faltan 1 o 2 sellos" />
        <Kpi etiqueta="Tarjetas activas" valor={rows.length} />
        <Kpi etiqueta="Premios aplicados" valor={redeemedTotal} nota="desde que empezó Stampee" />
      </div>

      <Card padded={false}>
        <CardHead title="Premio listo para aplicar" />
        {listas.length === 0 ? (
          <p className={styles.empty}>
            Nadie tiene la tarjeta llena ahora. Cuando alguien complete sus sellos aparece acá, y en
            Hoy sale marcada el día de su cita.
          </p>
        ) : (
          <ul className={styles.list}>
            {listas.map((row) => (
              <Fila key={row.key} row={row} canRedeem={canRedeem} />
            ))}
          </ul>
        )}
      </Card>

      {cerca.length === 0 ? null : (
        <Card padded={false}>
          <CardHead title="A punto del premio" />
          <p className={styles.lead}>
            Les falta una o dos visitas. Buenas candidatas para un mensaje: “te falta un sello para tu
            premio”.
          </p>
          <ul className={styles.list}>
            {cerca.map((row) => (
              <Fila key={row.key} row={row} canRedeem={false} />
            ))}
          </ul>
        </Card>
      )}

      {withCards.length === 0 ? null : (
        <div className={styles.campaigns}>
          {withCards.map((c) => (
            <Campana key={c.id} campaign={c} />
          ))}
        </div>
      )}

      <Card padded={false}>
        <CardHead title="Todas las tarjetas" />
        <div className={styles.tools}>
          <input
            className="ui-input"
            type="search"
            placeholder="Buscar por nombre o celular"
            aria-label="Buscar por nombre o celular"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className={styles.toolsRow}>
            <div className="ui-seg" role="radiogroup" aria-label="Etapa">
              {FILTROS.map((f) => (
                <label key={f.value} className="ui-seg__item">
                  <input
                    type="radio"
                    name="etapa"
                    value={f.value}
                    checked={filtro === f.value}
                    onChange={() => setFiltro(f.value)}
                  />
                  {f.label}
                </label>
              ))}
            </div>
            {withCards.length > 1 ? (
              <select
                className="ui-select"
                aria-label="Campaña"
                value={campaign}
                onChange={(e) => setCampaign(e.target.value)}
              >
                <option value="todas">Todas las campañas</option>
                {withCards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>
        {filtered.length === 0 ? (
          <p className={styles.empty}>Ninguna tarjeta coincide.</p>
        ) : (
          <ul className={styles.list}>
            {filtered.map((row) => (
              <Fila key={row.key} row={row} canRedeem={canRedeem} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Fila({ row, canRedeem }: { row: FidelidadRow; canRedeem: boolean }) {
  const { card } = row;
  const gifted = card.gifted.welcome + card.gifted.winBack;
  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowHead}>
          {row.fichaHref ? (
            <Link href={row.fichaHref} className={styles.name}>
              {row.clientName}
            </Link>
          ) : (
            <span className={styles.name}>{row.clientName}</span>
          )}
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
            card.campaignName,
            card.rewardName ? `Premio: ${card.rewardName}` : null,
            gifted > 0 ? `${card.fromVisits} por visitas, ${gifted} de regalo` : null,
            card.lastVisitAt ? `último sello ${fechaCorta(card.lastVisitAt)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <div className={styles.rowActions}>
        {canRedeem && card.stage === "lista" ? (
          <RedeemButton cardId={card.id} customerName={row.clientName} rewardName={card.rewardName} />
        ) : null}
        {row.cardUrl ? (
          <a
            className="ui-btn ui-btn--ghost ui-btn--sm"
            href={row.cardUrl}
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
}

/**
 * Dónde está parada la clientela de una campaña: una columna por cantidad de
 * sellos, de 0 a la meta. La última columna —tarjeta llena— va en verde: es
 * gente esperando su premio.
 */
function Campana({ campaign }: { campaign: CampaignStats }) {
  const max = Math.max(...campaign.distribution, 1);
  const last = campaign.distribution.length - 1;
  return (
    <Card padded={false}>
      <div className={styles.campaign}>
        <div className={styles.campaignHead}>
          <h3 className={styles.campaignName}>{campaign.name}</h3>
          {campaign.enabled ? null : <span className={styles.off}>pausada</span>}
        </div>
        <p className={styles.meta}>
          {campaign.totalStamps} sellos
          {campaign.rewardName ? ` · Premio: ${campaign.rewardName}` : ""}
        </p>
        <div
          className={styles.chart}
          role="img"
          aria-label={`Tarjetas activas por sellos: ${campaign.distribution
            .map((n, i) => `${i} sellos, ${n}`)
            .join("; ")}`}
        >
          {campaign.distribution.map((n, i) => (
            <div key={i} className={styles.col} data-full={i === last ? "true" : undefined}>
              <span className={`ui-num ${styles.colCount}`}>{n > 0 ? n : ""}</span>
              <span className={styles.colBar} style={{ height: `${(n / max) * 100}%` }} />
              <span className={`ui-num ${styles.colLabel}`}>{i}</span>
            </div>
          ))}
        </div>
        <p className={styles.meta}>
          {campaign.active} activas · {campaign.lista} con premio listo · {campaign.cerca} a punto ·{" "}
          {campaign.canjeadas} premios aplicados
        </p>
      </div>
    </Card>
  );
}

function Kpi({
  etiqueta,
  valor,
  nota,
  tono,
}: {
  etiqueta: string;
  valor: number;
  nota?: string;
  tono?: "ok" | "warn";
}) {
  return (
    <div className={`ui-card ${styles.kpi}`} data-tone={tono}>
      <span className={styles.kpiLabel}>{etiqueta}</span>
      <span className={`ui-num ${styles.kpiValue}`}>{valor}</span>
      {nota ? <span className={styles.meta}>{nota}</span> : null}
    </div>
  );
}

function fechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString("es-CO", {
    day: "numeric",
    month: "short",
    timeZone: "America/Bogota",
  });
}
