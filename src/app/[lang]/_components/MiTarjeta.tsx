"use client";

import { useId, useState } from "react";
import { EyebrowLabel } from "./atoms";

/**
 * "Encuentra tu tarjeta Golden" (`#mi-tarjeta`): celular + primer nombre → el
 * link permanente de su tarjeta de sellos en Stampee.
 *
 * Todo lo sensible pasa en el panel (`/api/tarjeta/buscar` → panel): aquí no
 * hay datos de nadie. "No encontrada" no distingue entre número desconocido y
 * nombre errado a propósito, y siempre ofrece pedirla por WhatsApp.
 *
 * En temporada (`season`) la acompaña el muñeco dorado y una línea del
 * calendario de adviento: es a donde lleva el botón de la banda de adviento.
 */

export type MiTarjetaDict = {
  eyebrow: string;
  title1: string;
  title2_em: string;
  body: string;
  phone: string;
  phonePlaceholder: string;
  name: string;
  namePlaceholder: string;
  submit: string;
  searching: string;
  foundTitle: string;
  stamps: string;
  reward: string;
  ready: string;
  open: string;
  copy: string;
  copied: string;
  save: string;
  notFound: string;
  askWhatsapp: string;
  whatsappText: string;
  invalidPhone: string;
  invalidName: string;
  rateLimited: string;
  unavailable: string;
  noCard: string;
  seasonNote: string;
  privacy: string;
  again: string;
};

type Found = { url: string; stamps: number; totalStamps: number; rewardName: string };
type State =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "found"; card: Found }
  | { kind: "error"; message: string; offerWhatsapp: boolean };

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));

