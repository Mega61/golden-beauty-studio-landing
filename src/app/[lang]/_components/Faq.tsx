import { EyebrowLabel, GoldRule } from "./atoms";
import { resolvePriceTokens } from "@/lib/seo";
import type { Locale } from "../dictionaries";

type FaqItem = { q: string; a: string };

type FaqDict = {
  eyebrow: string;
  title1: string;
  title2_em: string;
  body: string;
  items: FaqItem[];
};

/**
 * Plain question-and-answer block.
 *
 * Deliberately *not* a <details> accordion and deliberately not written in the
 * evocative voice the rest of the page uses: this is the one section whose job
 * is to match the literal phrasing people type into Google and ask assistants
 * ("¿cuánto cuestan las uñas acrílicas?"). Questions are real <h3>s under the
 * section's <h2> so the outline stays extractable, and every answer is
 * self-contained — no "as mentioned above", no pronouns pointing at other
 * sections — so a passage lifted on its own still makes sense.
 *
 * Prices come from `{price:<id>}` tokens resolved against pricing.ts, so the
 * numbers here can never drift from the price list (see AGENTS.md).
 */
export default function Faq({
  dict,
  lang,
  currencySuffix,
}: {
  dict: FaqDict;
  lang: Locale;
  currencySuffix: string;
}) {
  if (!dict.items?.length) return null;

  return (
    <section
      id="faq"
      className="relative bg-ivory px-5 py-16 md:px-20 md:py-28"
    >
      <div className="mx-auto max-w-[1240px]">
        <div className="mb-10 md:mb-16 md:grid md:grid-cols-2 md:items-end md:gap-14">
          <div>
            <EyebrowLabel className="text-gold">{dict.eyebrow}</EyebrowLabel>
            <h2
              className="m-0 mt-3.5 font-display text-[38px] font-normal leading-[1.02] text-ink md:text-[58px]"
              style={{ letterSpacing: "-0.02em" }}
            >
              {dict.title1}
              <br />
              <em className="text-gold-grad not-italic">
                <span className="italic">{dict.title2_em}</span>
              </em>
            </h2>
          </div>
          <p className="mt-4 max-w-[520px] font-sans text-[14px] leading-[1.6] text-ink-soft md:mt-0 md:text-base">
            {dict.body}
          </p>
        </div>

        <GoldRule width={80} className="mb-10 md:mb-14" />

        <div className="grid grid-cols-1 gap-x-16 gap-y-9 md:grid-cols-2 md:gap-y-12">
          {dict.items.map((item) => (
            <article key={item.q} className="flex flex-col gap-2.5">
              <h3
                className="m-0 font-display text-[21px] font-normal leading-[1.25] text-ink md:text-[25px]"
                style={{ letterSpacing: "-0.01em" }}
              >
                {item.q}
              </h3>
              <p className="m-0 font-sans text-[14px] leading-[1.7] text-ink-soft md:text-[15px]">
                {resolvePriceTokens(item.a, lang, currencySuffix)}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
