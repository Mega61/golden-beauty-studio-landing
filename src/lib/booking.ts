/**
 * The pure half of `/reservar`: everything the booking screen decides that can
 * be wrong without looking wrong. Kept out of the component so it can be tested
 * — a day shown as closed when it's open, or a calendar file an hour off, is a
 * lost client and nobody sees an error.
 */

export type Locale = "es" | "en";

/* ── Phone ───────────────────────────────────────────────────────────────── */

/**
 * Is this a number the panel will accept?
 *
 * The panel owns normalisation (`identity.ts`, E.164 with +57 by default); this
 * only stops the obvious typo before a round trip. A Colombian mobile is ten
 * digits starting with 3, optionally with the 57 prefix. Anything that starts
 * with `+` is a foreign number and gets the benefit of the doubt — 8 to 15
 * digits, which is E.164's own range.
 */
export function isPlausiblePhone(raw: string): boolean {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    if (digits.startsWith("57")) return /^573\d{9}$/.test(digits);
    return digits.length >= 8 && digits.length <= 15;
  }
  if (digits.length === 12 && digits.startsWith("57")) return digits[2] === "3";
  return digits.length === 10 && digits.startsWith("3");
}

/** `3001234567` → `300 123 4567` while typing. Foreign numbers pass untouched. */
export function formatPhoneInput(raw: string): string {
  if (raw.trim().startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

/* ── Days ────────────────────────────────────────────────────────────────── */

export type Schedule = {
  offWeekdays: number[];
  closedDates: string[];
  openDates: string[];
};

/** The next `count` days as `YYYY-MM-DD`, from the studio's today. Midday UTC, so no DST edge. */
export function buildDays(today: string, count: number): string[] {
  const start = Date.parse(`${today}T12:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
}

/** 0 = Sunday. Computed in UTC from the date itself — never from the visitor's clock. */
export function weekdayOf(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

/**
 * Could anyone in `schedules` be working that day?
 *
 * A hint, never a promise: an open day can still have no free time, which the
 * availability call says. The one thing this must not do is close a day that
 * has hours, so a missing schedule counts as open.
 */
export function isDayOpen(iso: string, schedules: readonly (Schedule | undefined)[]): boolean {
  if (schedules.length === 0) return true;
  return schedules.some((s) => {
    if (!s) return true;
    if (s.closedDates.includes(iso)) return false;
    if (s.openDates.includes(iso)) return true;
    return !s.offWeekdays.includes(weekdayOf(iso));
  });
}

/* ── Times ───────────────────────────────────────────────────────────────── */

export type DayPart = "morning" | "afternoon" | "evening";

/** Morning before 12, afternoon until 17, evening after. How people say it. */
export function dayPartOf(time: string): DayPart {
  const h = Number(time.slice(0, 2));
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

export function groupByDayPart<T extends { time: string }>(slots: readonly T[]) {
  const parts: Record<DayPart, T[]> = { morning: [], afternoon: [], evening: [] };
  for (const s of slots) parts[dayPartOf(s.time)].push(s);
  return (Object.keys(parts) as DayPart[])
    .filter((k) => parts[k].length > 0)
    .map((k) => ({ part: k, slots: parts[k] }));
}

/**
 * `14:30` → `2:30 p. m.` / `2:30 PM`.
 *
 * Written by hand instead of `Intl`: the input is a wall-clock string in Bogotá,
 * and turning it into a `Date` to format it would shift it by the visitor's
 * offset. Colombia reads the 12-hour clock, and so does the panel's agenda.
 */
export function formatTime(time: string, lang: Locale): string {
  const [hRaw, m] = time.split(":");
  const h = Number(hRaw);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = lang === "es" ? (h < 12 ? "a. m." : "p. m.") : h < 12 ? "AM" : "PM";
  return `${h12}:${m} ${suffix}`;
}

/** `HH:MM` plus minutes, as `HH:MM`. Wraps past midnight, which no salon slot does. */
export function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function formatDuration(min: number, lang: Locale): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (rest === 0) return lang === "es" ? `${h} h` : `${h} hr`;
  return `${h} h ${rest} min`;
}

/** Same shape as the price list: `$180.000` in es, `$180,000 COP` in en. */
export function formatCOP(value: number, lang: Locale): string {
  const n = new Intl.NumberFormat(lang === "es" ? "es-CO" : "en-US").format(value);
  return lang === "es" ? `$${n}` : `$${n} COP`;
}

/* ── After booking ───────────────────────────────────────────────────────── */

export type BookedAppointment = {
  title: string;
  /** `YYYY-MM-DD`, Bogotá. */
  date: string;
  /** `HH:MM`, Bogotá. */
  time: string;
  durationMin: number;
  location: string;
  details: string;
};

/**
 * Bogotá wall time → UTC stamp `YYYYMMDDTHHMMSSZ`.
 *
 * Bogotá is UTC−5 all year (no DST since 1993), so this is a fixed shift.
 * Emitting UTC rather than a floating local time is the point: a floating time
 * lands at 10:00 in whatever zone the phone is in, and a client who saved it
 * while travelling would show up an hour off.
 */
export function bogotaToUtcStamp(date: string, time: string, plusMin = 0): string {
  const ms = Date.parse(`${date}T${time}:00-05:00`) + plusMin * 60_000;
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function googleCalendarUrl(a: BookedAppointment): string {
  const start = bogotaToUtcStamp(a.date, a.time);
  const end = bogotaToUtcStamp(a.date, a.time, a.durationMin);
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: a.title,
    dates: `${start}/${end}`,
    location: a.location,
    details: a.details,
    ctz: "America/Bogota",
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

/** RFC 5545 text escaping: backslash, semicolon, comma, newline. */
function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** A one-event `.ics` with a reminder the day before — the one we can't send yet. */
export function icsFile(a: BookedAppointment, uid: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Golden Beauty Studio//Reservas//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}@goldenbeautystudio`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${bogotaToUtcStamp(a.date, a.time)}`,
    `DTEND:${bogotaToUtcStamp(a.date, a.time, a.durationMin)}`,
    `SUMMARY:${icsText(a.title)}`,
    `LOCATION:${icsText(a.location)}`,
    `DESCRIPTION:${icsText(a.details)}`,
    "BEGIN:VALARM",
    "TRIGGER:-P1D",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(a.title)}`,
    "END:VALARM",
    "BEGIN:VALARM",
    "TRIGGER:-PT2H",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(a.title)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** `wa.me` link with text. `number` is the env value: digits, with or without 57. */
export function whatsappLink(number: string, text: string): string {
  const digits = number.replace(/\D/g, "");
  const full = digits.length === 10 ? `57${digits}` : digits;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}

/** Fill `{key}` placeholders. Unknown keys are left visible, so a typo shows in review. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}
