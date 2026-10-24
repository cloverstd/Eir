import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const target = env.EIR_DEV_API || "http://localhost:8080";
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        registerType: "prompt",
        injectRegister: false,
        manifest: {
          id: "/",
          name: "Eir · 家庭健康",
          short_name: "Eir",
          start_url: "/",
          scope: "/",
          display: "standalone",
          theme_color: "#0c6657",
          background_color: "#ffffff",
          icons: [
            {
              src: "/icon-anime-v1-192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/icon-anime-v1-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any maskable",
            },
          ],
        },
        injectManifest: {
          globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
          globIgnores: ["**/icon-1024.png"],
          maximumFileSizeToCacheInBytes: 5000000,
        },
      }),
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
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
