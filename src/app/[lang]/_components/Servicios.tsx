import { EyebrowLabel, PrimaryCTA } from "./atoms";
import { siteConfig } from "@/config/site";
import { getPricing } from "@/data/pricing";
import {
  formatPrice,
  formatDuration,
  type PricingLocale,
} from "@/data/pricing-format";

type ItemCopy = { name: string; desc: string };
type CategoryCopy = {
  label: string;
  sub: string;
  items: Record<string, ItemCopy>;
};

type ServiciosDict = {
  eyebrow: string;
  title1: string;
  title2_em: string;
  body: string;
  labels: { from: string; currencySuffix: string };
  categories: Record<string, CategoryCopy>;
  footnote: string;
  cta: string;
};

export default async function Servicios({
  dict,
  lang,
}: {
  dict: ServiciosDict;
  lang: PricingLocale;
}) {
  const { from: fromLabel, currencySuffix } = dict.labels;
  const pricing = await getPricing(lang, dict.categories);

  return (
    <section
      id="servicios"
      className="relative bg-paper px-0 pb-16 pt-18 md:px-20 md:pb-30 md:pt-[140px]"
    >
      <div className="relative mx-auto max-w-[1240px]">
        <div className="mb-10 px-5 text-center md:mb-20 md:px-0">
          <EyebrowLabel className="text-gold">{dict.eyebrow}</EyebrowLabel>
          <h2
            className="mb-3.5 mt-3.5 font-display text-[40px] font-normal leading-[1.02] text-ink md:text-[72px]"
            style={{ letterSpacing: "-0.02em" }}
          >
            {dict.title1}
            <br />
            <em className="italic text-gold">{dict.title2_em}</em>
          </h2>
          <p className="mx-auto max-w-[560px] font-sans text-[14px] leading-[1.6] text-ink-soft md:text-base">
            {dict.body}
          </p>
        </div>

        <div className="grid grid-cols-1 px-5 md:grid-cols-2 md:gap-14 md:px-0">
          {pricing.map((cat, ci) => (
            <div
              key={cat.id}
              className="border-t border-hair py-7 md:py-9"
            >
              <div className="mb-5 flex items-baseline justify-between gap-4 md:mb-7">
                <div>
                  <h3 className="m-0 font-display text-[26px] font-normal italic text-ink md:text-[34px]">
                    {cat.label}
                  </h3>
                  <p className="m-0 mt-1.5 font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-gold">
                    {cat.sub}
                  </p>
                </div>
                <span className="font-display text-[36px] italic text-gold-soft opacity-60">
                  0{ci + 1}
                </span>
              </div>

              <ul className="m-0 flex list-none flex-col gap-[18px] p-0">
                {cat.items.map((it) => {
                  const price = formatPrice(
                    it.priceCOP,
                    lang,
                    fromLabel,
                    currencySuffix,
                    it.fromPrice,
                  );
                  const dur = formatDuration(it.durationMin);
                  return (
                    <li
                      key={it.id}
                      className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-b border-dashed pb-3.5"
                      style={{ borderColor: "var(--hair)" }}
                    >
                      <span className="font-sans text-[14px] font-medium text-ink md:text-[15px]">
                        {it.name}
                      </span>
                      <span className="whitespace-nowrap text-right font-display text-[15px] italic text-gold md:text-[17px]">
                        {price}
                      </span>
                      <span className="font-sans text-[12px] leading-[1.5] text-ink-mute">
                        {it.desc}
                      </span>
                      <span className="text-right font-sans text-[10px] uppercase tracking-[0.18em] text-ink-mute">
                        {dur}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 px-5 text-center md:mt-16 md:px-0">
          <p className="mb-6 font-sans text-[12px] text-ink-mute">{dict.footnote}</p>
          <PrimaryCTA href={siteConfig.bookingUrl} trackLocation="services">
            {dict.cta}
          </PrimaryCTA>
        </div>
      </div>
    </section>
  );
}
