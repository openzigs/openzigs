import express from "express";
import helmet from "helmet";
import cors from "cors";
import { getHealth } from "./health.js";
import { createAuthMiddleware, checkRole } from "./auth/auth.js";
import type { AppConfig } from "./config/index.js";

export const createApp = (config: AppConfig) => {
  const app = express();

  app.set("trust proxy", true);

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  const authMiddleware = createAuthMiddleware(config.auth);

  app.get("/health", (_req, res) => {
    res.status(200).json(getHealth());
  });

  app.get("/api/health", authMiddleware, (_req, res) => {
    res.status(200).json(getHealth());
  });

  app.post("/api/tools/:name/toggle", authMiddleware, checkRole("admin"), (req, res) => {
    res.status(200).json({ ok: true, tool: req.params.name });
  });

  return app;
};
