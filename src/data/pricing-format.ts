export type PricingLocale = "es" | "en";

const groupFormatters: Record<PricingLocale, Intl.NumberFormat> = {
  es: new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 }),
  en: new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }),
};

export function formatPrice(
  amountCOP: number,
  lang: PricingLocale,
  fromLabel: string,
  currencySuffix: string,
  isFrom?: boolean,
): string {
  const base = `$${groupFormatters[lang].format(amountCOP)}${currencySuffix}`;
  return isFrom ? `${fromLabel} ${base}` : base;
}

export function formatDuration(min: number | null): string {
  if (min === null) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}h ${m}min`;
  if (h) return `${h}h`;
  return `${m}min`;
}
