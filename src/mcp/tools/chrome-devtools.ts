import * as z from "zod";

export type ChromeDevtoolsOutput = {
  title?: string;
  url?: string;
  text?: string;
};

type ChromeDevtoolsInput = {
  selector?: string;
};

type ChromeDevtoolsOptions = {
  host: string;
  port: number;
};

const ChromeTargetSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  webSocketDebuggerUrl: z.string().optional()
});

const ChromeTargetsSchema = z.array(ChromeTargetSchema);

const buildBaseUrl = (host: string, port: number) => {
  if (!host) {
    throw new Error("CHROME_DEBUG_HOST is required to use browser-read");
  }
  if (host.startsWith("http://") || host.startsWith("https://")) {
    return `${host}:${port}`;
  }
  return `http://${host}:${port}`;
};

export const createChromeDevtoolsHandler = ({ host, port }: ChromeDevtoolsOptions) => {
  return async (input: ChromeDevtoolsInput): Promise<ChromeDevtoolsOutput> => {
    const baseUrl = buildBaseUrl(host, port);

    const response = await fetch(`${baseUrl}/json/list`);

    if (!response.ok) {
      throw new Error(`Chrome DevTools error: ${response.status}`);
    }

    const json = await response.json();
    const parsed = ChromeTargetsSchema.safeParse(json);

    if (!parsed.success) {
      throw new Error(`Chrome DevTools response validation failed: ${parsed.error.message}`);
    }

    if (input.selector) {
      const target = parsed.data.find((candidate) => candidate.webSocketDebuggerUrl);
      if (!target?.webSocketDebuggerUrl) {
        throw new Error("No Chrome targets available");
      }

      const text = await evaluateSelectorText(target.webSocketDebuggerUrl, input.selector);
      return { text };
    }

    const first = parsed.data.find((target) => target.url && target.title);
    if (!first) {
      throw new Error("No Chrome targets available");
    }

    return {
      title: first.title ?? "",
      url: first.url ?? ""
    };
  };
};

const evaluateSelectorText = async (webSocketUrl: string, selector: string): Promise<string> => {
  const WebSocketImpl = globalThis.WebSocket;
  if (!WebSocketImpl) {
    throw new Error("WebSocket is not available in this runtime");
  }

  const expression = `(() => { try { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) { return { missing: true }; } return { text: el.textContent ?? "" }; } catch (error) { return { error: String(error) }; } })()`;

  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(webSocketUrl);
    let isDone = false;
    let nextId = 1;
    const pending = new Map<number, (payload: Record<string, unknown>) => void>();

    const cleanup = (error?: Error, value?: string) => {
      if (isDone) {
        return;
      }
      isDone = true;
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
      try {
        socket.close();
      } catch {
        // ignore
      }
      if (error) {
        reject(error);
      } else {
        resolve(value ?? "");
      }
    };

    const handleOpen = async () => {
      try {
        const response = await sendCommand("Runtime.evaluate", {
          expression,
          returnByValue: true
        });

        const exception = response.result && typeof response.result === "object"
          ? (response.result as Record<string, unknown>).exceptionDetails
          : undefined;
        if (exception) {
          cleanup(new Error("Invalid selector"));
          return;
        }

        const result = response.result && typeof response.result === "object"
          ? (response.result as Record<string, unknown>).result
          : undefined;
        const value = result && typeof result === "object"
          ? (result as Record<string, unknown>).value
          : undefined;

        if (value && typeof value === "object") {
          const typedValue = value as Record<string, unknown>;
          if (typedValue.error) {
            cleanup(new Error("Invalid selector"));
            return;
          }
          if (typedValue.missing) {
            cleanup(new Error("selector not found"));
            return;
          }
          if (typeof typedValue.text === "string") {
            cleanup(undefined, typedValue.text);
            return;
          }
        }

        cleanup(new Error("selector not found"));
      } catch (error) {
        cleanup(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const handleMessage = (event: { data?: unknown }) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data ?? "");
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      const id = typeof payload.id === "number" ? payload.id : undefined;
      if (!id) {
        return;
      }

      const resolver = pending.get(id);
      if (!resolver || typeof resolver !== "function") {
        return;
      }
      pending.delete(id);
      resolver(payload);
    };

    const handleError = () => {
      cleanup(new Error("Chrome DevTools socket error"));
    };

    const handleClose = () => {
      if (!isDone) {
        cleanup(new Error("Chrome DevTools socket closed"));
      }
    };

    const sendCommand = (method: string, params: Record<string, unknown>) => {
      const id = nextId;
      nextId += 1;
      return new Promise<Record<string, unknown>>((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);
  });
};
