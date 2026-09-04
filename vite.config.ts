import { defineConfig } from "vite";

// If deploying to https://<user>.github.io/<repo>/, set base to '/<repo>/'.
// If deploying to a user/org root page (https://<user>.github.io/), leave it as '/'.
export default defineConfig({
  base: "./",
});
