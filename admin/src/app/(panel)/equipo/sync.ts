/**
 * El estado de la sincronización con Google, en **solo lectura**.
 *
 * El sync es de un solo sentido y a propósito (§ Multi-técnica): un calendario
 * por técnica, todos propiedad de la cuenta de Workspace del estudio,
 * conectados a EA con esa misma cuenta y compartidos en solo lectura al correo
 * personal de cada una. EA es la fuente de verdad; Google es un espejo.
 *
 * **El token vive en EA, así que conectar y desconectar enlazan a EA.** El
 * panel no reconstruye ese flujo: sería reconstruir OAuth de otra aplicación
 * para poder romperlo desde dos lugares. Lo que sí hace es *mirar*, que es lo
 * que nadie hace hoy — y el push a Google **falla en silencio**: un
 * `id_google_calendar` vacío es la única señal.
 *
 * ## Una corrección al plan
 *
 * § Multi-técnica pide mostrar "sync activo sí/no, **qué calendario y desde
 * cuándo**". Los dos primeros salen; el tercero **no existe**: `api_encode()` de
 * EA emite `google_sync`, `google_token`, `google_calendar`, `sync_past_days` y
 * `sync_future_days`, y ninguna columna guarda cuándo se autorizó. El token es
 * un JSON de OAuth sin fecha de emisión legible desde acá. Antes que inventar
 * una fecha, la pantalla dice qué se sabe y qué no.
 *
 * ## El token nunca sale de acá
 *
 * `settings.googleToken` es la credencial. Este módulo la reduce a un booleano
 * y **no la reexporta**: lo que no está en el tipo de salida no puede terminar
 * en un payload de React, en un log ni en una captura de pantalla.
 */

import type { Provider } from "@/lib/ea";

export type GoogleSyncState =
  /** Marcado activo y con calendario elegido. Es el estado esperado. */
  | "activo"
  /** Activo pero sin calendario o sin token: el push no está llegando a ningún lado. */
  | "incompleto"
  /** Apagado. Puede ser deliberado (una técnica que no usa el espejo). */
  | "apagado";

export type GoogleSyncStatus = {
  state: GoogleSyncState;
  /** El id del calendario de Google. Es un correo o un id largo; se muestra tal cual. */
  calendarId: string | null;
  /** Si hay credencial guardada. **Nunca el valor.** */
  hasToken: boolean;
  /** Ventana que EA sincroniza, en días. `null` = EA usa su valor por defecto. */
  pastDays: number | null;
  futureDays: number | null;
  /** Qué mirar cuando el estado no es `activo`. Vacío si está todo bien. */
  problems: string[];
};

export function googleSyncStatus(provider: Provider): GoogleSyncStatus {
  const settings = provider.settings;
  const enabled = settings?.googleSync === true;
  const calendarId = normalize(settings?.googleCalendar);
  const hasToken = normalize(settings?.googleToken) !== null;

  const problems: string[] = [];
  if (enabled && !hasToken) {
    problems.push(
      "El sync está marcado activo pero no hay credencial de Google guardada. Hay que volver a autorizar desde EA.",
    );
  }
  if (enabled && calendarId === null) {
    problems.push(
      "No hay calendario elegido: las citas no se están espejando a ninguna parte.",
    );
  }

  const state: GoogleSyncState = !enabled
    ? "apagado"
    : problems.length > 0
      ? "incompleto"
      : "activo";

  return {
    state,
    calendarId,
    hasToken,
    pastDays: settings?.syncPastDays ?? null,
    futureDays: settings?.syncFutureDays ?? null,
    problems,
  };
}

/**
 * A dónde manda el enlace "Conectar / Cambiar en EA".
 *
 * `/index.php/google/oauth/{provider_id}` es la ruta del flujo de EA, y un
 * admin la puede correr por cualquier provider desde su propia sesión — que es
 * exactamente lo que hace posible que las N conexiones se hagan con la cuenta
 * del estudio y la técnica no toque EA ni autorice nada.
 *
 * Se arma sobre la **URL pública de EA**, no sobre `EA_API_URL`: esa apunta al
 * contenedor por la red de Docker (`http://golden-agenda/index.php/api/v1`) y
 * no se puede abrir desde el navegador de nadie.
 */
export function eaGoogleOauthUrl(
  eaBaseUrl: string,
  providerId: number,
): string {
  const base = eaBaseUrl.replace(/\/+$/, "");
  return `${base}/index.php/google/oauth/${providerId}`;
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
