"use client";

import { trackBookingClick } from "@/lib/analytics";

type Props = {
  href: string;
  location: string;
  extra?: Record<string, unknown>;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
};

export default function TrackedBookingLink({
  href,
  location,
  extra,
  className,
  style,
  children,
}: Props) {
  // Our own `/reservar` opens in place; only an external booking tool gets a
  // new tab.
  const external = /^https?:\/\//i.test(href);
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      onClick={() => trackBookingClick(location, extra)}
      className={className}
      style={style}
    >
      {children}
    </a>
  );
}
