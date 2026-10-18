import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {fileURLToPath, URL} from "node:url";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const target = env.EIR_DEV_API || "http://localhost:8080";
  return {
    plugins: [react(), tailwindcss()],
    resolve: {alias: {"@": fileURLToPath(new URL("./src", import.meta.url))}},
    server: {
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (request, incoming) => {
              // The production server rejects cross-origin writes. Keep its
              // origin check intact while forwarding this local dev origin.
              if (
                incoming.headers.origin &&
                new URL(incoming.headers.origin).host === incoming.headers.host
              )
                request.setHeader("Origin", new URL(target).origin);
            });
          },
        },
      },
    },
  };
});
