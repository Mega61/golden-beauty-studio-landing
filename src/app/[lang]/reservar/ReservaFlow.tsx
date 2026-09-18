"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GoldRule } from "../_components/atoms";
import type { Locale } from "../dictionaries";

/**
 * The booking flow: service → technician → day and time → details → confirmed.
 *
 * ## Why a page and not a modal
 *
 * Most of the traffic arrives from Instagram on a phone. A five-step flow with
 * a day strip and a grid of times fights a 390px modal for room, traps scroll,
 * and loses everything if the sheet is dismissed by accident. A page also has a
 * URL, which is what makes it usable from the `/bio` link tree, a WhatsApp
 * reply, or an ad — straight to booking instead of the homepage, hoping she
 * scrolls.
 *
 * ## Two things this screen must never do
 *
 * **Never show a time that isn't really free.** Every slot here came from the
 * panel, which cross-checked the studio's two stations — EA alone would happily
 * report a technician free while both chairs are taken. The list is refetched
 * whenever the day or the technician changes, and again after a lost race.
 *
 * **Never blame the client for a race.** Two people can pick 10:00 seconds
 * apart; the loser gets `taken`, and the honest response is to reload the times
 * and say "that one just went", not to show a validation error on a form she
 * filled in correctly.
 */

type Service = {
  id: number;
  name: string;
  durationMin: number;
  priceCOP: number;
  category: string | null;
};
type Provider = { id: number; name: string; serviceIds: number[] };
type Slot = { time: string; start: string; end: string; providerIds: number[] };

type Dict = {
  steps: { service: string; provider: string; slot: string; details: string };
  anyProvider: string;
  anyProviderHint: string;
  duration: string;
  back: string;
  next: string;
  confirm: string;
  sending: string;
  labels: {
    firstName: string;
    lastName: string;
    phone: string;
    phoneHint: string;
    notes: string;
  };
  noSlots: string;
  loadingSlots: string;
  pickDate: string;
  success: { title: string; body: string; note: string; again: string };
  errors: Record<string, string>;
};

/** How far ahead the day strip runs. The panel refuses anything past 120. */
const DAYS_AHEAD = 45;

