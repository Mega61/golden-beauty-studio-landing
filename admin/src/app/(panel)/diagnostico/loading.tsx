import { ScreenSkeleton } from "@/components/shell";

/** Ver `components/shell/ScreenSkeleton.tsx`. */
export default function Loading() {
  return <ScreenSkeleton title="Diagnóstico" shape="stats" label="Cargando el diagnóstico…" />;
}
