"use client";

import { useEffect, useId, useRef, useState } from "react";
import Script from "next/script";
import { careersConfig, siteConfig } from "@/config/site";
import {
  trackApplyError,
  trackApplyStep,
  trackApplySubmit,
  type ApplySurface,
} from "@/lib/analytics";
import type { Locale } from "../dictionaries";
import type { JobRole } from "@/data/careers.types";

/* ── copy contract ────────────────────────────────────────────────────────── */

type FieldCopy = { label: string; placeholder?: string };

export type TrabajaFormDict = {
  name: FieldCopy;
  phone: FieldCopy;
  email: FieldCopy;
  /** Only a label — the options themselves are CMS-configured cargos. */
  role: { label: string };
  experience: { label: string; options: Record<string, string> };
  techniques: { label: string; hint: string; options: Record<string, string> };
  portfolio: FieldCopy;
  message: FieldCopy;
  cv: {
    label: string;
    hint: string;
    button: string;
    change: string;
    drop: string;
  };
  consent: string;
  optional: string;
  submit: string;
  sending: string;
};

export type TrabajaDict = {
  eyebrow: string;
  title1: string;
  title2_em: string;
  body: string;
  perks: string[];
  photoAlt: string;
  flow: {
    steps: string[];
    counter: string;
    next: string;
    back: string;
    reassurance: string;
  };
  form: TrabajaFormDict;
  fieldErrors: Record<string, string>;
  success: { title: string; body: string; again: string };
  errors: {
    validation: string;
    file_missing: string;
    file_too_large: string;
    file_type: string;
    rate_limited: string;
    captcha: string;
    spam: string;
    cms_unavailable: string;
    whatsappFallback: string;
  };
  bio: { rowLabel: string; rowSub: string; successShort: string };
  meta: { title: string; description: string; back: string };
};

/**
 * Canonical Spanish technique labels stored in the CMS, independent of the UI
 * language: the owner reads her applications in Spanish, so an English-language
 * visitor's checkboxes must not arrive as English strings.
 */
const TECHNIQUE_VALUES: Record<string, string> = {
  acrilico: "Acrílico",
  polygel: "Polygel",
  builder_gel: "Builder gel",
  dipping: "Dipping",
  semipermanente: "Semipermanente",
  press_on: "Press-on",
  pedicure: "Pedicura",
  nail_art: "Nail art / diseño",
};

const EXPERIENCE_KEYS = [
  "sin_experiencia",
  "menos_de_1",
  "de_1_a_3",
  "de_3_a_5",
  "mas_de_5",
];

const STEP_COUNT = 3;

