import { siteConfig } from "@/config/site";
import TrackedBookingLink from "../TrackedBookingLink";
import Bauble from "./Bauble";
import SeasonVideo from "./SeasonVideo";

export type AdventDict = {
  eyebrow: string;
  title: string;
  title_em: string;
  body: string;
  note: string;
  cta: string;
  ctaBooking: string;
};

/**
 * "Tu tarjeta Golden trae calendario de adviento" — la banda de diciembre
 * dentro de `#promos`.
 *
 * Como la de vacantes, no es una promo del carrusel: es un hecho fijo de la
 * temporada (puertas del 2 al 24) y una slide que rota se la pierde la mitad.
 * Lleva a la tarjeta de fidelidad (Stampee), donde viven las puertas; para
 * quien aún no tiene tarjeta, el segundo botón es agendar — la tarjeta se crea
 * sola con la primera visita.
 *
 * Server component, pasado a `Highlights` como slot (igual que `VacantesBand`).
 * Solo el video es cliente.
 */
export default function AdventBand({
  dict,
  bookingHref,
}: {
  dict: AdventDict;
  bookingHref: string | null;
}) {
  const titleId = "adviento-band-title";
  return (
    <aside
      id="adviento"
      aria-labelledby={titleId}
      className="relative mx-5 grid grid-cols-1 overflow-hidden md:mx-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"
      style={{
        background: "var(--color-carbon)",
        border: "1px solid rgba(231, 170, 81, 0.22)",
      }}
    >
      <div
        className="relative aspect-[16/11] md:aspect-auto md:min-h-[360px]"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 40%, #3a2c1f 0%, var(--color-carbon) 70%)",
        }}
      >
        {/* Mientras el video no carga (o si falta), tres bolas cuelgan del
            borde: el panel nunca queda vacío. El video las tapa al llegar. */}
        <div aria-hidden className="gbs-garland is-live absolute inset-0">
          {[
            { left: "28%", size: 30, thread: 90, delay: "0s" },
            { left: "52%", size: 44, thread: 150, delay: "-1.8s" },
            { left: "74%", size: 24, thread: 60, delay: "-3.1s" },
          ].map((b) => (
            <Bauble
              key={b.left}
              size={b.size}
              thread={b.thread}
              className="gbs-swing absolute top-0"
              style={{ left: b.left, marginLeft: -b.size / 2, animationDelay: b.delay }}
            />
          ))}
        </div>
        <SeasonVideo
          webm="/navidad/ornamentos.webm"
          mp4="/navidad/ornamentos.mp4"
          poster="/navidad/ornamentos-poster.jpg"
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>

      <div className="flex flex-col justify-center px-6 py-9 md:px-14 md:py-14">
        <div className="mb-4 flex items-center gap-3.5">
          <span className="block h-px w-9 bg-gold-bright" aria-hidden />
          <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.32em] text-gold-bright">
            {dict.eyebrow}
          </span>
        </div>
        <p
          id={titleId}
          className="m-0 font-display text-[32px] font-normal leading-[1.04] text-cream md:text-[46px]"
          style={{ letterSpacing: "-0.015em" }}
        >
          {dict.title}{" "}
          <em className="text-gold-grad-light italic">{dict.title_em}</em>
        </p>
        <p className="m-0 mt-5 max-w-[460px] font-sans text-[14px] leading-[1.6] text-gold-soft/80 md:text-[15px]">
          {dict.body}
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-4">
          {/* A la sección "Encuentra tu tarjeta" de esta misma página: ahí sale su
              link, y el calendario vive en el reverso de su tarjeta. Sin la
              sección, a la raíz de Stampee. */}
          <a
            href={siteConfig.sections.tarjeta ? "#mi-tarjeta" : siteConfig.loyaltyUrl}
            {...(siteConfig.sections.tarjeta ? {} : { target: "_blank", rel: "noopener" })}
            className="inline-flex items-center gap-2.5 px-6 py-3.5 font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-carbon no-underline"
            style={{
              background:
                "linear-gradient(135deg, var(--color-gold-soft) 0%, var(--color-gold-bright) 45%, var(--color-gold) 100%)",
            }}
          >
            {dict.cta} <span aria-hidden>→</span>
          </a>
          {bookingHref && (
            <TrackedBookingLink
              href={bookingHref}
              location="adviento"
              className="font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-gold-bright underline underline-offset-[5px]"
            >
              {dict.ctaBooking}
            </TrackedBookingLink>
          )}
        </div>
        <p className="m-0 mt-5 font-display text-[15px] italic text-gold-soft/60">
          {dict.note}
        </p>
      </div>
    </aside>
  );
}
