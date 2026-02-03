export type HealthStatus = {
  status: "ok";
};

export const getHealth = (): HealthStatus => ({ status: "ok" });
