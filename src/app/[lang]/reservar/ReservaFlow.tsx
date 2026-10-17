"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { AnimatePresence, LazyMotion, MotionConfig, animate, domAnimation, m } from "motion/react";
import type { Locale } from "../dictionaries";
import { trackEvent, trackMeta } from "@/lib/analytics";
import { newEventId } from "@/lib/meta-events";
import {
  addMinutes,
  buildDays,
  fill,
  formatCOP,
  formatDuration,
  formatPhoneInput,
  formatTime,
  googleCalendarUrl,
  groupByDayPart,
  icsFile,
  isDayOpen,
  isPlausiblePhone,
  whatsappLink,
  type Schedule,
} from "@/lib/booking";
import {
  dayPromoOn,
  parseQuote,
  promoHints,
  visitPricing,
  type DayPromo,
  type ServerQuote,
} from "@/lib/booking-promo";

/**
 * The booking flow: service → day and time → details → confirmed.
 *
 * ## Shape
 *
 * Three steps, one on screen at a time, with what's been chosen always in
 * view — a bar pinned to the bottom on a phone, a card beside the steps on a
 * desktop. Most of the traffic arrives from Instagram on a phone, and the old
 * version stacked every step into one page that started with a twenty-card
 * wall: the first screen is where a form is abandoned, so it now shows one
 * category at a time and moves on by itself once a choice is unambiguous.
 *
 * Each step is a history entry, so the phone's back gesture goes back a step
 * instead of out of the page and losing everything.
 *
 * ## Two things this screen must never do
 *
 * **Never show a time that isn't really free.** Every slot here came from the
 * panel, which cross-checked the studio's two stations — EA alone would happily
 * report a technician free while both chairs are taken. The list is refetched
 * whenever the day or the technician changes, and again after a lost race.
 * The closed days in the strip are a hint from each technician's weekly plan;
 * a day is only greyed out when nobody could possibly be working it.
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
  /** Price-list id. Null when the panel hasn't linked this service yet. */
  slug?: string | null;
  /** Reached by composing, not by picking: never listed in step 1. */
  isCombo?: boolean;
  /**
   * Las promos del día de este servicio ("Miércoles de pies"), de las mismas
   * reglas que aplica el panel. Un panel viejo no las manda: sin ellas no se
   * muestra ninguna promo, que es como funcionaba antes.
   */
  dayPromos?: DayPromo[];
};
type Provider = { id: number; name: string; serviceIds: number[]; schedule?: Schedule };
type Slot = { time: string; start: string; end: string; providerIds: number[] };

/**
 * A combo with the two halves it replaces. Sent by the panel.
 *
 * The combo isn't in the list: you pick "semi on hands" and get "feet too?".
 * That's how people think about a visit, and it spares the first step from a
 * combo hunt among twenty-five rows.
 */
type Combo = { serviceId: number; handsServiceId: number; feetServiceId: number };

export type Catalog = {
  services: Service[];
  providers: Provider[];
  combos: Combo[];
  /**
   * The panel can book a pair without a combo as two appointments in a row.
   * Older panels don't send it, and then only combos can be composed — a pair
   * offered to a panel that can't chain would book the first half only.
   */
  chained?: boolean;
  /** El 10% de primera visita, como dato del panel para que el texto diga el mismo número que descuenta. */
  firstVisitPercent?: number;
};

export type ServiceCopy = { name: string; desc: string; category: string; categoryId: string };

type Step = "service" | "slot" | "details";
const STEPS: Step[] = ["service", "slot", "details"];

type Dict = {
  eyebrow: string;
  steps: Record<Step, string>;
  headings: Record<Step, string>;
  provider: { label: string; any: string; anyHint: string };
  summary: { title: string; empty: string; with: string; anyone: string; total: string; pay: string };
  continue: string;
  back: string;
  change: string;
  confirm: string;
  sending: string;
  labels: {
    firstName: string;
    lastName: string;
    phone: string;
    phoneHint: string;
    phoneInvalid: string;
    notes: string;
    notesPlaceholder: string;
    addNote: string;
    remember: string;
  };
  day: { today: string; tomorrow: string; closed: string };
  parts: { morning: string; afternoon: string; evening: string };
  noSlots: string;
  nextOpen: string;
  loadingSlots: string;
  pickDate: string;
  promo: {
    labels: Record<string, string>;
    chip: string;
    chipLabel: string;
    dayHint: string;
    dayMark: string;
    firstVisit: string;
    firstVisitLoses: string;
    checking: string;
    payAtStudio: string;
    applied: string;
  };
  combo: {
    askFeet: string;
    askHands: string;
    none: string;
    hint: string;
    saving: string;
    pairHint: string;
    comboHint: string;
    discount: string;
    total: string;
    badge: string;
  };
  trust: { reviews: string; ratingOnly: string; instant: string; pay: string; change: string };
  studio: { name: string; area: string; hours: string; address: string; directions: string; photoAlt: string };
  scarcity: { few: string; last: string };
  success: {
    eyebrow: string;
    title: string;
    body: string;
    with: string;
    google: string;
    ics: string;
    whatsappSent: string;
    changeHint: string;
    changeCta: string;
    changeText: string;
    directions: string;
    address: string;
    again: string;
    calendarTitle: string;
    calendarDetails: string;
  };

  errors: Record<string, string>;
};

/** How far ahead the day strip runs. The panel refuses anything past 120. */
const DAYS_AHEAD = 45;

/**
 * How long a day's times are shown from memory before only the live answer
 * counts. Short on purpose — see the availability block in the component.
 */
const SLOT_TTL_MS = 45_000;

/** The studio's own wall — gold marble and the lit logo. The booking surface's face. */
const STUDIO_PHOTO = "/space-02.jpg";

/**
 * The booking card. On a phone it slides up over the studio photo like an app
 * sheet; on a desktop it's an elevated card beside the studio. Either way the
 * flow lives *inside* something — a form floating on the page read as a toy.
 */
const CARD =
  "relative z-10 -mt-7 min-w-0 rounded-t-[28px] bg-paper px-5 pb-10 pt-6 shadow-[0_-18px_40px_-28px_rgba(28,23,20,0.45)] md:rounded-[28px] md:px-8 md:pb-10 md:shadow-[0_40px_90px_-50px_rgba(28,23,20,0.45)] lg:mt-0 lg:rounded-[28px] lg:border lg:border-ink/8 lg:px-10 lg:pb-10 lg:pt-8 lg:shadow-[0_40px_90px_-50px_rgba(28,23,20,0.45)]";

/** Fewer Google reviews than this and the trust line shows the rating alone. */
const MIN_REVIEWS_TO_COUNT = 20;

/** Younger than this, a cached day isn't refetched on display. */
const FRESH_MS = 10_000;

/** At or below this many free times, the day says so. Real scarcity only. */
const FEW_SLOTS = 3;

/** Where "remember my details" keeps them. Name and phone only, never notes. */
const REMEMBER_KEY = "gbs-reserva-datos";

const ADDRESS = "Golden Beauty Studio, Calle 69 Sur #43a - 41, Sabaneta, Antioquia";

