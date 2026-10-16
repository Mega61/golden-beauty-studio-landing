/**
 * Cuándo ofrecer "Instalar en tu celular", como función pura.
 *
 * Separada del componente porque son cuatro señales del navegador que se
 * combinan mal fácilmente, y cada combinación equivocada tiene un costo
 * visible: el aviso en el computador del mostrador (ruido), el aviso dentro
 * de la app ya instalada (absurdo), o el aviso de Android en un iPhone, que
 * promete un botón que Safari no tiene.
 */

export type InstallHintMode = "ios" | "android" | null;

export type InstallSignals = {
  userAgent: string;
  /** `navigator.maxTouchPoints`. Delata al iPad que se hace pasar por Mac. */
  maxTouchPoints: number;
  /** `display-mode: standalone` o `navigator.standalone` de iOS. */
  standalone: boolean;
  /** Pantalla angosta y dedo como puntero. */
  mobile: boolean;
  /** Ya lo cerró una vez, o ya instaló. Se guarda en `localStorage`. */
  dismissed: boolean;
  /** Chrome/Android disparó `beforeinstallprompt` y lo tenemos guardado. */
  hasPrompt: boolean;
};

/**
 * iPhone, iPod, o un iPad. Desde iPadOS 13 Safari se anuncia como Mac de
 * escritorio; lo único que lo delata es la pantalla táctil.
 */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

/**
 * - Instalada o ya cerrada: nunca.
 * - iOS: siempre que sea celular o tablet — Safari no tiene evento de
 *   instalación, así que el aviso son instrucciones (Compartir → Agregar a
 *   inicio). Y es el único camino a los avisos de push en iPhone: iOS solo
 *   los permite en la app instalada.
 * - Android: solo si el navegador ofreció instalar (`beforeinstallprompt`) y
 *   la pantalla es de celular. Sin ese evento no hay botón que funcione.
 */
export function installHintMode(s: InstallSignals): InstallHintMode {
  if (s.standalone || s.dismissed) return null;
  if (isIos(s.userAgent, s.maxTouchPoints)) return "ios";
  if (s.hasPrompt && s.mobile) return "android";
  return null;
}

/** La llave en `localStorage`. Un solo valor: `"1"` = no volver a mostrar. */
export const INSTALL_HINT_KEY = "gbs:pwa-install-hint";
