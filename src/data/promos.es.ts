import type { PromosBySlug } from "./promos.types";
import { promoPrice, promoPriceRows } from "./promo-prices";
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
          "Reserva tu primera cita y llévate a casa un kit — exfoliante de manos, lima y aceite de cutícula para extender el resultado entre sesiones. Sin fecha límite: vale mientras duren los 100 kits.",
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
          "Por cada referida que agenda su primera cita, ambas reciben 10% en el retoque siguiente.",
        cta_label: "Ver detalles",
        cta_href: "#contacto",
        accent: "mocha",
        featured: false,
        terms: [
          "Aplica solo cuando la referida es una clienta nueva, sin citas previas en el estudio.",
          "El descuento del 10% se aplica al primer retoque posterior de cada una — no acumulable con otras promociones ni canjeable por efectivo.",
          "La referida debe mencionar el nombre de quien la refiere al momento de agendar; no se aplica retroactivamente.",
          "El beneficio se libera cuando la referida completa (no solo agenda) su primera cita.",
          "Una referida solo cuenta para una clienta — no aplica para múltiples referidoras del mismo nombre.",
          "Vigente mientras esté activa la edición de apertura; el estudio puede ajustar o cerrar la mecánica con previo aviso.",
        ],
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

  // Promos de día de la semana. Recurrentes, sin starts_at/ends_at: corren
  // mientras estén en NEXT_PUBLIC_ACTIVE_PROMO. Los montos viven en
  // `promo-prices.ts`, compartidos con el inglés.
  "sabado-press": {
    slug: "sabado-press",
    label: "Sábado de Press",
    active: true,
    strip: {
      tag: "Sábado de Press",
      message: `Sábados: Press On a ${promoPrice("sabado-press", "press-on", "es")}`,
      cta: "Reservar",
      href: BOOKING,
      accent: "gold",
    },
    items: [
      {
        id: "sabado-press-on",
        eyebrow: "Todos los sábados",
        title: "Sábado de Press",
        body:
          "Press On a precio de sábado. El mismo montaje de siempre, con su largo y su diseño, por menos — solo los sábados.",
        cta_label: "Reservar un sábado",
        cta_href: BOOKING,
        image_url: "/promos/sabado-press.webp",
        image_orientation: "portrait",
        image_alt: `Afiche Sábado de Press: Press On a ${promoPrice("sabado-press", "press-on", "es")}, todos los sábados en Golden Beauty Studio.`,
        price_rows: promoPriceRows("sabado-press", "es", { "press-on": "Press On" }),
        accent: "gold",
        featured: true,
        terms_label: "Condiciones",
        terms: [
          "El precio aplica a citas de Press On realizadas un sábado.",
          "No es acumulable con otras promociones, incluido el 10% de primera visita.",
          "La reserva en línea muestra el precio regular; el precio de sábado se aplica al pagar en el estudio.",
          "Diseños adicionales por uña se cobran aparte, según la lista de precios.",
        ],
      },
    ],
  },

  "miercoles-pies": {
    slug: "miercoles-pies",
    label: "Miércoles de pies",
    active: true,
    strip: {
      tag: "Miércoles de pies",
      message: `Miércoles: pies desde ${promoPrice("miercoles-pies", "traditional-feet", "es")}`,
      cta: "Reservar",
      href: BOOKING,
      accent: "ink",
    },
    items: [
      {
        id: "miercoles-pies",
        eyebrow: "Todos los miércoles",
        title: "Miércoles de pies",
        body:
          "Tradicional o semipermanente en pies, a precio de miércoles. Una cita a mitad de semana para llegar al fin de semana lista.",
        cta_label: "Reservar un miércoles",
        cta_href: BOOKING,
        image_url: "/promos/miercoles-pies.webp",
        image_orientation: "portrait",
        image_alt: `Afiche Miércoles de pies: tradicional ${promoPrice("miercoles-pies", "traditional-feet", "es")}, semipermanente ${promoPrice("miercoles-pies", "semi-permanent-feet", "es")}, todos los miércoles en Golden Beauty Studio.`,
        price_rows: promoPriceRows("miercoles-pies", "es", {
          "traditional-feet": "Tradicional",
          "semi-permanent-feet": "Semipermanente",
        }),
        accent: "ink",
        featured: true,
        terms_label: "Condiciones",
        terms: [
          "El precio aplica a servicios de pies realizados un miércoles: tradicional o semipermanente.",
          "No es acumulable con otras promociones, incluido el 10% de primera visita.",
          "La reserva en línea muestra el precio regular; el precio de miércoles se aplica al pagar en el estudio.",
          "Limpieza profunda y diseños se cobran aparte, según la lista de precios.",
        ],
      },
    ],
  },

  "primera-visita": {
    slug: "primera-visita",
    label: "Primera visita",
    active: true,
    // Evergreen: sin starts_at/ends_at — pensada para correr todo el año junto
    // a las promos que estén activas.
    strip: {
      tag: "Primera visita",
      message: "10% en tu primera cita",
      cta: "Reservar",
      href: BOOKING,
      until: "Solo clientas nuevas",
      accent: "ink",
    },
    items: [
      {
        id: "primera-visita-10",
        eyebrow: "Bienvenida",
        title: "10% en tu primera visita",
        body:
          "Si es tu primera cita en Golden, recibe 10% de descuento en el servicio que elijas — en todos nuestros servicios. Válido una sola vez.",
        cta_label: "Reservar mi primera cita",
        cta_href: BOOKING,
        ribbon: "Solo clientas nuevas",
        image_url: "/promos/primera-visita.webp",
        image_orientation: "portrait",
        image_alt:
          "Afiche 10% de descuento en tu primera visita, en todos los servicios: Press On, Polygel, Builder Gel, Acrílico, Base Rubber, semipermanente en pies y en manos.",
        accent: "ink",
        featured: true,
        terms_label: "Condiciones",
        terms: [
          "Aplica solo a clientas nuevas, sin citas previas en el estudio.",
          "El 10% se descuenta del servicio de la primera cita; los adicionales se cobran a precio regular.",
          "No es acumulable con otras promociones, incluidos Sábado de Press y Miércoles de pies.",
          "La reserva en línea muestra el precio regular; el descuento se aplica al pagar en el estudio.",
        ],
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
