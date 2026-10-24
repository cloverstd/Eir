/// <reference lib="webworker" />
import {
  precacheAndRoute,
  createHandlerBoundToURL,
  cleanupOutdatedCaches,
} from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: import("workbox-precaching").PrecacheEntry[];
};
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//, /^\/mcp/, /^\/healthz/, /^\/readyz/],
  }),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});
self.addEventListener("push", (event) => {
  let payload: Record<string, string> = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    /* Show a visible fallback for malformed payloads. */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "Eir 健康通知", {
      body: payload.body || "有新的健康测量",
      tag: payload.tag || "eir-update",
      icon: "/icon-192.png",
      data: { url: payload.url || "/" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(
    event.notification.data?.url || "/",
    self.location.origin,
  );
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if ("navigate" in client) {
          await (client as WindowClient).navigate(url.href);
          await (client as WindowClient).focus();
          return;
        }
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
