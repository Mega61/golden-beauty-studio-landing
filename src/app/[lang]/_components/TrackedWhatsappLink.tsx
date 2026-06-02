"use client";

import { trackWhatsappClick } from "@/lib/analytics";

type Props = {
  href: string;
  location: string;
  extra?: Record<string, unknown>;
  className?: string;
  style?: React.CSSProperties;
  "aria-label"?: string;
  children: React.ReactNode;
};

export default function TrackedWhatsappLink({
  href,
  location,
  extra,
  className,
  style,
  children,
  ...rest
}: Props) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => trackWhatsappClick(location, extra)}
      className={className}
      style={style}
      {...rest}
    >
      {children}
    </a>
  );
}
