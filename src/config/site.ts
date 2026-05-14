function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v.trim() === "") return fallback;
  const normalized = v.trim().toLowerCase();
  if (normalized === "false" || normalized === "0" || normalized === "off") {
    return false;
  }
  return normalized === "true" || normalized === "1" || normalized === "on";
}

const bookingUrl = process.env.NEXT_PUBLIC_BOOKING_URL?.trim() || null;

const wppNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER?.trim() || null;
const wppGreeting =
  process.env.NEXT_PUBLIC_WHATSAPP_GREETING?.trim() || "Hola Golden";
const whatsappUrl = wppNumber
  ? `https://wa.me/${wppNumber}?text=${encodeURIComponent(wppGreeting)}`
  : null;

const mapsKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() || null;
const mapsQuery = process.env.NEXT_PUBLIC_GOOGLE_MAPS_QUERY?.trim() || null;
const mapsEmbedUrl =
  mapsKey && mapsQuery
    ? `https://www.google.com/maps/embed/v1/place?key=${mapsKey}&q=${encodeURIComponent(mapsQuery)}`
    : null;

export const siteConfig = {
  bookingUrl,
  whatsappUrl,
  mapsEmbedUrl,
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
