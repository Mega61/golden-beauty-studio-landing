"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";

import { Button, Card, CardHead, Checkbox, Field, Panel, Select, TextArea, TextInput, useToast } from "@/components/ui";
import type { EaLocalDate } from "@/lib/ea";
import {
  addCalendarDays,
  DEFAULT_WINBACK_TEMPLATE,
  displayPhone,
  filterWinback,
  formatDayMonth,
  renderWinbackMessage,
  WINBACK_BOOKING_URL,
  WINBACK_FIELDS,
  WINBACK_OUTCOMES,
  WINBACK_RANGES,
  WINBACK_SORTS,
  type WinbackCandidate,
  type WinbackOutcome,
  type WinbackRange,
  type WinbackSort,
} from "@/lib/winback";

import { openWhatsappAfter } from "../../recordatorios/open-whatsapp";
import { enviarRegalo, guardarConfigRecuperar } from "./actions";
import type { CampaignOption, WinbackSettings } from "./data";
import styles from "./recuperar.module.css";

/** 10 % es el de primera visita (`FIRST_VISIT_PERCENT`); acá solo para la vista previa. */
const PREVIEW_PERCENT = "10";
/** Filas por tanda: una lista de cien renglones no se recorre, se busca. */
const PAGE = 40;

type Tab = "pendientes" | "enviadas";

