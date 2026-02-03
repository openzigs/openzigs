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

    const targets = (await response.json()) as Array<{ title?: string; url?: string }>;
    const first = targets.find((target) => target.url && target.title);

    if (!first) {
      throw new Error("No Chrome targets available");
    }

    return {
      title: first.title ?? "",
      url: first.url ?? ""
    };
  };
};