export default function ReservaFlow({
  dict,
  lang,
  today,
  whatsappHref,
}: {
  dict: Dict;
  lang: Locale;
  /** Hoy en el calendario del estudio, calculado en el servidor. */
  today: string;
  whatsappHref: string | null;
}) {
  const [catalog, setCatalog] = useState<{ services: Service[]; providers: Provider[] } | null>(
    null,
  );
  const [service, setService] = useState<Service | null>(null);
  const [providerId, setProviderId] = useState<number | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState({ firstName: "", lastName: "", phone: "", notes: "" });
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [booked, setBooked] = useState<{ date: string; time: string; provider: string } | null>(
    null,
  );

  /**
   * When the form was first rendered. The proxy rejects anything submitted
   * faster than a person can read — one of the guards that keeps scripted
   * floods away from the studio's real calendar.
   *
   * Stamped in an effect, not at render: `Date.now()` during render is impure,
   * and a ref assignment costs no re-render.
   */
  const startedAt = useRef(0);
  const honeypotRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  // Puro: el "hoy" lo fijó el servidor, que es el único que sabe con certeza en
  // qué día está el estudio.
  const days = useMemo(() => buildDays(today, DAYS_AHEAD), [today]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/reservas/catalogo");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { services: Service[]; providers: Provider[] };
        if (alive) setCatalog(body);
      } catch {
        if (alive) setError(dict.errors.unavailable);
      }
    })();
    return () => {
      alive = false;
    };
  }, [dict.errors.unavailable]);

  // Times are refetched on every change of day, service or technician — and
  // never cached, because a cached availability is a chair sold twice.
  useEffect(() => {
    if (!service || !date) return;
    let alive = true;

    void (async () => {
      const query = new URLSearchParams({ serviceId: String(service.id), date });
      if (providerId !== null) query.set("providerId", String(providerId));
      try {
        const res = await fetch(`/api/reservas/disponibilidad?${query}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { slots: Slot[] };
        if (alive) setSlots(body.slots);
      } catch {
        if (alive) {
          setSlots([]);
          setError(dict.errors.unavailable);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [service, date, providerId, dict.errors.unavailable]);

  /**
   * Agrupado por categoría, en el orden en que EA las devuelve — que es el de
   * `pricing.ts`, o sea el de la vitrina. Una lista plana de veinticinco
   * servicios en un celular es un muro, y el primer paso es justo donde se
   * abandona un formulario.
   */
  const grouped = useMemo(() => {
    if (!catalog) return [];
    const out = new Map<string, Service[]>();
    for (const s of catalog.services) {
      const key = s.category ?? "";
      const list = out.get(key);
      if (list) list.push(s);
      else out.set(key, [s]);
    }
    return [...out.entries()];
  }, [catalog]);

  const providers = useMemo(
    () =>
      service && catalog
        ? catalog.providers.filter((p) => p.serviceIds.includes(service.id))
        : [],
    [catalog, service],
  );

  async function submit() {
    if (!service || !slot || !date) return;
    setSending(true);
    setError(null);

    try {
      const res = await fetch("/api/reservas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: service.id,
          date,
          time: slot.time,
          providerId,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone,
          notes: form.notes,
          startedAt: startedAt.current,
          empresa: honeypotRef.current?.value ?? "",
        }),
      });

      const body = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        booking?: { provider: { name: string }; start: string };
      };

      if (res.status === 201 && body.booking) {
        setBooked({
          date: longDate(date, lang),
          time: slot.time,
          provider: body.booking.provider.name,
        });
        return;
      }

      // Someone else took it. Reload the times so she picks from what's real
      // now, instead of re-submitting into the same wall.
      if (body.reason === "taken") {
        setError(dict.errors.taken);
        setSlot(null);
        setDate((d) => d); // keep the day
        const query = new URLSearchParams({ serviceId: String(service.id), date });
        if (providerId !== null) query.set("providerId", String(providerId));
        const again = await fetch(`/api/reservas/disponibilidad?${query}`);
        if (again.ok) setSlots(((await again.json()) as { slots: Slot[] }).slots);
        return;
      }

      setError(dict.errors[body.reason ?? "unavailable"] ?? dict.errors.unavailable);
    } catch {
      setError(dict.errors.unavailable);
    } finally {
      setSending(false);
    }
  }

  if (booked) {
    return (
      <div className="mx-auto max-w-[640px] px-5 py-16 text-center md:py-24">
        <p className="font-display text-4xl text-ink md:text-5xl">{dict.success.title}</p>
        <GoldRule className="my-6" width={90} />
        <p className="font-sans text-base text-ink-soft">
          {dict.success.body
            .replace("{date}", booked.date)
            .replace("{time}", booked.time)
            .replace("{provider}", booked.provider)}
        </p>
        <p className="mt-4 font-sans text-sm text-ink-mute">{dict.success.note}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {whatsappHref && (
            <a
              href={whatsappHref}
              className="rounded-full bg-whatsapp px-6 py-3 font-sans text-sm font-semibold text-white"
            >
              WhatsApp
            </a>
          )}
          <button
            type="button"
            onClick={() => {
              setBooked(null);
              setService(null);
              setProviderId(null);
              setDate(null);
              setSlot(null);
              setForm({ firstName: "", lastName: "", phone: "", notes: "" });
              startedAt.current = Date.now();
            }}
            className="rounded-full border border-ink/20 px-6 py-3 font-sans text-sm text-ink"
          >
            {dict.success.again}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[760px] px-5 pb-24">
      {error && (
        <p
          role="alert"
          className="mb-6 rounded-lg border border-gold-dark/30 bg-gold-pale/60 px-4 py-3 font-sans text-sm text-gold-deep"
        >
          {error}
        </p>
      )}

      <Step n={1} title={dict.steps.service}>
        {!catalog ? (
          <Skeleton rows={4} />
        ) : (
          grouped.map(([category, items]) => (
            <div key={category} className="mb-6 last:mb-0">
              {category !== "" && (
                <p className="mb-2 font-sans text-[11px] uppercase tracking-[0.28em] text-gold-dark">
                  {category}
                </p>
              )}
              <ul className="grid gap-2">
                {items.map((s) => (
                  <li key={s.id}>
                    <Choice
                      selected={service?.id === s.id}
                      onClick={() => {
                        setService(s);
                        setProviderId(null);
                        setSlot(null);
                        setSlots(null);
                      }}
                    >
                      <span className="font-sans text-sm text-ink">{s.name}</span>
                      <span className="font-sans text-xs text-ink-mute">
                        {dict.duration.replace("{min}", String(s.durationMin))} ·{" "}
                        {formatCOP(s.priceCOP, lang)}
                      </span>
                    </Choice>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </Step>

      {service && (
        <Step n={2} title={dict.steps.provider}>
          <ul className="grid gap-2 sm:grid-cols-2">
            <li>
              <Choice
                selected={providerId === null}
                onClick={() => {
                  setProviderId(null);
                  setSlot(null);
                  setSlots(null);
                }}
              >
                <span className="font-sans text-sm text-ink">{dict.anyProvider}</span>
                <span className="font-sans text-xs text-ink-mute">{dict.anyProviderHint}</span>
              </Choice>
            </li>
            {providers.map((p) => (
              <li key={p.id}>
                <Choice
                  selected={providerId === p.id}
                  onClick={() => {
                    setProviderId(p.id);
                    setSlot(null);
                    setSlots(null);
                  }}
                >
                  <span className="font-sans text-sm text-ink">{p.name}</span>
                </Choice>
              </li>
            ))}
          </ul>
        </Step>
      )}

      {service && (
        <Step n={3} title={dict.steps.slot}>
          <p className="mb-3 font-sans text-xs uppercase tracking-[0.2em] text-ink-mute">
            {dict.pickDate}
          </p>
          <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-2">
            {days.map((d) => (
              <button
                key={d.iso}
                type="button"
                onClick={() => {
                  setDate(d.iso);
                  setSlot(null);
                  setSlots(null);
                }}
                aria-pressed={date === d.iso}
                className={`min-w-[62px] shrink-0 snap-start rounded-xl border px-3 py-2 text-center font-sans transition ${
                  date === d.iso
                    ? "border-gold bg-gold/10 text-ink"
                    : "border-ink/12 text-ink-soft hover:border-gold/50"
                }`}
              >
                <span className="block text-[10px] uppercase tracking-wider text-ink-mute">
                  {weekday(d.iso, lang)}
                </span>
                <span className="block text-lg leading-tight">{d.day}</span>
                <span className="block text-[10px] text-ink-mute">{month(d.iso, lang)}</span>
              </button>
            ))}
          </div>

          {date &&
            (slots === null ? (
              <p className="mt-4 font-sans text-sm text-ink-mute">{dict.loadingSlots}</p>
            ) : slots.length === 0 ? (
              <p className="mt-4 font-sans text-sm text-ink-mute">{dict.noSlots}</p>
            ) : (
              <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {slots.map((s) => (
                  <button
                    key={s.time}
                    type="button"
                    onClick={() => setSlot(s)}
                    aria-pressed={slot?.time === s.time}
                    className={`rounded-lg border py-2 font-sans text-sm transition ${
                      slot?.time === s.time
                        ? "border-gold bg-gold/10 text-ink"
                        : "border-ink/12 text-ink-soft hover:border-gold/50"
                    }`}
                  >
                    {s.time}
                  </button>
                ))}
              </div>
            ))}
        </Step>
      )}

      {slot && (
        <Step n={4} title={dict.steps.details}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="grid gap-4"
          >
            {/* Honeypot. Same shape and same field name as the careers form:
                off-screen rather than `display:none` (bots skip those), with a
                real label so it looks worth filling. Two different honeypot
                implementations in one codebase is how one of them quietly stops
                working. */}
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
              <label htmlFor="reserva-empresa">Empresa</label>
              <input
                id="reserva-empresa"
                type="text"
                name="empresa"
                tabIndex={-1}
                autoComplete="off"
                ref={honeypotRef}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={dict.labels.firstName}
                value={form.firstName}
                onChange={(v) => setForm({ ...form, firstName: v })}
                autoComplete="given-name"
                required
              />
              <Field
                label={dict.labels.lastName}
                value={form.lastName}
                onChange={(v) => setForm({ ...form, lastName: v })}
                autoComplete="family-name"
                required
              />
            </div>

            <Field
              label={dict.labels.phone}
              hint={dict.labels.phoneHint}
              value={form.phone}
              onChange={(v) => setForm({ ...form, phone: v })}
              autoComplete="tel"
              inputMode="tel"
              required
            />

            <Field
              label={dict.labels.notes}
              value={form.notes}
              onChange={(v) => setForm({ ...form, notes: v })}
              multiline
            />

            <button
              type="submit"
              disabled={sending}
              className="mt-2 rounded-full bg-carbon px-8 py-4 font-sans text-sm font-semibold uppercase tracking-[0.18em] text-cream disabled:opacity-60"
            >
              {sending ? dict.sending : dict.confirm}
            </button>
          </form>
        </Step>
      )}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-ink/10 py-8 first:border-t-0">
      <h2 className="mb-4 flex items-baseline gap-3">
        <span className="font-sans text-[11px] font-semibold tracking-[0.3em] text-gold-dark">
          {String(n).padStart(2, "0")}
        </span>
        <span className="font-display text-2xl text-ink md:text-3xl">{title}</span>
      </h2>
      {children}
    </section>
  );
}

function Choice({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full flex-col items-start gap-0.5 rounded-xl border px-4 py-3 text-left transition ${
        selected ? "border-gold bg-gold/10" : "border-ink/12 hover:border-gold/50"
      }`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  multiline = false,
  ...rest
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  required?: boolean;
  autoComplete?: string;
  inputMode?: "tel" | "text";
}) {
  const cls =
    "w-full rounded-lg border border-ink/15 bg-paper px-4 py-3 font-sans text-sm text-ink outline-none focus:border-gold";
  return (
    <label className="block">
      <span className="mb-1.5 block font-sans text-xs uppercase tracking-[0.18em] text-ink-mute">
        {label}
      </span>
      {multiline ? (
        <textarea
          rows={3}
          className={cls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="text"
          className={cls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...rest}
        />
      )}
      {hint && <span className="mt-1 block font-sans text-xs text-ink-mute">{hint}</span>}
    </label>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="grid gap-2" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-xl bg-ivory-deep/60" />
      ))}
    </div>
  );
}

/**
 * The next N days as `YYYY-MM-DD`, counted from the studio's today.
 *
 * `today` comes from the server precisely so this stays pure and correct: a
 * client browsing from Madrid at 1 a.m. is still looking at a Bogotá day, and
 * trusting her device clock would offer a day that already passed there.
 *
 * Midday arithmetic, so adding 24 h never lands on the wrong date — Bogotá has
 * no DST, but the visitor's engine does the parsing and hers might.
 */
function buildDays(today: string, count: number): { iso: string; day: string }[] {
  const out: { iso: string; day: string }[] = [];
  const noon = new Date(`${today}T12:00:00`).getTime();
  for (let i = 0; i < count; i += 1) {
    const iso = new Date(noon + i * 86_400_000).toISOString().slice(0, 10);
    out.push({ iso, day: iso.slice(8, 10) });
  }
  return out;
}

function weekday(iso: string, lang: Locale): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(lang === "es" ? "es-CO" : "en-US", {
    weekday: "short",
  });
}

function month(iso: string, lang: Locale): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(lang === "es" ? "es-CO" : "en-US", {
    month: "short",
  });
}

function longDate(iso: string, lang: Locale): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(lang === "es" ? "es-CO" : "en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** Same shape the price list uses: `$180.000` in es, `$180,000 COP` in en. */
function formatCOP(value: number, lang: Locale): string {
  const n = new Intl.NumberFormat(lang === "es" ? "es-CO" : "en-US").format(value);
  return lang === "es" ? `$${n}` : `$${n} COP`;
}
