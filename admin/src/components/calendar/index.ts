/**
 * Superficie pública de la grilla de calendario (WP-C1).
 *
 * Nada de acá toca la red ni `server-only`: son componentes de presentación y
 * funciones puras. Lo que sabe de EA vive en `app/(panel)/agenda/data.ts`, que
 * sí es de servidor.
 *
 * Lo que NO está y hay que pedirle a otro paquete: el layout (`buildDayGrid()`
 * de B3), la detección de choques (`checkConflicts()`, también B3) y el cliente
 * de EA (A1). Este paquete pinta lo que esos tres deciden.
 */

export { ResourceGrid } from "./ResourceGrid";
export type {
  MovePick,
  ResizePick,
  ResourceGridProps,
  SlotPick,
} from "./ResourceGrid";
export { ConflictReview } from "./ConflictReview";
export { DaySheet } from "./DaySheet";
export { RangeBar } from "./RangeBar";

export {
  addDays,
  datesFor,
  fetchWindow,
  isRangeMode,
  parseAnchor,
  parseRangeMode,
  RANGE_MODES,
  RANGE_MODE_DAYS,
  RANGE_MODE_LABEL,
  shiftAnchor,
  startOfWeek,
  touchesDates,
  visibleWindow,
  DEFAULT_DAY_START,
  DEFAULT_DAY_END,
  REVEAL_STEP_MINUTES,
  type FetchWindow,
  type RangeMode,
  type VisibleWindow,
} from "./range";

export {
  columnHeight,
  dragDeltaMinutes,
  laneBox,
  minuteToPx,
  pointerMinute,
  pxToMinute,
  snapMinute,
  spanBox,
  type Box,
  type LaneBox,
} from "./geometry";

export {
  eaStatusLabel,
  mapEaStatus,
  unmappedStatuses,
  EA_STATUS_MAP,
} from "./status-map";

export {
  NEUTRAL_TINT,
  parseHex,
  serviceTint,
  tintIsReadable,
  type ServiceTint,
} from "./service-color";

export type { AppointmentMeta, MetaIndex, ProviderOption, ServiceOption } from "./types";
