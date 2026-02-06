import "dotenv/config";
import { createServer } from "node:http";
import path from "node:path";
import { Server as SocketIOServer } from "socket.io";
import { createApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { logger } from "./logging/logger.js";
import { AuditLogger } from "./logging/audit-logger.js";
import { ApprovalQueue } from "./approvals/index.js";
import { ToolRegistry } from "./mcp/tool-registry.js";
import { registerToolCatalog } from "./mcp/tool-catalog.js";

const config = await loadConfig();
const auditLogger = new AuditLogger();
const toolRegistry = new ToolRegistry({
  statePath: path.resolve(process.cwd(), "config", "tools.json")
});
registerToolCatalog(toolRegistry);
const approvalQueue = new ApprovalQueue({ auditLogger });
const app = createApp(config, { auditLogger, approvalQueue, toolRegistry });
const port = Number(process.env.PORT ?? 3000);
const uiOrigin = process.env.OPENZIGS_UI_ORIGIN ?? "http://localhost:3000";

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: uiOrigin,
    credentials: true
  }
});

io.on("connection", (socket) => {
  socket.emit("status:update", { connected: true });
});

approvalQueue.on("approval:created", (approval) => {
  io.emit("approval:request", approval);
});

approvalQueue.on("approval:decided", (approval) => {
  io.emit("approval:decided", {
    id: approval.id,
    approved: approval.status === "approved",
    decidedVia: approval.decidedVia,
    status: approval.status
  });
});

toolRegistry.on("tool:toggled", (payload) => {
  io.emit("tool:toggled", payload);
});

httpServer.listen(port, () => {
  logger.info(`OpenZigs server listening on port ${port}`);
  void auditLogger.log({
    level: "info",
    category: "system",
    event: "server_started",
    details: { port }
  });
});

export { app, httpServer };
