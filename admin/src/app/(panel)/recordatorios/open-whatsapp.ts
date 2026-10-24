"use client";

/**
 * Abrir WhatsApp con un enlace que llega **después** de un `await`.
 *
 * El enlace sale del servidor después de registrar el mensaje, y un
 * `window.open` hecho después de un `await` ya no cuenta como gesto de quien
 * tocó: Safari en iPhone lo bloquea en silencio. Así que la pestaña se abre
 * vacía en el mismo toque y se le pone la dirección cuando llega. Se corta el
 * `opener` para que la pestaña de WhatsApp no tenga una referencia al panel.
 *
 * Tiene que llamarse **sincrónicamente** dentro del manejador del clic.
 */
export type SendOutcome =
  | { ok: true; url: string; already: boolean; sentLabel: string }
  | { ok: false; message: string };

export async function openWhatsappAfter(
  send: () => Promise<SendOutcome>,
): Promise<{ result: SendOutcome; opened: boolean }> {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;

  try {
    const result = await send();
    if (!result.ok) {
      tab?.close();
      return { result, opened: false };
    }
    if (tab) tab.location.href = result.url;
    return { result, opened: tab !== null };
  } catch (error) {
    tab?.close();
    throw error;
  }
}
