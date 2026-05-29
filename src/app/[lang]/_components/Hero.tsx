import Image from "next/image";
import { EyebrowLabel, PrimaryCTA, SecondaryCTA } from "./atoms";
import { siteConfig } from "@/config/site";

type HeroDict = {
  eyebrow: string;
  title1: string;
  title2_em: string;
  body: string;
  ctaPrimary: string;
  ctaSecondary: string;
  metaHours: string;
  metaArea: string;
  metaStatus: string;
};

export default function Hero({ dict }: { dict: HeroDict }) {
  return (
    <section className="relative bg-carbon">
      <div className="relative h-[620px] overflow-hidden md:h-[760px]">
        <Image
          src="/hero.jpg"
          alt="Golden Beauty Studio — uñas esculpidas en Sabaneta"
          fill
          priority
          sizes="100vw"
          className="object-cover"
          style={{ filter: "brightness(0.78) contrast(1.04) saturate(0.95)" }}
        />

        {/* dark gradient + marble overlay (medium gold intensity) */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(20,15,12,0.45) 0%, rgba(20,15,12,0.15) 35%, rgba(20,15,12,0.7) 100%)",
          }}
        />
        <div
          aria-hidden
          className="bg-marble absolute inset-0"
          style={{ mixBlendMode: "soft-light", opacity: 0.3 }}
        />

        {/* Brand watermark — ghosted FullLogoTexture, bottom-right bleed.
            Acts as a paper-stamp brand presence behind the photo. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logos/optimized/FullLogoTexture.webp"
          alt=""
          aria-hidden
          decoding="async"
          className="pointer-events-none absolute hidden md:block"
          style={{
            right: "-6%",
            bottom: "-12%",
            width: "min(560px, 50%)",
            opacity: 0.13,
            mixBlendMode: "soft-light",
          }}
        />

        <div className="absolute inset-0 mx-auto flex max-w-[1440px] flex-col justify-end px-6 pb-14 text-ivory md:px-20 md:pb-20">
          <div className="mb-4 flex items-center gap-3.5 md:mb-6">
            <span className="block h-px w-9 bg-gold-bright" aria-hidden />
            <EyebrowLabel className="text-gold-soft">{dict.eyebrow}</EyebrowLabel>
          </div>
          <h1
            className="m-0 max-w-[900px] font-display text-[44px] font-normal leading-[0.98] md:text-[96px]"
            style={{ letterSpacing: "-0.02em" }}
          >
            {dict.title1}
            <br />
            <em className="text-gold-grad-light not-italic">
              <span className="italic">{dict.title2_em}</span>
            </em>
          </h1>
          <p className="mt-5 max-w-[520px] font-sans text-[14px] leading-[1.55] opacity-85 md:mt-7 md:text-[17px]">
            {dict.body}
          </p>
          <div className="mt-7 flex flex-wrap gap-3.5 md:mt-10">
            <PrimaryCTA href={siteConfig.bookingUrl} trackLocation="hero">
              {dict.ctaPrimary}
            </PrimaryCTA>
            <SecondaryCTA onLight={false} trackLocation="hero">
              {dict.ctaSecondary}
            </SecondaryCTA>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 bg-carbon px-6 py-3.5 font-sans text-[11px] uppercase tracking-[0.22em] text-gold-soft md:px-20 md:py-4">
        <span>{dict.metaHours}</span>
        <span className="hidden opacity-45 md:inline">{dict.metaArea}</span>
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-gold-bright" />
          {dict.metaStatus}
        </span>
      </div>
    </section>
  );
}
