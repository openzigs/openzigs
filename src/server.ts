import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { logger } from "./logging/logger.js";
import { AuditLogger } from "./logging/audit-logger.js";
import { ApprovalQueue } from "./approvals/index.js";

const config = await loadConfig();
const auditLogger = new AuditLogger();
const approvalQueue = new ApprovalQueue({ auditLogger });
const app = createApp(config, { auditLogger, approvalQueue });
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  logger.info(`OpenZigs server listening on port ${port}`);
  void auditLogger.log({
    level: "info",
    category: "system",
    event: "server_started",
    details: { port }
  });
});

export { app };
