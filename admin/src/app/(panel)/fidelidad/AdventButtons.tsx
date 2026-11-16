"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button, useConfirm, useToast } from "@/components/ui";

import { deshacerRegaloAdviento, marcarRegaloAdviento } from "./actions";

/**
 * "Marcar usado" / "Deshacer" de un regalo de Adviento. Lo usan Fidelidad y la
 * ficha; solo se dibuja para quien tiene `fidelidad:canjear` (la Action lo
 * vuelve a preguntar).
 */
export function AdventRedeemButton({
  code,
  customerName,
  title,
  note,
}: {
  code: string;
  customerName: string;
  title: string;
  /** "Adviento día N": lo que va en la cuenta. */
  note: string;
}) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function onClick() {
    const ok = await confirm({
      title: `¿Marcar como usado el regalo de ${customerName}?`,
      body:
        `${title} (${code}). Queda usado en Stampee y no se puede volver a usar. ` +
        `El descuento se pone al cerrar la cuenta: motivo promo, nota «${note}».`,
      confirmLabel: "Marcar usado",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await marcarRegaloAdviento(code);
      toast({ message: result.message, tone: result.ok ? "ok" : "error" });
      if (result.ok) router.refresh();
    });
  }

  return (
    <Button variant="primary" size="sm" icon="regalo" loading={pending} onClick={onClick}>
      Marcar usado
    </Button>
  );
}

export function AdventUndoButton({ code }: { code: string }) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function onClick() {
    const ok = await confirm({
      title: "¿Deshacer el uso del regalo?",
      body: `${code} vuelve a quedar por usar. Úsalo solo si se marcó por error.`,
      confirmLabel: "Deshacer",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await deshacerRegaloAdviento(code);
      toast({ message: result.message, tone: result.ok ? "ok" : "error" });
      if (result.ok) router.refresh();
    });
  }

  return (
    <Button variant="ghost" size="sm" icon="deshacer" loading={pending} onClick={onClick}>
      Deshacer
    </Button>
  );
}