export default function ReservaFlow({
  dict,
  lang,
  today,
  initialSlug,
  initialCatalog,
  rating,
  copy,
  areas,
  handsForFeet,
  whatsappNumber,
  mapsUrl,
}: {
  dict: Dict;
  lang: Locale;
  /** Today in the studio's calendar, computed on the server. */
  today: string;
  /** `?servicio=<price-list id>` — arrive with the service already chosen. */
  initialSlug: string | null;
  /** Rendered with the page; null when the server couldn't reach the panel. */
  initialCatalog: Catalog | null;
  /** Google rating, for the trust line. Null hides it. */
  rating: { value: number; count: number } | null;
  copy: Record<string, ServiceCopy>;
  /** Price-list id → hands / feet. See `data/service-areas.ts`. */
  areas: Record<string, "hands" | "feet">;
  /** Price-list ids a feet service can be paired with. */
  handsForFeet: string[];
  whatsappNumber: string | null;
  mapsUrl: string;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(initialCatalog);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);

  const [step, setStep] = useState<Step>("service");
  const [category, setCategory] = useState<string | null>(null);
  const [service, setService] = useState<Service | null>(null);
  // Which half was picked first. Only so the list doesn't jump from "feet" to
  // "hands" under her finger when she adds the partner; the actual pair is
  // derived from `service`.
  const [firstPick, setFirstPick] = useState<number | null>(null);
  /**
   * The second half of a pair that has no combo: booked as its own
   * appointment right after `service`, same professional. Null otherwise —
   * a pair that *has* a combo is the combo service itself, in `service`.
   */
  const [addOn, setAddOn] = useState<Service | null>(null);
  const [providerId, setProviderId] = useState<number | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState({ firstName: "", lastName: "", phone: "", notes: "" });
  const [remember, setRemember] = useState(true);
  const [showNote, setShowNote] = useState(false);
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [booked, setBooked] = useState<{
    name: string;
    service: string;
    date: string;
    time: string;
    durationMin: number;
    provider: string;
    appointmentId: string;
    /** The panel will send the WhatsApp confirmation (Cloud API configured). */
    whatsappSent: boolean;
    /** Last four digits, to say where it went without printing the number. */
    phoneTail: string;
    /** La promo que se le mostró al reservar, ya en su idioma. Sin precio: eso se ve en el estudio. */
    promo: string | null;
  } | null>(null);

  const topRef = useRef<HTMLDivElement>(null);
  /** Set below, once the service is known: reports funnel steps to Meta. */
  const onStepTracked = useRef<((s: Step) => void) | null>(null);

  // Forward slides left, back slides right — the same spatial logic as the
  // progress bar, so going back feels like going back. Adjusted during render
  // (React's pattern for state derived from a change), not in an effect.
  const [prevStep, setPrevStep] = useState<Step>(step);
  const [direction, setDirection] = useState(1);
  if (prevStep !== step) {
    setDirection(STEPS.indexOf(step) > STEPS.indexOf(prevStep) ? 1 : -1);
    setPrevStep(step);
  }
  const dayStripRef = useRef<HTMLDivElement>(null);
  /** How many times the default day has rolled forward. 0 = she chose it. */
  const autoHops = useRef(0);

  /**
   * When the form was first rendered. The proxy rejects anything submitted
   * faster than a person can read. Stamped in an effect: `Date.now()` during
   * render is impure.
   */
  const startedAt = useRef(0);
  const honeypotRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  // Remembered details from a previous booking on this device.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(REMEMBER_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<typeof form>;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hydration from storage
      setForm((f) => ({
        ...f,
        firstName: saved.firstName ?? "",
        lastName: saved.lastName ?? "",
        phone: saved.phone ?? "",
      }));
    } catch {
      // Private window, blocked storage: start empty.
    }
  }, []);

  /* ── History: each step is an entry ─────────────────────────────────── */

  const scrollToTop = useCallback(() => {
    const el = topRef.current;
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - 96;
    if (window.scrollY > y) window.scrollTo({ top: y, behavior: "smooth" });
  }, []);

  const go = useCallback(
    (next: Step) => {
      setError(null);
      setStep(next);
      window.history.pushState({ gbsStep: next }, "");
      trackEvent("booking_step", { step: STEPS.indexOf(next) + 1 });
      onStepTracked.current?.(next);
      scrollToTop();
    },
    [scrollToTop],
  );

  useEffect(() => {
    window.history.replaceState({ ...(window.history.state ?? {}), gbsStep: "service" }, "");
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as { gbsStep?: Step } | null)?.gbsStep;
      if (s && STEPS.includes(s)) {
        setStep(s);
        setError(null);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const back = () => window.history.back();

  /* ── Catalog ─────────────────────────────────────────────────────────── */

  useEffect(() => {
    // Already rendered with the page: nothing to wait for. A retry after a
    // failure bumps `loadNonce` and comes through here with `catalog` null.
    if (catalog) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/reservas/catalogo");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          services: Service[];
          providers: Provider[];
          combos?: Combo[];
        };
        // An older panel doesn't send `combos`: combos are then listed like any
        // other service and composing is off — exactly how it used to work.
        if (alive) {
          setCatalog({ ...body, combos: body.combos ?? [] });
          setLoadFailed(false);
        }
      } catch {
        if (alive) setLoadFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a retry refetches
  }, [loadNonce]);

  const nameOf = useCallback(
    (s: Service) => (s.slug && copy[s.slug]?.name) || s.name,
    [copy],
  );
  const descOf = (s: Service) => (s.slug && copy[s.slug]?.desc) || null;

  /**
   * Grouped by category in EA's order — which is `pricing.ts`'s, the price
   * list's. Category labels come from the dictionary when the service is
   * linked, so they read in the visitor's language.
   */
  const grouped = useMemo(() => {
    if (!catalog) return [];
    const out = new Map<string, Service[]>();
    for (const s of catalog.services) {
      // Combos aren't listed: you reach them by composing.
      if (s.isCombo && catalog.combos.length > 0) continue;
      const key = (s.slug && copy[s.slug]?.category) || s.category || "";
      const list = out.get(key);
      if (list) list.push(s);
      else out.set(key, [s]);
    }
    return [...out.entries()];
  }, [catalog, copy]);

  const activeCategory = category ?? grouped[0]?.[0] ?? null;
  const visible = grouped.find(([c]) => c === activeCategory)?.[1] ?? [];

  /* ── The combo, derived from the chosen service ──────────────────────── */

  const composed = useMemo(
    () => catalog?.combos.find((c) => c.serviceId === service?.id) ?? null,
    [catalog, service],
  );

  const baseId = composed
    ? firstPick === composed.feetServiceId
      ? composed.feetServiceId
      : composed.handsServiceId
    : (service?.id ?? null);

  const partnerId = composed
    ? baseId === composed.handsServiceId
      ? composed.feetServiceId
      : composed.handsServiceId
    : (addOn?.id ?? null);

  const base = useMemo(
    () => catalog?.services.find((s) => s.id === baseId) ?? null,
    [catalog, baseId],
  );

  const partnersOf = useCallback(
    (id: number | null) => {
      if (!catalog || id === null) return [];
      const ids = new Set<number>();
      for (const c of catalog.combos) {
        if (c.handsServiceId === id) ids.add(c.feetServiceId);
        else if (c.feetServiceId === id) ids.add(c.handsServiceId);
      }
      // Without a combo, any hands service takes any feet service — and a feet
      // service the simple hands ones — as a plain sum. Only when the panel
      // can book two appointments in a row.
      const self = catalog.services.find((s) => s.id === id);
      const area = self?.slug ? areas[self.slug] : undefined;
      if (catalog.chained && area) {
        const wanted =
          area === "hands"
            ? (slug: string) => areas[slug] === "feet"
            : (slug: string) => handsForFeet.includes(slug);
        for (const s of catalog.services) {
          if (s.id !== id && !s.isCombo && s.slug && wanted(s.slug)) ids.add(s.id);
        }
      }
      return catalog.services.filter((s) => ids.has(s.id));
    },
    [catalog, areas, handsForFeet],
  );

  const partners = useMemo(() => partnersOf(baseId), [partnersOf, baseId]);

  /** Add-on options grouped by category, in catalog order — same labels as step 1. */
  const groupPartners = (list: Service[]): [string, Service[]][] => {
    const out = new Map<string, Service[]>();
    for (const p of list) {
      const label = (p.slug && copy[p.slug]?.category) || p.category || "";
      const bucket = out.get(label);
      if (bucket) bucket.push(p);
      else out.set(label, [p]);
    }
    return [...out.entries()];
  };

  /** The combo service that `partner` would turn the current pick into. */
  const comboWith = (partner: Service): Service | null => {
    if (!catalog || baseId === null) return null;
    const c = catalog.combos.find(
      (x) =>
        (x.handsServiceId === baseId && x.feetServiceId === partner.id) ||
        (x.feetServiceId === baseId && x.handsServiceId === partner.id),
    );
    return catalog.services.find((s) => s.id === c?.serviceId) ?? null;
  };

  const baseIsFeet = useMemo(
    () =>
      (catalog?.combos ?? []).some((c) => c.feetServiceId === baseId) ||
      (base?.slug ? areas[base.slug] === "feet" : false),
    [catalog, baseId, base, areas],
  );

  /**
   * The sum of the two halves, **only to strike it through**. What's charged
   * and how long it takes belong to the combo and come from EA. A combo that
   * saves nothing isn't struck: that would be false advertising.
   */
  const partsSum = useMemo(() => {
    if (!composed || !service || !catalog) return null;
    const hands = catalog.services.find((s) => s.id === composed.handsServiceId);
    const feet = catalog.services.find((s) => s.id === composed.feetServiceId);
    if (!hands || !feet) return null;
    const price = hands.priceCOP + feet.priceCOP;
    const saving = price - service.priceCOP;
    return saving > 0 ? { price, saving } : null;
  }, [composed, service, catalog]);

  /**
   * What's being booked, as one visit: a service, a combo, or a pair. For a
   * pair the price and the time are the plain sum — two appointments, one
   * after the other — and everything on screen reads from here.
   */
  const visit: Service | null = service
    ? addOn
      ? {
          ...service,
          durationMin: service.durationMin + addOn.durationMin,
          priceCOP: service.priceCOP + addOn.priceCOP,
        }
      : service
    : null;
  /** The availability key: the service, or "first+then" for a pair. */
  const bookingKey: number | string | null = service ? (addOn ? `${service.id}+${addOn.id}` : service.id) : null;
  const visitName = service ? (addOn ? `${nameOf(service)} + ${nameOf(addOn)}` : nameOf(service)) : null;

  /* ── Promos: la del día al elegir fecha, el 10% al escribir el celular ─── */
  //
  // La promo del día se calcula acá con el catálogo, en el mismo toque en que
  // se elige el miércoles. El 10% de primera visita no se puede: depende del
  // historial de la clienta, que solo tiene el panel. En cuanto ella escribe un
  // celular válido en el paso 3 se le pide la cotización al panel, y desde ahí
  // manda la cotización — es la misma función (`bestPromo`) que usa el cierre
  // de la cuenta, así que la pantalla y la caja dicen el mismo número.
  //
  // En el paso 1 no hay fecha elegida todavía (aunque `date` recuerde una de
  // antes): se muestra el precio de lista y las pistas de qué día baja.

  const promoDate = step !== "service" ? date : null;
  const visitLines = useMemo(
    () => (service ? (addOn ? [service, addOn] : [service]) : []),
    [service, addOn],
  );
  const dayPromo = useMemo(
    () => (promoDate ? dayPromoOn(visitLines, promoDate) : null),
    [visitLines, promoDate],
  );
  const [quote, setQuote] = useState<{ key: string; value: ServerQuote } | null>(null);
  const [quoting, setQuoting] = useState(false);
  /** Una cotización por visita + celular: volver atrás y adelante no gasta el cupo del proxy. */
  const quoteCache = useRef(new Map<string, ServerQuote>());
  const phoneDigits = form.phone.replace(/[^\d+]/g, "");
  const quoteKey =
    service && promoDate ? `${service.id}|${addOn?.id ?? ""}|${promoDate}|${phoneDigits}` : null;
  const activeQuote = quote && quote.key === quoteKey ? quote.value : null;

  const pricing = visit ? visitPricing(visit.priceCOP, dayPromo, activeQuote) : null;
  /** Lo que se le muestra y lo que se reporta como valor: con la promo ya descontada. */
  const totalCOP = pricing?.total ?? visit?.priceCOP ?? 0;
  const listCOP = activeQuote?.subtotal ?? visit?.priceCOP ?? 0;
  const firstVisitPercent = catalog?.firstVisitPercent ?? 10;
  const promoLabel = (slug: string) =>
    fill(dict.promo.labels[slug] ?? slug, { percent: String(firstVisitPercent) });

  /**
   * Los renglones del recibo del paso 3: las dos mitades de un combo (con su
   * descuento de combo aparte, como en el paso 1), las dos citas de un par, o
   * el servicio solo.
   */
  const receiptLines = useMemo(() => {
    if (!service) return [];
    if (composed && partsSum && catalog) {
      const halves = [composed.handsServiceId, composed.feetServiceId]
        .map((id) => catalog.services.find((s) => s.id === id))
        .filter((s): s is Service => s !== undefined);
      if (halves.length === 2) return halves.map((s) => ({ name: nameOf(s), price: s.priceCOP }));
    }
    const parts = addOn ? [service, addOn] : [service];
    return parts.map((s) => ({ name: nameOf(s), price: s.priceCOP }));
  }, [service, addOn, composed, partsSum, catalog, nameOf]);

  const resetSlot = () => {
    setSlot(null);
    setSlots(null);
  };

  /**
   * Pick in step 1. Undoes any combo, and stays put: the person moves on with
   * "Continuar" when they're ready. Jumping ahead on tap hid exactly what this
   * step should show — the add-on question and what the combo saves.
   */
  const chooseService = (s: Service) => {
    setService(s);
    setAddOn(null);
    setFirstPick(s.id);
    setProviderId(null);
    resetSlot();
    setError(null);
    // The times are fetched now anyway, so step 2 opens with them.
    prefetchFirstDay(s);
  };

  /**
   * Add or remove the other half. With it, what's booked becomes **the combo**:
   * another service, its own price and duration — so technician and time reset,
   * because a two-hour slot isn't a one-hour slot.
   */
  const choosePartner = (partner: Service | null) => {
    if (!catalog || baseId === null) return;
    // A combo, if the pair has one; otherwise the plain sum, as two
    // appointments in a row (`addOn`).
    const combo = partner === null ? null : comboWith(partner);
    const next = combo ?? base;
    setService(next);
    setAddOn(partner !== null && combo === null ? partner : null);
    setProviderId(null);
    resetSlot();
    if (next) prefetchFirstDay(next, partner !== null && combo === null ? partner : null);
  };

  // Arriving from the price list with `?servicio=`. A combo id lands as the
  // combo with its hands half first; a service with a partner waits on step 1
  // so the "feet too?" question isn't skipped.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (!catalog || deepLinked.current || !initialSlug) return;
    deepLinked.current = true;
    const target = catalog.services.find((s) => s.slug === initialSlug);
    if (!target) return;
    const asCombo = catalog.combos.find((c) => c.serviceId === target.id);
    const pickId = asCombo ? asCombo.handsServiceId : target.id;
    const pick = catalog.services.find((s) => s.id === pickId) ?? target;
    /* eslint-disable react-hooks/set-state-in-effect -- one-shot, once the catalog arrives */
    setService(target);
    setFirstPick(pick.id);
    setCategory((pick.slug && copy[pick.slug]?.category) || pick.category || null);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (asCombo || partnersOf(target.id).length === 0) go("slot");
  }, [catalog, initialSlug, copy, partnersOf, go]);

  /* ── Providers and days ──────────────────────────────────────────────── */

  const providers = useMemo(
    () =>
      service && catalog
        ? catalog.providers.filter(
            (p) => p.serviceIds.includes(service.id) && (!addOn || p.serviceIds.includes(addOn.id)),
          )
        : [],
    [catalog, service, addOn],
  );
  const chosenProvider = providers.find((p) => p.id === providerId) ?? null;

  const days = useMemo(() => buildDays(today, DAYS_AHEAD), [today]);
  /** Los días de la tira en que esta visita tiene promo, para marcarlos. */
  const promoDays = useMemo(
    () => new Set(visitLines.length === 0 ? [] : days.filter((d) => dayPromoOn(visitLines, d) !== null)),
    [visitLines, days],
  );
  const schedules = useMemo(
    () => (chosenProvider ? [chosenProvider.schedule] : providers.map((p) => p.schedule)),
    [chosenProvider, providers],
  );
  const openDays = useMemo(
    () => new Set(days.filter((d) => isDayOpen(d, schedules))),
    [days, schedules],
  );
  const nextOpenAfter = (iso: string | null) =>
    days.find((d) => (iso === null || d > iso) && openDays.has(d)) ?? null;

  // Entering step 2, or changing technician onto a closed day: land on the
  // first open day so there are times on screen without a tap.
  useEffect(() => {
    if (step !== "slot" || !service) return;
    if (date && openDays.has(date)) return;
    const first = days.find((d) => openDays.has(d)) ?? null;
    autoHops.current = first ? 1 : 0;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived default
    setDate(first);
    setSlot(null);
    setSlots(null);
  }, [step, service, date, openDays, days]);

  // A day we picked for her that turns out full — today after 5 p.m., a
  // booked-out Saturday — rolls on to the next open one, a few times at most.
  // A day she tapped herself stays put and says so.
  useEffect(() => {
    if (step !== "slot" || slots === null || slots.length > 0 || autoHops.current === 0) return;
    if (autoHops.current > 6) {
      autoHops.current = 0;
      return;
    }
    const next = days.find((d) => date !== null && d > date && openDays.has(d));
    if (!next) return;
    autoHops.current += 1;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- rolling the default forward
    setDate(next);
    setSlots(null);
  }, [step, slots, date, days, openDays]);

  // The add-on box opens under the chosen card; bring it into view if it
  // opened below the fold, so the question doesn't happen off-screen.
  useEffect(() => {
    if (step !== "service" || partners.length === 0) return;
    const t = window.setTimeout(() => {
      const box = document.querySelector<HTMLElement>("[data-addon]");
      if (!box) return;
      const r = box.getBoundingClientRect();
      const bottomBar = 96;
      if (r.top > window.innerHeight - bottomBar - 80) {
        window.scrollBy({ top: r.top - window.innerHeight * 0.35, behavior: "smooth" });
      }
    }, 320);
    return () => window.clearTimeout(t);
  }, [step, baseId, partners.length]);

  // Keep the chosen day in view in the strip.
  useEffect(() => {
    if (step !== "slot" || !date) return;
    // Horizontal only: `scrollIntoView` would also scroll the window and tuck
    // the step's heading under the nav.
    const strip = dayStripRef.current;
    const el = strip?.querySelector<HTMLElement>(`[data-day="${date}"]`);
    if (strip && el) {
      strip.scrollTo({
        left: el.offsetLeft - strip.offsetLeft - (strip.clientWidth - el.clientWidth) / 2,
        behavior: "smooth",
      });
    }
  }, [step, date]);

  /* ── Availability: fetched ahead, kept briefly, always rechecked ─────── */
  //
  // A tap on a day should show times now, not after a round trip. So the
  // first open day is fetched while she's still deciding on a service, and
  // the next two open days while she reads the times of this one.
  //
  // Holding them for a short while is safe for one reason: the panel
  // re-verifies the slot against fresh data before it writes anything, and a
  // lost race comes back as `taken`, which drops the cache and reloads. A day
  // shown from the cache is refetched underneath anyway, so a time that went
  // meanwhile disappears on its own.

  const slotCache = useRef(new Map<string, { at: number; slots: Slot[] }>());
  const inflight = useRef(new Map<string, Promise<Slot[] | null>>());
  /** Free-time count per day already seen — state, because the strip renders it. */
  const [knownLoads, setKnownLoads] = useState<Record<string, number>>({});

  // `serviceId` may be "17+15" for a pair: the times for a pair are not the
  // times for its first half.
  const keyOf = (serviceId: number | string, day: string, provider: number | null) =>
    `${serviceId}|${day}|${provider ?? "any"}`;

  const fetchSlots = useCallback(
    (serviceId: number | string, day: string, provider: number | null): Promise<Slot[] | null> => {
      const key = keyOf(serviceId, day, provider);
      const running = inflight.current.get(key);
      if (running) return running;
      const [first, then] = String(serviceId).split("+");
      const query = new URLSearchParams({ serviceId: first, date: day });
      if (then) query.set("thenServiceId", then);
      if (provider !== null) query.set("providerId", String(provider));
      const p = fetch(`/api/reservas/disponibilidad?${query}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          const body = (await res.json()) as { slots: Slot[] };
          slotCache.current.set(key, { at: Date.now(), slots: body.slots });
          setKnownLoads((prev) => (prev[key] === body.slots.length ? prev : { ...prev, [key]: body.slots.length }));
          return body.slots;
        })
        .catch(() => null)
        .finally(() => inflight.current.delete(key));
      inflight.current.set(key, p);
      return p;
    },
    [],
  );

  const cachedSlots = (serviceId: number | string, day: string, provider: number | null) => {
    const hit = slotCache.current.get(keyOf(serviceId, day, provider));
    return hit && Date.now() - hit.at < SLOT_TTL_MS ? hit.slots : null;
  };

  // The visible day: cached times at once if we have them, then the live answer.
  useEffect(() => {
    if (!service || !date || step === "service") return;
    let alive = true;
    const key = keyOf(bookingKey!, date, providerId);
    const hit = cachedSlots(bookingKey!, date, providerId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- show what we already know
    setSlots(hit);
    // Just fetched (the prefetch a moment ago): no second trip for the same answer.
    const age = Date.now() - (slotCache.current.get(key)?.at ?? 0);
    if (hit && age < FRESH_MS) return;
    void fetchSlots(bookingKey!, date, providerId).then((fresh) => {
      if (!alive) return;
      if (fresh) setSlots(fresh);
      else if (!hit) {
        setSlots([]);
        setError(dict.errors.unavailable);
      }
    });
    return () => {
      alive = false;
    };
    // `step` only gates the first fetch; leaving step 2 must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, bookingKey, date, providerId, dict.errors.unavailable, fetchSlots, step === "service"]);

  // Ahead of time: the next two open days, once this one has answered.
  useEffect(() => {
    if (step !== "slot" || !service || !date || slots === null) return;
    const ahead = days.filter((d) => d > date && openDays.has(d)).slice(0, 2);
    const run = () => {
      for (const d of ahead) {
        if (!cachedSlots(bookingKey!, d, providerId)) void fetchSlots(bookingKey!, d, providerId);
      }
    };
    const idle = window.requestIdleCallback?.(run, { timeout: 1500 }) ?? window.setTimeout(run, 400);
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, service, bookingKey, date, providerId, slots, days, openDays, fetchSlots]);

  /**
   * The first day anyone could do `svc`, fetched now — during the beat between
   * the tap and step 2 — so the times are usually there when it slides in.
   */
  const prefetchFirstDay = (svc: Service, then: Service | null = null) => {
    if (!catalog) return;
    const key = then ? `${svc.id}+${then.id}` : svc.id;
    const who = catalog.providers
      .filter((p) => p.serviceIds.includes(svc.id) && (!then || p.serviceIds.includes(then.id)))
      .map((p) => p.schedule);
    const first = days.find((d) => isDayOpen(d, who));
    if (first && !cachedSlots(key, first, null)) void fetchSlots(key, first, null);
  };

  /** What the strip knows about a day it has already seen: full, nearly full, or nothing yet. */
  const dayLoad = (d: string): "full" | "few" | null => {
    if (!service) return null;
    const known = knownLoads[keyOf(bookingKey!, d, providerId)];
    if (known === undefined) return null;
    if (known === 0) return "full";
    return known <= FEW_SLOTS ? "few" : null;
  };

  /* ── Meta funnel ───────────────────────────────────────────────────── */
  //
  // ViewContent = a service chosen, InitiateCheckout = a time chosen, Schedule
  // = booked (sent from the browser *and* the server with one event id). This
  // is what lets the ads optimise for bookings instead of for clicks.
  const metaParams = () =>
    service
      ? {
          content_ids: [service.slug ?? String(service.id)],
          content_name: visitName,
          content_type: "product",
          // Con la promo descontada: es lo que va a pagar, y lo que la pauta
          // tiene que optimizar.
          value: totalCOP,
          currency: "COP",
        }
      : {};
  useEffect(() => {
    onStepTracked.current = (next) => {
      if (next === "slot") trackMeta("ViewContent", metaParams());
      if (next === "details") trackMeta("InitiateCheckout", metaParams());
    };
  });

  /* ── Submit ──────────────────────────────────────────────────────────── */

  const phoneOk = isPlausiblePhone(form.phone);
  const canSubmit =
    form.firstName.trim() !== "" && form.lastName.trim() !== "" && phoneOk && !sending;

  // La cotización con el celular: solo en el paso 3, solo con un número que el
  // panel va a aceptar, y con una pausa para no preguntar por cada dígito. Una
  // falla no se le muestra a nadie: se queda la promo del día que ya se ve, y
  // en el estudio se aplica lo que corresponda igual.
  useEffect(() => {
    if (step !== "details" || !service || !promoDate || !phoneOk || quoteKey === null) return;
    const cached = quoteCache.current.get(quoteKey);
    if (cached) {
      setQuote({ key: quoteKey, value: cached });
      return;
    }
    let alive = true;
    const key = quoteKey;
    const timer = window.setTimeout(() => {
      setQuoting(true);
      void fetch("/api/reservas/cotizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: service.id,
          thenServiceId: addOn?.id ?? null,
          date: promoDate,
          phone: form.phone,
        }),
      })
        .then(async (res) => (res.ok ? parseQuote(await res.json()) : null))
        .catch(() => null)
        .then((value) => {
          if (!value) return;
          quoteCache.current.set(key, value);
          if (alive) setQuote({ key, value });
        })
        .finally(() => {
          if (alive) setQuoting(false);
        });
    }, 600);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      setQuoting(false);
    };
    // `form.phone` va por `quoteKey` (sus dígitos): un espacio de más no recotiza.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, quoteKey, phoneOk]);

  async function submit() {
    if (!service || !slot || !date) return;
    if (!canSubmit) {
      setPhoneTouched(true);
      return;
    }
    setSending(true);
    setError(null);
    const eventId = newEventId("schedule");

    try {
      const res = await fetch("/api/reservas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: service.id,
          // The second half of a pair: the panel books it right after, same professional.
          thenServiceId: addOn?.id ?? null,
          date,
          time: slot.time,
          providerId,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone,
          notes: form.notes,
          startedAt: startedAt.current,
          empresa: honeypotRef.current?.value ?? "",
          // For the server's copy of the Meta event, so both count as one.
          eventId,
          value: totalCOP,
          serviceSlug: service.slug ?? null,
        }),
      });

      const body = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        booking?: {
          appointmentId?: number;
          provider: { name: string };
          start: string;
          /** Sent by panels with the WhatsApp Cloud API; older ones omit it. */
          whatsappConfirmation?: "sending" | "disabled";
        };
      };

      if (res.status === 201 && body.booking) {
        try {
          if (remember) {
            localStorage.setItem(
              REMEMBER_KEY,
              JSON.stringify({
                firstName: form.firstName.trim(),
                lastName: form.lastName.trim(),
                phone: form.phone.trim(),
              }),
            );
          } else {
            localStorage.removeItem(REMEMBER_KEY);
          }
        } catch {
          // Storage blocked: nothing to remember, nothing lost.
        }
        trackEvent("booking_confirmed", { service: service.slug ?? service.id, value: totalCOP, currency: "COP" });
        trackMeta("Schedule", metaParams(), eventId);
        setBooked({
          name: form.firstName.trim(),
          service: visitName ?? nameOf(service),
          date,
          time: slot.time,
          durationMin: visit?.durationMin ?? service.durationMin,
          provider: body.booking.provider.name,
          appointmentId: String(body.booking.appointmentId ?? `${date}-${slot.time}`),
          whatsappSent: body.booking.whatsappConfirmation === "sending",
          phoneTail: form.phone.replace(/\D/g, "").slice(-4),
          promo: pricing?.promo ? promoLabel(pricing.promo.slug) : null,
        });
        window.history.replaceState({ gbsStep: "details" }, "");
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }

      // Someone else took it. Back to the times, freshly loaded, so she picks
      // from what's real now instead of re-submitting into the same wall.
      if (body.reason === "taken") {
        slotCache.current.delete(keyOf(bookingKey!, date, providerId));
        setSlot(null);
        setSlots(null);
        // The times effect keys on service/day/technician, none of which
        // changed — so the reload is explicit, or step 2 would spin forever.
        void fetchSlots(bookingKey!, date, providerId).then((fresh) => setSlots(fresh ?? []));
        setStep("slot");
        window.history.replaceState({ gbsStep: "slot" }, "");
        setError(dict.errors.taken);
        scrollToTop();
        return;
      }

      setError(dict.errors[body.reason ?? "unavailable"] ?? dict.errors.unavailable);
    } catch {
      setError(dict.errors.unavailable);
    } finally {
      setSending(false);
    }
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  if (booked) {
    // Same motion provider as the flow: outside it, the `m.*` elements of the
    // confirmation never get their animation features and stay at their
    // initial state — invisible.
    return (
      <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
      <div className="mx-auto max-w-[1180px] pb-24 md:max-w-[720px] md:px-6 md:pt-8 lg:max-w-[1180px] lg:px-8 lg:pt-10">
        <StudioBanner dict={dict} rating={rating} lang={lang} />
        <div className="lg:grid lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start lg:gap-8">
          <aside className="hidden lg:sticky lg:top-28 lg:block">
            <StudioCard dict={dict} rating={rating} lang={lang} mapsUrl={mapsUrl} />
          </aside>
          <section className={CARD}>
      <Success
        dict={dict}
        lang={lang}
        booked={booked}
        whatsappNumber={whatsappNumber}
        mapsUrl={mapsUrl}
        onAgain={() => {
          setBooked(null);
          setService(null);
          setAddOn(null);
          setFirstPick(null);
          setProviderId(null);
          setDate(null);
          resetSlot();
          setForm((f) => ({ ...f, notes: "" }));
          setShowNote(false);
          startedAt.current = Date.now();
          setStep("service");
          window.history.replaceState({ gbsStep: "service" }, "");
        }}
      />
          </section>
        </div>
      </div>
      </MotionConfig>
      </LazyMotion>
    );
  }

  const stepIndex = STEPS.indexOf(step);
  const canContinue =
    (step === "service" && service !== null) || (step === "slot" && slot !== null);

  const summary = (
    <Summary
      dict={dict}
      lang={lang}
      service={visit}
      serviceName={visitName}
      partsSum={partsSum}
      promo={pricing?.promo ? { label: promoLabel(pricing.promo.slug), discount: pricing.promo.discount } : null}
      total={totalCOP}
      provider={chosenProvider?.name ?? null}
      date={step !== "service" ? date : null}
      slot={step !== "service" ? slot : null}
      onEdit={(s) => go(s)}
    />
  );

  return (
    <LazyMotion features={domAnimation} strict>
    <MotionConfig reducedMotion="user" transition={{ duration: 0.24, ease: [0.25, 1, 0.5, 1] }}>
    <div ref={topRef} className="mx-auto max-w-[1180px] pb-40 md:max-w-[720px] md:px-6 md:pt-8 lg:max-w-[1180px] lg:px-8 lg:pb-20 lg:pt-10">
      <StudioBanner dict={dict} rating={rating} lang={lang} />

      <div className="lg:grid lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start lg:gap-8">
        {/* Desktop: the studio, and what's been chosen, beside the steps. */}
        <aside className="hidden lg:sticky lg:top-28 lg:block">
          <StudioCard dict={dict} rating={rating} lang={lang} mapsUrl={mapsUrl} />
          <div className="mt-4">{summary}</div>
        </aside>

        <section className={CARD}>
          <Progress dict={dict} step={step} reachable={(s) => STEPS.indexOf(s) < stepIndex} onGo={go} />

          {step === "service" && (
            <div className="lg:hidden">
              {/* The rating is already on the photo header above. */}
              <TrustLine dict={dict} rating={null} lang={lang} />
            </div>
          )}

        <div className="mt-7 min-w-0">
          {error && (
            <p
              role="alert"
              className="gbs-step mb-6 flex items-start gap-3 rounded-2xl border border-gold-dark/25 bg-gold-pale/70 px-4 py-3 font-sans text-sm text-gold-deep"
            >
              <span aria-hidden className="mt-0.5 text-base leading-none">!</span>
              <span>{error}</span>
            </p>
          )}

          <AnimatePresence mode="wait" initial={false} custom={direction}>
          {/* ── 1 · Service ───────────────────────────────────────────── */}
          {step === "service" && (
            <m.section key="service" {...stepMotion} custom={direction} aria-labelledby="h-service">
              <StepHeading id="h-service" n={1} title={dict.headings.service} />

              {loadFailed ? (
                <LoadError dict={dict} onRetry={() => setLoadNonce((n) => n + 1)} />
              ) : !catalog ? (
                <Skeleton />
              ) : (
                <>
                  {grouped.length > 1 && (
                    <div
                      role="tablist"
                      aria-label={dict.steps.service}
                      className="-mx-5 mb-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none] md:mx-0 md:px-0"
                    >
                      {grouped.map(([c, items]) => {
                        const active = c === activeCategory;
                        const holdsChoice = items.some((s) => s.id === baseId);
                        return (
                          <button
                            key={c}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => setCategory(c)}
                            className={`relative shrink-0 rounded-full border px-4 py-2 font-sans text-[13px] transition-colors ${
                              active
                                ? "border-carbon bg-carbon text-cream"
                                : "border-ink/15 bg-paper text-ink-soft hover:border-gold/60"
                            }`}
                          >
                            {c || "—"}
                            {holdsChoice && !active && (
                              <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-gold" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <ul key={activeCategory} className="gbs-step grid gap-2.5 sm:grid-cols-2">
                    {visible.map((s) => {
                      const selected = baseId === s.id;
                      const desc = descOf(s);
                      const expanded = selected && partners.length > 0;
                      return (
                        <li key={s.id} className={expanded ? "sm:col-span-2" : ""}>
                          <m.button
                            type="button"
                            whileTap={{ scale: 0.985 }}
                            onClick={() => chooseService(s)}
                            aria-pressed={selected}
                            className={`group relative flex w-full flex-col items-start rounded-2xl ${expanded ? "" : "h-full"} border px-4 py-4 text-left transition-all duration-200 ${
                              selected
                                ? "border-gold bg-paper shadow-[0_8px_30px_-12px_rgba(139,106,31,0.45)]"
                                : "border-ink/10 bg-paper/60 hover:-translate-y-px hover:border-gold/50 hover:bg-paper"
                            }`}
                          >
                            <span className="flex w-full items-start justify-between gap-3">
                              <span className="font-display text-[21px] leading-tight text-ink">
                                {nameOf(s)}
                              </span>
                              <Check on={selected} />
                            </span>
                            {desc && (
                              <span className="mt-1 font-sans text-[12.5px] leading-snug text-ink-mute">
                                {desc}
                              </span>
                            )}
                            <span className="mt-3 flex items-center gap-2 font-sans text-[12px] text-ink-soft">
                              <ClockIcon />
                              {formatDuration(s.durationMin, lang)}
                              <span aria-hidden className="text-ink/25">·</span>
                              <span className="font-semibold text-ink">{formatCOP(s.priceCOP, lang)}</span>
                            </span>
                            {/* La promo del día, antes de elegir fecha: quien
                                llegó por el afiche de los miércoles la reconoce
                                acá, y quien no, se entera de que existe. */}
                            {promoHints(s.priceCOP, s.dayPromos).map((p) => {
                              const values = { day: weekdayName(p.weekday, lang), price: formatCOP(p.promoCOP, lang) };
                              return (
                                <span
                                  key={`${p.slug}-${p.weekday}`}
                                  className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-gold/15 px-2.5 py-0.5 font-sans text-[11px] font-semibold tracking-wide text-gold-deep"
                                >
                                  <span aria-hidden>✦</span>
                                  <span aria-hidden>{fill(dict.promo.chip, values)}</span>
                                  <span className="sr-only">
                                    {fill(dict.promo.chipLabel, { ...values, day: values.day.toLowerCase() })}
                                  </span>
                                </span>
                              );
                            })}
                          </m.button>

                          {/* The other half. Only when this forms a combo, and only
                              offering pairs that are one — a pair with no combo has
                              no price to show. */}
                          <AnimatePresence initial={false}>
                          {expanded && (
                            <m.div
                              key="combo"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              className="overflow-hidden"
                            >
                            <div data-addon className="mt-2.5 rounded-2xl border border-gold/35 bg-gradient-to-br from-gold-pale/80 to-paper p-4 md:p-5">
                              <p className="font-display text-[22px] leading-tight text-ink">
                                {baseIsFeet ? dict.combo.askHands : dict.combo.askFeet}
                              </p>
                              <p className="mt-0.5 font-sans text-[12.5px] text-ink-mute">{dict.combo.hint}</p>
                              {/* "No, solo eso" first: it's the answer most of the
                                  time, and it shouldn't be the last row of a long list.
                                  With many options (feet first, then any hands
                                  service) they're grouped by category, like step 1. */}
                              <div className="mt-3">
                                <PillChoice selected={partnerId === null} onClick={() => choosePartner(null)}>
                                  <span>{dict.combo.none}</span>
                                </PillChoice>
                              </div>
                              {groupPartners(partners).map(([label, group]) => (
                                <div key={label || "_"} className="mt-3">
                                  {label && partners.length > 4 && (
                                    <p className="mb-1.5 font-sans text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-mute">
                                      {label}
                                    </p>
                                  )}
                                  <ul className="grid gap-2 sm:grid-cols-2">
                                    {group.map((p) => {
                                      const combo = comboWith(p);
                                      const saves = combo && base ? base.priceCOP + p.priceCOP - combo.priceCOP : 0;
                                      return (
                                        <li key={p.id}>
                                          <PillChoice selected={partnerId === p.id} onClick={() => choosePartner(p)}>
                                            {/* The badge goes under the name, not beside it:
                                                side by side on a phone, both got truncated. */}
                                            <span className="flex min-w-0 flex-col items-start gap-1">
                                              <span className="leading-snug">{nameOf(p)}</span>
                                              {combo && saves > 0 && (
                                                <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[10.5px] font-semibold tracking-wide text-gold-deep">
                                                  {fill(dict.combo.badge, { amount: formatCOP(saves, lang) })}
                                                </span>
                                              )}
                                            </span>
                                            {/* Its own price, so it reads like the price list.
                                                What the visit comes to — with the combo
                                                discount, if any — is in the breakdown below. */}
                                            <span className="whitespace-nowrap text-[13px] text-ink-mute">
                                              + {formatCOP(p.priceCOP, lang)}
                                            </span>
                                          </PillChoice>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              ))}
                              <AnimatePresence initial={false}>
                                {partnerId !== null && base && service && (
                                  <m.div
                                    key="breakdown"
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: "auto" }}
                                    exit={{ opacity: 0, height: 0 }}
                                    className="overflow-hidden"
                                  >
                                    <VisitBreakdown
                                      dict={dict}
                                      lang={lang}
                                      lines={[
                                        { name: nameOf(base), price: base.priceCOP },
                                        ...(() => {
                                          const other = catalog?.services.find((x) => x.id === partnerId);
                                          return other ? [{ name: nameOf(other), price: other.priceCOP }] : [];
                                        })(),
                                      ]}
                                      discount={partsSum?.saving ?? 0}
                                      total={visit?.priceCOP ?? service.priceCOP}
                                      durationMin={visit?.durationMin ?? service.durationMin}
                                      note={addOn ? dict.combo.pairHint : dict.combo.comboHint}
                                    />
                                  </m.div>
                                )}
                              </AnimatePresence>
                            </div>
                            </m.div>
                          )}
                          </AnimatePresence>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </m.section>
          )}

          {/* ── 2 · Day and time ──────────────────────────────────────── */}
          {step === "slot" && service && (
            <m.section key="slot" {...stepMotion} custom={direction} aria-labelledby="h-slot">
              <StepHeading id="h-slot" n={2} title={dict.headings.slot} onBack={back} backLabel={dict.back} />

              {providers.length > 1 && (
                <div className="mb-6">
                  <p className="mb-2 font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-ink-mute">
                    {dict.provider.label}
                  </p>
                  <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0">
                    <ProviderChip
                      selected={providerId === null}
                      onClick={() => {
                        autoHops.current = 1;
                        setProviderId(null);
                        resetSlot();
                      }}
                      name={dict.provider.any}
                      hint={dict.provider.anyHint}
                    />
                    {providers.map((p) => (
                      <ProviderChip
                        key={p.id}
                        selected={providerId === p.id}
                        onClick={() => {
                          autoHops.current = 1;
                          setProviderId(p.id);
                          resetSlot();
                        }}
                        name={p.name}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div className="mb-2 flex items-baseline justify-between">
                <p className="font-display text-[22px] text-ink">
                  {date ? monthYear(date, lang) : dict.pickDate}
                </p>
              </div>
              <div
                ref={dayStripRef}
                className="-mx-5 flex snap-x gap-2 overflow-x-auto px-5 pb-3 [scrollbar-width:none] md:mx-0 md:px-0"
              >
                {days.map((d, i) => {
                  const open = openDays.has(d);
                  const load = open ? dayLoad(d) : null;
                  const selected = date === d;
                  const promoDay = open && promoDays.has(d);
                  const label =
                    i === 0 ? dict.day.today : i === 1 ? dict.day.tomorrow : weekdayShort(d, lang);
                  return (
                    <button
                      key={d}
                      data-day={d}
                      type="button"
                      disabled={!open}
                      onClick={() => {
                        autoHops.current = 0;
                        setDate(d);
                        resetSlot();
                        setError(null);
                      }}
                      aria-pressed={selected}
                      aria-label={`${longDate(d, lang)}${open ? "" : ` — ${dict.day.closed}`}${promoDay ? ` — ${dict.promo.dayMark}` : ""}`}
                      className={`relative flex w-[64px] shrink-0 snap-start flex-col items-center rounded-2xl border py-2.5 font-sans transition-all ${
                        selected
                          ? "border-carbon bg-carbon text-cream shadow-[0_10px_24px_-12px_rgba(28,23,20,0.6)]"
                          : open
                            ? "border-ink/10 bg-paper text-ink hover:border-gold/60"
                            : "cursor-not-allowed border-transparent bg-transparent text-ink/25"
                      }`}
                    >
                      {/* El día con promo para esta visita: una estrella, no un
                          precio — en 64 px no cabe, y el precio aparece al tocarlo. */}
                      {promoDay && (
                        <span
                          aria-hidden
                          className={`absolute right-1.5 top-1 text-[10px] leading-none ${selected ? "text-gold-soft" : "text-gold"}`}
                        >
                          ✦
                        </span>
                      )}
                      <span
                        className={`text-[10px] font-semibold uppercase tracking-wider ${
                          selected ? "text-gold-soft" : open ? "text-ink-mute" : ""
                        }`}
                      >
                        {label}
                      </span>
                      <span className={`mt-0.5 text-[22px] leading-none ${!open || load === "full" ? "line-through opacity-50" : ""}`}>
                        {Number(d.slice(8, 10))}
                      </span>
                      {d.endsWith("-01") && i !== 0 ? (
                        <span className="mt-1 text-[9px] uppercase tracking-wider opacity-70">
                          {monthShort(d, lang)}
                        </span>
                      ) : (
                        <span
                          aria-hidden
                          className={`mt-1.5 h-1 rounded-full transition-all ${
                            !open || load === "full"
                              ? "w-1 bg-transparent"
                              : load === "few"
                                ? "w-3 bg-gold-bright"
                                : `w-1 ${selected ? "bg-gold-soft" : "bg-gold/60"}`
                          }`}
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* La promo del día elegido, dicha con números. */}
              <AnimatePresence initial={false}>
                {dayPromo && visit && (
                  <m.p
                    key={dayPromo.slug}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <span className="mt-1 flex items-start gap-2 rounded-2xl border border-gold/35 bg-gradient-to-br from-gold-pale/80 to-paper px-4 py-3 font-sans text-[13px] text-gold-deep">
                      <span aria-hidden className="mt-px">✦</span>
                      <span>
                        {fill(dict.promo.dayHint, {
                          label: promoLabel(dayPromo.slug),
                          price: formatCOP(visit.priceCOP - dayPromo.discount, lang),
                          was: formatCOP(visit.priceCOP, lang),
                        })}
                      </span>
                    </span>
                  </m.p>
                )}
              </AnimatePresence>

              <div className="mt-4 min-h-[180px]" aria-live="polite">
                {date &&
                  (slots === null ? (
                    <SlotSkeleton label={dict.loadingSlots} />
                  ) : slots.length === 0 ? (
                    <div className="gbs-step rounded-2xl border border-dashed border-ink/15 px-5 py-8 text-center">
                      <p className="font-display text-[22px] text-ink">{dict.noSlots}</p>
                      {nextOpenAfter(date) && (
                        <button
                          type="button"
                          onClick={() => {
                            autoHops.current = 0;
                            setDate(nextOpenAfter(date));
                            resetSlot();
                            setError(null);
                          }}
                          className="mt-4 inline-flex items-center gap-2 rounded-full border border-ink/20 px-5 py-2.5 font-sans text-[13px] text-ink transition-colors hover:border-gold"
                        >
                          {dict.nextOpen} <span aria-hidden>→</span>
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="gbs-step grid gap-6">
                      {slots.length <= FEW_SLOTS && (
                        <p className="-mb-2 flex items-center gap-2 font-sans text-[13px] font-medium text-gold-deep">
                          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gold-bright" />
                          {slots.length === 1
                            ? dict.scarcity.last
                            : fill(dict.scarcity.few, { n: String(slots.length) })}
                        </p>
                      )}
                      {groupByDayPart(slots).map(({ part, slots: group }) => (
                        <div key={part}>
                          <p className="mb-2.5 flex items-center gap-2 font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-ink-mute">
                            <PartIcon part={part} />
                            {dict.parts[part]}
                          </p>
                          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                            {group.map((s) => {
                              const selected = slot?.time === s.time;
                              return (
                                <m.button
                                  key={s.time}
                                  type="button"
                                  whileTap={{ scale: 0.94 }}
                                  onClick={() => setSlot(s)}
                                  aria-pressed={selected}
                                  className={`rounded-xl border py-3 font-sans text-[14px] tabular-nums transition-all ${
                                    selected
                                      ? "border-gold bg-gold text-white shadow-[0_8px_20px_-10px_rgba(172,130,49,0.9)]"
                                      : "border-ink/10 bg-paper text-ink hover:border-gold/60"
                                  }`}
                                >
                                  {/* The group already says morning or
                                      afternoon; the suffix on every button is noise. */}
                                  <span aria-hidden>{formatTime(s.time, lang).replace(/\s?(a\. m\.|p\. m\.|AM|PM)$/, "")}</span>
                                  <span className="sr-only">{formatTime(s.time, lang)}</span>
                                </m.button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
              </div>
            </m.section>
          )}

          {/* ── 3 · Details ───────────────────────────────────────────── */}
          {step === "details" && service && slot && date && (
            <m.section key="details" {...stepMotion} custom={direction} aria-labelledby="h-details">
              <StepHeading id="h-details" n={3} title={dict.headings.details} onBack={back} backLabel={dict.back} />

              {/* Phone: one compact line instead of the full summary card, so
                  the form starts right away instead of a screen further down. */}
              <div className="mb-6 flex items-center gap-3 rounded-2xl bg-carbon px-4 py-3 text-cream lg:hidden">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-display text-[18px] leading-tight">{visitName}</p>
                  <p className="mt-0.5 truncate font-sans text-[12px] text-gold-soft">
                    {weekdayShort(date, lang)} {Number(date.slice(8))} · {formatTime(slot.time, lang)}
                    {chosenProvider ? ` · ${chosenProvider.name}` : ""}
                  </p>
                </div>
                <span className="flex shrink-0 flex-col items-end leading-none">
                  {pricing?.promo && (
                    <span className="mb-1 font-sans text-[11px] text-cream/50 line-through tabular-nums">
                      {formatCOP(listCOP, lang)}
                    </span>
                  )}
                  <AnimatedCOP value={totalCOP} lang={lang} className="font-display text-[20px]" />
                </span>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
                className="grid gap-4"
                noValidate
              >
                {/* Honeypot. Same shape and field name as the careers form:
                    off-screen rather than `display:none` (bots skip those). */}
                <div
                  aria-hidden
                  style={{ position: "absolute", left: "-9999px", width: 1, height: 1, overflow: "hidden" }}
                >
                  <label htmlFor="reserva-empresa">Empresa</label>
                  <input id="reserva-empresa" type="text" name="empresa" tabIndex={-1} autoComplete="off" ref={honeypotRef} />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    id="r-first"
                    label={dict.labels.firstName}
                    value={form.firstName}
                    onChange={(v) => setForm({ ...form, firstName: v })}
                    autoComplete="given-name"
                    required
                  />
                  <Field
                    id="r-last"
                    label={dict.labels.lastName}
                    value={form.lastName}
                    onChange={(v) => setForm({ ...form, lastName: v })}
                    autoComplete="family-name"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="r-phone" className="mb-1.5 block font-sans text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-mute">
                    {dict.labels.phone}
                  </label>
                  <div
                    className={`flex items-stretch overflow-hidden rounded-xl border bg-paper transition-colors focus-within:border-gold ${
                      phoneTouched && !phoneOk ? "border-red-700/50" : "border-ink/15"
                    }`}
                  >
                    {!form.phone.trim().startsWith("+") && (
                      <span className="flex items-center whitespace-nowrap border-r border-ink/10 bg-ivory-deep/50 px-3.5 font-sans text-[15px] tabular-nums text-ink-soft">
                        +57
                      </span>
                    )}
                    <input
                      id="r-phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel-national"
                      required
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: formatPhoneInput(e.target.value) })}
                      onBlur={() => setPhoneTouched(true)}
                      aria-invalid={phoneTouched && !phoneOk}
                      aria-describedby="r-phone-hint"
                      placeholder="300 123 4567"
                      className="w-full bg-transparent px-4 py-3.5 font-sans text-[16px] tabular-nums text-ink outline-none placeholder:text-ink/25"
                    />
                  </div>
                  <p id="r-phone-hint" className={`mt-1.5 font-sans text-xs ${phoneTouched && !phoneOk ? "text-red-800" : "text-ink-mute"}`}>
                    {phoneTouched && !phoneOk ? dict.labels.phoneInvalid : dict.labels.phoneHint}
                  </p>
                </div>

                {showNote ? (
                  <div className="gbs-step">
                    <label htmlFor="r-notes" className="mb-1.5 block font-sans text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-mute">
                      {dict.labels.notes}
                    </label>
                    <textarea
                      id="r-notes"
                      rows={3}
                      maxLength={500}
                      autoFocus
                      value={form.notes}
                      placeholder={dict.labels.notesPlaceholder}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })}
                      className="w-full rounded-xl border border-ink/15 bg-paper px-4 py-3 font-sans text-[16px] text-ink outline-none transition-colors placeholder:text-ink/30 focus:border-gold"
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowNote(true)}
                    className="justify-self-start font-sans text-[13px] text-gold-dark underline decoration-gold/40 underline-offset-4 hover:decoration-gold"
                  >
                    + {dict.labels.addNote}
                  </button>
                )}

                <label className="flex cursor-pointer items-center gap-3 font-sans text-[13px] text-ink-soft">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="h-4 w-4 accent-[#ac8231]"
                  />
                  {dict.labels.remember}
                </label>

                {/* El recibo de la visita, con la promo que aplica. Reacciona
                    al celular: si es su primera visita y el 10% le gana a la
                    promo del día, cambia acá mismo. */}
                <VisitBreakdown
                  dict={dict}
                  lang={lang}
                  lines={receiptLines}
                  discount={partsSum?.saving ?? 0}
                  promo={
                    pricing?.promo
                      ? { label: promoLabel(pricing.promo.slug), discount: pricing.promo.discount }
                      : null
                  }
                  total={totalCOP}
                  durationMin={visit?.durationMin ?? service.durationMin}
                  note={dict.promo.payAtStudio}
                >
                  <AnimatePresence initial={false} mode="popLayout">
                    {pricing?.promo?.slug === "primera-visita" ? (
                      <m.p
                        key="first"
                        initial={{ opacity: 0, y: 6, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ type: "spring", stiffness: 380, damping: 24 }}
                        className="mt-3 flex items-center gap-2 rounded-xl bg-gold/15 px-3 py-2 text-[13px] font-semibold text-gold-deep"
                      >
                        <span aria-hidden>✦</span>
                        {fill(dict.promo.firstVisit, { percent: String(firstVisitPercent) })}
                      </m.p>
                    ) : pricing?.firstVisit === true && pricing.promo ? (
                      <m.p
                        key="loses"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="mt-2 text-[12px] leading-snug text-gold-deep"
                      >
                        {dict.promo.firstVisitLoses}
                      </m.p>
                    ) : quoting ? (
                      <m.p
                        key="checking"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="mt-2 flex items-center gap-2 text-[12px] text-ink-mute"
                      >
                        <Spinner /> {dict.promo.checking}
                      </m.p>
                    ) : null}
                  </AnimatePresence>
                </VisitBreakdown>

                <button
                  type="submit"
                  disabled={sending}
                  className="mt-2 flex items-center justify-center gap-3 rounded-full bg-carbon px-8 py-4 font-sans text-[13px] font-semibold uppercase tracking-[0.2em] text-gold-soft transition-opacity disabled:opacity-60"
                >
                  {sending ? (
                    <>
                      <Spinner /> {dict.sending}
                    </>
                  ) : (
                    <>
                      {dict.confirm}
                      <span className="text-cream/50">·</span>
                      <span className="normal-case tracking-normal text-cream">{formatCOP(totalCOP, lang)}</span>
                    </>
                  )}
                </button>
                <p className="text-center font-sans text-[12px] leading-relaxed text-ink-mute">{dict.summary.pay}</p>
              </form>
            </m.section>
          )}
          </AnimatePresence>
        </div>

          {/* Desktop: the way forward, pinned to the bottom of the card. The
              steps no longer move on by themselves, so the next step is always
              a button — with what's chosen and what it costs right beside it. */}
          {step !== "details" && service && (
            <div className="sticky bottom-0 z-20 -mx-10 -mb-10 mt-8 hidden items-center gap-5 rounded-b-[28px] border-t border-ink/8 bg-paper/95 px-10 py-4 backdrop-blur lg:flex">
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-[20px] leading-tight text-ink">{visitName}</p>
                <p className="mt-0.5 font-sans text-[12.5px] text-ink-mute">
                  {step === "slot" && date && slot
                    ? `${longDate(date, lang)} · ${formatTime(slot.time, lang)}`
                    : formatDuration(visit?.durationMin ?? service.durationMin, lang)}
                  {" · "}
                  {pricing?.promo && (
                    <span className="mr-1.5 text-ink-mute line-through tabular-nums">{formatCOP(listCOP, lang)}</span>
                  )}
                  <AnimatedCOP value={totalCOP} lang={lang} className="font-semibold text-ink" />
                </p>
              </div>
              <m.button
                type="button"
                whileTap={{ scale: 0.97 }}
                disabled={!canContinue}
                onClick={() => go(step === "service" ? "slot" : "details")}
                className="shrink-0 rounded-full bg-carbon px-8 py-3.5 font-sans text-[12px] font-semibold uppercase tracking-[0.2em] text-gold-soft transition-opacity disabled:opacity-35"
              >
                {dict.continue} →
              </m.button>
            </div>
          )}
        </section>
      </div>

      {/* Phone: the same, as a bar under the thumb. Hidden on step 3, where
          the summary sits above the form and the submit is the action. */}
      <AnimatePresence>
      {step !== "details" && service && (
        <m.div
          key="bar"
          initial={{ y: "110%" }}
          animate={{ y: 0 }}
          exit={{ y: "110%" }}
          className="fixed inset-x-0 bottom-0 z-40 border-t border-ink/10 bg-paper/95 px-5 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 shadow-[0_-12px_30px_-18px_rgba(28,23,20,0.35)] backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-[640px] items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-[18px] leading-tight text-ink">{visitName}</p>
              <p className="truncate font-sans text-[12px] text-ink-mute">
                {step === "slot" && date && slot
                  ? `${weekdayShort(date, lang)} ${Number(date.slice(8))} · ${formatTime(slot.time, lang)}`
                  : formatDuration(visit?.durationMin ?? service.durationMin, lang)}
                {" · "}
                {pricing?.promo && (
                    <span className="mr-1.5 text-ink-mute line-through tabular-nums">{formatCOP(listCOP, lang)}</span>
                  )}
                  <AnimatedCOP value={totalCOP} lang={lang} className="font-semibold text-ink" />
              </p>
            </div>
            <button
              type="button"
              disabled={!canContinue}
              onClick={() => go(step === "service" ? "slot" : "details")}
              className="shrink-0 rounded-full bg-carbon px-6 py-3.5 font-sans text-[12px] font-semibold uppercase tracking-[0.18em] text-gold-soft transition-opacity disabled:opacity-35"
            >
              {dict.continue}
            </button>
          </div>
        </m.div>
      )}
      </AnimatePresence>
    </div>
    </MotionConfig>
    </LazyMotion>
  );
}

/**
 * Step transition. Direction comes in as `custom`, so the exiting step leaves
 * the way the new one arrives from. Small distances on purpose: this moves
 * content a thumb is about to touch, it isn't a slideshow.
 */
const stepMotion = {
  variants: {
    enter: (dir: number) => ({ opacity: 0, x: dir * 28 }),
    center: { opacity: 1, x: 0 },
    exit: (dir: number) => ({ opacity: 0, x: dir * -28 }),
  },
  initial: "enter",
  animate: "center",
  exit: "exit",
} as const;

/* ── Pieces ─────────────────────────────────────────────────────────────── */

/**
 * A money figure that counts to its new value instead of swapping. When adding
 * feet takes the total from $95.000 to $135.000, the change is something you
 * see happen — and a discount reads as a discount. Respects reduced motion
 * (the MotionConfig above sets the transition to instant).
 */
function AnimatedCOP({ value, lang, className }: { value: number; lang: Locale; className?: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const controls = animate(from.current, value, {
      duration: 0.55,
      ease: [0.25, 1, 0.5, 1],
      onUpdate: (v) => setShown(Math.round(v / 100) * 100),
    });
    from.current = value;
    return () => controls.stop();
  }, [value]);
  return <span className={`tabular-nums ${className ?? ""}`}>{formatCOP(shown, lang)}</span>;
}

/**
 * What the visit comes to, line by line: each service at its own price, the
 * combo discount as its own line, and the total. Shown under the add-on
 * question once one is picked — and it stays, because the person moves on
 * when they choose to, not when the screen decides.
 *
 * En el paso 3 es además el recibo con la promo: la del día o el 10% de
 * primera visita, en su propio renglón, nunca las dos (no se acumulan).
 */
function VisitBreakdown({
  dict,
  lang,
  lines,
  discount,
  promo = null,
  total,
  durationMin,
  note,
  children,
}: {
  dict: Dict;
  lang: Locale;
  lines: { name: string; price: number }[];
  discount: number;
  promo?: { label: string; discount: number } | null;
  total: number;
  durationMin: number;
  note: string;
  /** Lo que va entre el total y la nota: el aviso de primera visita. */
  children?: React.ReactNode;
}) {
  return (
    <div className="mt-4 rounded-2xl border border-gold/25 bg-paper px-4 py-3.5 font-sans text-[13.5px]">
      {lines.map((line, i) => (
        <p key={line.name} className="flex items-baseline justify-between gap-3 py-0.5 text-ink-soft">
          <span className="min-w-0 truncate">
            {i > 0 && <span className="text-gold-dark">+ </span>}
            {line.name}
          </span>
          <span className="tabular-nums">{formatCOP(line.price, lang)}</span>
        </p>
      ))}
      <AnimatePresence initial={false}>
        {discount > 0 && (
          <m.p
            key="discount"
            initial={{ opacity: 0, scale: 0.92, height: 0 }}
            animate={{ opacity: 1, scale: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 26 }}
            className="flex items-baseline justify-between gap-3 py-0.5 font-semibold text-gold-deep"
          >
            <span className="flex items-center gap-1.5">
              <span aria-hidden>✦</span>
              {dict.combo.discount}
            </span>
            <span className="tabular-nums">− {formatCOP(discount, lang)}</span>
          </m.p>
        )}
        {promo && (
          <m.p
            key={`promo-${promo.label}`}
            initial={{ opacity: 0, scale: 0.92, height: 0 }}
            animate={{ opacity: 1, scale: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 26 }}
            className="flex items-baseline justify-between gap-3 py-0.5 font-semibold text-gold-deep"
          >
            <span className="flex items-center gap-1.5">
              <span aria-hidden>✦</span>
              {promo.label}
            </span>
            <span className="tabular-nums">− {formatCOP(promo.discount, lang)}</span>
          </m.p>
        )}
      </AnimatePresence>
      <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-ink/10 pt-2.5">
        <span className="text-ink">
          {dict.combo.total}
          <span className="ml-1.5 text-[12px] text-ink-mute">· {formatDuration(durationMin, lang)}</span>
        </span>
        <AnimatedCOP value={total} lang={lang} className="font-display text-[24px] leading-none text-ink" />
      </div>
      {children}
      <p className="mt-1.5 text-[12px] leading-snug text-ink-mute">{note}</p>
    </div>
  );
}

/** Google rating in words, honouring the minimum count rule. Null when there's no rating. */
function ratingText(dict: Dict, rating: { value: number; count: number } | null, lang: Locale) {
  if (!rating) return null;
  const value = rating.value.toLocaleString(lang === "es" ? "es-CO" : "en-US", { maximumFractionDigits: 1 });
  return rating.count < MIN_REVIEWS_TO_COUNT
    ? fill(dict.trust.ratingOnly, { rating: value })
    : fill(dict.trust.reviews, { rating: value, count: String(rating.count) });
}

/** Phone only: the studio as a photo header; the booking card slides up over it. */
function StudioBanner({
  dict,
  rating,
  lang,
}: {
  dict: Dict;
  rating: { value: number; count: number } | null;
  lang: Locale;
}) {
  const r = ratingText(dict, rating, lang);
  return (
    <div className="relative h-[188px] overflow-hidden md:h-[230px] md:rounded-t-[28px] lg:hidden">
      <Image
        src={STUDIO_PHOTO}
        alt={dict.studio.photoAlt}
        fill
        priority
        sizes="100vw"
        className="object-cover object-center"
      />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-carbon/90 via-carbon/40 to-carbon/5" />
      <div className="absolute inset-x-5 bottom-12 text-cream">
        <p className="font-sans text-[10px] font-semibold uppercase tracking-[0.32em] text-gold-soft">
          {dict.eyebrow}
        </p>
        <p className="mt-1.5 font-display text-[32px] leading-none">{dict.studio.name}</p>
        <p className="mt-2 flex flex-wrap items-center gap-x-2 font-sans text-[12px] text-cream/85">
          {r && (
            <>
              <span className="text-gold-soft">{r}</span>
              <span aria-hidden className="text-cream/40">·</span>
            </>
          )}
          {dict.studio.area}
        </p>
      </div>
    </div>
  );
}

/** Desktop: who you're booking with — photo, rating, where, when, and the promises. */
function StudioCard({
  dict,
  rating,
  lang,
  mapsUrl,
}: {
  dict: Dict;
  rating: { value: number; count: number } | null;
  lang: Locale;
  mapsUrl: string;
}) {
  const r = ratingText(dict, rating, lang);
  return (
    <div className="overflow-hidden rounded-[28px] border border-ink/8 bg-paper">
      <div className="relative aspect-[16/10]">
        <Image src={STUDIO_PHOTO} alt={dict.studio.photoAlt} fill priority sizes="360px" className="object-cover" />
        <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-carbon/85 via-carbon/20 to-transparent" />
        <div className="absolute inset-x-6 bottom-5 text-cream">
          <p className="font-display text-[28px] leading-none">{dict.studio.name}</p>
          {r && <p className="mt-1.5 font-sans text-[12px] text-gold-soft">{r}</p>}
        </div>
      </div>
      <div className="grid gap-3.5 px-6 py-5 font-sans text-[13px] text-ink-soft">
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-start gap-3 no-underline"
        >
          <span className="mt-0.5 text-gold-dark"><PinIcon /></span>
          <span className="flex-1">
            {dict.studio.address}
            <span className="mt-0.5 block text-[12px] text-gold-dark group-hover:underline">
              {dict.studio.directions} →
            </span>
          </span>
        </a>
        <p className="flex items-start gap-3">
          <span className="mt-0.5 text-gold-dark"><ClockIcon /></span>
          {dict.studio.hours}
        </p>
        <ul className="mt-1 grid gap-2 border-t border-ink/8 pt-4">
          {[dict.trust.instant, dict.trust.pay, dict.trust.change].map((t) => (
            <li key={t} className="flex items-center gap-2.5">
              <span aria-hidden className="flex h-4 w-4 items-center justify-center rounded-full bg-gold/15 text-[10px] text-gold-dark">✓</span>
              {t}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Three reasons to keep going, right where the doubt starts: under the
 * progress bar on the first step. The rating is Google's, live — no number on
 * this page is written by hand.
 */
function TrustLine({
  dict,
  rating,
  lang,
}: {
  dict: Dict;
  rating: { value: number; count: number } | null;
  lang: Locale;
}) {
  // Below a handful of reviews the count argues against us; `ratingText`
  // shows the rating alone until there are enough.
  const items = [ratingText(dict, rating, lang), dict.trust.instant, dict.trust.pay].filter(
    (x): x is string => x !== null,
  );
  return (
    <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 font-sans text-[12px] text-ink-soft">
      {items.map((t, i) => (
        <li key={t} className="flex items-center gap-1.5">
          <span aria-hidden className="text-gold">{i === 0 && rating ? "★" : "✓"}</span>
          {t}
        </li>
      ))}
    </ul>
  );
}

function Progress({
  dict,
  step,
  reachable,
  onGo,
}: {
  dict: Dict;
  step: Step;
  reachable: (s: Step) => boolean;
  onGo: (s: Step) => void;
}) {
  const current = STEPS.indexOf(step);
  return (
    <nav aria-label="Progreso" className="mt-6">
      <ol className="grid grid-cols-3 gap-2">
        {STEPS.map((s, i) => {
          const done = i < current;
          const active = i === current;
          const content = (
            <>
              <span className="block h-[3px] overflow-hidden rounded-full bg-ink/10">
                <span
                  className="block h-full rounded-full bg-gold transition-[width] duration-500 ease-out"
                  style={{ width: done || active ? "100%" : "0%" }}
                />
              </span>
              <span
                className={`mt-2 block truncate font-sans text-[11px] font-semibold uppercase tracking-[0.18em] ${
                  active ? "text-ink" : done ? "text-gold-dark" : "text-ink/35"
                }`}
              >
                <span className="mr-1.5 tabular-nums">{i + 1}</span>
                {dict.steps[s]}
              </span>
            </>
          );
          return (
            <li key={s} aria-current={active ? "step" : undefined}>
              {reachable(s) ? (
                <button type="button" onClick={() => onGo(s)} className="block w-full text-left">
                  {content}
                </button>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepHeading({
  id,
  n,
  title,
  onBack,
  backLabel,
}: {
  id: string;
  n: number;
  title: string;
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <h2 id={id} className="font-display text-[30px] leading-[1.05] text-ink md:text-[38px]">
        <span className="sr-only">{n}. </span>
        {title}
      </h2>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-1 shrink-0 font-sans text-[12px] uppercase tracking-[0.18em] text-ink-mute transition-colors hover:text-ink"
        >
          ← {backLabel}
        </button>
      )}
    </div>
  );
}

function Summary({
  dict,
  lang,
  service,
  serviceName,
  partsSum,
  promo,
  total,
  provider,
  date,
  slot,
  onEdit,
}: {
  dict: Dict;
  lang: Locale;
  service: Service | null;
  serviceName: string | null;
  partsSum: { price: number; saving: number } | null;
  /** La promo que aplica, ya con su nombre en el idioma de la página. */
  promo: { label: string; discount: number } | null;
  /** Lo que va a pagar, con la promo descontada. */
  total: number;
  provider: string | null;
  date: string | null;
  slot: Slot | null;
  onEdit: (s: Step) => void;
}) {
  return (
    <div className="overflow-hidden rounded-3xl border border-ink/10 bg-paper">
      <div className="bg-carbon px-5 py-4">
        <p className="font-sans text-[10px] font-semibold uppercase tracking-[0.3em] text-gold-soft">
          {dict.summary.title}
        </p>
        <p className="mt-1 font-display text-[24px] leading-tight text-cream">
          {serviceName ?? <span className="text-cream/50">—</span>}
        </p>
      </div>
      {!service ? (
        <p className="px-5 py-5 font-sans text-sm text-ink-mute">{dict.summary.empty}</p>
      ) : (
        <dl className="divide-y divide-ink/8 px-5 font-sans text-[13.5px]">
          <Row icon={<ClockIcon />} onEdit={() => onEdit("service")} editLabel={dict.change}>
            {formatDuration(service.durationMin, lang)}
          </Row>
          {date && (
            <Row icon={<CalendarIcon />} onEdit={() => onEdit("slot")} editLabel={dict.change}>
              <span>{longDate(date, lang)}</span>
              {slot && (
                <span className="block text-ink-mute">
                  {formatTime(slot.time, lang)} – {formatTime(addMinutes(slot.time, service.durationMin), lang)}
                </span>
              )}
            </Row>
          )}
          {date && (
            <Row icon={<PersonIcon />}>
              {dict.summary.with} {provider ?? dict.summary.anyone.toLowerCase()}
            </Row>
          )}
          <AnimatePresence initial={false}>
            {promo && (
              <m.div
                key={promo.label}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-baseline justify-between gap-3 overflow-hidden py-3 font-semibold text-gold-deep"
              >
                <dt className="flex items-center gap-1.5">
                  <span aria-hidden>✦</span>
                  {promo.label}
                </dt>
                <dd className="tabular-nums">− {formatCOP(promo.discount, lang)}</dd>
              </m.div>
            )}
          </AnimatePresence>
          <div className="flex items-baseline justify-between py-4">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-mute">
              {dict.summary.total}
            </dt>
            <dd className="text-right">
              {/* Lo tachado es lo de antes de cualquier descuento: la suma de
                  las mitades de un combo, o el precio de lista si hay promo. */}
              {(partsSum || promo) && (
                <span className="mr-2 text-ink-mute line-through">
                  {formatCOP(partsSum ? partsSum.price : service.priceCOP, lang)}
                </span>
              )}
              <AnimatedCOP value={total} lang={lang} className="font-display text-[24px] text-ink" />
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function Row({
  icon,
  children,
  onEdit,
  editLabel,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onEdit?: () => void;
  editLabel?: string;
}) {
  return (
    <div className="flex items-start gap-3 py-3.5">
      <span className="mt-0.5 text-gold-dark">{icon}</span>
      <dd className="min-w-0 flex-1 text-ink">{children}</dd>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="shrink-0 text-[12px] text-gold-dark underline decoration-gold/40 underline-offset-4 hover:decoration-gold"
        >
          {editLabel}
        </button>
      )}
    </div>
  );
}

function Success({
  dict,
  lang,
  booked,
  whatsappNumber,
  mapsUrl,
  onAgain,
}: {
  dict: Dict;
  lang: Locale;
  booked: {
    name: string;
    service: string;
    date: string;
    time: string;
    durationMin: number;
    provider: string;
    appointmentId: string;
    whatsappSent: boolean;
    phoneTail: string;
    promo: string | null;
  };
  whatsappNumber: string | null;
  mapsUrl: string;
  onAgain: () => void;
}) {
  const t = dict.success;
  // Mid-sentence the weekday stays lowercase ("el viernes, 16 de octubre");
  // standing alone it's capitalised.
  const when = {
    date: display(booked.date, lang, { weekday: "long", day: "numeric", month: "long" }),
    time: formatTime(booked.time, lang),
  };
  const values = { ...when, name: booked.name, service: booked.service, provider: booked.provider };
  const event = {
    title: fill(t.calendarTitle, values),
    date: booked.date,
    time: booked.time,
    durationMin: booked.durationMin,
    location: ADDRESS,
    details: fill(t.calendarDetails, values),
  };

  const downloadIcs = () => {
    const blob = new Blob([icsFile(event, `ea-${booked.appointmentId}`)], {
      type: "text/calendar;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "golden-beauty-studio.ics";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    trackEvent("booking_add_calendar", { kind: "ics" });
  };

  return (
    <div className="mx-auto max-w-[560px] pt-2 lg:pt-4">
      <div className="flex flex-col items-center text-center">
        <m.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 16 }}
        >
          <SuccessMark />
        </m.div>
        <m.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.55, duration: 0.4 }}
          className="relative mt-6 font-sans text-[11px] font-semibold uppercase tracking-[0.32em] text-gold-dark"
        >
          {t.eyebrow}
        </m.p>
        <m.h2
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7, type: "spring", stiffness: 200, damping: 20 }}
          className="relative mt-2 font-display text-[44px] leading-none text-ink md:text-[56px]"
        >
          {fill(t.title, values)}
        </m.h2>
        <m.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.9, duration: 0.4 }}
          className="relative mt-4 font-sans text-[15px] text-ink-soft"
        >
          {fill(t.body, values)}
        </m.p>
      </div>

      <div className="gbs-step mt-8 overflow-hidden rounded-3xl border border-ink/10 bg-paper [animation-delay:1000ms]">
        <div className="bg-carbon px-6 py-5">
          <p className="font-display text-[26px] leading-tight text-cream">{booked.service}</p>
          <p className="mt-1 font-sans text-[13px] text-gold-soft">{fill(t.with, values)}</p>
        </div>
        <div className="grid grid-cols-2 divide-x divide-ink/10 font-sans">
          <div className="px-6 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-ink-mute">{dict.steps.slot}</p>
            <p className="mt-1 text-[15px] text-ink">{longDate(booked.date, lang)}</p>
          </div>
          <div className="px-6 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-ink-mute">&nbsp;</p>
            <p className="mt-1 text-[15px] text-ink">
              {when.time} – {formatTime(addMinutes(booked.time, booked.durationMin), lang)}
            </p>
          </div>
        </div>
        {/* La promo que vio al reservar, con nombre y sin precio: el número
            exacto lo confirma la caja, y así esta pantalla —que se le muestra
            a alguien o se le saca captura— no promete una cifra. */}
        {booked.promo && (
          <p className="flex items-center gap-2 border-t border-ink/10 px-6 py-3.5 font-sans text-[13px] font-semibold text-gold-deep">
            <span aria-hidden>✦</span>
            {fill(dict.promo.applied, { label: booked.promo })}
            <span className="font-normal text-ink-mute">· {dict.promo.payAtStudio}</span>
          </p>
        )}
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between gap-3 border-t border-ink/10 px-6 py-4 font-sans text-[13px] text-ink-soft transition-colors hover:bg-ivory"
        >
          <span className="flex items-center gap-3">
            <span className="text-gold-dark"><PinIcon /></span>
            {t.address}
          </span>
          <span className="shrink-0 text-gold-dark">{t.directions} →</span>
        </a>
      </div>

      {/* Saving it is the one thing left for her to do, so it's the main
          action here. Google is the calendar most phones in Colombia use; the
          .ics covers iPhone and Outlook. */}
      <div className="gbs-step mt-6 grid gap-2 [animation-delay:1120ms] sm:grid-cols-2">
        <a
          href={googleCalendarUrl(event)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackEvent("booking_add_calendar", { kind: "google" })}
          className="flex items-center justify-center gap-2.5 rounded-full bg-carbon px-5 py-4 text-center font-sans text-[13px] font-semibold text-gold-soft"
        >
          <CalendarIcon /> {t.google}
        </a>
        <button
          type="button"
          onClick={downloadIcs}
          className="flex items-center justify-center gap-2.5 rounded-full border border-ink/15 bg-paper px-5 py-4 text-center font-sans text-[13px] text-ink transition-colors hover:border-gold"
        >
          <CalendarIcon /> {t.ics}
        </button>
      </div>

      {/* WhatsApp: the confirmation goes out by itself when the studio's
          WhatsApp API is set up — and then we say so. Otherwise, the only
          WhatsApp here is the way to change the appointment. Asking her to
          send us her own summary was work for the client. */}
      <div className="gbs-step mt-6 rounded-2xl bg-ivory px-5 py-4 text-center font-sans text-[13px] leading-relaxed text-ink-soft [animation-delay:1220ms]">
        {booked.whatsappSent ? (
          <p className="flex items-center justify-center gap-2">
            <span className="text-whatsapp"><WaIcon /></span>
            {fill(t.whatsappSent, { tail: booked.phoneTail })}
          </p>
        ) : null}
        {whatsappNumber ? (
          <p className={booked.whatsappSent ? "mt-1.5" : ""}>
            {t.changeHint}{" "}
            <a
              href={whatsappLink(whatsappNumber, fill(t.changeText, values))}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackEvent("booking_change_whatsapp")}
              className="font-semibold text-gold-dark underline decoration-gold/40 underline-offset-4"
            >
              {t.changeCta}
            </a>
          </p>
        ) : null}
      </div>

      <div className="mt-10 text-center">
        <button
          type="button"
          onClick={onAgain}
          className="font-sans text-[13px] text-ink-mute underline decoration-ink/20 underline-offset-4 hover:text-ink"
        >
          {t.again}
        </button>
      </div>
    </div>
  );
}

function ProviderChip({
  selected,
  onClick,
  name,
  hint,
}: {
  selected: boolean;
  onClick: () => void;
  name: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex shrink-0 items-center gap-2.5 rounded-full border py-1.5 pl-1.5 pr-4 font-sans text-[13px] transition-colors ${
        selected ? "border-gold bg-gold/10 text-ink" : "border-ink/12 bg-paper text-ink-soft hover:border-gold/50"
      }`}
    >
      <span
        aria-hidden
        className={`flex h-8 w-8 items-center justify-center rounded-full font-display text-[16px] ${
          selected ? "bg-gold text-white" : "bg-ivory-deep text-gold-dark"
        }`}
      >
        {hint ? "✦" : name.charAt(0).toUpperCase()}
      </span>
      <span className="text-left leading-tight">
        <span className="block">{name}</span>
        {hint && <span className="block text-[11px] text-ink-mute">{hint}</span>}
      </span>
    </button>
  );
}

