import Image from "next/image";
import Link from "next/link";
import PostulacionForm, { type TrabajaDict } from "./PostulacionForm";
import type { Locale } from "../dictionaries";
import type { JobRole } from "@/data/careers.types";

/**
 * Body of the dedicated careers page (`/[lang]/trabaja-con-nosotros`).
 *
 * It lives on its own route rather than as a block on the landing: a job form
 * competes with the booking CTA for attention, and a standalone page is what you
 * can actually share — in an Instagram story, in a WhatsApp reply, in a job post
 * — and what Google can rank for "trabajo uñas Sabaneta".
 *
 * Runs on the carbon surface (like Contacto) so the form fields sit on a calm
 * ground. Server component: only the form itself ships JS.
 */
export default function Trabaja({
  dict,
  lang,
  roles,
}: {
  dict: TrabajaDict;
  lang: Locale;
  roles: JobRole[];
}) {
  return (
    <section
      id="trabaja"
      className="relative overflow-hidden bg-carbon pb-16 pt-12 text-cream md:pb-24 md:pt-16"
    >
      {/* Faint marble wash — same texture treatment as the /bio card, kept low
          enough that the form stays the subject. */}
      <div
        aria-hidden
        className="bg-marble pointer-events-none absolute inset-0"
        style={{ opacity: 0.06 }}
      />

      <div className="relative mx-auto max-w-[1280px] px-5 md:px-14">
        <div className="mb-4 flex items-center gap-3 md:mb-6">
          <span aria-hidden className="block h-px w-7 bg-gold-bright" />
          <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.32em] text-gold-bright">
            {dict.eyebrow}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-10 md:grid-cols-[0.85fr_1.15fr] md:gap-16">
          {/* Left rail — the pitch. Not sticky: with the studio photo it now
              carries its own weight, and a column taller than the viewport
              sticks badly. */}
          <div>
            <h1
              className="m-0 mb-5 font-display text-[38px] font-normal leading-[1.05] md:text-[52px]"
              style={{ letterSpacing: "-0.015em", textWrap: "balance" }}
            >
              {dict.title1}
              <br />
              <em className="text-gold-grad-light not-italic">
                <span className="italic">{dict.title2_em}</span>
              </em>
            </h1>

            <p
              className="m-0 mb-7 max-w-[62ch] font-sans text-[14px] leading-[1.75] md:text-[15px]"
              style={{ color: "rgba(243,236,223,0.78)", textWrap: "pretty" }}
            >
              {dict.body}
            </p>

            {dict.perks.length > 0 && (
              <ul className="m-0 list-none p-0">
                {dict.perks.map((perk) => (
                  <li
                    key={perk}
                    className="flex items-start gap-3 font-sans text-[13px] leading-[1.5]"
                    style={{
                      padding: "12px 0",
                      borderTop: "1px solid rgba(243,236,223,0.12)",
                      color: "rgba(243,236,223,0.82)",
                    }}
                  >
                    <span
                      aria-hidden
                      className="font-display text-[15px] italic leading-none text-gold-bright"
                      style={{ marginTop: 2 }}
                    >
                      —
                    </span>
                    {perk}
                  </li>
                ))}
              </ul>
            )}

            {/* One decisive photo: the first thing an applicant wants to know is
                where she'd actually be working. The real storefront answers it —
                its warm marble and gold sit inside the palette rather than
                fighting it, which a portrait on a coloured backdrop did not. */}
            <div
              className="relative mt-8 overflow-hidden"
              style={{
                aspectRatio: "3 / 2",
                border: "1px solid rgba(243,236,223,0.12)",
              }}
            >
              <Image
                src="/space-01.jpg"
                alt={dict.photoAlt}
                fill
                sizes="(min-width: 768px) 42vw, 100vw"
                className="object-cover"
                style={{ filter: "saturate(0.94) contrast(1.02)" }}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(28,23,20,0) 45%, rgba(28,23,20,0.55) 100%)",
                }}
              />
            </div>

          </div>

          {/* Right — the form, on a slightly lifted panel */}
          <div
            style={{
              background: "rgba(243,236,223,0.03)",
              border: "1px solid rgba(243,236,223,0.1)",
              padding: "clamp(20px, 4vw, 36px)",
            }}
          >
            <PostulacionForm
              dict={dict}
              lang={lang}
              roles={roles}
              surface="landing"
              tone="dark"
            />
          </div>
        </div>

        {/* The way out lives after the form, never before it: on a phone the
            columns stack, and an exit link above the first question is an
            invitation to leave. */}
        <Link
          href={`/${lang}`}
          className="mt-10 inline-block font-sans text-[10px] font-semibold uppercase tracking-[0.24em] no-underline"
          style={{ color: "rgba(243,236,223,0.62)" }}
        >
          ← {dict.meta.back}
        </Link>
      </div>
    </section>
  );
}
