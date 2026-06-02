import type { BioCopy } from "./bio.types";

// Mock /es copy for the link-in-bio page. When Strapi is connected this file
// stops being used — `getBio` (in bio.ts) will read the `link-bio` Single Type.
// Until then: editing here changes what /es/bio shows. Hrefs are NOT here; they
// come from `siteConfig` (env) so the real destinations stay in one place.

export const BIO_COPY: BioCopy = {
  handle: "@golden__beautystudio",
  tagline: "El arte de las uñas, hecho a mano.",
  location: "Sabaneta · Medellín",
  promoCta: "Ver la promoción",
  links: {
    agendar: { label: "Agendar cita", sub: "Reserva en línea" },
    whatsapp: { label: "Escríbenos por WhatsApp", sub: "Respuesta el mismo día" },
    servicios: { label: "Servicios y precios", sub: "Catálogo completo del estudio" },
    instagram: { label: "Síguenos en Instagram", sub: "El trabajo, en detalle" },
    maps: { label: "Cómo llegar", sub: "Sabaneta · Calle 69 Sur" },
  },
  socials: {
    ig: "Instagram",
    wa: "WhatsApp",
    tt: "TikTok",
  },
};
