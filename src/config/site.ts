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
  mapsEmbedUrl,
  mapsPlaceId,
  sections: {
    lookbook: bool(process.env.NEXT_PUBLIC_SECTION_LOOKBOOK, true),
    servicios: bool(process.env.NEXT_PUBLIC_SECTION_SERVICIOS, true),
    diccionario: bool(process.env.NEXT_PUBLIC_SECTION_DICCIONARIO, true),
    tecnicas: bool(process.env.NEXT_PUBLIC_SECTION_TECNICAS, true),
    estudio: bool(process.env.NEXT_PUBLIC_SECTION_ESTUDIO, true),
    contacto: bool(process.env.NEXT_PUBLIC_SECTION_CONTACTO, true),
  },
} as const;

export type SectionKey = keyof typeof siteConfig.sections;
