import { ScreenSkeleton } from "@/components/shell";

/** Ver `components/shell/ScreenSkeleton.tsx`. */
export default function Loading() {
  return <ScreenSkeleton title="Clientes" shape="list" label="Cargando la lista de clientes…" />;
}
