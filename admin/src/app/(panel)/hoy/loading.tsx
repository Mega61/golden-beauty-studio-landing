import { ScreenSkeleton } from "@/components/shell";

/** Ver `components/shell/ScreenSkeleton.tsx`. */
export default function Loading() {
  return <ScreenSkeleton title="Hoy" shape="cards" label="Cargando las citas de hoy…" />;
}
