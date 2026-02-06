import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { runSetup } from "./setup.js";

const createMockIO = (answers: string[]) => {
  let index = 0;
  return {
    prompt: async () => {
      const answer = answers[index] ?? "";
      index += 1;
      return answer;
    },
    confirm: async () => {
      const answer = (answers[index] ?? "").toLowerCase();
      index += 1;
      return answer === "y" || answer === "yes";
    },
    log: () => undefined,
    close: () => undefined
  };
};

describe("runSetup", () => {
  it("writes env, config, and tools config based on prompts", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-setup-"));
    const envPath = path.join(repoDir, ".env");
    const toolsPath = path.join(repoDir, "config", "tools.json");
    const configPath = path.join(repoDir, "config.json");

    await fs.mkdir(path.dirname(toolsPath), { recursive: true });
    await fs.writeFile(
      toolsPath,
      JSON.stringify({ enabledTools: ["read-file"], customRiskOverrides: {} }, null, 2),
      "utf-8"
    );

    const answers = [
      "gh-token",
      "y",
      "tg-token",
      "123,456",
      "n",
      "y",
      "y",
      "n",
      "y",
      "y",
      "y"
    ];

    const calls: Array<{ command: string; args: string[] }> = [];

    await runSetup({
      repoDir,
      envPath,
      configPath,
      toolsPath,
      io: createMockIO(answers),
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return 0;
      }
    });

    const envContent = await fs.readFile(envPath, "utf-8");
    expect(envContent).toContain("GITHUB_TOKEN=gh-token");
    expect(envContent).toContain("TELEGRAM_BOT_TOKEN=tg-token");

    const config = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    const channels = config.channels as Record<string, Record<string, unknown>>;
    expect(channels.telegram.enabled).toBe(true);
    expect(channels.telegram.allowedUsers).toEqual(["123", "456"]);
    expect(channels.discord).toBeUndefined();

    const toolsConfig = JSON.parse(await fs.readFile(toolsPath, "utf-8")) as {
      enabledTools: string[];
    };
    expect(toolsConfig.enabledTools).toEqual(
      expect.arrayContaining(["read-file", "list-directory", "web-search", "browser-read", "write-file"])
    );
    expect(toolsConfig.enabledTools).not.toContain("shell-execute");

    expect(calls).toEqual([{ command: "docker", args: ["compose", "up", "-d"] }]);
  });
});