export function RecuperarVista({
  canConfigure,
  today,
  settings,
  pending,
  sent,
  campaigns,
  stampeeProblem,
}: {
  canConfigure: boolean;
  today: EaLocalDate;
  settings: WinbackSettings;
  pending: WinbackCandidate[];
  sent: WinbackCandidate[];
  campaigns: CampaignOption[];
  stampeeProblem: string | null;
}) {
  const campaign = campaigns.find((c) => c.id === settings.campaignId) ?? null;
  const ready = campaign !== null && campaign.enabled && stampeeProblem === null;
  const cameBack = sent.filter((p) => p.sent?.cameBack).length;
  const [configOpen, setConfigOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("pendientes");

  return (
    <div className={styles.page}>
      <Card padded={false}>
        <CardHead
          title="Te extrañamos"
          actions={
            canConfigure ? (
              <Button variant="secondary" size="sm" icon="ajustes" onClick={() => setConfigOpen(true)}>
                Configuración
              </Button>
            ) : null
          }
        />
        <div className={styles.intro}>
          <p className={styles.lead}>
            Clientas que no vienen hace más de <strong>{settings.lapsedDays} días</strong> y no tienen cita. El botón
            les crea una tarjeta nueva
            {campaign ? (
              <>
                {" "}
                de <strong>{campaign.name}</strong> con <strong>{campaign.bonusStamps} sellos de regalo</strong>
              </>
            ) : null}
            {settings.discountEnabled ? <> y les deja el 10 % en su próxima cita</> : null}, y abre WhatsApp con el
            mensaje listo. Unas 20 al día se atienden bien.
          </p>
          <div className={styles.kpis}>
            <Kpi label="Por recuperar" value={pending.length} />
            <Kpi label="Con regalo" value={sent.length} />
            <Kpi label="Volvieron" value={cameBack} tone={cameBack > 0 ? "ok" : undefined} />
          </div>
          {stampeeProblem ? (
            <div className="ui-callout" role="status">
              {stampeeProblem} Sin Stampee no se puede emitir la tarjeta.
            </div>
          ) : campaign === null ? (
            <div className="ui-callout" role="status">
              {canConfigure ? (
                <>
                  Falta elegir la campaña de Stampee.{" "}
                  <Button variant="secondary" size="sm" onClick={() => setConfigOpen(true)}>
                    Abrir la configuración
                  </Button>
                </>
              ) : (
                "Falta que la dueña elija la campaña de Stampee de las tarjetas de regalo."
              )}
            </div>
          ) : !campaign.enabled ? (
            <div className="ui-callout" role="status">
              La campaña “{campaign.name}” está apagada en Stampee. Actívala para poder emitir tarjetas.
            </div>
          ) : null}
        </div>
      </Card>

      <Card padded={false}>
        <div className={styles.tools}>
          <div className="ui-seg" role="tablist" aria-label="Lista">
            <button
              type="button"
              role="tab"
              className="ui-seg__item"
              aria-selected={tab === "pendientes"}
              aria-current={tab === "pendientes" ? "true" : undefined}
              onClick={() => setTab("pendientes")}
            >
              Por recuperar ({pending.length})
            </button>
            <button
              type="button"
              role="tab"
              className="ui-seg__item"
              aria-selected={tab === "enviadas"}
              aria-current={tab === "enviadas" ? "true" : undefined}
              onClick={() => setTab("enviadas")}
            >
              Con regalo ({sent.length})
            </button>
          </div>
        </div>
        {tab === "pendientes" ? (
          <PendingList people={pending} disabled={!ready} />
        ) : (
          <SentList people={sent} disabled={!ready} />
        )}
      </Card>

      {canConfigure ? (
        <ConfigPanel
          open={configOpen}
          onClose={() => setConfigOpen(false)}
          today={today}
          settings={settings}
          campaigns={campaigns}
        />
      ) : null}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "ok" }) {
  return (
    <div className={styles.kpi} data-tone={tone}>
      <span className={styles.kpiLabel}>{label}</span>
      <span className={`${styles.kpiValue} ui-num`}>{value}</span>
    </div>
  );
}

function Seg<T extends string>({
  label,
  name,
  options,
  value,
  onChange,
}: {
  label: string;
  name: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="ui-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className="ui-seg__item">
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function useShown<T>(rows: T[]) {
  const [limit, setLimit] = useState(PAGE);
  return { shown: rows.slice(0, limit), more: rows.length - limit, showMore: () => setLimit((l) => l + PAGE) };
}

function PendingList({ people, disabled }: { people: WinbackCandidate[]; disabled: boolean }) {
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<WinbackRange>("todas");
  const [sort, setSort] = useState<WinbackSort>("visitas");
  const rows = useMemo(() => filterWinback(people, { query, range, sort }), [people, query, range, sort]);
  const { shown, more, showMore } = useShown(rows);

  return (
    <>
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
          <Seg label="Sin venir" name="rango" options={WINBACK_RANGES} value={range} onChange={setRange} />
          <select
            className="ui-select"
            aria-label="Orden"
            value={sort}
            onChange={(e) => setSort(e.target.value as WinbackSort)}
          >
            {WINBACK_SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <p className={styles.count}>
          {rows.length === people.length ? `${people.length} clientas` : `${rows.length} de ${people.length} clientas`}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className={styles.empty}>
          {people.length === 0 ? "Nadie por recuperar con estos días. ¡Bien!" : "Ninguna clienta coincide."}
        </p>
      ) : (
        <ul className={styles.list}>
          {shown.map((p) => (
            <Row key={p.phone} person={p} disabled={disabled} />
          ))}
        </ul>
      )}
      {more > 0 ? (
        <div className={styles.more}>
          <Button variant="ghost" size="sm" onClick={showMore}>
            Ver {Math.min(more, PAGE)} más
          </Button>
        </div>
      ) : null}
    </>
  );
}

function SentList({ people, disabled }: { people: WinbackCandidate[]; disabled: boolean }) {
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<WinbackOutcome>("todas");
  const rows = useMemo(() => filterWinback(people, { query, outcome }), [people, query, outcome]);
  const { shown, more, showMore } = useShown(rows);

  return (
    <>
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
          <Seg label="Resultado" name="resultado" options={WINBACK_OUTCOMES} value={outcome} onChange={setOutcome} />
        </div>
        <p className={styles.count}>
          {rows.length === people.length ? `${people.length} clientas` : `${rows.length} de ${people.length} clientas`}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className={styles.empty}>
          {people.length === 0 ? "Todavía no se le ha mandado el regalo a nadie." : "Ninguna clienta coincide."}
        </p>
      ) : (
        <ul className={styles.list}>
          {shown.map((p) => (
            <Row key={p.phone} person={p} disabled={disabled} />
          ))}
        </ul>
      )}
      {more > 0 ? (
        <div className={styles.more}>
          <Button variant="ghost" size="sm" onClick={showMore}>
            Ver {Math.min(more, PAGE)} más
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Row({ person, disabled }: { person: WinbackCandidate; disabled: boolean }) {
  const name = `${person.firstName} ${person.lastName}`.trim();
  const last = person.lastAttended?.slice(0, 10);
  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowHead}>
          <Link href={`/clientes/${person.phone.slice(1)}`} className={styles.name}>
            {name || displayPhone(person.phone)}
          </Link>
          {name ? <span className={`${styles.phone} ui-num`}>{displayPhone(person.phone)}</span> : null}
          {person.sent ? (
            <span className={styles.pill} data-tone={person.sent.cameBack ? "ok" : undefined}>
              {person.sent.cameBack ? "Volvió" : "Esperando"}
            </span>
          ) : null}
        </div>
        <p className={styles.meta}>
          {[
            last ? `Última visita ${formatDayMonth(last)} ${last.slice(0, 4)} · hace ${person.daysAway} días` : null,
            `${person.visits} visita${person.visits === 1 ? "" : "s"}`,
            person.sent ? `regalo el ${formatDayMonth(person.sent.sentAt.slice(0, 10))}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      {person.sent?.cameBack ? null : (
        <div className={styles.rowActions}>
          <SendGiftButton phone={person.phone} sent={person.sent !== null} disabled={disabled} />
        </div>
      )}
    </li>
  );
}

/**
 * "Enviar regalo": la pestaña de WhatsApp se abre en el mismo toque
 * (`openWhatsappAfter`), porque el link llega después de emitir la tarjeta y
 * anotar el envío, y Safari bloquea un `window.open` tardío.
 */
function SendGiftButton({ phone, sent, disabled }: { phone: string; sent: boolean; disabled: boolean }) {
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick() {
    const opening = openWhatsappAfter(() => enviarRegalo(phone));
    startTransition(async () => {
      try {
        const { result, opened } = await opening;
        if (!result.ok) {
          toast({ message: result.message, tone: "error" });
          return;
        }
        if (!opened) toast({ message: "El navegador no dejó abrir WhatsApp. Toca de nuevo.", tone: "error" });
        router.refresh();
      } catch {
        toast({ message: "No se pudo preparar el mensaje. Intenta de nuevo.", tone: "error" });
      }
    });
  }

  return (
    <Button
      variant={sent ? "ghost" : "primary"}
      size="sm"
      icon="whatsapp"
      loading={pending}
      disabled={disabled}
      onClick={onClick}
    >
      {sent ? "Reenviar" : "Enviar regalo"}
    </Button>
  );
}

function ConfigPanel({
  open,
  onClose,
  today,
  settings,
  campaigns,
}: {
  open: boolean;
  onClose: () => void;
  today: EaLocalDate;
  settings: WinbackSettings;
  campaigns: CampaignOption[];
}) {
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [campaignId, setCampaignId] = useState(settings.campaignId ?? "");
  const [template, setTemplate] = useState(settings.template);
  const [discountEnabled, setDiscountEnabled] = useState(settings.discountEnabled);
  const [validDays, setValidDays] = useState(String(settings.validDays ?? 0));
  const [lapsedDays, setLapsedDays] = useState(String(settings.lapsedDays));
  const textarea = useRef<HTMLTextAreaElement>(null);

  const campaign = campaigns.find((c) => c.id === campaignId) ?? null;
  const valid = Number(validDays);
  const preview = useMemo(
    () =>
      renderWinbackMessage(template, {
        nombre: "Laura",
        sellos: String(campaign?.bonusStamps ?? 3),
        meta: String(campaign?.totalStamps ?? 8),
        premio: campaign?.rewardName || null,
        descuento: discountEnabled ? PREVIEW_PERCENT : null,
        vence: discountEnabled && valid > 0 ? formatDayMonth(addCalendarDays(today, valid)) : null,
        link: "https://loyalty.goldenbeautystudio.com.co/golden-beauty/…",
        reservar: WINBACK_BOOKING_URL,
      }),
    [template, campaign, discountEnabled, valid, today],
  );

  /** Mete `{campo}` donde está el cursor del mensaje. */
  function insertField(key: string) {
    const el = textarea.current;
    const token = `{${key}}`;
    if (!el) return setTemplate((t) => t + token);
    const start = el.selectionStart ?? template.length;
    const end = el.selectionEnd ?? template.length;
    setTemplate(template.slice(0, start) + token + template.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function save() {
    startTransition(async () => {
      const result = await guardarConfigRecuperar({
        campaignId,
        template,
        discountEnabled,
        validDays: Number(validDays) || 0,
        lapsedDays: Number(lapsedDays) || 0,
      });
      toast({ message: result.message, tone: result.ok ? "ok" : "error" });
      if (result.ok) {
        onClose();
        router.refresh();
      }
    });
  }

  return (
    <Panel
      open={open}
      onClose={onClose}
      title="Configuración de Te extrañamos"
      footer={
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" loading={pending} onClick={save}>
            Guardar
          </Button>
        </div>
      }
    >
      <div className={styles.form}>
        <Field
          label="Campaña de Stampee"
          hint="La tarjeta nace con los sellos de regalo de la campaña. Se crea en Stampee."
        >
          {(ids) => (
            <Select {...ids} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">— Elige una campaña —</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.bonusStamps} de {c.totalStamps} sellos de regalo
                  {c.enabled ? "" : " (apagada)"}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Checkbox
          label="10 % en su próxima cita, como primera visita"
          hint="Solo servicios y no se suma a otra promo (gana la mayor). La cuenta y la reserva en línea lo ponen solas."
          checked={discountEnabled}
          onChange={(e) => setDiscountEnabled(e.target.checked)}
        />

        <div className={styles.pair}>
          <Field label="Días para usar el descuento" hint="0 = no vence.">
            {(ids) => (
              <TextInput
                {...ids}
                inputMode="numeric"
                value={validDays}
                disabled={!discountEnabled}
                onChange={(e) => setValidDays(e.target.value.replace(/\D/g, ""))}
              />
            )}
          </Field>
          <Field label="Por recuperar después de" hint="Días sin venir. Mínimo 14.">
            {(ids) => (
              <TextInput
                {...ids}
                inputMode="numeric"
                value={lapsedDays}
                onChange={(e) => setLapsedDays(e.target.value.replace(/\D/g, ""))}
              />
            )}
          </Field>
        </div>

        <Field label="Mensaje" hint="Un renglón con un campo vacío no sale. Sin precios.">
          {(ids) => (
            <TextArea {...ids} ref={textarea} rows={9} value={template} onChange={(e) => setTemplate(e.target.value)} />
          )}
        </Field>
        <div>
          <div className="ui-label">Insertar campo</div>
          <div className={styles.fields}>
            {WINBACK_FIELDS.map((f) => (
              <button key={f.key} type="button" className={styles.field} title={f.help} onClick={() => insertField(f.key)}>
                {`{${f.key}}`}
              </button>
            ))}
            <button type="button" className={styles.field} onClick={() => setTemplate(DEFAULT_WINBACK_TEMPLATE)}>
              Restaurar sugerido
            </button>
          </div>
        </div>

        <div>
          <div className="ui-label">Así le llega</div>
          <pre className={styles.preview}>{preview}</pre>
        </div>
      </div>
    </Panel>
  );
}
