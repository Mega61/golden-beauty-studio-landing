/**
 * Los tipos de `<ViewTransition>` y de `addTransitionType`.
 *
 * El App Router corre con el React canary que trae Next (`next/dist/compiled/
 * react`), y ahí `ViewTransition` existe; `@types/react` lo declara solo en su
 * entrada `canary`. Con `experimental.viewTransition` en `next.config.ts`, Next
 * además dispara las transiciones al navegar.
 */
/// <reference types="react/canary" />
