import type { ChannelType } from "./types.js";
import { toTelegramMarkdownV2 } from "./telegram-formatter.js";

const convertBoldToSingleAsterisk = (text: string) => {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
};

export const convertMarkdown = (text: string, target: ChannelType): string => {
  switch (target) {
    case "telegram":
      return toTelegramMarkdownV2(text);
    case "discord":
    case "web":
      return text;
  }
};

// Keep legacy export for backward compat in case anything still imports it
export { convertBoldToSingleAsterisk };
