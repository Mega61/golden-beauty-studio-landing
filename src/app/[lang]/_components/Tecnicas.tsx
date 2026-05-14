import Image from "next/image";
import { EyebrowLabel } from "./atoms";
import { siteConfig } from "@/config/site";

type Member = { name: string; role: string; years: string; quote: string };
type TecnicasDict = {
  eyebrow: string;
  title1: string;
  title2_em: string;
  team: Member[];
  bookWith: string;
};

const portraits = ["/tecnica-01.jpg", "/tecnica-02.jpg"];

export default function Tecnicas({ dict }: { dict: TecnicasDict }) {
  return (
    <section
      id="tecnicas"
      className="bg-ivory px-5 pb-16 pt-18 md:px-20 md:pb-30 md:pt-[140px]"
    >
      <div className="mx-auto max-w-[1240px]">
        <div className="mb-9 text-left md:mb-18 md:text-center">
          <EyebrowLabel className="text-gold">{dict.eyebrow}</EyebrowLabel>
          <h2
            className="m-0 mt-3.5 font-display text-[38px] font-normal leading-[1.02] text-ink md:text-[64px]"
            style={{ letterSpacing: "-0.02em" }}
          >
            {dict.title1}
            <br />
            <em className="italic text-gold">{dict.title2_em}</em>
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-9 md:grid-cols-2 md:gap-14">
          {dict.team.map((m, i) => (
            <article key={m.name} className="flex flex-col gap-5">
              <div
                className="relative overflow-hidden bg-cream"
                style={{ aspectRatio: "3 / 4" }}
              >
                <Image
                  src={portraits[i]}
                  alt={m.name}
                  fill
                  sizes="(min-width: 768px) 50vw, 100vw"
                  className="object-cover"
                  style={{ filter: "saturate(0.88) contrast(1.02) sepia(0.05)" }}
                />
                <div
                  className="absolute left-3.5 top-3.5 px-2.5 py-[5px] font-sans text-[10px] font-semibold uppercase tracking-[0.22em] text-ink"
                  style={{ background: "rgba(248,244,238,0.92)" }}
                >
                  {m.years}
                </div>
              </div>
              <div>
                <h3 className="m-0 font-display text-[26px] font-normal text-ink md:text-[32px]">
                  {m.name}
                </h3>
                <p className="m-0 mb-[18px] mt-2 font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-gold">
                  {m.role}
                </p>
                <p
                  className="m-0 mb-6 pl-4 font-display text-[17px] italic leading-[1.4] text-ink-soft md:text-[19px]"
                  style={{ borderLeft: "1px solid var(--color-gold)" }}
                >
                  &ldquo;{m.quote}&rdquo;
                </p>
                {siteConfig.bookingUrl && (
                  <a
                    href={siteConfig.bookingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="border-b border-gold pb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.28em] text-ink no-underline"
                  >
                    {dict.bookWith} {m.name.split(" ")[0]} →
                  </a>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
