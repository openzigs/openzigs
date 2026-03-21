import * as z from "zod";
import { ensureChromeRunning } from "../../browser/chrome-launcher.js";
import { COMBINED_STEALTH_SCRIPT } from "../../browser/stealth.js";
import { SECRET_TOKEN_PATTERN } from "../../vault/vault-types.js";
import type { SecretVaultService } from "../../vault/index.js";

export type BrowserNavigateAction =
  | "navigate"
  | "click"
  | "type"
  | "screenshot"
  | "get-text"
  | "list-tabs"
  | "evaluate"
  | "snapshot-dom";

export type BrowserNavigateOutput = {
  success: boolean;
  title?: string;
  url?: string;
  text?: string;
  tabs?: Array<{ title: string; url: string }>;
  screenshot?: string;
};

export type BrowserNavigateInput = {
  action: BrowserNavigateAction;
  url?: string;
  selector?: string;
  text?: string;
  expression?: string;
};

type BrowserNavigateOptions = {
  host: string;
  port: number;
  /** Optional vault service for resolving {{SECRET:uuid}} tokens in type actions. */
  vaultService?: SecretVaultService;
};

const ChromeTargetSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  type: z.string().optional(),
  webSocketDebuggerUrl: z.string().optional()
});

const ChromeTargetsSchema = z.array(ChromeTargetSchema);

const buildBaseUrl = (host: string, port: number) => {
  if (!host) {
    throw new Error("CHROME_DEBUG_HOST is required to use browser-navigate");
  }
  if (host.startsWith("http://") || host.startsWith("https://")) {
    return `${host}:${port}`;
  }
  return `http://${host}:${port}`;
};

const sendCdpCommand = (
  socket: InstanceType<typeof WebSocket>,
  pending: Map<number, (payload: Record<string, unknown>) => void>,
  idRef: { current: number },
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> => {
  const id = idRef.current;
  idRef.current += 1;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
};

const connectToTarget = (
  wsUrl: string
): Promise<{
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
  waitForEvent: (method: string, timeout?: number) => Promise<Record<string, unknown>>;
}> => {
  const WebSocketImpl = globalThis.WebSocket;
  if (!WebSocketImpl) {
    throw new Error("WebSocket is not available in this runtime");
  }

  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(wsUrl);
    const pending = new Map<number, (payload: Record<string, unknown>) => void>();
    const eventListeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();
    const idRef = { current: 1 };

    const handleMessage = (event: { data?: unknown }) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data ?? "");
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      const id = typeof payload.id === "number" ? payload.id : undefined;
      if (id) {
        const resolver = pending.get(id);
        if (resolver) {
          pending.delete(id);
          resolver(payload);
        }
        return;
      }

      // CDP event
      const method = typeof payload.method === "string" ? payload.method : undefined;
      if (method) {
        const listeners = eventListeners.get(method);
        if (listeners) {
          const params = (payload.params ?? {}) as Record<string, unknown>;
          for (const listener of listeners) {
            listener(params);
          }
        }
      }
    };

    socket.addEventListener("message", handleMessage);
    socket.addEventListener("error", () => reject(new Error("Chrome DevTools socket error")));
    socket.addEventListener("open", () => {
      resolve({
        send: (method, params) => sendCdpCommand(socket, pending, idRef, method, params ?? {}),
        close: () => {
          try { socket.close(); } catch { /* ignore */ }
        },
        waitForEvent: (method, timeout = 10000) => {
          return new Promise<Record<string, unknown>>((eventResolve, eventReject) => {
            const timer = setTimeout(() => {
              eventReject(new Error(`Timed out waiting for CDP event: ${method}`));
            }, timeout);

            const listeners = eventListeners.get(method) ?? [];
            const handler = (params: Record<string, unknown>) => {
              clearTimeout(timer);
              const remaining = eventListeners.get(method) ?? [];
              eventListeners.set(method, remaining.filter((l) => l !== handler));
              eventResolve(params);
            };
            listeners.push(handler);
            eventListeners.set(method, listeners);
          });
        }
      });
    });
  });
};

const getFirstTarget = async (baseUrl: string) => {
  const response = await fetch(`${baseUrl}/json/list`);
  if (!response.ok) {
    throw new Error(`Chrome DevTools error: ${response.status}`);
  }
  const json = await response.json();
  const parsed = ChromeTargetsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("Chrome DevTools response validation failed");
  }
  const target = parsed.data.find(
    (t) => t.type === "page" && t.webSocketDebuggerUrl
  );
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("No page targets available in Chrome");
  }
  return target;
};

