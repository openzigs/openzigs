import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { logger } from "./logging/logger.js";

const config = await loadConfig();
const app = createApp(config);
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  logger.info(`OpenZigs server listening on port ${port}`);
});

export { app };
