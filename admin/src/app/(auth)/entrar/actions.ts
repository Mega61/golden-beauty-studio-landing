"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAuth, LOGIN_PATH, panelUrl } from "@/lib/auth";

/**
 * Las dos entradas y la salida, como Server Actions.
 *
 * Todas pasan por `auth.api.*`, no por un cliente de Better Auth en el
 * navegador: el panel no carga ningún SDK de auth al cliente. Lo que hace que
 * funcione es el plugin `nextCookies()` (ver `lib/auth.ts`), cuyo hook `after`
 * copia los `Set-Cookie` del endpoint al almacén de cookies de Next.
 */

/** Dónde aterriza quien entra: "Hoy", la raíz del panel. */
const HOME_PATH = "/";

export type TotpFormState = { error: string | null };

/**
 * Entrada por Workspace.
 *
 * `disableRedirect: true` porque el redirect lo hace Next, no un header de la
 * respuesta del endpoint: una Server Action no devuelve una respuesta HTTP que
 * el navegador siga.
 */
export async function entrarConWorkspace(): Promise<never> {
  const result = await getAuth().api.signInSocial({
    body: {
      provider: "google",
      callbackURL: panelUrl(HOME_PATH),
      errorCallbackURL: panelUrl(LOGIN_PATH),
      disableRedirect: true,
    },
    headers: await headers(),
  });

  if (!result.url) {
    // No debería pasar nunca con `disableRedirect`; si pasa, es configuración
    // rota y la persona tiene que verlo, no quedarse mirando un botón.
    redirect(`${LOGIN_PATH}?error=configuracion`);
  }
  redirect(result.url);
}

/**
 * Entrada por TOTP.
 *
 * El mensaje que vuelve es siempre uno de dos: "código inválido" o "cuenta
 * bloqueada". Nada distingue una cuenta sin enrolar de un código equivocado — la
 * grilla ya muestra los nombres, pero eso no es razón para además confirmar
 * quién está enrolada.
 */
export async function entrarConCodigo(
  _prev: TotpFormState,
  formData: FormData,
): Promise<TotpFormState> {
  const userId = String(formData.get("userId") ?? "");
  const code = String(formData.get("code") ?? "");

  if (!userId) return { error: "Elegí tu nombre antes de escribir el código." };

  try {
    await getAuth().api.signInTotp({
      body: { userId, code },
      headers: await headers(),
    });
  } catch (error) {
    return { error: mensajeDeError(error) };
  }

  // Fuera del `try`: `redirect()` funciona lanzando, y atraparlo acá lo
  // convertiría en "código inválido" justo cuando el código era correcto. Es el
  // error más fácil de cometer con Server Actions.
  redirect(HOME_PATH);
}

/** Cerrar sesión. Revoca la fila de `session` y borra la cookie. */
export async function salir(): Promise<never> {
  await getAuth().api.signOut({ headers: await headers() });
  redirect(LOGIN_PATH);
}

/**
 * El texto que ve la técnica.
 *
 * Better Auth devuelve un `APIError` cuyo cuerpo lleva el `code` y el `message`
 * que puso el endpoint. Se lee sin `instanceof` para no acoplar la pantalla a la
 * clase de error de la librería, y con un texto por defecto para que un fallo
 * inesperado no muestre un objeto vacío.
 */
function mensajeDeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "body" in error) {
    const body = (error as { body?: { message?: unknown } }).body;
    if (body && typeof body.message === "string") return body.message;
  }
  return "No pudimos verificar el código. Volvé a intentar.";
}
