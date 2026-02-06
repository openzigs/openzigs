import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import dotenv from "dotenv";

export type SetupIO = {
  prompt: (message: string) => Promise<string>;
  confirm: (message: string, defaultValue: boolean) => Promise<boolean>;
  log: (message: string) => void;
  close: () => void;
};

export type SetupOptions = {
  repoDir?: string;
  envPath?: string;
  configPath?: string;
  toolsPath?: string;
  io?: SetupIO;
  runCommand?: (command: string, args: string[]) => Promise<number>;
};

type ToolsConfig = {
  enabledTools: string[];
  customRiskOverrides: Record<string, unknown>;
};

type SetupInputs = {
  githubToken?: string;
  enableTelegram: boolean;
  telegramToken?: string;
  telegramAllowlist: string[];
  enableDiscord: boolean;
  discordToken?: string;
  discordGuilds: string[];
  enableBrowserRead: boolean;
  enableWriteFile: boolean;
  enableShellExecute: boolean;
  requireApprovalForHighRisk: boolean;
  enableAuditLogging: boolean;
  startAgent: boolean;
};

const createDefaultIO = (): SetupIO => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return {
    prompt: async (message) => rl.question(`${message} `),
    confirm: async (message, defaultValue) => {
      const suffix = defaultValue ? "(Y/n)" : "(y/N)";
      const answer = (await rl.question(`${message} ${suffix} `)).trim().toLowerCase();
      if (!answer) {
        return defaultValue;
      }
      return answer === "y" || answer === "yes";
    },
    log: (message) => {
      console.log(message);
    },
    close: () => {
      rl.close();
    }
  };
};

