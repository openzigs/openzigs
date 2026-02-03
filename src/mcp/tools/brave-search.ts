export type BraveSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type BraveSearchOutput = {
  results: BraveSearchResult[];
};

type BraveSearchInput = {
  query: string;
  count?: number;
};

type BraveSearchOptions = {
  apiKey: string;
  endpoint?: string;
};

export const createBraveSearchHandler = ({
  apiKey,
  endpoint = "https://api.search.brave.com/res/v1/web/search"
}: BraveSearchOptions) => {
  return async ({ query, count = 10 }: BraveSearchInput): Promise<BraveSearchOutput> => {
    if (!apiKey) {
      throw new Error("BRAVE_API_KEY is required to use web-search");
    }

    const url = new URL(endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`Brave Search API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };

    const results = (data.web?.results ?? []).map((result) => ({
      title: result.title ?? "",
      url: result.url ?? "",
      snippet: result.description ?? ""
    }));

    return { results };
  };
};
