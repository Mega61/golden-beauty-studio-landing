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
          "Book your first appointment and take home a kit — hand exfoliator, nail file and cuticle oil to keep the result going between sessions. No deadline: valid while the 100 kits last.",
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
          "For every referral who books her first appointment, both of you receive 10% off your next refill.",
        cta_label: "See details",
        cta_href: "#contacto",
        accent: "mocha",
        featured: false,
        terms: [
          "Applies only when the referral is a new client with no prior appointments at the studio.",
          "The 10% discount applies to each one's next refill — not stackable with other promotions and not redeemable for cash.",
          "The referral must mention the referrer's name at the time of booking; it cannot be applied retroactively.",
          "The benefit is unlocked once the referral completes (not just books) her first appointment.",
          "A referral counts toward only one referrer — multiple referrers cannot claim the same person.",
          "Valid while the opening edition is active; the studio may adjust or close the mechanic with prior notice.",
        ],
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

  "primera-visita": {
    slug: "primera-visita",
    label: "First visit",
    active: true,
    // Evergreen: no starts_at/ends_at — meant to run year-round alongside
    // whichever seasonal promo is active.
    strip: {
      tag: "First visit",
      message:
        "10% off your first appointment at the studio — new clients only.",
      cta: "Book now",
      href: BOOKING,
      accent: "ink",
    },
    items: [
      {
        id: "primera-visita-10",
        eyebrow: "Welcome",
        title: "10% off your first visit",
        body:
          "If it's your first appointment at Golden, take 10% off the service you choose. No deadline — the benefit is valid once, when you book your first appointment.",
        cta_label: "Book my first appointment",
        cta_href: BOOKING,
        ribbon: "New clients only",
        image_url: "/primera-visita.jpg",
        accent: "ink",
        featured: true,
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
