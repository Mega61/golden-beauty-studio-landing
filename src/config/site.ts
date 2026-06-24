function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v.trim() === "") return fallback;
  const normalized = v.trim().toLowerCase();
  if (normalized === "false" || normalized === "0" || normalized === "off") {
    return false;
  }
  return normalized === "true" || normalized === "1" || normalized === "on";
}

const DEFAULT_SITE_URL = "https://goldenbeautystudio.com.co";
const rawSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || DEFAULT_SITE_URL;
const siteUrl = rawSiteUrl.replace(/\/+$/, "");

const bookingUrl = process.env.NEXT_PUBLIC_BOOKING_URL?.trim() || null;

const wppNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER?.trim() || null;
const wppGreeting =
  process.env.NEXT_PUBLIC_WHATSAPP_GREETING?.trim() || "Hola Golden";
const whatsappUrl = wppNumber
  ? `https://wa.me/${wppNumber}?text=${encodeURIComponent(wppGreeting)}`
  : null;

const instagramUrl = process.env.NEXT_PUBLIC_INSTAGRAM_URL?.trim() || null;
const tiktokUrl = process.env.NEXT_PUBLIC_TIKTOK_URL?.trim() || null;

const gaId = process.env.NEXT_PUBLIC_GA_ID?.trim() || null;

const googleSiteVerification =
  process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION?.trim() || null;

// Schema.org expects an E.164 telephone (e.g. "+573001234567"). The WhatsApp
// env holds bare digits; emit null when unset so we never assert a fake number.
const telephone = wppNumber ? `+${wppNumber.replace(/\D/g, "")}` : null;

// Public social profiles for `sameAs`. Filtered to whatever is actually set.
const sameAs = [instagramUrl, tiktokUrl].filter(
  (u): u is string => Boolean(u),
);

const mapsKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() || null;
const mapsQuery = process.env.NEXT_PUBLIC_GOOGLE_MAPS_QUERY?.trim() || null;
const mapsPlaceId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_PLACE_ID?.trim() || null;
const embedQ = mapsPlaceId ? `place_id:${mapsPlaceId}` : mapsQuery;
const mapsEmbedUrl =
  mapsKey && embedQ
    ? `https://www.google.com/maps/embed/v1/place?key=${mapsKey}&q=${encodeURIComponent(embedQ)}`
    : null;

export const siteConfig = {
  siteUrl,
  bookingUrl,
  whatsappUrl,
  instagramUrl,
  tiktokUrl,
  gaId,
  googleSiteVerification,
  mapsEmbedUrl,
  mapsPlaceId,
  sections: {
    lookbook: bool(process.env.NEXT_PUBLIC_SECTION_LOOKBOOK, true),
    servicios: bool(process.env.NEXT_PUBLIC_SECTION_SERVICIOS, true),
    diccionario: bool(process.env.NEXT_PUBLIC_SECTION_DICCIONARIO, true),
    tecnicas: bool(process.env.NEXT_PUBLIC_SECTION_TECNICAS, true),
    estudio: bool(process.env.NEXT_PUBLIC_SECTION_ESTUDIO, true),
    reviews: bool(process.env.NEXT_PUBLIC_SECTION_REVIEWS, true),
    contacto: bool(process.env.NEXT_PUBLIC_SECTION_CONTACTO, true),
  },
} as const;

export type SectionKey = keyof typeof siteConfig.sections;

// Machine-readable business identity — the single source of truth for
// structured data (JSON-LD) and other crawler-facing fields. The displayed
// address/hours copy lives (localized) in the dictionaries; these are the
// canonical machine values. Address, hours and coordinates are confirmed real;
// `telephone`/`sameAs` derive from env and are emitted only when present.
export const business = {
  name: "Golden Beauty Studio",
  legalName: "Golden Beauty Studio",
  streetAddress: "Calle 69 Sur #43a - 41",
  addressLocality: "Sabaneta",
  addressRegion: "Antioquia",
  addressCountry: "CO",
  latitude: 6.156,
  longitude: -75.617,
  priceRange: "$$",
  telephone,
  sameAs,
  // Schema.org dayOfWeek values. Mon–Sat 09:00–19:00, Sun 10:00–15:00.
  openingHours: [
    {
      days: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ],
      opens: "09:00",
      closes: "19:00",
    },
    { days: ["Sunday"], opens: "10:00", closes: "15:00" },
  ],
} as const;

// Open Graph locale codes per UI language.
export const ogLocales: Record<string, string> = {
  es: "es_CO",
  en: "en_US",
};
