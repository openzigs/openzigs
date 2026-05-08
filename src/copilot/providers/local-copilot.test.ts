import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyLocalCopilotProvider,
  buildLocalCopilotProvider,
  clearLocalCopilotProvider,
} from "./local-copilot.js";
import type { ProviderConfig } from "../copilot-wrapper.js";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const validConfig = {
  type: "local-copilot" as const,
  endpoint: "http://127.0.0.1:11434/v1",
  model: "gemma4:26b",
  apiKey: "sekret",
  timeoutMs: 60000,
};

describe("local-copilot provider helpers", () => {
  describe("buildLocalCopilotProvider", () => {
    it("maps validated config to ProviderConfig shape", () => {
      const result = buildLocalCopilotProvider(validConfig);
      expect(result).toEqual({
        type: "local-copilot",
        endpoint: "http://127.0.0.1:11434/v1",
        model: "gemma4:26b",
        apiKey: "sekret",
        timeoutMs: 60000,
      });
    });

    it("preserves undefined optional apiKey", () => {
      const result = buildLocalCopilotProvider({
        type: "local-copilot",
        endpoint: "http://127.0.0.1:8000/v1",
        model: "google/gemma-4-26b-it",
        timeoutMs: 120000,
      });
      expect(result.apiKey).toBeUndefined();
      expect(result.timeoutMs).toBe(120000);
    });
  });

  describe("applyLocalCopilotProvider", () => {
    let setProvider: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      setProvider = vi.fn();
    });

    it("calls wrapper.setProvider with the built provider", async () => {
      await applyLocalCopilotProvider({
        wrapper: { setProvider },
        config: validConfig,
      });
      expect(setProvider).toHaveBeenCalledTimes(1);
      const arg = setProvider.mock.calls[0][0] as ProviderConfig;
      expect(arg.type).toBe("local-copilot");
      if (arg.type === "local-copilot") {
        expect(arg.endpoint).toBe(validConfig.endpoint);
        expect(arg.model).toBe(validConfig.model);
      }
    });

    it("emits provider.registered audit log when auditLogger provided", async () => {
      const log = vi.fn(async () => undefined);
      await applyLocalCopilotProvider({
        wrapper: { setProvider },
        config: validConfig,
        auditLogger: { log } as unknown as Parameters<
          typeof applyLocalCopilotProvider
        >[0]["auditLogger"],
      });
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "provider.registered",
          category: "session",
          details: expect.objectContaining({
            type: "local-copilot",
            endpoint: validConfig.endpoint,
            model: validConfig.model,
          }),
        }),
      );
      // apiKey deliberately omitted from audit details.
      const firstCall = log.mock.calls[0] as unknown as [
        { details: Record<string, unknown> },
      ];
      const detail = firstCall[0].details;
      expect(detail.apiKey).toBeUndefined();
    });

    it("does not require an auditLogger", async () => {
      await expect(
        applyLocalCopilotProvider({
          wrapper: { setProvider },
          config: validConfig,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("clearLocalCopilotProvider", () => {
    it("calls wrapper.setProvider with undefined", () => {
      const setProvider = vi.fn();
      clearLocalCopilotProvider({ wrapper: { setProvider } });
      expect(setProvider).toHaveBeenCalledWith(undefined);
    });
  });
});