const parseCsv = (value: string): string[] => {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const formatEnvValue = (value: string): string => {
  if (/\s|#/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
};

const readEnvFile = async (envPath: string): Promise<Record<string, string>> => {
  try {
    const raw = await fs.readFile(envPath, "utf-8");
    return dotenv.parse(raw);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const writeEnvFile = async (envPath: string, updates: Record<string, string>) => {
  const existing = await readEnvFile(envPath);
  const merged = { ...existing, ...updates };
  const lines = Object.entries(merged).map(([key, value]) => `${key}=${formatEnvValue(value)}`);
  await fs.writeFile(envPath, `${lines.join("\n")}\n`, "utf-8");
};

const readToolsConfig = async (toolsPath: string): Promise<ToolsConfig> => {
  try {
    const raw = await fs.readFile(toolsPath, "utf-8");
    const parsed = JSON.parse(raw) as ToolsConfig;
    return {
      enabledTools: Array.isArray(parsed.enabledTools) ? parsed.enabledTools : [],
      customRiskOverrides: parsed.customRiskOverrides ?? {}
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return { enabledTools: [], customRiskOverrides: {} };
    }
    throw error;
  }
};

const writeToolsConfig = async (toolsPath: string, config: ToolsConfig) => {
  await fs.mkdir(path.dirname(toolsPath), { recursive: true });
  await fs.writeFile(toolsPath, JSON.stringify(config, null, 2), "utf-8");
};

const writeConfig = async (configPath: string, config: Record<string, unknown>) => {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(configPath, 0o600);
};

const runCommandDefault = (command: string, args: string[]) => {
  return new Promise<number>((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
};

const collectInputs = async (io: SetupIO): Promise<SetupInputs> => {
  io.log("OpenZigs Setup Wizard");
  io.log("");

  io.log("Step 1/4: GitHub Authentication");
  const githubToken = (await io.prompt("GitHub token (optional, leave blank to skip):")).trim();
  io.log("");

  io.log("Step 2/4: Enable Messaging Channels");
  const enableTelegram = await io.confirm("Enable Telegram?", false);
  let telegramToken = "";
  let telegramAllowlist: string[] = [];
  if (enableTelegram) {
    telegramToken = (await io.prompt("Telegram bot token:")).trim();
    const allowlistRaw = await io.prompt("Telegram allowed user IDs (comma-separated, optional):");
    telegramAllowlist = parseCsv(allowlistRaw);
  }

  const enableDiscord = await io.confirm("Enable Discord?", false);
  let discordToken = "";
  let discordGuilds: string[] = [];
  if (enableDiscord) {
    discordToken = (await io.prompt("Discord bot token:")).trim();
    const guildsRaw = await io.prompt("Discord allowed guild IDs (comma-separated, optional):");
    discordGuilds = parseCsv(guildsRaw);
  }
  io.log("");

  io.log("Step 3/4: Configure Tools");
  const enableBrowserRead = await io.confirm("Enable browser-read tool?", false);
  const enableWriteFile = await io.confirm("Enable filesystem write tool?", false);
  const enableShellExecute = await io.confirm("Enable shell execute tool?", false);
  io.log("");

  io.log("Step 4/4: Security Settings");
  const requireApprovalForHighRisk = await io.confirm("Require approval for high-risk actions?", true);
  const enableAuditLogging = await io.confirm("Enable audit logging?", true);
  io.log("");

  const startAgent = await io.confirm("Start the agent now?", false);
  io.log("");

  return {
    githubToken: githubToken || undefined,
    enableTelegram,
    telegramToken: telegramToken || undefined,
    telegramAllowlist,
    enableDiscord,
    discordToken: discordToken || undefined,
    discordGuilds,
    enableBrowserRead,
    enableWriteFile,
    enableShellExecute,
    requireApprovalForHighRisk,
    enableAuditLogging,
    startAgent
  };
};

export const runSetup = async (options: SetupOptions = {}) => {
  const repoDir = options.repoDir ?? process.cwd();
  const envPath = options.envPath ?? path.join(repoDir, ".env");
  const toolsPath = options.toolsPath ?? path.join(repoDir, "config", "tools.json");
  const configPath = options.configPath ?? path.join(os.homedir(), ".openzigs", "config.json");
  const io = options.io ?? createDefaultIO();
  const runCommand = options.runCommand ?? runCommandDefault;

  try {
    const inputs = await collectInputs(io);
    const envUpdates: Record<string, string> = {};
    if (inputs.githubToken) {
      envUpdates.GITHUB_TOKEN = inputs.githubToken;
    }
    if (inputs.enableTelegram && inputs.telegramToken) {
      envUpdates.TELEGRAM_BOT_TOKEN = inputs.telegramToken;
    }
    if (inputs.enableDiscord && inputs.discordToken) {
      envUpdates.DISCORD_BOT_TOKEN = inputs.discordToken;
    }

    if (Object.keys(envUpdates).length > 0) {
      await writeEnvFile(envPath, envUpdates);
    }

    const config: Record<string, unknown> = {
      channels: {}
    };

    if (inputs.enableTelegram) {
      (config.channels as Record<string, unknown>).telegram = {
        enabled: true,
        token: "${TELEGRAM_BOT_TOKEN}",
        webhookUrl: "",
        allowedUsers: inputs.telegramAllowlist
      };
    }

    if (inputs.enableDiscord) {
      (config.channels as Record<string, unknown>).discord = {
        enabled: true,
        token: "${DISCORD_BOT_TOKEN}",
        allowedGuilds: inputs.discordGuilds
      };
    }

    await writeConfig(configPath, config);

    const toolsConfig = await readToolsConfig(toolsPath);
    const enabledTools = new Set<string>(toolsConfig.enabledTools);

    ["read-file", "list-directory", "web-search"].forEach((tool) => enabledTools.add(tool));

    const toggleTool = (name: string, enable: boolean) => {
      if (enable) {
        enabledTools.add(name);
      } else {
        enabledTools.delete(name);
      }
    };

    toggleTool("browser-read", inputs.enableBrowserRead);
    toggleTool("write-file", inputs.enableWriteFile);
    toggleTool("shell-execute", inputs.enableShellExecute);

    toolsConfig.enabledTools = Array.from(enabledTools).sort();
    await writeToolsConfig(toolsPath, toolsConfig);

    if (!inputs.requireApprovalForHighRisk) {
      io.log("Warning: high-risk tools are enabled without approval.");
    }
    if (!inputs.enableAuditLogging) {
      io.log("Warning: audit logging disabled.");
    }

    if (inputs.startAgent) {
      const exitCode = await runCommand("docker", ["compose", "up", "-d"]);
      if (exitCode !== 0) {
        io.log("Failed to start agent with docker compose.");
      }
    }

    io.log("Setup complete.");
  } finally {
    io.close();
  }
};
