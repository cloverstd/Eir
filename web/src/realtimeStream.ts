type Stream = {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener: (type: string, listener: () => void) => void;
  close: () => void;
};
type Options = {
  change: () => void;
  signals: () => void;
  status: (value: string) => void;
  create?: () => Stream;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
  now?: () => number;
};

// HTTP proxy errors can permanently close a browser EventSource. Recreate it
// explicitly, closing the old stream before scheduling a single replacement.
export function openRealtimeStream({
  change,
  signals,
  status,
  create = () => new EventSource("/api/v1/events/stream"),
  schedule = setTimeout,
  cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now = Date.now,
}: Options) {
  let source: Stream | undefined,
    timer: unknown,
    stopped = false,
    delay = 1000;
  let lastActivity = now();
  const connect = () => {
    if (stopped) return;
    timer = undefined;
    const stream = create();
    source = stream;
    lastActivity = now();
    const current = () => !stopped && source === stream;
    stream.addEventListener("change", () => {
      if (current()) {
        lastActivity = now();
        change();
      }
    });
    stream.addEventListener("signals", () => {
      if (current()) {
        lastActivity = now();
        signals();
      }
    });
    stream.onopen = () => {
      if (!current()) return;
      delay = 1000;
      lastActivity = now();
      status("connected");
      change();
      signals();
    };
    stream.onerror = () => {
      if (!current()) return;
      source = undefined;
      stream.close();
      status("reconnecting");
      timer = schedule(connect, delay);
      delay = Math.min(delay * 2, 15000);
    };
    stream.addEventListener("heartbeat", () => {
      if (current()) lastActivity = now();
    });
  };
  connect();
  return {
    isOpen: () => source?.readyState === 1,
    check: () => {
      if (source && now() - lastActivity > 45000)
        source.onerror?.(new Event("error"));
    },
    close: () => {
      stopped = true;
      if (timer !== undefined) cancel(timer);
      source?.close();
      source = undefined;
    },
  };
}
