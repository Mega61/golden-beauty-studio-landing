"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button, useToast } from "@/components/ui";

import { openWhatsappAfter } from "../recordatorios/open-whatsapp";
import { enviarTarjeta } from "./actions";

/**
 * "Enviar tarjeta": abre WhatsApp con el link de la tarjeta de sellos de la
 * clienta y anota que se le mandó. Lo usan Fidelidad, la ficha y Hoy; solo se
 * dibuja para quien tiene `fidelidad:ver` (la Action lo vuelve a preguntar).
 *
 * La pestaña se abre en el mismo toque (`openWhatsappAfter`): el link llega
 * después de anotar el envío, y Safari bloquea un `window.open` tardío.
 */
export function ShareCardButton({
  cardId,
  sent,
  size = "sm",
  block = false,
}: {
  cardId: string;
  /** Ya se le mandó: el botón pasa a "Reenviar" y deja de llamar la atención. */
  sent: boolean;
  size?: "sm" | "md";
  block?: boolean;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick() {
    const opening = openWhatsappAfter(() => enviarTarjeta(cardId));
    startTransition(async () => {
      try {
        const { result, opened } = await opening;
        if (!result.ok) {
          toast({ message: result.message, tone: "error" });
          return;
        }
        if (!opened) {
          toast({ message: "El navegador no dejó abrir WhatsApp. Toca de nuevo.", tone: "error" });
        }
        router.refresh();
      } catch {
        toast({ message: "No se pudo preparar el mensaje. Intenta de nuevo.", tone: "error" });
      }
    });
  }

  return (
    <Button
      variant={sent ? "ghost" : "primary"}
      size={size}
      block={block}
      icon="whatsapp"
      loading={pending}
      onClick={onClick}
    >
      {sent ? "Reenviar tarjeta" : "Enviar tarjeta"}
    </Button>
  );
}
