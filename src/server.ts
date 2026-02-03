import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { getHealth } from "./health.js";
import { logger } from "./logging/logger.js";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json(getHealth());
});

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  logger.info(`OpenZigs server listening on port ${port}`);
});

export { app };
