"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { Button, Checkbox, Field, Select, TextArea, TextInput, useToast } from "@/components/ui";
import type { EaLocalDate } from "@/lib/ea";
import {
  addCalendarDays,
  DEFAULT_WINBACK_TEMPLATE,
  formatDayMonth,
  renderWinbackMessage,
  WINBACK_BOOKING_URL,
  WINBACK_FIELDS,
  type WinbackCandidate,
} from "@/lib/winback";

import { openWhatsappAfter } from "../../recordatorios/open-whatsapp";
import { enviarRegalo, guardarConfigRecuperar } from "./actions";
import type { CampaignOption, WinbackSettings } from "./data";

const soft: React.CSSProperties = { margin: 0, fontSize: "var(--text-sm)", color: "var(--color-ink-soft)" };

/** 10 % es el de primera visita (`FIRST_VISIT_PERCENT`); acá solo para la vista previa. */
const PREVIEW_PERCENT = "10";

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

  return (
    <>
      <section className="ui-card">
        <header className="ui-card__head">
          <h2 className="ui-card__title">Te extrañamos</h2>
        </header>
        <div style={{ display: "grid", gap: "0.75rem", padding: "0.75rem 1rem 1rem" }}>
          <p style={soft}>
            Clientas que no vienen hace más de <strong>{settings.lapsedDays} días</strong> y no tienen cita. El
            botón les crea una tarjeta de sellos nueva
            {campaign ? (
              <>
                {" "}
                de <strong>{campaign.name}</strong> con <strong>{campaign.bonusStamps} sellos de regalo</strong>
              </>
            ) : null}
            {settings.discountEnabled ? <> y les deja el 10 % en su próxima cita, como si fuera la primera</> : null}
            , y abre WhatsApp con el mensaje listo. Unas 20 al día se pueden atender bien.
          </p>
          <p className="ui-num" style={{ margin: 0, fontSize: "var(--text-sm)" }}>
            <strong>{pending.length}</strong> por recuperar · <strong>{sent.length}</strong> con regalo ·{" "}
            <strong>{cameBack}</strong> volvieron
          </p>
          {stampeeProblem ? (
            <div className="ui-callout" role="status">
              {stampeeProblem} Sin Stampee no se puede emitir la tarjeta.
            </div>
          ) : campaign === null ? (
            <div className="ui-callout" role="status">
              {canConfigure
                ? "Elige abajo la campaña de Stampee de la que salen las tarjetas de regalo."
                : "Falta que la dueña elija la campaña de Stampee de las tarjetas de regalo."}
            </div>
          ) : !campaign.enabled ? (
            <div className="ui-callout" role="status">
              La campaña “{campaign.name}” está apagada en Stampee. Actívala para poder emitir tarjetas.
            </div>
          ) : null}
        </div>
      </section>

      <PeopleList
        title="Por recuperar"
        empty="Nadie por recuperar con estos días. ¡Bien!"
        people={pending}
        disabled={!ready}
      />
      {sent.length > 0 ? (
        <PeopleList title="Ya tienen el regalo" empty="" people={sent} disabled={!ready} />
      ) : null}

      {canConfigure ? <ConfigForm today={today} settings={settings} campaigns={campaigns} /> : null}
    </>
  );
}

function lastVisitText(person: WinbackCandidate): string {
  if (person.lastAttended === null) return "—";
  const date = person.lastAttended.slice(0, 10);
  const year = date.slice(0, 4);
  return `${formatDayMonth(date)} ${year} · hace ${person.daysAway} días`;
}

function PeopleList({
  title,
  empty,
  people,
  disabled,
}: {
  title: string;
  empty: string;
  people: WinbackCandidate[];
  disabled: boolean;
}) {
  return (
    <section className="ui-card">
      <header className="ui-card__head">
        <h2 className="ui-card__title">
          {title} <span className="ui-num">({people.length})</span>
        </h2>
      </header>
      {people.length === 0 ? (
        <p style={{ ...soft, padding: "0.75rem 1rem 1rem" }}>{empty}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {people.map((person) => (
            <li
              key={person.phone}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "0.5rem 1rem",
                padding: "0.65rem 1rem",
                borderTop: "1px solid var(--color-ivory-deep)",
              }}
            >
              <div style={{ flex: "1 1 14rem", minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {`${person.firstName} ${person.lastName}`.trim() || person.phone}
                </div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
                  Última visita {lastVisitText(person)} · {person.visits} visita{person.visits === 1 ? "" : "s"}
                  {person.sent ? (
                    <>
                      {" "}
                      · regalo el {formatDayMonth(person.sent.sentAt.slice(0, 10))}
                      {person.sent.cameBack ? <strong> · volvió ✓</strong> : null}
                    </>
                  ) : null}
                </div>
              </div>
              {person.sent?.cameBack ? null : (
                <SendGiftButton phone={person.phone} sent={person.sent !== null} disabled={disabled} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
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

function ConfigForm({
  today,
  settings,
  campaigns,
}: {
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
        link: "https://…/tarjeta?src=whatsapp",
        reservar: WINBACK_BOOKING_URL,
      }),
    [template, campaign, discountEnabled, valid, today],
  );

  function save(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await guardarConfigRecuperar({
        campaignId,
        template,
        discountEnabled,
        validDays: Number(validDays) || 0,
        lapsedDays: Number(lapsedDays) || 0,
      });
      toast({ message: result.message, tone: result.ok ? "ok" : "error" });
      if (result.ok) router.refresh();
    });
  }

  return (
    <section className="ui-card">
      <header className="ui-card__head">
        <h2 className="ui-card__title">Configuración</h2>
      </header>
      <form onSubmit={save} style={{ display: "grid", gap: "1rem", padding: "0.75rem 1rem 1rem", maxWidth: "44rem" }}>
        <Field
          label="Campaña de Stampee"
          hint="La tarjeta nace con los sellos de regalo que tenga la campaña en Stampee. Créala allá primero."
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
          hint="Mismas reglas que la primera visita: solo servicios, no se suma a otra promo (gana la mayor). La cuenta y la reserva en línea lo ponen solas."
          checked={discountEnabled}
          onChange={(e) => setDiscountEnabled(e.target.checked)}
        />

        <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
          <div style={{ flex: "1 1 12rem" }}>
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
          </div>
          <div style={{ flex: "1 1 12rem" }}>
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
        </div>

        <Field
          label="Mensaje"
          hint={`Campos: ${WINBACK_FIELDS.map((f) => `{${f.key}} ${f.help}`).join(" · ")}. Un renglón con un campo vacío no sale. Sin precios.`}
        >
          {(ids) => (
            <TextArea {...ids} rows={11} value={template} onChange={(e) => setTemplate(e.target.value)} />
          )}
        </Field>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <Button type="button" variant="ghost" size="sm" onClick={() => setTemplate(DEFAULT_WINBACK_TEMPLATE)}>
            Volver al mensaje sugerido
          </Button>
        </div>

        <div>
          <div className="ui-label">Así le llega</div>
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              fontFamily: "inherit",
              fontSize: "var(--text-sm)",
              padding: "0.75rem",
              borderRadius: "var(--radius-md)",
              background: "var(--color-ivory)",
            }}
          >
            {preview}
          </pre>
        </div>

        <div>
          <Button type="submit" loading={pending}>
            Guardar
          </Button>
        </div>
      </form>
    </section>
  );
}
