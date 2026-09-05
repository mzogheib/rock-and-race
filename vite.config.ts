import { defineConfig } from "vite";
import fs from "fs";

// If deploying to https://<user>.github.io/<repo>/, set base to '/<repo>/'.
// If deploying to a user/org root page (https://<user>.github.io/), leave it as '/'.
export default defineConfig(({ command }) => {
  const base = { base: "./" };

  // Local HTTPS (for testing camera access from a phone over LAN/hotspot) is
  // dev-only. It never runs during `vite build`, and it's skipped even in
  // dev if the cert files aren't present locally — so this is safe to keep
  // committed without breaking CI or a fresh clone.
  if (command === "serve") {
    const keyPath = "./certs/192.168.1.107+1-key.pem";
    const certPath = "./certs/192.168.1.107+1.pem";
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return {
        ...base,
        server: {
          host: true,
          https: {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
          },
        },
      };
    } else {
      console.warn(
        "HTTPS cert files not found. Serving over HTTP. Camera access may be blocked on some devices.",
      );
    }
  }

  return base;
});
