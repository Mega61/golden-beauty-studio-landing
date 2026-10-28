"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button, useConfirm, useToast } from "@/components/ui";

import { aplicarPremio } from "./actions";

/**
 * "Aplicar premio" con confirmación. Lo usan Fidelidad y la ficha de la
 * clienta; solo se dibuja para quien tiene `fidelidad:canjear` (la Action lo
 * vuelve a preguntar).
 */
export function RedeemButton({
  cardId,
  customerName,
  rewardName,
  size = "sm",
}: {
  cardId: string;
  customerName: string;
  rewardName: string;
  size?: "sm" | "md";
}) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function onClick() {
    const ok = await confirm({
      title: `¿Aplicar el premio de ${customerName}?`,
      body:
        `${rewardName ? `${rewardName}. ` : ""}La tarjeta queda cerrada en Stampee y no se puede volver a usar. ` +
        "El descuento se pone al cerrar la cuenta, como siempre.",
      confirmLabel: "Aplicar premio",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await aplicarPremio(cardId);
      toast({ message: result.message, tone: result.ok ? "ok" : "error" });
      if (result.ok) router.refresh();
    });
  }

  return (
    <Button variant="primary" size={size} icon="regalo" loading={pending} onClick={onClick}>
      Aplicar premio
    </Button>
  );
}
