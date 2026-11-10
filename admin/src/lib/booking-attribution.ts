/**
 * De dónde llegó una reserva hecha desde la página.
 *
 * La landing guarda, cuando alguien entra, los `utm_*` del link y el dominio que
 * la refirió (`src/lib/attribution.ts` de la landing), y los manda con la
 * reserva. Acá se hacen dos cosas, las dos puras:
 *
 * - **`parseAttribution`**: lo que llegó del navegador → campos acotados, o
 *   `null`. Lo escribe cualquiera con curl, así que nada se confía: texto corto,
 *   minúsculas, y el click id solo si es uno de los conocidos.
 * - **`channelOf`**: los campos crudos → un canal que la dueña reconoce
 *   ("Google Maps", "Instagram"). Se decide **al leer**, no al guardar: la
 *   tabla guarda lo crudo y esta regla puede mejorar sin reescribir filas.
 *
 * ## El orden de la regla
 *
 * 1. Pauta primero. `utm_medium` de pago (`paid`, `cpc`, …) o un `gclid` —que
 *    Google solo agrega a clics de anuncios— gana sobre todo lo demás.
 * 2. Después el `utm_source` que se puso a mano en el link: es la señal más
 *    honesta que hay, porque la escribió quien publicó el link.
 * 3. Sin UTM, el dominio referente. Instagram y Facebook mandan
 *    `l.instagram.com` / `l.facebook.com`; Google Maps casi siempre manda
 *    `google.com` a secas, así que sin UTM una visita de Maps se ve como
 *    "Google (búsqueda)". Por eso el link de Maps lleva UTM.
 * 4. Un `fbclid` sin nada más es Instagram o Facebook, sin saber cuál: Meta lo
 *    pega a **todos** los links salientes, pagados o no, así que tampoco dice
 *    que sea pauta.
 * 5. Nada de lo anterior: directo (escribió la dirección, un favorito, o una
 *    app que no manda referente, como WhatsApp).
 */

export type BookingAttribution = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  referrerHost: string | null;
  landingPath: string | null;
  /** Cuál click id traía el link (`fbclid`, `gclid`, …). Nunca el valor. */
  clickId: string | null;
};

export type BookingChannel =
  | "pauta-meta"
  | "pauta-google"
  | "google-maps"
  | "google"
  | "instagram"
  | "facebook"
  | "meta"
  | "whatsapp"
  | "tiktok"
  | "otro"
  | "directo";

export const BOOKING_CHANNEL_LABEL: Record<BookingChannel, string> = {
  "pauta-meta": "Anuncios de Meta",
  "pauta-google": "Anuncios de Google",
  "google-maps": "Google Maps",
  google: "Google (búsqueda)",
  instagram: "Instagram",
  facebook: "Facebook",
  meta: "Instagram o Facebook",
  whatsapp: "WhatsApp",
  tiktok: "TikTok",
  otro: "Otro sitio",
  directo: "Directo (sin origen)",
};

/** El orden de la tabla: de lo pagado a lo que no se sabe. */
export const BOOKING_CHANNELS: readonly BookingChannel[] = [
  "pauta-meta",
  "pauta-google",
  "instagram",
  "facebook",
  "meta",
  "google-maps",
  "google",
  "whatsapp",
  "tiktok",
  "otro",
  "directo",
];

const CLICK_IDS = new Set(["fbclid", "gclid", "gbraid", "wbraid", "ttclid", "msclkid"]);
const PAID_MEDIUMS = new Set(["paid", "cpc", "ppc", "ads", "ad", "paid_social", "paidsocial", "paid-social"]);

const MAX_FIELD = 100;
const MAX_HOST = 255;
const MAX_PATH = 255;

function field(value: unknown, max: number, lower: boolean): string | null {
  if (typeof value !== "string") return null;
  // Sin caracteres de control: esto se dibuja en una tabla.
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (clean === "") return null;
  const cut = clean.slice(0, max);
  return lower ? cut.toLowerCase() : cut;
}

/** Lo que llegó del navegador → campos acotados, o `null` si no trae nada. */
export function parseAttribution(raw: unknown): BookingAttribution | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const host = field(r.referrerHost, MAX_HOST, true);
  const clickId = field(r.clickId, 20, true);
  const path = field(r.landingPath, MAX_PATH, false);

  const out: BookingAttribution = {
    source: field(r.source, MAX_FIELD, true),
    medium: field(r.medium, MAX_FIELD, true),
    campaign: field(r.campaign, MAX_FIELD, true),
    content: field(r.content, MAX_FIELD, true),
    // Un host, no una URL: lo demás del referente puede traer datos de quien navega.
    referrerHost: host !== null && /^[a-z0-9.-]+$/.test(host) ? host : null,
    landingPath: path !== null && path.startsWith("/") ? path : null,
    clickId: clickId !== null && CLICK_IDS.has(clickId) ? clickId : null,
  };

  const empty = Object.values(out).every((value) => value === null);
  return empty ? null : out;
}

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** `google.com`, `google.com.co`, `www.google.es`, … */
function isGoogleHost(host: string): boolean {
  return /(^|\.)google\.[a-z.]+$/.test(host);
}

function fromSource(source: string, medium: string | null): BookingChannel {
  const s = source.replace(/[\s_-]+/g, "");
  if (s === "ig" || s.includes("instagram")) return "instagram";
  if (s === "fb" || s.includes("facebook")) return "facebook";
  if (s === "meta") return "meta";
  if (s.includes("googlemaps") || s === "gbp" || s === "gmb" || s.includes("maps")) return "google-maps";
  if (s.includes("google")) {
    return medium !== null && /maps|gbp|gmb|perfil|profile|business/.test(medium)
      ? "google-maps"
      : "google";
  }
  if (s === "wa" || s.includes("whatsapp")) return "whatsapp";
  if (s.includes("tiktok")) return "tiktok";
  return "otro";
}

export function channelOf(attribution: BookingAttribution | null): BookingChannel {
  if (attribution === null) return "directo";
  const { source, medium, referrerHost: host, clickId } = attribution;

  // 1. Pauta.
  const paid = medium !== null && PAID_MEDIUMS.has(medium);
  if (clickId === "gclid" || clickId === "gbraid" || clickId === "wbraid") return "pauta-google";
  if (paid) {
    const channel = source === null ? null : fromSource(source, medium);
    if (channel === "google" || channel === "google-maps") return "pauta-google";
    if (channel === "instagram" || channel === "facebook" || channel === "meta") return "pauta-meta";
    if (clickId === "fbclid") return "pauta-meta";
  }

  // 2. El UTM que se escribió a mano.
  if (source !== null) return fromSource(source, medium);

  // 3. El dominio referente.
  if (host !== null) {
    if (hostIs(host, "instagram.com")) return "instagram";
    if (hostIs(host, "facebook.com") || hostIs(host, "fb.com") || hostIs(host, "fb.me")) return "facebook";
    if (host.startsWith("maps.google.") || hostIs(host, "maps.app.goo.gl")) return "google-maps";
    if (isGoogleHost(host)) return "google";
    if (hostIs(host, "whatsapp.com") || hostIs(host, "wa.me")) return "whatsapp";
    if (hostIs(host, "tiktok.com")) return "tiktok";
    return "otro";
  }

  // 4. Meta sin más pistas.
  if (clickId === "fbclid") return "meta";
  if (clickId === "ttclid") return "tiktok";

  return "directo";
}
