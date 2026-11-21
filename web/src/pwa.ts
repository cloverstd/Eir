import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  prompt(): Promise<void>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });
}

function detectStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true
  );
}

function detectIOS() {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function usePWAInstall() {
  const [canPrompt, setCanPrompt] = useState(() => Boolean(deferredPrompt));
  const [isStandalone, setIsStandalone] = useState(() => detectStandalone());
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const sync = () => {
      setCanPrompt(Boolean(deferredPrompt));
      setIsStandalone(detectStandalone());
    };
    listeners.add(sync);
    const media = window.matchMedia("(display-mode: standalone)");
    media.addEventListener("change", sync);
    sync();
    return () => {
      listeners.delete(sync);
      media.removeEventListener("change", sync);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) return false;
    setInstalling(true);
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") {
        deferredPrompt = null;
        notify();
        return true;
      }
      return false;
    } finally {
      setInstalling(false);
    }
  }, []);

  return {
    canPrompt: canPrompt && !isStandalone,
    isStandalone,
    isIOS: detectIOS(),
    installing,
    install,
  };
}
