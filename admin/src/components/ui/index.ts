/**
 * Superficie pública del kit de interfaz (WP-A3).
 *
 * Los paquetes de las olas C y D importan de acá: `import { Button, DataTable }
 * from "@/components/ui"`. Nada de este barril toca la red ni `server-only`, así
 * que se puede importar desde un Server Component o desde un componente
 * cliente sin pensarlo — los que necesitan estado (`Panel`, `Toast`, `Field`,
 * `MoneyInput`) traen su propio `"use client"`.
 *
 * Lo que NO está acá y hay que pedirle a otro paquete: cualquier cálculo de
 * plata (B1), el layout de la agenda (B3) y el cliente de EA (A1).
 */

export { Icon, type IconName, type IconProps } from "./Icon";
export { Button, ButtonLink, type ButtonProps, type ButtonVariant } from "./Button";
export { StatusPill } from "./StatusPill";
export {
  STATUS_IDS,
  STATUS_META,
  STATUS_HEX,
  isStatusId,
  normalizeStatusId,
  resolveStatus,
  type StatusId,
  type StatusMeta,
  type StatusToken,
} from "./status";
export {
  Field,
  TextInput,
  TextArea,
  Select,
  Checkbox,
  FormErrorSummary,
} from "./Field";
export { MoneyInput } from "./MoneyInput";
export { DataTable } from "./DataTable";
export {
  listShape,
  secondaryLine,
  visibleColumns,
  type Breakpoint,
  type Column,
  type ColumnFrom,
  type ListShape,
  type ListSlot,
} from "./table-model";
export { Panel, PanelInline } from "./Panel";
export {
  ToastProvider,
  useToast,
  type ToastInput,
  type ToastTone,
} from "./Toast";
export { Skeleton, SkeletonText, SkeletonStat, LoadingRegion } from "./Skeleton";
export { EmptyState } from "./EmptyState";
export { ReadOnlyBand } from "./ReadOnlyBand";
export { Card, CardHead } from "./Card";
export {
  formatCOP,
  formatPesos,
  parsePesos,
  formatHour12,
  formatTime,
  formatTimeRange,
  formatDateLong,
  formatDateShort,
  formatDuration,
  formatPhoneCO,
  parseWallClock,
} from "./format";
export { contrastRatio, relativeLuminance, CONTRAST_FLOOR } from "./contrast";
