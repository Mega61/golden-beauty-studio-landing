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
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => trackBookingClick(location, extra)}
      className={className}
      style={style}
    >
      {children}
    </a>
  );
}