/** KB under a megabyte — "0.0 MB" next to a real file reads as a failure. */
function fileSizeLabel(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb < 1 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${mb.toFixed(1)} MB`;
}

type Tone = "dark" | "light";
type State = "idle" | "sending" | "sent";

/* ── per-tone styling ─────────────────────────────────────────────────────── */

// The form lives on two very different surfaces — the carbon careers page and
// the ivory /bio card — so every colour decision is funnelled through here
// instead of being sprinkled across the markup.
function tokens(tone: Tone) {
  const dark = tone === "dark";
  return {
    label: dark ? "text-gold-bright" : "text-gold",
    // Hints and helper copy: 0.62 alpha on carbon measures ~6.4:1, up from
    // ~5.4:1 at 0.55. Both pass AA; the extra headroom is for the 11-12px sizes
    // this text is used at.
    hint: dark ? "rgba(243,236,223,0.62)" : "var(--color-ink-mute)",
    text: dark ? "var(--color-cream)" : "var(--color-ink)",
    fieldBg: dark ? "rgba(243,236,223,0.04)" : "var(--color-paper)",
    fieldBorder: dark ? "rgba(243,236,223,0.22)" : "var(--hair)",
    chipBorder: dark ? "rgba(243,236,223,0.22)" : "var(--hair)",
    chipOnBg: dark ? "rgba(231,170,81,0.14)" : "rgba(172,130,49,0.08)",
    chipOnBorder: dark ? "var(--color-gold-bright)" : "var(--color-gold)",
    chosen: dark ? "var(--color-gold-soft)" : "var(--color-gold)",
    markerInk: dark ? "#1c1714" : "#fff",
    submit: dark ? "bg-gold-grad-dark" : "bg-gold-grad",
    error: dark ? "#ff9b8a" : "#b72b1a",
    rule: dark ? "rgba(243,236,223,0.14)" : "var(--hair)",
    track: dark ? "rgba(243,236,223,0.14)" : "rgba(28,23,20,0.1)",
  };
}

/* ── component ────────────────────────────────────────────────────────────── */

/**
 * The application form, shared by /trabaja-con-nosotros and the /bio disclosure.
 *
 * Three steps, one submit. It still asks everything the studio wants to know,
 * but never shows more than one decision's worth at a time: the previous
 * single-screen version stacked nine fields and eighteen choice chips in front
 * of someone standing on a bus, which reads as paperwork and loses applicants
 * who would have been good hires.
 *
 * Every answer is controlled state and the payload is assembled by hand on
 * submit, so inactive steps can unmount — real transitions, no stale DOM — with
 * nothing lost when you walk back. The one exception is the file input, which
 * stays mounted for the whole flow because a File cannot be re-assigned to a
 * fresh input.
 */
export default function PostulacionForm({
  dict,
  lang,
  roles,
  surface,
  tone = "dark",
  compact = false,
  onSent,
}: {
  dict: TrabajaDict;
  lang: Locale;
  /** Open cargos, from the CMS (see src/data/careers.ts). */
  roles: JobRole[];
  surface: ApplySurface;
  tone?: Tone;
  /** Single-column, tighter spacing — used inside the /bio card. */
  compact?: boolean;
  onSent?: () => void;
}) {
  const t = tokens(tone);
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const cvRef = useRef<HTMLInputElement>(null);
  const honeypotRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLParagraphElement>(null);
  const startedAtRef = useRef(0);
  const stepChangedRef = useRef(false);

  const [state, setState] = useState<State>("idle");
  const [step, setStep] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [portfolio, setPortfolio] = useState("");
  const [message, setMessage] = useState("");
  const [role, setRole] = useState("");
  const [experience, setExperience] = useState("");
  const [techniques, setTechniques] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [consent, setConsent] = useState(false);

  const { whatsappUrl, turnstileSiteKey } = siteConfig;
  const isLastStep = step === STEP_COUNT - 1;

  // When the form became fillable, used server-side to reject submissions that
  // arrive impossibly fast. A ref, not rendered state: Date.now() in the markup
  // would differ between the server render and hydration.
  useEffect(() => {
    startedAtRef.current = Date.now();
  }, []);

  // Move focus to the new step's heading so keyboard and screen-reader users
  // land on the question rather than back at the top of the page. Skipped on
  // first render — stealing focus on load would be hostile.
  useEffect(() => {
    if (!stepChangedRef.current) return;
    headingRef.current?.focus();
  }, [step]);

  const clearError = (field: string) =>
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });

  const text = (reason: string): string => {
    const map = dict.errors as unknown as Record<string, string>;
    const raw = map[reason] ?? dict.errors.cms_unavailable;
    return raw.replace("{max}", String(careersConfig.maxLabelMB));
  };

  const resetTurnstile = () => {
    const turnstile = (window as unknown as { turnstile?: { reset: () => void } })
      .turnstile;
    try {
      turnstile?.reset();
    } catch {
      /* widget not mounted — nothing to reset */
    }
  };

  /* ── validation ─────────────────────────────────────────────────────────── */

  /** Errors for one step, keyed by field. Empty object = that step is complete. */
  function validate(target: number): Record<string, string> {
    const e: Record<string, string> = {};
    const fe = dict.fieldErrors;
    if (target === 0) {
      if (!role) e.role_applied = fe.role_applied;
    } else if (target === 1) {
      if (fullName.trim().length < 2) e.full_name = fe.full_name;
      if (phone.replace(/\D/g, "").length < 10) e.phone = fe.phone;
      if (email.trim() && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email.trim())) {
        e.email = fe.email;
      }
    } else if (target === 2) {
      if (!file) e.cv = fe.cv;
      else if (file.size > careersConfig.maxBytes) e.cv = text("file_too_large");
      if (!consent) e.consent = fe.consent;
    }
    return e;
  }

  function goTo(target: number) {
    stepChangedRef.current = true;
    setFormError(null);
    setStep(target);
    trackApplyStep(surface, target + 1);
  }

  /**
   * Put the cursor on the first thing that needs fixing. Colouring a border red
   * tells you something is wrong; moving focus tells you where, which on a phone
   * also scrolls it into view and reopens the keyboard.
   */
  function focusFirstError(errors: Record<string, string>) {
    const suffix: Record<string, string> = {
      full_name: "name",
      phone: "phone",
      email: "email",
    };
    const order = ["full_name", "phone", "email"];
    const first = order.find((f) => errors[f]);
    if (!first) return;
    formRef.current
      ?.querySelector<HTMLElement>(`[id$="-${suffix[first]}"]`)
      ?.focus();
  }

  function goNext() {
    const e = validate(step);
    if (Object.keys(e).length > 0) {
      setFieldErrors(e);
      focusFirstError(e);
      return;
    }
    setFieldErrors({});
    goTo(Math.min(step + 1, STEP_COUNT - 1));
  }

  /** Back never validates — retreating is always allowed. */
  function goBack() {
    goTo(Math.max(step - 1, 0));
  }

  /* ── submit ─────────────────────────────────────────────────────────────── */

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === "sending") return;

    // Enter on any step but the last means "continue", not "send".
    if (!isLastStep) {
      goNext();
      return;
    }

    // Re-check every step, not just this one: an earlier answer could have been
    // edited to something invalid before walking forward again.
    const perStep = [validate(0), validate(1), validate(2)];
    const all = Object.assign({}, ...perStep) as Record<string, string>;
    if (Object.keys(all).length > 0) {
      setFieldErrors(all);
      const firstBad = perStep.findIndex((e) => Object.keys(e).length > 0);
      if (firstBad !== -1 && firstBad !== step) goTo(firstBad);
      setFormError(text("validation"));
      return;
    }

    const data = new FormData();
    data.set("full_name", fullName.trim());
    data.set("phone", phone.trim());
    if (email.trim()) data.set("email", email.trim());
    data.set("role_applied", role);
    if (experience) data.set("experience", experience);
    if (portfolio.trim()) data.set("portfolio_url", portfolio.trim());
    if (message.trim()) data.set("message", message.trim());
    for (const value of techniques) data.append("techniques", value);
    data.set("consent", "true");
    data.set("source_surface", surface);
    data.set("source_lang", lang);
    data.set("empresa", honeypotRef.current?.value ?? "");
    if (startedAtRef.current > 0) {
      data.set("started_at", String(startedAtRef.current));
    }
    if (file) data.set("cv", file, file.name);
    // Turnstile injects its token as a hidden input inside the form.
    const token = formRef.current?.querySelector<HTMLInputElement>(
      'input[name="cf-turnstile-response"]',
    )?.value;
    if (token) data.set("cf-turnstile-response", token);

    setState("sending");
    setFormError(null);
    setFieldErrors({});

    try {
      const res = await fetch("/api/postulaciones", {
        method: "POST",
        body: data,
      });
      if (res.ok) {
        setState("sent");
        trackApplySubmit(surface, { lang, role });
        onSent?.();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        reason?: string;
        fields?: string[];
      };
      const reason = body.reason ?? "cms_unavailable";
      setFormError(text(reason));
      // Map the server's field list onto inline messages where we have one, and
      // jump back to the step that owns the first offending field.
      if (body.fields?.length) {
        const mapped: Record<string, string> = {};
        for (const f of body.fields) {
          if (dict.fieldErrors[f]) mapped[f] = dict.fieldErrors[f];
        }
        setFieldErrors(mapped);
        if (mapped.role_applied) goTo(0);
        else if (mapped.full_name || mapped.phone || mapped.email) goTo(1);
      }
      setState("idle");
      resetTurnstile();
      trackApplyError(surface, reason);
    } catch {
      setFormError(text("cms_unavailable"));
      setState("idle");
      resetTurnstile();
      trackApplyError(surface, "network");
    }
  }

  /* ── success ────────────────────────────────────────────────────────────── */

  if (state === "sent") {
    return (
      <div
        role="status"
        className="flex flex-col items-start"
        style={{
          border: `1px solid ${t.chipOnBorder}`,
          background: t.chipOnBg,
          padding: compact ? "22px 18px" : "32px 30px",
        }}
      >
        <span
          aria-hidden
          className="mb-3 flex items-center justify-center"
          style={{
            width: 34,
            height: 34,
            border: `1px solid ${t.chipOnBorder}`,
            borderRadius: 999,
            color: t.chosen,
            fontSize: 14,
          }}
        >
          ✓
        </span>
        <p
          className="m-0 font-display text-[24px] italic md:text-[28px]"
          style={{ color: t.text, textWrap: "balance" }}
        >
          {dict.success.title}
        </p>
        <p
          className="m-0 mt-2 max-w-[46ch] font-sans text-[13px] leading-[1.65]"
          style={{ color: t.hint }}
        >
          {dict.success.body}
        </p>
        <button
          type="button"
          onClick={() => {
            setState("idle");
            setStep(0);
            stepChangedRef.current = false;
            setFullName("");
            setPhone("");
            setEmail("");
            setPortfolio("");
            setMessage("");
            setRole("");
            setExperience("");
            setTechniques(new Set());
            setFile(null);
            setConsent(false);
            setFieldErrors({});
            setFormError(null);
            if (cvRef.current) cvRef.current.value = "";
          }}
          className="mt-5 cursor-pointer bg-transparent p-0 font-sans text-[10px] font-semibold uppercase tracking-[0.24em] underline"
          style={{ color: t.hint, border: 0 }}
        >
          {dict.success.again}
        </button>
      </div>
    );
  }

  /* ── shared field bits ──────────────────────────────────────────────────── */

  const labelClass = `mb-2 block font-sans text-[10px] font-semibold uppercase tracking-[0.24em] ${t.label}`;

  const fieldStyle = (field: string): React.CSSProperties => ({
    background: t.fieldBg,
    border: `1px solid ${fieldErrors[field] ? t.error : t.fieldBorder}`,
    color: t.text,
    borderRadius: 0,
    padding: "13px 14px",
    fontSize: 16, // 16px stops iOS Safari zooming the page on focus
    width: "100%",
    outline: "none",
  });

  // A plain render helper, not a component: declaring a component inside render
  // would remount (and reset) it on every keystroke.
  const fieldError = (field: string) =>
    fieldErrors[field] ? (
      <p
        className="m-0 mt-1.5 font-sans text-[11.5px] leading-[1.4]"
        style={{ color: t.error }}
      >
        {fieldErrors[field]}
      </p>
    ) : null;

  const optionalTag = (
    <span style={{ color: t.hint }}> · {dict.form.optional}</span>
  );

  return (
    <>
      {turnstileSiteKey && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="lazyOnload"
        />
      )}

      <form ref={formRef} onSubmit={onSubmit} noValidate className="w-full">
        {/* Bot bait: hidden from humans, tempting to form-fillers. Not
            display:none — some fillers skip those. */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: "-9999px",
            width: 1,
            height: 1,
            overflow: "hidden",
          }}
        >
          <label htmlFor={`${uid}-empresa`}>Empresa</label>
          <input
            ref={honeypotRef}
            id={`${uid}-empresa`}
            type="text"
            name="empresa"
            tabIndex={-1}
            autoComplete="off"
          />
        </div>

        {/* The file input lives outside the steps so the chosen File survives
            navigating back and forth; its visible control is on step 3. */}
        <input
          ref={cvRef}
          id={`${uid}-cv`}
          name="cv"
          type="file"
          accept={careersConfig.accept}
          className="sr-only"
          onChange={(e) => {
            const picked = e.currentTarget.files?.[0] ?? null;
            setFile(picked);
            if (picked) clearError("cv");
          }}
        />

        {/* ── progress ───────────────────────────────────────────────────── */}
        <div className="mb-6">
          <div className="mb-2.5 flex items-baseline justify-between gap-4">
            <p
              ref={headingRef}
              tabIndex={-1}
              aria-live="polite"
              className="m-0 font-sans text-[10px] font-semibold uppercase tracking-[0.24em]"
              style={{ color: t.chosen, outline: "none" }}
            >
              {dict.flow.counter
                .replace("{current}", String(step + 1))
                .replace("{total}", String(STEP_COUNT))}
              <span style={{ color: t.hint }}> · {dict.flow.steps[step]}</span>
            </p>
            {step === 0 && !compact && (
              <p
                className="m-0 hidden font-sans text-[11px] md:block"
                style={{ color: t.hint }}
              >
                {dict.flow.reassurance}
              </p>
            )}
          </div>

          {/* Segmented track rather than a percentage bar: three marks make the
              remaining work countable, which is the whole reassurance. */}
          <div className="flex gap-1.5" aria-hidden>
            {dict.flow.steps.map((label, i) => (
              <span
                key={label}
                className="block flex-1"
                style={{
                  height: 2,
                  background: i <= step ? t.chipOnBorder : t.track,
                  transition: "background 320ms cubic-bezier(0.22,1,0.36,1)",
                }}
              />
            ))}
          </div>
        </div>

        {/* ── steps ──────────────────────────────────────────────────────── */}
        {/* The floor is set just under the tallest short step (measured: 297px on
            desktop) so the Continue button barely moves between steps without
            leaving a pit of empty carbon on the shorter ones. */}
        <div
          key={step}
          className="gbs-step"
          style={{ minHeight: compact ? 264 : 300 }}
        >
          {step === 0 && (
            <>
              <fieldset className="border-0 p-0" style={{ margin: 0 }}>
                <legend className={labelClass} style={{ padding: 0 }}>
                  {dict.form.role.label}
                </legend>
                <div
                  className={
                    compact
                      ? "grid grid-cols-1 gap-2"
                      : "grid grid-cols-1 gap-2 sm:grid-cols-2"
                  }
                >
                  {roles.map((r) => {
                    const on = role === r.slug;
                    const id = `${uid}-role-${r.slug}`;
                    return (
                      <label
                        key={r.slug}
                        htmlFor={id}
                        className="flex cursor-pointer items-center gap-3 px-4 py-3.5"
                        style={{
                          border: `1px solid ${
                            on
                              ? t.chipOnBorder
                              : fieldErrors.role_applied
                                ? t.error
                                : t.chipBorder
                          }`,
                          background: on ? t.chipOnBg : "transparent",
                          transition:
                            "border-color 180ms ease, background 180ms ease",
                        }}
                      >
                        <input
                          id={id}
                          type="radio"
                          name="role_applied"
                          value={r.slug}
                          className="sr-only"
                          checked={on}
                          onChange={() => {
                            setRole(r.slug);
                            clearError("role_applied");
                          }}
                        />
                        <span
                          aria-hidden
                          className="flex shrink-0 items-center justify-center"
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: 999,
                            border: `1px solid ${on ? t.chipOnBorder : t.chipBorder}`,
                            background: on ? t.chipOnBorder : "transparent",
                            color: t.markerInk,
                            fontSize: 9,
                            lineHeight: 1,
                          }}
                        >
                          {on ? "✓" : ""}
                        </span>
                        <span
                          className="font-display text-[18px] leading-[1.15]"
                          style={{ color: on ? t.chosen : t.text }}
                        >
                          {r.label}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {fieldError("role_applied")}
              </fieldset>

              <fieldset className="border-0 p-0" style={{ margin: "26px 0 0" }}>
                <legend className={labelClass} style={{ padding: 0 }}>
                  {dict.form.experience.label}
                  {optionalTag}
                </legend>
                <div className="flex flex-wrap gap-1.5">
                  {EXPERIENCE_KEYS.map((key) => {
                    const on = experience === key;
                    const id = `${uid}-exp-${key}`;
                    return (
                      <label
                        key={key}
                        htmlFor={id}
                        className="flex-1 cursor-pointer px-3 py-2.5 text-center font-sans text-[11.5px]"
                        style={{
                          minWidth: 104,
                          border: `1px solid ${on ? t.chipOnBorder : t.chipBorder}`,
                          background: on ? t.chipOnBg : "transparent",
                          color: on ? t.chosen : t.hint,
                          transition:
                            "border-color 180ms ease, background 180ms ease",
                        }}
                      >
                        <input
                          id={id}
                          type="radio"
                          name="experience"
                          value={key}
                          className="sr-only"
                          checked={on}
                          onChange={() => setExperience(key)}
                        />
                        {dict.form.experience.options[key]}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            </>
          )}

          {step === 1 && (
            <div
              className={
                compact
                  ? "grid grid-cols-1 gap-4"
                  : "grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5"
              }
            >
              <div className="flex flex-col">
                <label className={labelClass} htmlFor={`${uid}-name`}>
                  {dict.form.name.label}
                </label>
                <input
                  id={`${uid}-name`}
                  type="text"
                  autoComplete="name"
                  maxLength={120}
                  placeholder={dict.form.name.placeholder}
                  value={fullName}
                  onChange={(e) => {
                    setFullName(e.currentTarget.value);
                    clearError("full_name");
                  }}
                  aria-invalid={Boolean(fieldErrors.full_name) || undefined}
                  style={{ ...fieldStyle("full_name"), marginTop: "auto" }}
                />
                {fieldError("full_name")}
              </div>

              <div className="flex flex-col">
                <label className={labelClass} htmlFor={`${uid}-phone`}>
                  {dict.form.phone.label}
                </label>
                <input
                  id={`${uid}-phone`}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  maxLength={20}
                  placeholder={dict.form.phone.placeholder}
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.currentTarget.value);
                    clearError("phone");
                  }}
                  aria-invalid={Boolean(fieldErrors.phone) || undefined}
                  style={{ ...fieldStyle("phone"), marginTop: "auto" }}
                />
                {fieldError("phone")}
              </div>

              <div className="flex flex-col">
                <label className={labelClass} htmlFor={`${uid}-email`}>
                  {dict.form.email.label}
                  {optionalTag}
                </label>
                <input
                  id={`${uid}-email`}
                  type="email"
                  autoComplete="email"
                  maxLength={160}
                  placeholder={dict.form.email.placeholder}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.currentTarget.value);
                    clearError("email");
                  }}
                  aria-invalid={Boolean(fieldErrors.email) || undefined}
                  style={{ ...fieldStyle("email"), marginTop: "auto" }}
                />
                {fieldError("email")}
              </div>

              <div className="flex flex-col">
                <label className={labelClass} htmlFor={`${uid}-portfolio`}>
                  {dict.form.portfolio.label}
                  {optionalTag}
                </label>
                <input
                  id={`${uid}-portfolio`}
                  type="text"
                  inputMode="url"
                  maxLength={300}
                  placeholder={dict.form.portfolio.placeholder}
                  value={portfolio}
                  onChange={(e) => setPortfolio(e.currentTarget.value)}
                  style={{ ...fieldStyle("portfolio_url"), marginTop: "auto" }}
                />
              </div>
            </div>
          )}

          {step === 2 && (
            <>
              <fieldset className="border-0 p-0" style={{ margin: 0 }}>
                <legend className={labelClass} style={{ padding: 0 }}>
                  {dict.form.techniques.label}
                  {optionalTag}
                </legend>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(TECHNIQUE_VALUES).map(([key, value]) => {
                    const on = techniques.has(value);
                    const id = `${uid}-tech-${key}`;
                    return (
                      <label
                        key={key}
                        htmlFor={id}
                        className="flex cursor-pointer items-center gap-1.5 px-3 py-2 font-sans text-[11.5px]"
                        style={{
                          border: `1px solid ${on ? t.chipOnBorder : t.chipBorder}`,
                          background: on ? t.chipOnBg : "transparent",
                          color: on ? t.chosen : t.hint,
                          transition:
                            "border-color 180ms ease, background 180ms ease",
                        }}
                      >
                        <input
                          id={id}
                          type="checkbox"
                          name="techniques"
                          value={value}
                          className="sr-only"
                          checked={on}
                          onChange={() =>
                            setTechniques((prev) => {
                              const next = new Set(prev);
                              if (next.has(value)) next.delete(value);
                              else next.add(value);
                              return next;
                            })
                          }
                        />
                        <span aria-hidden style={{ fontSize: 9, width: 8 }}>
                          {on ? "✓" : ""}
                        </span>
                        {dict.form.techniques.options[key] ?? value}
                      </label>
                    );
                  })}
                </div>
                <p
                  className="m-0 mt-2 font-sans text-[11px] leading-[1.5]"
                  style={{ color: t.hint }}
                >
                  {dict.form.techniques.hint}
                </p>
              </fieldset>

              <div style={{ marginTop: 26 }}>
                <label className={labelClass} htmlFor={`${uid}-message`}>
                  {dict.form.message.label}
                  {optionalTag}
                </label>
                <textarea
                  id={`${uid}-message`}
                  rows={3}
                  maxLength={2000}
                  placeholder={dict.form.message.placeholder}
                  value={message}
                  onChange={(e) => setMessage(e.currentTarget.value)}
                  style={{ ...fieldStyle("message"), resize: "vertical" }}
                />
              </div>

              {/* Hoja de vida — a drop target on desktop, a big tap target on a
                  phone. A photo of a printed CV counts, on purpose. */}
              <div style={{ marginTop: 26 }}>
                <span className={labelClass}>{dict.form.cv.label}</span>
                <label
                  htmlFor={`${uid}-cv`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const dropped = e.dataTransfer.files?.[0];
                    if (!dropped) return;
                    // Mirror it into the real input so the control stays honest.
                    const dt = new DataTransfer();
                    dt.items.add(dropped);
                    if (cvRef.current) cvRef.current.files = dt.files;
                    setFile(dropped);
                    clearError("cv");
                  }}
                  className="flex cursor-pointer flex-col items-start gap-1 px-5 py-5"
                  style={{
                    border: `1px solid ${
                      fieldErrors.cv
                        ? t.error
                        : dragOver || file
                          ? t.chipOnBorder
                          : t.chipBorder
                    }`,
                    background: dragOver || file ? t.chipOnBg : "transparent",
                    transition: "border-color 180ms ease, background 180ms ease",
                  }}
                >
                  <span
                    className="font-sans text-[11px] font-semibold uppercase tracking-[0.22em]"
                    style={{ color: t.chosen }}
                  >
                    {file ? dict.form.cv.change : dict.form.cv.button}
                  </span>
                  <span
                    className="w-full font-sans text-[12px]"
                    style={{
                      color: file ? t.text : t.hint,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {file
                      ? `${file.name} · ${fileSizeLabel(file.size)}`
                      : compact
                        ? dict.form.cv.hint.replace(
                            "{max}",
                            String(careersConfig.maxLabelMB),
                          )
                        : `${dict.form.cv.drop} · ${dict.form.cv.hint.replace(
                            "{max}",
                            String(careersConfig.maxLabelMB),
                          )}`}
                  </span>
                </label>
                {fieldError("cv")}
              </div>

              <label
                className="mt-6 flex cursor-pointer items-start gap-3 font-sans text-[12px] leading-[1.55]"
                style={{ color: t.hint }}
              >
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => {
                    setConsent(e.currentTarget.checked);
                    if (e.currentTarget.checked) clearError("consent");
                  }}
                  aria-invalid={Boolean(fieldErrors.consent) || undefined}
                  style={{
                    marginTop: 2,
                    width: 18,
                    height: 18,
                    flexShrink: 0,
                    accentColor: "var(--color-gold)",
                    outline: fieldErrors.consent
                      ? `1px solid ${t.error}`
                      : undefined,
                  }}
                />
                <span>{dict.form.consent}</span>
              </label>
              {fieldError("consent")}

              {turnstileSiteKey && (
                <div
                  className="cf-turnstile mt-4"
                  data-sitekey={turnstileSiteKey}
                  data-theme={tone === "dark" ? "dark" : "light"}
                  data-size="flexible"
                  data-language={lang}
                />
              )}
            </>
          )}
        </div>

        {/* ── navigation ─────────────────────────────────────────────────── */}
        <div
          className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3 pt-5"
          style={{ borderTop: `1px solid ${t.rule}` }}
        >
          {/* The keys matter. Without them React reuses one DOM node for both
              buttons, so clicking "Continuar" on the second-to-last step mutates
              that same node's type from "button" to "submit" during the click —
              and the browser then runs the default action on it, firing a
              premature submit that lands on the last step covered in errors.
              Distinct keys make React swap the element instead. */}
          {isLastStep ? (
            <button
              key="submit"
              type="submit"
              disabled={state === "sending"}
              className={`${t.submit} cursor-pointer px-7 py-4 font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-white`}
              style={{
                border: 0,
                opacity: state === "sending" ? 0.7 : 1,
                cursor: state === "sending" ? "wait" : "pointer",
              }}
            >
              {state === "sending" ? dict.form.sending : dict.form.submit}
            </button>
          ) : (
            <button
              key="next"
              type="button"
              onClick={goNext}
              className={`${t.submit} inline-flex cursor-pointer items-center gap-3 px-7 py-4 font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-white`}
              style={{ border: 0 }}
            >
              {dict.flow.next}
              <span aria-hidden className="font-display text-[15px] leading-none">
                →
              </span>
            </button>
          )}

          {step > 0 && (
            <button
              type="button"
              onClick={goBack}
              className="cursor-pointer bg-transparent p-0 font-sans text-[10px] font-semibold uppercase tracking-[0.24em]"
              style={{ color: t.hint, border: 0 }}
            >
              ← {dict.flow.back}
            </button>
          )}

          {formError && whatsappUrl && (
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-sans text-[11px] font-semibold uppercase tracking-[0.22em] underline"
              style={{ color: t.hint }}
            >
              {dict.errors.whatsappFallback} ↗
            </a>
          )}
        </div>

        {formError && (
          <p
            role="alert"
            className="m-0 mt-3 font-sans text-[12px] leading-[1.5]"
            style={{ color: t.error }}
          >
            {formError}
          </p>
        )}
      </form>
    </>
  );
}