function PillChoice({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <m.button
      whileTap={{ scale: 0.98 }}
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left font-sans text-[14px] text-ink transition-colors ${
        selected ? "border-gold bg-paper" : "border-ink/12 bg-paper/50 hover:border-gold/50"
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">{children}</span>
      <Check on={selected} small />
    </m.button>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  ...rest
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block font-sans text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-mute">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        maxLength={120}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-ink/15 bg-paper px-4 py-3.5 font-sans text-[16px] text-ink outline-none transition-colors focus:border-gold"
        {...rest}
      />
    </div>
  );
}

function LoadError({ dict, onRetry }: { dict: Dict; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-ink/15 px-5 py-10 text-center">
      <p className="mx-auto max-w-[420px] font-sans text-sm text-ink-soft">{dict.errors.unavailable}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-full border border-ink/20 px-5 py-2.5 font-sans text-[13px] text-ink hover:border-gold"
      >
        {dict.errors.retry}
      </button>
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-hidden>
      <div className="mb-5 flex gap-2">
        {[88, 76, 84, 80].map((w, i) => (
          <div key={i} className="h-9 animate-pulse rounded-full bg-ivory-deep/70" style={{ width: w }} />
        ))}
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-[112px] animate-pulse rounded-2xl bg-ivory-deep/60" />
        ))}
      </div>
    </div>
  );
}

