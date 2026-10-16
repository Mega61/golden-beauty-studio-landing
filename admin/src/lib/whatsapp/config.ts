/**
 * La configuración de la Cloud API de WhatsApp (Meta), leída del entorno.
 *
 * ## Sin variables, la función no existe — no falla
 *
 * Mismo principio que `lib/push/config.ts`: hasta que la dueña termine el
 * trámite en Meta (verificación de negocio, Coexistence, plantillas aprobadas)
 * el stack no tiene `WHATSAPP_TOKEN` ni `WHATSAPP_PHONE_NUMBER_ID`, y entonces
 * `parseWhatsappEnv` devuelve `null`: la reserva no intenta mandar nada, el job
 * de recordatorios se queda quieto, y `/recordatorios` sigue siendo el canal
 * manual de siempre. Un despliegue sin el trámite hecho funciona exactamente
 * igual que antes de que esto existiera, sin un error en el log por reserva.
 *
 * El webhook de estado tiene sus propias dos variables (`WHATSAPP_APP_SECRET`,
 * `WHATSAPP_VERIFY_TOKEN`) y se valida aparte: se puede mandar sin recibir
 * estados —los mensajes salen igual— pero no se puede aceptar un POST sin
 * poder verificar su firma.
 *
 * Todo puro: entra el entorno, sale la configuración. Los secretos nunca entran
 * a un mensaje de error.
 */

export type WhatsappConfig = {
  /** Token permanente de un *System User*. Nunca se loguea. */
  token: string;
  /** El id del número en la Cloud API (no es el número de teléfono). */
  phoneNumberId: string;
  /** `v23.0`. Con la `v`, como la pide la URL de Graph. */
  graphVersion: string;
  /** Código de idioma de las plantillas, tal como se crearon en Meta. */
  templateLang: string;
  templates: {
    confirmacion: string;
    recordatorio: string;
  };
};

export type WhatsappWebhookConfig = {
  /** Secreto de la app de Meta: firma `X-Hub-Signature-256`. */
  appSecret: string;
  /** El texto que Meta repite en el `GET` de suscripción. */
  verifyToken: string;
  /** Si está, solo se procesan eventos de este número. */
  phoneNumberId: string | null;
};

/**
 * La versión de Graph por defecto. Meta mantiene cada versión unos dos años;
 * se fija acá y no se deja "la última" para que un cambio de Meta no cambie el
 * comportamiento del panel sin un commit.
 */
export const DEFAULT_GRAPH_VERSION = "v23.0";
export const DEFAULT_TEMPLATE_LANG = "es";
export const DEFAULT_TPL_CONFIRMACION = "confirmacion_cita";
export const DEFAULT_TPL_RECORDATORIO = "recordatorio_cita";

type Env = Record<string, string | undefined>;

const clean = (value: string | undefined): string => value?.trim() ?? "";

/** Nombre de plantilla de Meta: minúsculas, dígitos y guion bajo. */
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
/** `es`, `es_CO`, `es_MX`… */
const LANG = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const GRAPH_VERSION = /^v\d{1,3}\.\d$/;

/**
 * La configuración de envío, o `null` si la función está apagada.
 *
 * Se apaga con cualquier valor mal formado, no solo con los vacíos: un nombre
 * de plantilla con mayúsculas o un id con espacios no puede funcionar contra
 * Meta, y es mejor que la función no exista a que falle en cada reserva.
 */
export function parseWhatsappEnv(env: Env): WhatsappConfig | null {
  const token = clean(env.WHATSAPP_TOKEN);
  const phoneNumberId = clean(env.WHATSAPP_PHONE_NUMBER_ID);
  if (token === "" || /\s/.test(token)) return null;
  // El Phone Number ID es numérico. Un número de teléfono pegado acá por
  // error ("+57 300…") es el error más probable del alta, y no es un id.
  if (!/^\d{5,32}$/.test(phoneNumberId)) return null;

  const graphVersion = clean(env.WHATSAPP_GRAPH_VERSION) || DEFAULT_GRAPH_VERSION;
  const templateLang = clean(env.WHATSAPP_TEMPLATE_LANG) || DEFAULT_TEMPLATE_LANG;
  const confirmacion = clean(env.WHATSAPP_TPL_CONFIRMACION) || DEFAULT_TPL_CONFIRMACION;
  const recordatorio = clean(env.WHATSAPP_TPL_RECORDATORIO) || DEFAULT_TPL_RECORDATORIO;

  if (!GRAPH_VERSION.test(graphVersion)) return null;
  if (!LANG.test(templateLang)) return null;
  if (!TEMPLATE_NAME.test(confirmacion) || !TEMPLATE_NAME.test(recordatorio)) return null;

  return {
    token,
    phoneNumberId,
    graphVersion,
    templateLang,
    templates: { confirmacion, recordatorio },
  };
}

/** La configuración del webhook de estado, o `null` si falta alguno de los dos secretos. */
export function parseWhatsappWebhookEnv(env: Env): WhatsappWebhookConfig | null {
  const appSecret = clean(env.WHATSAPP_APP_SECRET);
  const verifyToken = clean(env.WHATSAPP_VERIFY_TOKEN);
  if (appSecret === "" || verifyToken === "") return null;
  const phoneNumberId = clean(env.WHATSAPP_PHONE_NUMBER_ID);
  return { appSecret, verifyToken, phoneNumberId: phoneNumberId === "" ? null : phoneNumberId };
}

/** ¿Está prendido el envío automático en este proceso? */
export function whatsappConfigured(env: Env = process.env): boolean {
  return parseWhatsappEnv(env) !== null;
}

/**
 * `+573001234567` → `+57•••••4567`. Para los logs.
 *
 * El teléfono completo de una clienta no va a un log que se pega en un chat
 * cuando algo falla. Los últimos cuatro bastan para cruzarlo con la ficha.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "•".repeat(digits.length);
  return `+${digits.slice(0, 2)}${"•".repeat(Math.max(0, digits.length - 6))}${digits.slice(-4)}`;
}
