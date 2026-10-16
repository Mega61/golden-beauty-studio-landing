/**
 * La configuración de Web Push, y la ruta del panel que el navegador ve.
 *
 * ## Sin las llaves, la función no existe — no falla
 *
 * `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` son opcionales a
 * propósito. Sin las tres (o con alguna mal formada) `parseVapidEnv` devuelve
 * `null`, Ajustes no dibuja el interruptor y una reserva web no intenta
 * mandar nada. Un despliegue que todavía no tiene llaves funciona igual que
 * antes de que esto existiera, sin un error en el log por cada reserva.
 *
 * ## Por qué la llave pública no es `NEXT_PUBLIC_*`
 *
 * El navegador la necesita para suscribirse, y la guía de Next la pone en
 * `NEXT_PUBLIC_VAPID_PUBLIC_KEY`. Acá no: esas variables se hornean en el
 * build, y la imagen del panel se construye una vez en CI y corre con las
 * variables del stack de Portainer (ver `docs/DEV-LOCAL.md`, "ninguna variable
 * `NEXT_PUBLIC_*` en `admin/`"). La pantalla de Ajustes es un Server Component
 * que la lee en tiempo de ejecución y se la pasa al cliente como prop.
 */

export type VapidConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

/**
 * El `basePath` de `next.config.ts`, para lo que Next **no** prefija solo: el
 * contenido del manifest, el registro del service worker y el enlace que lleva
 * un aviso. Un test compara esta constante con la config real.
 */
export const PANEL_BASE_PATH = "/admin";

/** base64url sin relleno, que es como `web-push` genera las llaves. */
const B64URL = /^[A-Za-z0-9_-]+$/;

export function parseVapidEnv(env: Record<string, string | undefined>): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = env.VAPID_SUBJECT?.trim() ?? "";

  // Llave pública: punto P-256 sin comprimir, 65 bytes → 87 caracteres.
  // Privada: 32 bytes → 43. Se valida la forma para que una llave pegada con
  // comillas o cortada apague la función en vez de lanzar en cada reserva.
  if (!B64URL.test(publicKey) || publicKey.length !== 87) return null;
  if (!B64URL.test(privateKey) || privateKey.length !== 43) return null;
  // El servicio de push exige un contacto; Apple rechaza lo que no sea
  // `mailto:` o `https:`.
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) return null;

  return { publicKey, privateKey, subject };
}
