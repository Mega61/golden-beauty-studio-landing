/**
 * Placeholder del andamiaje. La raíz real del panel es "Hoy" (dashboard del
 * día) y la entrega el paquete C2; hasta entonces esto solo confirma que la
 * app arranca detrás del basePath.
 */
export default function Page() {
  return (
    <main style={{ padding: "2rem", maxWidth: "40rem" }}>
      <h1 style={{ fontSize: "1.5rem", margin: 0 }}>
        Panel · Golden Beauty Studio
      </h1>
      <p style={{ color: "#5b4a3a" }}>
        Andamiaje (WP-0). Estado del servicio en{" "}
        <a href="/admin/api/health">/admin/api/health</a>.
      </p>
    </main>
  );
}
