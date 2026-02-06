import type { ChannelType } from "./types.js";

const convertBoldToSingleAsterisk = (text: string) => {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
};

export const convertMarkdown = (text: string, target: ChannelType): string => {
  switch (target) {
    case "telegram":
    case "slack":
      return convertBoldToSingleAsterisk(text);
    case "discord":
    case "web":
      return text;
  }
};
