import { EyebrowLabel } from "./atoms";
import LookbookGrid from "./LookbookGrid";
import type { Locale } from "../dictionaries";
import { LOOKBOOK } from "@/data/lookbook-manifest";
import { CATEGORY_ORDER } from "@/data/lookbook-categories";

type LookbookDict = {
  eyebrow: string;
  title1: string;
  title2_em: string;
  body: string;
  allLabel: string;
  seeAll: string;
  lightbox: {
    close: string;
    next: string;
    previous: string;
    counter: string;
  };
};

export default function Lookbook({
  lang,
  dict,
}: {
  lang: Locale;
  dict: LookbookDict;
}) {
  return (
    <section
      id="trabajo"
      className="bg-ivory px-5 pb-16 pt-20 md:px-20 md:pb-30 md:pt-[140px]"
    >
      <div className="mx-auto max-w-[1440px]">
        <div className="md:grid md:grid-cols-2 md:items-end md:gap-14">
          <div>
            <EyebrowLabel className="text-gold">{dict.eyebrow}</EyebrowLabel>
            <h2
              className="m-0 mt-3.5 font-display text-[40px] font-normal leading-[1.02] text-ink md:text-[76px]"
              style={{ letterSpacing: "-0.02em" }}
            >
              {dict.title1}
              <br />
              <em className="italic text-gold">{dict.title2_em}</em>
            </h2>
          </div>
          <div>
            <p className="mt-4 max-w-[480px] font-sans text-[14px] leading-[1.6] text-ink-soft md:mt-0 md:text-base">
              {dict.body}
            </p>
          </div>
        </div>

        <LookbookGrid
          lang={lang}
          items={LOOKBOOK}
          categories={CATEGORY_ORDER}
          allLabel={dict.allLabel}
          lightboxDict={dict.lightbox}
        />

        <div className="mt-10 text-center md:mt-14">
          <a
            href="#all"
            className="border-b border-gold pb-1 font-sans text-[12px] font-medium uppercase tracking-[0.28em] text-ink no-underline"
          >
            {dict.seeAll}
          </a>
        </div>
      </div>
    </section>
  );
}
