import { createApp } from "./app.js";
import { logger } from "./logging/logger.js";

const app = await createApp();
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  logger.info(`OpenZigs server listening on port ${port}`);
});

export { app };
