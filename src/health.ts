export type HealthStatus = {
  status: "ok";
  uptime: number;
  memoryMB: number;
};

export const getHealth = (): HealthStatus => ({
  status: "ok",
  uptime: process.uptime(),
  memoryMB: Math.round((process.memoryUsage().rss / (1024 * 1024)) * 100) / 100,
});