function SlotSkeleton({ label }: { label: string }) {
  return (
    <div>
      <p className="sr-only">{label}</p>
      <div aria-hidden className="mb-2.5 h-3 w-20 animate-pulse rounded bg-ivory-deep/70" />
      <div aria-hidden className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="h-[46px] animate-pulse rounded-xl bg-ivory-deep/60" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
    </div>
  );
}

/* ── Icons (inline, stroke = currentColor) ──────────────────────────────── */

function Check({ on, small = false }: { on: boolean; small?: boolean }) {
  const size = small ? 18 : 22;
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full border transition-all duration-200 ${
        on ? "scale-100 border-gold bg-gold text-white" : "scale-90 border-ink/15 text-transparent"
      }`}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 16 16" width={size - 8} height={size - 8} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8.5l3.2 3L13 4.5" />
      </svg>
    </span>
  );
}

/**
 * Gold confetti from behind the check mark — the moment the booking is real.
 *
 * Pieces come from a fixed-seed sequence, not `Math.random()`: the same burst
 * on every phone, and nothing impure in render. Fifty-odd pieces fly out on a
 * curve and fall with a little gravity and spin, then they're gone; nothing
 * stays on screen to compete with the details. Skipped entirely for reduced
 * motion.
 */
function GoldBurst() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- decided once, after mount
    if (!reduce) setOn(true);
  }, []);
  if (!on) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 z-0 h-0 w-0">
      {BURST.map((p, i) => (
        <m.span
          key={i}
          className="absolute block"
          style={{
            width: p.w,
            height: p.h,
            marginLeft: -p.w / 2,
            marginTop: -p.h / 2,
            background: p.color,
            borderRadius: p.round ? "9999px" : "2px",
          }}
          initial={{ x: 0, y: 0, opacity: 0, scale: 0.4, rotate: 0 }}
          animate={{
            x: [0, p.dx * 0.75, p.dx],
            y: [0, p.dy * 0.75, p.dy + p.fall],
            opacity: [0, 1, 1, 0],
            scale: [0.4, 1, 1, 0.8],
            rotate: p.spin,
          }}
          transition={{ duration: p.duration, delay: 0.35 + p.delay, ease: [0.2, 0.7, 0.3, 1], times: [0, 0.35, 1] }}
        />
      ))}
    </span>
  );
}

/** The burst's pieces, from a tiny seeded PRNG — deterministic and pure. */
const BURST = (() => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const colors = ["#e7aa51", "#ac8231", "#ffd49f", "#8b6a1f", "#fff1d6", "#5b2b08"];
  return Array.from({ length: 56 }, (_, i) => {
    const angle = (i / 56) * Math.PI * 2 + rand() * 0.5;
    const dist = 90 + rand() * 150;
    const round = rand() > 0.6;
    return {
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist * 0.8 - 40,
      fall: 60 + rand() * 90,
      spin: (rand() - 0.5) * 720,
      w: round ? 7 : 5 + rand() * 4,
      h: round ? 7 : 9 + rand() * 6,
      round,
      color: colors[Math.floor(rand() * colors.length)],
      delay: rand() * 0.12,
      duration: 1.3 + rand() * 0.7,
    };
  });
})();

function SuccessMark() {
  return (
    <span className="relative flex h-24 w-24 items-center justify-center">
      {/* A warm glow that blooms once behind the mark. */}
      <m.span
        aria-hidden
        className="absolute -inset-8 rounded-full"
        style={{ background: "radial-gradient(circle, rgba(231,170,81,0.35) 0%, rgba(231,170,81,0) 65%)" }}
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{ opacity: [0, 1, 0.55], scale: [0.5, 1.15, 1] }}
        transition={{ duration: 1.2, ease: "easeOut" }}
      />
      <GoldBurst />
      <span aria-hidden className="absolute inset-0 rounded-full bg-gold/15 motion-safe:animate-[ping_1.6s_ease-out_1]" />
      <svg viewBox="0 0 96 96" width="96" height="96" aria-hidden>
        <defs>
          <linearGradient id="gbs-ok" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8b6a1f" />
            <stop offset="0.6" stopColor="#e7aa51" />
            <stop offset="1" stopColor="#ac8231" />
          </linearGradient>
        </defs>
        <circle cx="48" cy="48" r="44" fill="none" stroke="url(#gbs-ok)" strokeWidth="2.5" className="gbs-draw" style={{ strokeDasharray: 277, strokeDashoffset: 277 }} />
        <path d="M30 49l12 12 24-26" fill="none" stroke="url(#gbs-ok)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="gbs-draw [animation-delay:450ms]" style={{ strokeDasharray: 60, strokeDashoffset: 60 }} />
      </svg>
    </span>
  );
}

function Spinner() {
  return <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-gold-soft/30 border-t-gold-soft" />;
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function ClockIcon() {
  return (
    <svg {...iconProps} width={14} height={14}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}
function PersonIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5" />
    </svg>
  );
}
function PinIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0113 0c0 5.4-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </svg>
  );
}
function PartIcon({ part }: { part: "morning" | "afternoon" | "evening" }) {
  if (part === "evening") {
    return (
      <svg {...iconProps} width={14} height={14}>
        <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />
      </svg>
    );
  }
  return (
    <svg {...iconProps} width={14} height={14}>
      <circle cx="12" cy={part === "morning" ? 14 : 12} r="4" />
      {part === "morning" ? (
        <path d="M3 19h18M12 4v3M5.6 8.6l1.8 1.8M18.4 8.6l-1.8 1.8" />
      ) : (
        <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
      )}
    </svg>
  );
}
function WaIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.5 14.4c-.3-.1-1.7-.8-2-.9-.3-.1-.5-.1-.7.1-.2.3-.8.9-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.1 4.9 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.6-.1 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3zM12 21.8c-1.8 0-3.5-.5-5-1.4l-.4-.2-3.7 1 1-3.6-.2-.4c-1-1.6-1.5-3.4-1.5-5.2 0-5.4 4.4-9.8 9.8-9.8 2.6 0 5.1 1 6.9 2.9 1.8 1.8 2.9 4.3 2.9 6.9 0 5.4-4.4 9.8-9.8 9.8zm8.3-18.1C18.1 1.5 15.1.3 12 .3 5.5.3.3 5.5.3 12c0 2.1.5 4.1 1.6 5.9L.2 23.7l6-1.6c1.7.9 3.7 1.4 5.7 1.4 6.5 0 11.7-5.2 11.7-11.7 0-3.1-1.2-6.1-3.4-8.3z" />
    </svg>
  );
}

/* ── Dates (display only; the wall-clock date is the source of truth) ───── */

const fmt = (lang: Locale) => (lang === "es" ? "es-CO" : "en-US");

/** Formatting a `YYYY-MM-DD` in UTC, so the visitor's zone can't shift the day. */
function display(iso: string, lang: Locale, opts: Intl.DateTimeFormatOptions): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(fmt(lang), { ...opts, timeZone: "UTC" });
}

function weekdayShort(iso: string, lang: Locale): string {
  return display(iso, lang, { weekday: "short" }).replace(".", "");
}
function monthShort(iso: string, lang: Locale): string {
  return display(iso, lang, { month: "short" }).replace(".", "");
}
/** First letter up, the rest as the locale wrote it: "Viernes, 16 de octubre", not "De Octubre". */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function monthYear(iso: string, lang: Locale): string {
  return cap(display(iso, lang, { month: "long", year: "numeric" }));
}
function longDate(iso: string, lang: Locale): string {
  return cap(display(iso, lang, { weekday: "long", day: "numeric", month: "long" }));
}
/** "Miércoles" / "Wednesday" de un número de día (0 = domingo). El 2026-10-11 fue domingo. */
function weekdayName(weekday: number, lang: Locale): string {
  return cap(display(`2026-10-${String(11 + weekday).padStart(2, "0")}`, lang, { weekday: "long" }));
}
