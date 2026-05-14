import { EyebrowLabel } from "./atoms";
import Placeholder from "./Placeholder";

type Item = {
  name: string;
  dur: string;
  ideal: string;
  body?: string;
  placeholder?: string;
};

type DiccionarioDict = {
  eyebrow: string;
  title1: string;
  title2_em: string;
  body: string;
  fallback: string;
  labels: { duration: string; ideal: string };
  items: Item[];
};

// All 6 technique cards render the brand-seal Placeholder.
// (Earlier versions wired 3 of them to /lookbook/0X.jpg flat paths — those
// files moved into category subfolders during the v6 reorg, so the procImages
// references 404'd. The logo-seal treatment reads cleanly on the dark
// Diccionario backdrop and is the right placeholder until process-shot
// photography ships.)

export default function Diccionario({ dict }: { dict: DiccionarioDict }) {
  return (
    <section className="relative overflow-hidden bg-carbon px-5 pb-16 pt-18 text-ivory md:px-20 md:pb-30 md:pt-[140px]">
      <div
        aria-hidden
        className="bg-marble pointer-events-none absolute inset-0"
        style={{ mixBlendMode: "overlay", opacity: 0.15 }}
      />
      <div className="relative mx-auto max-w-[1240px]">
        <div className="mb-9 md:mb-18 md:grid md:grid-cols-2 md:items-end md:gap-14">
          <div>
            <EyebrowLabel className="text-gold-bright">{dict.eyebrow}</EyebrowLabel>
            <h2
              className="m-0 mt-3.5 font-display text-[38px] font-normal leading-[1.02] text-ivory md:text-[64px]"
              style={{ letterSpacing: "-0.02em" }}
            >
              {dict.title1}
              <br />
              <em className="text-gold-grad-light not-italic">
                <span className="italic">{dict.title2_em}</span>
              </em>
            </h2>
          </div>
          <p
            className="mt-4 max-w-[520px] font-sans text-[14px] leading-[1.6] md:mt-0 md:text-base"
            style={{ color: "rgba(248,244,238,0.7)" }}
          >
            {dict.body}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-3 md:gap-7">
          {dict.items.map((t, i) => {
            return (
              <article
                key={t.name}
                className="flex flex-col gap-[18px] p-5 md:p-7"
                style={{
                  border: "1px solid rgba(231,170,81,0.18)",
                  background: "rgba(255,255,255,0.02)",
                }}
              >
                <div
                  className="overflow-hidden"
                  style={{
                    aspectRatio: "4 / 3",
                    background: "#2a2520",
                    position: "relative",
                  }}
                >
                  <Placeholder label={t.placeholder ?? t.name} tone="ink" />
                </div>

                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="m-0 font-display text-[28px] font-normal italic text-gold-bright">
                    {t.name}
                  </h3>
                  <span
                    className="font-display text-[24px] italic"
                    style={{ color: "rgba(231,170,81,0.3)" }}
                  >
                    0{i + 1}
                  </span>
                </div>

                <p
                  className="m-0 font-sans text-[13.5px] leading-[1.6]"
                  style={{ color: "rgba(248,244,238,0.72)" }}
                >
                  {t.body ?? dict.fallback}
                </p>

                <dl
                  className="m-0 grid grid-cols-2 gap-x-4 gap-y-2.5 pt-3.5"
                  style={{ borderTop: "1px solid rgba(231,170,81,0.15)" }}
                >
                  <div>
                    <dt
                      className="mb-1 font-sans text-[9px] uppercase tracking-[0.22em]"
                      style={{ color: "rgba(255,212,159,0.5)" }}
                    >
                      {dict.labels.duration}
                    </dt>
                    <dd className="m-0 font-sans text-[12px] text-ivory">
                      {t.dur}
                    </dd>
                  </div>
                  <div>
                    <dt
                      className="mb-1 font-sans text-[9px] uppercase tracking-[0.22em]"
                      style={{ color: "rgba(255,212,159,0.5)" }}
                    >
                      {dict.labels.ideal}
                    </dt>
                    <dd className="m-0 font-sans text-[12px] text-ivory">
                      {t.ideal}
                    </dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
