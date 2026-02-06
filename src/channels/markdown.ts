import type { ChannelType } from "./types.js";

const boldToTelegram = (text: string) => {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
};

export const convertMarkdown = (text: string, target: ChannelType): string => {
  if (target === "discord") {
    return text;
  }

  if (target === "telegram" || target === "slack") {
    return boldToTelegram(text);
  }

  return text;
};