export const createBrowserNavigateHandler = ({ host, port, vaultService }: BrowserNavigateOptions) => {
  return async (input: BrowserNavigateInput): Promise<BrowserNavigateOutput> => {
    const baseUrl = buildBaseUrl(host, port);

    // Auto-relaunch Chrome if it crashed or was closed
    await ensureChromeRunning({ host, port });

    // ── Validate required fields upfront ──
    if (input.action === "navigate" && !input.url) {
      throw new Error("url is required for navigate action");
    }
    if ((input.action === "click" || input.action === "type" || input.action === "get-text") && !input.selector) {
      throw new Error("selector is required for " + input.action + " action");
    }
    if (input.action === "type" && !input.text) {
      throw new Error("text is required for type action");
    }
    if (input.action === "evaluate" && !input.expression) {
      throw new Error("expression is required for evaluate action");
    }

    // ── list-tabs: no WebSocket needed ──
    if (input.action === "list-tabs") {
      const response = await fetch(`${baseUrl}/json/list`);
      if (!response.ok) {
        throw new Error(`Chrome DevTools error: ${response.status}`);
      }
      const json = await response.json();
      const parsed = ChromeTargetsSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error("Chrome DevTools response validation failed");
      }
      const tabs = parsed.data
        .filter((t) => t.type === "page")
        .map((t) => ({ title: t.title ?? "", url: t.url ?? "" }));
      return { success: true, tabs };
    }

    const target = await getFirstTarget(baseUrl);
    const cdp = await connectToTarget(target.webSocketDebuggerUrl!);

    try {
      switch (input.action) {
        case "navigate": {
          await cdp.send("Page.enable");
          // Inject anti-bot stealth scripts into every new document context
          await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
            source: COMBINED_STEALTH_SCRIPT,
          });
          // Wait for either loadEventFired (traditional pages) or
          // frameStoppedLoading (SPAs that never fire load). Use a race
          // so we don't hang for 30s on sites that skip the load event.
          const loadPromise = Promise.race([
            cdp.waitForEvent("Page.loadEventFired", 15000),
            cdp.waitForEvent("Page.frameStoppedLoading", 15000),
          ]).catch(() => {
            // Neither event fired within 15s — page is likely an SPA
            // that loaded via JS. Continue anyway.
          });
          await cdp.send("Page.navigate", { url: input.url });
          await loadPromise;
          // Get the final page title and URL
          const titleResult = await cdp.send("Runtime.evaluate", {
            expression: "JSON.stringify({ title: document.title, url: location.href })",
            returnByValue: true
          });
          const titleValue = extractValue(titleResult);
          const pageInfo = typeof titleValue === "string" ? JSON.parse(titleValue) as { title: string; url: string } : { title: "", url: input.url };
          return { success: true, title: pageInfo.title, url: pageInfo.url };
        }

        case "click": {
          // Simulate human-like mouse movement to the element before clicking.
          // Anti-bot systems detect instant teleporting clicks.
          const clickExpr = `(() => {
            const el = document.querySelector(${JSON.stringify(input.selector)});
            if (!el) return { error: "Element not found" };
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          })()`;
          const clickResult = await cdp.send("Runtime.evaluate", {
            expression: clickExpr,
            returnByValue: true
          });
          const clickValue = extractObjectValue(clickResult);
          if (clickValue && typeof clickValue === "object" && (clickValue as Record<string, unknown>).error) {
            throw new Error(String((clickValue as Record<string, unknown>).error));
          }
          const cx = Number((clickValue as Record<string, unknown>).x ?? 0);
          const cy = Number((clickValue as Record<string, unknown>).y ?? 0);

          // Simulate realistic mouse movement using multiple steps
          const steps = 8 + Math.floor(Math.random() * 8);
          // Start from a pseudo-random point on screen
          const fromX = 100 + Math.random() * 400;
          const fromY = 100 + Math.random() * 300;
          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            // Ease-in-out curve for natural deceleration
            const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
            const mx = fromX + (cx - fromX) * ease + (Math.random() - 0.5) * 4;
            const my = fromY + (cy - fromY) * ease + (Math.random() - 0.5) * 4;
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseMoved", x: mx, y: my, button: "none"
            });
            // Small random delay between movements (5-25ms)
            await new Promise(r => setTimeout(r, 5 + Math.random() * 20));
          }

          // Brief hover pause before clicking (50-150ms)
          await new Promise(r => setTimeout(r, 50 + Math.random() * 100));

          await cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1
          });
          // Human click duration (40-120ms between press and release)
          await new Promise(r => setTimeout(r, 40 + Math.random() * 80));
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1
          });
          return { success: true, text: `Clicked ${input.selector}` };
        }

        case "type": {
          // Focus the element
          const focusExpr = `(() => {
            const el = document.querySelector(${JSON.stringify(input.selector)});
            if (!el) return { error: "Element not found" };
            el.focus();
            if (el.value !== undefined) el.value = "";
            return { focused: true };
          })()`;
          const focusResult = await cdp.send("Runtime.evaluate", {
            expression: focusExpr,
            returnByValue: true
          });
          const focusValue = extractObjectValue(focusResult);
          if (focusValue && typeof focusValue === "object" && (focusValue as Record<string, unknown>).error) {
            throw new Error(String((focusValue as Record<string, unknown>).error));
          }

          // Resolve {{SECRET:uuid}} tokens to plaintext at the last possible moment.
          // The tokenised text flows through hooks/audit safely; plaintext only
          // materialises here, inside the browser handler, right before key dispatch.
          let resolvedText = input.text || "";
          if (vaultService && SECRET_TOKEN_PATTERN.test(resolvedText)) {
            SECRET_TOKEN_PATTERN.lastIndex = 0;
            resolvedText = resolvedText.replace(SECRET_TOKEN_PATTERN, (_match, uuid: string) => {
              const plaintext = vaultService.resolveToken(uuid);
              if (!plaintext) {
                throw new Error(`Secret ${uuid} not found in vault (is the vault unlocked?)`);
              }
              return plaintext;
            });
          }

          // Type each character via Input.dispatchKeyEvent with human-like delays
          for (const char of resolvedText) {
            await cdp.send("Input.dispatchKeyEvent", {
              type: "keyDown",
              text: char,
              unmodifiedText: char
            });
            await cdp.send("Input.dispatchKeyEvent", {
              type: "keyUp",
              text: char,
              unmodifiedText: char
            });
            // Human typing cadence: 30-120ms per character with occasional pauses
            const delay = Math.random() < 0.1
              ? 150 + Math.random() * 200  // 10% chance of a longer "thinking" pause
              : 30 + Math.random() * 90;
            await new Promise(r => setTimeout(r, delay));
          }
          return { success: true, text: `Typed into ${input.selector}` };
        }

        case "get-text": {
          const textExpr = `(() => {
            const el = document.querySelector(${JSON.stringify(input.selector)});
            if (!el) return { error: "Element not found" };
            return { text: el.textContent ?? "" };
          })()`;
          const textResult = await cdp.send("Runtime.evaluate", {
            expression: textExpr,
            returnByValue: true
          });
          const textValue = extractObjectValue(textResult);
          if (textValue && typeof textValue === "object" && (textValue as Record<string, unknown>).error) {
            throw new Error(String((textValue as Record<string, unknown>).error));
          }
          const text = textValue && typeof textValue === "object"
            ? String((textValue as Record<string, unknown>).text ?? "")
            : "";
          return { success: true, text };
        }

        case "screenshot": {
          const screenshotResult = await cdp.send("Page.captureScreenshot", {
            format: "png"
          });
          const data = screenshotResult.result && typeof screenshotResult.result === "object"
            ? (screenshotResult.result as Record<string, unknown>).data
            : undefined;
          const base64 = typeof data === "string"
            ? data
            : typeof screenshotResult.data === "string"
              ? screenshotResult.data as string
              : "";
          return { success: true, screenshot: base64 ? `data:image/png;base64,${base64}` : "" };
        }

        case "evaluate": {
          const evalResult = await cdp.send("Runtime.evaluate", {
            expression: input.expression,
            returnByValue: true
          });
          const evalValue = extractValue(evalResult);
          return { success: true, text: typeof evalValue === "string" ? evalValue : JSON.stringify(evalValue) };
        }

        case "snapshot-dom": {
          const snapshotExpr = `(() => {
            function getUniqueSelector(el) {
              if (el.id) return '#' + el.id;
              let path = [];
              let current = el;
              while (current && current.nodeType === Node.ELEMENT_NODE) {
                let selector = current.nodeName.toLowerCase();
                if (current.id) {
                  selector = '#' + current.id;
                  path.unshift(selector);
                  break;
                }
                let sib = current, nth = 1;
                while (sib = sib.previousElementSibling) {
                  if (sib.nodeName.toLowerCase() === selector) nth++;
                }
                if (nth !== 1) selector += ":nth-of-type(" + nth + ")";
                path.unshift(selector);
                current = current.parentNode;
              }
              return path.join(" > ");
            }

            function isVisible(el) {
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.getClientRects().length > 0;
            }

            const elements = document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"]');
            const items = [];
            for (const el of elements) {
              if (!isVisible(el)) continue;
              let text = (el.innerText || el.value || el.getAttribute('aria-label') || el.alt || '').trim().replace(/\\s+/g, ' ').substring(0, 100);
              const tagName = el.tagName.toLowerCase();
              const uniqueSelector = getUniqueSelector(el);
              items.push(\`\${tagName} "\${text}" => \${uniqueSelector}\`);
            }
            return items.join('\\n');
          })()`;

          const snapshotResult = await cdp.send("Runtime.evaluate", {
            expression: snapshotExpr,
            returnByValue: true
          });
          
          const snapshotValue = extractValue(snapshotResult);
          const domText = typeof snapshotValue === "string" ? snapshotValue : JSON.stringify(snapshotValue);
          return { success: true, text: domText };
        }

        default:
          throw new Error(`Unknown browser action: ${input.action}`);
      }
    } finally {
      cdp.close();
    }
  };
};

const extractValue = (response: Record<string, unknown>): unknown => {
  const result = response.result && typeof response.result === "object"
    ? (response.result as Record<string, unknown>).result
    : undefined;
  if (result && typeof result === "object") {
    return (result as Record<string, unknown>).value;
  }
  return undefined;
};

const extractObjectValue = (response: Record<string, unknown>): unknown => {
  return extractValue(response);
};
