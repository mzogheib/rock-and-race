import { defineConfig } from "vite";
import fs from "fs";

// TODO: parametrise the IP address

// If deploying to https://<user>.github.io/<repo>/, set base to '/<repo>/'.
// If deploying to a user/org root page (https://<user>.github.io/), leave it as '/'.
export default defineConfig({
  base: "./",
  server: {
    host: true,
    https: {
      key: fs.readFileSync("./certs/192.168.1.107+1-key.pem"),
      cert: fs.readFileSync("./certs/192.168.1.107+1.pem"),
    },
  },
});
