import type { PromosBySlug } from "./promos.types";

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
      tag: "Opening gift",
      message:
        "The first 30 clients receive an editorial press-on set with their appointment.",
      cta: "Claim my spot",
      href: "#contacto",
      until: "Until Jul · 15",
      accent: "gold",
    },
    items: [
      {
        id: "opening-gift",
        eyebrow: "Opening · Vol. 01",
        title: "A gift for the first 30 clients",
        body:
          "Book your appointment before July 15 and take home an editorial press-on set designed by our artists — built for your next two events without spending the session.",
        cta_label: "Reserve my spot",
        cta_href: "#contacto",
        ribbon: "30 spots · 12 already taken",
        accent: "gold",
        badge_day: "15",
        badge_month: "JUL",
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
      {
        id: "opening-event",
        eyebrow: "Launch night",
        title: "Opening cocktail",
        body:
          "Saturday, June 15 · 5pm. Drinks, live demos and an attendee-only discount on the same week's bookings.",
        cta_label: "Confirm attendance",
        cta_href: "#contacto",
        accent: "ink",
        badge_day: "15",
        badge_month: "JUN",
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