export default function MiTarjeta({
  dict,
  whatsappUrl,
  season = false,
}: {
  dict: MiTarjetaDict;
  /** Chat con el estudio y el mensaje ya escrito, o null sin número configurado. */
  whatsappUrl: string | null;
  season?: boolean;
}) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const phoneId = useId();
  const nameId = useId();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const digits = phone.replace(/\D+/g, "");
    if (digits.length < 10) return setState({ kind: "error", message: dict.invalidPhone, offerWhatsapp: false });
    if (name.trim() === "") return setState({ kind: "error", message: dict.invalidName, offerWhatsapp: false });

    setState({ kind: "searching" });
    setCopied(false);
    try {
      const res = await fetch("/api/tarjeta/buscar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, name }),
      });
      if (res.status === 429) return setState({ kind: "error", message: dict.rateLimited, offerWhatsapp: true });
      if (res.status === 400) return setState({ kind: "error", message: dict.invalidPhone, offerWhatsapp: false });
      if (!res.ok) return setState({ kind: "error", message: dict.unavailable, offerWhatsapp: true });
      const data = (await res.json()) as { found: boolean } & Partial<Found>;
      if (data.found && typeof data.url === "string") {
        setState({
          kind: "found",
          card: {
            url: data.url,
            stamps: Number(data.stamps) || 0,
            totalStamps: Number(data.totalStamps) || 0,
            rewardName: data.rewardName ?? "",
          },
        });
      } else {
        setState({ kind: "error", message: dict.notFound, offerWhatsapp: true });
      }
    } catch {
      setState({ kind: "error", message: dict.unavailable, offerWhatsapp: true });
    }
  };

  const onCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      /* sin portapapeles: el link sigue en el botón */
    }
  };

  const inputClass =
    "mt-2 block w-full border bg-paper px-4 py-3.5 font-sans text-[16px] text-ink outline-none transition-colors focus:border-gold";

  return (
    <section id="mi-tarjeta" className="relative bg-cream px-5 py-20 md:px-20 md:py-28" style={{ borderTop: "1px solid var(--hair)" }}>
      <div className="mx-auto grid max-w-[1240px] grid-cols-1 items-center gap-12 md:grid-cols-[1fr_1fr] md:gap-20">
        <div>
          <div className="mb-5 flex items-center gap-3.5">
            <span className="block h-px w-9 bg-gold" aria-hidden />
            <EyebrowLabel className="text-gold">{dict.eyebrow}</EyebrowLabel>
          </div>
          <h2 className="m-0 font-display text-[40px] font-normal leading-[1.02] text-ink md:text-[64px]" style={{ letterSpacing: "-0.02em" }}>
            {dict.title1}
            <br />
            <em className="text-gold-grad italic">{dict.title2_em}</em>
          </h2>
          <p className="m-0 mt-6 max-w-[460px] font-sans text-[15px] leading-[1.65] text-ink-soft">{dict.body}</p>
          {season && (
            <p className="m-0 mt-5 max-w-[460px] font-display text-[18px] italic leading-[1.45] text-gold-dark">
              ✦ {dict.seasonNote}
            </p>
          )}
          <p className="m-0 mt-5 font-display text-[16px] italic text-ink-mute">{dict.noCard}</p>
        </div>

        <div className={`relative ${season ? "mt-12 md:mt-0" : ""}`}>
          {season && (
            // eslint-disable-next-line @next/next/no-img-element -- render 3D de 18 KB, adorno
            <img
              src="/navidad/snowman.webp"
              alt=""
              aria-hidden
              width={70}
              height={84}
              loading="lazy"
              className="gbs-scene-sway pointer-events-none absolute -top-[76px] right-3 z-10 block select-none md:right-6"
            />
          )}
          <div className="relative border bg-paper p-6 md:p-9" style={{ borderColor: "var(--hair)", boxShadow: "0 24px 60px -36px rgba(40,30,20,0.35)" }}>
            {state.kind === "found" ? (
              <FoundCard card={state.card} dict={dict} copied={copied} onCopy={onCopy} onBack={() => setState({ kind: "idle" })} />
            ) : (
              <form onSubmit={onSubmit} noValidate>
                <label htmlFor={phoneId} className="block font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-ink-soft">
                  {dict.phone}
                </label>
                <input
                  id={phoneId}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder={dict.phonePlaceholder}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={20}
                  className={inputClass}
                  style={{ borderColor: "var(--hair)" }}
                />
                <label htmlFor={nameId} className="mt-5 block font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-ink-soft">
                  {dict.name}
                </label>
                <input
                  id={nameId}
                  type="text"
                  autoComplete="given-name"
                  placeholder={dict.namePlaceholder}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={40}
                  className={inputClass}
                  style={{ borderColor: "var(--hair)" }}
                />
                <button
                  type="submit"
                  disabled={state.kind === "searching"}
                  className="bg-gold-grad mt-7 flex w-full cursor-pointer items-center justify-between border-0 px-6 py-4 font-sans text-[12px] font-semibold uppercase tracking-[0.24em] text-white disabled:cursor-wait disabled:opacity-70"
                >
                  {state.kind === "searching" ? dict.searching : dict.submit}
                  <span aria-hidden className="font-display text-[22px] italic leading-none">→</span>
                </button>
                <div aria-live="polite">
                  {state.kind === "error" && (
                    <div className="mt-5 border-l-2 border-gold pl-4">
                      <p className="m-0 font-sans text-[14px] leading-[1.55] text-ink-soft">{state.message}</p>
                      {state.offerWhatsapp && whatsappUrl && (
                        <a
                          href={whatsappUrl}
                          target="_blank"
                          rel="noopener"
                          className="mt-3 inline-block font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-gold-dark underline underline-offset-[5px]"
                        >
                          {dict.askWhatsapp} →
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function FoundCard({
  card,
  dict,
  copied,
  onCopy,
  onBack,
}: {
  card: Found;
  dict: MiTarjetaDict;
  copied: boolean;
  onCopy: (url: string) => void;
  onBack: () => void;
}) {
  const total = Math.max(card.totalStamps, 1);
  const full = card.totalStamps > 0 && card.stamps >= card.totalStamps;
  return (
    <div aria-live="polite">
      <p className="m-0 font-display text-[28px] leading-[1.1] text-ink md:text-[34px]">{dict.foundTitle}</p>
      {/* Los sellos, como en la tarjeta: oro los puestos, hilo los que faltan. */}
      <div className="mt-6 flex flex-wrap gap-2.5" role="img" aria-label={fill(dict.stamps, { stamps: card.stamps, total })}>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`gbs-stamp block h-8 w-8 rounded-full ${i < card.stamps ? "is-on" : ""}`}
            style={{ animationDelay: `${i * 70}ms` }}
          />
        ))}
      </div>
      <p className="m-0 mt-4 font-sans text-[12px] font-semibold uppercase tracking-[0.22em] text-gold-dark">
        {fill(dict.stamps, { stamps: card.stamps, total })}
      </p>
      <p className="m-0 mt-2 font-sans text-[14px] leading-[1.55] text-ink-soft">
        {full ? dict.ready : card.rewardName ? fill(dict.reward, { reward: card.rewardName }) : null}
      </p>
      <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-4">
        <a
          href={card.url}
          target="_blank"
          rel="noopener"
          className="bg-gold-grad inline-flex items-center gap-2.5 px-6 py-4 font-sans text-[12px] font-semibold uppercase tracking-[0.24em] text-white no-underline"
        >
          {dict.open} <span aria-hidden>→</span>
        </a>
        <button
          type="button"
          onClick={() => onCopy(card.url)}
          className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-gold-dark underline underline-offset-[5px]"
        >
          {copied ? dict.copied : dict.copy}
        </button>
      </div>
      <p className="m-0 mt-6 font-display text-[16px] italic leading-[1.45] text-ink-mute">{dict.save}</p>
      <p className="m-0 mt-1 font-sans text-[12px] text-ink-mute">{dict.privacy}</p>
      <button
        type="button"
        onClick={onBack}
        className="mt-5 cursor-pointer border-0 bg-transparent p-0 font-sans text-[11px] uppercase tracking-[0.2em] text-ink-mute underline underline-offset-4"
      >
        ← {dict.again}
      </button>
    </div>
  );
}
