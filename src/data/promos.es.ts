import type { PromosBySlug } from "./promos.types";
import { siteConfig } from "@/config/site";

// Reservation URL lives in NEXT_PUBLIC_BOOKING_URL (siteConfig.bookingUrl). If
// unset, hashes fall through to the local #contacto section.
const BOOKING = siteConfig.bookingUrl ?? "#contacto";

// Mock por idioma. Cuando se conecte Strapi, este archivo deja de usarse —
// `getActiveScenario` (en promos.ts) consultará `?locale=es&populate=deep`.
// Mientras tanto: editar aquí cambia lo que ve la landing en /es.

export const PROMOS_DATA: PromosBySlug = {
  apertura: {
    slug: "apertura",
    label: "Apertura · Junio 2026",
    active: true,
    starts_at: "2026-06-01T00:00:00.000Z",
    ends_at: "2026-07-15T23:59:59.000Z",
    strip: {
      tag: "Kit de apertura",
      message:
        "Las primeras 100 clientas reciben el kit de bienvenida Golden con su primera cita.",
      cta: "Quiero mi kit",
      href: "#promos",
      accent: "gold",
    },
    items: [
      {
        id: "opening-gift",
        eyebrow: "Apertura · Edición 01",
        title: "Un kit de bienvenida para las primeras 100",
        body:
          "Reserva tu primera cita y llévate a casa el kit curado por el estudio — exfoliante de manos, lima editorial y aceite de cutícula para extender el resultado entre sesiones. Sin fecha límite: vale mientras duren los 100 kits.",
        cta_label: "Reservar mi cita",
        cta_href: BOOKING,
        ribbon: "100 kits · Edición de apertura",
        image_url: "/apertura.jpg",
        accent: "gold",
        featured: true,
      },
      {
        id: "opening-referral",
        eyebrow: "Referidas",
        title: "Trae a una amiga, ganan las dos",
        body:
          "Por cada referida que agenda su primera cita, ambas reciben 20% en el retoque siguiente.",
        cta_label: "Ver detalles",
        cta_href: "#contacto",
        accent: "mocha",
        featured: false,
      },
    ],
  },

  madre: {
    slug: "madre",
    label: "Día de la madre · Mayo 2026",
    active: true,
    starts_at: "2026-04-15T00:00:00.000Z",
    ends_at: "2026-05-15T23:59:59.000Z",
    strip: {
      tag: "Día de la madre",
      message:
        "Regala una sesión completa con bono escrito a mano y caja de presentación.",
      cta: "Comprar bono",
      href: "#contacto",
      until: "Hasta 12 · May",
      accent: "gold",
    },
    items: [
      {
        id: "madre-gift-card",
        eyebrow: "Edición · Día de la madre",
        title: "Bono regalo para una sesión completa",
        body:
          "Una sesión de montaje a tu elección, presentada en caja de cartón texturizado con nota escrita a mano. Listo para entregar — sin envoltorio que arreglar.",
        cta_label: "Pedir mi bono",
        cta_href: "#contacto",
        ribbon: "Edición limitada · 50 bonos",
        accent: "gold",
        badge_day: "12",
        badge_month: "MAY",
        featured: true,
      },
      {
        id: "madre-duo",
        eyebrow: "Duo",
        title: "Cita doble — madre e hija",
        body:
          "Agenden juntas el mismo día y reciban un postre de Boutique La Provence al final de la sesión.",
        cta_label: "Reservar el duo",
        cta_href: "#contacto",
        accent: "mocha",
        featured: false,
      },
    ],
  },

  navidad: {
    slug: "navidad",
    label: "Temporada navideña · 2026",
    active: true,
    starts_at: "2026-11-15T00:00:00.000Z",
    ends_at: "2026-12-31T23:59:59.000Z",
    strip: {
      tag: "Temporada navideña",
      message:
        "Agenda diciembre con anticipación — los fines de semana se llenan en 48h.",
      cta: "Ver cupos",
      href: "#contacto",
      until: "Hasta 24 · Dic",
      accent: "ink",
    },
    items: [
      {
        id: "navidad-editorial",
        eyebrow: "Lookbook · Vol. 02",
        title: "Edición Navidad — set editorial",
        body:
          "Tres diseños inspirados en el oro patinado, el champagne y el bronce. Cita extendida con cóctel cortesía y polaroid de cierre.",
        cta_label: "Reservar la edición",
        cta_href: "#contacto",
        ribbon: "Cupos limitados",
        accent: "gold",
        badge_day: "24",
        badge_month: "DIC",
        featured: true,
      },
      {
        id: "navidad-gift",
        eyebrow: "Regalo",
        title: "Tarjeta regalo digital",
        body:
          "Envía un bono por WhatsApp en menos de 5 minutos. La beneficiada elige fecha, técnica y largo.",
        cta_label: "Comprar tarjeta",
        cta_href: "#contacto",
        accent: "mocha",
        featured: false,
      },
      {
        id: "navidad-aniversario",
        eyebrow: "Aniversario",
        title: "Fin de año — bono de retoque",
        body:
          "Las clientas que asistieron a 3 o más citas en 2026 reciben su primer retoque de enero sin costo.",
        cta_label: "Confirmar elegibilidad",
        cta_href: "#contacto",
        accent: "ink",
        badge_day: "31",
        badge_month: "DIC",
        featured: false,
      },
    ],
  },

  vacio: {
    slug: "vacio",
    label: "Sin promoción activa",
    active: true,
    strip: null,
    items: [],
  },
};
