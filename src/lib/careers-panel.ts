/**
 * Contract between the /bio hiring slide and the application form further down
 * the same page (`TrabajaBio`).
 *
 * Two mechanisms, because neither is sufficient alone:
 *
 * · The hash makes `…/es/bio#trabaja` a real, shareable destination — the link
 *   you paste into an Instagram story or a WhatsApp reply — and it survives a
 *   cold load, where no click ever happens.
 * · The event covers the in-page click. Clicking an anchor whose hash is
 *   already current fires no `hashchange`, so a visitor who collapses the form
 *   and taps the banner again would get nothing back.
 */
export const CAREERS_PANEL_ID = "trabaja";
export const CAREERS_PANEL_HASH = `#${CAREERS_PANEL_ID}`;
export const CAREERS_PANEL_EVENT = "gbs:careers-open";
