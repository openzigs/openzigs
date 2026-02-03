import winston from "winston";

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp: ts }) => {
  return `${ts} ${level}: ${message}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: combine(timestamp(), logFormat),
  transports: [new winston.transports.Console({ format: combine(colorize(), logFormat) })]
});
