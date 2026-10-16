/*
 * Service worker del panel. Se sirve en /admin/sw.js con alcance /admin/.
 *
 * Hace DOS cosas y nada más: mostrar el aviso de push y abrir el panel al
 * tocarlo.
 *
 * ## Por qué no hay manejador de `fetch` (ni caché, ni página offline)
 *
 * A propósito. El panel es la agenda y la caja del estudio en vivo: una
 * agenda servida de caché le muestra a recepción un hueco que ya se ocupó, y
 * una decisión tomada sobre eso es una clienta con dos citas a la misma hora.
 * Todo lo que el panel pinta es HTML autenticado o una respuesta de API, y
 * ninguna de las dos cosas puede salir de una caché del navegador.
 *
 * Sin manejador de `fetch`, el navegador va a la red exactamente como si este
 * archivo no existiera: no hay forma de que una regla de caché mal escrita
 * sirva datos viejos, porque no hay regla. Lo que se pierde es una página
 * propia de "sin conexión"; sin red se ve el error del navegador, que dice la
 * verdad. Chrome ya no exige `fetch` para instalar la app, y iOS nunca lo
 * exigió.
 *
 * Si algún día se agrega una página offline, tiene que ser un archivo
 * estático precacheado y servido SOLO para navegaciones que fallan por red —
 * nunca una respuesta cacheada de una ruta del panel.
 */

const BASE = "/admin";
const ICON = `${BASE}/icons/icon-192.png`;

self.addEventListener("install", () => {
  // Una versión nueva toma el control sin esperar a que se cierren todas las
  // pestañas: no hay caché que migrar, así que no hay nada que romper.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    // Un push que no es JSON no es nuestro. Igual hay que mostrar algo: iOS
    // y Chrome castigan un push "silencioso" revocando el permiso.
    data = { title: "Golden · Panel", body: event.data.text() };
  }

  const url = typeof data.url === "string" && data.url.startsWith(`${BASE}/`) ? data.url : `${BASE}/agenda`;

  event.waitUntil(
    self.registration.showNotification(data.title || "Golden · Panel", {
      body: data.body || "",
      icon: ICON,
      tag: data.tag || undefined,
      // Si llega otra con la misma etiqueta, que vuelva a sonar.
      renotify: Boolean(data.tag),
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || `${BASE}/agenda`, self.location.origin);

  event.waitUntil(
    (async () => {
      // Si el panel ya está abierto, se reutiliza esa ventana en vez de abrir
      // otra: en un celular, cada aviso tocado sería una pestaña más.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        const url = new URL(client.url);
        if (url.origin === target.origin && url.pathname.startsWith(`${BASE}/`)) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target.href);
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
