"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./Button";
import { Icon, type IconName } from "./Icon";

/**
 * El botón que envía un `<form action={…}>` y sabe que está enviando.
 *
 * `useFormStatus` lee el estado del formulario que lo contiene: mientras la
 * Server Action corre, el botón muestra el spinner y no se deja apretar dos
 * veces. Entrar, salir y los dos botones de la entrada de desarrollo no tenían
 * nada: tocar "Cerrar sesión" en un celular lento era tocar y esperar sin
 * saber si el toque se oyó.
 */
export function SubmitButton(props: Omit<ButtonProps, "type" | "loading">) {
  const { pending } = useFormStatus();
  return <Button {...props} type="submit" loading={pending} />;
}

/**
 * El ícono de una fila que envía un formulario ("Cerrar sesión" en el menú),
 * que se vuelve spinner mientras se envía. La fila no es un botón del kit, así
 * que no tiene `loading`; esto le da lo mismo sin cambiarle la forma.
 */
export function FormPendingIcon({
  name,
  size = 20,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const { pending } = useFormStatus();
  if (pending) {
    return (
      <span
        className={`ui-spinner${className ? ` ${className}` : ""}`}
        style={{ width: size * 0.8, height: size * 0.8, margin: size * 0.1, flex: "none" }}
        aria-label="Enviando"
      />
    );
  }
  return <Icon name={name} size={size} className={className} style={{ flex: "none" }} />;
}
