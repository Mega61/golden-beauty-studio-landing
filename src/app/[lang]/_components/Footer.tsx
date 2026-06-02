import { siteConfig } from "@/config/site";
import Logo from "./Logo";
import TrackedBookingLink from "./TrackedBookingLink";
import TrackedWhatsappLink from "./TrackedWhatsappLink";

type FooterDict = {
  tagline: string;
  visit: {
    title: string;
    address1: string;
    address2: string;
    hours: string;
  };
  find: {
    title: string;
    links: string[];
  };
  copyright: string;
};

function resolveFindLink(
  label: string,
  urls: {
    instagram: string | null;
    whatsapp: string | null;
    booking: string | null;
    maps: string;
  }
): string | null {
  const l = label.toLowerCase();
  if (l.includes("instagram")) return urls.instagram;
  if (l.includes("whatsapp")) return urls.whatsapp;
  if (l.includes("agendapro") || l.includes("fresha")) return urls.booking;
  if (l.includes("google") || l.includes("maps")) return urls.maps;
  return null;
}

export default function Footer({ dict }: { dict: FooterDict }) {
  const { instagramUrl, whatsappUrl, bookingUrl, mapsPlaceId } = siteConfig;
  const addressQuery = encodeURIComponent(
    [dict.visit.address1, dict.visit.address2].join(", ")
  );
  const mapsHref = mapsPlaceId
    ? `https://www.google.com/maps/search/?api=1&query=${addressQuery}&query_place_id=${mapsPlaceId}`
    : `https://www.google.com/maps/search/?api=1&query=${addressQuery}`;
  const findUrls = {
    instagram: instagramUrl,
    whatsapp: whatsappUrl,
    booking: bookingUrl,
    maps: mapsHref,
  };
  return (
    <footer
      className="bg-ivory px-5 pb-9 pt-14 md:px-20 md:pb-12 md:pt-24"
      style={{ borderTop: "1px solid var(--hair)" }}
    >
      <div className="mx-auto max-w-[1240px]">
        <div className="mb-9 grid grid-cols-1 gap-8 md:mb-14 md:grid-cols-[1.4fr_1fr_1fr] md:gap-14">
          <div>
            <Logo variant="text" size={14} />
            <p className="m-0 mt-6 max-w-[380px] whitespace-pre-line font-display text-[16px] italic leading-[1.5] text-ink-soft md:text-[19px]">
              {dict.tagline}
            </p>
          </div>
          <div>
            <h4 className="m-0 mb-4 font-sans text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
              {dict.visit.title}
            </h4>
            <p className="m-0 font-sans text-[14px] leading-[1.7] text-ink">
              {dict.visit.address1}
              <br />
              {dict.visit.address2}
              <br />
              <span className="text-ink-mute">{dict.visit.hours}</span>
            </p>
          </div>
          <div>
            <h4 className="m-0 mb-4 font-sans text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
              {dict.find.title}
            </h4>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {dict.find.links.map((l) => {
                const href = resolveFindLink(l, findUrls);
                if (!href) return null;
                const isBooking = href === findUrls.booking;
                const isWhatsapp = href === findUrls.whatsapp;
                const className =
                  "pb-0.5 font-sans text-[14px] text-ink no-underline";
                const style = { borderBottom: "1px solid var(--hair)" };
                return (
                  <li key={l}>
                    {isBooking ? (
                      <TrackedBookingLink
                        href={href}
                        location="footer"
                        className={className}
                        style={style}
                      >
                        {l} →
                      </TrackedBookingLink>
                    ) : isWhatsapp ? (
                      <TrackedWhatsappLink
                        href={href}
                        location="footer"
                        className={className}
                        style={style}
                      >
                        {l} →
                      </TrackedWhatsappLink>
                    ) : (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={className}
                        style={style}
                      >
                        {l} →
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <div
          className="pt-6"
          style={{ borderTop: "1px solid var(--hair)" }}
        >
          <span className="font-sans text-[11px] text-ink-mute">
            {dict.copyright}
          </span>
        </div>
      </div>
    </footer>
  );
}
