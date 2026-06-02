import type { BioCopy } from "./bio.types";

// Mock /en copy for the link-in-bio page. Keys MUST mirror bio.es.ts exactly.

export const BIO_COPY: BioCopy = {
  handle: "@golden__beautystudio",
  tagline: "The art of nails, made by hand.",
  location: "Sabaneta · Medellín",
  promoCta: "View the offer",
  links: {
    agendar: { label: "Book an appointment", sub: "Online booking" },
    whatsapp: { label: "Message us on WhatsApp", sub: "Same-day reply" },
    servicios: { label: "Services & prices", sub: "The studio's full menu" },
    instagram: { label: "Follow us on Instagram", sub: "The work, up close" },
    maps: { label: "How to find us", sub: "Sabaneta · Calle 69 Sur" },
  },
  socials: {
    ig: "Instagram",
    wa: "WhatsApp",
    tt: "TikTok",
  },
};
