import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { openRealtimeStream } from "./realtimeStream";

const Context = createContext({
  version: 0,
  signalsVersion: 0,
  status: "connecting",
});
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0),
    [signalsVersion, setSignalsVersion] = useState(0);
  const [status, setStatus] = useState("connecting");
  useEffect(() => {
    let changeTimer: ReturnType<typeof setTimeout> | undefined;
    let signalTimer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== "hidden";
    const change = () => {
      if (!visible() || changeTimer) return;
      changeTimer = setTimeout(() => {
        changeTimer = undefined;
        setVersion((v) => v + 1);
      }, 500);
    };
    const signals = () => {
      if (!visible() || signalTimer) return;
      signalTimer = setTimeout(() => {
        signalTimer = undefined;
        setSignalsVersion((v) => v + 1);
      }, 300);
    };
    const stream = openRealtimeStream({ change, signals, status: setStatus });
    const resume = () => {
      if (visible()) {
        change();
        signals();
      }
    };
    document.addEventListener("visibilitychange", resume);
    const fallback = setInterval(() => {
      if (!stream.isOpen()) resume();
    }, 30000);
    const watchdog = setInterval(() => stream.check(), 5000);
    return () => {
      stream.close();
      clearTimeout(changeTimer);
      clearTimeout(signalTimer);
      clearInterval(fallback);
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  return (
    <Context.Provider value={{ version, signalsVersion, status }}>
      {children}
    </Context.Provider>
  );
}
export const useRealtime = () => useContext(Context);

// A resource keeps its last successful value during refresh failures. Query
// changes hide the old member's data immediately and abort obsolete requests.
export function useResource<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  initial: T,
  revision = 0,
) {
  const loader = useRef(load);
  loader.current = load;
  const { version } = useRealtime();
  const refresh = useRef<(() => void) | null>(null);
  const lastRefresh = useRef({ key, version, revision });
  const [state, setState] = useState({
    key,
    data: initial,
    error: "",
    loading: !!key,
    loaded: false,
  });
  useEffect(() => {
    if (!key) {
      refresh.current = null;
      return;
    }
    const controller = new AbortController();
    let inflight = false,
      again = false;
    const update = async () => {
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      setState((old) => ({
        key,
        data: old.key === key ? old.data : initial,
        error: old.key === key ? old.error : "",
        loading: true,
        loaded: old.key === key && old.loaded,
      }));
      try {
        const data = await loader.current(controller.signal);
        if (!controller.signal.aborted)
          setState({ key, data, error: "", loading: false, loaded: true });
      } catch (error) {
        if (!controller.signal.aborted)
          setState((old) => ({
            ...old,
            error: String((error as Error).message || error),
            loading: false,
          }));
      } finally {
        inflight = false;
        if (again && !controller.signal.aborted) {
          again = false;
          void update();
        }
      }
    };
    refresh.current = () => void update();
    void update();
    return () => {
      controller.abort();
      refresh.current = null;
    };
    // initial is the reset value, not a fetch dependency.
  }, [key]);
  useEffect(() => {
    const previous = lastRefresh.current;
    lastRefresh.current = { key, version, revision };
    if (
      previous.key === key &&
      (previous.version !== version || previous.revision !== revision)
    )
      refresh.current?.();
  }, [key, version, revision]);
  return state.key === key
    ? state
    : { key, data: initial, error: "", loading: !!key, loaded: false };
}
export function useAPI<T>(path: string | null, initial: T, revision = 0) {
  return useResource<T>(
    path,
    (signal) => api(path!, "GET", undefined, signal),
    initial,
    revision,
  );
}
