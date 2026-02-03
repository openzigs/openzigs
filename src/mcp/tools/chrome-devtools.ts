import * as z from "zod";

export type ChromeDevtoolsOutput = {
  title: string;
  url: string;
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
  url: z.string().optional()
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

    if (input.selector) {
      throw new Error("selector filtering is not supported yet");
    }
    const response = await fetch(`${baseUrl}/json/list`);

    if (!response.ok) {
      throw new Error(`Chrome DevTools error: ${response.status}`);
    }

    const json = await response.json();
    const parsed = ChromeTargetsSchema.safeParse(json);

    if (!parsed.success) {
      throw new Error(`Chrome DevTools response validation failed: ${parsed.error.message}`);
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
