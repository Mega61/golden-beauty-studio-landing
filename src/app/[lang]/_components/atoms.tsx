import Link from "next/link";

export function GoldRule({
  className = "",
  width = 60,
}: {
  className?: string;
  width?: number;
}) {
  return (
    <span
      aria-hidden
      className={`inline-block h-px ${className}`}
      style={{
        width,
        background:
          "linear-gradient(90deg, transparent, var(--color-gold), transparent)",
      }}
    />
  );
}

export function EyebrowLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`font-sans text-[11px] font-semibold uppercase tracking-[0.32em] ${className}`}
    >
      {children}
    </span>
  );
}

export function PrimaryCTA({
  children,
  href,
  dark = false,
  className = "",
}: {
  children: React.ReactNode;
  href: string | null | undefined;
  dark?: boolean;
  className?: string;
}) {
  if (!href) return null;
  const external = /^https?:\/\//i.test(href);
  const linkProps = external
    ? { target: "_blank" as const, rel: "noopener noreferrer" }
    : {};
  const base =
    "inline-flex items-center gap-3 px-6 py-3.5 md:px-8 md:py-[17px] font-sans text-[12px] md:text-[13px] font-semibold uppercase tracking-[0.24em] no-underline cursor-pointer";
  return (
    <Link
      href={href}
      {...linkProps}
      className={`${base} ${
        dark
          ? "border border-gold bg-carbon text-gold-soft"
          : "bg-gold-grad text-white"
      } ${className}`}
    >
      {children}
      <span className="font-serif text-base leading-none">→</span>
    </Link>
  );
}

export function SecondaryCTA({
  children,
  href = "#servicios",
  onLight = true,
  className = "",
}: {
  children: React.ReactNode;
  href?: string;
  onLight?: boolean;
  className?: string;
}) {
  // Plain <a> instead of next/link: this CTA is always an in-page hash
  // anchor. Next's <Link> short-circuits repeat clicks when the URL is
  // already at the same pathname+hash, so the browser never re-fires the
  // anchor jump. Native <a> works on every click.
  return (
    <a
      href={href}
      className={`inline-flex cursor-pointer items-center gap-3 px-6 py-3.5 md:px-7 md:py-4 font-sans text-[12px] md:text-[13px] font-medium uppercase tracking-[0.24em] no-underline border bg-transparent ${
        onLight ? "border-hair text-ink" : "text-ivory"
      } ${className}`}
      style={
        onLight ? undefined : { borderColor: "rgba(255,255,255,0.3)" }
      }
    >
      {children}
    </a>
  );
}
