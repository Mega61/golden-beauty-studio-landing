import type { PromosBySlug } from "./promos.types";
import { siteConfig } from "@/config/site";

const BOOKING = siteConfig.bookingUrl ?? "#contacto";

// Same shape as promos.es.ts. Keeping the slug keys identical so the
// language-agnostic selector can resolve either locale by the same slug.

export const PROMOS_DATA: PromosBySlug = {
  apertura: {
    slug: "apertura",
    label: "Opening · June 2026",
    active: true,
    starts_at: "2026-06-01T00:00:00.000Z",
    ends_at: "2026-07-15T23:59:59.000Z",
    strip: {
      tag: "Opening kit",
      message:
        "The first 100 clients receive the Golden welcome kit with their first appointment.",
      cta: "Claim my kit",
      href: "#promos",
      accent: "gold",
    },
    items: [
      {
        id: "opening-gift",
        eyebrow: "Opening · Edition 01",
        title: "A welcome kit for the first 100",
        body:
          "Book your first appointment and take home the kit curated by the studio — hand exfoliator, editorial nail file and cuticle oil to keep the result going between sessions. No deadline: valid while the 100 kits last.",
        cta_label: "Reserve my appointment",
        cta_href: BOOKING,
        ribbon: "100 kits · Opening edition",
        image_url: "/apertura.jpg",
        accent: "gold",
        featured: true,
      },
      {
        id: "opening-referral",
        eyebrow: "Referrals",
        title: "Bring a friend, both of you win",
        body:
          "For every referral who books her first appointment, both of you receive 20% off your next refill.",
        cta_label: "See details",
        cta_href: "#contacto",
        accent: "mocha",
        featured: false,
      },
    ],
  },

  madre: {
    slug: "madre",
    label: "Mother's Day · May 2026",
    active: true,
    starts_at: "2026-04-15T00:00:00.000Z",
    ends_at: "2026-05-15T23:59:59.000Z",
    strip: {
      tag: "Mother's Day",
      message:
        "Gift a full session with a handwritten note and presentation box.",
      cta: "Buy gift card",
      href: "#contacto",
      until: "Until May · 12",
      accent: "gold",
    },
    items: [
      {
        id: "madre-gift-card",
        eyebrow: "Edition · Mother's Day",
        title: "Gift card for a full session",
        body:
          "A new-set session of her choice, presented in a textured cardboard box with a handwritten note. Ready to hand over — no wrapping required.",
        cta_label: "Order my gift card",
        cta_href: "#contacto",
        ribbon: "Limited edition · 50 cards",
        accent: "gold",
        badge_day: "12",
        badge_month: "MAY",
        featured: true,
      },
      {
        id: "madre-duo",
        eyebrow: "Duo",
        title: "Double appointment — mother & daughter",
        body:
          "Book the same day and we'll close the session with a sweet from Boutique La Provence.",
        cta_label: "Book the duo",
        cta_href: "#contacto",
        accent: "mocha",
        featured: false,
      },
    ],
  },

  navidad: {
    slug: "navidad",
    label: "Holiday season · 2026",
    active: true,
    starts_at: "2026-11-15T00:00:00.000Z",
    ends_at: "2026-12-31T23:59:59.000Z",
    strip: {
      tag: "Holiday season",
      message:
        "Book December ahead — weekends fill up within 48 hours.",
      cta: "See availability",
      href: "#contacto",
      until: "Until Dec · 24",
      accent: "ink",
    },
    items: [
      {
        id: "navidad-editorial",
        eyebrow: "Lookbook · Vol. 02",
        title: "Holiday edition — editorial set",
        body:
          "Three designs inspired by patina gold, champagne and bronze. Extended session with a complimentary cocktail and a closing polaroid.",
        cta_label: "Reserve the edition",
        cta_href: "#contacto",
        ribbon: "Limited spots",
        accent: "gold",
        badge_day: "24",
        badge_month: "DEC",
        featured: true,
      },
      {
        id: "navidad-gift",
        eyebrow: "Gift",
        title: "Digital gift card",
        body:
          "Send a gift card on WhatsApp in under 5 minutes. The recipient chooses date, technique and length.",
        cta_label: "Buy the gift card",
        cta_href: "#contacto",
        accent: "mocha",
        featured: false,
      },
      {
        id: "navidad-aniversario",
        eyebrow: "Anniversary",
        title: "Year-end — refill credit",
        body:
          "Clients who attended 3 or more sessions in 2026 receive their first January refill on us.",
        cta_label: "Check my eligibility",
        cta_href: "#contacto",
        accent: "ink",
        badge_day: "31",
        badge_month: "DEC",
        featured: false,
      },
    ],
  },

  vacio: {
    slug: "vacio",
    label: "No active promotion",
    active: true,
    strip: null,
    items: [],
  },
};
